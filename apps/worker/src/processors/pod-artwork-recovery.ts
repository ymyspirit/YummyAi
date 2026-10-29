import { assessPaidRequestRecovery, createEnvironmentSecretVault, type SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { PodInvocationReceiptSchema, type PodInvocationReceipt } from "@yummyai/contracts/harness";
import { assetFiles, podArtworkExecutions as executions, podArtworkInvocations as invocations, podArtworkTaskInputs, podArtworkTasks as tasks, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { podExecutionFingerprint } from "@yummyai/pod-core";
import { objectKey, type Storage } from "@yummyai/storage";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { PodArtworkInputPolicyError, type PodArtworkClaim, type PodArtworkExecutionResult } from "./pod-artwork.processor.js";
import { hashPodResponse, POD_MAX_RESPONSE_BYTES, PodArtworkResponseCheckpointSchema, PodResponseInvalidError, type PodArtworkResponseCheckpoint } from "./pod-artwork-response.js";

type Base = Pick<TenantContext, "tenantId" | "userId">;
type Task = typeof tasks.$inferSelect;
type Execution = typeof executions.$inferSelect;
type Admission = (tx: TenantTransaction, base: Base, task: Task) => Promise<TenantContext>;
const terminal = (phase: Execution["phase"]) => ["completed", "failed", "uncertain"].includes(phase);
const internal = (base: Base): TenantContext => ({ ...base, permissions: [], dataScope: "tenant" });
const maintenance = (base: Base): TenantContext => ({ ...base, permissions: [Permission.AssetRead], dataScope: "tenant" });

/** Original-owner recovery. Redis never decides whether a paid request may be repeated. */
export class PodArtworkRecovery {
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly admit: Admission, private readonly contentVault?: SecretVault) {}

  private vault() { return this.contentVault ?? createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1"); }

  async claim(base: Base, taskId: string): Promise<PodArtworkClaim | undefined | "legacy"> {
    return withTenant(this.database.db, internal(base), async tx => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      if (!task || task.requestedBy !== base.userId) return undefined;
      const [execution] = await tx.select({ row: executions, activeLease: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()`, due: sql<boolean>`${executions.nextAttemptAt}<=clock_timestamp()`, expired: sql<boolean>`${executions.responseExpiresAt}<=clock_timestamp()` }).from(executions).where(eq(executions.taskId, taskId)).for("update");
      if (!execution) return "legacy";
      const row = execution.row;
      if (!['queued', 'running'].includes(task.status) || task.resultVersionId || terminal(row.phase) || execution.activeLease || !execution.due) return undefined;
      const [invocation] = await tx.select().from(invocations).where(and(eq(invocations.taskId, taskId), eq(invocations.attemptNumber, 1))).for("update");
      if (execution.expired || row.responsePurgedAt) {
        await this.stop(tx, task, row, "POD_RESPONSE_EXPIRED", false);
        return undefined;
      }
      const recovery = assessPaidRequestRecovery({ submissionState: invocation?.receivedAt ? "received" : invocation?.submittedAt ? "submitted" : "not_submitted", hasResponseReceipt: !!invocation?.receivedAt, hasResponseCheckpoint: row.responseObjectKey !== null });
      if (recovery.action === "reconcile") {
        await this.stop(tx, task, row, "POD_RESULT_UNCERTAIN", true);
        return undefined;
      }
      if (row.attemptCount >= 3) {
        await this.stop(tx, task, row, "POD_LOCAL_PROCESSING_FAILED", false);
        return undefined;
      }
      await this.admit(tx, base, task);
      await this.assertIdentity(tx, task, row);
      const token = createEntityId();
      await tx.update(executions).set({ phase: row.responseObjectKey ? row.phase : "preparing", attemptCount: row.attemptCount + 1, leaseToken: token, leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
      await tx.update(tasks).set({ status: "running", progressPercent: 1, attemptCount: 1, startedAt: task.startedAt ?? sql`clock_timestamp()`, completedAt: null, errorCode: null, errorMessage: null, updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, taskId));
      if (!invocation) await tx.insert(invocations).values({ id: createEntityId(), tenantId: base.tenantId, taskId, attemptNumber: 1, phase: "pending" });
      return { token, attempt: 0, hasResponse: row.responseObjectKey !== null };
    });
  }

  async assertIdentity(tx: TenantTransaction, task: Task, execution?: Execution) {
    const row = execution ?? (await tx.select().from(executions).where(eq(executions.taskId, task.id)))[0];
    if (!row) return;
    const pins = await tx.select().from(podArtworkTaskInputs).where(eq(podArtworkTaskInputs.taskId, task.id)).orderBy(asc(podArtworkTaskInputs.ordinal));
    const fingerprint = podExecutionFingerprint({ ...task, methodSnapshot: row.methodSnapshot, inputAssets: pins.map(pin => ({ id: pin.assetFileId, version: pin.assetVersion, checksumSha256: pin.checksumSha256, domain: pin.assetDomain, rightsStatus: pin.rightsStatus, rightsSourceKind: pin.rightsSourceKind ?? undefined })) });
    if (row.contractVersion !== "pod-execution-v1" || fingerprint !== row.inputFingerprint) throw new PodArtworkInputPolicyError("POD execution input no longer matches its immutable snapshot");
  }

  async owns(tx: TenantTransaction, base: Base, taskId: string, claim: PodArtworkClaim) {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
    const [row] = await tx.select({ execution: executions, active: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()` }).from(executions).where(eq(executions.taskId, taskId)).for("update");
    if (!task || task.requestedBy !== base.userId || task.status !== "running" || task.resultVersionId || !row || row.execution.leaseToken !== claim.token || !row.active || terminal(row.execution.phase)) throw new Error("POD_EXECUTION_CLAIM_LOST");
    return { task, execution: row.execution };
  }

  async markSubmitted(base: Base, taskId: string, claim: PodArtworkClaim) {
    // Fail before crossing the external boundary if encryption is unavailable.
    this.vault();
    await withTenant(this.database.db, internal(base), async tx => {
      const { task, execution } = await this.owns(tx, base, taskId, claim);
      await this.admit(tx, base, task);
      await this.assertIdentity(tx, task, execution);
      const changed = await tx.update(invocations).set({ phase: "submitted", submittedAt: sql`clock_timestamp()` }).where(and(eq(invocations.taskId, taskId), eq(invocations.attemptNumber, 1), eq(invocations.phase, "pending"))).returning({ id: invocations.id });
      if (!changed.length) throw new Error("POD_INVOCATION_SUBMISSION_ALREADY_RECORDED");
      await tx.update(executions).set({ leaseExpiresAt: sql`clock_timestamp()+interval '5 minutes'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
    });
  }

  async record(base: Base, taskId: string, attempt: number, rawReceipt: PodInvocationReceipt, checkpoint?: PodArtworkResponseCheckpoint, claim?: PodArtworkClaim) {
    const receipt = PodInvocationReceiptSchema.parse(rawReceipt);
    const prepared = checkpoint ? PodArtworkResponseCheckpointSchema.parse(checkpoint) : undefined;
    if (prepared && (!isDeepStrictEqual(prepared.receipt, receipt) || Buffer.byteLength(prepared.rawBody) > POD_MAX_RESPONSE_BYTES)) throw new PodResponseInvalidError();
    const staged = await withTenant(this.database.db, internal(base), async tx => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      const [execution] = await tx.select().from(executions).where(eq(executions.taskId, taskId)).for("update");
      if (execution) {
        if (!claim?.token) throw new Error("POD_EXECUTION_CLAIM_LOST");
        await this.owns(tx, base, taskId, claim);
      }
      const [row] = await tx.select().from(invocations).where(and(eq(invocations.taskId, taskId), eq(invocations.attemptNumber, attempt + 1))).for("update");
      if (!task || task.requestedBy !== base.userId || task.status !== "running" || task.attemptCount !== attempt + 1 || !row) throw new Error("POD_INVOCATION_CLAIM_LOST");
      if (row.receivedAt) {
        if (row.responseChecksum !== receipt.responseChecksum || row.reportedCostUsd !== receipt.costUsd || row.providerRequestId !== receipt.providerRequestId || row.modelKey !== receipt.modelKey || row.modelVersion !== receipt.modelVersion || row.metadataValid !== receipt.metadataValid || !isDeepStrictEqual(row.tokenUsage??null,receipt.tokenUsage??null)) throw new Error("POD_INVOCATION_RESPONSE_CHANGED");
      } else {
        if (row.phase !== "submitted") throw new Error("POD_INVOCATION_SUBMISSION_MISSING");
        await tx.update(invocations).set({ phase: "received", receivedAt: new Date(receipt.receivedAt), responseChecksum: receipt.responseChecksum, providerRequestId: receipt.providerRequestId, modelKey: receipt.modelKey, modelVersion: receipt.modelVersion, reportedCostUsd: receipt.costUsd, metadataValid: receipt.metadataValid,tokenUsage:receipt.tokenUsage??null }).where(eq(invocations.id, row.id));
      }
      if (!execution || !prepared || execution.responseObjectKey) return null;
      const body = Buffer.from(this.vault().encrypt(JSON.stringify({ version: 1, tenantId: base.tenantId, taskId, inputFingerprint: execution.inputFingerprint, checkpoint: prepared })));
      const encryptedChecksum = hashPodResponse(body), fileName = `${taskId}-pod-response.pe`;
      const key = objectKey({ tenantId: base.tenantId, domain: "quarantine", sha256: encryptedChecksum, fileName });
      // Record the exact object intent before upload. A lost upload acknowledgement
      // can be recovered by reading this key; a missing body never causes a new call.
      await tx.update(executions).set({ phase: "response_staging", responseObjectKey: key, encryptedChecksum, responseChecksum: receipt.responseChecksum, responseExpiresAt: sql`clock_timestamp()+interval '7 days'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
      return { body, fileName };
    });
    if (!staged) return;
    await this.storage.putPrivate(maintenance(base), { body: staged.body, domain: "quarantine", fileName: staged.fileName, mediaType: "application/octet-stream" });
    await withTenant(this.database.db, internal(base), async tx => {
      await this.owns(tx, base, taskId, claim!);
      await tx.update(executions).set({ phase: "response_ready", updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
    });
  }

  async read(base: Base, taskId: string, claim: PodArtworkClaim) {
    const loaded = await withTenant(this.database.db, internal(base), async tx => {
      const current = await this.owns(tx, base, taskId, claim);
      const context = await this.admit(tx, base, current.task);
      await this.assertIdentity(tx, current.task, current.execution);
      const [valid] = await tx.select({ usable: sql<boolean>`${executions.responseExpiresAt}>clock_timestamp() AND ${executions.responsePurgedAt} IS NULL` }).from(executions).where(eq(executions.taskId, taskId));
      if (!valid?.usable || !current.execution.responseObjectKey) throw new PodResponseInvalidError();
      return { context, row: current.execution };
    });
    const bytes = await this.storage.readPrivate(loaded.context, { id: taskId, tenantId: base.tenantId, assetDomain: "quarantine", objectKey: loaded.row.responseObjectKey! }, { requiredDomain: "quarantine", maxBytes: 2 * POD_MAX_RESPONSE_BYTES });
    if (hashPodResponse(bytes) !== loaded.row.encryptedChecksum) throw new PodResponseInvalidError();
    let value: unknown;
    try { value = this.vault().withSecret(Buffer.from(bytes).toString(), raw => JSON.parse(raw)); } catch { throw new PodResponseInvalidError(); }
    const saved = value as { version?: unknown; tenantId?: unknown; taskId?: unknown; inputFingerprint?: unknown; checkpoint?: unknown } | null;
    if (!saved || saved.version !== 1 || saved.tenantId !== base.tenantId || saved.taskId !== taskId || saved.inputFingerprint !== loaded.row.inputFingerprint) throw new PodResponseInvalidError();
    const parsed = PodArtworkResponseCheckpointSchema.safeParse(saved.checkpoint);
    if (!parsed.success || parsed.data.receipt.responseChecksum !== loaded.row.responseChecksum) throw new PodResponseInvalidError();
    await withTenant(this.database.db, internal(base), async tx => {
      await this.owns(tx, base, taskId, claim);
      await tx.update(executions).set({ phase: "response_ready", updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
    });
    return parsed.data;
  }

  outputManifest(base: Base, taskId: string, result: PodArtworkExecutionResult) {
    const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff", "image/svg+xml": "svg", "video/mp4": "mp4", "application/zip": "zip", "application/postscript": "ps", "text/plain": "txt" };
    return result.outputs.map((output, index) => {
      const checksumSha256 = hashPodResponse(output.bytes), fileName = `${taskId}-pod-output-${index}.${extensions[output.mediaType]}`;
      return { checksumSha256, objectKey: objectKey({ tenantId: base.tenantId, domain: "authorized", sha256: checksumSha256, fileName }), fileName };
    });
  }

  async stageArtifacts(base: Base, taskId: string, claim: PodArtworkClaim, manifest: Array<{ objectKey: string; checksumSha256: string }>) {
    await withTenant(this.database.db, internal(base), async tx => {
      const { task, execution } = await this.owns(tx, base, taskId, claim);
      await this.admit(tx, base, task);
      if (execution.phase !== "response_ready") throw new Error("POD_RESPONSE_CHECKPOINT_REQUIRED");
      const normalized = manifest.map(({ objectKey: key, checksumSha256 }) => ({ objectKey: key, checksumSha256 }));
      if (execution.artifactManifest && !isDeepStrictEqual(execution.artifactManifest, normalized)) throw new PodResponseInvalidError();
      if (!execution.artifactManifest) await tx.update(executions).set({ artifactManifest: normalized, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
    });
  }

  async fail(base: Base, taskId: string, input: { attempt: number; terminal: boolean; code: string; message: string }, claim?: PodArtworkClaim): Promise<"legacy" | "deferred" | "lost" | "uncertain" | "failed"> {
    return withTenant(this.database.db, internal(base), async tx => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for("update");
      const [current] = await tx.select({ row: executions, active: sql<boolean>`${executions.leaseExpiresAt}>clock_timestamp()` }).from(executions).where(eq(executions.taskId, taskId)).for("update");
      if (!current) return "legacy";
      const row = current.row;
      if (!task || task.requestedBy !== base.userId || !['queued','running'].includes(task.status) || task.resultVersionId || terminal(row.phase) || (claim?.token ? row.leaseToken !== claim.token || !current.active : current.active)) return "lost";
      const [invocation] = await tx.select().from(invocations).where(and(eq(invocations.taskId, taskId), eq(invocations.attemptNumber, 1)));
      const blocked = input.code === "INPUT_POLICY_BLOCKED", invalid = input.code === "POD_RESPONSE_INVALID" || (input.terminal && input.code !== "POD_RESULT_UNCERTAIN" && input.code !== "POD_TOOL_FAILED" && input.code !== "POD_WORKFLOW_PAUSED");
      const uncertain = !!invocation?.submittedAt && !row.responseObjectKey;
      if (!blocked && !invalid && !uncertain && row.attemptCount < 3) {
        await tx.update(executions).set({ phase: row.responseObjectKey ? row.phase : "pending", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: sql`clock_timestamp()+interval '1 minute'`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, taskId));
        await tx.update(tasks).set({ status: row.responseObjectKey ? "running" : "queued", errorCode: row.responseObjectKey ? "POD_RESPONSE_RECOVERY_PENDING" : "POD_PREPARATION_PENDING", errorMessage: "POD local processing will resume from the original task", updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, taskId));
        return "deferred";
      }
      await this.stop(tx, task, row, blocked ? input.code : uncertain ? "POD_RESULT_UNCERTAIN" : invalid ? input.code : "POD_LOCAL_PROCESSING_FAILED", uncertain && !blocked, blocked);
      return uncertain && !blocked ? "uncertain" : "failed";
    });
  }

  private async stop(tx: TenantTransaction, task: Task, row: Execution, code: string, uncertain: boolean, blocked = false) {
    await tx.update(executions).set({ phase: uncertain ? "uncertain" : "failed", leaseToken: null, leaseExpiresAt: null, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, task.id));
    await tx.update(tasks).set({ status: blocked ? "blocked" : "failed", errorCode: code, errorMessage: uncertain ? "The original POD request requires reconciliation before another request" : blocked ? "Current POD authorization or input evidence is unavailable" : "The original POD response requires operator attention", completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(tasks.id, task.id));
    await tx.update(invocations).set({ phase: uncertain ? "uncertain" : "failed", finishedAt: sql`clock_timestamp()` }).where(and(eq(invocations.taskId, task.id), eq(invocations.attemptNumber, 1), inArray(invocations.phase, ["pending", "submitted", "received"])));
  }

  async purgeExpired(context: TenantContext) {
    return withTenant(this.database.db, context, async tx => {
      const candidates = await tx.select({ taskId: executions.taskId }).from(executions).where(and(sql`${executions.responseExpiresAt}<=clock_timestamp()`, sql`${executions.responsePurgedAt} IS NULL`, sql`(${executions.leaseExpiresAt} IS NULL OR ${executions.leaseExpiresAt}<=clock_timestamp())`)).orderBy(asc(executions.responseExpiresAt)).limit(10);
      let purged = 0;
      for (const candidate of candidates) {
        // Same task -> execution lock order as claims and completion.
        const [task] = await tx.select().from(tasks).where(eq(tasks.id, candidate.taskId)).for("update", { skipLocked: true });
        if (!task) continue;
        const [row] = await tx.select().from(executions).where(and(eq(executions.taskId, candidate.taskId), sql`${executions.responseExpiresAt}<=clock_timestamp()`, sql`${executions.responsePurgedAt} IS NULL`, sql`(${executions.leaseExpiresAt} IS NULL OR ${executions.leaseExpiresAt}<=clock_timestamp())`)).for("update", { skipLocked: true });
        if (!row) continue;
        if (!task || !row.responseObjectKey) continue;
        if (!terminal(row.phase)) await this.stop(tx, task, row, "POD_RESPONSE_EXPIRED", false);
        for (const artifact of row.artifactManifest ?? []) {
          const [committed] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(eq(assetFiles.objectKey, artifact.objectKey)).limit(1);
          if (!committed) await this.storage.discardPodExecutionArtifact(maintenance(context), row.taskId, artifact.objectKey, "output");
        }
        await this.storage.discardPodExecutionArtifact(maintenance(context), row.taskId, row.responseObjectKey, "response");
        await tx.update(executions).set({ responsePurgedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, row.taskId));
        purged++;
      }
      return purged;
    });
  }
}
