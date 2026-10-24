import { readFile } from "node:fs/promises";
import { Permission } from "@yummyai/authz";
import { CreateCreativeDesignBatchInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles, connectDatabase, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates,
  creativeExecutions, creativeExecutionChecksum, designTasks, designVersions, loadCurrentMembershipContext, memberships, membershipRoles,
  mockupBatches, mockupBatchItems, mockupBatchOutputs, mockupTemplatePackVersions, mockupTemplateSlots,
  mockupTemplateSourceInspections, roles, withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { stageCreativeExecution, type CreativeOperation } from "@yummyai/pod-core";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CreativeExecutionRecovery } from "../../../worker/src/processors/creative-execution-recovery.js";
import { creativeOwnerRunning, creativeOwnerStopped, refreshCreativeProgress, refreshMockupItem, refreshMockupProgress } from "../../../worker/src/processors/creative-execution-owner-state.js";
import { CreativeDesignCandidateProcessor, MockupRenderProcessor } from "../../../worker/src/processors/pod-batch-workflow.processor.js";
import type { PodArtworkGateway } from "../../../worker/src/processors/pod-artwork.processor.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { PodMockupBatchService } from "./pod-mockup-batch.service.js";

// Reject before constructing clients. Four independent single-session clients make
// the real parent/cancel/worker lock interleave observable without a Worker loop.
requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.DATABASE_POOL_SIZE !== "1")
  throw new Error("Creative cancellation regression requires the isolated current-schema runner and single-session pools");

type Kind = "design" | "mockup";
type Execution = typeof creativeExecutions.$inferSelect;
type Fixture = { kind: Kind; batchId: string; itemId: string; operation: CreativeOperation; execution: Execution };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function failureCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && /^[A-Z0-9_]{1,80}$/.test(current.code)) return current.code;
    current = "cause" in current ? current.cause : undefined;
  }
  return "TEST_OPERATION_FAILED";
}

