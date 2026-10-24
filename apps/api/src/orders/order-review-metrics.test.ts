import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { type FinanceFactView, type FinanceProfitRunView, type FinanceProfitMetricVersionView } from "@yummyai/contracts/finance";
import { buildFinanceCalculationBasis } from "@yummyai/contracts/finance/monetary";
import { OrderReviewViewSchema, OrderSkuReviewSchema } from "@yummyai/contracts/order/review";
import { effectiveOrderFacts, orderReviewProfit, reviewDeadline, reviewDuration, summarizeOrderReview } from "./order-review-metrics.js";
import type { OrderFinanceEvidence } from "../finance/finance.service.js";

function fixture() {
  const orderId = createEntityId(), lineId = createEntityId(), skuId = createEntityId(), statementId = createEntityId();
  const facts: FinanceFactView[] = (["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"] as const).map((factType, index) => ({
    id: createEntityId(), statementId, accountId: null, lineKey: String(index), sourceEntryId: `synthetic-review:${orderId}:${index}`, factType,
    direction: index === 0 ? "credit" : "debit", amountMinor: [5000, 1500, 600, 500][index]!, currency: "USD",
    occurredAt: "2026-10-01T00:00:00.000Z", recordedAt: "2026-10-01T00:00:00.000Z", externalReference: null,
    orderId, orderLineId: lineId, skuId, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null,
  }));
  const metric: FinanceProfitMetricVersionView = { id: createEntityId(), metricId: createEntityId(), versionNumber: 1, reportingCurrency: "USD",
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost", "carrier_cost", "marketplace_commission", "refund", "other_fee"],
    requiredFactTypes: ["sale_revenue", "production_cost", "carrier_cost", "marketplace_commission"], reasonCode: "SYNTHETIC_ONLY",
    checksum: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z" };
  const run: FinanceProfitRunView = { id: createEntityId(), metricId: metric.metricId, metricVersionId: metric.id, metricVersion: 1,
    reportingCurrency: "USD", status: "complete", revenueMinor: 5000, costMinor: 2600, profitMinor: 2400, marginBps: 4800,
    statementIds: [statementId], fxRateIds: [], inputChecksum: "b".repeat(64), calculatedAt: "2026-10-02T00:00:00.000Z",
    sourceIdentityVersion: 1, monetaryBasis: buildFinanceCalculationBasis(["USD"]),
    diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] },
      monetary: { unknownCurrencies: [], ambiguousFxRateIds: [] }, coverage: {
      dimension: "order", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [],
    } }, breakdowns: [], contributions: facts.map(fact => ({ id: createEntityId(), factId: fact.id, fxRateId: null,
      bucket: fact.factType === "sale_revenue" ? "revenue" : "cost", sourceAmountMinor: fact.amountMinor, sourceCurrency: "USD",
      reportingAmountMinor: fact.amountMinor, reportingCurrency: "USD", effectSign: 1, factType: fact.factType,
      occurredAt: fact.occurredAt, orderId, orderLineId: lineId, skuId, listingId: null, accountId: null, supplierId: null,
    })) };
  const evidence: OrderFinanceEvidence = { facts, calculations: [{ run, metric }], truncated: false };
  return { orderId, lineId, skuId, facts, run, metric, evidence, lines: [{ id: lineId, skuId }] };
}

describe("order review evidence accounting", () => {
  it("reuses complete pinned per-order contributions and allocates only exact line/SKU facts", () => {
    const f = fixture(), result = orderReviewProfit(f.orderId, f.lines, f.evidence, []);
    expect(result).toMatchObject({ status: "verified", revenueMinor: 5000, costMinor: 2600, profitMinor: 2400,
      lines: [{ lineId: f.lineId, profitMinor: 2400 }] });
  });
  it("invalidates a calculation after a new booked cost, including a known zero", () => {
    const f = fixture(); f.facts.push({ ...f.facts[1]!, id: createEntityId(), amountMinor: 0 });
    expect(orderReviewProfit(f.orderId, f.lines, f.evidence, [])).toMatchObject({ status: "incomplete", profitMinor: null, lines: [] });
  });
  it("rejects aggregate coverage, incomplete costs, missing FX and narrow required-cost definitions", () => {
    for (const change of ["aggregate", "missing", "fx", "definition"] as const) {
      const f = fixture();
      if (change === "aggregate") f.run.diagnostics.coverage!.dimension = "aggregate";
      if (change === "missing") f.run.diagnostics.coverage!.missingByEntity.push({ key: f.orderId, missingFactTypes: ["production_cost"] });
      if (change === "fx") f.run.diagnostics.missingFxPairs.push("CNY/USD");
      if (change === "definition") f.metric.requiredFactTypes = ["sale_revenue"];
      expect(orderReviewProfit(f.orderId, f.lines, f.evidence, []).profitMinor).toBeNull();
    }
  });
  it("keeps whole-order freight out of SKU totals without splitting or duplicating it", () => {
    const f = fixture(); f.facts[2]!.orderLineId = null; f.run.contributions[2]!.orderLineId = null;
    expect(orderReviewProfit(f.orderId, f.lines, f.evidence, [])).toMatchObject({ status: "verified", profitMinor: 2400, lines: [] });
  });
  it("blocks unknown model fees and truncated or unauthorized evidence", () => {
    const f = fixture();
    expect(orderReviewProfit(f.orderId, f.lines, f.evidence, ["模型费用未知"]).profitMinor).toBeNull();
    f.evidence.truncated = true; expect(orderReviewProfit(f.orderId, f.lines, f.evidence, []).profitMinor).toBeNull();
    expect(orderReviewProfit(f.orderId, f.lines, null, [])).toMatchObject({ status: "unavailable", currency: null, profitMinor: null });
  });
  it("does not resurrect reversed evidence or prefer older positive profits over a newer failed run", () => {
    const f = fixture(); const reversal = { ...f.facts[1]!, id: createEntityId(), correctionKind: "reversal" as const, correctsFactId: f.facts[1]!.id };
    expect(effectiveOrderFacts([...f.facts, reversal]).map(fact => fact.id)).not.toContain(f.facts[1]!.id);
    f.evidence.calculations.unshift({ metric: f.metric, run: { ...f.run, id: createEntityId(), status: "incomplete" } });
    expect(orderReviewProfit(f.orderId, f.lines, f.evidence, []).profitMinor).toBeNull();
  });
});

