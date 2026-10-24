import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import {
  AdGoalFieldsSchema,
  adCurrencyBasis,
  type AdStoredFact,
  type AdGoalVersion,
  type AdActionView,
  type AdObservation,
} from "@yummyai/contracts/advertising";
import { parseAdCsv } from "./ad-csv-parser.js";
import {
  analyzeAdvertising,
  adCpcAllowance,
  adEconomics,
  adRatios,
  boundedAdBid,
  sumAdMetrics,
  validAdTransition,
} from "./ad-analysis.js";

const accountId = createEntityId(),
  productId = createEntityId(),
  goalId = createEntityId();
const scope = { accountId, marketplace: "US" as const, currency: "USD", asin: "B012345678" };
const input = {
  accountId,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-15",
  marketplace: null,
  currency: null,
  evidenceCutoffAt: "2026-09-25T18:00:00.000Z",
  idempotencyKey: "test-analysis-001",
};
function fromCsv(content: string, observedAt = "2026-09-23T18:00:00.000Z"): AdStoredFact[] {
  const parsed = parseAdCsv("input.csv", content, {
    marketplaceByCurrency: { USD: "US", CAD: "CA" },
    dateOrder: null,
    attributionWindowDays: 7,
    attributionBasis: "click",
    conversionDefinition: { model: "click", source: "Synthetic report settings explicitly confirm click attribution" },
  });
  const importId = createEntityId();
  return parsed.facts.map((fact) => ({
    id: createEntityId(),
    importId,
    accountId,
    observedAt,
    recordedAt: observedAt,
    timezone: "America/Los_Angeles",
    attributionWindowDays: 7,
    attributionBasis: "click",
    sourceChecksum: parsed.checksum,
    sourceArchivedAt: null,
    fact,
  }));
}
function campaign(spend = "10", currency = "USD", product = "Sponsored Products") {
  return fromCsv(
    `日期范围,广告主账户 ID,广告活动编号,广告活动名称,广告产品,预算货币,展示量,点击量,总成本,购买量,销售额\n2026年9月1日 - 2026年9月15日,adv,123,Campaign,${product},${currency},1000,40,${spend},3,100`,
  );
}
function product(asin = scope.asin) {
  return fromCsv(
    `日期范围,广告主账户 ID,广告活动编号,广告组编号,推广的商品编号,预算货币,展示量,点击量,总成本,购买量,销售额\n2026年9月1日 - 2026年9月15日,adv,123,456,${asin},USD,1000,40,10,3,100`,
  );
}
function target(sales = "20", purchases = 3, bid = "1.00") {
  return fromCsv(
    `日期范围,广告主账户 ID,广告活动编号,广告组编号,投放方案编号,投放方案,投放匹配类型-Targeting match type,目标竞价,投放状态,预算货币,展示量,点击量,总成本,购买量,销售额\n2026年9月1日 - 2026年9月15日,adv,123,456,target-1,custom pillow,EXACT,${bid},ENABLED,USD,1000,40,10,${purchases},${sales}`,
  );
}
function search(purchases = 0, term = "custom pillow") {
  return fromCsv(
    `日期范围,广告主账户 ID,广告活动编号,广告组编号,搜索词,预算货币,展示量,点击量,总成本,购买量,销售额\n2026年9月1日 - 2026年9月15日,adv,123,456,${term},USD,1000,40,10,${purchases},100`,
  );
}
function goal(overrides: Partial<AdGoalVersion["fields"]> = {}): AdGoalVersion {
  return {
    id: goalId,
    productId,
    revision: 1,
    scope,
    fields: AdGoalFieldsSchema.parse({
      mode: "profit_defense",
      effectiveFrom: "2026-09-01",
      unitPriceMinor: 10000,
      unitCostMinor: 7000,
      targetAcosBps: null,
      coreKeywords: [],
      protectedTerms: [],
      trialEndDate: null,
      trialSpendLimitMinor: null,
      monetaryBasis: adCurrencyBasis("USD")!,
      ...overrides,
    }),
    checksum: "a".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}
function run(
  facts: AdStoredFact[],
  goals = [goal()],
  additions: { actions?: AdActionView[]; observations?: AdObservation[] } = {},
) {
  return analyzeAdvertising({ input, facts, goals, ...additions });
}
describe("advertising metrics and decision boundaries", () => {
  it("keeps nulls and zero denominators visible instead of claiming zero ACoS or CVR", () => {
    expect(
      adRatios({ impressions: 100, clicks: 0, purchases: 2, spendMinor: 1000, salesMinor: 0 }),
    ).toMatchObject({ acosBps: null, cvrBps: null, cpcMinor: null, roasBps: 0 });
    expect(
      sumAdMetrics([
        { impressions: 100, clicks: 4, purchases: null, spendMinor: 10, salesMinor: null },
      ]).salesMinor,
    ).toBeNull();
    expect(sumAdMetrics([]).spendMinor).toBeNull();
    expect(
      sumAdMetrics([
        {
          impressions: Number.MAX_SAFE_INTEGER,
          clicks: 1,
          purchases: 0,
          spendMinor: 10,
          salesMinor: 0,
        },
        { impressions: 1, clicks: 1, purchases: 0, spendMinor: 20, salesMinor: 0 },
      ]).impressions,
    ).toBeNull();
  });
  it("corrects the upstream reduction cap and keeps CPC arithmetic exact at large counts", () => {
    expect(boundedAdBid(100, 1, 1500, "lower")).toBe(85);
    expect(boundedAdBid(100, 900, 1500, "raise")).toBe(115);
    expect(boundedAdBid(1, 0, 1500, "lower")).toBe(1);
    expect(adCpcAllowance(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 100000)).toBe(10);
    expect(adCpcAllowance(10000, 40, 2100)).toBe(53);
  });
  it("derives targets only from actual economics or explicit settings", () => {
    expect(adEconomics(goal())).toEqual({ breakEvenAcosBps: 3000, targetAcosBps: 2100 });
    expect(adEconomics(goal({ unitCostMinor: null }))).toEqual({
      breakEvenAcosBps: null,
      targetAcosBps: null,
    });
    expect(adEconomics(goal({ targetAcosBps: 9000 })).targetAcosBps).toBe(3000);
  });
  it("uses Campaign as control and never adds alternate breakdowns or currencies", () => {
    const data = [...campaign(), ...campaign("3", "CAD"), ...product(), ...target()];
    const before = structuredClone(data),
      result = run(data);
    expect(result.controlType).toBe("campaign");
    expect(result.totals.map((t) => [t.currency, t.metrics.spendMinor])).toEqual(
      expect.arrayContaining([
        ["USD", 1000],
        ["CAD", 300],
      ]),
    );
    expect(result.products).toHaveLength(1);
    expect(data).toEqual(before);
    expect(result.dailyTrend).toHaveLength(0);
  });
  it("supersedes the same interval and does not add overlapping rolling exports", () => {
    const older = campaign("10"),
      newer = campaign("12");
    newer[0]!.observedAt = newer[0]!.recordedAt = "2026-09-24T00:00:00.000Z";
    const result = run([...older, ...newer]);
    expect(result.totals[0]?.metrics.spendMinor).toBe(1200);
    expect(result.supersededFactCount).toBe(1);
    older[0]!.fact.periodStart = "2026-09-02";
    expect(run([...older, ...newer]).diagnostics.map((d) => d.code)).toContain(
      "OVERLAPPING_INTERVALS",
    );
  });
  it("does not clip interval summaries into a selected daily window", () => {
    const result = analyzeAdvertising({
      input: { ...input, periodStart: "2026-09-10" },
      facts: campaign(),
      goals: [goal()],
    });
    expect(result.selectedFactCount).toBe(0);
    expect(result.diagnostics.map((d) => d.code)).toContain("INTERVAL_CROSSES_WINDOW");
  });
  it("requires mature attribution before treating zero purchases as a negative candidate", () => {
    const data = [...campaign(), ...product(), ...search()].map(row => ({
      ...row, observedAt: "2026-09-16T18:00:00.000Z", recordedAt: "2026-09-16T18:00:00.000Z",
    }));
    const recent = analyzeAdvertising({
      input: { ...input, evidenceCutoffAt: "2026-09-17T18:00:00.000Z" },
      facts: data,
      goals: [goal()],
    });
    expect(recent.recommendations.some((r) => r.kind === "negate_term")).toBe(false);
    expect(recent.recommendations.some((r) => r.ruleId === "AD_ATTRIBUTION_PENDING")).toBe(true);
    data.forEach((r) => {
      r.attributionWindowDays = null;
      if (r.fact.measurement) r.fact.measurement.conversion = { ...r.fact.measurement.conversion, state: "unresolved", windowDays: null };
    });
    expect(run(data).recommendations.some((r) => r.kind === "negate_term")).toBe(false);
  });
  it("allows bounded profit bid reductions while protecting rank-growth core terms", () => {
    const data = [...campaign(), ...product(), ...target()];
    const profit = run(data).recommendations.find((r) => r.kind === "lower_bid");
    expect(profit).toMatchObject({ currentBidMinor: 100, proposedBidMinor: 85, changeBps: -1500 });
    const growth = goal({
      mode: "rank_growth",
      coreKeywords: ["custom pillow"],
      trialEndDate: "2026-09-30",
      trialSpendLimitMinor: 10000,
      targetAcosBps: 2100,
    });
    expect(
      run(data, [growth]).recommendations.some((r) => r.ruleId === "AD_CORE_RANK_REVIEW"),
    ).toBe(true);
    expect(run(data, [growth]).recommendations.some((r) => r.kind === "lower_bid")).toBe(false);
  });
  it("has a stop condition for expired or exhausted rank experiments", () => {
    const growth = goal({
      mode: "rank_growth",
      coreKeywords: ["custom pillow"],
      trialEndDate: "2026-09-20",
      trialSpendLimitMinor: 10000,
      targetAcosBps: 7000,
    });
    expect(
      run([...campaign(), ...product(), ...target()], [growth]).recommendations.some(
        (r) => r.ruleId === "AD_RANK_TRIAL_LIMIT",
      ),
    ).toBe(true);
  });
  it("checks product spend caps and nonpositive margins before sample and maturity gates", () => {
    const first = product(),
      second = product();
    for (const [index, row] of [first[0]!, second[0]!].entries()) {
      row.fact.adGroupId = `group-${index}`;
      row.fact.entityKey = String(index).repeat(64);
      row.fact.metrics.clicks = 1;
      row.fact.metrics.spendMinor = 600;
      row.attributionWindowDays = null;
      if (row.fact.measurement) row.fact.measurement.conversion = { ...row.fact.measurement.conversion, state: "unresolved", windowDays: null };
    }
    const growth = goal({
      mode: "rank_growth",
      coreKeywords: ["custom pillow"],
      trialEndDate: "2026-09-30",
      trialSpendLimitMinor: 1000,
    });
    expect(run([...first, ...second], [growth]).recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "AD_RANK_TRIAL_LIMIT",
          metrics: expect.objectContaining({ spendMinor: 1200 }),
        }),
      ]),
    );
    expect(
      run(first, [goal({ unitCostMinor: 10000 })]).recommendations.some(
        (r) => r.ruleId === "AD_NONPOSITIVE_MARGIN",
      ),
    ).toBe(true);
  });
  it("requires complete trial spend coverage before suggesting a rank-growth increase", () => {
    const growth = goal({
      mode: "rank_growth",
      targetAcosBps: 2100,
      coreKeywords: ["custom pillow"],
      trialEndDate: "2026-09-30",
      trialSpendLimitMinor: 10000,
    });
    const options = { input: { ...input, periodEnd: "2026-09-24" }, goals: [growth] };
    expect(
      analyzeAdvertising({
        ...options,
        facts: [...campaign(), ...product(), ...target("1000")],
      }).recommendations.some((r) => r.kind === "raise_bid"),
    ).toBe(false);
    const complete = product();
    complete[0]!.fact.periodEnd = "2026-09-24";
    complete[0]!.observedAt = complete[0]!.recordedAt = "2026-09-25T17:00:00.000Z";
    expect(
      analyzeAdvertising({
        ...options,
        facts: [...campaign(), ...complete, ...target("1000")],
      }).recommendations.some((r) => r.kind === "raise_bid"),
    ).toBe(true);
  });
  it("selects effective goals using each report's timezone", () => {
    const next = {
      ...goal(),
      id: createEntityId(),
      revision: 2,
      createdAt: "2026-09-24T00:00:00.000Z",
      fields: { ...goal().fields, effectiveFrom: "2026-09-25" },
    };
    const facts = product();
    const options = {
      input: { ...input, evidenceCutoffAt: "2026-09-25T02:00:00.000Z" },
      goals: [goal(), next],
    };
    expect(analyzeAdvertising({ ...options, facts }).products[0]?.goal?.id).toBe(goalId);
    facts[0]!.timezone = "UTC";
    expect(analyzeAdvertising({ ...options, facts }).products[0]?.goal?.id).toBe(next.id);
  });
  it("does not fabricate a triggering target for search terms or allocate shared groups", () => {
    const result = run([...campaign(), ...product(), ...search()]);
    expect(result.recommendations.find((r) => r.kind === "negate_term")?.targetId).toBeNull();
    const shared = run([...campaign(), ...product(), ...product("B098765432"), ...target()]);
    expect(shared.recommendations.some((r) => r.kind === "lower_bid")).toBe(false);
    expect(shared.recommendations[0]?.reason).toContain("多个产品");
  });
  it("suppresses repeated adjustments using actual execution time", () => {
    const data = [...campaign(), ...product(), ...target()],
      recommendation = run(data).recommendations[0]!;
    const action: AdActionView = {
      id: createEntityId(),
      runId: createEntityId(),
      status: "observing",
      revision: 3,
      recommendation,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      executedAt: "2026-09-24T00:00:00.000Z",
      actualBeforeMinor: 100,
      actualAfterMinor: 85,
      execution: null,
      events: [],
    };
    expect(run(data, [goal()], { actions: [action] }).recommendations[0]?.ruleId).toBe(
      "AD_COOLDOWN",
    );
    expect(
      run(data, [goal()], { actions: [{ ...action, executedAt: "2026-09-18T18:30:00.000Z" }] })
        .recommendations[0]?.ruleId,
    ).toBe("AD_COOLDOWN");
    expect(
      run(data, [goal()], {
        actions: [{ ...action, executedAt: "2026-09-26T00:00:00.000Z" }],
      }).recommendations.some((r) => r.kind === "lower_bid"),
    ).toBe(true);
    expect(validAdTransition("pending", "executed")).toBe(false);
    expect(validAdTransition("adopted", "executed")).toBe(true);
    expect(validAdTransition("reviewed", "pending")).toBe(false);
  });
  it("separates source-backed total commerce from ad-attributed sales and organic rank", () => {
    const observed: AdObservation = {
      id: createEntityId(),
      scope,
      kind: "commerce",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
      source: "ERP period export",
      keyword: null,
      organicRank: null,
      totalSalesMinor: 50000,
      totalPurchases: 12,
      preAdContributionMinor: 12000,
      adsCoverageConfirmed: true,
      monetaryBasis: adCurrencyBasis("USD")!,
      observedAt: "2026-09-16T00:00:00.000Z",
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    const result = run([...campaign(), ...product()], [goal()], { observations: [observed] });
    expect(result.products[0]).toMatchObject({ tacosBps: 200, postAdContributionMinor: 11000 });
    expect(result.products[0]).not.toHaveProperty("organicPurchases");
    expect(
      run([...campaign(), ...product()], [goal()], {
        observations: [{ ...observed, periodEnd: "2026-09-14" }],
      }).products[0]?.tacosBps,
    ).toBeNull();
    expect(
      run(product(), [goal()], { observations: [{ ...observed, adsCoverageConfirmed: false }] })
        .products[0]?.postAdContributionMinor,
    ).toBeNull();
    const alternate = product();
    alternate[0]!.attributionBasis = "click_and_view";
    if (alternate[0]!.fact.measurement)
      alternate[0]!.fact.measurement.conversion = { ...alternate[0]!.fact.measurement.conversion, model: "legacy_click_and_view" };
    expect(
      run([...product(), ...alternate], [goal()], { observations: [observed] }).products.every(
        (p) => p.tacosBps === null && p.qualityCodes.includes("COMMERCE_SCOPE_AMBIGUOUS"),
      ),
    ).toBe(true);
  });
});