describe("cancelled creative owners resist late original work in real tenant transactions", () => {
  const database = connectDatabase(), workerDatabase = connectDatabase(), blockerDatabase = connectDatabase(), observerDatabase = connectDatabase();
  const storage = createStorageFromEnvironment(), audit = new AuditService(database);
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const candidateIds: string[] = [];
  const queue = {
    enqueueCreativeCandidate: async (input: { candidateId: string }) => { candidateIds.push(input.candidateId); throw new Error("Synthetic queue unavailable"); },
    enqueueCreativeAdaptation: async () => { throw new Error("Synthetic adaptation dispatch forbidden"); },
    enqueueTemplateCompile: async () => { throw new Error("Synthetic compilation dispatch forbidden"); },
    enqueueMockupRender: async () => { throw new Error("Synthetic mockup dispatch forbidden"); },
  };
  const designs = new PodBatchWorkflowService(database, queue, audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const mockups = new PodMockupBatchService(database, queue, audit, new PodGovernanceService(database, audit));
  const recovery = new CreativeExecutionRecovery(workerDatabase, storage, undefined, creativeOwnerStopped);
  let skuId: string;
  const envelope = (payload: Record<string, string>): JobEnvelope => ({ jobId: createEntityId(), idempotencyKey: createEntityId(),
    correlationId: createEntityId(), traceId: createTraceId(), tenantId: context.tenantId, requestedBy: context.userId,
    requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload });

  beforeAll(async () => {
    vi.stubEnv("POD_BATCH_WORKFLOWS_ENABLED", "true");
    vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image,canvas_extend");
    vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:9");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "synthetic-cancellation-no-call");
    vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "synthetic-cancellation-no-network");
    // Only global synthetic identity bootstrap uses the runner's administrative
    // connection. Every tenant row and every exercised owner uses withTenant.
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic cancellation regression',$2)",
      [context.tenantId, `creative-cancellation-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic cancellation owner')",
      [context.userId, `creative-cancellation-${context.userId}`, `${context.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: "Synthetic cancellation owner", permissions: Object.values(Permission), dataScope: "self" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
    });
    Object.assign(context, await withTenant(database.db, context, tx => loadCurrentMembershipContext(tx, context)));
    const catalog = new ProductService(new DrizzleCatalogRepository(database));
    const plan = await catalog.createPlan(context, { name: "Synthetic cancellation source", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(context, plan.id, "pending_approval"); await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `CANCEL-${plan.id}`, name: "Synthetic cancellation source" });
    skuId = (await catalog.createSku(context, { spuId: spu.id, code: `CANCEL-${spu.id}`, attributes: { canvas_aspect_ratio: "1:1" } })).id;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([database, workerDatabase, blockerDatabase, observerDatabase].map(value => value.client.end()));
    // The acceptance runner owns and removes this disposable DB and its private
    // bucket, including the exact synthetic PSD objects and immutable history.
  });

  async function designFixture(): Promise<Fixture> {
    const spec = await designs.createPrintSpec(context, { name: `Synthetic cancellation ${createEntityId()}`, aspectWidth: 1, aspectHeight: 1,
      targetDpi: 300, bleedMm: 0, safeZoneMm: 0, wrapMode: "none", physicalSizes: [{ key: "300", label: "Synthetic", widthMm: 300, heightMm: 300 }] });
    await designs.reviewPrintSpec(context, spec.id, { decision: "approve" });
    await expect(designs.createDesignBatch(context, CreateCreativeDesignBatchInputSchema.parse({ name: `Synthetic cancelled ${createEntityId()}`, items: [{ rowKey: "one", name: "Synthetic queued failure",
      prompt: "Synthetic no-model cancellation", referenceAssetIds: [], candidateCount: 1, printSpecVersionIds: [spec.id] }] }))).rejects.toMatchObject({ status: 503 });
    const candidateId = candidateIds.at(-1)!;
    return withTenant(database.db, context, async tx => {
      const [source] = await tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems }).from(creativeDesignCandidates)
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id)).where(eq(creativeDesignCandidates.id, candidateId));
      const [execution] = await tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
        .where(eq(creativeExecutions.candidateId, candidateId)).returning();
      expect(source!.candidate).toMatchObject({ status: "failed", errorCode: "QUEUE_UNAVAILABLE" });
      expect(execution).toMatchObject({ phase: "pending", attemptCount: 0, submittedAt: null });
      return { kind: "design", batchId: source!.item.batchId, itemId: source!.item.id,
        operation: { kind: "creative_candidate", ownerId: candidateId, stepKey: "generate" }, execution: execution! };
    });
  }

  async function mockupFixture(): Promise<Fixture> {
    const batchId = createEntityId(), itemId = createEntityId(), slotId = createEntityId(), packId = createEntityId();
    const assetId = createEntityId(), inspectionId = createEntityId(), designTaskId = createEntityId(), designVersionId = createEntityId();
    const psd = await readFile(new URL("../../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
    const original = await storage.putPrivate(context, { body: psd, domain: "authorized", fileName: `synthetic-cancellation-${assetId}.psd`, mediaType: "image/vnd.adobe.photoshop" });
    return withTenant(database.db, context, async tx => {
      // Structural, non-renderable owner fixture: original bytes really exist,
      // but no golden-image compilation, approved design or production is claimed.
      // Cancellation/failure must remain safe even when old sources are unusable.
      await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, assetDomain: "authorized",
        objectKey: original.objectKey, checksumSha256: original.checksumSha256, byteSize: psd.length, fileName: `synthetic-cancellation-${assetId}.psd`,
        mediaType: "image/vnd.adobe.photoshop", rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned", reference: "Synthetic cancellation fixture only" } } });
      await tx.insert(designTasks).values({ id: designTaskId, tenantId: context.tenantId, skuId, title: "Synthetic cancellation design", brief: "Structural reference only", createdBy: context.userId });
      await tx.insert(designVersions).values({ id: designVersionId, tenantId: context.tenantId, taskId: designTaskId, versionNumber: 1, createdBy: context.userId });
      await tx.insert(mockupTemplateSourceInspections).values({ id: inspectionId, tenantId: context.tenantId, sourceAssetId: assetId,
        sourceAssetVersion: 1, checksumSha256: original.checksumSha256, slotKey: "main", compilerVersion: "synthetic-cancellation", requestedBy: context.userId });
      await tx.insert(mockupTemplatePackVersions).values({ id: packId, tenantId: context.tenantId, packId: createEntityId(), versionNumber: 1,
        name: "Synthetic uncompiled cancellation pack", platform: "amazon", locale: "en-US", createdBy: context.userId });
      await tx.insert(mockupTemplateSlots).values({ id: slotId, tenantId: context.tenantId, templatePackVersionId: packId, inspectionId,
        slotKey: "main", label: "Synthetic", ordinal: 0, required: true, acceptedPrintSpecVersionIds: [] });
      await tx.insert(mockupBatches).values({ id: batchId, tenantId: context.tenantId, name: "Synthetic mockup cancellation", templatePackVersionId: packId,
        platform: "amazon", locale: "en-US", itemCount: 1, requestChecksum: creativeExecutionChecksum({ batchId }), createdBy: context.userId });
      await tx.insert(mockupBatchItems).values({ id: itemId, tenantId: context.tenantId, batchId, ordinal: 0, designVersionId, skuId, status: "failed" });
      await tx.insert(mockupBatchOutputs).values({ id: createEntityId(), tenantId: context.tenantId, itemId, templateSlotId: slotId,
        slotKey: "main", attempt: 1, status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: "Synthetic original queue failure", completedAt: new Date() });
      const operation: CreativeOperation = { kind: "mockup_render", ownerId: itemId, stepKey: `slot:${slotId}:attempt:1` };
      const execution = await stageCreativeExecution(tx, context, operation, "internal_write");
      await tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(creativeExecutions.id, execution.id));
      return { kind: "mockup", batchId, itemId, operation, execution };
    });
  }

  const fixture = (kind: Kind) => kind === "design" ? designFixture() : mockupFixture();
  const cancel = (f: Fixture) => f.kind === "design" ? designs.cancelDesignBatch(context, f.batchId) : mockups.cancelBatch(context, f.batchId);
  async function ownerSnapshot(f: Fixture) {
    return withTenant(observerDatabase.db, context, async tx => {
      if (f.kind === "design") {
        const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, f.batchId));
        const [item] = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.id, f.itemId));
        const candidates = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.itemId, f.itemId));
        return { batch, item, children: candidates };
      }
      const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, f.batchId));
      const [item] = await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.id, f.itemId));
      const outputs = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, f.itemId));
      return { batch, item, children: outputs };
    });
  }
  async function effectSnapshot(f: Fixture) {
    const [row] = await withTenant(observerDatabase.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, f.execution.id)));
    return { inputFingerprint: row!.inputFingerprint, authorityChecksum: row!.authorityChecksum, executionContract: row!.executionContract,
      methodSelection: row!.methodSelection, submittedAt: row!.submittedAt, submissionToken: row!.submissionToken, receipt: row!.receipt,
      budgetLedgerId: row!.budgetLedgerId, budgetLimitUsd: row!.budgetLimitUsd, responseObjectKey: row!.responseObjectKey,
      responseChecksum: row!.responseChecksum, artifactManifest: row!.artifactManifest, completionEvidence: row!.completionEvidence,
      completionChecksum: row!.completionChecksum };
  }

  it.each<Kind>(["design", "mockup"])("keeps a %s cancellation after an original QUEUE_UNAVAILABLE job arrives late", async kind => {
    const f = await fixture(kind), effects = await effectSnapshot(f);
    await cancel(f);
    const cancelled = await ownerSnapshot(f);
    expect(cancelled.batch!.status).toBe("cancelled");
    const execute = vi.fn(async () => { throw new Error("Provider calls are forbidden in cancellation regression"); });
    const run = vi.fn(async () => { throw new Error("Rendering is forbidden in cancellation regression"); });
    if (kind === "design") {
      const gateway: PodArtworkGateway = { execute };
      await expect(new CreativeDesignCandidateProcessor(workerDatabase, storage, gateway).process(envelope({ candidateId: f.operation.ownerId }))).rejects.toThrow();
    } else await new MockupRenderProcessor(workerDatabase, storage, { run }).process(envelope({ itemId: f.itemId }));
    expect(await ownerSnapshot(f)).toEqual(cancelled);
    expect(await effectSnapshot(f)).toEqual(effects);
    expect(execute).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  });

  async function staleOwnerNotifications(f: Fixture) {
    await withTenant(workerDatabase.db, context, async tx => {
      await creativeOwnerRunning(tx, f.execution);
      await creativeOwnerStopped(tx, f.execution, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
      await creativeOwnerStopped(tx, f.execution, "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", false);
      if (f.kind === "design") await refreshCreativeProgress(tx, f.batchId);
      else { await refreshMockupItem(tx, f.itemId); await refreshMockupProgress(tx, f.batchId); }
    });
  }
  it.each<Kind>(["design", "mockup"])("preserves all %s owner rows on stale running/stop/finish notifications after cancellation", async kind => {
    const f = await fixture(kind), effects = await effectSnapshot(f);
    await cancel(f);
    const cancelled = await ownerSnapshot(f);
    await staleOwnerNotifications(f);
    expect(await ownerSnapshot(f)).toEqual(cancelled);
    expect(await effectSnapshot(f)).toEqual(effects);
  });
  it("preserves an archived failed design parent independently of cancellation", async () => {
    const f = await designFixture(), effects = await effectSnapshot(f);
    await recovery.fail(context, f.operation, undefined, "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", true);
    expect((await ownerSnapshot(f)).batch!.status).toBe("failed");
    await designs.archiveDesignBatch(context, f.batchId, { archived: true, reason: "Synthetic archived failure" });
    const archived = await ownerSnapshot(f);
    const archivedBatch = archived.batch!;
    expect(archivedBatch.status).toBe("failed");
    expect("archivedAt" in archivedBatch && archivedBatch.archivedAt).toBeTruthy();
    await staleOwnerNotifications(f);
    expect(await ownerSnapshot(f)).toEqual(archived);
    expect(await effectSnapshot(f)).toEqual(effects);
  });
  it.each<Kind>(["design", "mockup"])("still records an ordinary %s owner failure while its parent is active", async kind => {
    const f = await fixture(kind), effects = await effectSnapshot(f);
    expect((await ownerSnapshot(f)).batch!.status).toBe("queued");
    await recovery.fail(context, f.operation, undefined, "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", true);
    expect((await ownerSnapshot(f)).batch!.status).toBe("failed");
    expect(await effectSnapshot(f)).toEqual(effects);
  });

  async function backendPid(connection: DatabaseConnection) {
    return withTenant(connection.db, context, async tx => Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid));
  }
  async function waitForBlock(pid: number, blockers: number[]) {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const [row] = await withTenant(observerDatabase.db, context, tx => tx.execute<{ blockers: number[] }>(sql`select pg_blocking_pids(${pid}::int) as blockers`));
      if (row!.blockers.some(value => blockers.includes(value))) return;
      if (performance.now() >= deadline) throw new Error("Synthetic cancellation lock interleave was not reached");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  it.each<Kind>(["design", "mockup"])("locks the %s parent before child writes while the real cancel API is waiting", async kind => {
    const f = await fixture(kind), effects = await effectSnapshot(f), held = deferred(), release = deferred();
    const apiPid = await backendPid(database), workerPid = await backendPid(workerDatabase);
    let blockerPid = 0;
    const holder = withTenant(blockerDatabase.db, context, async tx => {
      blockerPid = Number((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      if (kind === "design") await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, f.batchId)).for("update");
      else await tx.select().from(mockupBatches).where(eq(mockupBatches.id, f.batchId)).for("update");
      held.resolve(); await release.promise;
    });
    const holderResult = holder.then(() => ({ ok: true as const }), error => ({ ok: false as const, code: failureCode(error) }));
    let cancelResult: Promise<{ ok: boolean; code?: string }> | undefined, workerResult: Promise<{ ok: boolean; code?: string }> | undefined;
    try {
      await Promise.race([held.promise, holder.then(() => { throw new Error("Synthetic parent lock unexpectedly released"); })]);
      cancelResult = cancel(f).then(() => ({ ok: true }), error => ({ ok: false, code: failureCode(error) }));
      await waitForBlock(apiPid, [blockerPid]);
      workerResult = recovery.fail(context, f.operation, undefined, "CREATIVE_AUTHORITY_OR_INPUT_CHANGED", true)
        .then(() => ({ ok: true }), error => ({ ok: false, code: failureCode(error) }));
      await waitForBlock(workerPid, [blockerPid, apiPid]);
      const locks = await withTenant(observerDatabase.db, context, tx => tx.execute<{ name: string }>(sql`
        select c.relname as name from pg_locks l join pg_class c on c.oid=l.relation
        where l.pid=${workerPid}::int and l.granted and l.mode='RowExclusiveLock'
          and c.relname in ('creative_design_batch_items','creative_design_candidates','creative_design_versions','mockup_batch_items','mockup_batch_outputs')`));
      expect([...locks]).toEqual([]);
    } finally {
      release.resolve();
      const results = await Promise.all([holderResult, cancelResult, workerResult].filter(value => value !== undefined));
      expect(results).toEqual(results.map(() => ({ ok: true })));
    }
    expect((await ownerSnapshot(f)).batch!.status).toBe("cancelled");
    expect(await effectSnapshot(f)).toEqual(effects);
  });
});
