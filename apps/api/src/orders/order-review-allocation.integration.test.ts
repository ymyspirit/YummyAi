import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { connectDatabase, migrateDatabase, skus, withTenant } from "@yummyai/database";
import { costKey, costTables, financeCostAllocationFixture, requireFinanceCostAllocationFixture } from "../finance/finance-cost-allocation.fixtures.js";
import { orderReviewProfit } from "./order-review-metrics.js";

requireFinanceCostAllocationFixture();
describe.sequential("real order evidence discovers approved allocation targets without rewriting unassigned expense facts", () => {
  const database = connectDatabase(), f = financeCostAllocationFixture(database), { context, finance, allocations } = f;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 60_000);
  afterEach(async () => { await f.restoreRights(); });
  afterAll(async () => { await database.client.end(); });
  async function calculation(dimension: "order" | "order_line" = "order_line") {
    const basis = await f.basis(), input = f.previewInput(basis, dimension), { preview, version } = await f.approve(input), run = await f.calculate(basis, [version.id], dimension);
    return { basis, input, preview, version, run };
  }
  async function review(index = 0) {
    const target = f.own[index]!, evidence = await finance.orderEvidence(context, [target.orderId]);
    return { target, evidence, profit: orderReviewProfit(target.orderId, [{ id: target.lineId, skuId: target.skuId }], evidence, []) };
  }
  it("finds a shared original null-order fee through the actual slice target and returns separate base/projection IDs with exact line profit", async () => {
    const a = await calculation(), { target, evidence, profit } = await review();
    expect(a.basis.root).toMatchObject({ orderId: null, orderLineId: null, skuId: null });
    const actual = evidence.allocationCalculations?.find(row => row.run.id === a.run.id); expect(actual).toBeDefined();
    expect(actual!.baseRun.id).toBe(a.basis.base.id); expect(actual!.sourceFacts.some(row => row.id === a.basis.root.id)).toBe(true);
    expect(actual!.slices.some(row => row.target?.orderId === target.orderId && row.sourceFactId === a.basis.root.id)).toBe(true);
    const share = a.preview.sources[0]!.shares.find(row => row.target.orderLineId === target.lineId)!;
    expect(profit).toMatchObject({ status: "verified", runId: a.basis.base.id, allocationRunId: a.run.id, allocationDimension: "order_line",
      revenueMinor: 1000, costMinor: 150 + share.amountMinor, profitMinor: 850 - share.amountMinor,
      lines: [{ lineId: target.lineId, costMinor: 150 + share.amountMinor, profitMinor: 850 - share.amountMinor }] });
    expect(profit.allocationVersionSetChecksum).toMatch(/^[a-f0-9]{64}$/); expect(profit.runId).not.toBe(profit.allocationRunId);
  });
  it("retains whole-order allocation at order level and never invents an SKU split from its quantity", async () => {
    const a = await calculation("order"), { profit } = await review();
    expect(profit).toMatchObject({ status: "verified", runId: a.basis.base.id, allocationRunId: a.run.id, allocationDimension: "order", lines: [] });
  });
  it("does not prefer an earlier complete projection over the latest actual incomplete target calculation", async () => {
    const a = await calculation(), incomplete = await f.calculate(a.basis, []), { profit } = await review();
    expect(incomplete.status).toBe("incomplete"); expect(profit).toMatchObject({ status: "incomplete", profitMinor: null, lines: [], allocationRunId: incomplete.id });
  });
  it("withdraws current verification after a new shared correction even though the original direct order fact IDs are unchanged", async () => {
    const a = await calculation(), before = await review(), saved = await f.state(costTables); await f.correction(a.basis, "reversal");
    const after = await review(); expect(after.evidence.facts.map(row => row.id)).toEqual(before.evidence.facts.map(row => row.id));
    expect(after.profit).toMatchObject({ status: "incomplete", profitMinor: null, lines: [] });
    const history = await allocations.run(context, a.run.id); expect(history).toMatchObject({ status: "complete", costMinor: 551, profitMinor: 2449 });
    expect(history.basisProblems).toContain("source_changed"); expect(await f.state(costTables)).toEqual(saved);
  });
  it("keeps changed real SKU lineage out of current verified line profit while preserving the historical target tuple", async () => {
    const a = await calculation(), original = a.preview.sources[0]!.shares.find(row => row.target.key === f.own[0]!.lineId)!.target;
    try {
      await withTenant(database.db, context, tx => tx.update(skus).set({ spuId: f.own[1]!.spuId }).where(eq(skus.id, f.own[0]!.skuId)));
      expect((await review()).profit).toMatchObject({ status: "incomplete", profitMinor: null, lines: [] });
      const history = await allocations.version(context, a.version.id); expect(history.basisProblems).toContain("target_changed");
      expect(history.preview.sources[0]!.shares.find(row => row.target.key === original.key)!.target).toEqual(original);
    } finally { await withTenant(database.db, context, tx => tx.update(skus).set({ spuId: f.own[0]!.spuId }).where(eq(skus.id, f.own[0]!.skuId))); }
  });
  it("requires an explicit recalculation after an approved rule supersedes the original version and changes its version-set identity", async () => {
    const a = await calculation(), before = (await review()).profit;
    const input = { ...a.input, allocationId: a.version.allocationId, expectedVersion: 1, method: "manual_weights" as const,
      sources: a.input.sources.map(source => ({ ...source, targets: source.targets.map((target, index) => ({ ...target, weight: index === 0 ? "2" : "1" })) })) };
    const next = await f.approve(input); expect((await review()).profit).toMatchObject({ status: "incomplete", profitMinor: null });
    const current = await f.calculate(a.basis, [next.version.id]), after = (await review()).profit;
    expect(after).toMatchObject({ status: "verified", allocationRunId: current.id, runId: a.basis.base.id });
    expect(after.allocationVersionSetChecksum).not.toBe(before.allocationVersionSetChecksum);
    expect((await allocations.run(context, a.run.id)).breakdowns).toEqual(a.run.breakdowns);
  });
  it("does not expose shared allocation evidence to another tenant or a stale caller after current FinanceRead is removed", async () => {
    const a = await calculation(), foreign = await finance.orderEvidence(f.outsider, [f.own[0]!.orderId]);
    expect(foreign.facts).toEqual([]); expect(foreign.allocationCalculations).toEqual([]);
    await f.rights(context, [Permission.FinanceReview]); await expect(finance.orderEvidence(context, [f.own[0]!.orderId])).rejects.toMatchObject({ status: 403 });
    expect((await allocations.calculate(context, { baseRunId: a.basis.base.id, baseInputChecksum: a.basis.base.inputChecksum, dimension: "order_line", versionIds: [a.version.id], idempotencyKey: costKey() })).status).toBe("complete");
  });
});