describe("actual fulfillment timing and SKU cohorts", () => {
  it("marks partial handover overdue, missing platform deadlines unknown and true handover on time", () => {
    expect(reviewDeadline("2026-10-05T00:00:00Z", null, 1, "2026-10-06T00:00:00Z")).toMatchObject({ status: "overdue", handedOverQuantity: 1 });
    expect(reviewDeadline(null, "2026-10-04T00:00:00Z", 2, "2026-10-06T00:00:00Z").status).toBe("unknown");
    expect(reviewDeadline("2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00Z", 2, "2026-10-06T00:00:00Z").status).toBe("on_time");
  });
  it("distinguishes current waiting, missing events and contradictory/future timestamps", () => {
    expect(reviewDuration("等待", "2026-10-05T00:00:00Z", null, "2026-10-06T00:00:00Z")).toMatchObject({ status: "pending", minutes: 1440 });
    expect(reviewDuration("未知", null, null, "2026-10-06T00:00:00Z").minutes).toBeNull();
    expect(reviewDuration("错误", "2026-10-05T00:00:00Z", "2026-10-04T00:00:00Z", "2026-10-06T00:00:00Z").status).toBe("invalid");
    expect(reviewDuration("未来", "2026-10-05T00:00:00Z", "2026-10-07T00:00:00Z", "2026-10-06T00:00:00Z").status).toBe("invalid");
  });
  it("keeps currency/metric versions separate and excludes pending/unknown shipments from the on-time denominator", () => {
    const f = fixture();
    const base = OrderReviewViewSchema.parse({ orderId: f.orderId, externalOrderId: "SYNTHETIC", placedAt: "2026-10-01T00:00:00Z", builtAt: "2026-10-07T00:00:00Z",
      lines: [{ id: f.lineId, skuId: f.skuId, skuCode: "PILLOW-10", title: "Synthetic", quantity: 2,
        recipeVersionId: null, recipeVersionNumber: null, specification: "10 in", profileVersionId: null, basisStatus: "pinned",
        factoryId: null, factoryName: null, factoryStatus: "missing", events: [], durations: [], blockers: [],
        deadline: reviewDeadline("2026-10-05T00:00:00Z", "2026-10-04T00:00:00Z", 2, "2026-10-07T00:00:00Z"),
        reviewRejections: 0, factoryRejections: 0, remakeCount: 1, remakeQuantity: 1 }],
      facts: f.facts, costs: [], profit: orderReviewProfit(f.orderId, f.lines, f.evidence, []), rework: [], diagnostics: [] });
    const late = structuredClone(base); late.orderId = createEntityId(); late.lines[0]!.deadline.status = "late";
    late.profit.currency = "CNY"; late.profit.metricVersionId = createEntityId();
    const pending = structuredClone(base); pending.orderId = createEntityId(); pending.lines[0]!.deadline.status = "pending"; pending.profit.lines = [];
    const [group] = summarizeOrderReview([base, late, pending]);
    expect(group).toMatchObject({ orderCount: 3, lineCount: 3, onTime: 1, late: 1, pending: 1, onTimeBps: 5000,
      remakeLineCount: 3, remakeQuantity: 3, verifiedProfitLines: 2, unallocatedProfitLines: 1 });
    expect(group!.profitTotals).toHaveLength(2);
    const missing = structuredClone(base); missing.lines[0]!.remakeCount = null; missing.lines[0]!.remakeQuantity = null;
    missing.lines[0]!.factoryRejections = null; missing.lines[0]!.factoryStatus = "unknown";
    const [partial] = summarizeOrderReview([missing]);
    expect(partial).toMatchObject({ remakeLineCount: null, remakeCount: null, remakeQuantity: null, remakeBps: null,
      factoryRejections: null, verifiedProfitLines: 0, unallocatedProfitLines: 1 });
    const differentSpec = structuredClone(base); differentSpec.lines[0]!.specificationVersionId = createEntityId();
    expect(summarizeOrderReview([base, differentSpec])).toHaveLength(2);
  });
});

