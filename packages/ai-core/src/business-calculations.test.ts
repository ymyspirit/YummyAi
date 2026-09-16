import { describe, expect, it } from "vitest";
import type { FinanceProfitRunView } from "@yummyai/contracts/finance";
import { AssistResultSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { compareProfitRuns, replenishmentAnalysis } from "./business-calculations.js";
import { validateAssistResult, type AssistContext } from "./assist.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const run = (overrides: Partial<FinanceProfitRunView> = {}) =>
  ({
    id: id(1),
    metricVersionId: id(3),
    reportingCurrency: "USD",
    status: "complete",
    revenueMinor: 10000,
    costMinor: 4300,
    profitMinor: 5700,
    marginBps: 5700,
    ...overrides,
  }) as FinanceProfitRunView;
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
  it.each([
    { status: "incomplete", profitMinor: null },
    { reportingCurrency: "EUR" },
    { metricVersionId: id(4) },
    { id: id(1) },
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
