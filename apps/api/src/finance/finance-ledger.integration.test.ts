import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceLedgerDetailViewSchema, FinanceLedgerKindSchema, FinanceLedgerPageViewSchema,
  financeLedgerDetailParentId, type FinanceLedgerKind } from "@yummyai/contracts/finance/ledger";
import { FinancePayablesWorkspaceViewSchema } from "@yummyai/contracts/finance/payables";
import { FinanceWorkspaceViewSchema } from "@yummyai/contracts/finance";
import { connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { financeLedgerFixture, requireFinanceLedgerFixture } from "./finance-ledger.fixtures.js";
import { adjustmentKey, protectedAdjustmentFacts, existingPayablesTables } from "./finance-payables-adjustments.fixtures.js";
import { monetaryFact, monetaryStatement, monetaryTables } from "./finance-monetary.fixtures.js";

requireFinanceLedgerFixture();
const status = (error: unknown) => (error as { status?: number; getStatus?: () => number }).status ?? (error as { getStatus?: () => number }).getStatus?.();
const denied = (error: unknown) => status(error) === 403;
const invalid = (error: unknown) => status(error) === 400;
const missing = (error: unknown) => status(error) === 404;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (cursor: string): Record<string, unknown> => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));

describe.sequential("complete authenticated finance ledger reads every actual page without changing evidence", () => {
  const database = connectDatabase(), f = financeLedgerFixture(database), { ledger, context } = f;
  let seeded: Awaited<ReturnType<typeof f.seed>>;
  beforeAll(async () => {
    await migrateDatabase(database); await f.initialize();
    expect(EntityIdSchema.safeParse(f.supplierId).success).toBe(true);
    expect(f.supplierId).toBe(f.procurement.supplierId);
    seeded = await f.seed();
  }, 120_000);
  afterEach(async () => { await f.restoreRights(); });
  afterAll(async () => { f.destroy(); await database.client.end(); });
  const parentFor = (kind: FinanceLedgerKind) => kind === "procurement_adjustments" ? seeded.procurementBillId : undefined;
  async function exhaust(kind: FinanceLedgerKind, parentId?: string, limit = 2) {
    let cursor: string | undefined, upperBoundId: string | null | undefined; const ids: string[] = [], rows = [];
    for (let index = 0; index < 1000; index++) {
      const page = FinanceLedgerPageViewSchema.parse(await ledger.list(context, { kind, parentId, limit, ...(cursor ? { cursor } : {}) }));
      expect(page).toMatchObject({ kind, parentId: parentId ?? null, limit, order: "id_desc", consistency: "live" });
      if (upperBoundId === undefined) upperBoundId = page.upperBoundId; else expect(page.upperBoundId).toBe(upperBoundId);
      ids.push(...page.items.map(row => row.id)); rows.push(...page.items);
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); return { ids, rows }; }
      expect(page.items).toHaveLength(limit); expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor!;
    }
    throw new Error("Synthetic ledger page failed to terminate");
  }
  it.each(FinanceLedgerKindSchema.options)("exhausts actual %s records in strict ID order with no omission, duplicate or embedded child data", async kind => {
    const before = await f.state([...new Set([...protectedAdjustmentFacts, ...existingPayablesTables, ...monetaryTables, "finance_bill_adjustments", "finance_payment_adjustments", "audit_events"])]);
    const result = await exhaust(kind, parentFor(kind));
    expect(result.ids).toEqual([...f.ids[kind]].sort().reverse()); expect(new Set(result.ids).size).toBe(result.ids.length);
    for (const row of result.rows) {
      expect(Object.keys(row).sort()).toEqual(["amountMinor", "currency", "id", "kind", "netAmountMinor", "parentId", "recordedAt", "reference", "status", "supplierId"].sort());
      if (kind === "profit_runs") expect(row).toMatchObject({ amountMinor: null, netAmountMinor: null, status: null });
      const detail = FinanceLedgerDetailViewSchema.parse(await ledger.detail(context, { kind, id: row.id, ...(parentFor(kind) ? { parentId: parentFor(kind) } : {}) }));
      expect(detail.id).toBe(row.id); expect(financeLedgerDetailParentId(detail)).toBe(row.parentId);
    }
    expect(await f.state(Object.keys(before))).toEqual(before);
  });
  it("reads child collections only from their actual parent and makes every declared relation traversable", async () => {
    for (const kind of ["statements", "metrics", "profit_runs", "bills", "payments", "allocations"] as const) {
      const id = f.ids[kind][0]!, detail = await ledger.detail(context, { kind, id });
      for (const child of detail.children) {
        const actual = await exhaust(child.kind, child.parentId, 1);
        expect(actual.rows.every(row => row.parentId === id)).toBe(true);
        const expected = f.ids[child.kind].filter(candidate => f.parents.get(candidate) === id).sort().reverse();
        expect(actual.ids).toEqual(expected);
      }
    }
    await expect(ledger.detail(context, { kind: "facts", id: f.ids.facts[0], parentId: f.ids.statements[1] })).rejects.toSatisfy(missing);
    await expect(ledger.list(context, { kind: "facts", parentId: createEntityId(), limit: 1 })).rejects.toSatisfy(missing);
    const emptySupplier = await f.supplier();
    expect(await ledger.list(context, { kind: "bills", parentId: emptySupplier, limit: 1 })).toMatchObject({ items: [], hasMore: false, nextCursor: null });
  });
  it("keeps original statement facts and profit contributions paged outside their original-owner headers", async () => {
    const statementId = f.ids.statements[0]!, runId = f.ids.profit_runs[0]!;
    const statement = await ledger.detail(context, { kind: "statements", id: statementId }); expect(statement.record).not.toHaveProperty("lines");
    const run = await ledger.detail(context, { kind: "profit_runs", id: runId }); expect(run.record).not.toHaveProperty("contributions");
    const original = await f.finance.getProfitRun(context, runId);
    const { contributions: originalContributions, ...originalHeader } = original;
    expect(run.record).toEqual(originalHeader);
    const items = await exhaust("contributions", runId, 1); expect(items.ids).toEqual(originalContributions.map(row => row.id).sort().reverse());
    for (const contribution of originalContributions) {
      const detail = await ledger.detail(context, { kind: "contributions", id: contribution.id, parentId: runId });
      expect(detail.record).toEqual({ ...contribution, runId });
    }
  });
  it("does not lose or reorder equal business timestamps and preserves the exact large minor integer in details", async () => {
    const rates = await exhaust("fx_rates", undefined, 1);
    const details = await Promise.all(rates.ids.map(id => ledger.detail(context, { kind: "fx_rates", id })));
    expect(details.every(detail => detail.kind === "fx_rates" && detail.record.effectiveAt === "2026-07-01T00:00:00.000Z")).toBe(true);
    const rows = await withTenant(database.db, context, tx => tx.execute<{ id: string; recordedAt: string }>(sql`select id,
      to_char(recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "recordedAt" from finance_fx_rates order by id desc`));
    expect(rates.rows.map(row => ({ id: row.id, recordedAt: row.recordedAt }))).toEqual(rows.map(row => ({ id: row.id, recordedAt: row.recordedAt })));
    const due = await f.bill(Number.MAX_SAFE_INTEGER, { currency: "KWD" });
    const detail = await ledger.detail(context, { kind: "bills", id: due.id, parentId: f.supplierId });
    expect(detail.record).toMatchObject({ amountMinor: Number.MAX_SAFE_INTEGER, netAmountMinor: Number.MAX_SAFE_INTEGER, currency: "KWD" });
  });
  it("holds the first upper ID bound across later inserts and makes refreshing start a new live traversal", async () => {
    const first = await ledger.list(context, { kind: "statements", limit: 1 }); expect(first.hasMore).toBe(true);
    const inserted = await f.finance.recordStatement(context, monetaryStatement("USD", [monetaryFact("USD", 1)]));
    const seen = first.items.map(row => row.id); let cursor = first.nextCursor!;
    for (;;) {
      const next = await ledger.list(context, { kind: "statements", limit: 1, cursor }); expect(next.upperBoundId).toBe(first.upperBoundId);
      seen.push(...next.items.map(row => row.id)); if (!next.hasMore) break; cursor = next.nextCursor!;
    }
    expect(seen).not.toContain(inserted.id); expect(seen).toEqual([...f.ids.statements].sort().reverse());
    const refreshed = await ledger.list(context, { kind: "statements", limit: 1 }); expect(refreshed.items[0]!.id).toBe(inserted.id);
  });
  it("rejects malformed, noncanonical, duplicate-property and nonexistent-anchor cursors instead of silently restarting", async () => {
    const first = await ledger.list(context, { kind: "payments", limit: 1 }), cursor = first.nextCursor!, parsed = decode(cursor);
    const raw = Buffer.from(cursor, "base64url").toString("utf8"), firstKey = Object.keys(parsed)[0]!;
    const duplicate = `${raw.slice(0, -1)},${JSON.stringify(firstKey)}:${JSON.stringify(parsed[firstKey])}}`;
    const cases = ["not_json", Buffer.from("null").toString("base64url"), `${cursor}=`,
      Buffer.from(JSON.stringify(parsed, null, 1)).toString("base64url"), Buffer.from(duplicate).toString("base64url"),
      encode({ ...parsed, id: createEntityId() }), encode({ ...parsed, upperId: createEntityId() }),
      encode({ ...parsed, upperId: [...f.ids.payments].sort()[0], id: [...f.ids.payments].sort().at(-1) }), encode({ ...parsed, unexpected: true })];
    for (const bad of cases) await expect(ledger.list(context, { kind: "payments", limit: 1, cursor: bad })).rejects.toSatisfy(invalid);
  });
  it("binds continuation to tenant, actor, record kind, parent filter and page size without treating it as authority", async () => {
    const page = await ledger.list(context, { kind: "bills", parentId: f.supplierId, limit: 1 }), cursor = page.nextCursor!;
    for (const [actor, input, expectedFailure] of [
      [f.coworker, { kind: "bills", parentId: f.supplierId, limit: 1, cursor }, invalid],
      [f.outsider, { kind: "bills", parentId: f.supplierId, limit: 1, cursor }, missing],
      [context, { kind: "payments", parentId: f.supplierId, limit: 1, cursor }, invalid],
      [context, { kind: "bills", limit: 1, cursor }, invalid],
      [context, { kind: "bills", parentId: f.supplierId, limit: 2, cursor }, invalid],
    ] as Array<[TenantContext, Record<string, unknown>, (error: unknown) => boolean]>) await expect(ledger.list(actor, input)).rejects.toSatisfy(expectedFailure);
  });
  it("rechecks live tenant Read authority for list, continuation and detail even when the old context still grants it", async () => {
    const first = await ledger.list(context, { kind: "bills", limit: 1 }); await f.rights(context, [Permission.FinanceWrite, Permission.FinanceReview]);
    for (const work of [() => ledger.list(context, { kind: "bills" }), () => ledger.list(context, { kind: "bills", limit: 1, cursor: first.nextCursor }),
      () => ledger.detail(context, { kind: "bills", id: f.ids.bills[0] })]) await expect(work()).rejects.toSatisfy(denied);
  });
  it("allows FinanceRead-only and denies fabricated permission, nonmember and self/team scoped reads", async () => {
    await f.rights(context, [Permission.FinanceRead]); const readonly = { ...context, permissions: [Permission.FinanceRead] };
    expect((await ledger.list(readonly, { kind: "payments", limit: 1 })).items).toHaveLength(1);
    expect((await ledger.detail(readonly, { kind: "payments", id: f.ids.payments[0] })).id).toBe(f.ids.payments[0]);
    await expect(ledger.list({ ...context, permissions: [] }, { kind: "bills" })).rejects.toSatisfy(denied);
    await expect(ledger.list({ ...context, userId: createEntityId() }, { kind: "bills" })).rejects.toSatisfy(denied);
    for (const scope of ["self", "team"] as const) { await f.rights(context, [Permission.FinanceRead], scope); await expect(ledger.list(context, { kind: "bills" })).rejects.toSatisfy(denied); }
  });
  it("returns no foreign evidence through authenticated detail, parent filters or direct forced-RLS reads", async () => {
    await expect(ledger.detail(f.outsider, { kind: "bills", id: f.ids.bills[0] })).rejects.toSatisfy(missing);
    await expect(ledger.list(f.outsider, { kind: "bills", parentId: f.supplierId })).rejects.toSatisfy(missing);
    const rows = await withTenant(database.db, f.outsider, tx => tx.execute(sql`select id from finance_payable_bills where id=${f.ids.bills[0]}`));
    expect(rows).toHaveLength(0);
  });
  it("keeps current balances computed from the entire ledger while immutable adjustment details retain their execution-time balance", async () => {
    const due = await f.bill(100), paid = await f.payment(100), batch = await f.allocate(paid.id, due.id, 60), allocation = batch.allocations[0]!;
    await f.payables.release(context, allocation.id, { reasonCode: "SOURCE_RECHECK", idempotencyKey: adjustmentKey() });
    const first = await f.adjustments.recordBillAdjustment(context, due.id, { ...f.common(100), kind: "credit", amountMinor: 20 });
    await f.adjustments.recordBillAdjustment(context, due.id, { ...f.common(80), kind: "debit", amountMinor: 5 });
    await f.allocate(paid.id, due.id, 85); await f.adjustments.recordPaymentAdjustment(context, paid.id, { ...f.common(100), kind: "refund", amountMinor: 15 });
    const tiny = await ledger.list(context, { kind: "bill_adjustments", parentId: due.id, limit: 1 }); expect(tiny.hasMore).toBe(true);
    const detail = await ledger.detail(context, { kind: "bills", id: due.id });
    expect(detail.record).toMatchObject({ amountMinor: 100, creditMinor: 20, debitMinor: 5, netAmountMinor: 85, allocatedMinor: 85, outstandingMinor: 0 });
    const old = await ledger.detail(context, { kind: "bill_adjustments", id: first.id, parentId: due.id });
    expect(old.record).toEqual(first); expect(first.balanceAfter.netAmountMinor).toBe(80);
    const actualPayment = await ledger.detail(context, { kind: "payments", id: paid.id });
    expect(actualPayment.record).toMatchObject({ amountMinor: 100, refundedMinor: 15, netAmountMinor: 85, allocatedMinor: 85, unallocatedMinor: 0 });
    expect((await ledger.detail(context, { kind: "allocations", id: allocation.id })).record).toMatchObject({ amountMinor: 60, released: true });
  });
  it("preserves an actual incomplete profit result and its original contribution evidence rather than promoting a paged list to verified profit", async () => {
    const statement = await f.finance.recordStatement(context, monetaryStatement("JPY", [
      monetaryFact("JPY", 1234, { factType: "sale_revenue", direction: "credit" }), monetaryFact("JPY", 100),
    ]));
    const metric = await f.finance.upsertProfitMetric(context, { metricId: null, name: `Synthetic incomplete ${adjustmentKey()}`, reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: adjustmentKey() });
    const original = await f.finance.calculateProfit(context, { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [],
      coverageDimension: "aggregate", idempotencyKey: adjustmentKey() });
    expect(original).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null });
    const detail = await ledger.detail(context, { kind: "profit_runs", id: original.id }), { contributions, ...header } = original;
    expect(detail.record).toEqual(header); const page = await ledger.list(context, { kind: "profit_runs", parentId: metric.id });
    expect(page.items[0]).toMatchObject({ id: original.id, amountMinor: null, netAmountMinor: null, status: null });
    const evidence = await exhaust("contributions", original.id, 1); expect(evidence.ids).toHaveLength(2);
    for (const originalContribution of contributions) {
      const actual = await ledger.detail(context, { kind: "contributions", id: originalContribution.id, parentId: original.id });
      expect(actual.record).toEqual({ ...originalContribution, runId: original.id }); expect(actual.record).toMatchObject({ reportingAmountMinor: null, sourceCurrency: "JPY" });
    }
  });
  it("keeps the existing workspace response contracts while reading an actual bill outside the 500-row workspace cap", async () => {
    const supplierId = await f.supplier(), ids: string[] = [];
    for (let index = 0; index < 501; index++) ids.push((await f.bill(100 + index, { supplierId })).id);
    const current = FinancePayablesWorkspaceViewSchema.parse(await f.workspace()); expect(current.truncated).toBe(true); expect(current.bills).toHaveLength(500);
    expect(current.bills.some(row => row.id === ids[0])).toBe(false);
    const pages = await exhaust("bills", supplierId, 100); expect(pages.ids).toEqual([...ids].sort().reverse());
    const old = await ledger.detail(context, { kind: "bills", id: ids[0], parentId: supplierId }); expect(old.record).toMatchObject({ id: ids[0], amountMinor: 100 });
    expect(FinanceWorkspaceViewSchema.safeParse(await f.finance.workspace(context)).success).toBe(true);
  }, 180_000);
});
