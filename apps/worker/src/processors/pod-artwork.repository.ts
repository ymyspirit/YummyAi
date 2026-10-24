import { ForbiddenError, Permission } from "@yummyai/authz";
import { harnessChecksum, type SecretVault } from "@yummyai/ai-core";
import { RightsRiskQualityCheckSnapshotSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import {
  artifactRelations,
  assetFiles,
  designTasks,
  designVersionFiles,
  designVersions,
  podArtworkTaskInputs,
  podArtworkTasks,
  podArtworkInvocations as invocations,
  podArtworkExecutions as executions,
  loadCurrentMembershipContext,
  skus, spus, productPlans, workflowNodeAttempts, workflowNodeRuns, workflowRuns,
  rightsAssessments,
  visualFingerprints,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  PodArtworkExecutionRecord,
  PodArtworkExecutionRepository,
  PodArtworkExecutionResult,
  PodArtworkClaim,
} from "./pod-artwork.processor.js";
import { PodArtworkDeferredError, PodArtworkInputPolicyError } from "./pod-artwork.processor.js";
import { PodArtworkRecovery } from "./pod-artwork-recovery.js";
import { hashPodResponse, type PodArtworkResponseCheckpoint } from "./pod-artwork-response.js";
import { assertPodMethod, PodOwnerError, sealPodCompletion } from "@yummyai/pod-core";
import { assertWorkflowMethod, WorkflowExecutionError } from "@yummyai/workflow-core";
import { catalogFingerprint } from "@yummyai/catalog-core";
import { WorkflowExecutionSnapshotSchema } from "@yummyai/contracts/workflow/execution";
import { ZodError } from "zod";

export class PodArtworkSnapshotMismatchError extends PodArtworkInputPolicyError {
  constructor(assetId: string) {
    super(`POD artwork input snapshot no longer matches asset ${assetId}`);
    this.name = "PodArtworkSnapshotMismatchError";
  }
}

export class DrizzlePodArtworkExecutionRepository implements PodArtworkExecutionRepository {
  private readonly recovery: PodArtworkRecovery;
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
    contentVault?: SecretVault,
  ) { this.recovery = new PodArtworkRecovery(database, storage, assertPodAdmission, contentVault); }

  async load(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string): Promise<PodArtworkExecutionRecord | undefined> {
    let tenantContext = workerContext(context);
    const loaded = await withTenant(this.database.db, tenantContext, async (tx) => {
      const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, taskId)).limit(1);
      if (!task) return undefined;
      tenantContext = await assertPodAdmission(tx, context, task);
      await this.recovery.assertIdentity(tx, task);
      const inputs = await tx.select({ snapshot: podArtworkTaskInputs, asset: assetFiles })
        .from(podArtworkTaskInputs)
        .innerJoin(assetFiles, eq(podArtworkTaskInputs.assetFileId, assetFiles.id))
        .where(eq(podArtworkTaskInputs.taskId, taskId))
        .orderBy(asc(podArtworkTaskInputs.ordinal));
      return { task, inputs };
    });
    if (!loaded) return undefined;

    const inputAssets = await Promise.all(loaded.inputs.map(async ({ snapshot, asset }) => {
      if (
        snapshot.assetVersion !== asset.version
        || snapshot.checksumSha256 !== asset.checksumSha256
        || snapshot.assetDomain !== asset.assetDomain
        || snapshot.rightsStatus !== asset.rightsStatus
      ) throw new PodArtworkSnapshotMismatchError(asset.id);
      const rightsSourceKind = (asset.rightsMetadata as { source?: { kind?: PodArtworkExecutionRecord["inputAssets"][number]["rightsSourceKind"] } }).source?.kind;
      if ((snapshot.rightsSourceKind ?? undefined) !== rightsSourceKind) throw new PodArtworkSnapshotMismatchError(asset.id);
      const domain = snapshot.assetDomain as "research" | "authorized";
      const bytes = await this.storage.readPrivate(tenantContext, {
        id: asset.id,
        tenantId: asset.tenantId,
        assetDomain: domain,
        objectKey: asset.objectKey,
      }, { requiredDomain: domain });
      if (hashPodResponse(bytes) !== snapshot.checksumSha256) throw new PodArtworkSnapshotMismatchError(asset.id);
      return {
        id: asset.id,
        version: snapshot.assetVersion,
        checksumSha256: snapshot.checksumSha256,
        domain,
        rightsStatus: snapshot.rightsStatus as "unverified" | "approved" | "rejected",
        rightsSourceKind,
        bytes,
        mediaType: asset.mediaType,
      };
    }));

    return {
      id: loaded.task.id,
      designTaskId: loaded.task.designTaskId,
      toolKey: loaded.task.toolKey,
      parameterSnapshot: loaded.task.parameterSnapshot,
      inputAssets,
      modelKey: loaded.task.modelKey ?? undefined,
      maxAttempts: loaded.task.maxAttempts,
    };
  }

  async claim(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string, attempt: number) {
    const modern = await this.recovery.claim(context, taskId);
    if (modern !== "legacy") return modern;
    const [claimed] = await withTenant(this.database.db, workerContext(context), async (tx) => {
      const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, taskId)).for("update");
      if (!task) return [];
      await assertPodAdmission(tx, context, task);
      const result = await tx.update(podArtworkTasks).set({
      status: "running",
      progressPercent: 1,
      attemptCount: attempt + 1,
      errorCode: null,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    }).where(and(
      eq(podArtworkTasks.id, taskId),
      eq(podArtworkTasks.status, "queued"),
      sql`(${podArtworkTasks.attemptCount} <= ${attempt} OR (${podArtworkTasks.attemptCount}=${attempt+1} AND EXISTS (SELECT 1 FROM pod_artwork_invocations p WHERE p.task_id=${taskId} AND p.attempt_number=${attempt+1} AND p.phase='pending'))) AND ${attempt} < ${podArtworkTasks.maxAttempts}`,
    )).returning({ id: podArtworkTasks.id });
      if (result.length) await tx.insert(invocations).values({ id:createEntityId(),tenantId:context.tenantId,taskId,attemptNumber:attempt+1,phase:"pending" }).onConflictDoNothing();
      return result;
    });
    return claimed ? { token: null, attempt, hasResponse: false } : undefined;
  }

  async markSubmitted(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string, attempt: number, claim?: PodArtworkClaim) {
    if (claim?.token) return this.recovery.markSubmitted(context, taskId, claim);
    await withTenant(this.database.db, workerContext(context), async tx => {
      const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id,taskId)).for("update");
      if (!task || task.requestedBy!==context.userId || task.status!=="running" || task.attemptCount!==attempt+1) throw new Error("POD_INVOCATION_CLAIM_LOST");
      if ((await tx.select({ id: executions.taskId }).from(executions).where(eq(executions.taskId, taskId)))[0]) throw new Error("POD_EXECUTION_CLAIM_LOST");
      await assertPodAdmission(tx,context,task);
      const changed=await tx.update(invocations).set({phase:"submitted",submittedAt:new Date()})
        .where(and(eq(invocations.taskId,taskId),eq(invocations.attemptNumber,attempt+1),eq(invocations.phase,"pending"))).returning({id:invocations.id});
      if (!changed.length) throw new Error("POD_INVOCATION_SUBMISSION_ALREADY_RECORDED");
    });
  }

  async recordResponse(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string, attempt: number, receipt: PodInvocationReceipt, checkpoint?: PodArtworkResponseCheckpoint, claim?: PodArtworkClaim) {
    return this.recovery.record(context, taskId, attempt, receipt, checkpoint, claim);
  }

  async readResponse(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string, claim: PodArtworkClaim) {
    return this.recovery.read(context, taskId, claim);
  }

  async purgeExpiredResponses(context: TenantContext) {
    return this.recovery.purgeExpired(context);
  }

  async complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: PodArtworkExecutionRecord,
    result: PodArtworkExecutionResult,
    claim?: PodArtworkClaim,
  ) {
    const tenantContext = await withTenant(this.database.db, workerContext(context), async (tx) => {
      const [row] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, task.id));
      if (!row) throw new PodArtworkInputPolicyError("POD task is unavailable");
      if (!claim?.token && (await tx.select({ id: executions.taskId }).from(executions).where(eq(executions.taskId, task.id)))[0]) throw new Error("POD_EXECUTION_CLAIM_LOST");
      if (claim?.token) await this.recovery.owns(tx, context, task.id, claim);
      await this.recovery.assertIdentity(tx, row);
      return assertPodAdmission(tx, context, row);
    });
    const rightsQuality = task.toolKey === "rights_risk_scan"
      ? RightsRiskQualityCheckSnapshotSchema.parse(result.qualityCheckSnapshot)
      : undefined;
    const manifest = claim?.token ? this.recovery.outputManifest(context, task.id, result) : undefined;
    if (manifest) await this.recovery.stageArtifacts(context, task.id, claim!, manifest);
    const outputs = await Promise.all(result.outputs.map(async (output, index) => {
      const fileName = `${task.id}-${output.fileName}`;
      const stored = await this.storage.putPrivate(tenantContext, {
        body: output.bytes,
        domain: "authorized",
        fileName: manifest?.[index]?.fileName ?? fileName,
        mediaType: output.mediaType,
      });
      if (manifest) {
        const persisted = await this.storage.readPrivate(tenantContext, { id: task.id, tenantId: context.tenantId, assetDomain: "authorized", objectKey: stored.objectKey }, { requiredDomain: "authorized", maxBytes: output.bytes.byteLength });
        if (persisted.byteLength !== output.bytes.byteLength || hashPodResponse(persisted) !== manifest[index]!.checksumSha256) throw new Error("POD_ARTIFACT_CHECKSUM_MISMATCH");
      }
      return { ...output, fileName, stored };
    }));

    await withTenant(this.database.db, tenantContext, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pod-artwork:${task.id}`}, 0))`);
      const [current] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, task.id)).limit(1);
      if (claim?.token) await this.recovery.owns(tx, context, task.id, claim);
      if (!current || current.resultVersionId) return;
      if (current.status !== "running") throw new Error("POD artwork task is not running");
      await this.recovery.assertIdentity(tx, current);
      await assertPodAdmission(tx, context, current);

      const outputAssets: Array<{ id: string; version: number; checksumSha256: string }> = [];
      for (const output of outputs) {
        const [existing] = await tx.select({
          id: assetFiles.id,
          version: assetFiles.version,
          checksumSha256: assetFiles.checksumSha256,
        }).from(assetFiles)
          .where(eq(assetFiles.objectKey, output.stored.objectKey)).limit(1);
        if (existing) {
          outputAssets.push(existing);
          continue;
        }
        const id = createEntityId();
        const aiGenerated = output.metadata.aiInference !== "none";
        await tx.insert(assetFiles).values({
          id,
          tenantId: tenantContext.tenantId,
          ownerUserId: tenantContext.userId,
          objectKey: output.stored.objectKey,
          assetDomain: "authorized",
          fileName: output.fileName,
          mediaType: output.mediaType,
          byteSize: output.bytes.byteLength,
          checksumSha256: output.stored.checksumSha256,
          rightsStatus: "unverified",
          rightsMetadata: {
            source: {
              kind: aiGenerated ? "ai_generated" : "owned",
              reference: `${aiGenerated ? "generated" : "deterministic-transform"}:${result.modelKey}:${result.modelVersion}`,
            },
            podArtworkTaskId: task.id,
            modelKey: result.modelKey,
            modelVersion: result.modelVersion,
            seed: result.seed,
            outputMetadata: output.metadata,
          },
          aiGenerated,
        });
        outputAssets.push({ id, version: 1, checksumSha256: output.stored.checksumSha256 });
      }

      await tx.insert(artifactRelations).values(task.inputAssets.flatMap((input) => outputAssets.map((output) => ({
        id: createEntityId(),
        tenantId: tenantContext.tenantId,
        fromAssetId: input.id,
        fromAssetVersion: input.version,
        toAssetId: output.id,
        toAssetVersion: output.version,
        relationType: "source_to_result" as const,
        taskId: task.id,
        createdBy: tenantContext.userId,
      })))).onConflictDoNothing();

      await tx.insert(visualFingerprints).values([
        ...task.inputAssets.map((input) => ({
          id: createEntityId(),
          tenantId: tenantContext.tenantId,
          assetId: input.id,
          assetVersion: input.version,
          checksumSha256: input.checksumSha256,
          fingerprintAlgorithm: "sha256",
          fingerprintVersion: "1",
          indexStatus: "indexed" as const,
        })),
        ...outputAssets.map((output) => ({
          id: createEntityId(),
          tenantId: tenantContext.tenantId,
          assetId: output.id,
          assetVersion: output.version,
          checksumSha256: output.checksumSha256,
          fingerprintAlgorithm: "sha256",
          fingerprintVersion: "1",
          indexStatus: "indexed" as const,
        })),
      ]).onConflictDoNothing();

      if (rightsQuality) {
        await tx.insert(rightsAssessments).values(rightsQuality.outputChecks.map((check) => {
          const input = task.inputAssets[check.inputOrdinal]!;
          return {
            id: createEntityId(),
            tenantId: tenantContext.tenantId,
            assetId: input.id,
            assetVersion: input.version,
            taskId: task.id,
            scopeSnapshot: {
              purpose: "pod_rights_risk_scan",
              depth: rightsQuality.depth,
              disclaimer: rightsQuality.disclaimer,
              checkedAt: rightsQuality.checkedAt,
              validUntil: rightsQuality.validUntil,
              ruleVersion: rightsQuality.ruleVersion,
              sourceChecks: rightsQuality.sourceChecks,
              missingSourceKeys: rightsQuality.missingSourceKeys,
              ruleHits: check.ruleHits,
              visualSimilarityEvaluated: check.visualSimilarityEvaluated,
              visualCandidateCount: check.visualCandidateCount,
              confidence: check.confidence,
            },
            status: check.downstreamBlocked ? "blocked" as const : "review_required" as const,
            legalRisk: check.legalRisk,
            visualSimilarityPermille: check.visualSimilarityPermille,
            evidenceSnapshot: check.evidence.map((evidence) => ({
              kind: evidence.kind === "hot_ip" ? "internal" : evidence.kind,
              reference: evidence.reference,
              ...(evidence.title ? { title: evidence.title } : {}),
              checkedAt: evidence.checkedAt,
              accessible: evidence.accessible,
              ...(evidence.contentHashSha256 ? { contentHashSha256: evidence.contentHashSha256 } : {}),
            })),
            modelKey: result.modelKey,
            modelVersion: result.modelVersion,
          };
        }));
        for (const check of rightsQuality.outputChecks) {
          if (check.legalRisk === "low") continue;
          const input = task.inputAssets[check.inputOrdinal]!;
          await tx.update(assetFiles).set({
            rightsStatus: check.legalRisk === "high" ? "rejected" : "unverified",
            rightsMetadata: {
              riskTaskId: task.id,
              legalRisk: check.legalRisk,
              checkedAt: rightsQuality.checkedAt,
              validUntil: rightsQuality.validUntil,
            },
          }).where(eq(assetFiles.id, input.id));
        }
      } else {
        await tx.insert(rightsAssessments).values(outputAssets.map((output) => ({
          id: createEntityId(),
          tenantId: tenantContext.tenantId,
          assetId: output.id,
          assetVersion: output.version,
          taskId: task.id,
          scopeSnapshot: { purpose: "pod_generated_output", toolKey: task.toolKey },
          status: "pending" as const,
          legalRisk: "unknown" as const,
          evidenceSnapshot: [],
          modelKey: result.modelKey,
          modelVersion: result.modelVersion,
        })));
      }

      const [latest] = await tx.select({ versionNumber: designVersions.versionNumber }).from(designVersions)
        .where(eq(designVersions.taskId, task.designTaskId)).orderBy(desc(designVersions.versionNumber)).limit(1);
      const versionId = createEntityId();
      await tx.insert(designVersions).values({
        id: versionId,
        tenantId: tenantContext.tenantId,
        taskId: task.designTaskId,
        versionNumber: (latest?.versionNumber ?? 0) + 1,
        status: "pending_review",
        changeNote: rightsQuality
          ? `Rights-risk report generated by POD task ${task.id}. This is auxiliary evidence, not a legal opinion.`
          : `Generated by POD task ${task.id}. AI-generated output requires rights and quality review.`,
        createdBy: tenantContext.userId,
      });
      await tx.insert(designVersionFiles).values(outputAssets.map((output, index) => ({
        id: createEntityId(),
        tenantId: tenantContext.tenantId,
        versionId,
        assetFileId: output.id,
        role: outputs[index]!.role,
      })));
      const resultState = rightsQuality && (rightsQuality.highRiskDetected || rightsQuality.unknownRiskDetected)
        ? "blocked" : result.partial ? "partially_succeeded" : "awaiting_review";
      await tx.update(podArtworkTasks).set({
        status: resultState,
        progressPercent: 100,
        resultVersionId: versionId,
        modelKey: result.modelKey,
        modelVersion: result.modelVersion,
        seed: result.seed ?? null,
        qualityCheckSnapshot: result.qualityCheckSnapshot,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(podArtworkTasks.id, task.id));
      await tx.update(invocations).set({phase:"completed",finishedAt:new Date(),resultVersionId:versionId})
        .where(and(eq(invocations.taskId,task.id),eq(invocations.phase,"received")));
      if (claim?.token) {
        const [execution] = await tx.select().from(executions).where(eq(executions.taskId, task.id));
        if (!execution) throw new Error("POD_EXECUTION_CLAIM_LOST");
        const completion = sealPodCompletion(task.toolKey, execution.methodSnapshot, {
          contractVersion: "pod-completion-v1", taskId: task.id, designTaskId: task.designTaskId, toolKey: task.toolKey,
          inputFingerprint: execution.inputFingerprint,
          methodContractChecksum: execution.methodSnapshot?.executionContract.checksum ?? null,
          methodValidation: execution.methodSnapshot === null ? "legacy_missing"
            : execution.methodSnapshot.executionContract.skill.version === "pod-method-2026-10-18-v1" ? "legacy_owner_view" : "native_completion",
          responseChecksum: execution.responseChecksum, decodedWith: "pod-processor-result-v1",
          resultVersionId: versionId, resultState, qualityCheckChecksum: harnessChecksum(result.qualityCheckSnapshot),
          outputs: outputAssets.map((asset, ordinal) => ({
            ordinal, assetId: asset.id, assetVersion: asset.version, checksumSha256: asset.checksumSha256,
            byteSize: outputs[ordinal]!.bytes.byteLength, mediaType: outputs[ordinal]!.mediaType, role: outputs[ordinal]!.role,
          })),
          requiresBusinessReview: true, automaticProductionApproval: false,
        });
        await tx.update(executions).set({ phase: "completed", completionEvidence: completion.evidence, completionChecksum: completion.checksum,
          leaseToken: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, task.id));
      }
      await tx.update(designTasks).set({ status: "in_review", updatedAt: new Date() })
        .where(eq(designTasks.id, task.designTaskId));
    });
  }

  async fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    taskId: string,
    input: { attempt: number; terminal: boolean; code: string; message: string },
    claim?: PodArtworkClaim,
  ) {
    const modern = await this.recovery.fail(context, taskId, input, claim);
    if (modern !== "legacy") return modern;
    if (input.code === "POD_WORKFLOW_PAUSED") {
      await withTenant(this.database.db, workerContext(context), async tx => {
        const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, taskId)).for("update");
        const [pending] = await tx.select().from(invocations).where(and(eq(invocations.taskId, taskId), eq(invocations.attemptNumber, input.attempt + 1), eq(invocations.phase, "pending")));
        if (task?.requestedBy === context.userId && task.status === "running" && pending) await tx.update(podArtworkTasks).set({ status: "queued", errorCode: "POD_WORKFLOW_PAUSED", updatedAt: sql`clock_timestamp()` }).where(eq(podArtworkTasks.id, taskId));
      });
      return "deferred" as const;
    }
    const blocked = input.code === "INPUT_POLICY_BLOCKED";
    await withTenant(this.database.db, workerContext(context), async (tx) => {
      const changed=await tx.update(podArtworkTasks).set({
      status: blocked ? "blocked" : input.terminal ? "failed" : "queued",
      progressPercent: 0,
      attemptCount: input.attempt + 1,
      errorCode: input.code,
      errorMessage: input.message,
      completedAt: blocked || input.terminal ? new Date() : null,
      updatedAt: new Date(),
    }).where(and(eq(podArtworkTasks.id, taskId), eq(podArtworkTasks.requestedBy, context.userId),
      inArray(podArtworkTasks.status, ["queued", "running"]), sql`${podArtworkTasks.resultVersionId} IS NULL`,sql`${podArtworkTasks.attemptCount} <= ${input.attempt+1}`)).returning({id:podArtworkTasks.id});
      if(changed.length)await tx.update(invocations).set({phase:input.code==="POD_RESULT_UNCERTAIN"?"uncertain":"failed",finishedAt:new Date()})
        .where(and(eq(invocations.taskId,taskId),eq(invocations.attemptNumber,input.attempt+1),inArray(invocations.phase,["pending","submitted","received"])));
    });
  }
}

