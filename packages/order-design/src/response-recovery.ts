import type { SecretVault } from "@yummyai/ai-core";
import { authorize } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderDesignRestoreResponseSchema, ORDER_DESIGN_RECOVERY_MAX_BYTES, type OrderDesignRestoreResponse } from "@yummyai/contracts/order/design-agent";
import { DesignAutomationStepSchema } from "@yummyai/contracts/pod/design-automation";
import { orderDesignAgentRuns as runs, orderDesignAgentSteps as steps, orderDesignAgentCommands as commands,
  orderDesignAgentOutbox as outbox, productionEditorProjects as projects, aiBudgetLedger, withTenant,
  type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { objectKey as privateObjectKey, type Storage } from "@yummyai/storage";
import { and, eq, inArray } from "drizzle-orm";
import sharp from "sharp";
import { fingerprint, open, seal } from "./crypto.js";
import { assertExecutionIdentity, assertRunSource, executionPermissions, lockWork, paidTool, type DesignRun, type DesignStep } from "./repository.js";
import { OrderDesignError, type OrderDesignSnapshot, type OrderDesignStepCheckpoint } from "./types.js";

/** Only the missing response can be restored. Completed work and the pinned
 * recipe remain untouched; an operator's evidence is not provider billing. */
export async function responseRecoveryTarget(tx: TenantTransaction, context: TenantContext, run: DesignRun, rows: DesignStep[], key: Uint8Array) {
  if (context.dataScope !== "tenant" || executionPermissions.some(permission => !context.permissions.includes(permission)))
    throw new OrderDesignError("agent_membership_unavailable");
  const uncertain = rows.filter(step => step.status === "uncertain");
  if (run.status !== "needs_attention" || uncertain.length !== 1) throw new OrderDesignError("agent_response_recovery_not_safe");
  const step = uncertain[0]!;
  const firstIncomplete = rows.find(row => row.status !== "completed" && row.status !== "skipped");
  if (firstIncomplete?.id !== step.id || !["agent_model_submission_unknown", "agent_model_response_uncheckpointed"].includes(step.errorCode ?? ""))
    throw new OrderDesignError("agent_response_recovery_not_safe");
  await assertRunSource(tx, run);
  await assertExecutionIdentity(tx, context);
  if (context.userId !== run.requestedBy) await assertExecutionIdentity(tx, { ...context, userId: run.requestedBy });
  const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId!));
  if (!project?.encryptedDataKey || project.status !== "active" || project.sourceWorkItemId !== run.workItemId || project.currentVersionId !== run.currentEditorVersionId)
    throw new OrderDesignError("agent_editor_changed");
  const snapshot = open<OrderDesignSnapshot>(key, run.encryptedSnapshot);
  if (orderDesignInputChecksum(snapshot,run.methodSnapshot) !== run.inputChecksum || !snapshot.model || snapshot.plan.status !== "ready") throw new OrderDesignError("agent_snapshot_invalid");
  const input = DesignAutomationStepSchema.parse(open(key, step.encryptedInput));
  if (fingerprint(input) !== step.inputChecksum || !paidTool(input.tool)
    || input.dependsOn.some(id => !rows.some(row => row.key === id && row.status === "completed")))
    throw new OrderDesignError("agent_step_dependency_invalid");
  const [budget] = await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.requestId, step.requestId),
    eq(aiBudgetLedger.taskType, "order_design"), inArray(aiBudgetLedger.state, ["reserved", "committed"])));
  if (!budget || budget.modelKey !== snapshot.model.model || budget.provider !== snapshot.model.providerConfigId)
    throw new OrderDesignError("agent_response_recovery_not_safe");
  const checkpoint = step.encryptedOutput ? open<OrderDesignStepCheckpoint>(key, step.encryptedOutput) : {};
  if (checkpoint.responseCheckpoint || checkpoint.responseRecovery) throw new OrderDesignError("agent_response_recovery_not_safe");
  if (input.tool !== "enhance_image" && input.tool !== "cutout_subject") throw new OrderDesignError("agent_response_recovery_not_safe");
  const sourceAssetId = input.tool === "cutout_subject" && input.enhancedStepId
    ? rows.find(row => row.key === input.enhancedStepId && row.status === "completed")?.outputAssetId
    : input.sourceImageId;
  if (!sourceAssetId) throw new OrderDesignError("agent_step_dependency_invalid");
  return { step, checkpoint, project, target: { stepId: step.id, requestId: step.requestId, stepLabel: step.label,
    model: snapshot.model.model, sourceAssetId, knownResponseChecksum: checkpoint.responseReceipt?.checksum ?? null } };
}

