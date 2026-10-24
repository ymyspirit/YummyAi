import { createEnvironmentSecretVault, type SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreativeExecutionCompletionSchema, PodInvocationReceiptSchema, type PodInvocationReceipt } from "@yummyai/contracts/harness";
import { aiBudgetLedger, assetFiles, creativeExecutions as executions, creativeExecutionChecksum, withTenant,
  creativeStudioGenerations, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { creativeHarness, creativeOwnerCondition, type CreativeOperation } from "@yummyai/pod-core";
import { ClamAvScanner, objectKey, type Storage } from "@yummyai/storage";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { admitCreativeExecution, type CreativeWorkerIdentity } from "./creative-execution-admission.js";
import { reserveCreativeBudget, settleCreativeBudget, type CreativeBillingIdentity } from "./creative-execution-budget.js";
import { creativeMediaExtension, creativeResponseChecksum, parseCreativeResponse, type CreativeLocalOutput, type CreativeResponse } from "./creative-execution-response.js";
import { hashPodResponse, POD_MAX_RESPONSE_BYTES } from "./pod-artwork-response.js";

type Execution = typeof executions.$inferSelect;
type Admission = Awaited<ReturnType<typeof admitCreativeExecution>>;
type TxAction<T> = (tx: TenantTransaction, admission: Admission) => Promise<T>;
export type CreativeExecutionClaim = { id: string; token: string; operation: CreativeOperation; hasResponse: boolean; submissionToken: string | null };
export type CreativeArtifact = CreativeLocalOutput & { aiGenerated: boolean; rightsStatus: "approved" | "unverified"; rightsMetadata: Record<string, unknown> };
export type CreativeStoredArtifact = Pick<typeof assetFiles.$inferSelect, "id" | "version" | "checksumSha256" | "objectKey" | "mediaType">;
const internal = (identity: CreativeWorkerIdentity): TenantContext => ({ ...identity, permissions: [], dataScope: "tenant" });
// Restricted to retaining/discarding the exact original execution namespace. Never used for business admission.
const retention = (identity: CreativeWorkerIdentity): TenantContext => ({ ...identity, permissions: [Permission.AssetRead], dataScope: "tenant" });
const terminal = (row: Execution) => ["completed", "failed", "uncertain"].includes(row.phase);

/** Original-owner execution. Redis delivery and envelope retries cannot authorize another paid call. */
export class CreativeExecutionRecovery {
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly contentVault?: SecretVault,
    private readonly stopped?: (tx: TenantTransaction, row: Execution, code: string, deferred: boolean) => Promise<void>,
    private readonly scanner: Pick<ClamAvScanner, "scan"> = new ClamAvScanner()) {}
  private vault() { return this.contentVault ?? createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1"); }

  async claim(identity: CreativeWorkerIdentity, operation: CreativeOperation, onClaim?: TxAction<void>): Promise<CreativeExecutionClaim | undefined> {
    return withTenant(this.database.db, internal(identity), async tx => {
      const [found] = await tx.select({ row: executions, active: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()`,
        due: sql<boolean>`${executions.nextAttemptAt}<=clock_timestamp()`, expired: sql<boolean>`${executions.responseExpiresAt}<=clock_timestamp()` })
        .from(executions).where(creativeOwnerCondition(operation)).for("update");
      if (!found) throw new Error("CREATIVE_LEGACY_AUTHORITY_MISSING");
      const row = found.row;
      if (row.requestedBy !== identity.userId) throw new Error("CREATIVE_ORIGINAL_ACTOR_MISMATCH");
      if (terminal(row) || found.active || !found.due) return undefined;
      if (found.expired || row.responsePurgedAt || row.attemptCount >= 3) {
        await this.stop(tx, row, found.expired || row.responsePurgedAt ? "CREATIVE_RESPONSE_EXPIRED" : "CREATIVE_LOCAL_PROCESSING_FAILED");
        return undefined;
      }
      if (row.submittedAt && !row.responseObjectKey) {
        const [generation] = row.kind === "studio_generation" ? await tx.select().from(creativeStudioGenerations)
          .where(eq(creativeStudioGenerations.id, row.studioGenerationId!)).for("share") : [];
        if (generation?.modelSnapshot.capability !== "video" || !generation.providerTaskId || !/^[a-zA-Z0-9_-]{1,160}$/.test(generation.providerTaskId)) {
          await this.stop(tx, row, "CREATIVE_RESULT_UNCERTAIN"); return undefined;
        }
      }
      const admission = await admitCreativeExecution(tx, identity, operation), token = createEntityId();
      await tx.update(executions).set({ phase: row.responseObjectKey ? row.phase : "preparing", attemptCount: row.attemptCount + 1,
        leaseToken: token, leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'`, errorCode: null, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
      if (onClaim) await onClaim(tx, admission);
      return { id: row.id, token, operation, hasResponse: row.responseObjectKey !== null, submissionToken: row.submissionToken };
    });
  }

  private async owns(tx: TenantTransaction, identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim) {
    const [found] = await tx.select({ row: executions, active: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()` })
      .from(executions).where(eq(executions.id, claim.id)).for("update");
    if (!found || !found.active || found.row.leaseToken !== claim.token || found.row.requestedBy !== identity.userId
      || terminal(found.row) || !isSameOperation(found.row, claim.operation)) throw new Error("CREATIVE_EXECUTION_LEASE_LOST");
    return found.row;
  }
  async authorized<T>(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, action: TxAction<T>) {
    return withTenant(this.database.db, internal(identity), async tx => {
      await this.owns(tx, identity, claim);
      return action(tx, await admitCreativeExecution(tx, identity, claim.operation));
    });
  }
  async renew(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim) {
    return this.authorized(identity, claim, async tx => {
      await tx.update(executions).set({ leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, claim.id));
    });
  }
  async withLease<T>(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
    const control = new AbortController(), combined = AbortSignal.any([signal, control.signal]);
    let pulse: Promise<void> = Promise.resolve(), stopped = false;
    const timer = setInterval(() => {
      if (!stopped) pulse = pulse.then(() => this.renew(identity, claim)).catch(() => { control.abort(new Error("CREATIVE_EXECUTION_LEASE_LOST")); });
    }, 30_000);
    timer.unref();
    try { combined.throwIfAborted(); const result = await work(combined); combined.throwIfAborted(); return result; }
    finally { stopped = true; clearInterval(timer); await pulse; }
  }

  async markSubmitted(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, billing: CreativeBillingIdentity) {
    this.vault();
    const token = await this.authorized(identity, claim, async (tx, admission) => {
      const row = admission.execution;
      if (row.effect !== "external_request" || row.submittedAt || row.responseObjectKey) throw new Error("CREATIVE_SUBMISSION_ALREADY_RECORDED");
      const budget = await reserveCreativeBudget(tx, row, billing), submissionToken = createEntityId();
      await tx.update(executions).set({ phase: "submitted", submittedAt: sql`clock_timestamp()`, submissionToken,
        budgetLedgerId: budget.id, budgetLimitUsd: budget.limit, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
      return submissionToken;
    });
    claim.submissionToken = token;
  }

  async rememberStudioTask(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, taskId: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(taskId)) throw new Error("CREATIVE_PROVIDER_TASK_INVALID");
    await withTenant(this.database.db, internal(identity), async tx => {
      const [row] = await tx.select().from(executions).where(eq(executions.id, claim.id)).for("update");
      if (!row || row.kind !== "studio_generation" || row.requestedBy !== identity.userId || !claim.submissionToken
        || row.submissionToken !== claim.submissionToken || !row.submittedAt) throw new Error("CREATIVE_SUBMISSION_MISSING");
      const [generation] = await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, row.studioGenerationId!)).for("update");
      if (!generation || generation.modelSnapshot.capability !== "video" || (generation.providerTaskId && generation.providerTaskId !== taskId)) throw new Error("CREATIVE_PROVIDER_TASK_CHANGED");
      if (!generation.providerTaskId) await tx.update(creativeStudioGenerations).set({ providerTaskId: taskId, updatedAt: sql`clock_timestamp()` }).where(eq(creativeStudioGenerations.id, generation.id));
    });
  }

  /** Submission token authorizes retaining this call's receipt, never adopting its content. */
  async record(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, response?: CreativeResponse, rawReceipt?: PodInvocationReceipt) {
    const prepared = response ? parseCreativeResponse(response) : undefined;
    const receipt = rawReceipt ? PodInvocationReceiptSchema.parse(rawReceipt) : prepared?.kind === "pod" ? prepared.checkpoint.receipt : prepared?.kind === "studio" ? prepared.receipt : null;
    const checksum = prepared ? creativeResponseChecksum(prepared) : receipt?.responseChecksum;
    if (prepared?.kind === "pod" && !isDeepStrictEqual(prepared.checkpoint.receipt, receipt)) throw new Error("CREATIVE_RESPONSE_RECEIPT_CHANGED");
    if (prepared?.kind === "studio" && !isDeepStrictEqual(prepared.receipt, receipt)) throw new Error("CREATIVE_RESPONSE_RECEIPT_CHANGED");
    if (prepared && receipt && checksum !== receipt.responseChecksum) throw new Error("CREATIVE_RESPONSE_RECEIPT_CHANGED");
    const staged = await withTenant(this.database.db, internal(identity), async tx => {
      const [row] = await tx.select().from(executions).where(eq(executions.id, claim.id)).for("update");
      if (!row || row.requestedBy !== identity.userId || !isSameOperation(row, claim.operation)) throw new Error("CREATIVE_ORIGINAL_ACTOR_MISMATCH");
      if (row.effect === "external_request") {
        if (!claim.submissionToken || row.submissionToken !== claim.submissionToken || !row.submittedAt || !receipt) throw new Error("CREATIVE_SUBMISSION_MISSING");
      } else {
        await this.owns(tx, identity, claim); await admitCreativeExecution(tx, identity, claim.operation);
        if (receipt || prepared?.kind !== "local") throw new Error("CREATIVE_LOCAL_STEP_HAS_NO_PAID_RECEIPT");
      }
      if (row.receipt && !isDeepStrictEqual(row.receipt, receipt)) throw new Error("CREATIVE_RESPONSE_RECEIPT_CHANGED");
      if (receipt) await settleCreativeBudget(tx, row, receipt);
      if (row.responseObjectKey) {
        if (row.responseChecksum !== checksum) throw new Error("CREATIVE_RESPONSE_CHANGED");
        return null;
      }
      if (!prepared) {
        if (receipt && !row.receipt) await tx.update(executions).set({ receipt, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
        return null;
      }
      const body = Buffer.from(this.vault().encrypt(JSON.stringify({ version: 1, tenantId: identity.tenantId, executionId: row.id,
        inputFingerprint: row.inputFingerprint, response: prepared })));
      const encryptedChecksum = hashPodResponse(body), fileName = `${row.id}-pod-response.pe`;
      const key = objectKey({ tenantId: identity.tenantId, domain: "quarantine", sha256: encryptedChecksum, fileName });
      await tx.update(executions).set({ ...(terminal(row) ? {} : { phase: "response_staging" as const }), receipt,
        responseObjectKey: key, encryptedChecksum, responseChecksum: checksum, responseExpiresAt: sql`clock_timestamp()+interval '7 days'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
      return { body, fileName, key, checksum: encryptedChecksum };
    });
    if (!staged) return;
    const stored = await this.storage.putPrivate(retention(identity), { body: staged.body, domain: "quarantine", fileName: staged.fileName, mediaType: "application/octet-stream" });
    if (stored.objectKey !== staged.key || stored.checksumSha256 !== staged.checksum) throw new Error("CREATIVE_RESPONSE_STORAGE_CHANGED");
    // The exact intent above makes a lost acknowledgement recoverable without resubmission.
  }

  async read(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim): Promise<CreativeResponse> {
    const loaded = await this.authorized(identity, claim, async (tx, admission) => {
      await this.assertResponseUsable(tx, admission.execution.id);
      return admission;
    });
    const parsed = await this.decodeSaved(identity, loaded);
    await this.authorized(identity, claim, async tx => {
      await this.assertResponseUsable(tx, claim.id);
      await tx.update(executions).set({ phase: "response_ready", updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, claim.id));
    });
    return parsed;
  }

  /** A completed paid child is a reusable original response, never permission to submit again. */
  async readCompleted(identity: CreativeWorkerIdentity, operation: CreativeOperation): Promise<CreativeResponse> {
    const load = () => withTenant(this.database.db, internal(identity), async tx => {
      const admission = await admitCreativeExecution(tx, identity, operation);
      if (admission.execution.phase !== "completed") throw new Error("CREATIVE_RESPONSE_NOT_COMPLETED");
      await this.assertResponseUsable(tx, admission.execution.id); return admission;
    });
    const loaded = await load(), parsed = await this.decodeSaved(identity, loaded);
    const current = await load();
    if (current.execution.responseObjectKey !== loaded.execution.responseObjectKey) throw new Error("CREATIVE_RESPONSE_CHANGED");
    return parsed;
  }
  private async assertResponseUsable(tx: TenantTransaction, id: string) {
    const [clock] = await tx.select({ usable: sql<boolean>`${executions.responseExpiresAt}>clock_timestamp() AND ${executions.responsePurgedAt} IS NULL AND ${executions.responseObjectKey} IS NOT NULL` })
      .from(executions).where(eq(executions.id, id));
    if (!clock?.usable) throw new Error("CREATIVE_RESPONSE_EXPIRED");
  }
  private async decodeSaved(identity: CreativeWorkerIdentity, loaded: Admission): Promise<CreativeResponse> {
    const row = loaded.execution;
    const bytes = await this.storage.readPrivate(loaded.authority, { id: row.id, tenantId: identity.tenantId, assetDomain: "quarantine", objectKey: row.responseObjectKey! },
      { requiredDomain: "quarantine", maxBytes: 2 * POD_MAX_RESPONSE_BYTES });
    if (hashPodResponse(bytes) !== row.encryptedChecksum) throw new Error("CREATIVE_RESPONSE_INVALID");
    let saved: unknown;
    try { saved = this.vault().withSecret(Buffer.from(bytes).toString(), raw => JSON.parse(raw)); } catch { throw new Error("CREATIVE_RESPONSE_INVALID"); }
    const value = saved as { version?: unknown; tenantId?: unknown; executionId?: unknown; inputFingerprint?: unknown; response?: unknown } | null;
    if (!value || value.version !== 1 || value.tenantId !== identity.tenantId || value.executionId !== row.id || value.inputFingerprint !== row.inputFingerprint) throw new Error("CREATIVE_RESPONSE_INVALID");
    const parsed = parseCreativeResponse(value.response);
    if (creativeResponseChecksum(parsed) !== row.responseChecksum || (parsed.kind === "pod" && !isDeepStrictEqual(parsed.checkpoint.receipt, row.receipt))
      || (parsed.kind === "studio" && !isDeepStrictEqual(parsed.receipt, row.receipt))) throw new Error("CREATIVE_RESPONSE_INVALID");
    return parsed;
  }

  /** Upload and read back bytes outside authorization locks, then atomically hand off to the owner. */
  async complete<T>(identity: CreativeWorkerIdentity, claim: CreativeExecutionClaim, artifacts: CreativeArtifact[],
    adopt: (tx: TenantTransaction, admission: Admission, stored: CreativeStoredArtifact[]) => Promise<T>) {
    if (artifacts.length > 100 || artifacts.reduce((n, a) => n + a.bytes.length, 0) > 50 * 1024 * 1024) throw new Error("CREATIVE_ARTIFACT_LIMIT");
    const manifest = artifacts.map((artifact, index) => {
      const extension = creativeMediaExtension[artifact.mediaType];
      if (!extension || !artifact.bytes.length) throw new Error("CREATIVE_ARTIFACT_INVALID");
      const checksumSha256 = hashPodResponse(artifact.bytes), fileName = `${claim.id}-pod-output-${index}.${extension}`;
      return { checksumSha256, fileName, objectKey: objectKey({ tenantId: identity.tenantId, domain: "authorized", sha256: checksumSha256, fileName }) };
    });
    const normalized = manifest.map(({ objectKey: key, checksumSha256 }) => ({ objectKey: key, checksumSha256 }));
    const authority = await this.authorized(identity, claim, async (tx, admission) => {
      if (admission.execution.phase !== "response_ready") throw new Error("CREATIVE_RESPONSE_CHECKPOINT_REQUIRED");
      if (admission.execution.artifactManifest && !isDeepStrictEqual(admission.execution.artifactManifest, normalized)) throw new Error("CREATIVE_ARTIFACT_CHANGED");
      if (!admission.execution.artifactManifest && normalized.length) await tx.update(executions).set({ artifactManifest: normalized, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, claim.id));
      return admission.authority;
    });
    for (const [index, artifact] of artifacts.entries()) {
      const item = manifest[index]!;
      if ((await this.scanner.scan({ body: artifact.bytes, fileName: item.fileName, mediaType: artifact.mediaType })).result !== "clean") throw new Error("CREATIVE_ARTIFACT_SCAN_FAILED");
      const stored = await this.storage.putPrivate(authority, { body: artifact.bytes, domain: "authorized", fileName: item.fileName, mediaType: artifact.mediaType });
      if (stored.objectKey !== item.objectKey || stored.checksumSha256 !== item.checksumSha256) throw new Error("CREATIVE_ARTIFACT_STORAGE_CHANGED");
      const bytes = await this.storage.readPrivate(authority, { id: claim.id, tenantId: identity.tenantId, assetDomain: "authorized", objectKey: item.objectKey }, { requiredDomain: "authorized", maxBytes: artifact.bytes.length });
      if (bytes.length !== artifact.bytes.length || hashPodResponse(bytes) !== item.checksumSha256) throw new Error("CREATIVE_ARTIFACT_STORAGE_CHANGED");
    }
    return this.authorized(identity, claim, async (tx, admission) => {
      const stored: CreativeStoredArtifact[] = [];
      for (const [index, artifact] of artifacts.entries()) {
        const item = manifest[index]!;
        const [existing] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(eq(assetFiles.objectKey, item.objectKey));
        if (existing) throw new Error("CREATIVE_ARTIFACT_ALREADY_OWNED");
        const [file] = await tx.insert(assetFiles).values({ id: createEntityId(), tenantId: identity.tenantId, ownerUserId: identity.userId,
          assetDomain: "authorized", objectKey: item.objectKey, checksumSha256: item.checksumSha256, byteSize: artifact.bytes.length,
          fileName: item.fileName, mediaType: artifact.mediaType, aiGenerated: artifact.aiGenerated,
          rightsStatus: artifact.rightsStatus, rightsMetadata: artifact.rightsMetadata }).returning();
        stored.push(file!);
      }
      const result = await adopt(tx, admission, stored);
      const completion = CreativeExecutionCompletionSchema.parse({ version: "creative-completion-v1", executionId: claim.id,
        inputFingerprint: admission.execution.inputFingerprint, responseChecksum: admission.execution.responseChecksum,
        artifacts: stored.map(file => ({ assetId: file.id, version: file.version, checksumSha256: file.checksumSha256 })),
        ownerResultChecksum: creativeExecutionChecksum(result) });
      const bundle = creativeHarness(admission.execution.kind, admission.execution.effect);
      bundle.registry.checkOutput(admission.execution.executionContract, bundle.skill, bundle.key, completion);
      await tx.update(executions).set({ phase: "completed", leaseToken: null, leaseExpiresAt: null,
        completionEvidence: completion, completionChecksum: creativeExecutionChecksum(completion), updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, claim.id));
      return result;
    });
  }

  async fail(identity: CreativeWorkerIdentity, operation: CreativeOperation, claim: CreativeExecutionClaim | undefined, code: string,
    permanent: boolean, onStop?: (tx: TenantTransaction, row: Execution, deferred: boolean) => Promise<void>) {
    const safeCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(code) ? code : "CREATIVE_LOCAL_PROCESSING_FAILED";
    return withTenant(this.database.db, internal(identity), async tx => {
      const [found] = await tx.select({ row: executions, active: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()` })
        .from(executions).where(creativeOwnerCondition(operation)).for("update");
      if (!found || found.row.requestedBy !== identity.userId || terminal(found.row)
        || (claim ? found.row.leaseToken !== claim.token : found.active)) return "lost" as const;
      const row = found.row;
      const [generation] = row.kind === "studio_generation" && row.submittedAt && !row.responseObjectKey
        ? await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, row.studioGenerationId!)).for("share") : [];
      const canPoll = generation?.modelSnapshot.capability === "video" && !!generation.providerTaskId && /^[a-zA-Z0-9_-]{1,160}$/.test(generation.providerTaskId);
      const uncertain = !!row.submittedAt && !row.responseObjectKey && !canPoll;
      const deferred = !permanent && !uncertain && row.attemptCount < 3;
      if (deferred) {
        await tx.update(executions).set({ phase: row.responseObjectKey ? row.phase : "pending", errorCode: safeCode,
          leaseToken: null, leaseExpiresAt: null, nextAttemptAt: sql`clock_timestamp()+interval '1 minute'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
        await this.stopped?.(tx, row, safeCode, true);
      }
      else await this.stop(tx, row, uncertain ? "CREATIVE_RESULT_UNCERTAIN" : safeCode);
      if (onStop) await onStop(tx, row, deferred);
      return deferred ? "deferred" as const : uncertain ? "uncertain" as const : "failed" as const;
    });
  }
  private async stop(tx: TenantTransaction, row: Execution, code: string) {
    await tx.update(executions).set({ phase: row.submittedAt && !row.responseObjectKey ? "uncertain" : "failed", errorCode: code,
      leaseToken: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id));
    if (!row.submittedAt) await tx.update(aiBudgetLedger).set({ state: "released" }).where(and(
      eq(aiBudgetLedger.requestId, row.kind === "studio_generation" ? row.studioGenerationId! : row.id), eq(aiBudgetLedger.state, "reserved")));
    await this.stopped?.(tx, row, code, false);
  }

  async purgeExpired(identity: CreativeWorkerIdentity, kinds?: Execution["kind"][]) {
    if (kinds?.length === 0) return 0;
    return withTenant(this.database.db, internal(identity), async tx => {
      const candidates = await tx.select().from(executions).where(and(kinds ? inArray(executions.kind, kinds) : undefined, sql`${executions.responseExpiresAt}<=clock_timestamp()`, isNull(executions.responsePurgedAt),
        sql`(${executions.leaseExpiresAt} IS NULL OR ${executions.leaseExpiresAt}<=clock_timestamp())`)).orderBy(asc(executions.responseExpiresAt)).limit(10).for("update", { skipLocked: true });
      let count = 0;
      for (const row of candidates) {
        if (!row.responseObjectKey) continue;
        if (!terminal(row)) await this.stop(tx, row, "CREATIVE_RESPONSE_EXPIRED");
        for (const artifact of row.artifactManifest ?? []) {
          const [adopted] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(eq(assetFiles.objectKey, artifact.objectKey)).limit(1);
          if (!adopted) await this.storage.discardPodExecutionArtifact(retention(identity), row.id, artifact.objectKey, "output");
        }
        await this.storage.discardPodExecutionArtifact(retention(identity), row.id, row.responseObjectKey, "response");
        await tx.update(executions).set({ responsePurgedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.id, row.id)); count++;
      }
      return count;
    });
  }
}

function isSameOperation(row: Execution, operation: CreativeOperation) {
  const owner = row.candidateId ?? row.creativeVersionId ?? row.inspectionId ?? row.mockupItemId ?? row.studioGenerationId;
  return row.kind === operation.kind && row.stepKey === operation.stepKey && owner === operation.ownerId;
}
