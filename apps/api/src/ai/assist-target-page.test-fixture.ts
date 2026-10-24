import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createEntityId, CreateAfterSalesCaseInputSchema, CreateTemplateSourceInspectionInputSchema, CreateRightsAssessmentInputSchema } from "@yummyai/contracts";
import { NormalizeOrderInputSchema } from "@yummyai/contracts/order/order";
import { CreateCanvasBriefInputSchema } from "@yummyai/contracts/pod/canvas-bridge";
import { CreateProductSpuSchema } from "@yummyai/contracts/catalog/development";
import type { FinanceFactInput } from "../../../../packages/contracts/src/finance/finance.js";
import { marketplaceAccounts, withTenant, type DatabaseConnection } from "@yummyai/database";
import { Storage, ClamAvScanner } from "@yummyai/storage";
import type * as S3Sdk from "../../../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { sql } from "drizzle-orm";
import sharp from "sharp";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { agentReadFixture, agentReadSha, type AgentActor } from "./agent-read.test-fixture.js";
import { AssistTargetPageOwner } from "./assist-target-page-owner.js";
import { AssistTargetPageService } from "./assist-target-page.service.js";
import { AssistTaskWorkspaceService } from "./assist-task-workspace.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import { DesignService, DrizzleDesignRepository } from "../design/design.service.js";
import { PodGovernanceService } from "../design/pod-governance.service.js";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { AssetsController } from "../assets/assets.controller.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { OrderAfterSalesService } from "../orders/order-after-sales.service.js";
import { DrizzleTemplateSourceInspectionRepository, PersonalizationTemplateSourceInspectionProcessor } from "../../../worker/src/processors/personalization-template-source-inspection.processor.js";

const { S3Client } = createRequire(new URL("../../../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
export function requireAgentEntryEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment));
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || environment.E2E_AGENT_ENTRY_ISOLATED !== "1" || environment.E2E_AGENT_READ_ISOLATED !== "1" ||
      environment.E2E_LEGACY_SCHEMA_TARGET !== "current" || environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
      !redis || environment.REDIS_URL !== redis || environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
      !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname))
    throw new Error("Agent entry fixture requires all opt-ins and its exact current nonce database, bucket and Redis before connection");
  return url.href;
}

/** Only identities/accounts are synthetic admissions. Objects come from real
 * ingest, canvas draft, catalog draft, finance and template parser owners.
 * PNG source-rights review concerns our own controlled pixels; no production
 * artwork, factory acceptance, seller publishing or paid model is fabricated. */
