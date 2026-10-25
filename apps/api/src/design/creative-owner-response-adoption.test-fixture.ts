import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts, Permission } from "@yummyai/authz";
import { CreateCreativeDesignBatchInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CreativeResponseAdoptionCommand } from "@yummyai/contracts/harness/creative-response-adoption";
import { CreativeOwnerResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-owner-response-adoption";
import { aiBudgetLedger, artifactRelations, assetFiles, canvasPrintSpecVersions, creativeDesignBatches,
  creativeDesignBatchItems, creativeDesignCandidates, creativeDesignVersionAssets, creativeDesignVersions,
  creativeExecutions, creativeOwnerResponseAdoptions, creativeStudioEntries, creativeStudioGenerations,
  creativeStudioRevisions, designVersions, mockupBatchItems, mockupBatchOutputs, mockupBatches,
  mockupTemplateSourceInspections, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { compileControlledPsd, NativeImageMagickRunner, type ImageMagickRunner } from "@yummyai/mockup-renderer";
import { creativeLocalResponse, creativeMockupStep, creativeResponseChecksum, parseCreativeResponse, type CreativeOperation, type CreativeResponse } from "@yummyai/pod-core";
import { objectKey, type Storage } from "@yummyai/storage";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { requireCreativeOwnerResponseAdoptionEnvironment } from "../../../../tools/testing/creative-owner-response-adoption-environment.mjs";
import { CreativeExecutionRecovery } from "../../../worker/src/processors/creative-execution-recovery.js";
import { creativeOwnerRunning, creativeOwnerStopped } from "../../../worker/src/processors/creative-execution-owner-state.js";
import { CreativeDesignAdaptationProcessor, CreativeDesignCandidateProcessor, MockupRenderProcessor,
  MockupTemplateCompileProcessor } from "../../../worker/src/processors/pod-batch-workflow.processor.js";
import type { PodArtworkGateway } from "../../../worker/src/processors/pod-artwork.processor.js";
import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { CreativeOwnerResponseAdoptionService } from "./creative-owner-response-adoption.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { PodMockupBatchService } from "./pod-mockup-batch.service.js";
import { createStudioPaidImageFixture } from "./studio-paid-image.test-fixture.js";

export const ownerFixtureSha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export type OwnerSeedKind = "creative_adaptation" | "adaptation_outpaint" | "template_compile" | "mockup_render" | "studio_generation";
export type OwnerSeed = {
  variant: OwnerSeedKind; executionId: string; operation: CreativeOperation; parentId: string | null;
  specId?: string; versionId?: string; batchId?: string; sourceAssetId?: string; inspectionId?: string;
  mockupItemId?: string; mockupOutputId?: string; scope?: string; generationId?: string;
};
type Hook = "read" | "put";
const permissions = Object.values(Permission);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Every target comes from the real business producer and real Processor. A
 * storage fault occurs only after its original trusted archive was recorded.
 * This is a disposable fixture, never a production-image or billing result. */
export async function createCreativeOwnerResponseAdoptionFixture(fixtureOptions: { database?: DatabaseConnection; context?: TenantContext } = {}) {
  const environment = requireCreativeOwnerResponseAdoptionEnvironment();
  const paid = await createStudioPaidImageFixture(fixtureOptions);
  const { database, storage } = paid;
  let context: TenantContext | undefined, closed = false;
  const batches = new Set<string>(), mockupBatchIds = new Set<string>(), seeds: OwnerSeed[] = [];
  const nativeDirectories = new Set<string>(), releases = new Set<() => void>(), running = new Set<Promise<unknown>>();
  const nativeFailures: unknown[] = [];
  const hooks: Partial<Record<Hook, () => Promise<void>>> = {};
  const counts = { candidateDispatches: 0, adaptationDispatches: 0, compileDispatches: 0, renderDispatches: 0,
    podGatewayCalls: 0, adoptionReads: 0, adoptionWrites: 0 };
  const vault = createEnvironmentSecretVault("POD_EXECUTION_ENCRYPTION_KEY", "yummyai:pod-execution-v1");
  const audit = new AuditService(database), designs = new DesignService(new DrizzleDesignRepository(database, storage));
  const selectedVersions: string[] = [];
  const queue = {
    async enqueueCreativeCandidate() { counts.candidateDispatches++; },
    async enqueueCreativeAdaptation(input: { creativeDesignVersionId: string }) { counts.adaptationDispatches++; selectedVersions.push(input.creativeDesignVersionId); },
    async enqueueTemplateCompile() { counts.compileDispatches++; },
    async enqueueMockupRender() { counts.renderDispatches++; },
  };
  const pod = new PodBatchWorkflowService(database, queue, audit, designs);
  const mockups = new PodMockupBatchService(database, queue, audit, new PodGovernanceService(database, audit));
  const recovery = new CreativeExecutionRecovery(database, storage, vault, creativeOwnerStopped);
  const observed = new Proxy(storage, { get(target, key) {
    if (key === "readPrivate") return async (...args: Parameters<Storage["readPrivate"]>) => {
      const result = await target.readPrivate(...args); counts.adoptionReads++; await hooks.read?.(); return result;
    };
    if (key === "putPrivate") return async (...args: Parameters<Storage["putPrivate"]>) => {
      const result = await target.putPrivate(...args); counts.adoptionWrites++; await hooks.put?.(); return result;
    };
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
  const nativeRunner = (): ImageMagickRunner => {
    const native = new NativeImageMagickRunner();
    return { async run(args, options) {
      if (options?.cwd) nativeDirectories.add(options.cwd);
      try { await native.run(args, options); }
      catch (cause) { nativeFailures.push(cause); throw cause; }
    } };
  };
  const current = async () => {
    if (!context) throw new Error("owner_fixture_not_admitted");
    const latest = await paid.current(context);
    return fixtureOptions.context ? intersectPermissionContexts(fixtureOptions.context, latest) : latest;
  };
  const envelope = (payload: Record<string, string>): JobEnvelope => {
    if (!context) throw new Error("owner_fixture_not_admitted");
    return { jobId: createEntityId(), correlationId: createEntityId(), idempotencyKey: createEntityId(), traceId: createTraceId(),
      tenantId: context.tenantId, requestedBy: context.userId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload };
  };
  const service = (seed: OwnerSeed, store: Storage = observed) => new CreativeOwnerResponseAdoptionService(database, store,
    { vault: seed.variant === "studio_generation" ? paid.vault : vault });
  async function execution(operation: CreativeOperation) {
    const rows = await withTenant(database.db, await current(), tx => tx.select().from(creativeExecutions)
      .where(and(eq(creativeExecutions.kind, operation.kind), eq(creativeExecutions.stepKey, operation.stepKey))).orderBy(asc(creativeExecutions.id)));
    const row = rows.find(row => (row.creativeVersionId ?? row.inspectionId ?? row.mockupItemId ?? row.studioGenerationId) === operation.ownerId);
    if (!row) throw new Error("owner_fixture_real_execution_missing"); return row;
  }
  async function due(id: string) {
    await withTenant(database.db, await current(), tx => tx.update(creativeExecutions).set({ nextAttemptAt: sql`clock_timestamp()-interval '1 second'` })
      .where(and(eq(creativeExecutions.id, id), eq(creativeExecutions.phase, "pending"), eq(creativeExecutions.attemptCount, 0))));
  }
  function gateway(): PodArtworkGateway {
    return { async execute(_identity, task) {
      counts.podGatewayCalls++;
      const expanded = task.toolKey === "canvas_extend", width = expanded ? 420 : 400, height = expanded ? 320 : 300;
      const bytes = await sharp({ create: { width, height, channels: 4, background: "#2879be" } }).png().toBuffer();
      return { modelKey: "synthetic-owner-original", modelVersion: "synthetic-owner-v1", costUsd: 0.02345678, partial: false,
        outputs: [{ bytes, fileName: "synthetic-owner-original.png", mediaType: "image/png", role: "effect",
          metadata: { width, height, unit: "px", colorMode: "rgb", transparent: true, aiInference: expanded ? "partial" : "full",
            ...(expanded ? { inferenceRegions: [{ x: 0, y: 0, width: 40, height }] } : {}) } }], qualityCheckSnapshot: { synthetic: true } };
    } };
  }
  async function selected(outpaint = false) {
    const actor = await current();
    const spec = await pod.createPrintSpec(actor, { name: "Synthetic owner spec " + createEntityId(), aspectWidth: 1, aspectHeight: 1,
      targetDpi: 300, bleedMm: 0, safeZoneMm: outpaint ? 20 : 0, wrapMode: "none",
      physicalSizes: [{ key: "square", label: "Synthetic 300 mm", widthMm: 300, heightMm: 300 }] });
    await pod.reviewPrintSpec(actor, spec.id, { decision: "approve" });
    const created = await pod.createDesignBatch(actor, CreateCreativeDesignBatchInputSchema.parse({ name: "Synthetic owner input " + createEntityId(),
      items: [{ rowKey: "one", name: "Synthetic original", prompt: "Synthetic fixture only No provider connection",
        candidateCount: 1, referenceAssetIds: [], printSpecVersionIds: [spec.id], focalPoint: { xPermille: outpaint ? 0 : 500, yPermille: 500 } }] }));
    batches.add(created.id);
    const [row] = await withTenant(database.db, actor, tx => tx.select({ candidate: creativeDesignCandidates }).from(creativeDesignCandidates)
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignBatchItems.batchId, created.id)));
    if (!row) throw new Error("owner_fixture_candidate_missing");
    const [candidateExecution] = await withTenant(database.db, actor, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.candidateId, row.candidate.id)));
    if (!candidateExecution) throw new Error("owner_fixture_candidate_execution_missing");
    await due(candidateExecution.id);
    const transport = gateway();
    await new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId: row.candidate.id }));
    await pod.selectCandidate(actor, created.id, row.candidate.id);
    const versionId = selectedVersions.at(-1); if (!versionId) throw new Error("owner_fixture_selected_version_missing");
    const operation = { kind: "creative_adaptation" as const, ownerId: versionId, stepKey: "spec:" + spec.id };
    await due((await execution(operation)).id);
    return { batchId: created.id, specId: spec.id, versionId, operation, transport };
  }
  async function licensedInspection() {
    const actor = await current(), bytes = await readFile(new URL("../../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
    const assetId = createEntityId(), fileName = "synthetic-owner-licensed-" + assetId + ".psd";
    const stored = await storage.putPrivate(actor, { domain: "authorized", fileName, mediaType: "image/vnd.adobe.photoshop", body: bytes });
    await withTenant(database.db, actor, tx => tx.insert(assetFiles).values({ id: assetId, tenantId: actor.tenantId, ownerUserId: actor.userId,
      ...stored, assetDomain: "authorized", fileName, byteSize: bytes.length, mediaType: "image/vnd.adobe.photoshop", rightsStatus: "approved",
      rightsMetadata: { source: { kind: "licensed", reference: "Synthetic disposable source license", licenseExpiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        approvedAt: new Date().toISOString(), approvedBy: actor.userId } }));
    const inspection = await mockups.createInspection(actor, { sourceAssetId: assetId, sourceAssetVersion: 1, checksumSha256: stored.checksumSha256, slotKey: "main" });
    const operation = { kind: "template_compile" as const, ownerId: inspection.id, stepKey: "compile" };
    await due((await execution(operation)).id);
    return { sourceAssetId: assetId, inspectionId: inspection.id, operation };
  }
  async function mockupTarget() {
    const actor = await current(), item = await selected();
    await new CreativeDesignAdaptationProcessor(database, storage, item.transport).process(envelope({ creativeDesignVersionId: item.versionId }));
    await pod.reviewCreativeVersion(actor, item.versionId, { decision: "approve" });
    const catalog = new ProductService(new DrizzleCatalogRepository(database));
    const plan = await catalog.createPlan(actor, { name: "Synthetic owner mockup product", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(actor, plan.id, "pending_approval"); await catalog.transition(actor, plan.id, "approved");
    const spu = await catalog.createSpu(actor, plan.id, { code: "OWNER-" + plan.id, name: "Synthetic owner fixture" });
    const sku = await catalog.createSku(actor, { spuId: spu.id, code: "OWNER-" + spu.id, attributes: { canvas_aspect_ratio: "1:1" } });
    const bound = await pod.createSkuBindings(actor, item.versionId, { bindings: [{ skuId: sku.id, printSpecVersionId: item.specId }] });
    const formalId = bound.items[0]?.designVersionId; if (!formalId) throw new Error("owner_fixture_formal_design_missing");
    const [formal] = await withTenant(database.db, actor, tx => tx.select().from(designVersions).where(eq(designVersions.id, formalId)));
    if (formal?.status === "pending_review") await designs.reviewVersion(actor, formal.id, { decision: "approve" });
    const inspection = await licensedInspection();
    await new MockupTemplateCompileProcessor(database, storage, nativeRunner()).process(envelope({ inspectionId: inspection.inspectionId }));
    const confirmation = await mockups.getInspection(actor, inspection.inspectionId);
    await mockups.confirmInspection(actor, inspection.inspectionId, confirmation.reviewFingerprint);
    const pack = await mockups.createTemplatePack(actor, { name: "Synthetic owner pack " + createEntityId(), platform: "amazon", locale: "en-US", productCategory: "canvas_art",
      slots: [{ slotKey: "main", label: "Synthetic main", ordinal: 0, required: true, inspectionId: inspection.inspectionId, acceptedPrintSpecVersionIds: [item.specId] }] });
    await mockups.reviewTemplatePack(actor, pack.id, { decision: "approve" });
    const batch = await mockups.createBatch(actor, { name: "Synthetic owner render " + createEntityId(), templatePackVersionId: pack.id, platform: "amazon", locale: "en-US",
      items: [{ designVersionId: formalId, skuId: sku.id }] });
    mockupBatchIds.add(batch.id);
    const [renderItem] = await withTenant(database.db, actor, tx => tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batch.id)));
    if (!renderItem) throw new Error("owner_fixture_mockup_item_missing");
    const [target] = await withTenant(database.db, actor, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.mockupItemId, renderItem.id)));
    if (!target) throw new Error("owner_fixture_mockup_execution_missing");
    await due(target.id);
    return { ...inspection, batchId: batch.id, mockupItemId: renderItem.id, operation: { kind: "mockup_render" as const, ownerId: renderItem.id, stepKey: target.stepKey } };
  }
  async function withOriginalOutputFailure(work: () => Promise<unknown>) {
    const put = storage.putPrivate.bind(storage); let intercepted = 0, failure: unknown;
    storage.putPrivate = async (...args: Parameters<Storage["putPrivate"]>) => {
      if (args[1].domain === "authorized") { intercepted++; throw new Error("SYNTHETIC_OWNER_ORIGINAL_OUTPUT_STORAGE_UNAVAILABLE"); }
      return put(...args);
    };
    try { await work(); } catch (cause) { failure = cause; }
    finally { storage.putPrivate = put; }
    // Studio's processor records its failure and may return a disposition;
    // the original storage fault and archive/terminal checks are the evidence.
    if (intercepted !== 1) throw new AggregateError([failure, ...nativeFailures].filter(value => value !== undefined),
      "owner_fixture_original_output_fault_not_reached:" + intercepted);
  }
  async function stopArchived(operation: CreativeOperation, selectedRecovery = recovery) {
    const before = await execution(operation);
    if (!before.responseObjectKey || !before.encryptedChecksum || !before.responseChecksum || !before.responseExpiresAt || before.completionEvidence)
      throw new Error("owner_fixture_real_original_archive_missing");
    if (!["failed", "uncertain"].includes(before.phase)) await selectedRecovery.fail(await current(), operation, undefined, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
    const after = await execution(operation);
    if (!["failed", "uncertain"].includes(after.phase) || after.leaseToken || after.leaseExpiresAt || after.completionEvidence)
      throw new Error("owner_fixture_original_not_terminal");
    return after;
  }
  async function seed(variant: OwnerSeedKind, options: { withoutOriginalReview?: boolean } = {}): Promise<OwnerSeed> {
    let value: OwnerSeed;
    if (variant === "creative_adaptation" || variant === "adaptation_outpaint") {
      const input = await selected(variant === "adaptation_outpaint");
      await withOriginalOutputFailure(() => new CreativeDesignAdaptationProcessor(database, storage, input.transport)
        .process(envelope({ creativeDesignVersionId: input.versionId })));
      if (variant === "adaptation_outpaint") {
        const op = { kind: "creative_adaptation" as const, ownerId: input.versionId, stepKey: "outpaint:" + input.specId };
        const row = await stopArchived(op);
        // The original parent stops through its real recovery owner. Adopting
        // the child must not invent a completed local aspect adaptation.
        const parent = await execution(input.operation);
        if (!["failed", "uncertain"].includes(parent.phase)) await recovery.fail(await current(), input.operation, undefined, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
        value = { variant, executionId: row.id, operation: op, parentId: input.batchId, batchId: input.batchId, specId: input.specId, versionId: input.versionId };
      } else {
        const row = await stopArchived(input.operation);
        value = { variant, executionId: row.id, operation: input.operation, parentId: input.batchId, batchId: input.batchId, specId: input.specId, versionId: input.versionId };
      }
    } else if (variant === "template_compile") {
      const input = await licensedInspection();
      await withOriginalOutputFailure(() => new MockupTemplateCompileProcessor(database, storage, nativeRunner()).process(envelope({ inspectionId: input.inspectionId })));
      const row = await stopArchived(input.operation);
      value = { variant, executionId: row.id, operation: input.operation, parentId: null, sourceAssetId: input.sourceAssetId, inspectionId: input.inspectionId };
    } else if (variant === "mockup_render") {
      const input = await mockupTarget();
      await withOriginalOutputFailure(() => new MockupRenderProcessor(database, storage, nativeRunner()).process(envelope({ itemId: input.mockupItemId })));
      const row = await stopArchived(input.operation);
      const step = creativeMockupStep(row.stepKey);
      const [output] = await withTenant(database.db, await current(), tx => tx.select().from(mockupBatchOutputs)
        .where(and(eq(mockupBatchOutputs.itemId, input.mockupItemId), eq(mockupBatchOutputs.templateSlotId, step.slotId), eq(mockupBatchOutputs.attempt, step.attempt))));
      if (!output) throw new Error("owner_fixture_mockup_output_missing");
      value = { ...input, variant, executionId: row.id, parentId: input.batchId, mockupOutputId: output.id };
    } else {
      const actor = await current(), channel = await paid.channel(actor), scope = (await paid.project(actor)).id;
      if (options.withoutOriginalReview) context = await paid.grant(actor, permissions.filter(value => value !== Permission.DesignReview), "tenant");
      const originalActor = await current(), input = await paid.request(originalActor, channel.modelId), prepared = await paid.prepare(originalActor, scope, input);
      paid.admission(originalActor, true); const committed = await paid.commit(originalActor, prepared);
      if (options.withoutOriginalReview) context = await paid.grant(originalActor, permissions, "tenant");
      if (!committed.generationId) throw new Error("owner_fixture_paid_generation_missing");
      const operation = { kind: "studio_generation" as const, ownerId: committed.generationId, stepKey: "generate" };
      await due((await execution(operation)).id);
      await withOriginalOutputFailure(() => paid.processGeneration(actor, committed.generationId!));
      const row = await stopArchived(operation, paid.recovery);
      value = { variant, executionId: row.id, operation, parentId: scope, scope, generationId: committed.generationId };
    }
    seeds.push(value); return value;
  }
  async function archive(seed: OwnerSeed) {
    const row = await execution(seed.operation);
    if (!row.responseObjectKey) throw new Error("owner_fixture_archive_missing");
    const bytes = await storage.readPrivate(await current(), { id: row.id, tenantId: row.tenantId, assetDomain: "quarantine", objectKey: row.responseObjectKey }, { requiredDomain: "quarantine" });
    if (ownerFixtureSha(bytes) !== row.encryptedChecksum) throw new Error("owner_fixture_archive_checksum_changed");
    const secret = seed.variant === "studio_generation" ? paid.vault : vault;
    const body = secret.withSecret(Buffer.from(bytes).toString("utf8"), plain => JSON.parse(plain)) as { executionId: string; inputFingerprint: string; response: unknown };
    if (body.executionId !== row.id || body.inputFingerprint !== row.inputFingerprint) throw new Error("owner_fixture_archive_identity_changed");
    return { objectKey: row.responseObjectKey, encryptedSha256: ownerFixtureSha(bytes), response: parseCreativeResponse(body.response) as CreativeResponse };
  }
  async function original(seed: OwnerSeed) {
    const actor = await current(), row = await execution(seed.operation);
    return withTenant(database.db, actor, async tx => {
      const executions = await tx.select().from(creativeExecutions).where(inArray(creativeExecutions.id, [row.id, ...(row.parentExecutionId ? [row.parentExecutionId] : [])])).orderBy(asc(creativeExecutions.id));
      const ledger = await tx.select().from(aiBudgetLedger).orderBy(asc(aiBudgetLedger.id));
      return { executions, ledger, calls: { candidateDispatches: counts.candidateDispatches, adaptationDispatches: counts.adaptationDispatches,
        compileDispatches: counts.compileDispatches, renderDispatches: counts.renderDispatches, podGatewayCalls: counts.podGatewayCalls,
        paidGatewayCalls: paid.calls.length, paidQueue: [...paid.queueCalls] } };
    });
  }
  async function facts(seed: OwnerSeed) {
    const actor = await current();
    return withTenant(database.db, actor, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      const adoptions = await tx.select().from(creativeOwnerResponseAdoptions).where(eq(creativeOwnerResponseAdoptions.executionId, seed.executionId));
      const ids = adoptions.flatMap(row => row.artifactIntents?.map(value => value.assetId) ?? []);
      const assets = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)) : [];
      const versions = seed.versionId ? await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, seed.versionId)) : [];
      const parentBatches = seed.batchId ? await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, seed.batchId)) : [];
      const links = seed.versionId ? await tx.select().from(creativeDesignVersionAssets).where(eq(creativeDesignVersionAssets.creativeDesignVersionId, seed.versionId)).orderBy(asc(creativeDesignVersionAssets.id)) : [];
      const inspections = seed.inspectionId ? await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, seed.inspectionId)) : [];
      const outputs = seed.mockupItemId ? await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, seed.mockupItemId)) : [];
      const items = seed.mockupItemId ? await tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.id, seed.mockupItemId)) : [];
      const mockupParents = seed.mockupItemId ? await tx.select().from(mockupBatches).where(eq(mockupBatches.id, seed.parentId!)) : [];
      const generations = seed.generationId ? await tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, seed.generationId)) : [];
      const entries = seed.generationId ? await tx.select().from(creativeStudioEntries).where(eq(creativeStudioEntries.key, "image:" + seed.generationId)) : [];
      const revisions = entries.length ? await tx.select().from(creativeStudioRevisions).where(inArray(creativeStudioRevisions.entryId, entries.map(row => row.id))) : [];
      const relations = ids.length ? await tx.select().from(artifactRelations).where(inArray(artifactRelations.toAssetId, ids)) : [];
      return { role: role?.role, adoptions, assets, versions, parentBatches, links, inspections, outputs, items, mockupParents, generations, entries, revisions, relations };
    });
  }
  async function command(seed: OwnerSeed): Promise<CreativeResponseAdoptionCommand> {
    const workspace = CreativeOwnerResponseAdoptionWorkspaceSchema.parse(await service(seed).workspace(await current(), seed.executionId));
    if (!workspace.canAdopt || !workspace.basis) throw new Error("owner_fixture_real_admission_missing:" + workspace.blockers.join("|"));
    return { requestId: randomUUID(), expectedBasis: workspace.basis, acknowledgeReviewRequired: true };
  }
  function hold(stage: Hook) {
    const entered = deferred(), released = deferred(); let used = false;
    const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    hooks[stage] = async () => { if (!used) { used = true; entered.resolve(); await released.promise; } };
    return { entered: entered.promise, release, clear() { release(); delete hooks[stage]; } };
  }
  function adopt(seed: OwnerSeed, input: CreativeResponseAdoptionCommand, actor?: TenantContext) {
    const pending = (async () => service(seed).adopt(actor ?? await current(), seed.executionId, input))();
    running.add(pending); void pending.finally(() => running.delete(pending)).catch(() => undefined); return pending;
  }
  async function unarchived() {
    const input = await licensedInspection();
    await recovery.fail(await current(), input.operation, undefined, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
    const row = await execution(input.operation);
    if (row.phase !== "failed" || row.responseObjectKey || row.responseChecksum) throw new Error("owner_fixture_empty_archive_not_real");
    const value: OwnerSeed = { ...input, variant: "template_compile", executionId: row.id, parentId: null };
    seeds.push(value); return value;
  }
  async function approvedPrintSpec() {
    const actor = await current();
    const spec = await pod.createPrintSpec(actor, { name: "Synthetic confirmation spec " + createEntityId(), aspectWidth: 1, aspectHeight: 1,
      targetDpi: 300, bleedMm: 0, safeZoneMm: 0, wrapMode: "none", physicalSizes: [{ key: "square", label: "Synthetic", widthMm: 300, heightMm: 300 }] });
    await pod.reviewPrintSpec(actor, spec.id, { decision: "approve" }); return spec.id;
  }
  async function shortLivedTemplateHistory(): Promise<OwnerSeed> {
    const actor = await current(), input = await licensedInspection();
    const claim = await recovery.claim(actor, input.operation, (tx, admitted) => creativeOwnerRunning(tx, admitted.execution));
    if (!claim) throw new Error("owner_fixture_short_history_claim_missing");
    await recovery.authorized(actor, claim, async (_tx, admitted) => {
      if (admitted.source.kind !== "template_compile" || admitted.source.sourceAssetId !== input.sourceAssetId)
        throw new Error("owner_fixture_short_history_source_changed");
    });
    const [file] = await withTenant(database.db, actor, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, input.sourceAssetId)));
    if (!file) throw new Error("owner_fixture_short_history_source_missing");
    const bytes = await storage.readPrivate(actor, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    const compiled = await compileControlledPsd(bytes, "main", nativeRunner());
    const response = creativeLocalResponse([
      { role: "background", bytes: compiled.background, mediaType: "image/png" },
      { role: "foreground", bytes: compiled.foreground, mediaType: "image/png" },
      ...(compiled.mask ? [{ role: "mask", bytes: compiled.mask, mediaType: "image/png" as const }] : []),
      { role: "preview", bytes: compiled.preview, mediaType: "image/png" },
      { role: "manifest", bytes: compiled.manifestBytes, mediaType: "application/json" },
    ], { manifest: compiled.manifest, ssimPermille: compiled.ssimPermille, warnings: compiled.warnings });
    const original = await execution(input.operation);
    const encrypted = Buffer.from(vault.encrypt(JSON.stringify({ version: 1, tenantId: actor.tenantId,
      executionId: original.id, inputFingerprint: original.inputFingerprint, response })));
    const encryptedChecksum = ownerFixtureSha(encrypted), fileName = original.id + "-pod-response.pe";
    const key = objectKey({ tenantId: actor.tenantId, domain: "quarantine", sha256: encryptedChecksum, fileName });
    // Retention-history fixture only: the first archive assignment has a short
    // real PG-clock expiry. Never change normal record()'s seven-day TTL or an
    // already assigned checkpoint, disable a trigger, or alter either clock.
    const assigned = await withTenant(database.db, actor, tx => tx.update(creativeExecutions).set({ phase: "response_staging",
      responseObjectKey: key, encryptedChecksum, responseChecksum: creativeResponseChecksum(response),
      responseExpiresAt: sql`clock_timestamp()+interval '12 seconds'`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(creativeExecutions.id, original.id), eq(creativeExecutions.leaseToken, claim.token), sql`${creativeExecutions.responseObjectKey} is null`)).returning({ id: creativeExecutions.id }));
    if (assigned.length !== 1) throw new Error("owner_fixture_short_history_first_assignment_missing");
    const stored = await storage.putPrivate(actor, { body: encrypted, domain: "quarantine", fileName, mediaType: "application/octet-stream" });
    if (stored.objectKey !== key || stored.checksumSha256 !== encryptedChecksum) throw new Error("owner_fixture_short_history_archive_changed");
    await recovery.fail(actor, input.operation, claim, "CREATIVE_LOCAL_PROCESSING_FAILED", true);
    const value: OwnerSeed = { ...input, variant: "template_compile", executionId: original.id, parentId: null };
    seeds.push(value); return value;
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    for (const release of releases) release(); await Promise.allSettled([...running]);
    if (context) {
      if (!fixtureOptions.context) try { context = await paid.grant(context, permissions, "tenant"); } catch (cause) { failures.push(cause); }
      for (const seed of seeds) try {
        const rows = await withTenant(database.db, await current(), tx => tx.select().from(creativeOwnerResponseAdoptions).where(eq(creativeOwnerResponseAdoptions.executionId, seed.executionId)));
        for (const row of rows) if (row.status === "prepared" || row.status === "cancelled" && !row.artifactDiscardedAt)
          await service(seed).cancel(await current(), seed.executionId, row.id, row.request);
        if (rows.some(row => row.status === "processing")) throw new Error("owner_fixture_unresolved_io_retained_until_nonce_deletion");
      } catch (cause) { failures.push(cause); }
      for (const id of mockupBatchIds) try {
        const actor = await current(), [batch] = await withTenant(database.db, actor, tx => tx.select({ status: mockupBatches.status }).from(mockupBatches).where(eq(mockupBatches.id, id)));
        if (batch && !["completed", "cancelled"].includes(batch.status)) await mockups.cancelBatch(actor, id);
      } catch (cause) { failures.push(cause); }
      for (const id of batches) try {
        const actor = await current(), [batch] = await withTenant(database.db, actor, tx => tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, id)));
        if (batch && !["completed", "cancelled"].includes(batch.status)) await pod.cancelDesignBatch(actor, id);
        if (batch && !batch.archivedAt) await pod.archiveDesignBatch(actor, id, { archived: true, reason: "Synthetic owner response acceptance cleanup" });
      } catch (cause) { failures.push(cause); }
    }
    for (const directory of nativeDirectories) try { await access(directory); failures.push(new Error("owner_fixture_native_directory_retained")); }
    catch (cause) { if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")) failures.push(cause); }
    try { await paid.close(); } catch (cause) { failures.push(cause); }
    if (failures.length) throw new AggregateError(failures, "owner_response_fixture_cleanup_failed");
  }
  try {
    if (fixtureOptions.context) context = intersectPermissionContexts(fixtureOptions.context, await paid.current(fixtureOptions.context));
    else { const actor = await paid.actor(undefined, "tenant"); context = await paid.grant(actor.context, permissions, "tenant"); }
    await paid.policy(context);
    const [metadata] = await database.client.unsafe("select current_database() as name,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
    if (metadata?.name !== environment.name || metadata.migrations !== environment.schema) throw new Error("owner_fixture_exact_schema_required");
    return { environment, paid, database, storage, vault, pod, mockups, recovery, designs, service, current, seed, archive, original, facts, command,
      hold, adopt, execution, due, unarchived, approvedPrintSpec, shortLivedTemplateHistory, counts, nativeDirectories, close, permissions, canvasPrintSpecVersions };
  } catch (primary) { try { await close(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "owner_response_fixture_setup_and_cleanup_failed"); } throw primary; }
}
