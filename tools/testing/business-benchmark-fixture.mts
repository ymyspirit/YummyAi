import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { SecretVault, openBenchmarkValue, runBusinessBenchmarkBaseline, type AssistContext } from "../../packages/ai-core/src/index.js";
import { LegacyAssistResultSchema } from "../../packages/contracts/src/ai/assist.js";
import { BusinessBenchmarkCaseSchema, BenchmarkDatasetFieldsSchema, BUSINESS_BENCHMARK_RULE_VERSION,
  type BenchmarkVersion, type BenchmarkItem } from "../../packages/contracts/src/knowledge/benchmark.js";
import type { FinanceFactInput } from "../../packages/contracts/src/finance/finance.js";
import type { TenantContext } from "../../packages/contracts/src/tenant/tenant-context.js";
import { Storage, ClamAvScanner } from "../../packages/storage/src/index.js";
import { withTenant, type DatabaseConnection } from "../../packages/database/src/index.js";
import type * as Drizzle from "../../packages/database/node_modules/drizzle-orm/index.js";
import type * as S3Sdk from "../../packages/storage/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { AuditService } from "../../apps/api/src/audit/audit.service.js";
import { FinanceService } from "../../apps/api/src/finance/finance.service.js";
import { InventoryService } from "../../apps/api/src/inventory/inventory.service.js";
import { ProcurementService } from "../../apps/api/src/procurement/procurement.service.js";
import { OrderService } from "../../apps/api/src/orders/order.service.js";
import { OrderRoutingService } from "../../apps/api/src/orders/order-routing.service.js";
import { OrderAfterSalesService } from "../../apps/api/src/orders/order-after-sales.service.js";
import { OrderWorkspaceService } from "../../apps/api/src/orders/order-workspace.service.js";
import { AmazonOrderReportService } from "../../apps/api/src/orders/amazon-order-report.service.js";
import { ProductionEditorService } from "../../apps/api/src/design/production-editor.service.js";
import { AssistBusinessContextService } from "../../apps/api/src/ai/assist-business-context.service.js";
import { AssistContextService } from "../../apps/api/src/ai/assist-context.service.js";
import { AssistTaskWorkspaceService } from "../../apps/api/src/ai/assist-task-workspace.service.js";
import { AssistService, type AssistEnqueuer } from "../../apps/api/src/ai/assist.service.js";
import { KnowledgeEvaluationService } from "../../apps/api/src/knowledge/knowledge-evaluation.service.js";
import { KnowledgeBenchmarkDatasetService } from "../../apps/api/src/knowledge/knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService } from "../../apps/api/src/knowledge/knowledge-benchmark-experiment.service.js";
import { KnowledgeBenchmarkCostService } from "../../apps/api/src/knowledge/knowledge-benchmark-cost.service.js";
import { KnowledgeBenchmarkBusinessService } from "../../apps/api/src/knowledge/knowledge-benchmark-business.service.js";
import { knowledgeEvaluationFixture } from "./knowledge-evaluation-fixture.mjs";
import { requireDisposableIntegrationEnvironment } from "./require-disposable-integration.mjs";

