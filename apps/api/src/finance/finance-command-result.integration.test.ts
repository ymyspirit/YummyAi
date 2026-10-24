import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { FinanceCommandListSchema, FinanceCommandOriginalSchema } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandRecordedResultSchema, FinanceCommandResultPageSchema, financeCommandResultSections,
  readFinanceCommandResultCursorPosition, type FinanceCommandResultPage, type FinanceCommandResultSection } from "@yummyai/contracts/finance/finance-command-result";
import { connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { FinanceCommandService } from "./finance-command.service.js";
import { FinanceCommandResultReader } from "./finance-command-result.reader.js";
import { createFinanceCommandVault } from "./finance-command-vault.js";
import { financeCommandBusinessTables, financeCommandKey, financeCommandKinds, financeCommandPermission } from "./finance-command.fixtures.js";
import { financeCommandResultFixture, immutableFinanceExecution, requireFinanceCommandResultFixture } from "./finance-command-result.fixtures.js";

requireFinanceCommandResultFixture();
const denied = { status: 403 }, missing = { status: 404 }, conflict = { status: 409 }, invalid = { status: 400 };
const code = (value: string) => ({ response: { code: value } });

describe.sequential("own historical finance results survive private-input disposal without rewriting execution", () => {
  const database = connectDatabase(), fixture = financeCommandResultFixture(database), { f, complete } = fixture;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 90_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.restoreRights(); await f.cleanupCommands(); }, 60_000);
  afterAll(async () => { try { await f.restoreRights(); await f.cleanupCommands(); } finally { f.destroy(); await database.client.end(); } }, 60_000);
  async function page(context: TenantContext, commandId: string, section: FinanceCommandResultSection, limit = 25, cursor?: string) {
    return FinanceCommandResultPageSchema.parse(await f.service().recordedResultEntries(context, commandId, { section, limit, ...(cursor ? { cursor } : {}) }));
  }
  async function allPages(context: TenantContext, commandId: string, section: FinanceCommandResultSection, limit: number) {
    const pages: FinanceCommandResultPage[] = []; let next: string | undefined;
    do {
      const current = await page(context, commandId, section, limit, next); pages.push(current);
      expect(current.offset).toBe(pages.slice(0, -1).reduce((sum, prior) => sum + prior.items.length, 0));
      next = current.nextCursor ?? undefined;
      if (pages.length > 1000) throw new Error("Immutable collection did not terminate");
    } while (next);
    return pages;
  }

  it.each(financeCommandKinds)("reads actual %s under operation-only authority, then after ack under Read-only with no writes", async kind => {
    const scenario = await f.scenario(kind), permission = financeCommandPermission(kind), narrow = { ...scenario.context, permissions: [permission] };
    await f.rights(scenario.context, [permission]);
    const { done, result } = await complete({ ...scenario, context: narrow });
    expect(result).toMatchObject({ commandId: done.id, kind, targetId: scenario.original.targetId, result: done.result, consistency: "immutable_execution" });
    expect(result.collections.map(row => row.section)).toEqual([...financeCommandResultSections[kind]]);
    expect(result.recorded.record.id).toBe(done.result!.id); expect(result).not.toHaveProperty("original");
    const before = await f.state(scenario.context);
    for (const collection of result.collections) {
      const rows = await allPages(narrow, done.id, collection.section, 1);
      expect(rows.flatMap<FinanceCommandResultPage["items"][number]>(item => item.items)).toHaveLength(collection.total);
      expect(rows.every(item => item.commandId === done.id && item.result.id === done.result!.id)).toBe(true);
    }
    expect(await f.state(scenario.context)).toEqual(before);
    await f.commands.acknowledge(narrow, done.id);
    expect((await f.row(scenario.context, done.id)).encrypted_input).toBeNull();
    await f.rights(scenario.context, [Permission.FinanceRead]);
    const reader = { ...scenario.context, permissions: [Permission.FinanceRead] }, fresh = f.service(), acknowledged = await f.state(scenario.context);
    const restored = FinanceCommandRecordedResultSchema.parse(await fresh.recordedResult(structuredClone(reader), done.id));
    expect(immutableFinanceExecution(restored)).toEqual(immutableFinanceExecution(result));
    expect((await fresh.list(reader, { kind, targetId: scenario.original.targetId ?? "root", view: "active" })).items.some(item => item.id === done.id)).toBe(false);
    const history = FinanceCommandListSchema.parse(await fresh.list(reader, { kind, targetId: scenario.original.targetId ?? "root", view: "recorded" }));
    expect(history.items.some(item => item.id === done.id && item.status === "succeeded" && item.acknowledged)).toBe(true);
    for (const collection of restored.collections) expect((await page(reader, done.id, collection.section)).total).toBe(collection.total);
    expect(await f.state(scenario.context)).toEqual(acknowledged);
  }, 60_000);

  it("keeps the first bill credit execution balance after a later debit and a current allocation", async () => {
    const scenario = await f.scenario("bill_adjustment_record"), { done, result } = await complete(scenario);
    if (result.recorded.kind !== "bill_adjustment_record") throw new Error("Actual bill adjustment expected");
    expect(result.recorded.record.balanceAfter).toMatchObject({ amountMinor: 100, creditMinor: 20, netAmountMinor: 80, allocatedMinor: 0, outstandingMinor: 80 });
    await f.payable.adjustments.recordBillAdjustment(scenario.context, scenario.original.targetId!, { kind: "debit", expectedNetAmountMinor: 80, amountMinor: 5,
      externalDocumentId: financeCommandKey(), evidenceReference: "Synthetic later actual debit", occurredAt: "2026-07-04T00:00:00.000Z",
      reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() });
    const payment = await f.payable.payment(85); await f.payable.allocate(payment.id, scenario.original.targetId!, 30);
    const current = (await f.payable.workspace()).bills.find(item => item.id === scenario.original.targetId);
    expect(current).toMatchObject({ netAmountMinor: 85, allocatedMinor: 30, outstandingMinor: 55 });
    await f.commands.acknowledge(scenario.context, done.id);
    const before = await f.state(scenario.context), restored = await f.service().recordedResult(structuredClone(scenario.context), done.id);
    expect(immutableFinanceExecution(restored)).toEqual(immutableFinanceExecution(result));
    expect(await f.state(scenario.context)).toEqual(before);
  });

  it("retains the original refund balance after another actual refund without reading today's payment balance", async () => {
    const scenario = await f.scenario("payment_adjustment_record"), { done, result } = await complete(scenario);
    if (result.recorded.kind !== "payment_adjustment_record") throw new Error("Actual refund expected");
    expect(result.recorded.record.balanceAfter).toMatchObject({ amountMinor: 100, refundedMinor: 20, netAmountMinor: 80, unallocatedMinor: 80 });
    await f.payable.adjustments.recordPaymentAdjustment(scenario.context, scenario.original.targetId!, { kind: "refund", expectedNetAmountMinor: 80, amountMinor: 10,
      externalDocumentId: financeCommandKey(), evidenceReference: "Synthetic second actual refund", occurredAt: "2026-07-04T00:00:00.000Z",
      reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() });
    const current = (await f.payable.workspace()).payments.find(item => item.id === scenario.original.targetId);
    expect(current).toMatchObject({ refundedMinor: 30, netAmountMinor: 70 });
    expect(immutableFinanceExecution(await f.service().recordedResult(scenario.context, done.id))).toEqual(immutableFinanceExecution(result));
  });

  it("keeps original batch allocations after a release without fabricating a saved execution balance", async () => {
    const scenario = await f.scenario("payment_allocate"), { done, result } = await complete(scenario);
    const before = await page(scenario.context, done.id, "allocations");
    if (before.section !== "allocations") throw new Error("Actual allocations expected");
    const first = before.items[0]!;
    await f.payable.payables.release(scenario.context, first.id, { reasonCode: "SOURCE_CHANGED", idempotencyKey: financeCommandKey() });
    expect((await f.payable.workspace()).allocations.find(item => item.id === first.id)).toHaveProperty("released", true);
    expect((await page(scenario.context, done.id, "allocations")).items).toEqual(before.items);
    expect(result.recorded).toHaveProperty("balanceSnapshot", "not_saved");
    for (const item of before.items) { expect(item).not.toHaveProperty("released"); expect(item).not.toHaveProperty("balanceAfter"); }
  });

  it("reads a retained and then seven-day-redacted successful original with an unusable vault and preserves actual facts", async () => {
    const scenario = await f.scenario("statement_record"), { done, result } = await complete(scenario), wrongKey = randomBytes(32);
    const wrongVault = createFinanceCommandVault({ NODE_ENV: "production", FINANCE_COMMAND_ENCRYPTION_KEY: wrongKey.toString("base64url") }); wrongKey.fill(0);
    const decrypt = vi.spyOn(wrongVault, "withSecret").mockImplementation(() => { throw new Error("Historical result must never decrypt an original"); });
    const resumed = new FinanceCommandService(database, wrongVault, f.adapter, f.audit, new FinanceCommandResultReader());
    const facts = await f.state(scenario.context, [...financeCommandBusinessTables, "finance_original_write_proofs"]);
    expect((await f.row(scenario.context, done.id)).encrypted_input).not.toBeNull();
    expect(immutableFinanceExecution(await resumed.recordedResult(scenario.context, done.id))).toEqual(immutableFinanceExecution(result));
    const originalRows = (await page(scenario.context, done.id, "facts")).items;
    expect(await fixture.expireOwnedInput(scenario.context, done.id)).toBe(1);
    expect(await f.row(scenario.context, done.id)).toMatchObject({ status: "succeeded", encrypted_input: null, result_id: done.result!.id });
    const original = FinanceCommandOriginalSchema.parse(await f.commands.original(scenario.context, done.id)); expect(original.original).toBeNull();
    expect(immutableFinanceExecution(await resumed.recordedResult(scenario.context, done.id))).toEqual(immutableFinanceExecution(result));
    expect((await resumed.recordedResultEntries(scenario.context, done.id, { section: "facts" })).items).toEqual(originalRows);
    expect(decrypt).not.toHaveBeenCalled(); expect(await f.state(scenario.context, [...financeCommandBusinessTables, "finance_original_write_proofs"])).toEqual(facts);
  });

  it("paginates every one of101 approved period shares at25 and100 after ack and a newer approved version", async () => {
    const large = await fixture.largeApproval(), context = f.cost.context, { done, result } = large;
    if (result.recorded.kind !== "cost_version_approve") throw new Error("Actual approved rule expected");
    expect(result.recorded.record).toMatchObject({ sourceCount: 1, shareCount: 101, preview: { previewChecksum: large.preview.previewChecksum, reportingCurrency: "USD" } });
    const baseline = (await allPages(context, done.id, "cost_shares", 25)).flatMap<FinanceCommandResultPage["items"][number]>(row => row.items);
    expect(baseline).toHaveLength(101);
    const sources = await page(context, done.id, "cost_sources", 25); expect(sources.items).toHaveLength(1); expect(sources.items[0]).not.toHaveProperty("shares");
    const input = { ...f.cost.previewInput(large.basis, "period", ["2026-07"]), allocationId: done.result!.parentId!, expectedVersion: 1 };
    const preview = await f.cost.allocations.preview(context, input);
    await complete({ context, original: { kind: "cost_version_approve", targetId: done.result!.parentId!,
      input: { ...input, previewChecksum: preview.previewChecksum, idempotencyKey: financeCommandKey() } } });
    await f.commands.acknowledge(context, done.id);
    await f.rights(context, [Permission.FinanceReview]); const reviewer = { ...context, permissions: [Permission.FinanceReview] };
    const before = await f.state(context), restored = FinanceCommandRecordedResultSchema.parse(await f.service().recordedResult(reviewer, done.id));
    expect(immutableFinanceExecution(restored)).toEqual(immutableFinanceExecution(result));
    expect(restored.currentVerification).toMatchObject({ verified: false, problems: expect.arrayContaining(["rule_superseded"]) });
    const twentyFive = await allPages(reviewer, done.id, "cost_shares", 25), hundred = await allPages(reviewer, done.id, "cost_shares", 100);
    expect(twentyFive.map(row => row.items.length)).toEqual([25, 25, 25, 25, 1]); expect(hundred.map(row => row.items.length)).toEqual([100, 1]);
    const rows = hundred.flatMap(row => row.section === "cost_shares" ? row.items : []);
    expect(rows).toEqual(baseline); expect(rows.map(row => row.share.target.key)).toEqual(large.keys);
    expect(rows.filter(row => row.share.amountMinor === 0)).toHaveLength(100);
    expect(rows.reduce((sum, row) => sum + BigInt(row.share.amountMinor), 0n)).toBe(1n);
    expect(rows.map(({ sourceIndex, shareIndex, source, share }) => ({ sourceIndex, shareIndex, source,
      share }))).toEqual(large.preview.sources.flatMap((source, sourceIndex) => {
      const { shares, ...header } = source;
      return shares.map((share, shareIndex) => ({ sourceIndex, shareIndex, source: header, share }));
    }));
    expect(await f.state(context)).toEqual(before);
  }, 90_000);

  it("retains saved profit row totals and contributions without inventing historical breakdowns or substituting newer calculations", async () => {
    const scenario = await f.scenario("profit_calculate"), { done, result } = await complete(scenario);
    if (result.recorded.kind !== "profit_calculate" || !scenario.costBasis) throw new Error("Actual saved profit expected");
    const saved = await fixture.savedProfit(scenario.context, done.result!.id);
    expect(result.recorded.record).toMatchObject(saved); expect(result.recorded.record).not.toHaveProperty("breakdowns");
    const contributions = (await allPages(scenario.context, done.id, "contributions", 3)).flatMap<FinanceCommandResultPage["items"][number]>(row => row.items);
    expect(contributions).toEqual(expect.arrayContaining(scenario.costBasis.base.contributions.map(row => expect.objectContaining({ factId: row.factId, reportingAmountMinor: row.reportingAmountMinor }))));
    await f.cost.finance.upsertProfitMetric(scenario.context, { metricId: scenario.costBasis.metric.id, expectedVersion: 1, name: "A later metric name",
      reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
      reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() });
    expect(immutableFinanceExecution(await f.service().recordedResult(scenario.context, done.id))).toEqual(immutableFinanceExecution(result));
    expect((await allPages(scenario.context, done.id, "contributions", 3)).flatMap<FinanceCommandResultPage["items"][number]>(row => row.items)).toEqual(contributions);
  });

  it("keeps the recorded metric name and immutable version when a later version renames the metric", async () => {
    const scenario = await f.scenario("metric_upsert"), { done, result } = await complete(scenario);
    if (scenario.original.kind !== "metric_upsert") throw new Error("Actual metric expected");
    await f.cost.finance.upsertProfitMetric(scenario.context, { ...scenario.original.input, metricId: done.result!.parentId!, expectedVersion: 1,
      name: "A different current metric name", idempotencyKey: financeCommandKey() });
    const restored = await f.service().recordedResult(scenario.context, done.id);
    expect(immutableFinanceExecution(restored)).toEqual(immutableFinanceExecution(result));
    expect(restored.recorded.record).toMatchObject({ id: done.result!.id, name: scenario.original.input.name, versionNumber: 1 });
  });

  it("reads a true20000-fact calculation after ack with bounded metadata and exact first and final contribution pages", async () => {
    const scenario = await f.scenario("statement_record"); if (scenario.original.kind !== "statement_record") throw new Error("Actual statement expected");
    const firstLine = scenario.original.input.lines[0]!, component = financeCommandKey();
    const original = { ...scenario.original, input: { ...scenario.original.input,
      lines: Array.from({ length: 20_000 }, (_, index) => ({ ...firstLine, lineKey: `row-${String(index).padStart(5, "0")}`,
        sourceEntryId: `${component}:${index}`, amountMinor: index === 0 ? 600_000_000 : index + 1,
        factType: index === 0 ? "sale_revenue" as const : "production_cost" as const,
        direction: index === 0 ? "credit" as const : "debit" as const, externalReference: `合成完整原财务事实 ${index}` })) } };
    const statement = await complete({ context: scenario.context, original });
    const metric = await f.cost.finance.upsertProfitMetric(scenario.context, { metricId: null, name: financeCommandKey(), reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
      reasonCode: "SYNTHETIC", idempotencyKey: financeCommandKey() });
    const profit = await complete({ context: scenario.context, original: { kind: "profit_calculate", targetId: metric.id,
      input: { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.done.result!.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: financeCommandKey() } } });
    await f.commands.acknowledge(scenario.context, statement.done.id); await f.commands.acknowledge(scenario.context, profit.done.id);
    const before = await f.state(scenario.context), header = FinanceCommandRecordedResultSchema.parse(await f.service().recordedResult(structuredClone(scenario.context), profit.done.id));
    expect(header.collections).toEqual([{ section: "contributions", total: 20_000 }]);
    expect(header.recorded.record).not.toHaveProperty("contributions"); expect(header.recorded.record).not.toHaveProperty("breakdowns");
    expect(JSON.stringify(header)).not.toContain(component); expect(JSON.stringify(header)).not.toContain("合成完整原财务事实");
    expect(Buffer.byteLength(JSON.stringify(header), "utf8")).toBeLessThan(64 * 1024);
    const first = await page(scenario.context, profit.done.id, "contributions", 100);
    if (first.section !== "contributions") throw new Error("Actual contribution page expected");
    expect(first.items).toHaveLength(100); expect(first.total).toBe(20_000);
    const position = readFinanceCommandResultCursorPosition(first.nextCursor!); if (!position) throw new Error("Actual result continuation missing");
    // The cursor is a verified position, not a capability or an enforced page
    // sequence. Read its real offset-1 anchor independently; no fact is altered.
    const [anchor] = await withTenant(database.db, scenario.context, tx => tx.execute<{ id: string }>(sql`
      select c.id from finance_profit_contributions c join finance_facts fact on fact.tenant_id=c.tenant_id and fact.id=c.fact_id
      where c.run_id=${profit.done.result!.id}::uuid order by fact.occurred_at,fact.id,c.id offset 19899 limit 1`));
    if (!anchor) throw new Error("Actual final-page anchor missing");
    const finalCursor = Buffer.from(JSON.stringify({ ...position, offset: 19900, anchor: anchor.id })).toString("base64url");
    const final = await page(scenario.context, profit.done.id, "contributions", 100, finalCursor);
    if (final.section !== "contributions") throw new Error("Actual final contribution page expected");
    expect(final).toMatchObject({ offset: 19900, total: 20_000, hasMore: false, nextCursor: null }); expect(final.items).toHaveLength(100);
    expect(new Set([...first.items, ...final.items].map(item => item.id)).size).toBe(200);
    const expectedPages = await withTenant(database.db, scenario.context, async tx => {
      const output = [];
      for (const offset of [0, 19900]) output.push(await tx.execute<{ id: string; factId: string; lineKey: string; amount: string; factType: string }>(sql`
        select c.id,fact.id as "factId",fact.line_key as "lineKey",fact.amount_minor::text as amount,fact.fact_type as "factType"
        from finance_profit_contributions c join finance_facts fact on fact.tenant_id=c.tenant_id and fact.id=c.fact_id
        where c.run_id=${profit.done.result!.id}::uuid order by fact.occurred_at,fact.id,c.id offset ${offset} limit 100`));
      return output;
    });
    // Fact IDs are genuine UUIDv7 values, not the report's line-key ordering.
    // Independently read the actual ordered boundary rows and tie their money
    // back to each exact input line rather than assuming UUID insertion order.
    const originalByLine = new Map(original.input.lines.map(line => [line.lineKey, line]));
    for (const [index, actual] of [first.items, final.items].entries()) {
      const expected = expectedPages[index]!;
      for (const row of expected) expect(row.amount).toBe(String(originalByLine.get(row.lineKey)!.amountMinor));
      expect(actual.map(row => ({ id: row.id, factId: row.factId, sourceAmountMinor: row.sourceAmountMinor,
        reportingAmountMinor: row.reportingAmountMinor, factType: row.factType }))).toEqual(expected.map(row => ({
        id: row.id, factId: row.factId, sourceAmountMinor: Number(row.amount), reportingAmountMinor: Number(row.amount), factType: row.factType,
      })));
    }
    const saved = await fixture.savedProfit(scenario.context, profit.done.result!.id);
    expect(header.recorded.record).toMatchObject(saved);
    expect(await f.state(scenario.context)).toEqual(before);
  }, 180_000);

  it("revalidates current kind authority, data scope and membership even with a previous successful receipt and cursor", async () => {
    const scenario = await f.scenario("statement_record"), { done } = await complete(scenario), stale = structuredClone(scenario.context);
    for (const [rights, scope] of [[[Permission.FinanceReview], "tenant"], [[Permission.FinanceWrite], "self"], [[Permission.FinanceRead], "team"], [[], "tenant"]] as const) {
      await f.rights(scenario.context, [...rights], scope);
      await expect(f.service().recordedResult(stale, done.id)).rejects.toMatchObject(denied);
      await expect(f.service().recordedResultEntries(stale, done.id, { section: "facts" })).rejects.toMatchObject(denied);
    }
    await f.rights(scenario.context, [Permission.FinanceRead]);
    const readOnly = { ...scenario.context, permissions: [Permission.FinanceRead] };
    expect((await f.service().recordedResult(readOnly, done.id)).result).toEqual(done.result);
    await f.membership(scenario.context, "disabled");
    await expect(f.service().recordedResult(readOnly, done.id)).rejects.toMatchObject(denied);
    await f.membership(scenario.context, "active");
    const fakeSession = { ...scenario.context, permissions: [Permission.FinanceWrite] };
    await expect(f.service().recordedResult(fakeSession, done.id)).rejects.toMatchObject(denied);
  });

  it("never exposes another actor's command, cross-tenant result or raw result as a command", async () => {
    const scenario = await f.scenario("statement_record"), { done } = await complete(scenario);
    const before = await f.state(scenario.context);
    for (const actor of [scenario.coworker, scenario.outsider]) {
      await expect(f.service().recordedResult(actor, done.id)).rejects.toMatchObject(missing);
      await expect(f.service().recordedResultEntries(actor, done.id, { section: "facts" })).rejects.toMatchObject(missing);
    }
    await expect(f.service().recordedResult(scenario.context, done.result!.id)).rejects.toMatchObject(missing);
    const raw = await f.scenario("fx_rate_record"), actual = await f.raw(raw.original, raw.context);
    await expect(f.service().recordedResult(raw.context, actual.id)).rejects.toMatchObject(missing);
    await expect(f.commands.prepare(raw.context, raw.original)).rejects.toMatchObject(conflict);
    // Only the deliberately created raw rate can differ; no command/proof was
    // minted by either unsuccessful read.
    const after = await f.state(scenario.context);
    expect(after.finance_commands).toEqual(before.finance_commands);
  });

  it("rejects prepared, cancelled and expired originals without manufacturing a successful result", async () => {
    const scenario = await f.scenario("fx_rate_record"), prepared = await f.commands.prepare(scenario.context, scenario.original);
    const before = await f.state(scenario.context);
    await expect(f.service().recordedResult(scenario.context, prepared.id)).rejects.toMatchObject({ ...conflict, ...code("finance_command_result_not_available") });
    await expect(f.service().recordedResultEntries(scenario.context, prepared.id, { section: "facts" })).rejects.toMatchObject(conflict);
    expect(await f.state(scenario.context)).toEqual(before);
    await f.commands.cancel(scenario.context, prepared.id);
    await expect(f.service().recordedResult(scenario.context, prepared.id)).rejects.toMatchObject({ ...conflict, ...code("finance_command_result_not_available") });
    await f.commands.acknowledge(scenario.context, prepared.id);
    const due = await f.scenario("fx_rate_record"), pending = await f.commands.prepare(due.context, due.original);
    expect(await fixture.expireOwnedInput(due.context, pending.id)).toBe(1);
    await expect(f.service().recordedResult(due.context, pending.id)).rejects.toMatchObject({ ...conflict, ...code("finance_command_result_not_available") });
    expect((await f.commands.list(scenario.context, { kind: "fx_rate_record", view: "recorded" })).items.some(row => row.id === prepared.id || row.id === pending.id)).toBe(false);
  });

  it("binds cursor scope to original actor, result, section and page size and validates the actual previous row", async () => {
    const scenario = await f.scenario("profit_calculate"), { done } = await complete(scenario), first = await page(scenario.context, done.id, "contributions", 2);
    const next = first.nextCursor!; expect(next).toBeTruthy();
    const position = readFinanceCommandResultCursorPosition(next); if (!position) throw new Error("Actual canonical result cursor missing");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [encode({ ...position, anchor: createEntityId() }), encode({ ...position, offset: position.offset + 1 }),
      encode({ ...position, offset: 100000 }), encode({ ...position, scope: "0".repeat(64) }), next + "=",
      Buffer.from(` {"v":1,"scope":"${position.scope}","offset":${position.offset},"anchor":"${position.anchor}"}`).toString("base64url"),
      Buffer.from(`{"v":1,"scope":"${position.scope}","offset":1,"offset":${position.offset},"anchor":"${position.anchor}"}`).toString("base64url")])
      await expect(f.service().recordedResultEntries(scenario.context, done.id, { section: "contributions", limit: 2, cursor })).rejects.toMatchObject(invalid);
    await expect(f.service().recordedResultEntries(scenario.context, done.id, { section: "contributions", limit: 3, cursor: next })).rejects.toMatchObject(invalid);
    const other = await complete(await f.scenario("profit_calculate"));
    await expect(f.service().recordedResultEntries(scenario.context, other.done.id, { section: "contributions", limit: 2, cursor: next })).rejects.toMatchObject(invalid);
    await expect(f.service().recordedResultEntries(scenario.coworker, done.id, { section: "contributions", limit: 2, cursor: next })).rejects.toMatchObject(missing);
    const approval = await complete(await f.scenario("cost_version_approve")), sources = await page(scenario.context, approval.done.id, "cost_sources", 1);
    expect(sources.section).toBe("cost_sources");
    await expect(f.service().recordedResultEntries(scenario.context, approval.done.id, { section: "cost_sources", limit: 2, cursor: next })).rejects.toMatchObject(invalid);
    expect((await page(scenario.context, done.id, "contributions", 2, next)).offset).toBe(2);
  });

  it("rejects wrong sections and malformed queries without falling back to a ledger or current workspace", async () => {
    const scenario = await f.scenario("payment_record"), { done } = await complete(scenario), before = await f.state(scenario.context);
    await expect(f.service().recordedResultEntries(scenario.context, done.id, { section: "allocations" })).rejects.toMatchObject({ ...invalid, ...code("finance_command_result_section_invalid") });
    for (const query of [{ section: "facts", limit: "01" }, { section: "facts", limit: 101 }, { section: "facts", limit: 1.5 },
      { section: "facts", parentId: done.result!.id }, { section: ["facts", "slices"] }])
      await expect(f.service().recordedResultEntries(scenario.context, done.id, query)).rejects.toMatchObject(invalid);
    expect(await f.state(scenario.context)).toEqual(before);
  });
});