export function assistTargetPageFixture(database: DatabaseConnection) {
  requireAgentEntryEnvironment();
  const base = agentReadFixture(database), owner = new AssistTargetPageOwner(database);
  const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const storage = new Storage(client, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner();
  const assets = new AssetsController(storage, database, base.audit), governance = new PodGovernanceService(database, base.audit);
  const forbiddenJob = async (): Promise<never> => { throw new Error("Target-page setup never generates or approves production artwork"); };
  const workflow = new PodBatchWorkflowService(database, { enqueueCreativeCandidate: forbiddenJob, enqueueCreativeAdaptation: forbiddenJob,
    enqueueMockupRender: forbiddenJob, enqueueTemplateCompile: forbiddenJob }, base.audit, new DesignService(new DrizzleDesignRepository(database, storage)));
  const canvas = new CanvasBridgeService(database, storage, base.audit, workflow,
    { scan: (body, fileName, mediaType) => clam.scan({ body, fileName, mediaType }) });
  const development = new ProductDevelopmentService(database, storage), listing = new ListingService(new DrizzleListingRepository(database));
  const templates = new PodPersonalizationService(database, { enqueue: async () => {} }, base.audit);
  const inspector = new PersonalizationTemplateSourceInspectionProcessor(new DrizzleTemplateSourceInspectionRepository(database, storage));
  const finance = new FinanceService(database, base.audit), afterSales = new OrderAfterSalesService(database, base.originalVault, base.audit);
  const legacy = new AssistTaskWorkspaceService(database, base.assists, base.contexts, base.orderWorkspace, base.editor);
  const gateway = () => new AssistTargetPageService(database, owner, base.integrationVault);
  let accountId: string | undefined;

  async function orderLines(count: number, actor = base.a, label = `Synthetic target ${createEntityId()}`) {
    const id = createEntityId();
    let account = actor === base.a ? accountId : undefined;
    if (!account) {
      account = createEntityId();
      await withTenant(database.db, actor.context, tx => tx.insert(marketplaceAccounts).values({ id: account!, tenantId: actor.tenantId, platform: "etsy",
        displayName: "Synthetic target source", region: "GLOBAL", authorizationMode: "etsy_oauth", createdBy: actor.userId }));
      if (actor === base.a) accountId = account;
    }
    const order = await base.orders.ingestNormalized(actor.context, NormalizeOrderInputSchema.parse({ accountId: account, platform: "etsy", externalEventId: `${id}:1`,
      externalOrderId: id, providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 1000 * count, currency: "USD" },
      lines: Array.from({ length: count }, (_, index) => ({ externalLineId: `${id}-${index}`, title: label, quantity: 1,
        unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 })), redactedSource: { syntheticOnly: true }, protectedDetails: null }));
    return { ...order, label };
  }
  async function creative(actor = base.a, name = `Synthetic canvas target ${createEntityId()}`) {
    return canvas.create(actor.context, CreateCanvasBriefInputSchema.parse({ requestId: randomUUID(), name, prompt: "Synthetic metadata-only requirements; no generated artwork", referenceAssetIds: [] }));
  }
  async function catalog(actor = base.a, name = `Synthetic catalog target ${createEntityId()}`, teamId?: string) {
    const { spu } = await development.createSpu(actor.context, CreateProductSpuSchema.parse({ code: `TARGET-${createEntityId()}`, name, teamId,
      idempotencyKey: randomUUID() }));
    const result = await listing.create(actor.context, { spuId: spu.id, platform: "etsy", locale: "en-US",
      content: { platform: "etsy", locale: "en-US", title: name, description: "Synthetic unpublished draft",
        bullets: [], tags: [], mediaAssetIds: [], variants: [], attributes: {}, compliance: {} } });
    return { spu, listing: result, name };
  }
  async function template(assetActor = base.a, parserActor = assetActor, label = `synthetic-target-${createEntityId()}`) {
    await storage.ensureBucket();
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#" + agentReadSha(label).slice(0, 6) } }).png().toBuffer();
    const scanned = await clam.scan({ body: bytes, fileName: label + ".png", mediaType: "image/png" });
    if (scanned.result !== "clean" || !scanned.signatureVersion || ["unavailable", "unknown"].includes(scanned.signatureVersion))
      throw new Error("Actual template source scanner must establish clean synthetic pixels");
    const asset = await assets.upload({ headers: {}, tenantContext: assetActor.context }, { domain: "authorized", dataBase64: bytes.toString("base64"), fileName: label + ".png", mediaType: "image/png" });
    await governance.createRightsAssessment(assetActor.context, CreateRightsAssessmentInputSchema.parse({ assetId: asset.id, assetVersion: asset.version,
      rightsSource: { kind: "owned", reference: "Synthetic original target fixture pixels" }, scopeSnapshot: { syntheticOnly: true }, status: "approved", legalRisk: "low",
      evidence: [{ kind: "internal", reference: "Known controlled fixture", checkedAt: new Date().toISOString() }], decisionReason: "Owned synthetic source only; no artwork or production approval" }));
    const created = await templates.createTemplateSourceInspection(parserActor.context, CreateTemplateSourceInspectionInputSchema.parse({ sourceAssetId: asset.id, sourceAssetVersion: asset.version, idempotencyKey: createEntityId() }));
    const jobId = createEntityId();
    await inspector.process(JobEnvelopeSchema.parse({ jobId, correlationId: jobId, idempotencyKey: jobId, tenantId: parserActor.tenantId,
      requestedBy: parserActor.userId, payload: { inspectionId: created.id } }));
    const basis = await templates.templateAnalysisBasis(parserActor.context, created.id);
    if (basis.status !== "completed") throw new Error("Actual synthetic PNG template parsing did not complete");
    return { id: created.id, assetId: asset.id, label };
  }
  async function financeTarget(actor = base.a) {
    const now = new Date().toISOString(), id = createEntityId();
    const fact = (factType: "sale_revenue" | "production_cost", amountMinor: number): FinanceFactInput => ({ sourceEntryId: `${id}:${factType}`, lineKey: factType,
      factType, direction: factType === "sale_revenue" ? "credit" : "debit", amountMinor, currency: "USD", occurredAt: now,
      externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null });
    const statement = await finance.recordStatement(actor.context, { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: `SYNTHETIC.TARGET.${id}` },
      accountId: null, provider: "manual", statementKind: "manual_adjustment", externalStatementId: id, periodStart: now, periodEnd: now,
      sourceCurrency: "USD", observedAt: now, idempotencyKey: randomUUID(), lines: [fact("sale_revenue", 1000), fact("production_cost", 400)] });
    const metric = await finance.upsertProfitMetric(actor.context, { metricId: null, name: `Synthetic target ${id}`, reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"],
      costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() });
    return finance.calculateProfit(actor.context, { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: randomUUID() });
  }
  async function afterSalesTarget(orderId: string, actor = base.a) {
    return afterSales.create(actor.context, orderId, CreateAfterSalesCaseInputSchema.parse({ type: "delivery_issue", reasonCode: "SYNTHETIC_TARGET",
      summary: "Synthetic private contact text must not enter target projection", idempotencyKey: randomUUID() }));
  }
  async function state() {
    const original = await base.state();
    const tables = await withTenant(database.db, base.a.context, async tx => {
      const values: Record<string, { count: number; hash: string }> = {};
      for (const name of ["creative_design_batches", "creative_design_batch_items", "product_plans", "spus", "listings", "listing_versions", "asset_files",
        "personalization_template_source_inspections", "finance_statements", "finance_facts", "finance_profit_runs", "after_sales_cases"])
        values[name] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(name)} t`))[0]!;
      return values;
    });
    return { original, tables };
  }
  return { base, owner, gateway, legacy, storage, canvas, development, listing, templates, orderLines, creative, catalog, template, financeTarget, afterSalesTarget, state,
    current: (actor: AgentActor) => base.current(actor), async initialize() { await base.initialize(); }, close() { base.close(); client.destroy(); } };
}
