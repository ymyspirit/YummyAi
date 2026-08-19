import { Permission } from "@yummyai/authz";
import { RightsRiskQualityCheckSnapshotSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  artifactRelations,
  assetFiles,
  designTasks,
  designVersionFiles,
  designVersions,
  podArtworkTaskInputs,
  podArtworkTasks,
  rightsAssessments,
  visualFingerprints,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type {
  PodArtworkExecutionRecord,
  PodArtworkExecutionRepository,
  PodArtworkExecutionResult,
} from "./pod-artwork.processor.js";

export class PodArtworkSnapshotMismatchError extends Error {
  constructor(assetId: string) {
    super(`POD artwork input snapshot no longer matches asset ${assetId}`);
    this.name = "PodArtworkSnapshotMismatchError";
  }
}

export class DrizzlePodArtworkExecutionRepository implements PodArtworkExecutionRepository {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly storage: Storage,
  ) {}

  async load(context: Pick<TenantContext, "tenantId" | "userId">, taskId: string): Promise<PodArtworkExecutionRecord | undefined> {
    const tenantContext = workerContext(context);
    const loaded = await withTenant(this.database.db, tenantContext, async (tx) => {
      const [task] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, taskId)).limit(1);
      if (!task) return undefined;
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
    const [claimed] = await withTenant(this.database.db, workerContext(context), (tx) => tx.update(podArtworkTasks).set({
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
      inArray(podArtworkTasks.status, ["queued", "failed"]),
    )).returning({ id: podArtworkTasks.id }));
    return Boolean(claimed);
  }

  async complete(
    context: Pick<TenantContext, "tenantId" | "userId">,
    task: PodArtworkExecutionRecord,
    result: PodArtworkExecutionResult,
  ) {
    const tenantContext = workerContext(context);
    const rightsQuality = task.toolKey === "rights_risk_scan"
      ? RightsRiskQualityCheckSnapshotSchema.parse(result.qualityCheckSnapshot)
      : undefined;
    const outputs = await Promise.all(result.outputs.map(async (output) => {
      const fileName = `${task.id}-${output.fileName}`;
      const stored = await this.storage.putPrivate(tenantContext, {
        body: output.bytes,
        domain: "authorized",
        fileName,
        mediaType: output.mediaType,
      });
      return { ...output, fileName, stored };
    }));

    await withTenant(this.database.db, tenantContext, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pod-artwork:${task.id}`}, 0))`);
      const [current] = await tx.select().from(podArtworkTasks).where(eq(podArtworkTasks.id, task.id)).limit(1);
      if (!current || current.resultVersionId) return;
      if (current.status !== "running") throw new Error("POD artwork task is not running");

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
      await tx.update(podArtworkTasks).set({
        status: rightsQuality && (rightsQuality.highRiskDetected || rightsQuality.unknownRiskDetected)
          ? "blocked"
          : result.partial ? "partially_succeeded" : "awaiting_review",
        progressPercent: 100,
        resultVersionId: versionId,
        modelKey: result.modelKey,
        modelVersion: result.modelVersion,
        seed: result.seed ?? null,
        qualityCheckSnapshot: result.qualityCheckSnapshot,
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(podArtworkTasks.id, task.id));
      await tx.update(designTasks).set({ status: "in_review", updatedAt: new Date() })
        .where(eq(designTasks.id, task.designTaskId));
    });
  }

  async fail(
    context: Pick<TenantContext, "tenantId" | "userId">,
    taskId: string,
    input: { attempt: number; terminal: boolean; code: string; message: string },
  ) {
    const blocked = input.code === "INPUT_POLICY_BLOCKED";
    await withTenant(this.database.db, workerContext(context), (tx) => tx.update(podArtworkTasks).set({
      status: blocked ? "blocked" : input.terminal ? "failed" : "queued",
      progressPercent: 0,
      attemptCount: input.attempt + 1,
      errorCode: input.code,
      errorMessage: input.message,
      completedAt: blocked || input.terminal ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(podArtworkTasks.id, taskId)));
  }
}

function workerContext(context: Pick<TenantContext, "tenantId" | "userId">): TenantContext {
  return {
    ...context,
    permissions: [Permission.AssetRead],
    dataScope: "tenant",
  };
}
