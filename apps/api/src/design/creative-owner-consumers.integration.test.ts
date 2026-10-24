import { access, readFile } from "node:fs/promises";
import { NativeImageMagickRunner, type ImageMagickRunner } from "@yummyai/mockup-renderer";
import { Permission } from "@yummyai/authz";
import { createEntityId, CreateCreativeDesignBatchInputSchema, type TenantContext } from "@yummyai/contracts";
import { aiBudgetLedger, aiBudgetPolicies, assetFiles, connectDatabase, creativeDesignBatchItems, creativeDesignCandidates,
  creativeDesignVersions, creativeExecutions, designVersions,
  creativeExecutionChecksum, loadCurrentMembershipContext, memberships, membershipRoles, migrateDatabase, mockupBatchItems, mockupBatchOutputs,
  mockupTemplateSourceInspections, mockupTemplatePackVersions, listings, listingVersions, roles, skus, withTenant } from "@yummyai/database";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreativeDesignCandidateProcessor, CreativeDesignAdaptationProcessor, MockupTemplateCompileProcessor, MockupRenderProcessor } from "../../../worker/src/processors/pod-batch-workflow.processor.js";
import type { PodArtworkExecutionRecord, PodArtworkExecutionResult, PodArtworkGateway } from "../../../worker/src/processors/pod-artwork.processor.js";
import { CreativeExecutionRecovery } from "../../../worker/src/processors/creative-execution-recovery.js";
import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { PodMockupBatchService } from "./pod-mockup-batch.service.js";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Creative consumers require the disposable acceptance runner");