describe("exact SKU totals across already authorized order projections", () => {
  function row(f: ReturnType<typeof fixture>, revenueMinor: number) {
    const orderId = createEntityId(), lineId = createEntityId();
    return OrderReviewViewSchema.parse({ orderId, externalOrderId: `SYNTHETIC-${orderId}`, placedAt: "2026-10-01T00:00:00Z", builtAt: "2026-10-07T00:00:00Z",
      lines: [{ id: lineId, skuId: f.skuId, skuCode: "SYNTHETIC-EXACT-SKU", title: "Synthetic authorized projection", quantity: 1,
        recipeVersionId: null, recipeVersionNumber: null, specification: "Synthetic fixed specification", profileVersionId: null, basisStatus: "pinned",
        factoryId: null, factoryName: null, factoryStatus: "missing", events: [], durations: [], blockers: [],
        deadline: reviewDeadline(null, null, 0, "2026-10-07T00:00:00Z"), reviewRejections: 0, factoryRejections: 0, remakeCount: 0, remakeQuantity: 0 }],
      facts: [], costs: [], rework: [], diagnostics: [],
      // This unit consumes the final per-order DTO; owner/source verification
      // is exercised by the real order-allocation integration suite.
      profit: { status: "verified", runId: f.run.id, metricVersionId: f.metric.id, metricVersion: 1, calculatedAt: f.run.calculatedAt,
        currency: "USD", revenueMinor, costMinor: 0, profitMinor: revenueMinor, blockers: [],
        allocationRunId: createEntityId(), allocationVersionSetChecksum: "c".repeat(64), allocationDimension: "order_line",
        lines: [{ lineId, revenueMinor, costMinor: 0, profitMinor: revenueMinor }] } });
  }
  it("keeps equal-currency equal-metric profits separate for different pinned allocation sets and dimensions", () => {
    const f = fixture(), a = row(f, 101), b = row(f, 202), c = row(f, 303);
    b.profit.allocationVersionSetChecksum = "d".repeat(64); c.profit.allocationDimension = "order";
    const [group] = summarizeOrderReview([a, b, c]); expect(group).toMatchObject({ verifiedProfitLines: 3, unallocatedProfitLines: 0 });
    expect(group!.profitTotals).toHaveLength(3);
    expect(group!.profitTotals.map(item => ({ set: item.allocationVersionSetChecksum, dimension: item.allocationDimension, profitMinor: item.profitMinor, lineCount: item.lineCount })))
      .toEqual([{ set: "c".repeat(64), dimension: "order_line", profitMinor: 101, lineCount: 1 },
        { set: "d".repeat(64), dimension: "order_line", profitMinor: 202, lineCount: 1 },
        { set: "c".repeat(64), dimension: "order", profitMinor: 303, lineCount: 1 }]);
    expect(OrderSkuReviewSchema.safeParse(group).success).toBe(true);
  });
  it("uses exact cross-line BigInt sums when safe signed amounts temporarily exceed the safe range and later cancel", () => {
    const f = fixture(), source = [row(f, Number.MAX_SAFE_INTEGER), row(f, 2), row(f, -Number.MAX_SAFE_INTEGER)];
    const [group] = summarizeOrderReview(source);
    expect(group).toMatchObject({ verifiedProfitLines: 3, unallocatedProfitLines: 0,
      profitTotals: [{ revenueMinor: 2, costMinor: 0, profitMinor: 2, lineCount: 3 }] });
    const [reverseOrder] = summarizeOrderReview([...source].reverse()); expect(reverseOrder!.profitTotals).toEqual(group!.profitTotals);
    expect(OrderSkuReviewSchema.safeParse(group).success).toBe(true);
  });
  it("withdraws an overflowing final SKU total without replacing it with zero or changing the original safe per-order results", () => {
    const f = fixture(), source = [row(f, Number.MAX_SAFE_INTEGER), row(f, 1)], original = structuredClone(source);
    const [group] = summarizeOrderReview(source);
    expect(group).toMatchObject({ verifiedProfitLines: 0, unallocatedProfitLines: 2, profitTotals: [] });
    expect(source).toEqual(original); expect(source.map(item => item.profit.status)).toEqual(["verified", "verified"]);
    expect(OrderSkuReviewSchema.safeParse(group).success).toBe(true);
  });
});
