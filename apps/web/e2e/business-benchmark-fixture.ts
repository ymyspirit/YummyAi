import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { LegacyAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { type BenchmarkItem } from "@yummyai/contracts/knowledge/benchmark";
import { CreateWarehouseInputSchema, CreateInventoryLocationInputSchema, CreateStockItemInputSchema, RecordInventoryMovementInputSchema,
  InventoryWarehouseViewSchema, InventoryLocationViewSchema, InventoryStockItemViewSchema } from "@yummyai/contracts/inventory";
import { CreateProcurementRequisitionInputSchema, CreateProcurementRfqInputSchema, RecordProcurementSupplierQuoteInputSchema,
  UpsertReplenishmentPolicyInputSchema, ProcurementRequisitionViewSchema, ProcurementRfqViewSchema } from "@yummyai/contracts/procurement";
import { CreateFulfillmentSupplierInputSchema, FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { RecordFinanceStatementInputSchema, UpsertFinanceProfitMetricInputSchema, CalculateFinanceProfitInputSchema,
  FinanceStatementViewSchema, FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, type FinanceFactInput } from "@yummyai/contracts/finance";
import { createEnvironmentSecretVault, openBenchmarkValue, runBusinessBenchmarkBaseline, type AssistContext } from "../../../packages/ai-core/src/index";
import { connectDatabase, membershipRoles, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { actors } from "./erp-identity-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { centerApi } from "./order-centers-fixture";

export function requireBusinessBenchmarkBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (!nonce || !process.env.ERP_FIXTURE_ACTORS || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
    process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" ||
    process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" ||
    process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Business benchmark browser requires the exact isolated compiled personal nonce API and bucket before connection");
  return { url, nonce };
}

const domainPermissions = [Permission.ProcurementRead, Permission.InventoryRead, Permission.FinanceRead, Permission.OrderRead];
const outputRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)), "tmp/business-benchmark-20261021-c9e82d4a/frontend/browser-proof");
const unfinished = new Set<{ close(): Promise<void> }>();
export async function closeBusinessBenchmarkBrowsers() { for (const value of [...unfinished]) await value.close(); }
type BusinessSource = { role: "procurement_review"; targetId: string; stockId: string; locationId: string; complete: boolean }
  | { role: "business_review"; targetId: string; runId: string; statementId: string; metricId: string; complete: boolean };
