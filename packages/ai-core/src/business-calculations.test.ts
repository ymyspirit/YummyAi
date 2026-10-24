import { describe, expect, it } from "vitest";
import type { FinanceProfitRunView } from "@yummyai/contracts/finance";
import { buildFinanceCalculationBasis } from "@yummyai/contracts/finance/monetary";
import { AssistResultSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { compareProfitRuns, replenishmentAnalysis } from "./business-calculations.js";
import { validateAssistResult, type AssistContext } from "./assist.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const run = (overrides: Partial<FinanceProfitRunView> = {}): FinanceProfitRunView => {
  const value: FinanceProfitRunView = {
    id: id(1),
    metricId: id(20),
    metricVersionId: id(3),
    metricVersion: 1,
    reportingCurrency: "USD",
    sourceIdentityVersion: 1,
    status: "complete",
    revenueMinor: 10000,
    costMinor: 4300,
    profitMinor: 5700,
    marginBps: 5700,
    statementIds: [id(21)],
    fxRateIds: [],
    calculatedAt: "2026-07-15T00:00:00.000Z",
    inputChecksum: "a".repeat(64),
    contributions: [],
    breakdowns: [],
    diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] },
      coverage: { dimension: "order", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] } },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "monetaryBasis")) value.monetaryBasis = buildFinanceCalculationBasis([value.reportingCurrency]);
  if (!Object.hasOwn(overrides, "contributions")) value.contributions = (["revenue", "cost"] as const).map<FinanceProfitRunView["contributions"][number]>((bucket, index) => {
    const amount = bucket === "revenue" ? value.revenueMinor ?? 0 : value.costMinor ?? 0;
    return { id: id(30 + index), factId: id(32 + index), fxRateId: null, bucket, sourceAmountMinor: Math.abs(amount), sourceCurrency: value.reportingCurrency,
      reportingAmountMinor: Math.abs(amount), reportingCurrency: value.reportingCurrency, effectSign: amount < 0 ? -1 : 1,
      factType: bucket === "revenue" ? "sale_revenue" : "production_cost", occurredAt: "2026-07-15T00:00:00.000Z", orderId: id(10),
      orderLineId: null, skuId: null, listingId: null, accountId: null, supplierId: null };
  });
  return value;
};
describe("business calculations keep missing and incomparable evidence explicit", () => {
  it("computes a fixed-report difference and preserves a negative profit", () => {
    expect(
      compareProfitRuns(
        run({ costMinor: 12700, profitMinor: -2700, marginBps: -2700 }),
        run({ id: id(2) }),
      ),
    ).toEqual({
      comparable: true,
      revenueDeltaMinor: 0,
      costDeltaMinor: 8400,
      profitDeltaMinor: -8400,
      marginDeltaBps: -8400,
    });
  });
  it("refuses an empty money context and a legacy mixed-precision amount despite otherwise complete matching reports", () => {
    expect(compareProfitRuns(run(), run({ id: id(2), monetaryBasis: null, contributions: [] }))).toMatchObject({ comparable: false, profitDeltaMinor: null });
    const legacy = run({ id: id(2), monetaryBasis: null });
    legacy.contributions[1] = { ...legacy.contributions[1]!, sourceCurrency: "JPY", sourceAmountMinor: 645000, fxRateId: id(40) };
    expect(compareProfitRuns(run(), legacy)).toMatchObject({ comparable: false, profitDeltaMinor: null, marginDeltaBps: null });
  });
  it.each([
    { status: "incomplete", profitMinor: null },
    { reportingCurrency: "EUR" },
    { metricVersionId: id(4) },
    { id: id(1) },
    { diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] } },
    { diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: { dimension: "aggregate", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] } } },
    { diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: { dimension: "order", checkedEntityCount: 2, missingByEntity: [{ key: id(10), missingFactTypes: ["production_cost"] }], unattributedFactIds: [] } } },
  ] as Partial<FinanceProfitRunView>[])(
    "does not fabricate growth from incompatible reports: %o",
    (change) => {
      expect(compareProfitRuns(run(), run({ id: id(2), ...change }))).toMatchObject({
        comparable: false,
        profitDeltaMinor: null,
        marginDeltaBps: null,
      });
    },
  );
  it("counts approved unreceived purchases in the stock position before suggesting more", () => {
    const input = {
      physical: 3,
      reserved: 2,
      inTransit: 0,
      openPurchaseQuantity: 12,
      policy: { reorderPoint: 10, safetyStock: 4, minimumOrderQuantity: 5 },
      blocked: false,
    };
    expect(replenishmentAnalysis(input)).toEqual({
      available: 1,
      position: 13,
      target: 14,
      suggestedQuantity: 0,
    });
    expect(replenishmentAnalysis({ ...input, openPurchaseQuantity: 2 }).suggestedQuantity).toBe(11);
    expect(replenishmentAnalysis({ ...input, openPurchaseQuantity: 8 }).suggestedQuantity).toBe(5);
  });
  it("withholds quantities for missing rules or reconciliation and rejects numeric overflow", () => {
    const input = {
      physical: 0,
      reserved: 0,
      inTransit: 0,
      openPurchaseQuantity: 0,
      policy: null,
      blocked: false,
    };
    expect(replenishmentAnalysis(input).suggestedQuantity).toBeNull();
    expect(
      replenishmentAnalysis({
        ...input,
        policy: { reorderPoint: 5, safetyStock: 3, minimumOrderQuantity: 2 },
        blocked: true,
      }).suggestedQuantity,
    ).toBeNull();
    expect(() =>
      replenishmentAnalysis({ ...input, physical: Number.MAX_SAFE_INTEGER, inTransit: 1 }),
    ).toThrow("unsafe_integer");
  });

  it("keeps fractional inventory exact and separately covers whole purchasing units", () => {
    const input = { physical: "1.05", reserved: "0.35", inTransit: 0, openPurchaseQuantity: 0,
      policy: { reorderPoint: 1, safetyStock: 1, minimumOrderQuantity: 1 }, blocked: false };
    expect(replenishmentAnalysis(input)).toEqual({ available: "0.7", position: "0.7", target: 2, suggestedQuantity: 2 });
    expect(replenishmentAnalysis({ ...input, inTransit: "0.3", openPurchaseQuantity: 1 })).toEqual({ available: "0.7", position: 2, target: 2, suggestedQuantity: 0 });
    expect(replenishmentAnalysis({ ...input, blocked: true }).suggestedQuantity).toBeNull();
    expect(replenishmentAnalysis({ ...input, physical: 0, reserved: 0, openPurchaseQuantity: "0.123456789" }))
      .toEqual({ available: 0, position: "0.123456789", target: 2, suggestedQuantity: 2 });
    expect(replenishmentAnalysis({ ...input, unit: "gram", physical: "0.1", reserved: 0,
      policy: { reorderPoint: "0.25", safetyStock: "0.05", minimumOrderQuantity: "0.125" } }))
      .toEqual({ available: "0.1", position: "0.1", target: "0.3", suggestedQuantity: "0.2" });
  });
});