function workerContext(context: Pick<TenantContext, "tenantId" | "userId">): TenantContext {
  return {
    ...context,
    permissions: [],
    dataScope: "tenant",
  };
}

async function assertPodAdmission(tx: TenantTransaction, base: Pick<TenantContext, "tenantId" | "userId">, task: typeof podArtworkTasks.$inferSelect) {
  const context = await loadCurrentMembershipContext(tx, base, { lock: true });
  if (task.requestedBy !== base.userId || [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead].some((permission) => !context.permissions.includes(permission)))
    throw new PodArtworkInputPolicyError("Current POD execution permission is unavailable");
  const [execution] = await tx.select({ methodSnapshot: executions.methodSnapshot }).from(executions).where(eq(executions.taskId, task.id));
  try { await assertPodMethod(tx, context, task.toolKey, execution?.methodSnapshot, { lock: true }); }
  catch (error) {
    if (error instanceof PodOwnerError || error instanceof ForbiddenError) throw new PodArtworkInputPolicyError("The original POD method, its withdrawal state or its knowledge authority is unavailable");
    throw error;
  }
  const [resource] = await tx.select({ owner: productPlans.createdBy, planStatus: productPlans.status, spuStatus: spus.status, skuStatus: skus.status }).from(designTasks)
    .innerJoin(skus, eq(skus.id, designTasks.skuId)).innerJoin(spus, eq(spus.id, skus.spuId)).innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(eq(designTasks.id, task.designTaskId)).limit(1);
  if (!resource || [resource.planStatus, resource.spuStatus, resource.skuStatus].includes("archived") || (context.dataScope !== "tenant" && resource.owner !== context.userId))
    throw new PodArtworkInputPolicyError("Current POD product scope is unavailable");
  const [origin] = await tx.select({ nodeRunId: workflowNodeAttempts.nodeRunId }).from(workflowNodeAttempts).where(eq(workflowNodeAttempts.id, task.idempotencyKey)).limit(1);
  if (origin) {
    const [active] = await tx.select({ runStatus: workflowRuns.status, nodeStatus: workflowNodeRuns.status, snapshot: workflowNodeAttempts.inputSnapshot, inputChecksum: workflowNodeAttempts.inputChecksum }).from(workflowNodeAttempts)
      .innerJoin(workflowNodeRuns, eq(workflowNodeRuns.id, workflowNodeAttempts.nodeRunId)).innerJoin(workflowRuns, eq(workflowRuns.id, workflowNodeRuns.runId))
      .where(and(eq(workflowNodeAttempts.nodeRunId, origin.nodeRunId), inArray(workflowNodeAttempts.status, ["queued", "running", "waiting"]),
        eq(workflowRuns.currentNodeId, workflowNodeRuns.nodeId),
        eq(workflowNodeRuns.attemptCount, workflowNodeAttempts.attemptNumber),
        sql`${workflowNodeAttempts.inputSnapshot} #>> '{input,value,input,idempotencyKey}' = ${task.idempotencyKey}`)).limit(1);
    if (active?.runStatus === "blocked" && active.nodeStatus === "blocked") throw new PodArtworkDeferredError();
    if (active?.runStatus !== "active" || active.nodeStatus !== "in_progress") throw new PodArtworkInputPolicyError("The originating workflow execution is no longer active");
    try {
      const snapshot = WorkflowExecutionSnapshotSchema.parse(active.snapshot);
      const scope = { self: 0, team: 1, tenant: 2 };
      if (catalogFingerprint(snapshot) !== active.inputChecksum || scope[context.dataScope] < scope[snapshot.dataScope] || snapshot.requiredPermissions.some(permission => !context.permissions.includes(permission)))
        throw new PodArtworkInputPolicyError("Original workflow authority changed");
      await assertWorkflowMethod(tx, context, snapshot, { lock: true });
    } catch (error) {
      if (error instanceof WorkflowExecutionError || error instanceof ForbiddenError || error instanceof ZodError) throw new PodArtworkInputPolicyError("The originating workflow method or current execution authority is unavailable");
      throw error;
    }
  }
  const inputs = await tx.select({ pin: podArtworkTaskInputs, asset: assetFiles }).from(podArtworkTaskInputs)
    .innerJoin(assetFiles, eq(assetFiles.id, podArtworkTaskInputs.assetFileId)).where(eq(podArtworkTaskInputs.taskId, task.id));
  for (const { pin, asset } of inputs) {
    const kind = (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind;
    if (asset.deletedAt || pin.assetVersion !== asset.version || pin.checksumSha256 !== asset.checksumSha256 || pin.assetDomain !== asset.assetDomain
      || pin.rightsStatus !== asset.rightsStatus || (pin.rightsSourceKind ?? undefined) !== kind || kind === "customer_provided"
      || (task.toolKey !== "rights_risk_scan" && (kind === "competitor" || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved")))
      throw new PodArtworkInputPolicyError("Current POD input authorization no longer matches its snapshot");
  }
  return context;
}
