import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SecretVault, openBenchmarkValue, readAssistResearchImageBytes, type AssistContext } from "../../packages/ai-core/src/index.js";
import { runRoleBenchmarkBaseline } from "../../packages/ai-core/src/role-benchmark.js";
import { CaptureDraftSchema, CreateRightsAssessmentInputSchema, CreateCanvasPrintSpecVersionInputSchema, ReviewVersionInputSchema,
  CreateMockupTemplateInspectionInputSchema, CreateMockupTemplatePackVersionInputSchema, CreateMockupBatchInputSchema,
  ReviewMockupBatchInputSchema, CreateMockupListingBindingsInputSchema, CreateTemplateSourceInspectionInputSchema,
  CreateProductionEditorProjectInputSchema, SaveProductionEditorVersionInputSchema, CreateProductionEditorRenderInputSchema,
  PrintProfileInputSchema, SaveOrderWorkDraftInputSchema, OrderWorkActionInputSchema,
  CreateAfterSalesCaseInputSchema, RecordCustomerContactInputSchema, AddResponsibilityEvidenceInputSchema, createEntityId } from "../../packages/contracts/src/index.js";
import { CreateProductSpuSchema, RegisterArtworkSchema, SaveProductSpecificationSchema, CreateProductCombinationSchema,
  SalesRecipeActionSchema, CreateSalesListingSchema } from "../../packages/contracts/src/catalog/development.js";
import { LegacyAssistResultSchema, type AssistResult } from "../../packages/contracts/src/ai/assist.js";
import { BenchmarkDatasetFieldsSchema, BusinessBenchmarkCaseSchema, SaveBenchmarkDatasetSchema, PublishBenchmarkDatasetSchema, CreateBenchmarkExperimentSchema, ROLE_BENCHMARK_RULE_VERSION,
  type BenchmarkItem, type BenchmarkVersion } from "../../packages/contracts/src/knowledge/benchmark.js";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { CANVAS_BRIDGE, CreateCanvasBriefInputSchema, SubmitCanvasResultInputSchema } from "../../packages/contracts/src/pod/canvas-bridge.js";