describe("original creative consumers with real storage, scanning and native mockup rendering", () => {
  const database = connectDatabase(), storage = createStorageFromEnvironment();
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const roleId = createEntityId(), audit = new AuditService(database), designs = new DesignService(new DrizzleDesignRepository(database, storage));
  const selectedVersions: string[] = [], enqueuedCandidates: string[] = [];
  const nativeTemporaryDirectories = new Set<string>();
  const nativeRunner = () => {
    const runner = new NativeImageMagickRunner();
    return { run: async (args, options) => { if (options?.cwd) nativeTemporaryDirectories.add(options.cwd); await runner.run(args, options); } } satisfies ImageMagickRunner;
  };
  let rejectDelivery = false, skuId: string, image: Buffer;
  const queue = { enqueueCreativeCandidate: async (input: { candidateId: string }) => { enqueuedCandidates.push(input.candidateId); if (rejectDelivery) throw new Error("Synthetic queue unavailable"); },
    enqueueCreativeAdaptation: async (input: { creativeDesignVersionId: string }) => { selectedVersions.push(input.creativeDesignVersionId); },
    enqueueTemplateCompile: async () => {}, enqueueMockupRender: async () => {} };
  const workflows = new PodBatchWorkflowService(database, queue, audit, designs);
  const mockups = new PodMockupBatchService(database, queue, audit, new PodGovernanceService(database, audit));
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const adaptation = (transport: PodArtworkGateway) => new CreativeDesignAdaptationProcessor(database, storage, transport,
    diagnostic => process.stderr.write(JSON.stringify({ syntheticCreativeDiagnostic: diagnostic }) + "\n"));
  const grant = (permissions: readonly string[] = Object.values(Permission)) => withTenant(database.db, context, tx => tx.update(roles).set({ permissions }).where(eq(roles.id, roleId)));
  const envelope = (payload: Record<string, string>): JobEnvelope => ({ jobId: createEntityId(), idempotencyKey: createEntityId(),
    correlationId: createEntityId(), traceId: createTraceId(), tenantId: context.tenantId, requestedBy: context.userId,
    requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload });
  async function spec(wrapMode: "none" | "extend" = "extend") {
    const created = await workflows.createPrintSpec(context, { name: `Synthetic ${createEntityId()}`, aspectWidth: 1, aspectHeight: 1,
      targetDpi: 300, bleedMm: 0, safeZoneMm: 20, wrapMode,
      physicalSizes: [{ key: "300x300", label: "Synthetic 300 mm", widthMm: 300, heightMm: 300 }] });
    await workflows.reviewPrintSpec(context, created.id, { decision: "approve" }); return created.id;
  }
  async function freshExecutionDue(kind: "candidate" | "adaptation", ownerId: string) {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const [execution] = await withTenant(database.db, context, tx => tx.select({
        phase: creativeExecutions.phase, attemptCount: creativeExecutions.attemptCount, leaseToken: creativeExecutions.leaseToken,
        due: sql<boolean>`${creativeExecutions.nextAttemptAt} <= clock_timestamp() - interval '25 milliseconds'`,
      }).from(creativeExecutions).where(and(
        eq(kind === "candidate" ? creativeExecutions.candidateId : creativeExecutions.creativeVersionId, ownerId),
        isNull(creativeExecutions.parentExecutionId),
      )));
      expect(execution).toMatchObject({ phase: "pending", attemptCount: 0, leaseToken: null });
      if (execution!.due) return;
      if (performance.now() >= deadline) throw new Error("Fresh synthetic creative execution did not become due");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function batch(focalX = 500, wrapMode: "none" | "extend" = "extend", recipeVersionId?: string) {
    const specId = await spec(wrapMode);
    const input = CreateCreativeDesignBatchInputSchema.parse({ name: `Synthetic ${createEntityId()}`, recipeVersionId, items: [{ rowKey: "one", name: "Synthetic original artwork",
      prompt: "Synthetic fixture only", candidateCount: 1, printSpecVersionIds: [specId], referenceAssetIds: [], focalPoint: { xPermille: focalX, yPermille: 500 } }] });
    const created = await workflows.createDesignBatch(context, input);
    const [row] = await withTenant(database.db, context, tx => tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems })
      .from(creativeDesignCandidates).innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId)).where(eq(creativeDesignBatchItems.batchId, created.id)));
    await freshExecutionDue("candidate", row!.candidate.id);
    return { batchId: created.id, candidateId: row!.candidate.id, itemId: row!.item.id, specId };
  }
  function gateway(after?: () => Promise<void>) {
    const execute = vi.fn(async (_identity: unknown, task: PodArtworkExecutionRecord): Promise<PodArtworkExecutionResult> => {
      if (after) await after();
      const expanded = task.toolKey === "canvas_extend", bytes = expanded
        ? await sharp({ create: { width: 420, height: 320, channels: 4, background: "#2879be" } }).png().toBuffer() : image;
      return { modelKey: "synthetic-provider-model", modelVersion: "synthetic-v1", costUsd: 0.02345678, partial: false,
        outputs: [{ bytes, fileName: "synthetic-result.png", mediaType: "image/png", role: "effect",
          metadata: { width: expanded ? 420 : 400, height: expanded ? 320 : 300, unit: "px", colorMode: "rgb", transparent: true,
            aiInference: expanded ? "partial" : "full", ...(expanded ? { inferenceRegions: [{ x: 0, y: 0, width: 40, height: 320 }] } : {}) } }],
        qualityCheckSnapshot: { syntheticProvider: true, passed: true } };
    });
    return { execute } satisfies PodArtworkGateway;
  }
  async function selected(focalX = 500, wrapMode: "none" | "extend" = "extend") {
    const item = await batch(focalX, wrapMode), transport = gateway();
    await new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId: item.candidateId }));
    await workflows.selectCandidate(context, item.batchId, item.candidateId);
    const versionId = selectedVersions.at(-1)!;
    await freshExecutionDue("adaptation", versionId);
    return { ...item, transport, versionId };
  }
  beforeAll(async () => {
    vi.stubEnv("POD_BATCH_WORKFLOWS_ENABLED", "true"); vi.stubEnv("POD_MOCKUP_RENDERER_ENABLED", "true");
    vi.stubEnv("POD_ENABLED_TOOLS", "text_to_image,canvas_extend"); vi.stubEnv("POD_PROCESSOR_URL", "http://127.0.0.1:9");
    vi.stubEnv("POD_PROCESSOR_API_KEY", "synthetic-test-only"); vi.stubEnv("POD_PROCESSOR_DEPLOYMENT_ID", "synthetic-no-network");
    await migrateDatabase(database); await storage.ensureBucket();
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic creative consumers',$2)", [context.tenantId, `creative-consumers-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic operator')", [context.userId, `creative-consumers-${context.userId}`, `${context.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const member = createEntityId(); await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: "Synthetic creative operator", permissions: Object.values(Permission), dataScope: "self" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId });
      await tx.insert(aiBudgetPolicies).values({ tenantId: context.tenantId, monthlyCapUsd: "100.000000", defaultTaskCapUsd: "0.100000", taskCapsUsd: {} });
    });
    Object.assign(context, await withTenant(database.db, context, tx => loadCurrentMembershipContext(tx, context)));
    const plan = await catalog.createPlan(context, { name: "Synthetic native mockup product", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(context, plan.id, "pending_approval"); await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `NATIVE-${plan.id}`, name: "Synthetic native product" });
    skuId = (await catalog.createSku(context, { spuId: spu.id, code: `NATIVE-${spu.id}`, attributes: { canvas_aspect_ratio: "1:1" } })).id;
    image = await sharp({ create: { width: 400, height: 300, channels: 4, background: "#2879be" } }).png().toBuffer();
  });
  beforeEach(async () => { rejectDelivery = false; await grant(); });
  afterAll(async () => {
    try {
      for (const directory of nativeTemporaryDirectories) await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
      process.stdout.write(JSON.stringify({ nativeTemporaryDirectoriesVerified: nativeTemporaryDirectories.size, allRemoved: true }) + "\n");
    }
    finally { vi.unstubAllEnvs(); await database.client.end(); }
  });

  it("runs one original candidate under concurrent queue deliveries and does not auto-approve its rights", async () => {
    const item = await batch(), transport = gateway(), processor = new CreativeDesignCandidateProcessor(database, storage, transport);
    await Promise.all([processor.process(envelope({ candidateId: item.candidateId })), processor.process(envelope({ candidateId: item.candidateId }))]);
    expect(transport.execute).toHaveBeenCalledTimes(1);
    const [candidate] = await withTenant(database.db, context, tx => tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, item.candidateId)));
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.candidateId, item.candidateId)));
    const [file] = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, candidate!.assetId!)));
    expect(candidate?.status).toBe("generated"); expect(execution?.phase).toBe("completed"); expect(file?.rightsStatus).toBe("unverified");
    expect(execution?.receipt?.costUsd).toBe("0.02345678");
  });

  it("creates and executes a candidate pinned to a read-only recipe version without granting UPDATE", async () => {
    const governance = new PodGovernanceService(database, audit);
    const recipe = await governance.createRecipe(context, { toolKey: "text_to_image", parameterSnapshot: {},
      modelPolicy: { routingPolicyVersion: "synthetic-recipe-v1", seedMode: "fixed" } });
    const item = await batch(500, "none", recipe.id), transport = gateway();
    const detail = await workflows.getDesignBatch(context, item.batchId);
    expect(detail.recipeVersionId).toBe(recipe.id);
    const [privilege] = await withTenant(database.db, context, tx => tx.execute<{ allowed: boolean }>(
      sql`select has_table_privilege(current_user,'design_recipe_versions','UPDATE') as allowed`));
    expect(privilege?.allowed).toBe(false);
    await new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId: item.candidateId }));
    expect(transport.execute).toHaveBeenCalledTimes(1);
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.candidateId, item.candidateId)));
    expect(execution?.phase).toBe("completed");
  });
  it("retains spent cost and raw response when a candidate loses authority during the provider call", async () => {
    const item = await batch(), transport = gateway(() => grant([]).then(() => undefined));
    await expect(new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId: item.candidateId }))).rejects.toThrow("CREATIVE_AUTHORITY_OR_INPUT_CHANGED");
    await grant();
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.candidateId, item.candidateId)));
    expect(execution).toMatchObject({ phase: "failed", receipt: { costUsd: "0.02345678" } }); expect(execution!.responseObjectKey).toBeTruthy();
    const [budget] = await withTenant(database.db, context, tx => tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, execution!.budgetLedgerId!)));
    expect(budget).toMatchObject({ state: "committed", amountUsd: "0.023457" });
    await new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId: item.candidateId }));
    expect(transport.execute).toHaveBeenCalledTimes(1);
  });
  it("crops by actual geometry despite an extend label without creating a paid adaptation receipt", async () => {
    const item = await selected(); await adaptation(item.transport).process(envelope({ creativeDesignVersionId: item.versionId }));
    const rows = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.creativeVersionId, item.versionId)));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ phase: "completed", effect: "internal_write", receipt: null, budgetLedgerId: null });
    const [version] = await withTenant(database.db, context, tx => tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, item.versionId)));
    expect(version?.status).toBe("pending_review"); expect(item.transport.execute).toHaveBeenCalledTimes(1);
  });
  it("activates one ceiling-bound outpaint child even when wrap mode is none", async () => {
    const item = await selected(0, "none"); await adaptation(item.transport).process(envelope({ creativeDesignVersionId: item.versionId }));
    const rows = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.creativeVersionId, item.versionId)));
    const parent = rows.find(row => row.effect === "internal_write")!, child = rows.find(row => row.effect === "external_request")!;
    expect(rows).toHaveLength(2); expect(parent.phase).toBe("completed"); expect(parent.receipt).toBeNull();
    expect(child).toMatchObject({ parentExecutionId: parent.id, phase: "completed", requestedBy: context.userId });
    expect(child.authoritySnapshot.context.permissionScopes).toEqual(parent.authoritySnapshot.context.permissionScopes);
    expect(child.receipt?.costUsd).toBe("0.02345678"); expect(item.transport.execute).toHaveBeenCalledTimes(2);
    const widened = { ...child.authoritySnapshot, context: { ...child.authoritySnapshot.context,
      permissionScopes: { ...child.authoritySnapshot.context.permissionScopes, [Permission.DesignWrite]: "tenant" as const } } };
    await expect(withTenant(database.db, context, tx => tx.insert(creativeExecutions).values({ ...child, id: createEntityId(),
      phase: "pending", attemptCount: 0, leaseToken: null, leaseExpiresAt: null, submittedAt: null, submissionToken: null,
      budgetLedgerId: null, budgetLimitUsd: null, receipt: null, responseObjectKey: null, encryptedChecksum: null, responseChecksum: null,
      responseExpiresAt: null, responsePurgedAt: null, artifactManifest: null, completionEvidence: null, completionChecksum: null,
      authoritySnapshot: widened, authorityChecksum: creativeExecutionChecksum(widened) }))).rejects.toMatchObject({ cause: { code: "55000" } });
    await new CreativeDesignAdaptationProcessor(database, storage, item.transport).process(envelope({ creativeDesignVersionId: item.versionId }));
    expect(item.transport.execute).toHaveBeenCalledTimes(2);
  });
  it("does not treat a queue error label as proof that a paid candidate was never submitted", async () => {
    const item = await batch(), recovery = new CreativeExecutionRecovery(database, storage);
    const claim = (await recovery.claim(context, { kind: "creative_candidate", ownerId: item.candidateId, stepKey: "generate" }))!;
    await recovery.markSubmitted(context, claim, { taskType: "creative_candidate", provider: "pod-processor", modelKey: "pod:text_to_image" });
    await withTenant(database.db, context, async tx => {
      await tx.update(creativeExecutions).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(creativeExecutions.id, claim.id));
      await tx.update(creativeDesignCandidates).set({ status: "failed", errorCode: "QUEUE_UNAVAILABLE", errorMessage: "Synthetic misleading delivery error", completedAt: new Date() }).where(eq(creativeDesignCandidates.id, item.candidateId));
    });
    await expect(workflows.retryDesignItem(context, item.batchId, item.itemId)).rejects.toMatchObject({ status: 409 });
    const [preserved] = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, claim.id)));
    expect(preserved?.submittedAt).toBeTruthy();
  });
  it("resumes a genuinely unsubmitted queue failure from its original execution", async () => {
    const specId = await spec(); rejectDelivery = true;
    await expect(workflows.createDesignBatch(context, CreateCreativeDesignBatchInputSchema.parse({ name: `Synthetic delivery ${createEntityId()}`,
      items: [{ rowKey: "one", name: "Synthetic failed delivery", prompt: "Synthetic original input", referenceAssetIds: [],
        candidateCount: 1, printSpecVersionIds: [specId] }] }))).rejects.toMatchObject({ status: 503 });
    rejectDelivery = false;
    const candidateId = enqueuedCandidates.at(-1)!, transport = gateway();
    await freshExecutionDue("candidate", candidateId);
    await new CreativeDesignCandidateProcessor(database, storage, transport).process(envelope({ candidateId }));
    const [candidate] = await withTenant(database.db, context, tx => tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.id, candidateId)));
    expect(candidate?.status).toBe("generated"); expect(transport.execute).toHaveBeenCalledTimes(1);
  });
  it("compiles a licensed PSD and renders through the real ImageMagick executable with inherited source rights", async () => {
    const item = await selected(); await adaptation(item.transport).process(envelope({ creativeDesignVersionId: item.versionId }));
    await workflows.reviewCreativeVersion(context, item.versionId, { decision: "approve" });
    const bound = await workflows.createSkuBindings(context, item.versionId, { bindings: [{ skuId, printSpecVersionId: item.specId }] });
    const binding = bound.items[0]!;
    const [formal] = await withTenant(database.db, context, tx => tx.select().from(designVersions).where(eq(designVersions.id, binding.designVersionId)));
    if (formal!.status === "pending_review") await designs.reviewVersion(context, formal!.id, { decision: "approve" });
    const body = await readFile(new URL("../../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
    const file = await storage.putPrivate(context, { body, domain: "authorized", fileName: "synthetic-licensed.psd", mediaType: "image/vnd.adobe.photoshop" });
    const assetId = createEntityId(), approvedAt = new Date().toISOString();
    await withTenant(database.db, context, tx => tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId,
      objectKey: file.objectKey, checksumSha256: file.checksumSha256, byteSize: body.length, assetDomain: "authorized", fileName: "synthetic-licensed.psd",
      mediaType: "image/vnd.adobe.photoshop", rightsStatus: "approved", rightsMetadata: { source: { kind: "licensed", reference: "Synthetic fixture license",
        licenseExpiresAt: new Date(Date.now() + 86400000).toISOString() }, approvedAt, approvedBy: context.userId } }));
    const compileDispatch = vi.spyOn(queue, "enqueueTemplateCompile");
    const inspectionInput = { sourceAssetId: assetId, sourceAssetVersion: 1, checksumSha256: file.checksumSha256, slotKey: "main" };
    const inspections = await Promise.all([mockups.createInspection(context, inspectionInput), mockups.createInspection(context, inspectionInput)]);
    const inspection = inspections[0]!;
    expect(inspections[1]!.id).toBe(inspection.id); expect(compileDispatch).toHaveBeenCalledTimes(1); compileDispatch.mockRestore();
    await new MockupTemplateCompileProcessor(database, storage, nativeRunner()).process(envelope({ inspectionId: inspection.id }));
    const [compiled] = await withTenant(database.db, context, tx => tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, inspection.id)));
    expect(compiled!.status).toBe("completed"); expect(compiled!.compilation!.ssimPermille).toBeGreaterThanOrEqual(990);
    const ids = [compiled!.compilation!.backgroundAssetId, compiled!.compilation!.foregroundAssetId, compiled!.compilation!.manifestAssetId];
    const derived = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)));
    for (const asset of derived) { expect(asset.rightsMetadata.source).toMatchObject({ kind: "licensed" }); expect(asset.rightsMetadata.approvedAt).toBeUndefined(); expect(asset.rightsMetadata.inheritedRights).toBeTruthy(); }
    const confirmation = await mockups.getInspection(context, inspection.id);
    expect(confirmation.executionEvidence).toBe("original_execution");
    await expect(mockups.confirmInspection(context, inspection.id, "0".repeat(64))).rejects.toMatchObject({ status: 409 });
    await Promise.all([mockups.confirmInspection(context, inspection.id, confirmation.reviewFingerprint),
      mockups.confirmInspection(context, inspection.id, confirmation.reviewFingerprint)]);
    const pack = await mockups.createTemplatePack(context, { name: `Synthetic pack ${createEntityId()}`, platform: "amazon", locale: "en-US", productCategory: "canvas_art",
      slots: [{ slotKey: "main", label: "Synthetic main", ordinal: 0, required: true, inspectionId: inspection.id, acceptedPrintSpecVersionIds: [item.specId] }] });
    await mockups.reviewTemplatePack(context, pack.id, { decision: "approve" });
    const batch = await mockups.createBatch(context, { name: `Synthetic render ${createEntityId()}`, templatePackVersionId: pack.id, platform: "amazon", locale: "en-US",
      items: [{ designVersionId: formal!.id, skuId }] });
    const [renderItem] = await withTenant(database.db, context, tx => tx.select().from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batch.id)));
    await new MockupRenderProcessor(database, storage, nativeRunner()).process(envelope({ itemId: renderItem!.id }));
    const [output] = await withTenant(database.db, context, tx => tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, renderItem!.id)));
    expect(output).toMatchObject({ status: "succeeded", width: 32, height: 32 });
    const [execution] = await withTenant(database.db, context, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.mockupItemId, renderItem!.id)));
    expect(execution).toMatchObject({ phase: "completed", receipt: null, budgetLedgerId: null });
    const [result] = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, output!.assetId!)));
    expect(result!.rightsMetadata.source).toMatchObject({ kind: "licensed" }); expect(result!.rightsStatus).toBe("unverified");
    const bytes = await storage.readPrivate(context, { ...result!, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 32, height: 32 });

    const view = () => mockups.getBatch(context, batch.id);
    const review = async (decision: "approve" | "reject", fingerprint?: string) => mockups.reviewBatch(context, batch.id, {
      decisions: [{ itemId: renderItem!.id, expectedFingerprint: fingerprint ?? (await view()).items[0]!.reviewFingerprint,
        decision, ...(decision === "reject" ? { rejectionReason: "Synthetic revision required" } : {}) }],
    });
    await expect(review("approve", "0".repeat(64))).rejects.toMatchObject({ status: 409 });
    await grant(Object.values(Permission).filter(permission => permission !== Permission.DesignReview));
    await expect(review("approve")).rejects.toMatchObject({ status: 403 });
    await grant();
    const swapped = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(assetFiles).values({ ...result!, id: swapped, objectKey: `authorized/synthetic-unadopted-${swapped}`, checksumSha256: "0".repeat(64) });
      await tx.update(mockupBatchOutputs).set({ assetId: swapped, checksumSha256: "0".repeat(64) }).where(eq(mockupBatchOutputs.id, output!.id));
    });
    await expect(review("approve")).rejects.toMatchObject({ code: "MOCKUP_ORIGINAL_COMPLETION_REQUIRED", status: 409 });
    expect((await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, swapped))))[0]!.rightsStatus).toBe("unverified");
    await withTenant(database.db, context, tx => tx.update(mockupBatchOutputs).set({ assetId: result!.id, checksumSha256: result!.checksumSha256 }).where(eq(mockupBatchOutputs.id, output!.id)));

    const [originalSource] = await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, assetId)));
    await withTenant(database.db, context, tx => tx.update(assetFiles).set({ rightsMetadata: { ...originalSource!.rightsMetadata,
      source: { ...(originalSource!.rightsMetadata.source as object), licenseExpiresAt: "2000-01-01T00:00:00Z" } } }).where(eq(assetFiles.id, assetId)));
    await expect(review("approve")).rejects.toMatchObject({ status: 409 });
    expect((await mockups.capabilities(context)).mockupBatches.enabled).toBe(false);
    expect((await view()).templatePack.id).toBe(pack.id);
    await withTenant(database.db, context, tx => tx.update(assetFiles).set({ rightsMetadata: originalSource!.rightsMetadata }).where(eq(assetFiles.id, assetId)));
    const auditFailure = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic atomic audit failure"));
    await expect(review("approve")).rejects.toThrow("Synthetic atomic audit failure"); auditFailure.mockRestore();
    expect((await withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, result!.id))))[0]!.rightsStatus).toBe("unverified");
    expect((await view()).items[0]!.outputs[0]!.status).toBe("succeeded");

    const stale = (await view()).items[0]!.reviewFingerprint;
    await review("reject", stale);
    const retries = await Promise.allSettled([mockups.retryOutput(context, batch.id, output!.id), mockups.retryOutput(context, batch.id, output!.id)]);
    expect(retries.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(retries.filter(row => row.status === "rejected")).toHaveLength(1);
    const attempts = await withTenant(database.db, context, tx => tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, renderItem!.id)));
    expect(attempts.map(row => row.attempt).sort()).toEqual([1, 2]);
    await expect(review("approve", stale)).rejects.toMatchObject({ status: 409 });
    await new MockupRenderProcessor(database, storage, nativeRunner()).process(envelope({ itemId: renderItem!.id }));
    const fresh = (await view()).items[0]!.reviewFingerprint;
    const approvals = await Promise.allSettled([review("approve", fresh), review("approve", fresh)]);
    expect(approvals.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(approvals.filter(row => row.status === "rejected")).toHaveLength(1);
    const approved = (await view()).items[0]!;
    expect(approved.status).toBe("completed"); expect(approved.outputs[0]!.attempt).toBe(2);

    const other = createEntityId(), otherRole = createEntityId(), wideRole = createEntityId(), membership = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic scoped reviewer')",
      [other, `synthetic-mockup-${other}`, `${other}@example.test`]);
    const otherIdentity = { ...context, userId: other };
    await withTenant(database.db, context, async tx => {
      await tx.insert(memberships).values({ id: membership, tenantId: context.tenantId, userId: other, status: "active" });
      await tx.insert(roles).values([{ id: otherRole, tenantId: context.tenantId, name: "Synthetic narrow design", permissions: Object.values(Permission), dataScope: "self" },
        { id: wideRole, tenantId: context.tenantId, name: "Synthetic unrelated wide grant", permissions: [Permission.ProductRead, Permission.AssetRead], dataScope: "tenant" }]);
      await tx.insert(membershipRoles).values([{ tenantId: context.tenantId, membershipId: membership, roleId: otherRole },
        { tenantId: context.tenantId, membershipId: membership, roleId: wideRole }]);
      const [savedPack] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.id, pack.id));
      await tx.insert(mockupTemplatePackVersions).values({ ...savedPack!, id: createEntityId(), versionNumber: 2, createdBy: other });
    });
    const narrow = await withTenant(database.db, otherIdentity, tx => loadCurrentMembershipContext(tx, otherIdentity));
    expect(await mockups.listBatches(narrow)).toEqual([]);
    expect((await mockups.listTemplatePacks(narrow)).items).toEqual([]);
    expect(await mockups.listInspections(narrow)).toEqual([]);
    await expect(mockups.getBatch(narrow, batch.id)).rejects.toMatchObject({ status: 403 });
    await expect(mockups.cancelBatch(narrow, batch.id)).rejects.toMatchObject({ status: 403 });
    await expect(mockups.createInspection(narrow, { sourceAssetId: assetId, sourceAssetVersion: 1, checksumSha256: file.checksumSha256, slotKey: "main" })).rejects.toMatchObject({ status: 403 });
    const narrowOptions = await mockups.batchOptions(narrow);
    expect(narrowOptions.templatePacks).toEqual([]); expect(narrowOptions.inspections).toEqual([]); expect(narrowOptions.formalDesigns).toEqual([]);
    await withTenant(database.db, context, tx => tx.update(roles).set({ dataScope: "tenant" }).where(eq(roles.id, otherRole)));
    const wide = await withTenant(database.db, otherIdentity, tx => loadCurrentMembershipContext(tx, otherIdentity));
    const siblingInput = { name: "Synthetic collaborator render", templatePackVersionId: pack.id, platform: "amazon" as const, locale: "en-US",
      items: [{ designVersionId: formal!.id, skuId }] };
    const sibling = await mockups.createBatch(wide, siblingInput);
    expect(sibling.id).not.toBe(batch.id);
    expect((await mockups.createBatch(wide, siblingInput)).id).toBe(sibling.id);
    await mockups.cancelBatch(wide, sibling.id);
    const siblingOutput = sibling.items[0]!.outputs[0]!;
    await expect(mockups.retryOutput(wide, sibling.id, siblingOutput.id)).rejects.toMatchObject({ status: 409 });
    const collaboratorPack = await mockups.createTemplatePack(wide, { packId: pack.packId, name: "Synthetic collaborator template version",
      platform: "amazon", locale: "en-US", productCategory: "canvas_art", slots: pack.slots.map(slot => ({ slotKey: slot.slotKey,
        label: slot.label, ordinal: slot.ordinal, required: slot.required, inspectionId: slot.inspectionId, acceptedPrintSpecVersionIds: slot.acceptedPrintSpecVersionIds })) });
    await withTenant(database.db, context, tx => tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, otherRole)));
    await expect(mockups.getTemplatePack(wide, collaboratorPack.id)).rejects.toMatchObject({ status: 403 });

    const listingId = createEntityId(), listingVersionId = createEntityId();
    await withTenant(database.db, context, async tx => {
      const [sku] = await tx.select().from(skus).where(eq(skus.id, skuId));
      await tx.insert(listings).values({ id: listingId, tenantId: context.tenantId, spuId: sku!.spuId, platform: "amazon", locale: "en-US", status: "draft", createdBy: context.userId });
      await tx.insert(listingVersions).values({ id: listingVersionId, tenantId: context.tenantId, listingId, versionNumber: 1, ruleVersion: "synthetic-local-rule",
        status: "draft", source: "human", createdBy: context.userId, content: { platform: "amazon", locale: "en-US", title: "Synthetic native mockup Listing", description: "Synthetic review fixture",
          bullets: [], tags: [], mediaAssetIds: [], variants: [{ skuId, skuCode: "SYNTHETIC", optionValues: {} }], attributes: {}, compliance: {} }, validation: { completeness: 80, blockers: [], warnings: [] } });
    });
    const governance = new PodGovernanceService(database, audit);
    await expect(governance.createListingArtifactBinding(context, { listingVersionId, assetId: approved.outputs[0]!.assetId!,
      assetVersion: approved.outputs[0]!.assetVersion!, contentKind: "image", slotKey: "gallery.1" })).rejects.toThrow(/整款审核与槽位映射/);
    await withTenant(database.db, context, tx => tx.update(listings).set({ createdBy: other }).where(eq(listings.id, listingId)));
    await expect(governance.createApprovedMockupListingBindings(context, { batchId: batch.id, itemId: approved.id, listingVersionId,
      slots: [{ outputId: approved.outputs[0]!.id, slotKey: "gallery.1" }] })).rejects.toMatchObject({ status: 404 });
    await withTenant(database.db, context, tx => tx.update(listings).set({ createdBy: context.userId }).where(eq(listings.id, listingId)));
    await expect(governance.createApprovedMockupListingBindings(context, { batchId: batch.id, itemId: approved.id, listingVersionId,
      slots: [{ outputId: approved.outputs[0]!.id, slotKey: "gallery.1" }] })).resolves.toHaveLength(1);
  }, 60000);
});
