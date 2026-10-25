import { ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { createEnvironmentSecretVault, type SecretVault } from "@yummyai/ai-core";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { POD_MAX_RESPONSE_BYTES } from "@yummyai/contracts/harness/creative-response";
import {
  CREATIVE_RESPONSE_ADOPTION_VERSION, CreativeResponseAdoptionCancelSchema, CreativeResponseAdoptionCommandSchema,
  CreativeResponseAdoptionReceiptSchema, CreativeResponseAdoptionRequestViewSchema, CreativeResponseAdoptionWorkspaceSchema,
  type CreativeResponseAdoptionCommand,
} from "@yummyai/contracts/harness/creative-response-adoption";
import {
  artifactRelations, assetFiles, auditEvents, creativeDesignBatchItems, creativeDesignCandidates, creativeExecutions,
  creativeExecutionChecksum, creativeResponseAdoptions, currentCreativeExecutionAuthority, withTenant,
  type CreativeResponseAdoptionArtifactIntent, type CreativeResponseAdoptionSourcePin, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { currentCreativeAuthority, requireBatchAccess, requireBatchInputs } from "@yummyai/catalog-core";
import { assertCreativeMethod, creativeOriginalFingerprint, hashPodResponse, readCreativeExecutionSource, refreshCreativeProgress } from "@yummyai/pod-core";
import { ClamAvScanner, objectKey, type Storage } from "@yummyai/storage";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, PRIVATE_STORAGE, CREATIVE_RESPONSE_ADOPTION_OPTIONS } from "../platform.tokens.js";
import { inspectOriginalCandidateResponse, type InspectedOriginalCandidateResponse } from "./creative-response-adoption-original.js";

type Adoption = typeof creativeResponseAdoptions.$inferSelect;
type Execution = typeof creativeExecutions.$inferSelect;
const writes = [Permission.DesignRead, Permission.DesignWrite, Permission.DesignReview, Permission.AssetRead, Permission.AssetWrite];
const reads = [Permission.DesignRead, Permission.AssetRead];
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff" } as const;
type Failure = "CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE" | "CREATIVE_ADOPTION_ARCHIVE_INVALID" | "CREATIVE_ADOPTION_SCAN_FAILED"
  | "CREATIVE_ADOPTION_ARTIFACT_IO_FAILED" | "CREATIVE_ADOPTION_BASIS_CHANGED" | "CREATIVE_ADOPTION_BLOCKED"
  | "CREATIVE_ADOPTION_LEASE_LOST" | "CREATIVE_ADOPTION_PROCESSING_FAILED" | "CREATIVE_ADOPTION_CONFLICT";
const messages: Record<Failure, string> = {
  CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE: "原归档暂时无法读取 请保留原请求后核对",
  CREATIVE_ADOPTION_ARCHIVE_INVALID: "原归档未通过完整性或图片核对 原任务保持",
  CREATIVE_ADOPTION_SCAN_FAILED: "原图片未通过安全扫描 原任务保持",
  CREATIVE_ADOPTION_ARTIFACT_IO_FAILED: "本地文件保存尚未核对 请读取原请求结果",
  CREATIVE_ADOPTION_BASIS_CHANGED: "原任务或来源已变化 请保留原请求并重新核对",
  CREATIVE_ADOPTION_BLOCKED: "原任务当前不能采用 请核对原权限 来源和任务状态",
  CREATIVE_ADOPTION_LEASE_LOST: "原本地处理租约已失效 请只读核对原请求",
  CREATIVE_ADOPTION_PROCESSING_FAILED: "本地采用尚未完成 请只读核对原请求",
  CREATIVE_ADOPTION_CONFLICT: "原采用请求已存在 请使用原编号核对",
};
export class CreativeResponseAdoptionError extends ConflictException {
  constructor(readonly code: Failure) { super({ code, message: messages[code] }); }
}
const fail = (code: Failure): never => { throw new CreativeResponseAdoptionError(code); };
const missing = (): never => { throw new NotFoundException({ code: "CREATIVE_ADOPTION_NOT_FOUND", message: "原采用记录不存在" }); };
const operation = (row: Execution) => ({ kind: "creative_candidate" as const, ownerId: row.candidateId!, stepKey: "generate" });
type Options = { vault?: Pick<SecretVault, "withSecret">; scanner?: Pick<ClamAvScanner, "scan"> };

@Injectable()
export class CreativeResponseAdoptionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Optional() @Inject(CREATIVE_RESPONSE_ADOPTION_OPTIONS) private readonly options: Options = {}) {}

  /** Every route reads current membership and the actual parent owner. Retained
   * success remains readable even after the original archive expires. */
  private async scope(tx: TenantTransaction, context: TenantContext, executionId: string) {
    const { authority } = await currentCreativeAuthority(tx, context, reads);
    const [execution] = await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, executionId)).for("update");
    if (!execution || execution.kind !== "creative_candidate" || execution.stepKey !== "generate" || !execution.candidateId) return missing();
    const [association] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignCandidates)
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
      .where(eq(creativeDesignCandidates.id, execution.candidateId));
    if (!association) return missing();
    const batch = await requireBatchAccess(tx, authority, association.batchId, [Permission.DesignRead], { lock: "update" });
    // Match the original aggregate/cancellation order before locking a candidate.
    const items = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batch.id))
      .orderBy(asc(creativeDesignBatchItems.id)).for("update");
    const [candidate] = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, execution.candidateId)).for("update");
    const item = items.find(value => value.id === candidate?.itemId);
    if (!candidate || !item) return missing();
    const [clock] = await tx.execute<{ now: string }>(sql`select extract(epoch from clock_timestamp())*1000 as now`);
    const checkedAt = Number(clock?.now);
    if (!Number.isFinite(checkedAt)) throw new Error("creative_adoption_clock_unavailable");
    return { execution, batch, item, candidate, authority, checkedAt };
  }

  private async pin(tx: TenantTransaction, context: TenantContext, scope: Awaited<ReturnType<CreativeResponseAdoptionService["scope"]>>) {
    const { execution, candidate, batch, item, checkedAt } = scope;
    if (execution.requestedBy !== context.userId) return fail("CREATIVE_ADOPTION_BLOCKED");
    const original = await currentCreativeExecutionAuthority(tx, context, execution, writes);
    const authority = intersectPermissionContexts(scope.authority, original);
    for (const permission of writes) authorize(authority, permission, { ownerId: batch.createdBy });
    if (execution.effect !== "external_request" || !["failed", "uncertain"].includes(execution.phase)
      || candidate.status !== "failed" || candidate.assetId || candidate.assetVersion || candidate.checksumSha256
      || batch.archivedAt || ["completed", "cancelled"].includes(batch.status) || ["completed", "cancelled"].includes(item.status)
      || !execution.submissionToken || !execution.submittedAt || !execution.receipt
      || !execution.responseObjectKey || !execution.encryptedChecksum || !execution.responseChecksum
      || !execution.responseExpiresAt || execution.responseExpiresAt.getTime() <= checkedAt || execution.responsePurgedAt)
      return fail("CREATIVE_ADOPTION_BLOCKED");
    try {
      await assertCreativeMethod(tx, authority, execution);
      await requireBatchInputs(tx, authority, batch, checkedAt);
    } catch (cause) {
      if (cause instanceof ForbiddenError) throw cause;
      return fail("CREATIVE_ADOPTION_BLOCKED");
    }
    const source = await readCreativeExecutionSource(tx, authority, operation(execution));
    if (source.kind !== "creative_candidate" || creativeOriginalFingerprint(operation(execution), source, execution) !== execution.inputFingerprint)
      return fail("CREATIVE_ADOPTION_BASIS_CHANGED");
    // PostgreSQL originals retain microseconds. JavaScript Date truncates them;
    // pin the original database timestamps instead of weakening SQL equality.
    const [timestamps] = await tx.execute<{ submitted: string; expires: string }>(sql`select
      to_char(submitted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as submitted,
      to_char(response_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires
      from creative_executions where id=${execution.id}::uuid`);
    if (!timestamps?.submitted || !timestamps.expires) return fail("CREATIVE_ADOPTION_BLOCKED");
    const pin: CreativeResponseAdoptionSourcePin = {
      version: 1, executionId: execution.id, candidateId: candidate.id, batchId: batch.id, itemId: item.id,
      originalPhase: execution.phase as "failed" | "uncertain", inputFingerprint: execution.inputFingerprint,
      authorityChecksum: execution.authorityChecksum, contractChecksum: creativeExecutionChecksum(execution.executionContract),
      methodChecksum: creativeExecutionChecksum(execution.methodSelection), sourceChecksum: creativeExecutionChecksum(source),
      candidateChecksum: creativeExecutionChecksum(JSON.parse(JSON.stringify(candidate))), responseObjectKey: execution.responseObjectKey,
      encryptedChecksum: execution.encryptedChecksum, responseChecksum: execution.responseChecksum,
      responseExpiresAt: timestamps.expires, submissionToken: execution.submissionToken,
      submittedAt: timestamps.submitted, receipt: execution.receipt,
    };
    return { pin, basis: creativeExecutionChecksum(pin), authority, source };
  }

  private async view(tx: TenantTransaction, row: Adoption) {
    const [clock] = await tx.execute<{ active: boolean }>(sql`select lease_expires_at>clock_timestamp() as active
      from creative_response_adoptions where id=${row.id}::uuid`);
    const leaseActive = row.status === "processing" && clock?.active === true;
    return CreativeResponseAdoptionRequestViewSchema.parse({
      id: row.id, executionId: row.executionId, requestId: row.requestId, command: row.request, status: row.status,
      attempts: row.attemptCount, leaseActive, canRetry: row.status === "prepared" && row.attemptCount < 3,
      // Expiry is not proof an old uploader has stopped. Cancel and object
      // cleanup require an explicitly released, quiescent prepared attempt.
      canCancel: row.status === "prepared" || row.status === "cancelled" && !!row.artifactIntent && !row.artifactDiscardedAt, errorCode: row.errorCode,
      artifactCleanup: row.status === "committed" ? "registered" : !row.artifactIntent ? "not_required"
        : row.artifactDiscardedAt ? "complete" : "pending",
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), receipt: row.receipt,
    });
  }

  async workspace(context: TenantContext, executionId: string) {
    return withTenant(this.database.db, context, async tx => {
      const scope = await this.scope(tx, context, executionId), { execution, candidate, batch, checkedAt } = scope;
      const requests = await tx.select().from(creativeResponseAdoptions).where(eq(creativeResponseAdoptions.executionId, executionId));
      let basis: string | null = null; const blockers: string[] = [];
      try { basis = (await this.pin(tx, context, scope)).basis; }
      catch (cause) {
        if (cause instanceof ForbiddenError || cause instanceof CreativeResponseAdoptionError || cause instanceof Error && ("status" in cause || "code" in cause))
          blockers.push("原权限 来源或任务状态不满足采用条件");
        else throw cause;
      }
      const archiveState = execution.responsePurgedAt ? "purged" : !execution.responseObjectKey ? "missing"
        : !execution.responseExpiresAt || execution.responseExpiresAt.getTime() <= checkedAt ? "expired" : "registered_unverified";
      if (requests.length) blockers.push(requests[0]!.status === "committed" ? "原响应已有独立采用回执" : "请继续核对原采用请求");
      return CreativeResponseAdoptionWorkspaceSchema.parse({ version: CREATIVE_RESPONSE_ADOPTION_VERSION,
        executionId, candidateId: candidate.id, batchId: batch.id,
        identityStamp: creativeExecutionChecksum({ version: CREATIVE_RESPONSE_ADOPTION_VERSION, tenantId: context.tenantId, userId: context.userId }),
        kind: "creative_candidate", stepKey: "generate", originalPhase: execution.phase, candidateStatus: candidate.status, basis,
        canInspectOriginal: basis !== null, canAdopt: basis !== null && !requests.some(row => ["committed", "cancelled"].includes(row.status)), blockers,
        source: { inputFingerprint: execution.inputFingerprint, responseChecksum: execution.responseChecksum, encryptedChecksum: execution.encryptedChecksum,
          archiveState, archiveExpiresAt: execution.responseExpiresAt?.toISOString() ?? null, providerRequestId: execution.receipt?.providerRequestId ?? null,
          receivedAt: execution.receipt?.receivedAt ?? null, modelKey: execution.receipt?.modelKey ?? null, modelVersion: execution.receipt?.modelVersion ?? null,
          originalCostUsd: execution.receipt?.costUsd ?? null, providerInvoiceVerified: false },
        requests: await Promise.all(requests.map(row => this.view(tx, row))), noNewModelCall: true, resultRequiresReview: true,
      });
    });
  }

  private async inspect(context: TenantContext, pin: CreativeResponseAdoptionSourcePin, signal: AbortSignal) {
    let encryptedBytes: Uint8Array;
    try {
      encryptedBytes = await this.storage.readPrivate(context, { id: pin.executionId, tenantId: context.tenantId, assetDomain: "quarantine", objectKey: pin.responseObjectKey },
        { requiredDomain: "quarantine", maxBytes: 2 * POD_MAX_RESPONSE_BYTES, signal });
    } catch { return fail("CREATIVE_ADOPTION_ARCHIVE_UNAVAILABLE"); }
    try {
      return await inspectOriginalCandidateResponse({ pin: { ...pin, tenantId: context.tenantId }, encryptedBytes,
        vault: this.options.vault ?? createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1"),
        scanner: this.options.scanner ?? new ClamAvScanner(), signal });
    } catch (cause) {
      return fail(cause instanceof Error && "code" in cause && cause.code === "CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED"
        ? "CREATIVE_ADOPTION_SCAN_FAILED" : "CREATIVE_ADOPTION_ARCHIVE_INVALID");
    }
  }

  async preview(context: TenantContext, executionId: string, basis: string) {
    const pinned = await withTenant(this.database.db, context, async tx => {
      const value = await this.pin(tx, context, await this.scope(tx, context, executionId));
      if (value.basis !== basis) return fail("CREATIVE_ADOPTION_BASIS_CHANGED"); return value;
    });
    const image = await this.inspect(pinned.authority, pinned.pin, AbortSignal.timeout(90_000));
    await this.recheck(context, executionId, basis);
    return { bytes: image.bytes, mediaType: image.mediaType, basis, responseChecksum: pinned.pin.responseChecksum, artifactChecksum: image.checksumSha256 };
  }

  private async recheck(context: TenantContext, executionId: string, basis: string) {
    return withTenant(this.database.db, context, async tx => {
      const value = await this.pin(tx, context, await this.scope(tx, context, executionId));
      if (value.basis !== basis) return fail("CREATIVE_ADOPTION_BASIS_CHANGED"); return value;
    });
  }

  async lookup(context: TenantContext, executionId: string, requestId: string) {
    return withTenant(this.database.db, context, async tx => {
      await this.scope(tx, context, executionId);
      const [row] = await tx.select().from(creativeResponseAdoptions).where(and(eq(creativeResponseAdoptions.executionId, executionId), eq(creativeResponseAdoptions.requestId, requestId)));
      return row ? this.view(tx, row) : missing();
    });
  }

  private async leased(tx: TenantTransaction, id: string, token: string) {
    const [row] = await tx.select({ row: creativeResponseAdoptions,
      active: sql<boolean>`${creativeResponseAdoptions.leaseExpiresAt}>clock_timestamp()` })
      .from(creativeResponseAdoptions).where(eq(creativeResponseAdoptions.id, id)).for("update");
    if (!row || row.row.status !== "processing" || row.row.leaseToken !== token || !row.active) return fail("CREATIVE_ADOPTION_LEASE_LOST");
    return row.row;
  }

  async adopt(context: TenantContext, executionId: string, raw: unknown) {
    const command = CreativeResponseAdoptionCommandSchema.parse(raw);
    const prepared = await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`creative-response-adoption:${context.tenantId}:${context.userId}:${command.requestId}`},0))`);
      const scope = await this.scope(tx, context, executionId);
      if (scope.execution.requestedBy !== context.userId) return fail("CREATIVE_ADOPTION_BLOCKED");
      const [prior] = await tx.select().from(creativeResponseAdoptions).where(or(eq(creativeResponseAdoptions.executionId, executionId),
        and(eq(creativeResponseAdoptions.requestedBy, context.userId), eq(creativeResponseAdoptions.requestId, command.requestId)))).for("update");
      if (prior && (prior.executionId !== executionId || prior.requestChecksum !== creativeExecutionChecksum(command))) return fail("CREATIVE_ADOPTION_CONFLICT");
      if (prior?.status === "cancelled") return fail("CREATIVE_ADOPTION_CONFLICT");
      if (prior && ((await this.view(tx, prior)).leaseActive || prior.status === "committed")) return { view: await this.view(tx, prior) };
      if (prior?.status === "processing") return fail("CREATIVE_ADOPTION_LEASE_LOST");
      const pinned = await this.pin(tx, context, scope);
      if (pinned.basis !== command.expectedBasis) return fail("CREATIVE_ADOPTION_BASIS_CHANGED");
      let row = prior;
      if (!row) {
        [row] = await tx.insert(creativeResponseAdoptions).values({ id: createEntityId(), tenantId: context.tenantId, executionId,
          candidateId: scope.candidate.id, requestedBy: context.userId, requestId: command.requestId, request: command,
          requestChecksum: creativeExecutionChecksum(command), expectedBasis: command.expectedBasis, sourcePin: pinned.pin }).returning();
      }
      if (!row || row.attemptCount >= 3) return fail("CREATIVE_ADOPTION_BLOCKED");
      const token = createEntityId();
      const [claimed] = await tx.update(creativeResponseAdoptions).set({ status: "processing", attemptCount: row.attemptCount + 1,
        leaseToken: token, leaseExpiresAt: sql`clock_timestamp()+interval '180 seconds'`, errorCode: null, updatedAt: sql`clock_timestamp()` })
        .where(eq(creativeResponseAdoptions.id, row.id)).returning();
      return { row: claimed!, token, pinned };
    });
    if (prepared.view) return prepared.view;
    const { row, token, pinned } = prepared;
    let artifactDispatched = false, artifactConfirmed = false;
    try {
      const signal = AbortSignal.timeout(90_000), image = await this.inspect(pinned.authority, row.sourcePin, signal);
      const intent = await withTenant(this.database.db, context, async tx => {
        const current = await this.pin(tx, context, await this.scope(tx, context, executionId));
        if (current.basis !== command.expectedBasis) return fail("CREATIVE_ADOPTION_BASIS_CHANGED");
        const owned = await this.leased(tx, row.id, token), proposed = this.intent(context, owned, image);
        if (owned.artifactIntent) {
          if (creativeExecutionChecksum(owned.artifactIntent) !== creativeExecutionChecksum({ ...proposed, assetId: owned.artifactIntent.assetId }))
            return fail("CREATIVE_ADOPTION_ARCHIVE_INVALID");
          return owned.artifactIntent;
        }
        await tx.update(creativeResponseAdoptions).set({ artifactIntent: proposed, updatedAt: sql`clock_timestamp()` }).where(eq(creativeResponseAdoptions.id, row.id));
        return proposed;
      });
      try {
        signal.throwIfAborted();
        artifactDispatched = true;
        const stored = await this.storage.putPrivate(pinned.authority, { body: image.bytes, domain: "authorized", fileName: intent.fileName, mediaType: intent.mediaType });
        if (stored.objectKey !== intent.objectKey || stored.checksumSha256 !== intent.checksumSha256) return fail("CREATIVE_ADOPTION_ARTIFACT_IO_FAILED");
        const bytes = await this.storage.readPrivate(pinned.authority, { id: intent.assetId, tenantId: context.tenantId, assetDomain: "authorized", objectKey: intent.objectKey },
          { requiredDomain: "authorized", maxBytes: intent.byteSize, signal });
        if (bytes.byteLength !== intent.byteSize || hashPodResponse(bytes) !== intent.checksumSha256) return fail("CREATIVE_ADOPTION_ARTIFACT_IO_FAILED");
        artifactConfirmed = true;
      } catch {
        // A lost storage ACK is reconciled by actual bounded original bytes.
        // A missing object or failed read does not prove that its remote PUT
        // stopped; retain processing ownership in that uncertain case.
        if (artifactDispatched) try {
          const retained = await this.storage.readPrivate(pinned.authority, { id: intent.assetId, tenantId: context.tenantId,
            assetDomain: "authorized", objectKey: intent.objectKey }, { requiredDomain: "authorized", maxBytes: intent.byteSize, signal: AbortSignal.timeout(15_000) });
          artifactConfirmed = retained.byteLength === intent.byteSize && hashPodResponse(retained) === intent.checksumSha256;
        } catch { /* Absence and transport failure remain an unresolved write. */ }
        return fail("CREATIVE_ADOPTION_ARTIFACT_IO_FAILED");
      }
      return await this.commit(context, executionId, command, row.id, token, intent);
    } catch (cause) {
      const failure = cause instanceof CreativeResponseAdoptionError ? cause : new CreativeResponseAdoptionError(
        cause instanceof ForbiddenError || cause instanceof Error && "status" in cause && [403, 404, 409].includes(Number(cause.status))
          ? "CREATIVE_ADOPTION_BLOCKED" : "CREATIVE_ADOPTION_PROCESSING_FAILED");
      // This is compensation of the owned local lease only. Original execution
      // history and any immutable artifact intent remain byte-for-byte intact.
      await withTenant(this.database.db, context, async tx => {
        const [owned] = await tx.select().from(creativeResponseAdoptions).where(eq(creativeResponseAdoptions.id, row.id)).for("update");
        if (owned?.status === "processing" && owned.leaseToken === token) {
          const quiescent = !artifactDispatched || artifactConfirmed;
          await tx.update(creativeResponseAdoptions).set({ ...(quiescent ? { status: "prepared" as const, leaseToken: null, leaseExpiresAt: null } : {}),
            errorCode: failure.code, updatedAt: sql`clock_timestamp()` }).where(eq(creativeResponseAdoptions.id, row.id));
        }
      });
      throw failure;
    }
  }

  private intent(context: TenantContext, row: Adoption, image: InspectedOriginalCandidateResponse): CreativeResponseAdoptionArtifactIntent {
    const fileName = `${row.id}-pod-output-0.${extensions[image.mediaType]}`;
    return { assetId: createEntityId(), fileName,
      objectKey: objectKey({ tenantId: context.tenantId, domain: "authorized", sha256: image.checksumSha256, fileName }),
      checksumSha256: image.checksumSha256, byteSize: image.bytes.byteLength, mediaType: image.mediaType, width: image.width, height: image.height,
      modelKey: image.modelKey, modelVersion: image.modelVersion, seed: image.seed, qualityCheckSnapshot: image.qualityCheckSnapshot, outputMetadata: image.outputMetadata };
  }

  private async commit(context: TenantContext, executionId: string, command: CreativeResponseAdoptionCommand, id: string, token: string,
    intent: CreativeResponseAdoptionArtifactIntent) {
    return withTenant(this.database.db, context, async tx => {
      const scope = await this.scope(tx, context, executionId), pinned = await this.pin(tx, context, scope);
      if (pinned.basis !== command.expectedBasis) return fail("CREATIVE_ADOPTION_BASIS_CHANGED");
      const row = await this.leased(tx, id, token);
      if (creativeExecutionChecksum(row.artifactIntent) !== creativeExecutionChecksum(intent)) return fail("CREATIVE_ADOPTION_CONFLICT");
      const [clock] = await tx.execute<{ time: string }>(sql`select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as time`);
      const now = new Date(clock!.time);
      await tx.insert(assetFiles).values({ id: intent.assetId, tenantId: context.tenantId, ownerUserId: context.userId,
        objectKey: intent.objectKey, assetDomain: "authorized", fileName: intent.fileName, mediaType: intent.mediaType,
        byteSize: intent.byteSize, checksumSha256: intent.checksumSha256, version: 1, aiGenerated: true, rightsStatus: "unverified",
        rightsMetadata: { source: { kind: "ai_generated", reference: `creative-design:${intent.modelKey}:${intent.modelVersion}` },
          candidateId: scope.candidate.id, modelKey: intent.modelKey, modelVersion: intent.modelVersion, seed: intent.seed,
          promptTemplateVersion: scope.candidate.promptTemplateVersion, processorQuality: intent.qualityCheckSnapshot, outputMetadata: intent.outputMetadata,
          responseAdoptionId: row.id, originalExecutionId: executionId, originalResponseChecksum: row.sourcePin.responseChecksum } });
      await tx.update(creativeDesignCandidates).set({ status: "generated", assetId: intent.assetId, assetVersion: 1,
        checksumSha256: intent.checksumSha256, modelKey: intent.modelKey, modelVersion: intent.modelVersion, seed: intent.seed,
        costUsd: row.sourcePin.receipt.costUsd, qualitySnapshot: intent.qualityCheckSnapshot, completedAt: now, updatedAt: now,
        errorCode: null, errorMessage: null }).where(eq(creativeDesignCandidates.id, scope.candidate.id));
      if (pinned.source.referenceSnapshot.length) await tx.insert(artifactRelations).values(pinned.source.referenceSnapshot.map(ref => ({
        id: createEntityId(), tenantId: context.tenantId, fromAssetId: ref.assetId, fromAssetVersion: ref.assetVersion,
        toAssetId: intent.assetId, toAssetVersion: 1, relationType: "source_to_result" as const, createdBy: context.userId,
      }))).onConflictDoNothing();
      await refreshCreativeProgress(tx, scope.batch.id);
      const receipt = CreativeResponseAdoptionReceiptSchema.parse({ version: CREATIVE_RESPONSE_ADOPTION_VERSION, id: row.id, executionId,
        requestId: command.requestId, basis: command.expectedBasis, candidateId: row.candidateId, originalPhase: row.sourcePin.originalPhase,
        inputFingerprint: row.sourcePin.inputFingerprint, responseChecksum: row.sourcePin.responseChecksum, encryptedChecksum: row.sourcePin.encryptedChecksum,
        artifact: { assetId: intent.assetId, version: 1, checksumSha256: intent.checksumSha256, mediaType: intent.mediaType, width: intent.width, height: intent.height },
        modelKey: intent.modelKey, modelVersion: intent.modelVersion, originalCostUsd: row.sourcePin.receipt.costUsd,
        disposition: "generated", rightsStatus: "unverified", approval: "review_required", committedAt: now.toISOString() });
      const [committed] = await tx.update(creativeResponseAdoptions).set({ status: "committed", receipt, committedAt: now,
        leaseToken: null, leaseExpiresAt: null, updatedAt: now }).where(eq(creativeResponseAdoptions.id, row.id)).returning();
      await tx.insert(auditEvents).values({ id: createEntityId(), tenantId: context.tenantId, actorUserId: context.userId,
        action: "creative_response.adopted", entityType: "creative_response_adoption", entityId: row.id, result: "success",
        metadata: { executionId, candidateId: row.candidateId, requestId: row.requestId, basis: row.expectedBasis,
          assetId: intent.assetId, disposition: "generated", rightsStatus: "unverified", approval: "review_required", noNewModelCall: true } });
      return this.view(tx, committed!);
    });
  }

  async cancel(context: TenantContext, executionId: string, adoptionId: string, raw: unknown) {
    const command = CreativeResponseAdoptionCancelSchema.parse(raw);
    const cancelled = await withTenant(this.database.db, context, async tx => {
      const scope = await this.scope(tx, context, executionId);
      // Cancellation can compensate a failed attempt even if its parent or
      // source was subsequently cancelled. It still requires current own rights.
      for (const permission of writes) authorize(scope.authority, permission, { ownerId: scope.batch.createdBy });
      const [row] = await tx.select().from(creativeResponseAdoptions).where(and(eq(creativeResponseAdoptions.id, adoptionId),
        eq(creativeResponseAdoptions.executionId, executionId), eq(creativeResponseAdoptions.requestId, command.requestId))).for("update");
      if (!row) return missing();
      if (row.status === "committed" || row.status === "cancelled") return row;
      if (row.status !== "prepared") return fail("CREATIVE_ADOPTION_BLOCKED");
      const [result] = await tx.update(creativeResponseAdoptions).set({ status: "cancelled", cancelledAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()` }).where(eq(creativeResponseAdoptions.id, row.id)).returning(); return result!;
    });
    if (cancelled.status === "cancelled" && cancelled.artifactIntent && !cancelled.artifactDiscardedAt) {
      await withTenant(this.database.db, context, async tx => {
        const scope = await this.scope(tx, context, executionId);
        for (const permission of writes) authorize(scope.authority, permission, { ownerId: scope.batch.createdBy });
        const [row] = await tx.select().from(creativeResponseAdoptions).where(eq(creativeResponseAdoptions.id, cancelled.id)).for("update");
        if (!row || row.status !== "cancelled" || !row.artifactIntent || row.artifactDiscardedAt) return;
        const [registered] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(eq(assetFiles.objectKey, row.artifactIntent.objectKey));
        if (registered) return fail("CREATIVE_ADOPTION_BLOCKED");
        // Exact owned key, including all object-store versions; never the
        // original response archive or any registered business asset.
        await this.storage.discardCreativeResponseAdoptionArtifact(scope.authority, row.id, row.artifactIntent.objectKey, { signal: AbortSignal.timeout(30_000) });
        await tx.update(creativeResponseAdoptions).set({ artifactDiscardedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
          .where(eq(creativeResponseAdoptions.id, row.id));
      });
    }
    return this.lookup(context, executionId, command.requestId);
  }
}