const businessFactTables = ["orders", "order_lines", "order_work_items", "finance_statements", "finance_facts", "finance_profit_runs",
  "finance_profit_contributions", "finance_profit_metric_versions", "finance_fx_rates", "inventory_movements", "inventory_balances",
  "inventory_reservations", "inventory_replenishment_policy_versions", "inventory_procurement_requisitions", "inventory_procurement_rfqs",
  "inventory_supplier_quote_versions", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events"] as const;

/** Real business owners create synthetic source facts and the actual native
 * processor consumes the published packet. Only external model HTTP is synthetic. */
export async function businessBenchmarkBrowser(leaf: string) {
  const isolated = requireBusinessBenchmarkBrowser(), requests: Record<string, unknown>[] = [];
  const identity = actors().operator, database = connectDatabase(isolated.url.href);
  const ceiling: TenantContext = { tenantId: identity.tenantId, userId: identity.userId, permissions: Object.values(Permission), dataScope: "tenant" };
  let closed = false, domainRoleId: string | null = null;
  let initializingFixture: Awaited<ReturnType<typeof knowledgeGovernanceFixture>> | undefined;
  let vault: ReturnType<typeof createEnvironmentSecretVault>;
  try {
    initializingFixture = await knowledgeGovernanceFixture(`business-benchmark-${leaf}`, { onModelRequest: request => requests.push(request) });
    vault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist");
  } catch (error) { try { await initializingFixture?.close(); } finally { await database.client.end(); } throw error; }
  const fixture = initializingFixture;
  const proof: Record<string, unknown> = { leaf, nonce: isolated.nonce,
    admission: "Real personal OIDC, membership, original inventory/procurement/finance REST owners, fixed publication, native Assist Worker, assessment, human minutes and report; only provider HTTP transport is synthetic",
    cleanupOwner: "This fixture restores roles and removes its exact auxiliary role and closes connections; the outer disposable runner deletes all nonce business data, bucket and identity resources" };
  async function check() {
    if (closed || requireBusinessBenchmarkBrowser().nonce !== isolated.nonce) throw new Error("Business benchmark fixture scope changed");
    const [current] = await database.client.unsafe<{ name: string }[]>("select current_database() as name");
    if (current?.name !== `order_daily_e2e_${isolated.nonce}`) throw new Error("Exact disposable business benchmark database required");
  }
  async function procurementSource(complete = true): Promise<Extract<BusinessSource, { role: "procurement_review" }>> {
    await check(); const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
    const warehouse = InventoryWarehouseViewSchema.parse(await centerApi("inventory/warehouses", CreateWarehouseInputSchema.parse({
      code: `BENCH-${suffix}`, name: "Synthetic benchmark warehouse", type: "owned", countryCode: "US", timeZone: "UTC" })));
    const location = InventoryLocationViewSchema.parse(await centerApi("inventory/locations", CreateInventoryLocationInputSchema.parse({
      warehouseId: warehouse.id, code: `DOCK-${suffix}`, name: "Synthetic benchmark dock" })));
    const stock = InventoryStockItemViewSchema.parse(await centerApi("inventory/stock-items", CreateStockItemInputSchema.parse({
      skuId: null, code: `BLANK-${suffix}`, name: "Synthetic benchmark blank", baseUnit: "each" })));
    if (complete) {
      await centerApi("inventory/movements", RecordInventoryMovementInputSchema.parse({ stockItemId: stock.id, locationId: location.id, lotId: null,
        bucket: "physical", type: "adjustment", quantityDelta: 2, unit: "each", sourceType: "manual", sourceId: `synthetic-benchmark:${randomUUID()}`,
        reasonCode: "SYNTHETIC", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() }));
      await centerApi("procurement/replenishment-policies", UpsertReplenishmentPolicyInputSchema.parse({ stockItemId: stock.id, locationId: location.id,
        reorderPoint: 10, safetyStock: 4, minimumOrderQuantity: 5, leadTimeDays: 7, serviceLevelBps: 9500, reviewIntervalDays: 7, idempotencyKey: randomUUID() }));
      const supplier = FulfillmentSupplierViewSchema.parse(await centerApi("sourcing/suppliers", CreateFulfillmentSupplierInputSchema.parse({
        name: `Synthetic benchmark supplier ${suffix}`, kind: "manual", regionCode: "US", settlementCurrency: "USD" })));
      const requisition = ProcurementRequisitionViewSchema.parse(await centerApi("procurement/requisitions", CreateProcurementRequisitionInputSchema.parse({
        code: `REQ-${suffix}`, reasonCode: "SYNTHETIC", lines: [{ lineKey: "BLANK", stockItemId: stock.id, destinationLocationId: location.id, quantity: 20, unit: "each" }], idempotencyKey: randomUUID() })));
      const rfq = ProcurementRfqViewSchema.parse(await centerApi(`procurement/requisitions/${requisition.id}/rfqs`, CreateProcurementRfqInputSchema.parse({
        expectedRequisitionVersion: requisition.currentVersion, supplierIds: [supplier.id], responseDueAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), idempotencyKey: randomUUID() })));
      await centerApi(`procurement/rfqs/${rfq.id}/quotes`, RecordProcurementSupplierQuoteInputSchema.parse({ supplierId: supplier.id, currency: "USD",
        validUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(), lines: [{ lineKey: "BLANK", unitCostMinor: 150, minimumOrderQuantity: 5, leadTimeDays: 4 }], idempotencyKey: randomUUID() }));
    }
    return { role: "procurement_review", targetId: `${stock.id}:${location.id}`, stockId: stock.id, locationId: location.id, complete };
  }
  async function financeSource(complete = true): Promise<Extract<BusinessSource, { role: "business_review" }>> {
    await check(); const now = new Date().toISOString(), key = randomUUID();
    const fact = (type: "sale_revenue" | "production_cost", amountMinor: number): FinanceFactInput => ({ sourceEntryId: `synthetic-benchmark:${key}:${type}`,
      lineKey: type, factType: type, direction: type === "sale_revenue" ? "credit" : "debit", amountMinor, currency: "USD", occurredAt: now,
      externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null });
    const statement = FinanceStatementViewSchema.parse(await centerApi("finance/statements", RecordFinanceStatementInputSchema.parse({
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: `SYNTHETIC.BENCHMARK.${key}` }, accountId: null, provider: "manual",
      statementKind: "manual_adjustment", externalStatementId: `synthetic-benchmark-${key}`, periodStart: now, periodEnd: now, sourceCurrency: "USD", observedAt: now,
      idempotencyKey: randomUUID(), lines: [fact("sale_revenue", 7350), ...(complete ? [fact("production_cost", 2050)] : [])] })));
    const metric = FinanceProfitMetricViewSchema.parse(await centerApi("finance/profit-metrics", UpsertFinanceProfitMetricInputSchema.parse({
      metricId: null, name: `Synthetic benchmark metric ${key}`, reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"],
      requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() })));
    // These source facts are a manual aggregate. No order attribution is made.
    const run = FinanceProfitRunViewSchema.parse(await centerApi("finance/profit-runs", CalculateFinanceProfitInputSchema.parse({
      metricId: metric.id, expectedMetricVersion: metric.currentVersion, statementIds: [statement.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: randomUUID() })));
    return { role: "business_review", targetId: run.id, runId: run.id, statementId: statement.id, metricId: metric.id, complete };
  }
  const result = { fixture, database, requests, proof, check,
    async sources() {
      return [await procurementSource(), await procurementSource(false), await financeSource(), await financeSource(false)];
    },
    businessState: async () => {
      await check(); return withTenant(database.db, ceiling, async tx => {
        const state: Record<string, { count: number; hash: string }> = {};
        for (const table of businessFactTables) state[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
          md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
        return state;
      });
    },
    async output(item: BenchmarkItem) {
      await check();
      if (item.caseId || item.fields.role === "knowledge_answer") throw new Error("Business browser requires an original business sample");
      const [row] = await withTenant(database.db, ceiling, tx => tx.execute<{ encrypted: string | null }>(
        sql`select encrypted_basis as encrypted from knowledge_benchmark_items where id=${item.id}::uuid and version_id=${item.versionId}::uuid and created_by=${identity.userId}::uuid`));
      if (!row?.encrypted) throw new Error("Original published business packet missing");
      const original = openBenchmarkValue<{ prepared: AssistContext }>(vault, "basis", row.encrypted);
      return LegacyAssistResultSchema.parse(runBusinessBenchmarkBaseline(original.prepared));
    },
    async domainScope(scope: "self" | "tenant") {
      await check();
      if (!domainRoleId) {
        await fixture.setPermissions(Object.values(Permission).filter(permission => !domainPermissions.includes(permission as typeof domainPermissions[number])));
        const id = createEntityId();
        await withTenant(database.db, ceiling, async tx => {
          await tx.insert(roles).values({ id, tenantId: identity.tenantId, name: `Synthetic business benchmark domain ${randomUUID()}`, permissions: domainPermissions, dataScope: scope });
          await tx.insert(membershipRoles).values({ tenantId: identity.tenantId, membershipId: identity.membershipId, roleId: id });
        });
        domainRoleId = id;
      } else {
        await withTenant(database.db, ceiling, tx => tx.update(roles).set({ dataScope: scope }).where(eq(roles.id, domainRoleId!)));
      }
    },
    async close() {
      if (closed) return;
      const errors: string[] = [];
      try { await check(); await fixture.close(); proof.originalRolesRestored = true; } catch { errors.push("original_roles_restore_failed"); }
      if (domainRoleId) try {
        await withTenant(database.db, ceiling, async tx => {
          await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, domainRoleId!));
          await tx.delete(roles).where(eq(roles.id, domainRoleId!));
        }); proof.auxiliaryDomainRoleRemoved = true;
      } catch { errors.push("auxiliary_domain_role_remove_failed"); }
      try { await database.client.end(); proof.databaseConnectionClosed = true; } catch { errors.push("owned_database_close_failed"); }
      closed = true; unfinished.delete(result); proof.cleanupErrors = errors;
      const owned = resolve(outputRoot, isolated.nonce); await mkdir(owned, { recursive: true });
      await writeFile(resolve(owned, leaf + ".json"), JSON.stringify(proof, null, 2) + "\n");
      if (errors.length) throw new Error("Business benchmark cleanup incomplete: " + errors.join(","));
    },
  };
  unfinished.add(result);
  try { await check(); return result; } catch (error) { await result.close(); throw error; }
}
