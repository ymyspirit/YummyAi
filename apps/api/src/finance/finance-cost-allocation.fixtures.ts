/** Actual Finance owners write all money; neutral synthetic catalog/order targets are isolated fixture records. */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { FinanceFactInput } from "@yummyai/contracts/finance";
import type { FinanceCostAllocationDimension, FinanceCostAllocationPreviewInput } from "@yummyai/contracts/finance/cost-allocation";
import { memberships, membershipRoles, roles, withTenant, type DatabaseConnection } from "@yummyai/database";
import { financeMonetaryFixture, monetaryFact, monetaryKey, monetaryRate, monetaryStatement, monetaryTables } from "./finance-monetary.fixtures.js";
import { FinanceCostAllocationService } from "./finance-cost-allocation.service.js";

export const costKey = monetaryKey;
export const costTables = ["finance_cost_allocation_versions", "finance_allocated_profit_runs", "finance_allocated_profit_slices"];
export const costProtectedTables = [...monetaryTables, "finance_payable_bills", "finance_payable_payments", "finance_payment_allocations", "inventory_supplier_invoices"];
export function requireFinanceCostAllocationFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COST_ALLOCATION_ISOLATED !== "1" || process.env.E2E_FINANCE_MONETARY_ISOLATED !== "1"
    || !["postgres:", "postgresql:"].includes(url.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Explicit cost allocation requires its dedicated disposable runner before connection");
}
export interface CostTargetFixture { accountId: string; orderId: string; lineId: string; skuId: string; listingId: string; spuId: string; catalogLinkId: string }
export function financeCostAllocationFixture(database: DatabaseConnection) {
  requireFinanceCostAllocationFixture();
  const f = financeMonetaryFixture(database), { context, outsider, service: finance, audit } = f;
  const allocations = new FinanceCostAllocationService(database, audit), coworker: TenantContext = { ...context, userId: createEntityId() };
  const permissions = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
  let own: CostTargetFixture[] = [], foreign: CostTargetFixture[] = [];
  async function dimensions(actor: TenantContext, count: number) {
    const result: CostTargetFixture[] = [];
    for (let index = 0; index < count; index++) await withTenant(database.db, actor, async tx => {
      const accountId = createEntityId(), planId = createEntityId(), spuId = createEntityId(), skuId = createEntityId(), listingId = createEntityId(),
        snapshotId = createEntityId(), orderId = createEntityId(), lineId = createEntityId(), catalogLinkId = createEntityId(), code = `COST-${skuId.toUpperCase()}`;
      await tx.execute(sql`insert into marketplace_accounts(id,tenant_id,platform,display_name,region,marketplace_ids,authorization_mode,status)
        values(${accountId},${actor.tenantId},'etsy',${`Synthetic allocation account ${accountId}`},'GLOBAL','["US"]'::jsonb,'etsy_oauth','active')`);
      await tx.execute(sql`insert into product_plans(id,tenant_id,name,customization) values(${planId},${actor.tenantId},${`Synthetic cost product ${planId}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into spus(id,tenant_id,product_plan_id,code,name,customization) values(${spuId},${actor.tenantId},${planId},${`SPU-${code}`},${`Synthetic cost SPU ${spuId}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into skus(id,tenant_id,spu_id,code,status) values(${skuId},${actor.tenantId},${spuId},${code},'active')`);
      await tx.execute(sql`insert into listings(id,tenant_id,spu_id,platform,marketplace_id,locale,status) values(${listingId},${actor.tenantId},${spuId},'etsy','US','en-US','approved')`);
      await tx.execute(sql`insert into order_source_snapshots(id,tenant_id,account_id,platform,external_event_id,external_order_id,normalized_order_id,redacted_payload,payload_checksum)
        values(${snapshotId},${actor.tenantId},${accountId},'etsy',${costKey()},${orderId},${orderId},'{}'::jsonb,${"a".repeat(64)})`);
      await tx.execute(sql`insert into orders(id,tenant_id,account_id,source_snapshot_id,platform,external_order_id,provider_status,order_total_minor,order_currency,line_count,placed_at)
        values(${orderId},${actor.tenantId},${accountId},${snapshotId},'etsy',${orderId},'paid',1000,'USD',1,'2026-07-01T00:00:00Z')`);
      await tx.execute(sql`insert into order_lines(id,tenant_id,order_id,external_line_id,sku_code,title,quantity,unit_price_minor,unit_price_currency)
        values(${lineId},${actor.tenantId},${orderId},${lineId},${code},'Synthetic attribution line without buyer input',1,1000,'USD')`);
      await tx.execute(sql`insert into order_line_catalog_links(id,tenant_id,order_line_id,sku_id,match_source,linked_by)
        values(${catalogLinkId},${actor.tenantId},${lineId},${skuId},'manual',${actor.userId})`);
      result.push({ accountId, orderId, lineId, skuId, listingId, spuId, catalogLinkId });
    });
    return result;
  }
  async function rights(actor: TenantContext, granted: string[], scope: "tenant" | "self" | "team" = "tenant") {
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: granted, dataScope: scope }).where(eq(roles.id, f.roleIds.get(actor.userId)!)));
  }
  async function restoreRights() {
    for (const actor of [context, outsider, coworker]) await withTenant(database.db, actor, async tx => {
      await tx.update(roles).set({ permissions, dataScope: "tenant" }).where(eq(roles.id, f.roleIds.get(actor.userId)!));
      await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, f.membershipIds.get(actor.userId)!));
    });
  }
  async function initialize() {
    await f.initialize(); await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic allocation coworker')",
      [coworker.userId, `allocation-${coworker.userId}`, `${coworker.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId(); f.roleIds.set(coworker.userId, roleId); f.membershipIds.set(coworker.userId, membershipId);
      await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: coworker.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: `Synthetic allocation ${roleId}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
    });
    own = await dimensions(context, 3); foreign = await dimensions(outsider, 1);
  }
  async function basis(options: { amountMinor?: number; currency?: string; omitCostIndex?: number; directSource?: boolean; coverage?: "aggregate" | "order_line" } = {}) {
    // Each base owns new actual orders. Otherwise later order-evidence reads
    // would correctly see prior cases' additional facts and reject a stale base.
    own = await dimensions(context, 3);
    const directInputs = own.flatMap((target, index) => {
      const refs = { orderId: target.orderId, orderLineId: target.lineId, skuId: target.skuId };
      const inputs = [monetaryFact("USD", 1000, { ...refs, factType: "sale_revenue", direction: "credit" }),
        monetaryFact("USD", 50, { ...refs, factType: "marketplace_commission" })];
      if (index !== options.omitCostIndex) inputs.push(monetaryFact("USD", 100, refs));
      if (options.coverage === "order_line") inputs.push(monetaryFact("USD", 0, { ...refs, factType: "carrier_cost" }));
      return inputs;
    });
    const direct = await finance.recordStatement(context, monetaryStatement("USD", directInputs));
    const sharedInput = monetaryFact(options.currency ?? "USD", options.amountMinor ?? 101, { factType: "carrier_cost",
      ...(options.directSource ? { orderId: own[0]!.orderId, orderLineId: own[0]!.lineId, skuId: own[0]!.skuId } : {}) });
    const shared = await finance.recordStatement(context, monetaryStatement(sharedInput.currency, [sharedInput]));
    const rates = sharedInput.currency === "EUR" ? [await finance.recordFxRate(context, monetaryRate("EUR", "USD", 1, 2))] : [];
    const metric = await finance.upsertProfitMetric(context, { metricId: null, name: `Synthetic explicit cost ${randomUUID()}`, reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost", "carrier_cost", "marketplace_commission"],
      requiredFactTypes: ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"], reasonCode: "SYNTHETIC", idempotencyKey: costKey() });
    const input = { metricId: metric.id, expectedMetricVersion: 1, statementIds: [direct.id, shared.id], fxRateIds: rates.map(row => row.id),
      coverageDimension: options.coverage ?? "aggregate", idempotencyKey: costKey() };
    const base = await finance.calculateProfit(context, input);
    return { direct, shared, sharedInput, root: shared.lines[0]!, metric, rates, input, base, targets: [...own] };
  }
  function previewInput(base: Awaited<ReturnType<typeof basis>>, dimension: FinanceCostAllocationDimension = "order_line", keys?: string[]): FinanceCostAllocationPreviewInput {
    const actual = keys ?? base.targets.map(target => dimension === "order" ? target.orderId : dimension === "order_line" ? target.lineId : dimension === "sku" ? target.skuId : dimension === "listing" ? target.listingId : "2026-07");
    return { baseRunId: base.base.id, baseInputChecksum: base.base.inputChecksum, allocationId: null, expectedVersion: null, dimension, method: "equal",
      sources: [{ rootFactId: base.root.id, targets: [...new Set(actual)].map(key => ({ key, weight: "1" })) }], reasonCode: "SYNTHETIC", basisDescription: "Synthetic operator explicitly chose equal weights No inferred sales quantity or bank action" };
  }
  async function approve(input: FinanceCostAllocationPreviewInput) {
    const preview = await allocations.preview(context, input);
    return { preview, version: await allocations.approve(context, { ...input, previewChecksum: preview.previewChecksum, idempotencyKey: costKey() }) };
  }
  async function calculate(base: Awaited<ReturnType<typeof basis>>, versionIds: string[], dimension: FinanceCostAllocationDimension = "order_line") {
    return allocations.calculate(context, { baseRunId: base.base.id, baseInputChecksum: base.base.inputChecksum, dimension, versionIds, idempotencyKey: costKey() });
  }
  async function correction(base: Awaited<ReturnType<typeof basis>>, kind: "reversal" | "replacement", amountMinor = base.sharedInput.amountMinor) {
    const original: FinanceFactInput = { ...base.sharedInput, sourceEntryId: costKey(), lineKey: costKey(), amountMinor, correctionKind: kind, correctsFactId: base.root.id };
    return finance.recordStatement(context, monetaryStatement(original.currency, [original]));
  }
  return { ...f, database, context, outsider, coworker, finance, allocations, initialize, rights, restoreRights, basis, previewInput, approve, calculate, correction,
    get own() { return own; }, get foreign() { return foreign; } };
}
export type FinanceCostFixture = ReturnType<typeof financeCostAllocationFixture>;