import type { ProductionEditorDocument } from "../../packages/contracts/src/pod/production-editor.js";
import { marketplaceAccounts, withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import { ClamAvScanner, Storage } from "../../packages/storage/src/index.js";
import { createDefaultProductionDocument, productionExportDefaults } from "../../packages/production-editor/src/products.js";
import { JobEnvelopeSchema } from "../../packages/jobs/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import type * as S3Sdk from "../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import type * as Psd from "../../packages/mockup-renderer/node_modules/ag-psd/dist/index.js";
import type Sharp from "../../apps/api/node_modules/sharp/lib/index.js";
import { AuditService } from "../../apps/api/src/audit/audit.service.js";
import { AssetsController } from "../../apps/api/src/assets/assets.controller.js";
import { CaptureService } from "../../apps/api/src/capture/capture.service.js";
import { ResearchClassificationService } from "../../apps/api/src/research/research-classification.service.js";
import { OrderService } from "../../apps/api/src/orders/order.service.js";
import { AmazonOrderReportService } from "../../apps/api/src/orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../../apps/api/src/orders/order-workspace.service.js";
import { OrderAfterSalesService } from "../../apps/api/src/orders/order-after-sales.service.js";
import { FinanceService } from "../../apps/api/src/finance/finance.service.js";
import { InventoryService } from "../../apps/api/src/inventory/inventory.service.js";
import { ProcurementService } from "../../apps/api/src/procurement/procurement.service.js";
import { ProductionEditorService } from "../../apps/api/src/design/production-editor.service.js";
import { DesignService, DrizzleDesignRepository } from "../../apps/api/src/design/design.service.js";
import { PodBatchWorkflowService, type PodBatchWorkflowEnqueuer } from "../../apps/api/src/design/pod-batch-workflow.service.js";
import { PodGovernanceService } from "../../apps/api/src/design/pod-governance.service.js";
import { PodPersonalizationService } from "../../apps/api/src/design/pod-personalization.service.js";
import { PodMockupBatchService } from "../../apps/api/src/design/pod-mockup-batch.service.js";
import { CanvasBridgeService } from "../../apps/api/src/design/canvas-bridge.service.js";
import { SalesAdaptationService } from "../../apps/api/src/design/sales-adaptation.service.js";
import { ProductDevelopmentService } from "../../apps/api/src/catalog/product-development.service.js";
import { SalesRecipeService } from "../../apps/api/src/catalog/sales-recipe.service.js";
import { SalesPackageService } from "../../apps/api/src/catalog/sales-package.service.js";
import { SalesPlanService } from "../../apps/api/src/catalog/sales-plan.service.js";
import { SalesPlanLaunchService } from "../../apps/api/src/catalog/sales-plan-launch.service.js";
import { ListingService, DrizzleListingRepository } from "../../apps/api/src/listings/listing.service.js";
import { AssistCatalogContextService } from "../../apps/api/src/ai/assist-catalog-context.service.js";
import { AssistBusinessContextService } from "../../apps/api/src/ai/assist-business-context.service.js";
import { AssistContextService } from "../../apps/api/src/ai/assist-context.service.js";
import { AssistService, type AssistEnqueuer } from "../../apps/api/src/ai/assist.service.js";
import { AssistTaskWorkspaceService } from "../../apps/api/src/ai/assist-task-workspace.service.js";
import { KnowledgeEvaluationService } from "../../apps/api/src/knowledge/knowledge-evaluation.service.js";
import { KnowledgeService } from "../../apps/api/src/knowledge/knowledge.service.js";
import { KnowledgeBenchmarkBusinessService } from "../../apps/api/src/knowledge/knowledge-benchmark-business.service.js";
import { KnowledgeBenchmarkDatasetService } from "../../apps/api/src/knowledge/knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "../../apps/api/src/knowledge/knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "../../apps/api/src/knowledge/knowledge-benchmark-cost.service.js";
import { CaptureMediaProcessor } from "../../apps/worker/src/processors/capture-media.processor.js";
import { CaptureMediaDownloader } from "../../apps/worker/src/processors/capture-media.download.js";
import { DrizzleTemplateSourceInspectionRepository, PersonalizationTemplateSourceInspectionProcessor } from "../../apps/worker/src/processors/personalization-template-source-inspection.processor.js";
import { ProductionEditorRenderProcessor } from "../../apps/worker/src/processors/production-editor.processor.js";
import { MockupTemplateCompileProcessor, MockupRenderProcessor } from "../../apps/worker/src/processors/pod-batch-workflow.processor.js";
import { knowledgeEvaluationFixture } from "./knowledge-evaluation-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "./specification-fixtures.js";

const { sql } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as typeof Drizzle;
const { S3Client } = createRequire(new URL("../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
const sharp = createRequire(new URL("../../apps/api/package.json", import.meta.url))("sharp") as typeof Sharp;
const { writePsdUint8Array } = createRequire(new URL("../../packages/mockup-renderer/package.json", import.meta.url))("ag-psd") as typeof Psd;
export const roleBenchmarkSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const remainingBenchmarkRoles = ["creative", "order_review", "artwork_preflight", "template_config", "sku_package", "after_sales_review"] as const;
export type RemainingBenchmarkRole = typeof remainingBenchmarkRoles[number];
export type RoleSource = { role: RemainingBenchmarkRole; targetId: string; complete: boolean; ids: Record<string, string>; notes: string };
export function requireRoleBenchmarkEnvironment(target: "current" | "pre-0170", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || environment.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
      environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== target || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Role benchmark requires all opt-in flags, exact isolated schema, nonce database and private bucket before connection");
  return { url, nonce, workspace: fileURLToPath(new URL("../../", import.meta.url)) };
}
export function roleBenchmarkGate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
export function roleEnvelope(context: TenantContext, payload: Record<string, unknown>) {
  return JobEnvelopeSchema.parse({ jobId: createEntityId(), correlationId: createEntityId(), idempotencyKey: createEntityId(),
    tenantId: context.tenantId, requestedBy: context.userId, payload });
}
/** The exact owning schema controls both excess-property typing and runtime
 * refinements even when an owner's public method accepts unknown input. */
function checkedRoleInput<Input, Output>(schema: { readonly _input: Input; parse(value: unknown): Output }, raw: NoInfer<Input>): Output {
  return schema.parse(raw);
}

/** All source admissions use their public owners. Only public research HTTP
 * transport and paid model HTTP are synthetic. Uploaded bytes are real, scanned
 * and stored privately. No production order, factory release or buyer approval is
 * constructed. Rectangular print source geometry is explicitly synthetic; it is
 * not evidence of real shaped-pillow visual or manufacturing acceptance. */
export function roleBenchmarkOwners(database: DatabaseConnection, vault: SecretVault, options: { assistVault?: SecretVault } = {}) {
  requireRoleBenchmarkEnvironment("current");
  const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const storage = new Storage(client, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner(), audit = new AuditService(database);
  const scanner = { scan: (bytes: Uint8Array, fileName: string, mediaType: string) => clam.scan({ body: bytes, fileName, mediaType }) };
  const orders = new OrderService(database, vault, audit), assets = new AssetsController(storage, database, audit);
  const reports = new AmazonOrderReportService(database, vault, orders, audit,
    { download: async () => { throw new Error("Synthetic role source has no remote private report download"); },
      scan: bytes => clam.scan({ body: bytes, fileName: "synthetic-role-report.zip", mediaType: "application/zip" }) },
    { schedule: async () => {} }, { schedule: async () => {} });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit, { enqueue: async () => {} }, scanner, options.assistVault);
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, scanner);
  const queue: PodBatchWorkflowEnqueuer = { enqueueCreativeCandidate: async () => { throw new Error("Synthetic source never generates artwork using a model"); },
    enqueueCreativeAdaptation: async () => { throw new Error("Synthetic source never generates artwork using a model"); }, enqueueTemplateCompile: async () => {}, enqueueMockupRender: async () => {} };
  const designs = new DesignService(new DrizzleDesignRepository(database, storage)), governance = new PodGovernanceService(database, audit);
  const workflows = new PodBatchWorkflowService(database, queue, audit, designs), canvas = new CanvasBridgeService(database, storage, audit, workflows, scanner);
  const templates = new PodPersonalizationService(database, { enqueue: async () => {} }, audit);
  const inspector = new PersonalizationTemplateSourceInspectionProcessor(new DrizzleTemplateSourceInspectionRepository(database, storage));
  const mockups = new PodMockupBatchService(database, queue, audit, governance), development = new ProductDevelopmentService(database, storage);
  const recipes = new SalesRecipeService(database, new SalesAdaptationService(database, storage, editor));
  const listing = new ListingService(new DrizzleListingRepository(database)), packages = new SalesPackageService(database, listing, storage), salesPlans = new SalesPlanService(database, listing);
  const finance = new FinanceService(database, audit), inventory = new InventoryService(database, audit), procurement = new ProcurementService(database, inventory, audit);
  const afterSales = new OrderAfterSalesService(database, vault, audit), business = new AssistBusinessContextService(finance, procurement, afterSales, work);
  const publicMedia = new Map<string, Uint8Array>(), mediaJobs: Parameters<ConstructorParameters<typeof CaptureService>[1]["enqueue"]>[0][] = [];
  const captures = new CaptureService(database, { enqueue: async job => { mediaJobs.push(job); } }, audit, new ResearchClassificationService(database, audit), storage);
  const downloader = new CaptureMediaDownloader({ resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    read: async url => { const body = publicMedia.get(url.href); if (!body) throw new Error("Unregistered synthetic public media"); return { body, mediaType: "image/png", status: 200 }; } });
  const captureWorker = new CaptureMediaProcessor(database, storage, clam, downloader), renderWorker = new ProductionEditorRenderProcessor(database, storage, vault);
  const catalog = new AssistCatalogContextService(templates, packages, new KnowledgeService(database, audit));
  const ownershipTables = ["orders", "order_lines", "order_work_items", "order_work_revisions", "order_work_events", "order_work_assets",
    "after_sales_cases", "customer_contact_records", "after_sales_decisions", "after_sales_responsibility_evidence", "return_shipments", "replacement_order_links",
    "production_editor_projects", "production_editor_versions", "production_editor_renders", "print_profile_versions", "artwork_masters", "artwork_master_versions",
    "sales_recipe_versions", "sales_sku_definitions", "sales_plans", "listings", "listing_versions", "personalization_template_versions", "personalization_template_source_inspections",
    "mockup_template_source_inspections", "mockup_template_pack_versions", "mockup_batch_items", "mockup_batch_outputs", "production_orders", "production_milestone_events"];
  async function state(context: TenantContext) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ownershipTables) result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  const image = async (density = 150) => sharp({ create: { width: 1024, height: 1024, channels: 4, background: "#2879be" } }).png().withMetadata({ density }).toBuffer();
  async function ownedAsset(context: TenantContext, body: Uint8Array, name: string, mediaType: string) {
    const scanned = await clam.scan({ body, fileName: name, mediaType });
    if (scanned.result !== "clean" || !scanned.signatureVersion || ["unavailable", "unknown"].includes(scanned.signatureVersion)) throw new Error("Synthetic role source scan did not establish clean bytes");
    const asset = await assets.upload({ headers: {}, tenantContext: context }, { dataBase64: Buffer.from(body).toString("base64"), domain: "authorized", fileName: name, mediaType });
    await governance.createRightsAssessment(context, checkedRoleInput(CreateRightsAssessmentInputSchema, { assetId: asset.id, assetVersion: asset.version, rightsSource: { kind: "owned", reference: "Synthetic original fixture pixels; no competitor or customer file" },
      scopeSnapshot: { syntheticOnly: true }, status: "approved", legalRisk: "low", evidence: [{ kind: "internal", reference: "Synthetic original controlled fixture", checkedAt: new Date().toISOString() }],
      decisionReason: "Known synthetic source created solely for the disposable acceptance fixture" }));
    return asset;
  }
  function rectangularDocument(): ProductionEditorDocument {
    const document = createDefaultProductionDocument("rectangular_print");
    if (document.productType !== "rectangular_print") throw new Error("Synthetic rectangular fixture expected");
    document.name = "Synthetic actual 150 DPI rectangular source"; document.spec = { ...document.spec, widthMm: 60, heightMm: 40, dpi: 150, safeInsetMm: 2 };
    return document;
  }
  let profile: Awaited<ReturnType<typeof work.saveProfile>>[number] | undefined;
  async function processProfile(context: TenantContext) {
    if (profile) return profile;
    const document = rectangularDocument(); let template = await editor.create(context, checkedRoleInput(CreateProductionEditorProjectInputSchema, { name: document.name, document }));
    const uploaded = await editor.upload(context, template.project.id, "synthetic-profile.png", await image());
    if (!("width" in uploaded)) throw new Error("Synthetic source requires an actual decoded raster");
    document.layers = [{ id: "original-image", kind: "image", name: "Original synthetic raster", assetId: uploaded.id, assetVersion: 1, xMm: 10, yMm: 8,
      widthMm: 30, heightMm: 24, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }];
    document.confirmations = { physicalSize: true, visualReview: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true };
    template = await editor.save(context, template.project.id, checkedRoleInput(SaveProductionEditorVersionInputSchema, { expectedVersionId: template.version.id, document }));
    await editor.review(context, template.project.id, template.version.id);
    const code = `ROLE-${randomUUID().slice(0, 12)}`;
    profile = (await work.saveProfile(context, checkedRoleInput(PrintProfileInputSchema, { code, name: document.name, projectId: template.project.id, versionId: template.version.id,
      instructions: "Synthetic rectangular geometry and known pixels only; no production release", expectedVersion: 0, idempotencyKey: randomUUID() }))).find(row => row.code === code);
    if (!profile) throw new Error("Actual process profile was not returned"); return profile;
  }
  async function privateOrder(context: TenantContext, complete: boolean, artwork = false): Promise<RoleSource> {
    const accountId = createEntityId(), externalOrderId = `ROLE-${randomUUID()}`, externalLineId = `LINE-${randomUUID()}`;
    await withTenant(database.db, context, tx => tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "etsy",
      displayName: `Synthetic role private account ${accountId}`, region: "GLOBAL", authorizationMode: "etsy_oauth", status: "pending_authorization", createdBy: context.userId }));
    const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId, providerStatus: "paid", placedAt: new Date().toISOString(),
      orderTotal: { amountMinor: 2000, currency: "USD" }, lines: [{ externalLineId, externalListingId: null, customizationCount: 0, title: "Synthetic private role item", skuCode: "SYNTHETIC-ROLE", quantity: 1, unitPrice: { amountMinor: 2000, currency: "USD" } }],
      redactedSource: { synthetic: true }, protectedDetails: { buyer: { name: "PRIVATE-ROLE-BUYER", email: "private-role@example.invalid", phone: null },
        shippingAddress: { recipient: null, lines: [], city: null, region: null, postalCode: null, countryCode: "US" }, customizations: [] } });
    const line = order.lines[0]!, original = await work.detail(context, line.id), fixedProfile = await processProfile(context);
    let detail = await work.save(context, line.id, checkedRoleInput(SaveOrderWorkDraftInputSchema, { expectedRevision: original.line.revision, expectedProjectionVersion: original.line.projectionVersion,
      expectedSourceVersionId: original.report?.versionId ?? null, draft: { ...original.draft, designExecutor: "human", printProfileVersionId: fixedProfile.versionId,
        fields: [], images: [], instructions: complete ? "Original synthetic fixed graphic; no customer text or photo" : "缺少实际顾客图片与原文 不能确认最终制作内容" },
      status: artwork ? "ready_to_push" : "pending_review", reason: "Synthetic original private requirement admitted by the real order workspace owner", idempotencyKey: randomUUID() }));
    if (artwork) {
      for (const action of ["push", "start_artwork"] as const) detail = await work.action(context, line.id, checkedRoleInput(OrderWorkActionInputSchema, { action,
        expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, reason: "Synthetic human draft; no artwork approval or production release", idempotencyKey: randomUUID() }));
      const current = await editor.get(context, detail.line.editorProjectId!);
      if (!complete) {
        const document = structuredClone(current.version.document); document.confirmations.visualReview = false; document.confirmations.physicalSize = false;
        await editor.save(context, current.project.id, checkedRoleInput(SaveProductionEditorVersionInputSchema, { expectedVersionId: current.version.id, document }));
      }
    }
    return { role: artwork ? "artwork_preflight" : "order_review", targetId: line.id, complete,
      ids: { orderId: order.id, orderLineId: line.id, accountId, ...(detail.line.editorProjectId ? { editorProjectId: detail.line.editorProjectId } : {}) },
      notes: "Actual private requirement and optional human editor draft only; no approval, accepted factory task, or production fact" };
  }
  async function creativeSource(context: TenantContext, complete: boolean): Promise<RoleSource> {
    const token = String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)), sourceUrl = `https://i.etsystatic.com/synthetic-role-${randomUUID()}.png`;
    publicMedia.set(sourceUrl, await image());
    const captured = await captures.createSnapshot(context, checkedRoleInput(CaptureDraftSchema, { platform: "etsy", parserVersion: "synthetic-role-v1", extensionVersion: "0.0.0", marketplace: "www.etsy.com",
      sourceUrl: `https://www.etsy.com/listing/${token}/synthetic`, externalId: token, title: "Synthetic geometric gift research", domain: "research", capturedAt: new Date().toISOString(),
      price: null, rating: null, reviewCount: null, taxonomy: [], listingPublishedAt: null, favoriteCount: null, shipping: null, shop: null, reviewSummary: null, reviews: [],
      reviewCollection: { collectedCount: 0, reportedTotal: null, pageCount: 0, status: "visible", updatedAt: new Date().toISOString() }, bullets: [], variants: [],
      contentBlocks: complete ? [{ kind: "personalization", text: "Synthetic geometric fixed print; no competitor artwork is licensed", sourceSelector: "#synthetic" }] : [],
      missingFields: complete ? [] : ["material", "personalization"], diagnostics: [], captureStatus: complete ? "complete" : "partial",
      media: complete ? [{ id: "original", kind: "image", sourceUrl, included: true }] : [] }));
    for (const job of mediaJobs.filter(row => row.snapshotId === captured.snapshotId)) {
      const result = await captureWorker.process(roleEnvelope(context, { mediaId: job.mediaId, snapshotId: job.snapshotId }));
      if (result.state !== "archived") throw new Error("Actual synthetic research archive did not complete");
    }
    const project = await canvas.create(context, checkedRoleInput(CreateCanvasBriefInputSchema, { requestId: randomUUID(), name: `Synthetic fixed creative ${randomUUID()}`, prompt: complete ? "Original geometric gift directions" : "未知材质与定制能力 不得补造",
      referenceAssetIds: [], requirements: { mode: "fixed", audience: complete ? "Synthetic gift audience" : "", acceptance: "Original directions only; no approval", researchItemIds: [captured.researchItemId] },
      researchSources: [{ researchItemId: captured.researchItemId, snapshotId: captured.snapshotId, studyRevisionId: null }] }));
    return { role: "creative", targetId: project.id, complete, ids: { projectId: project.id, ...captured }, notes: "Actual archived research is evidence only, never an authorized production asset" };
  }
  async function templateSource(context: TenantContext, complete: boolean): Promise<RoleSource> {
    let body: Uint8Array, mediaType: string, source: "psd" | "png";
    if (complete) {
      const rgba = { width: 128, height: 128, data: new Uint8ClampedArray(128 * 128 * 4).fill(255) };
      body = writePsdUint8Array({ width: 128, height: 128, imageData: rgba, imageResources: { resolutionInfo: { horizontalResolution: 300, horizontalResolutionUnit: "PPI", widthUnit: "Inches",
        verticalResolution: 300, verticalResolutionUnit: "PPI", heightUnit: "Inches" } }, children: [{ name: "image", children: [{ name: "Synthetic original photo slot", left: 0, top: 0, imageData: rgba }] }] }, { generateThumbnail: false });
      source = "psd"; mediaType = "image/vnd.adobe.photoshop";
    } else { body = await sharp({ create: { width: 128, height: 128, channels: 4, background: "#2879be" } }).png().toBuffer(); source = "png"; mediaType = "image/png"; }
    const asset = await ownedAsset(context, body, `synthetic-role-template-${randomUUID()}.${source}`, mediaType);
    const inspection = await templates.createTemplateSourceInspection(context, checkedRoleInput(CreateTemplateSourceInspectionInputSchema, { sourceAssetId: asset.id, sourceAssetVersion: asset.version, idempotencyKey: createEntityId() }));
    await inspector.process(roleEnvelope(context, { inspectionId: inspection.id }));
    const basis = await templates.templateAnalysisBasis(context, inspection.id);
    if (basis.status !== "completed" || !basis.canvas || !basis.slots.length) throw new Error("Actual template parser did not return its original structure");
    if (!complete && !basis.warnings.length) throw new Error("Synthetic incomplete PNG must preserve actual parsing warnings");
    return { role: "template_config", targetId: inspection.id, complete, ids: { inspectionId: inspection.id, assetId: asset.id }, notes: "Real source parser; no template confirmation or template approval performed" };
  }
  let skuSource: { recipeId: string; skuId: string; designVersionId: string; listingId: string; mockupAssetId: string; inspectionId: string } | undefined;
  async function freshMockupExecutionDue(context: TenantContext, itemId: string) {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const rows = await withTenant(database.db, context, tx => tx.execute<{ phase: string; attempts: number; unleased: boolean; due: boolean }>(sql`select
        phase,attempt_count as attempts,lease_token is null as unleased,next_attempt_at<=clock_timestamp()-interval '25 milliseconds' as due
        from creative_executions where mockup_item_id=${itemId}::uuid and requested_by=${context.userId}::uuid order by step_key`));
      if (rows.length !== 1 || rows.some(row => row.phase !== "pending" || row.attempts !== 0 || !row.unleased))
        throw new Error(`Synthetic fresh mockup execution changed before first delivery: ${JSON.stringify(rows)}`);
      if (rows.every(row => row.due)) return;
      if (performance.now() >= deadline) throw new Error("Synthetic fresh mockup execution did not become due by the database clock");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  async function salesSource(context: TenantContext, complete: boolean): Promise<RoleSource> {
    if (!skuSource) {
      const suffix = randomUUID().slice(0, 12), fixedProfile = await processProfile(context), bytes = await image();
      const scanned = await clam.scan({ body: bytes, fileName: "synthetic-role-owned-master.png", mediaType: "image/png" });
      if (scanned.result !== "clean" || !scanned.signatureVersion || ["unavailable", "unknown"].includes(scanned.signatureVersion)) throw new Error("Actual source scan must succeed before canvas submission");
      const brief = await canvas.create(context, checkedRoleInput(CreateCanvasBriefInputSchema, { requestId: randomUUID(), name: `Synthetic owned master ${suffix}`, prompt: "Known original geometric fixture pixels", referenceAssetIds: [] }));
      const submitted = await canvas.submit(context, brief.id, checkedRoleInput(SubmitCanvasResultInputSchema, { submissionId: randomUUID(), protocolVersion: CANVAS_BRIDGE.protocolVersion, pluginVersion: CANVAS_BRIDGE.pluginVersion,
        upstreamVersion: CANVAS_BRIDGE.upstreamVersion, sourceNodeId: randomUUID(), title: "Synthetic known original master", contentBase64: bytes.toString("base64"),
        rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic source created solely for this disposable fixture" }));
      await workflows.reviewCreativeVersion(context, submitted.versionId, checkedRoleInput(ReviewVersionInputSchema, { decision: "approve" }));
      const { artwork } = await development.registerArtwork(context, checkedRoleInput(RegisterArtworkSchema, { code: `ART-${suffix}`, name: "Synthetic fixed original artwork", mode: "fixed", creativeVersionId: submitted.versionId,
        expectedVersion: 0, idempotencyKey: randomUUID() }));
      const { spu } = await development.createSpu(context, checkedRoleInput(CreateProductSpuSchema, { code: `SPU-${suffix}`, name: "Synthetic rectangular print", idempotencyKey: randomUUID() }));
      const printSpec = await workflows.createPrintSpec(context, checkedRoleInput(CreateCanvasPrintSpecVersionInputSchema, { name: `Synthetic mockup ${suffix}`, aspectWidth: 3, aspectHeight: 2, targetDpi: 150, bleedMm: 0, safeZoneMm: 1,
        wrapMode: "none", physicalSizes: [{ key: "synthetic", label: "Synthetic preview only", widthMm: 60, heightMm: 40 }] }));
      await workflows.reviewPrintSpec(context, printSpec.id, checkedRoleInput(ReviewVersionInputSchema, { decision: "approve" }));
      const { specification } = await development.saveSpecification(context, checkedRoleInput(SaveProductSpecificationSchema, { spuId: spu.id, code: "ORIGINAL", name: "Known synthetic 60 by 40 mm panel", attributes: { size: "60x40mm" },
        facts: syntheticSpecificationFacts({ material: "Synthetic test fabric", dimensions: "60 by 40 mm", packageContents: "One synthetic item", packageQuantity: 1, factsConfirmed: true }),
        processProfileVersionId: fixedProfile.versionId, canvasPrintSpecVersionId: printSpec.id, expectedVersion: 0, idempotencyKey: randomUUID() }));
      const combined = await development.combine(context, checkedRoleInput(CreateProductCombinationSchema, { artworkVersionId: artwork.versionId, items: [{ specificationVersionId: specification.versionId, skuCode: `SKU-${suffix}` }], idempotencyKey: randomUUID() }));
      const { recipe } = await recipes.action(context, combined.recipes[0]!.id, checkedRoleInput(SalesRecipeActionSchema, { action: "start_adaptation", reason: "Synthetic original small rectangular layout", idempotencyKey: randomUUID() }));
      let project = await editor.get(context, recipe.editorProjectId!); const doc = structuredClone(project.version.document); doc.confirmations.visualReview = true;
      project = await editor.save(context, project.project.id, checkedRoleInput(SaveProductionEditorVersionInputSchema, { expectedVersionId: project.version.id, document: doc })); await editor.review(context, project.project.id, project.version.id);
      const render = await editor.render(context, project.project.id, checkedRoleInput(CreateProductionEditorRenderInputSchema, { expectedVersionId: project.version.id, purpose: "production", ...productionExportDefaults(project.version.document) }));
      await renderWorker.process(roleEnvelope(context, { renderId: render.id }));
      const approved = (await recipes.action(context, recipe.id, checkedRoleInput(SalesRecipeActionSchema, { action: "approve_adaptation", expectedEditorVersionId: project.version.id, renderId: render.id,
        reason: "Known fixture geometry and actual rendered bytes checked; no buyer order released", idempotencyKey: randomUUID() }))).recipe;
      const psd = await readFile(new URL("../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
      const asset = await ownedAsset(context, psd, `synthetic-controlled-${suffix}.psd`, "image/vnd.adobe.photoshop");
      const inspection = await mockups.createInspection(context, checkedRoleInput(CreateMockupTemplateInspectionInputSchema, { sourceAssetId: asset.id, sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256, slotKey: "main" }));
      await new MockupTemplateCompileProcessor(database, storage).process(roleEnvelope(context, { inspectionId: inspection.id }));
      const compiled = await mockups.getInspection(context, inspection.id); await mockups.confirmInspection(context, inspection.id, compiled.reviewFingerprint);
      const pack = await mockups.createTemplatePack(context, checkedRoleInput(CreateMockupTemplatePackVersionInputSchema, { name: `Synthetic actual controlled pack ${suffix}`, platform: "amazon", locale: "en-US", productCategory: "canvas_art",
        slots: [{ slotKey: "main", label: "Original synthetic main", ordinal: 0, required: true, inspectionId: inspection.id, acceptedPrintSpecVersionIds: [printSpec.id] }] }));
      await mockups.reviewTemplatePack(context, pack.id, checkedRoleInput(ReviewVersionInputSchema, { decision: "approve" }));
      const batch = await mockups.createBatch(context, checkedRoleInput(CreateMockupBatchInputSchema, { name: `Synthetic actual mockup ${suffix}`, templatePackVersionId: pack.id, platform: "amazon", locale: "en-US",
        items: [{ designVersionId: approved.designVersionId!, skuId: approved.skuId }] }));
      const itemId = batch.items[0]!.id;
      await freshMockupExecutionDue(context, itemId);
      const processed = await new MockupRenderProcessor(database, storage).process(roleEnvelope(context, { itemId }));
      const actual = await mockups.getBatch(context, batch.id);
      const executions = await withTenant(database.db, context, tx => tx.execute<{ phase: string; attempts: number; code: string | null; due: boolean }>(sql`select
        phase,attempt_count as attempts,error_code as code,next_attempt_at<=clock_timestamp() as due from creative_executions
        where mockup_item_id=${itemId}::uuid and requested_by=${context.userId}::uuid order by step_key`));
      const outputs = actual.items[0]!.outputs;
      if (processed.succeeded !== 1 || processed.deferred !== 0 || outputs.length !== 1 || outputs[0]!.status !== "succeeded" ||
        executions.length !== 1 || executions[0]!.phase !== "completed")
        throw new Error(`Synthetic original mockup did not complete: ${JSON.stringify({ processed: { succeeded: processed.succeeded, deferred: processed.deferred, disposition: processed.disposition },
          outputs: outputs.map(row => ({ status: row.status, width: row.width, height: row.height })), executions })}`);
      const [rendered] = await withTenant(database.db, context, tx => tx.execute<{ id: string; objectKey: string; checksum: string; byteSize: number }>(sql`select
        a.id,a.object_key as "objectKey",a.checksum_sha256 as checksum,a.byte_size as "byteSize" from mockup_batch_outputs o
        inner join asset_files a on a.id=o.asset_id and a.tenant_id=o.tenant_id where o.item_id=${itemId}::uuid`));
      if (!rendered || !compiled.compilation) throw new Error("Synthetic original mockup requires its actual output asset and compiled canvas");
      const renderedBytes = await storage.readPrivate(context, { id: rendered.id, tenantId: context.tenantId, assetDomain: "authorized", objectKey: rendered.objectKey },
        { requiredDomain: "authorized", maxBytes: 50 * 1024 * 1024 });
      const renderedMetadata = await sharp(renderedBytes).metadata();
      if (roleBenchmarkSha(renderedBytes) !== rendered.checksum || renderedBytes.length !== Number(rendered.byteSize) ||
        renderedMetadata.width !== compiled.compilation.canvasWidth || renderedMetadata.height !== compiled.compilation.canvasHeight)
        throw new Error("Synthetic original mockup bytes do not match their completed asset and compiled canvas");
      await mockups.reviewBatch(context, batch.id, checkedRoleInput(ReviewMockupBatchInputSchema, { decisions: [{ itemId, expectedFingerprint: actual.items[0]!.reviewFingerprint, decision: "approve" }] }));
      const draft = await packages.createListing(context, checkedRoleInput(CreateSalesListingSchema, { recipeIds: [approved.id], platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", title: "Synthetic original rectangular print", idempotencyKey: randomUUID() }));
      const originalListing = await listing.getWorkspace(context, draft.listingId), listingVersion = originalListing.version.id;
      const reviewed = await mockups.getBatch(context, batch.id);
      const approvedOutputs = reviewed.items[0]!.outputs.filter(output => output.status === "approved");
      const bound = await mockups.createListingBindings(context, batch.id, checkedRoleInput(CreateMockupListingBindingsInputSchema, { bindings: [{ itemId, listingVersionId: listingVersion,
        slots: approvedOutputs.map(output => ({ outputId: output.id, slotKey: output.slotKey })) }] }));
      const boundItem = bound.items[0];
      if (bound.items.length !== 1 || boundItem?.itemId !== itemId || boundItem.status !== "succeeded" || boundItem.bindingIds?.length !== approvedOutputs.length || !approvedOutputs.length)
        throw new Error("Actual owner rejected its approved mockup listing binding");
      const persistedBindings = await governance.listListingArtifactBindings(context, listingVersion), selectedImageIds: string[] = [];
      for (const output of approvedOutputs) {
        if (!output.assetId || !persistedBindings.items.some(binding => boundItem.bindingIds!.includes(binding.id) && binding.listingVersionId === listingVersion &&
          binding.assetId === output.assetId && binding.assetVersion === output.assetVersion && binding.slotKey === output.slotKey && binding.contentKind === "image"))
          throw new Error("Actual mockup candidate binding does not contain its approved output pins");
        selectedImageIds.push(output.assetId);
      }
      // A candidate binding never adopts its image. The synthetic operator must
      // explicitly save the actual reviewed image in a new original Listing draft.
      const selectedContent: Parameters<typeof listing.saveVersion>[2] = { ...originalListing.version.content,
        mainImageId: selectedImageIds[0]!, mediaAssetIds: selectedImageIds };
      const selectedVersion = await listing.saveVersion(context, draft.listingId, selectedContent, "human", listingVersion);
      if (selectedVersion.id === listingVersion || (await listing.getWorkspace(context, draft.listingId)).version.id !== selectedVersion.id)
        throw new Error("Actual Listing owner did not retain the explicitly selected image version");
      const basis = await packages.analysisBasis(context, draft.listingId, selectedVersion.id);
      if (basis.images.length !== selectedImageIds.length || selectedImageIds.some(id => !basis.images.some(image => image.id === id)))
        throw new Error("Actual compiled, rendered and approved mockup must be in its explicitly selected listing packet");
      skuSource = { recipeId: approved.id, skuId: approved.skuId, designVersionId: approved.designVersionId!, listingId: draft.listingId, mockupAssetId: basis.images[0]!.id, inspectionId: inspection.id };
    }
    const row = skuSource;
    const listingId = complete ? row.listingId : (await packages.createListing(context, checkedRoleInput(CreateSalesListingSchema, { recipeIds: [row.recipeId], platform: "etsy", marketplaceId: "US", locale: "en-US",
      title: "Synthetic recipe facts without approved listing images", idempotencyKey: randomUUID() }))).listingId;
    return { role: "sku_package", targetId: listingId, complete, ids: { ...row, listingId }, notes: complete
      ? "Actual source rights, recipe review, render, controlled PSD compile, mockup render and review; no production order or marketplace publish"
      : "Approved original recipe facts but no approved media binding for this distinct Etsy listing; visual limitation must remain explicit" };
  }
  async function afterSalesSource(context: TenantContext, complete: boolean): Promise<RoleSource> {
    const original = await privateOrder(context, complete), record = await afterSales.create(context, original.ids.orderId!, checkedRoleInput(CreateAfterSalesCaseInputSchema, { type: "quality_issue", reasonCode: "SYNTHETIC_EVIDENCE_CHECK",
      summary: "PRIVATE-ROLE-SUMMARY private-role@example.invalid", idempotencyKey: randomUUID() }));
    if (complete) {
      await afterSales.recordContact(context, record.case.id, checkedRoleInput(RecordCustomerContactInputSchema, { channel: "marketplace", direction: "inbound", body: "PRIVATE-ROLE-CONTACT Do not send this body to a model", externalMessageId: "PRIVATE-ROLE-MESSAGE",
        occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() }));
      await afterSales.addResponsibilityEvidence(context, record.case.id, checkedRoleInput(AddResponsibilityEvidenceInputSchema, { party: "undetermined", code: "SYNTHETIC_MEASUREMENT_REGISTERED", detail: "Known synthetic fixture measurement; does not resolve liability or execute a refund",
        assetId: null, idempotencyKey: randomUUID() }));
    }
    return { role: "after_sales_review", targetId: record.case.id, complete, ids: { ...original.ids, caseId: record.case.id },
      notes: complete ? "Synthetic registered evidence exists; responsibility remains undetermined, no message sent or refund executed" : "No evidence and no contact; original case private text must never be passed to the model" };
  }
  async function source(context: TenantContext, role: RemainingBenchmarkRole, complete = true) {
    if (role === "creative") return creativeSource(context, complete);
    if (role === "template_config") return templateSource(context, complete);
    if (role === "sku_package") return salesSource(context, complete);
    if (role === "after_sales_review") return afterSalesSource(context, complete);
    return privateOrder(context, complete, role === "artwork_preflight");
  }
  const originalEnvironment = new Map(["POD_BATCH_WORKFLOWS_ENABLED", "POD_MOCKUP_RENDERER_ENABLED"].map(key => [key, process.env[key]]));
  const registeredFetch: typeof fetch = async raw => {
    const key = raw instanceof Request ? raw.url : String(raw), bytes = publicMedia.get(key);
    if (!bytes) throw new Error("Unregistered synthetic public image");
    return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png" } });
  };
  const readResearchImage = (raw: string) => readAssistResearchImageBytes(raw, registeredFetch);
  return { storage, clam, audit, orders, assets, reports, editor, work, templates, inspector, mockups, workflows, canvas, development, recipes, packages,
    salesPlans, catalog, business, afterSales, captures, mediaJobs, state, source, ownedAsset, image, processProfile, readResearchImage,
    async initialize() { await storage.ensureBucket(); process.env.POD_BATCH_WORKFLOWS_ENABLED = "true"; process.env.POD_MOCKUP_RENDERER_ENABLED = "true"; },
    close() { client.destroy(); for (const [key, value] of originalEnvironment) if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

export function roleBenchmarkFixture(database: DatabaseConnection) {
  requireRoleBenchmarkEnvironment("current");
  const base = knowledgeEvaluationFixture(database), facts = roleBenchmarkOwners(database, base.originalVault, { assistVault: base.vault });
  const queue: AssistEnqueuer = { enqueue: async event => { base.dispatches.push(event); await base.controls.beforeQueue?.(event); if (base.controls.failQueue) throw new Error("Synthetic role queue unavailable"); } };
  const contexts = new AssistContextService(database, facts.work, facts.reports, facts.editor, facts.catalog, facts.business, base.answers, facts.salesPlans, facts.readResearchImage);
  const assists = new AssistService(database, base.vault, contexts, queue), evaluations = new KnowledgeEvaluationService(database, assists);
  const tasks = new AssistTaskWorkspaceService(database, assists, contexts, facts.work, facts.editor), adapter = new KnowledgeBenchmarkBusinessService(database, assists, tasks);
  const datasets = new KnowledgeBenchmarkDatasetService(database, evaluations, base.vault, adapter), experiments = new KnowledgeBenchmarkExperimentService(database, evaluations, base.vault, adapter);
  const costs = new KnowledgeBenchmarkCostService(database, experiments, base.vault), launch = new SalesPlanLaunchService(database, facts.salesPlans, facts.development, assists, contexts, facts.packages);
  let memo: Promise<RoleSource[]> | undefined;
  async function sourceRows() {
    memo ??= (async () => {
      const rows: RoleSource[] = [];
      // All private work is admitted before catalog artifacts are introduced;
      // later fixed tasks still read the complete actual catalog at publication.
      for (const role of ["order_review", "artwork_preflight", "after_sales_review", "creative", "template_config", "sku_package"] as const)
        for (const complete of [true, false]) rows.push(await facts.source(base.a.context, role, complete));
      return rows;
    })();
    return memo;
  }
  async function sources(roles: readonly RemainingBenchmarkRole[] = remainingBenchmarkRoles) {
    const rows = (await sourceRows()).filter(row => roles.includes(row.role)), items = [];
    for (const [index, row] of rows.entries()) {
      const basis = await adapter.basis(base.a.context, { kind: row.role, targetId: row.targetId,
        taskGoal: row.complete ? "仅核对原拥有者固定事实与限制 不审批或采用" : "缺少原资料时明确拒答 不推测未知值" });
      if (basis.input.kind === "knowledge_answer") throw new Error("Synthetic six-role source requires an actual original business task");
      if (!basis.input.expectedTaskFingerprint || basis.input.expectedTaskFingerprint !== basis.fingerprint) throw new Error("Actual source owner must return its fixed task fingerprint");
      items.push(checkedRoleInput(BusinessBenchmarkCaseSchema, { key: `${row.role}_${row.complete ? "known" : "missing"}_${index}`, role: row.role,
        label: `Synthetic ${row.role} ${row.complete ? "known source packet" : "missing evidence packet"}`, task: { ...basis.input, expectedTaskFingerprint: basis.input.expectedTaskFingerprint },
        expectedFacts: [], forbiddenClaims: ["AUTOMATICALLY APPROVED FOR PRODUCTION", "已自动发送退款", "guaranteed landed profit"], expectRefusal: !row.complete }));
    }
    return { rows, fields: checkedRoleInput(BenchmarkDatasetFieldsSchema, { name: `Synthetic six-role fixed benchmark ${randomUUID()}`,
      description: "Known synthetic assets and original owners; technical source completeness is not customer approval, factory acceptance or model business-quality acceptance", items }) };
  }
  async function dataset(roles: readonly RemainingBenchmarkRole[] = remainingBenchmarkRoles, options: { retentionDays?: number } = {}) {
    const source = await sources(roles), saveInput = checkedRoleInput(SaveBenchmarkDatasetSchema, { fields: source.fields, expectedRevision: 0, reason: "Synthetic original role fixed samples", requestId: randomUUID() });
    const saved = await datasets.save(base.a.context, null, saveInput), publishInput = checkedRoleInput(PublishBenchmarkDatasetSchema, { expectedRevision: saved.revision, retentionDays: options.retentionDays ?? 7,
      reason: "Explicit fixed role sources, original private scope and byte/version pins", requestId: randomUUID() });
    const published = await datasets.publish(base.a.context, saved.id, publishInput);
    return { ...source, saveInput, saved, publishInput, published, version: await datasets.version(base.a.context, published.id) };
  }
  async function experiment(roles: readonly RemainingBenchmarkRole[] = remainingBenchmarkRoles, options: { modelId?: string; maxAttemptsPerItem?: number; retentionDays?: number } = {}) {
    const source = await dataset(roles, options), createInput = checkedRoleInput(CreateBenchmarkExperimentSchema, { datasetVersionId: source.version.id, label: `Synthetic original six-role comparison ${randomUUID()}`,
      baselineVersion: ROLE_BENCHMARK_RULE_VERSION, modelId: options.modelId ?? base.modelId, maxAttemptsPerItem: options.maxAttemptsPerItem ?? 3,
      reason: "Free fixed rule baseline and explicitly approved candidate attempts only", requestId: randomUUID() });
    const created = await experiments.create(base.a.context, createInput);
    return { ...source, createInput, created, experiment: await experiments.get(base.a.context, created.id) };
  }
  async function originalPrepared(item: BenchmarkItem): Promise<AssistContext> {
    const [row] = await withTenant(database.db, base.a.context, tx => tx.execute<{ encrypted: string | null }>(sql`select encrypted_basis as encrypted from knowledge_benchmark_items where id=${item.id}::uuid`));
    if (!row?.encrypted) throw new Error("Synthetic original fixed role source body unavailable");
    return openBenchmarkValue<{ prepared: AssistContext }>(base.vault, "basis", row.encrypted).prepared;
  }
  async function output(item: BenchmarkItem, options: { forbidden?: boolean; foreignEvidence?: boolean; foreignSlot?: boolean; omitGaps?: boolean } = {}): Promise<AssistResult> {
    const prepared = await originalPrepared(item), baseline = runRoleBenchmarkBaseline(prepared), role = prepared.request.kind;
    const result = LegacyAssistResultSchema.parse(baseline), sourceId = prepared.sources.find(source => !prepared.images.some(image => image.sourceId === source.id))?.id;
    if (role === "creative") result.directions = [1, 2, 3].map(index => ({ title: `Synthetic independently authored direction ${index}`, rationale: "Synthetic model transport proposes a new geometric arrangement; no image generation or adoption",
      prompt: `Original synthetic geometric direction ${index}`, negativePrompt: "Do not copy research artwork or claim approval", requirements: { mode: "fixed", audience: "Synthetic audience", occasion: "", style: "Original geometry", fixedElements: "", imageInstructions: "", acceptance: "Human review required" }, fields: [],
      evidence: sourceId ? [{ sourceId, detail: "Actual fixed research source only" }] : [] }));
    for (const warning of prepared.diagnostics.filter(value => /缺|尚无|无法|不能|仅|未.{0,8}确认/.test(value)))
      if (!result.missingInformation.includes(warning)) result.missingInformation.push(warning);
    if (options.forbidden) result.summary += " AUTOMATICALLY APPROVED FOR PRODUCTION";
    if (options.foreignEvidence) result.findings.push({ title: "Synthetic forged source", detail: "Foreign image must fail", kind: "fact", severity: "warning", location: null,
      evidence: [{ sourceId: "foreign-image-not-in-this-input", detail: "Synthetic negative evidence" }] });
    if (options.foreignSlot) result.templateSlots = [{ stableKey: "foreign.slot", name: "Foreign parsed slot", kind: "image", fillMode: "contain", replaceable: true, fieldKey: "photo", reuseLabel: null,
      reason: "Synthetic foreign stable key must be rejected", evidence: [{ sourceId: sourceId!, detail: "Original parse does not contain this slot" }] }];
    if (options.omitGaps) { result.missingInformation = []; result.summary = "All source material is complete"; }
    return LegacyAssistResultSchema.parse(result);
  }
  async function complete(attemptId: string, version: BenchmarkVersion, options: Parameters<typeof output>[1] = {}) {
    const before = await experiments.attempt(base.a.context, attemptId), item = version.items.find(row => row.id === before.itemId);
    if (!item || !before.nativeRunId || before.evaluationRunId) throw new Error("Actual fixed native role attempt required");
    base.setOutput(await output(item, options)); await base.processRun(before.nativeRunId);
    const native = await assists.get(base.a.context, before.nativeRunId), attempt = await experiments.attempt(base.a.context, before.id);
    if (native.status !== "completed" || attempt.state !== "completed" || !attempt.assessment) {
      const [actual] = await withTenant(database.db, base.a.context, tx => tx.execute<{ status: string; error: string | null }>(sql`select status,error_code as error from ai_assist_runs where id=${before.nativeRunId}::uuid`));
      throw new Error(`Synthetic role completion failed: ${JSON.stringify({ status: actual?.status ?? "missing", error: actual?.error && /^[a-z][a-z0-9_]{0,127}$/.test(actual.error) ? actual.error : null, providerRequests: base.requests.length })}`);
    }
    return { native, attempt };
  }
  async function state(context = base.a.context) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ["ai_assist_runs", "ai_assist_executions", "ai_budget_ledger", "knowledge_benchmark_datasets", "knowledge_benchmark_versions", "knowledge_benchmark_items",
        "knowledge_benchmark_experiments", "knowledge_benchmark_attempts", "knowledge_benchmark_assessments", "knowledge_benchmark_reviews", "knowledge_benchmark_expenses", "knowledge_benchmark_reports", "knowledge_benchmark_commands", "knowledge_governance_events"])
        result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  const initializeBase = base.initialize.bind(base);
  return Object.assign(base, { facts, contexts, assists, evaluations, tasks, adapter, datasets, experiments, costs, launch, sourceRows, sources, dataset, experiment, originalPrepared, output, complete, state,
    businessState: facts.state, async initialize() { await initializeBase(); await facts.initialize(); }, close: facts.close });
}
