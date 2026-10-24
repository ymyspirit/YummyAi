import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { FinanceAllocatedProfitRunViewSchema, FinanceAllocatedProfitSlicePageSchema, FinanceCostAllocationPreviewViewSchema,
  type FinanceCostAllocationDimension } from "@yummyai/contracts/finance/cost-allocation";
import { connectDatabase, migrateDatabase, skus, withTenant } from "@yummyai/database";
import { costKey, costProtectedTables, costTables, financeCostAllocationFixture, requireFinanceCostAllocationFixture } from "./finance-cost-allocation.fixtures.js";

requireFinanceCostAllocationFixture();
const conflict = (code: string) => ({ status: 409, response: { code: `finance_cost_allocation_${code}` } });
const denied = (error: unknown) => error instanceof ForbiddenError || (error as { status?: number }).status === 403;
describe.sequential("approved exact cost attribution preserves original facts and immutable calculation versions", () => {
  const database = connectDatabase(), f = financeCostAllocationFixture(database), { context, finance, allocations } = f;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.restoreRights(); });
  afterAll(async () => { await database.client.end(); });
  const state = () => f.state([...costProtectedTables, ...costTables, "audit_events"]);
  async function slices(id: string, limit = 2) {
    const result = []; let cursor: string | undefined, upper: string | null | undefined;
    for (let index = 0; index < 100; index++) {
      const page = FinanceAllocatedProfitSlicePageSchema.parse(await allocations.slices(context, id, { limit, ...(cursor ? { cursor } : {}) }));
      if (upper === undefined) upper = page.upperBoundKey; else expect(page.upperBoundKey).toBe(upper);
      result.push(...page.items); if (!page.hasMore) return result; expect(page.items).toHaveLength(limit); expect(page.nextCursor).not.toBe(cursor); cursor = page.nextCursor!;
    }
    throw new Error("Synthetic allocation slice page failed to terminate");
  }
  async function approved() { const basis = await f.basis(), input = f.previewInput(basis), result = await f.approve(input); return { basis, input, ...result }; }

  it("previews 101 reporting minor units as 34/34/33 with complete actual target lineage and no business or audit writes", async () => {
    const b = await f.basis(), before = await state(), preview = FinanceCostAllocationPreviewViewSchema.parse(await allocations.preview(context, f.previewInput(b)));
    expect(preview.sources).toHaveLength(1); expect(preview.sources[0]).toMatchObject({ factId: b.root.id, sourceAmountMinor: 101, reportingAmountMinor: 101, effectSign: 1 });
    expect(preview.sources[0]!.shares.map(row => row.amountMinor)).toEqual([34, 34, 33]);
    for (const share of preview.sources[0]!.shares) {
      const target = f.own.find(row => row.lineId === share.target.key)!;
      expect(share.target).toMatchObject({ dimension: "order_line", orderId: target.orderId, orderLineId: target.lineId, skuId: target.skuId,
        accountId: target.accountId, spuId: target.spuId, catalogLinkId: target.catalogLinkId });
    }
    expect(await state()).toEqual(before);
  });
  it("approves an explicit version and projects the original contribution once without creating cost, invoice, payment or stock facts", async () => {
    const b = await f.basis(), original = await f.state(costProtectedTables), { version } = await f.approve(f.previewInput(b));
    expect(version).toMatchObject({ status: "approved", versionNumber: 1, previousVersionId: null, reviewedBy: context.userId, basisProblems: [] });
    const run = FinanceAllocatedProfitRunViewSchema.parse(await f.calculate(b, [version.id]));
    expect(run).toMatchObject({ status: "complete", revenueMinor: 3000, costMinor: 551, profitMinor: 2449, diagnostics: { checkedTargetCount: 3, unallocatedContributionIds: [], missingByTarget: [] } });
    expect(run.breakdowns.map(row => row.costMinor).sort()).toEqual([183, 184, 184]);
    const actual = await slices(run.id), source = actual.filter(row => row.sourceFactId === b.root.id);
    expect(source).toHaveLength(3); expect(source.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(101n);
    for (const originalContribution of b.base.contributions) {
      const attributed = actual.filter(row => row.baseContributionId === originalContribution.id);
      expect(attributed.reduce((sum, row) => sum + BigInt(row.amountMinor), 0n)).toBe(BigInt(originalContribution.reportingAmountMinor!));
      if (originalContribution.factId !== b.root.id) { expect(attributed).toHaveLength(1); expect(attributed[0]!.allocationVersionId).toBeNull(); }
    }
    expect(await f.state(costProtectedTables)).toEqual(original); expect(await finance.getProfitRun(context, b.base.id)).toEqual(b.base);
  });
  it("retains one full unknown-target slice and null aggregate claims when the source fee has no selected allocation", async () => {
    const b = await f.basis(), run = await f.calculate(b, []); expect(run).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, breakdowns: [] });
    const source = (await slices(run.id)).filter(row => row.sourceFactId === b.root.id); expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ target: null, amountMinor: 101, allocationVersionId: null });
    expect(run.diagnostics.unallocatedContributionIds).toEqual([b.base.contributions.find(row => row.factId === b.root.id)!.id]);
  });
  it("does not promote aggregate completeness to target profit when a second real target lacks its own required production cost", async () => {
    const b = await f.basis({ omitCostIndex: 1 }), { version } = await f.approve(f.previewInput(b)); expect(b.base.status).toBe("complete");
    const run = await f.calculate(b, [version.id]); expect(run).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, breakdowns: [] });
    expect(run.diagnostics.missingByTarget).toContainEqual({ key: f.own[1]!.lineId, missingFactTypes: ["production_cost"] });
  });
  it("converts the original foreign fee once before allocating and retains explicit zero reporting shares", async () => {
    const b = await f.basis({ currency: "EUR", amountMinor: 2 }), { preview, version } = await f.approve(f.previewInput(b));
    expect(preview.sources[0]).toMatchObject({ sourceAmountMinor: 2, sourceCurrency: "EUR", reportingAmountMinor: 1, fxRateId: b.rates[0]!.id });
    expect(preview.sources[0]!.shares.map(row => row.amountMinor)).toEqual([1, 0, 0]); const run = await f.calculate(b, [version.id]);
    expect(run).toMatchObject({ status: "complete", costMinor: 451, profitMinor: 2549 });
    expect((await slices(run.id)).filter(row => row.sourceFactId === b.root.id).map(row => row.amountMinor).sort()).toEqual([0, 0, 1]);
  });
  it("approves and persists an exact near-integer quotient without numeric division rounding away its floor or zero share", async () => {
    const b = await f.basis(), keys = b.targets.slice(0, 2).map(row => row.lineId).sort(), input = f.previewInput(b, "order_line", keys);
    input.method = "manual_weights";
    input.sources[0]!.targets = keys.map((key, index) => ({ key, weight: index === 0 ? "999999999999999999999.999999999" : "0.000000001" }));
    const { preview, version } = await f.approve(input), denominator = 10n ** 30n;
    expect(preview.sources[0]!.shares.map(row => ({ key: row.target.key, floor: row.floorMinor, amount: row.amountMinor, tail: row.receivesRemainder,
      numerator: row.remainderNumerator, denominator: row.remainderDenominator }))).toEqual([
      { key: keys[0], floor: 100, amount: 101, tail: true, numerator: (denominator - 101n).toString(), denominator: denominator.toString() },
      { key: keys[1], floor: 0, amount: 0, tail: false, numerator: "101", denominator: denominator.toString() },
    ]);
    const run = await f.calculate(b, [version.id]), actual = (await slices(run.id)).filter(row => row.sourceFactId === b.root.id).sort((a, c) => a.target!.key < c.target!.key ? -1 : 1);
    expect(actual.map(row => [row.floorMinor, row.amountMinor, row.receivesRemainder])).toEqual([[100, 101, true], [0, 0, false]]);
    // The unselected third order still lacks its carrier fact. The exact zero
    // for the second selected target cannot manufacture complete coverage.
    expect(run).toMatchObject({ status: "incomplete", costMinor: null, profitMinor: null, breakdowns: [] });
    expect(run.diagnostics.missingByTarget).toContainEqual({ key: b.targets[2]!.lineId, missingFactTypes: ["carrier_cost"] });
  });
  it("expands the complete original reversal/replacement family with identical weights and mirrors the original tail", async () => {
    const b = await f.basis(), reversed = await f.correction(b, "reversal"), replaced = await f.correction(b, "replacement", 99);
    const base = await finance.calculateProfit(context, { ...b.input, statementIds: [...b.input.statementIds, reversed.id, replaced.id], idempotencyKey: costKey() });
    const updated = { ...b, base }, { preview, version } = await f.approve(f.previewInput(updated)); expect(preview.sources).toHaveLength(3);
    const original = preview.sources.find(row => row.factId === b.root.id)!, reversal = preview.sources.find(row => row.factId === reversed.lines[0]!.id)!;
    expect(reversal.effectSign).toBe(-1); expect(reversal.shares).toEqual(original.shares);
    const run = await f.calculate(updated, [version.id]); expect(run).toMatchObject({ status: "complete", costMinor: 549, profitMinor: 2451 });
    expect(run.breakdowns.map(row => row.costMinor)).toEqual([183, 183, 183]);
  });
  it("refuses to preview an old source family after a genuine new correction and marks historical approved evidence without rewriting it", async () => {
    const a = await approved(), original = await allocations.version(context, a.version.id), stored = await f.state(costTables); await f.correction(a.basis, "reversal");
    await expect(allocations.preview(context, a.input)).rejects.toMatchObject(conflict("correction_chain_changed"));
    const historical = await allocations.version(context, a.version.id); expect(historical.preview).toEqual(original.preview); expect(historical.checksum).toBe(original.checksum);
    expect(historical.basisProblems).toContain("source_changed"); expect(await f.state(costTables)).toEqual(stored);
  });
  it("appends a new approved version under optimistic control and keeps original projection amounts and pins immutable", async () => {
    const a = await approved(), originalRun = await f.calculate(a.basis, [a.version.id]);
    const input = { ...a.input, allocationId: a.version.allocationId, expectedVersion: 1, method: "manual_weights" as const,
      sources: a.input.sources.map(source => ({ ...source, targets: source.targets.map((target, index) => ({ ...target, weight: index === 0 ? "2" : "1" })) })) };
    const appended = await f.approve(input); expect(appended.version).toMatchObject({ allocationId: a.version.allocationId, versionNumber: 2, previousVersionId: a.version.id });
    const history = await allocations.run(context, originalRun.id); expect(history.breakdowns).toEqual(originalRun.breakdowns); expect(history.versionPins).toEqual(originalRun.versionPins);
    expect(history.basisProblems).toContain("rule_superseded");
    await expect(allocations.preview(context, input)).rejects.toMatchObject(conflict("version_changed"));
  });
  it("serializes competing appends against one exact approved version without creating duplicate version numbers", async () => {
    const a = await approved(), next = { ...a.input, allocationId: a.version.allocationId, expectedVersion: 1 }, preview = await allocations.preview(context, next);
    const results = await Promise.allSettled([allocations.approve(context, { ...next, previewChecksum: preview.previewChecksum, idempotencyKey: costKey() }),
      allocations.approve(context, { ...next, previewChecksum: preview.previewChecksum, idempotencyKey: costKey() })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(row => row.status === "rejected") as PromiseRejectedResult; expect(failure.reason).toMatchObject(conflict("version_changed"));
  });
  it.each(["version", "run"] as const)("binds an actual %s request key to its actor, original base and exact normalized body", async operation => {
    const a = await approved(), originalInput = operation === "version" ? { ...a.input, previewChecksum: a.preview.previewChecksum, idempotencyKey: costKey() }
      : { baseRunId: a.basis.base.id, baseInputChecksum: a.basis.base.inputChecksum, dimension: "order_line" as const, versionIds: [a.version.id], idempotencyKey: costKey() };
    const invoke = (actor: typeof context, input: unknown) => operation === "version" ? allocations.approve(actor, input) : allocations.calculate(actor, input);
    const actual = await invoke(context, originalInput), before = await state(); expect(await invoke(context, originalInput)).toEqual(actual);
    await expect(invoke(f.coworker, originalInput)).rejects.toMatchObject(conflict("request_mismatch"));
    await expect(invoke(context, { ...originalInput, baseInputChecksum: "b".repeat(64) })).rejects.toMatchObject(conflict("request_mismatch"));
    const changed = operation === "version" ? { ...originalInput, basisDescription: "Changed original basis" } : { ...originalInput, versionIds: [] };
    await expect(invoke(context, changed)).rejects.toMatchObject(conflict("request_mismatch")); expect(await state()).toEqual(before);
  });
  it("rejects overlapping source families and two versions of one allocation in a single projection", async () => {
    const a = await approved(), other = await f.approve(a.input);
    await expect(f.calculate(a.basis, [a.version.id, other.version.id])).rejects.toMatchObject(conflict("version_overlap"));
    const next = await f.approve({ ...a.input, allocationId: a.version.allocationId, expectedVersion: 1 });
    await expect(f.calculate(a.basis, [a.version.id, next.version.id])).rejects.toMatchObject(conflict("version_overlap"));
  });
  it.each(["version", "run"] as const)("rolls an actual %s and all its slices back with the final audit failure", async operation => {
    const a = await approved(), before = await state(); vi.spyOn(f.audit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic final audit unavailable"));
    const work = operation === "version" ? () => allocations.approve(context, { ...a.input, previewChecksum: a.preview.previewChecksum, idempotencyKey: costKey() }) : () => f.calculate(a.basis, [a.version.id]);
    await expect(work()).rejects.toThrow("synthetic final audit unavailable"); expect(await state()).toEqual(before);
  });
  it("requires current FinanceReview before new decisions and replay while allowing authorized Review-only receipts", async () => {
    const a = await approved(), original = { ...a.input, previewChecksum: a.preview.previewChecksum, idempotencyKey: costKey() }, receipt = await allocations.approve(context, original);
    await f.rights(context, [Permission.FinanceRead]); await expect(allocations.approve(context, original)).rejects.toSatisfy(denied);
    await expect(f.calculate(a.basis, [a.version.id])).rejects.toSatisfy(denied); await f.rights(context, [Permission.FinanceReview]);
    expect((await allocations.approve(context, original)).id).toBe(receipt.id); expect((await f.calculate(a.basis, [a.version.id])).status).toBe("complete");
  });
  it("rechecks current tenant Read for every read method, preview and empty history rather than trusting an earlier caller context", async () => {
    const a = await approved(), run = await f.calculate(a.basis, [a.version.id]); await f.rights(context, [Permission.FinanceReview]);
    const work = [() => allocations.base(context, a.basis.base.id), () => allocations.sources(context, { baseRunId: a.basis.base.id, dimension: "order_line" }),
      () => allocations.targets(context, { dimension: "order_line" }), () => allocations.preview(context, a.input), () => allocations.listVersions(context, {}),
      () => allocations.version(context, a.version.id), () => allocations.listRuns(context, {}), () => allocations.run(context, run.id), () => allocations.slices(context, run.id, {})];
    for (const read of work) await expect(read()).rejects.toSatisfy(denied);
  });
  it("does not widen self/team grants, caller-injected permission or an absent membership into allocation authority", async () => {
    const b = await f.basis();
    for (const scope of ["self", "team"] as const) { await f.rights(context, [Permission.FinanceRead, Permission.FinanceReview], scope); await expect(allocations.preview(context, f.previewInput(b))).rejects.toSatisfy(denied); }
    await f.restoreRights(); await expect(allocations.preview({ ...context, permissions: [] }, f.previewInput(b))).rejects.toSatisfy(denied);
    await expect(allocations.targets({ ...context, userId: createEntityId() }, { dimension: "order" })).rejects.toSatisfy(denied);
  });
  it("uses actual current target linkage and reports changed catalog lineage without altering historical target snapshots", async () => {
    const a = await approved(), original = a.preview.sources[0]!.shares.find(row => row.target.key === f.own[0]!.lineId)!.target;
    try {
      await withTenant(database.db, context, tx => tx.update(skus).set({ spuId: f.own[1]!.spuId }).where(eq(skus.id, f.own[0]!.skuId)));
      const read = await allocations.version(context, a.version.id); expect(read.basisProblems).toContain("target_changed");
      expect(read.preview.sources[0]!.shares.find(row => row.target.key === original.key)!.target).toEqual(original);
      await expect(allocations.approve(context, { ...a.input, previewChecksum: a.preview.previewChecksum, idempotencyKey: costKey() })).rejects.toMatchObject(conflict("preview_changed"));
    } finally { await withTenant(database.db, context, tx => tx.update(skus).set({ spuId: f.own[0]!.spuId }).where(eq(skus.id, f.own[0]!.skuId))); }
  });
  it("rejects foreign target IDs, foreign original bases and direct forced-RLS reads of approved versions or projections", async () => {
    const a = await approved(), run = await f.calculate(a.basis, [a.version.id]);
    await expect(allocations.preview(context, f.previewInput(a.basis, "order_line", [f.foreign[0]!.lineId]))).rejects.toMatchObject({ status: 404 });
    await expect(allocations.base(f.outsider, a.basis.base.id)).rejects.toMatchObject({ status: 404 });
    for (const [table, id] of [["finance_cost_allocation_versions", a.version.id], ["finance_allocated_profit_runs", run.id]]) {
      expect(await withTenant(database.db, f.outsider, tx => tx.execute(sql`select id from ${sql.identifier(table!)} where id=${id}`))).toHaveLength(0);
      await expect(withTenant(database.db, context, tx => tx.execute(sql`update ${sql.identifier(table!)} set id=id where id=${id}`))).rejects.toThrow();
    }
  });
  it.each(["order", "order_line", "sku", "listing", "period"] as FinanceCostAllocationDimension[])("resolves real %s targets and keeps period selection explicit rather than guessing a page", async dimension => {
    const key = dimension === "period" ? "2026-07" : dimension === "order" ? f.own[0]!.orderId : dimension === "order_line" ? f.own[0]!.lineId : dimension === "sku" ? f.own[0]!.skuId : f.own[0]!.listingId;
    const page = await allocations.targets(context, { dimension, key, limit: 1 }); expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ dimension, key });
    if (dimension === "period") expect(page.items[0]).toMatchObject({ periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z" });
  });
  it("rejects a non-aggregate or unknown-currency original base instead of allocating unverified source totals", async () => {
    const unknown = await f.basis({ currency: "ZZZ" }); await expect(allocations.preview(context, f.previewInput(unknown))).rejects.toMatchObject(conflict("base_incomplete"));
    const scoped = await f.basis({ directSource: true, coverage: "order_line" }); expect(scoped.base.status).toBe("complete");
    await expect(allocations.preview(context, f.previewInput(scoped))).rejects.toMatchObject(conflict("base_not_aggregate"));
  });
  it("rejects reallocating an already-attributed cost or treating a revenue root as an unassigned expense", async () => {
    const direct = await f.basis({ directSource: true });
    await expect(allocations.preview(context, f.previewInput(direct))).rejects.toMatchObject(conflict("already_attributed"));
    const b = await f.basis(), input = f.previewInput(b);
    await expect(allocations.preview(context, { ...input, sources: [{ ...input.sources[0]!, rootFactId: b.direct.lines.find(row => row.factType === "sale_revenue")!.id }] })).rejects.toMatchObject(conflict("not_cost"));
  });
});
