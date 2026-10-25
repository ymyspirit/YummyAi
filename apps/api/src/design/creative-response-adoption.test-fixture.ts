import { createHash, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { CreateCreativeDesignBatchInputSchema, createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import type { CreativeResponse, PodArtworkResponseCheckpoint } from "@yummyai/contracts/harness/creative-response";
import { aiBudgetLedger, assetFiles, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates,
  creativeDesignVersions, creativeExecutions, creativeResponseAdoptions, memberships, membershipRoles, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { objectKey, type Storage } from "@yummyai/storage";
import { requireCreativeResponseAdoptionEnvironment } from "../../../../tools/testing/creative-response-adoption-environment.mjs";
import { CreativeExecutionRecovery } from "../../../worker/src/processors/creative-execution-recovery.js";
import { creativeOwnerRunning, creativeOwnerStopped } from "../../../worker/src/processors/creative-execution-owner-state.js";
import { podInvocationReceipt } from "../../../worker/src/processors/pod-invocation-receipt.js";
import { AuditService } from "../audit/audit.service.js";
import { CreativeResponseAdoptionService } from "./creative-response-adoption.service.js";
import { createCreativeStudioPersonalFixture } from "./creative-studio-personal.test-fixture.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";

export const adoptionFixtureSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type AdoptionSeed = {
  executionId: string; candidateId: string; itemId: string; batchId: string; specId: string;
  phase: "failed" | "uncertain"; image: Buffer; response: CreativeResponse; checkpoint: PodArtworkResponseCheckpoint;
};
type ActorIdentity = Pick<TenantContext, "tenantId" | "userId">;
type Scope = "self" | "team" | "tenant";
type Stage = "read" | "put";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function strictContext(value: TenantContext): TenantContext {
  return TenantContextSchema.strict().parse({ tenantId: value.tenantId, userId: value.userId,
    permissions: value.permissions, dataScope: value.dataScope,
    ...(value.permissionScopes ? { permissionScopes: value.permissionScopes } : {}),
    ...(value.teamId ? { teamId: value.teamId } : {}), ...(value.teamIds ? { teamIds: value.teamIds } : {}),
    ...(value.teamAuthority ? { teamAuthority: value.teamAuthority } : {}) });
}

/** Synthetic originals are created by the actual batch producer, budget owner and
 * response recovery owner. No processor, provider client or queue consumer runs.
 * Adoption itself always calls the real service and its default ClamAV scanner. */
export async function createCreativeResponseAdoptionFixture(environment = process.env,
  options: { database?: DatabaseConnection; context?: TenantContext; vault?: SecretVault } = {}) {
  const isolated = requireCreativeResponseAdoptionEnvironment(environment);
  const base = await createCreativeStudioPersonalFixture(options);
  try {
  const { database, storage } = base;
  const vault = options.vault ?? new SecretVault(Buffer.alloc(32, 71));
  const defaultActor = options.context ? null : await base.actor();
  const originalIdentity: ActorIdentity = options.context ?? defaultActor!;
  const identity: ActorIdentity = { tenantId: originalIdentity.tenantId, userId: originalIdentity.userId };
  const initial = strictContext(await base.current(identity));
  const roleSnapshots = await withTenant(database.db, initial, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
    .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
    .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
    .where(and(eq(memberships.userId, identity.userId), eq(memberships.tenantId, identity.tenantId))));
  if (!roleSnapshots.length) { await base.close(); throw new Error("adoption_fixture_original_roles_missing"); }
  const batches = new Map<string, string | null>();
  const entered = new Set<() => void>(), hooks: Partial<Record<Stage, () => Promise<void>>> = {};
  const counts = { originalDispatches: 0, forbiddenDispatches: 0, adoptionReads: 0, adoptionWrites: 0 };
  const pendingCandidateIds: string[] = [];
  const queue = {
    async enqueueCreativeCandidate(input: { candidateId: string }) { counts.originalDispatches++; pendingCandidateIds.push(input.candidateId); },
    async enqueueCreativeAdaptation() { counts.forbiddenDispatches++; throw new Error("adoption_fixture_adaptation_forbidden"); },
    async enqueueTemplateCompile() { counts.forbiddenDispatches++; throw new Error("adoption_fixture_compile_forbidden"); },
    async enqueueMockupRender() { counts.forbiddenDispatches++; throw new Error("adoption_fixture_render_forbidden"); },
  };
  const pod = new PodBatchWorkflowService(database, queue, new AuditService(database), new DesignService(new DrizzleDesignRepository(database, storage)));
  const recovery = new CreativeExecutionRecovery(database, storage, vault, creativeOwnerStopped);
  const observedStorage = new Proxy(storage, { get(target, key) {
    if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => {
      const bytes = await target.readPrivate(...args); counts.adoptionReads++; await hooks.read?.(); return bytes;
    };
    if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
      const stored = await target.putPrivate(...args); counts.adoptionWrites++; await hooks.put?.(); return stored;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const service = (store: Storage = observedStorage) => new CreativeResponseAdoptionService(database, store, { vault });
  const adoption = service();
  let closed = false;
  async function current(actor: ActorIdentity = identity) {
    return strictContext(await base.current({ tenantId: actor.tenantId, userId: actor.userId }));
  }
  async function grant(next: readonly string[], scope: Scope = "self") {
    await withTenant(database.db, initial, async tx => {
      for (const row of roleSnapshots) await tx.update(roles).set({ permissions: [...next], dataScope: scope })
        .where(and(eq(roles.tenantId, identity.tenantId), eq(roles.id, row.id)));
    });
    return current();
  }
  async function restorePermissions() {
    await withTenant(database.db, initial, async tx => {
      for (const row of roleSnapshots) await tx.update(roles).set({ permissions: row.permissions, dataScope: row.dataScope })
        .where(and(eq(roles.tenantId, identity.tenantId), eq(roles.id, row.id)));
    });
  }
  async function seed(input: { phase?: "failed" | "uncertain"; costUsd?: number | null; referenceAssetIds?: string[];
    archive?: "missing" | "wrong-execution" | "wrong-receipt" | "expired" | "purged" } = {}): Promise<AdoptionSeed> {
    const context = await current(), phase = input.phase ?? "failed";
    const spec = await pod.createPrintSpec(context, { name: "Synthetic adoption spec " + createEntityId(), aspectWidth: 1, aspectHeight: 1,
      targetDpi: 300, bleedMm: 0, safeZoneMm: 0, wrapMode: "none", physicalSizes: [{ key: "square", label: "Synthetic", widthMm: 300, heightMm: 300 }] });
    await pod.reviewPrintSpec(context, spec.id, { decision: "approve" });
    const created = await pod.createDesignBatch(context, CreateCreativeDesignBatchInputSchema.parse({ name: "Synthetic original response " + createEntityId(),
      items: [{ rowKey: "original", name: "Synthetic original candidate", prompt: "Synthetic original response No provider is contacted",
        referenceAssetIds: input.referenceAssetIds ?? [], candidateCount: 1, printSpecVersionIds: [spec.id] }] }));
    batches.set(created.id, null);
    const candidateId = pendingCandidateIds.at(-1);
    if (!candidateId) throw new Error("adoption_fixture_original_dispatch_missing");
    const original = await withTenant(database.db, context, async tx => {
      const [row] = await tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems, execution: creativeExecutions })
        .from(creativeDesignCandidates).innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
        .innerJoin(creativeExecutions, eq(creativeExecutions.candidateId, creativeDesignCandidates.id))
        .where(eq(creativeDesignCandidates.id, candidateId));
      if (!row) throw new Error("adoption_fixture_original_owner_missing"); return row;
    });
    batches.set(original.item.batchId, original.execution.id);
    const operation = { kind: "creative_candidate" as const, ownerId: candidateId, stepKey: "generate" };
    const claim = await recovery.claim(identity, operation, (tx, admitted) => creativeOwnerRunning(tx, admitted.execution));
    if (!claim) throw new Error("adoption_fixture_original_claim_missing");
    await recovery.markSubmitted(identity, claim, { taskType: "pod_text_to_image", modelKey: "synthetic-original-model", provider: "synthetic-local-processor", ceilingUsd: "0.100000" });
    const image = await base.image();
    const rawBody = JSON.stringify({ outputs: [{ dataBase64: image.toString("base64"), mediaType: "image/png", role: "effect",
      fileName: "synthetic-original.png", metadata: { width: 240, height: 160, unit: "px", colorMode: "rgb", transparent: true, aiInference: "full" } }],
      modelKey: "synthetic-original-model", modelVersion: "synthetic-original-v1", qualityCheckSnapshot: { synthetic: true }, partial: false });
    const receipt = podInvocationReceipt({ modelKey: "synthetic-original-model", modelVersion: "synthetic-original-v1",
      ...(input.costUsd === null ? {} : { costUsd: input.costUsd ?? 0.01234567 }) }, adoptionFixtureSha(rawBody), "synthetic-request-" + original.execution.id);
    const checkpoint: PodArtworkResponseCheckpoint = { version: "pod-response-checkpoint-v1", kind: "http", rawBody, status: 200,
      deploymentId: process.env.POD_PROCESSOR_DEPLOYMENT_ID!, maxOutputBytes: 50 * 1024 * 1024, receipt };
    const response: CreativeResponse = { version: "creative-response-v1", kind: "pod", checkpoint };
    if (phase === "uncertain") await recovery.fail(identity, operation, claim, "CREATIVE_RESULT_UNCERTAIN", true);
    if (input.archive === "missing") {
      // The real owner commits an archive intent before putPrivate. Fail before
      // upload, leaving an actually absent object in this nonce bucket.
      const missing = new Proxy(storage, { get(target, key) {
        if (key === "putPrivate") return async () => { throw new Error("synthetic_original_archive_not_uploaded"); };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      try { await new CreativeExecutionRecovery(database, missing, vault, creativeOwnerStopped).record(identity, claim, response, receipt); }
      catch (error) { if (!(error instanceof Error) || error.message !== "synthetic_original_archive_not_uploaded") throw error; }
    } else if (input.archive) {
      // Negative fixtures model an original first archive assignment. They never
      // rewrite an already immutable original checkpoint to manufacture a pass.
      await recovery.record(identity, claim, undefined, receipt);
      const savedResponse = input.archive === "wrong-receipt" ? { ...response, checkpoint: { ...checkpoint, rawBody: checkpoint.rawBody + " " } } : response;
      const encrypted = Buffer.from(vault.encrypt(JSON.stringify({ version: 1, tenantId: identity.tenantId,
        executionId: input.archive === "wrong-execution" ? createEntityId() : original.execution.id,
        inputFingerprint: original.execution.inputFingerprint, response: savedResponse })));
      const fileName = original.execution.id + "-pod-response.pe";
      const saved = await storage.putPrivate(context, { body: encrypted, domain: "quarantine", fileName, mediaType: "application/octet-stream" });
      if (saved.objectKey !== objectKey({ tenantId: identity.tenantId, domain: "quarantine", sha256: adoptionFixtureSha(encrypted), fileName }))
        throw new Error("adoption_fixture_negative_archive_address_changed");
      await withTenant(database.db, context, tx => tx.update(creativeExecutions).set({ responseObjectKey: saved.objectKey,
        encryptedChecksum: adoptionFixtureSha(encrypted), responseChecksum: receipt.responseChecksum,
        responseExpiresAt: input.archive === "expired" || input.archive === "purged" ? sql`clock_timestamp()-interval '1 second'` : sql`clock_timestamp()+interval '7 days'` })
        .where(eq(creativeExecutions.id, original.execution.id)));
    } else await recovery.record(identity, claim, response, receipt);
    if (phase === "failed") await recovery.fail(identity, operation, claim, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
    if (input.archive === "purged") await recovery.purgeExpired(identity, ["creative_candidate"]);
    const result = { executionId: original.execution.id, candidateId, itemId: original.item.id, batchId: original.item.batchId,
      specId: spec.id, phase, image, response, checkpoint };
    return result;
  }
  async function facts(seedValue: AdoptionSeed) {
    return withTenant(database.db, await current(), async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      const [execution] = await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, seedValue.executionId));
      const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, seedValue.batchId));
      const [item] = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.id, seedValue.itemId));
      const candidates = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.itemId, seedValue.itemId)).orderBy(asc(creativeDesignCandidates.id));
      const versions = await tx.select().from(creativeDesignVersions).where(inArray(creativeDesignVersions.sourceCandidateId, candidates.map(row => row.id))).orderBy(asc(creativeDesignVersions.id));
      const budget = await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId, seedValue.executionId)).orderBy(asc(aiBudgetLedger.id));
      const adoptions = await tx.select().from(creativeResponseAdoptions).where(eq(creativeResponseAdoptions.executionId, seedValue.executionId)).orderBy(asc(creativeResponseAdoptions.id));
      const assets = await tx.select().from(assetFiles).where(eq(assetFiles.ownerUserId, identity.userId)).orderBy(asc(assetFiles.id));
      return { role: role?.role, execution, batch, item, candidates, versions, budget, adoptions, assets, counts: { ...counts } };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function archive(seedValue: AdoptionSeed) {
    const value = await facts(seedValue), execution = value.execution;
    if (!execution?.responseObjectKey) throw new Error("adoption_fixture_archive_missing");
    const bytes = await storage.readPrivate(await current(), { id: execution.id, tenantId: identity.tenantId, assetDomain: "quarantine", objectKey: execution.responseObjectKey },
      { requiredDomain: "quarantine", maxBytes: 150 * 1024 * 1024 });
    return { bytes, sha256: adoptionFixtureSha(bytes), key: execution.responseObjectKey };
  }
  async function reference() {
    const context = await current(), body = await base.image(1), id = createEntityId(), fileName = "synthetic-adoption-reference-" + id + ".png";
    const saved = await storage.putPrivate(context, { body, domain: "authorized", fileName, mediaType: "image/png" });
    const [asset] = await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id, tenantId: identity.tenantId, ownerUserId: identity.userId,
      assetDomain: "authorized", objectKey: saved.objectKey, checksumSha256: saved.checksumSha256, byteSize: body.length,
      fileName, mediaType: "image/png", rightsStatus: "approved",
      rightsMetadata: { source: { kind: "owned", reference: "Synthetic isolated adoption reference" } } }).returning());
    return asset!;
  }
  function hold(stage: Stage, once = true) {
    const began = deferred(), released = deferred(); let used = false;
    const release = () => { released.resolve(); entered.delete(release); };
    entered.add(release);
    hooks[stage] = async () => { if (once && used) return; used = true; began.resolve(); await released.promise; };
    return { entered: began.promise, release, clear() { release(); delete hooks[stage]; } };
  }
  async function close() {
    if (closed) return; closed = true;
    for (const release of entered) release(); delete hooks.read; delete hooks.put;
    const failures: unknown[] = [];
    try {
      await restorePermissions();
      for (const [batchId, executionId] of batches) {
        try {
        const context = await current();
        if (executionId) {
          const workspace = await adoption.workspace(context, executionId);
          for (const request of workspace.requests) {
            if (request.status === "committed" || request.status === "cancelled") continue;
            if (!request.canCancel) throw new Error("adoption_fixture_active_processing_retained");
            const cancelled = await adoption.cancel(context, executionId, request.id, { requestId: request.requestId });
            if (cancelled.status !== "cancelled" || !["complete", "not_required"].includes(cancelled.artifactCleanup))
              throw new Error("adoption_fixture_private_artifact_cleanup_incomplete");
          }
        }
        const snapshot = () => withTenant(database.db, context, async tx => {
          const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId));
          const execution = executionId ? (await tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, executionId)))[0] : null;
          return { batch, execution };
        });
        const before = await snapshot();
        if (before.batch && !["completed", "cancelled"].includes(before.batch.status)) await pod.cancelDesignBatch(context, batchId);
        if (before.batch) await pod.archiveDesignBatch(context, batchId, { archived: true, reason: "Synthetic isolated original-response adoption fixture completed" });
        const after = await snapshot();
        if (!after.batch?.archivedAt || (before.execution && adoptionFixtureSha(JSON.stringify(after.execution)) !== adoptionFixtureSha(JSON.stringify(before.execution))))
          throw new Error("adoption_fixture_owner_cleanup_verification_failed");
        } catch (error) { failures.push(error); }
      }
    } catch (error) { failures.push(error); }
    finally { try { await base.close(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "adoption_fixture_cleanup_failed");
  }
  return { isolated, base, database, storage, vault, pod, recovery, adoption, service, identity, initial, current, grant, restorePermissions,
    seed, facts, archive, reference, hold, counts, close, randomRequestId: randomUUID,
    retainedHistory: "Original terminal executions, costs, archives and immutable adoption history remain in the nonce DB/bucket until the outer runner deletes and independently verifies both." };
  } catch (primary) {
    try { await base.close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "adoption_fixture_setup_and_cleanup_failed"); }
    throw primary;
  }
}