const { sql } = createRequire(new URL("../../packages/database/package.json", import.meta.url))("drizzle-orm") as typeof Drizzle;
const { S3Client } = createRequire(new URL("../../packages/storage/package.json", import.meta.url))("@aws-sdk/client-s3") as typeof S3Sdk;
export const businessBenchmarkSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const businessFactTables = ["orders", "order_lines", "order_work_items", "finance_statements", "finance_facts", "finance_profit_runs",
  "finance_profit_contributions", "finance_profit_metric_versions", "finance_fx_rates", "inventory_movements", "inventory_balances",
  "inventory_reservations", "inventory_replenishment_policy_versions", "inventory_procurement_requisitions", "inventory_procurement_rfqs",
  "inventory_supplier_quote_versions", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events"] as const;
export function requireBusinessBenchmarkEnvironment(target: "current" | "pre-0169", environment: NodeJS.ProcessEnv = process.env) {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || environment.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" || environment.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" ||
      environment.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || environment.E2E_LEGACY_SCHEMA_TARGET !== target ||
      environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Business benchmark requires its exact isolated schema, nonce database and private bucket before connection");
  return { url, nonce, workspace: fileURLToPath(new URL("../../", import.meta.url)) };
}

/** Real public constructors and business owners. These two task kinds use only
 * aggregate financial facts and stock/quote evidence. No artwork, object upload,
 * factory approval or file-scan acceptance is claimed by these scenarios. */
export function businessBenchmarkOwners(database: DatabaseConnection, vault: SecretVault) {
  requireBusinessBenchmarkEnvironment("current");
  const audit = new AuditService(database), finance = new FinanceService(database, audit), inventory = new InventoryService(database, audit);
  const procurement = new ProcurementService(database, inventory, audit), orders = new OrderService(database, vault, audit);
  const routing = new OrderRoutingService(database, orders, audit), afterSales = new OrderAfterSalesService(database, vault, audit);
  const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, forcePathStyle: true, region: process.env.S3_REGION ?? "us-east-1",
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! } });
  const storage = new Storage(client, process.env.S3_PRIVATE_BUCKET!), clam = new ClamAvScanner();
  const scan = { scan: (bytes: Uint8Array, fileName: string, mediaType: string) => clam.scan({ body: bytes, fileName, mediaType }) };
  const reports = new AmazonOrderReportService(database, vault, orders, audit,
    { download: async () => { throw new Error("Synthetic asset-free benchmark has no report download path"); },
      scan: bytes => clam.scan({ body: bytes, fileName: "synthetic-benchmark-report.txt", mediaType: "text/plain" }) },
    { schedule: async () => { throw new Error("Synthetic asset-free benchmark has no document processing path"); } },
    { schedule: async () => { throw new Error("Synthetic asset-free benchmark has no image processing path"); } });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit,
    { enqueue: async () => { throw new Error("Synthetic asset-free benchmark has no artwork queue path"); } }, scan, vault);
  const orderWorkspace = new OrderWorkspaceService(database, vault, storage, reports, editor, scan);
  const business = new AssistBusinessContextService(finance, procurement, afterSales, orderWorkspace);
  async function state(context: TenantContext) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of businessFactTables) result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
        md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  async function procurementSource(context: TenantContext, complete = true) {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const warehouse = await inventory.createWarehouse(context, { code: `BENCH-${suffix}`, name: "Synthetic benchmark warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: `DOCK-${suffix}`, name: "Synthetic benchmark dock" });
    const stock = await inventory.createStockItem(context, { skuId: null, code: `BLANK-${suffix}`, name: "Synthetic benchmark blank", baseUnit: "each" });
    if (complete) {
      await inventory.recordMovement(context, { stockItemId: stock.id, locationId: location.id, lotId: null, bucket: "physical", type: "adjustment",
        quantityDelta: 2, unit: "each", sourceType: "manual", sourceId: `synthetic-benchmark:${randomUUID()}`, reasonCode: "SYNTHETIC", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
      await procurement.upsertReplenishmentPolicy(context, { stockItemId: stock.id, locationId: location.id, reorderPoint: 10, safetyStock: 4,
        minimumOrderQuantity: 5, leadTimeDays: 7, serviceLevelBps: 9500, reviewIntervalDays: 7, idempotencyKey: randomUUID() });
      const supplier = await routing.createSupplier(context, { name: `Synthetic benchmark supplier ${suffix}`, kind: "manual", regionCode: "US", settlementCurrency: "USD" });
      const lines = [{ lineKey: "BLANK", stockItemId: stock.id, destinationLocationId: location.id, quantity: 20, unit: "each" as const }];
      const requisition = await procurement.createRequisition(context, { code: `REQ-${suffix}`, reasonCode: "SYNTHETIC", lines, idempotencyKey: randomUUID() });
      const rfq = await procurement.createRfq(context, requisition.id, { expectedRequisitionVersion: 1, supplierIds: [supplier.id],
        responseDueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), idempotencyKey: randomUUID() });
      await procurement.recordSupplierQuote(context, rfq.id, { supplierId: supplier.id, currency: "USD", validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        lines: [{ lineKey: "BLANK", unitCostMinor: 150, minimumOrderQuantity: 5, leadTimeDays: 4 }], idempotencyKey: randomUUID() });
    }
    return { role: "procurement_review" as const, targetId: `${stock.id}:${location.id}`, stockId: stock.id, locationId: location.id, complete };
  }
  async function financeSource(context: TenantContext, complete = true) {
    const now = new Date().toISOString(), key = randomUUID();
    const fact = (type: "sale_revenue" | "production_cost", amountMinor: number): FinanceFactInput => ({ sourceEntryId: `synthetic-benchmark:${key}:${type}`, lineKey: type,
      factType: type, direction: type === "sale_revenue" ? "credit" : "debit", amountMinor, currency: "USD", occurredAt: now,
      externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null });
    const statement = await finance.recordStatement(context, { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: `SYNTHETIC.BENCHMARK.${key}` },
      accountId: null, provider: "manual", statementKind: "manual_adjustment", externalStatementId: `synthetic-benchmark-${key}`, periodStart: now, periodEnd: now,
      sourceCurrency: "USD", observedAt: now, idempotencyKey: randomUUID(), lines: [fact("sale_revenue", 7350), ...(complete ? [fact("production_cost", 2050)] : [])] });
    const metric = await finance.upsertProfitMetric(context, { metricId: null, name: `Synthetic benchmark metric ${key}`, reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() });
    // These are original aggregate manual statements, not attributable order
    // contributions. Keep the explicit owner-supported coverage dimension.
    const run = await finance.calculateProfit(context, { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [],
      coverageDimension: "aggregate", idempotencyKey: randomUUID() });
    return { role: "business_review" as const, targetId: run.id, runId: run.id, statementId: statement.id, metricId: metric.id, complete };
  }
  return { audit, finance, inventory, procurement, orders, routing, afterSales, orderWorkspace, editor, business, state, procurementSource, financeSource,
    close: () => client.destroy() };
}

/** Reuses only the original native fixture's membership/model/HTTP/Worker and
 * controls. Business contexts are built through public DI, never private fields. */
export function businessBenchmarkFixture(database: DatabaseConnection) {
  requireBusinessBenchmarkEnvironment("current");
  const base = knowledgeEvaluationFixture(database), facts = businessBenchmarkOwners(database, base.originalVault);
  const nativeState = base.state.bind(base);
  const queue: AssistEnqueuer = { enqueue: async input => { base.dispatches.push(input); await base.controls.beforeQueue?.(input);
    if (base.controls.failQueue) throw new Error("Synthetic postcommit queue unavailable"); } };
  const contexts = new AssistContextService(database, facts.orderWorkspace, null!, facts.editor, null!, facts.business, base.answers);
  const assists = new AssistService(database, base.vault, contexts, queue), evaluations = new KnowledgeEvaluationService(database, assists);
  const tasks = new AssistTaskWorkspaceService(database, assists, contexts, facts.orderWorkspace, facts.editor);
  const businessAdapter = new KnowledgeBenchmarkBusinessService(database, assists, tasks);
  const datasets = new KnowledgeBenchmarkDatasetService(database, evaluations, base.vault, businessAdapter);
  const experiments = new KnowledgeBenchmarkExperimentService(database, evaluations, base.vault, businessAdapter), costs = new KnowledgeBenchmarkCostService(database, experiments, base.vault);
  async function sources() {
    const rows = [await facts.procurementSource(base.a.context), await facts.procurementSource(base.a.context, false),
      await facts.financeSource(base.a.context), await facts.financeSource(base.a.context, false)];
    const items = [];
    for (const [index, row] of rows.entries()) {
      const basis = await businessAdapter.basis(base.a.context, { kind: row.role, targetId: row.targetId, taskGoal: "" });
      items.push(BusinessBenchmarkCaseSchema.parse({ key: `business_${index + 1}`, role: row.role, label: `Synthetic ${row.role} ${row.complete ? "known" : "missing"}`,
        task: basis.input, expectedFacts: [row.role === "procurement_review" ? "calculations" : "reportingCurrency"],
        forbiddenClaims: ["guaranteed landed profit", "已自动采购付款"], expectRefusal: !row.complete }));
    }
    return { rows, fields: BenchmarkDatasetFieldsSchema.parse({ name: `Synthetic business benchmark ${randomUUID()}`, description: "Synthetic original stock and finance packets; phrase checks are not semantic monetary verification", items }) };
  }
  async function dataset() {
    const source = await sources(), saveInput = { fields: source.fields, expectedRevision: 0, reason: "Synthetic original business fixed samples", requestId: randomUUID() };
    const saved = await datasets.save(base.a.context, null, saveInput), publishInput = { expectedRevision: saved.revision, retentionDays: 7,
      reason: "Synthetic explicit scope, actual task pins and original source review", requestId: randomUUID() };
    const published = await datasets.publish(base.a.context, saved.id, publishInput), version = await datasets.version(base.a.context, published.id);
    return { ...source, saveInput, saved, publishInput, published, version };
  }
  async function experiment(options: { modelId?: string; maxAttemptsPerItem?: number } = {}) {
    const source = await dataset(), createInput = { datasetVersionId: source.version.id, label: `Synthetic mixed business experiment ${randomUUID()}`,
      baselineVersion: BUSINESS_BENCHMARK_RULE_VERSION, modelId: options.modelId ?? base.modelId, maxAttemptsPerItem: options.maxAttemptsPerItem ?? 3,
      reason: "Synthetic fixed business facts comparison", requestId: randomUUID() };
    const created = await experiments.create(base.a.context, createInput);
    return { ...source, createInput, created, experiment: await experiments.get(base.a.context, created.id) };
  }
  async function originalPrepared(item: BenchmarkItem): Promise<AssistContext> {
    if (item.fields.role === "knowledge_answer") throw new Error("Synthetic business helper refuses a knowledge sample");
    const [row] = await withTenant(database.db, base.a.context, tx => tx.execute<{ encrypted: string | null }>(
      sql`select encrypted_basis as encrypted from knowledge_benchmark_items where id=${item.id}::uuid`));
    if (!row?.encrypted) throw new Error("Synthetic original business basis is unavailable");
    return openBenchmarkValue<{ prepared: AssistContext }>(base.vault, "basis", row.encrypted).prepared;
  }
  async function output(item: BenchmarkItem, options: { forbidden?: boolean; omitGaps?: boolean } = {}) {
    const result = runBusinessBenchmarkBaseline(await originalPrepared(item));
    if (options.forbidden) result.summary += " guaranteed landed profit";
    if (options.omitGaps) { result.missingInformation = []; result.summary = "Everything is complete"; }
    return LegacyAssistResultSchema.parse(result);
  }
  async function complete(attemptId: string, version: BenchmarkVersion, options: Parameters<typeof output>[1] = {}) {
    const before = await experiments.attempt(base.a.context, attemptId), item = version.items.find(row => row.id === before.itemId);
    if (!before.nativeRunId || before.evaluationRunId || !item) throw new Error("Synthetic business completion requires its actual native run and fixed item");
    let phase = "prepare-output";
    try {
      base.setOutput(await output(item, options)); phase = "processor"; await base.processRun(before.nativeRunId);
      phase = "read-native"; const native = await assists.get(base.a.context, before.nativeRunId);
      phase = "read-attempt"; const attempt = await experiments.attempt(base.a.context, attemptId);
      if (native.status !== "completed" || attempt.state !== "completed" || !attempt.assessment) throw new Error("Synthetic completion receipt missing");
      return { attempt, native };
    } catch (error) {
      const [actual] = await withTenant(database.db, base.a.context, tx => tx.execute<{ status: string; error: string | null }>(
        sql`select status,error_code as error from ai_assist_runs where id=${before.nativeRunId}::uuid`));
      throw new Error("Synthetic business completion failed: " + JSON.stringify({ phase, status: actual?.status ?? "missing",
        error: actual?.error && /^[a-z][a-z0-9_]{0,127}$/.test(actual.error) ? actual.error : null, providerRequests: base.requests.length }), { cause: error });
    }
  }
  async function state(context = base.a.context) {
    const result = { ...await nativeState(context), ...await facts.state(context) };
    return withTenant(database.db, context, async tx => {
      for (const table of ["knowledge_benchmark_datasets", "knowledge_benchmark_versions", "knowledge_benchmark_items", "knowledge_benchmark_experiments",
        "knowledge_benchmark_attempts", "knowledge_benchmark_assessments", "knowledge_benchmark_reviews", "knowledge_benchmark_expenses", "knowledge_benchmark_commands", "knowledge_benchmark_reports", "knowledge_benchmark_retention_jobs", "audit_events"])
        result[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
      return result;
    });
  }
  return Object.assign(base, facts, { contexts, assists, evaluations, tasks, businessAdapter, datasets, experiments, costs, sources, dataset, experiment, originalPrepared, output, complete,
    state, businessState: facts.state, close: facts.close });
}