export class OrderDesignResponseRecovery {
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault, private readonly storage: Storage) {}

  async restore(context: TenantContext, workItemId: string, raw: unknown) {
    for (const permission of executionPermissions) authorize(context, permission);
    const input = OrderDesignRestoreResponseSchema.parse(raw);
    const bytes = Buffer.from(input.contentBase64, "base64");
    let objectKey: string | undefined;
    let committed = false;
    let encryptedWorkKey: string | undefined;
    try {
      if (!bytes.length || bytes.length > ORDER_DESIGN_RECOVERY_MAX_BYTES || bytes.toString("base64") !== input.contentBase64)
        throw new OrderDesignError("agent_asset_size_invalid");
      const checksum = fingerprint(bytes);
      const digest = fingerprint({ action: "restore_response", ...input, contentBase64: undefined, checksum });
      // Authorize before decoding or storage access; revalidate under the same
      // work/run locks after I/O to catch takeover, expiry, and editor changes.
      const prepared = await withTenant(this.database.db, context, tx => this.prepare(tx, context, workItemId, input, digest, checksum, bytes.length));
      if (!prepared) return;
      encryptedWorkKey = prepared.work.encryptedDataKey!;
      const metadata = await sharp(bytes, { limitInputPixels: 100_000_000, failOn: "warning" }).metadata()
        .catch(() => { throw new OrderDesignError("agent_asset_invalid"); });
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1)
        throw new OrderDesignError("agent_asset_invalid");
      const projectKey = this.vault.withSecret(prepared.project.encryptedDataKey!, value => Buffer.from(value, "base64"));
      try {
        const encryptedBytes = encryptProductionBytes(projectKey, bytes), fileName = `${input.requestId}-response-quarantine.pe`;
        // Know the exact owned key even if S3 writes successfully but loses its
        // acknowledgement, so failed uploads can also be discarded safely.
        objectKey = privateObjectKey({ tenantId: context.tenantId, domain: "order", sha256: fingerprint(encryptedBytes), fileName });
        const stored = await this.storage.putPrivate(context, { body: encryptedBytes, domain: "order", fileName, mediaType: "application/octet-stream" })
          .catch(() => { throw new OrderDesignError("agent_asset_storage_unavailable"); });
        if (stored.objectKey !== objectKey) throw new OrderDesignError("agent_asset_storage_unavailable");
      } finally { projectKey.fill(0); }
      committed = await withTenant(this.database.db, context, async tx => {
        const current = await this.prepare(tx, context, workItemId, input, digest, checksum, bytes.length);
        if (!current) return false;
        const evidence = { kind: "operator_verified_provider_result" as const, providerReference: input.providerReference,
          verificationNote: input.verificationNote, verifiedBy: context.userId, verifiedAt: new Date().toISOString(), checksum,
          previousErrorCode: current.step.errorCode };
        const receipt = current.checkpoint.responseReceipt ?? { version: 1 as const, requestId: input.requestId, checksum,
          byteSize: bytes.length, receivedAt: evidence.verifiedAt, quarantined: true as const };
        const output: OrderDesignStepCheckpoint = { ...current.checkpoint, submissionState: "received", responseReceipt: receipt,
          responseCheckpoint: { ...receipt, objectKey: objectKey! }, responseProcessingAttempts: 0, responseRecovery: evidence };
        const workKey = this.vault.withSecret(current.work.encryptedDataKey!, value => Buffer.from(value, "base64"));
        try {
          await tx.update(steps).set({ status: "pending", errorCode: null, encryptedOutput: seal(workKey, output), updatedAt: new Date() }).where(eq(steps.id, input.stepId));
        } finally { workKey.fill(0); }
        await tx.update(runs).set({ status: "queued", revision: current.run.revision + 1, errorCode: null,
          processingToken: null, leaseUntil: null, updatedAt: new Date() }).where(eq(runs.id, input.runId));
        await tx.insert(commands).values({ id: createEntityId(), tenantId: context.tenantId, runId: input.runId,
          idempotencyKey: input.idempotencyKey, action: "restore_response", requestChecksum: digest, requestedBy: context.userId });
        await tx.insert(outbox).values({ id: createEntityId(), tenantId: context.tenantId, runId: input.runId, requestedBy: current.run.requestedBy });
        return true;
      });
    } finally {
      bytes.fill(0);
      if (objectKey && !committed) {
        // A lost commit acknowledgement must not delete a live checkpoint. If
        // the database cannot settle this question, retain the private blob.
        const referenced = await this.isReferenced(context, input.stepId, encryptedWorkKey!, objectKey)
          .catch(() => { throw new OrderDesignError("agent_response_cleanup_pending"); });
        if (!referenced) await this.storage.discardOrderDesignResponse(context, input.requestId, objectKey)
          .catch(() => { throw new OrderDesignError("agent_response_cleanup_pending"); });
      }
    }
  }

  private async isReferenced(context: TenantContext, stepId: string, encryptedWorkKey: string, objectKey: string) {
    return withTenant(this.database.db, context, async tx => {
      const [step] = await tx.select({ output: steps.encryptedOutput }).from(steps).where(eq(steps.id, stepId));
      if (!step?.output) return false;
      const key = this.vault.withSecret(encryptedWorkKey, value => Buffer.from(value, "base64"));
      try { return open<OrderDesignStepCheckpoint>(key, step.output).responseCheckpoint?.objectKey === objectKey; }
      finally { key.fill(0); }
    });
  }

  private async prepare(tx: TenantTransaction, context: TenantContext, workItemId: string, input: OrderDesignRestoreResponse, digest: string, checksum: string, byteSize: number) {
    await lockWork(tx, workItemId);
    const [run] = await tx.select().from(runs).where(and(eq(runs.id, input.runId), eq(runs.workItemId, workItemId))).for("update");
    if (!run) throw new OrderDesignError("agent_run_not_found");
    const [prior] = await tx.select().from(commands).where(and(eq(commands.runId, run.id), eq(commands.idempotencyKey, input.idempotencyKey)));
    if (prior) {
      if (prior.requestChecksum !== digest) throw new OrderDesignError("agent_command_conflict");
      return null;
    }
    if (run.revision !== input.expectedRevision) throw new OrderDesignError("agent_revision_changed");
    const work = await assertRunSource(tx, run);
    const key = this.vault.withSecret(work.encryptedDataKey!, value => Buffer.from(value, "base64"));
    try {
      const rows = await tx.select().from(steps).where(eq(steps.runId, run.id)).orderBy(steps.position);
      const prepared = await responseRecoveryTarget(tx, context, run, rows, key);
      if (prepared.step.id !== input.stepId || prepared.step.requestId !== input.requestId) throw new OrderDesignError("agent_response_identity_mismatch");
      if (prepared.checkpoint.responseReceipt && (prepared.checkpoint.responseReceipt.checksum !== checksum
        || prepared.checkpoint.responseReceipt.requestId !== input.requestId || prepared.checkpoint.responseReceipt.byteSize !== byteSize))
        throw new OrderDesignError("agent_response_checksum_mismatch");
      return { ...prepared, run, work };
    } finally { key.fill(0); }
  }
}
import { orderDesignInputChecksum } from "./harness.js";