describe("third-batch output has bounded evidence and draft-only replies", () => {
  const input = (): AssistContext => ({
    request: CreateAssistSchema.parse({
      kind: "after_sales_review",
      caseId: id(4),
      locale: "en-US",
      contextNotes: "请核对收到的尺寸",
      expectedFingerprint: "a".repeat(64),
      modelId: id(5),
      requestId: id(6),
    }),
    data: { case: { status: "open" } },
    sources: [{ id: id(4), label: "售后状态", href: "/after-sales" }],
    checks: [],
    diagnostics: [],
    images: [],
    allowedArtworkIds: [],
    allowedSpecificationIds: [],
    allowMatches: false,
  });
  const output = () =>
    AssistResultSchema.parse({
      summary: "需要核对尺寸证据",
      findings: [],
      directions: [],
      matches: [],
      missingInformation: [],
      actions: [
        {
          title: "核对尺寸",
          detail: "对照订单规格和测量照片",
          priority: "high",
          sourceId: id(4),
          evidence: [{ sourceId: id(4), detail: "售后记录" }],
        },
      ],
      replyDraft: {
        locale: "en-US",
        body: "Could you confirm the size you received?",
        evidence: [{ sourceId: id(4), detail: "售后状态" }],
      },
    });
  it("accepts supported source links and rejects model-invented destinations", () => {
    expect(validateAssistResult(output(), input(), []).actions).toHaveLength(1);
    const value = output();
    value.actions[0]!.sourceId = "https://unknown.example.test";
    expect(() => validateAssistResult(value, input(), [])).toThrow("invalid_action");
  });
  it("rejects replies for closed cases or a language not selected by the operator", () => {
    const value = input();
    value.data.case = { status: "resolved" };
    expect(() => validateAssistResult(output(), value, [])).toThrow("closed_case_reply");
    const result = output();
    result.replyDraft!.locale = "zh-CN";
    expect(() => validateAssistResult(result, input(), [])).toThrow("invalid_reply");
  });
});
