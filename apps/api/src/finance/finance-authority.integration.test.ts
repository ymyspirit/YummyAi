import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { UpsertFinanceProfitMetricInput } from "@yummyai/contracts/finance";
import { connectDatabase, migrateDatabase, withTenant, memberships, membershipRoles, roles, financeFacts, financeProfitMetricVersions } from "@yummyai/database";
import { financeMonetaryFixture, monetaryFact, monetaryKey, monetaryRate, monetaryStatement, monetaryTables } from "./finance-monetary.fixtures.js";

const isolated = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_AUTHORITY_ISOLATED !== "1"
  || !["postgres:", "postgresql:"].includes(isolated.protocol) || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(isolated.pathname))
  throw new Error("Financial authority acceptance requires its own disposable database before connection");
const rights = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview], key = monetaryKey;
const metricInput = (overrides: Partial<UpsertFinanceProfitMetricInput> = {}): UpsertFinanceProfitMetricInput => ({ metricId: null,
  name: `Synthetic authority ${randomUUID()}`, reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"],
  requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: key(), ...overrides });

describe.sequential("financial owner authority and actual economic-event identity", () => {
  const database = connectDatabase(), fixture = financeMonetaryFixture(database), { service, context, outsider, audit } = fixture;
  const coworker: TenantContext = { ...context, userId: createEntityId() }, scopedRoleId = createEntityId();
  let own: Awaited<ReturnType<typeof dimensions>>, foreign: Awaited<ReturnType<typeof dimensions>>;
  beforeAll(async () => {
    await migrateDatabase(database); await fixture.initialize();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic financial coworker')",
      [coworker.userId, `authority-${coworker.userId}`, `${coworker.userId}@example.test`]);
    await withTenant(database.db, context, async tx => {
      const memberId = createEntityId(), roleId = createEntityId(); fixture.membershipIds.set(coworker.userId, memberId); fixture.roleIds.set(coworker.userId, roleId);
      await tx.insert(memberships).values({ id: memberId, tenantId: context.tenantId, userId: coworker.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: `Synthetic coworker ${roleId}`, permissions: rights, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: memberId, roleId });
      await tx.insert(roles).values({ id: scopedRoleId, tenantId: context.tenantId, name: `Synthetic mixed finance scope ${scopedRoleId}`, permissions: [], dataScope: "self" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: fixture.membershipIds.get(context.userId)!, roleId: scopedRoleId });
    });
    own = await dimensions(context); foreign = await dimensions(outsider);
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const actor of [context, coworker, outsider]) await withTenant(database.db, actor, async tx => {
      await tx.update(roles).set({ permissions: rights, dataScope: "tenant" }).where(eq(roles.id, fixture.roleIds.get(actor.userId)!));
      await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, fixture.membershipIds.get(actor.userId)!));
    });
    await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: [], dataScope: "self" }).where(eq(roles.id, scopedRoleId)));
  });
  afterAll(async () => { await database.client.end(); });
  const state = () => fixture.state([...monetaryTables, "audit_events"]);
  async function grant(actor: TenantContext, granted: string[], dataScope: "self" | "team" | "tenant" = "tenant") {
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: granted, dataScope }).where(eq(roles.id, fixture.roleIds.get(actor.userId)!)));
  }
  async function calculation() {
    const statement = await fixture.statement("USD", [monetaryFact("USD", 10000, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 2000)]);
    const metric = await service.upsertProfitMetric(context, metricInput()), input = { metricId: metric.id, expectedMetricVersion: 1,
      statementIds: [statement.id], fxRateIds: [], coverageDimension: "aggregate" as const, idempotencyKey: key() };
    return { statement, metric, input };
  }
  async function operations() {
    const basis = await calculation(), statement = monetaryStatement("USD", [monetaryFact("USD", 100)]), rate = monetaryRate("EUR", "USD", 11, 10), metric = metricInput();
    return { basis, statement: () => service.recordStatement(context, statement), rate: () => service.recordFxRate(context, rate),
      metric: () => service.upsertProfitMetric(context, metric), run: () => service.calculateProfit(context, basis.input) };
  }
  it.each(["statement", "rate", "metric", "run"] as const)("rechecks current rights before a %s write or replay from a previously authorized context", async operation => {
    const actions = await operations(); await actions[operation](); const permission = ["statement", "rate"].includes(operation) ? Permission.FinanceWrite : Permission.FinanceReview;
    await grant(context, rights.filter(value => value !== permission)); const before = await state();
    await expect(actions[operation]()).rejects.toBeInstanceOf(ForbiddenError); expect(await state()).toEqual(before);
    expect((await service.workspace(context)).statements.length).toBeGreaterThan(0);
  });
  it.each(["workspace", "statement", "metric", "run", "orders"] as const)("rechecks current FinanceRead for the %s reader including an empty order selection", async operation => {
    const basis = await calculation(), run = await service.calculateProfit(context, basis.input); await grant(context, [Permission.FinanceWrite, Permission.FinanceReview]);
    const read = () => operation === "workspace" ? service.workspace(context) : operation === "statement" ? service.getStatement(context, basis.statement.id)
      : operation === "metric" ? service.getProfitMetric(context, basis.metric.id) : operation === "run" ? service.getProfitRun(context, run.id) : service.orderEvidence(context, []);
    await expect(read()).rejects.toBeInstanceOf(ForbiddenError);
  });
  it.each(["self", "team"] as const)("does not widen a current %s finance grant through a tenant caller object", async scope => {
    const actions = await operations(); await grant(context, rights, scope); const before = await state();
    for (const operation of ["statement", "rate", "metric", "run"] as const) await expect(actions[operation]()).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.workspace(context)).rejects.toBeInstanceOf(ForbiddenError); expect(await state()).toEqual(before);
  });
  it("intersects mixed permission scopes independently instead of borrowing tenant read scope for financial writes", async () => {
    const actions = await operations(); await grant(context, [Permission.FinanceRead]);
    await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: [Permission.FinanceWrite, Permission.FinanceReview], dataScope: "self" }).where(eq(roles.id, scopedRoleId)));
    expect((await service.workspace(context)).statements.length).toBeGreaterThan(0); const before = await state();
    await expect(actions.statement()).rejects.toBeInstanceOf(ForbiddenError); await expect(actions.run()).rejects.toBeInstanceOf(ForbiddenError); expect(await state()).toEqual(before);
  });
  it("does not trust caller-injected permissions or a disabled current membership", async () => {
    const actions = await operations(); await grant(context, []); const before = await state();
    await expect(actions.statement()).rejects.toBeInstanceOf(ForbiddenError); await expect(service.workspace(context)).rejects.toBeInstanceOf(ForbiddenError);
    await grant(context, rights); await withTenant(database.db, context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, fixture.membershipIds.get(context.userId)!)));
    await expect(actions.rate()).rejects.toBeInstanceOf(ForbiddenError); await expect(service.orderEvidence(context, [own.orders[0]!])).rejects.toBeInstanceOf(ForbiddenError); expect(await state()).toEqual(before);
  });
  it("records statement and FX receipts with FinanceWrite only without requiring or granting FinanceRead", async () => {
    await grant(context, [Permission.FinanceWrite]); const writer = { ...context, permissions: [Permission.FinanceWrite] };
    const input = monetaryStatement("USD", [monetaryFact("USD", 29)]), statement = await service.recordStatement(writer, input);
    expect(statement.lines[0]).toMatchObject({ amountMinor: 29, sourceEntryId: input.lines[0]!.sourceEntryId });
    expect((await service.recordStatement(writer, input)).id).toBe(statement.id);
    const rate = await service.recordFxRate(writer, monetaryRate("EUR", "USD", 11, 10)); expect(rate.rateNumerator).toBe(11);
    await expect(service.getStatement(writer, statement.id)).rejects.toBeInstanceOf(ForbiddenError); await expect(service.workspace(writer)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("returns an authorized calculation receipt to FinanceReview only without opening separate financial readers", async () => {
    const basis = await calculation(); await grant(context, [Permission.FinanceReview]); const reviewer = { ...context, permissions: [Permission.FinanceReview] };
    const run = await service.calculateProfit(reviewer, basis.input); expect(run).toMatchObject({ status: "complete", profitMinor: 8000, sourceIdentityVersion: 1 });
    await expect(service.getProfitRun(reviewer, run.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await service.upsertProfitMetric(reviewer, metricInput())).version.versionNumber).toBe(1);
  });
  it.each(["statement", "rate", "metric", "run"] as const)("rolls %s facts, version changes and its final audit back in one transaction", async operation => {
    const actions = await operations(), before = await state(), spy = vi.spyOn(audit, "recordInTransaction").mockRejectedValue(new Error("Synthetic authority audit unavailable"));
    await expect(actions[operation]()).rejects.toThrow("Synthetic authority audit unavailable"); expect(spy).toHaveBeenCalledOnce(); expect(await state()).toEqual(before);
    spy.mockRestore(); await actions[operation](); const after = await state(); await actions[operation](); expect(await state()).toEqual(after);
  });
  it("rejects new legacy-shaped financial inputs rather than claiming an unrecorded event identity", async () => {
    const { sourceIdentity: omittedSource, ...original } = monetaryStatement("USD", [monetaryFact("USD", 100)]); void omittedSource;
    const legacy = { ...original, lines: original.lines.map(({ sourceEntryId, ...line }) => { void sourceEntryId; return line; }) }, before = await state();
    await expect(service.recordStatement(context, legacy)).rejects.toMatchObject({ status: 409, response: { code: "finance_source_identity_required" } }); expect(await state()).toEqual(before);
  });
  it("keeps a supplier document number inside the real supplier scope, not the shared provider name", async () => {
    const number = `SYNTHETIC-INVOICE-${randomUUID()}`, entry = `synthetic-source-component:${randomUUID()}`;
    const supplierInput = (supplierId: string) => monetaryStatement("USD", [monetaryFact("USD", 100, { supplierId, sourceEntryId: entry })], {
      provider: "supplier", statementKind: "supplier_invoice", externalStatementId: number, sourceIdentity: { schemaVersion: 2, kind: "supplier", supplierId } });
    const a = supplierInput(own.suppliers[0]!), first = await service.recordStatement(context, a), b = await service.recordStatement(context, supplierInput(own.suppliers[1]!));
    expect(b.id).not.toBe(first.id); const before = await state();
    expect((await service.recordStatement(context, { ...a, idempotencyKey: key() })).id).toBe(first.id); expect(await state()).toEqual(before);
    await expect(service.recordStatement(context, { ...a, idempotencyKey: key(), lines: [{ ...a.lines[0]!, amountMinor: 101 }] })).rejects.toMatchObject({ status: 409 });
    await expect(service.recordStatement(coworker, a)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects the same economic component across different statements but permits different components with identical amounts", async () => {
    const input = monetaryStatement("USD", [monetaryFact("USD", 100)]); await service.recordStatement(context, input); const before = await state();
    await expect(service.recordStatement(context, { ...input, externalStatementId: key(), idempotencyKey: key() })).rejects.toMatchObject({ status: 409, response: { code: "finance_source_entry_already_recorded" } });
    expect(await state()).toEqual(before);
    const other = await service.recordStatement(context, { ...input, externalStatementId: key(), idempotencyKey: key(), lines: [{ ...input.lines[0]!, sourceEntryId: key() }] });
    expect(other.lines[0]!.amountMinor).toBe(100); expect(other.lines[0]!.sourceEntryId).not.toBe(input.lines[0]!.sourceEntryId);
  });
  it("serializes two simultaneous documents that name the same economic component into one actual fact", async () => {
    const input = monetaryStatement("USD", [monetaryFact("USD", 100)]), before = await state();
    const settled = await Promise.allSettled([service.recordStatement(context, input), service.recordStatement(context, { ...input, externalStatementId: key(), idempotencyKey: key() })]);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((settled.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const after = await state(); expect(after.finance_facts!.count).toBe(before.finance_facts!.count + 1); expect(after.finance_statements!.count).toBe(before.finance_statements!.count + 1);
    expect(after.audit_events!.count).toBe(before.audit_events!.count + 1);
  });
  it.each(["line_order", "account_order", "sku_line", "listing_spu"] as const)("rejects a genuine but contradictory %s reference instead of merely checking that both IDs exist", async mismatch => {
    const line = monetaryFact("USD", 100, { orderId: own.orders[0]!, orderLineId: own.lines[0]!, skuId: own.skus[0]!, listingId: own.listings[0]! });
    const accountId = mismatch === "account_order" ? own.accounts[1]! : own.accounts[0]!;
    if (mismatch === "line_order") line.orderLineId = own.lines[1]!; if (mismatch === "sku_line") line.skuId = own.skus[1]!; if (mismatch === "listing_spu") line.listingId = own.listings[1]!;
    const before = await state(); await expect(service.recordStatement(context, monetaryStatement("USD", [line], {
      accountId, provider: "etsy", sourceIdentity: { schemaVersion: 2, kind: "marketplace_account" } }))).rejects.toMatchObject({ status: 422 }); expect(await state()).toEqual(before);
  });
  it("retains a valid full parent-child attribution and permits independent unassigned evidence without inventing a parent", async () => {
    const line = monetaryFact("USD", 100, { orderId: own.orders[0]!, orderLineId: own.lines[0]!, skuId: own.skus[0]!, listingId: own.listings[0]! });
    const attributed = await service.recordStatement(context, monetaryStatement("USD", [line], { accountId: own.accounts[0]!, provider: "etsy", sourceIdentity: { schemaVersion: 2, kind: "marketplace_account" } }));
    expect(attributed.lines[0]).toMatchObject({ orderId: own.orders[0], orderLineId: own.lines[0], skuId: own.skus[0], listingId: own.listings[0] });
    const unassigned = await fixture.statement("USD", [monetaryFact("USD", 100)]); expect(unassigned.lines[0]).toMatchObject({ orderId: null, orderLineId: null, skuId: null, listingId: null });
  });
  it("enforces current membership and RLS for every referenced foreign object and direct SQL read", async () => {
    const original = await fixture.statement("USD", [monetaryFact("USD", 100)]);
    await expect(service.getStatement(outsider, original.id)).rejects.toMatchObject({ status: 404 });
    expect((await service.orderEvidence(outsider, [own.orders[0]!])).facts).toEqual([]);
    expect(await withTenant(database.db, outsider, tx => tx.select().from(financeFacts))).toEqual([]);
    for (const line of [monetaryFact("USD", 100, { orderId: foreign.orders[0]! }), monetaryFact("USD", 100, { supplierId: foreign.suppliers[0]! })])
      await expect(service.recordStatement(context, monetaryStatement("USD", [line]))).rejects.toMatchObject({ status: 404 });
  });
  it("keeps reversals and replacements on one original root and the same real source scope", async () => {
    const original = await fixture.statement("USD", [monetaryFact("USD", 100)]), root = original.lines[0]!;
    const reversal = monetaryFact("USD", 100, { correctionKind: "reversal", correctsFactId: root.id });
    await expect(service.recordStatement(context, monetaryStatement("USD", [reversal], { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "DIFFERENT-SYNTHETIC-SOURCE" } }))).rejects.toMatchObject({ status: 422 });
    const reversed = await fixture.statement("USD", [reversal]);
    const before = await state();
    await expect(fixture.statement("USD", [monetaryFact("USD", 100, { correctionKind: "reversal", correctsFactId: reversed.lines[0]!.id })])).rejects.toMatchObject({ status: 422 });
    expect(await state()).toEqual(before);
    const replacement = await fixture.statement("USD", [monetaryFact("USD", 80, { correctionKind: "replacement", correctsFactId: root.id })]);
    expect(replacement.lines[0]).toMatchObject({ correctsFactId: root.id, correctionKind: "replacement", amountMinor: 80 });
    await expect(fixture.statement("USD", [monetaryFact("USD", 100, { correctionKind: "reversal", correctsFactId: root.id })])).rejects.toMatchObject({ status: 409 });
  });
  it("serializes optimistic metric updates and binds each replay to its original metric, actor and expected version", async () => {
    const created = await service.upsertProfitMetric(context, metricInput()), a = metricInput({ metricId: created.id, expectedVersion: 1 }), b = metricInput({ metricId: created.id, expectedVersion: 1 });
    const settled = await Promise.allSettled([service.upsertProfitMetric(context, a), service.upsertProfitMetric(context, b)]);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1); expect((settled.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const winnerIndex = settled.findIndex(result => result.status === "fulfilled"), winnerInput = winnerIndex === 0 ? a : b;
    const winner = (settled[winnerIndex] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.upsertProfitMetric>>>).value;
    expect(winner.version.versionNumber).toBe(2); await service.upsertProfitMetric(context, metricInput({ metricId: created.id, expectedVersion: 2 }));
    const replay = await service.upsertProfitMetric(context, winnerInput); expect(replay.version.id).toBe(winner.version.id); expect(replay.version.versionNumber).toBe(2);
    const other = await service.upsertProfitMetric(context, metricInput());
    const before = await state(); await expect(service.upsertProfitMetric(coworker, winnerInput)).rejects.toMatchObject({ status: 409 });
    await expect(service.upsertProfitMetric(context, { ...winnerInput, metricId: other.id })).rejects.toMatchObject({ status: 409 });
    await expect(service.upsertProfitMetric(context, { ...winnerInput, expectedVersion: 3 })).rejects.toMatchObject({ status: 409 });
    const versions = await withTenant(database.db, context, tx => tx.select({ number: financeProfitMetricVersions.versionNumber }).from(financeProfitMetricVersions).where(eq(financeProfitMetricVersions.metricId, created.id)));
    expect(versions.map(row => row.number).sort()).toEqual([1, 2, 3]); expect(await state()).toEqual(before);
  });
  it("deduplicates identical concurrent metric submissions and refuses missing optimistic authority for a new update", async () => {
    const input = metricInput(), values = await Promise.all([service.upsertProfitMetric(context, input), service.upsertProfitMetric(context, input)]);
    expect(values[0]!.version.id).toBe(values[1]!.version.id); const before = await state();
    await expect(service.upsertProfitMetric(context, metricInput({ metricId: values[0]!.id }))).rejects.toMatchObject({ status: 409 });
    await expect(service.upsertProfitMetric(context, metricInput({ expectedVersion: 1 }))).rejects.toThrow(); expect(await state()).toEqual(before);
  });
  async function dimensions(actor: TenantContext) {
    const result = { accounts: [] as string[], suppliers: [] as string[], orders: [] as string[], lines: [] as string[], skus: [] as string[], listings: [] as string[] };
    for (let index = 0; index < 2; index++) await withTenant(database.db, actor, async tx => {
      const account = createEntityId(), supplier = createEntityId(), product = createEntityId(), spu = createEntityId(), sku = createEntityId(), listing = createEntityId();
      const snapshot = createEntityId(), order = createEntityId(), line = createEntityId(), code = `AUTH-${sku.toUpperCase()}`;
      await tx.execute(sql`insert into marketplace_accounts(id,tenant_id,platform,display_name,region,marketplace_ids,authorization_mode,status)
        values(${account},${actor.tenantId},'etsy',${`Synthetic financial account ${account}`},'GLOBAL','["US"]'::jsonb,'etsy_oauth','active')`);
      await tx.execute(sql`insert into fulfillment_suppliers(id,tenant_id,name,kind,region_code,settlement_currency,created_by)
        values(${supplier},${actor.tenantId},${`Synthetic financial supplier ${supplier}`},'manual','US','USD',${actor.userId})`);
      await tx.execute(sql`insert into product_plans(id,tenant_id,name,customization) values(${product},${actor.tenantId},${`Synthetic financial product ${product}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into spus(id,tenant_id,product_plan_id,code,name,customization) values(${spu},${actor.tenantId},${product},${`SPU-${code}`},${`Synthetic financial SPU ${spu}`},'{"version":1,"fields":[]}'::jsonb)`);
      await tx.execute(sql`insert into skus(id,tenant_id,spu_id,code,status) values(${sku},${actor.tenantId},${spu},${code},'active')`);
      await tx.execute(sql`insert into listings(id,tenant_id,spu_id,platform,marketplace_id,locale,status) values(${listing},${actor.tenantId},${spu},'etsy','US','en-US','approved')`);
      await tx.execute(sql`insert into order_source_snapshots(id,tenant_id,account_id,platform,external_event_id,external_order_id,normalized_order_id,redacted_payload,payload_checksum)
        values(${snapshot},${actor.tenantId},${account},'etsy',${key()},${order},${order},'{}'::jsonb,${"a".repeat(64)})`);
      await tx.execute(sql`insert into orders(id,tenant_id,account_id,source_snapshot_id,platform,external_order_id,provider_status,order_total_minor,order_currency,line_count,placed_at)
        values(${order},${actor.tenantId},${account},${snapshot},'etsy',${order},'paid',100,'USD',1,'2026-07-01T00:00:00Z')`);
      await tx.execute(sql`insert into order_lines(id,tenant_id,order_id,external_line_id,sku_code,title,quantity,unit_price_minor,unit_price_currency)
        values(${line},${actor.tenantId},${order},${line},${code},'Synthetic financial line',1,100,'USD')`);
      result.accounts.push(account); result.suppliers.push(supplier); result.orders.push(order); result.lines.push(line); result.skus.push(sku); result.listings.push(listing);
    });
    return result;
  }
});
