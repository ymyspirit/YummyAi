import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import {
  AdGoalFieldsSchema,
  AdImportInputSchema,
  adCurrencyBasis,
  type AdGoalVersion,
  type AdImportInput,
  type AdMetricColumnSelection,
  type AdStoredFact,
} from "@yummyai/contracts/advertising";
import { adMinor, parseAdCsv } from "./ad-csv-parser.js";
import { analyzeAdvertising } from "./ad-analysis.js";

const accountId = createEntityId();
const asin = "B012345678";
const scope = { accountId, marketplace: "US" as const, currency: "USD", asin };
const observedAt = "2026-09-02T18:00:00.000Z";

function parse(content: string, overrides: Partial<AdImportInput> = {}, metricColumns?: AdMetricColumnSelection) {
  const basis = overrides.attributionBasis ?? "click";
  const input = AdImportInputSchema.parse({
    accountId,
    marketplaceByCurrency: { USD: "US", CAD: "CA" },
    timezone: "America/Los_Angeles",
    attributionWindowDays: 7,
    attributionBasis: "click",
    conversionDefinition: {
      model: basis === "click" ? "click" : basis === "click_and_view" ? "legacy_click_and_view" : "unknown",
      source: "Synthetic actual report settings confirm this metric definition",
    },
    dateOrder: null,
    observedAt,
    files: [{ fileName: "synthetic-measurement.csv", content, ...(metricColumns ? { metricColumns } : {}) }],
    allowPartial: false,
    idempotencyKey: "synthetic-measurement-original",
    ...overrides,
  });
  const file = input.files[0]!;
  const options = { ...input, reportTypeHint: file.reportTypeHint, adProductHint: file.adProductHint,
    metricColumns: file.metricColumns };
  return parseAdCsv(file.fileName, file.content, options);
}

const commonHeader = "Date,Advertiser ID,Ad product,Campaign ID,Ad Group ID,Currency,Impressions,Clicks,Spend";
const commonRow = "2026-09-01,synthetic-advertiser,SP,campaign,group,USD,1000,40,10.00";
const campaignCsv = `${commonHeader},Purchases,Sales\n${commonRow},2,100.00`;
const productCsv = `${commonHeader},Advertised ASIN,Purchases,Sales\n${commonRow},${asin},2,100.00`;
const searchCsv = `${commonHeader},Customer Search Term,Purchases,Sales\n${commonRow},unrelated synthetic term,0,0.00`;

function evidence(overrides: Partial<AdImportInput> = {}): AdStoredFact[] {
  return [campaignCsv, productCsv, searchCsv].flatMap(content => {
    const importId = createEntityId();
    const parsed = parse(content, overrides);
    return parsed.facts.map(fact => ({
      id: createEntityId(), importId, accountId,
      observedAt: overrides.observedAt ?? observedAt,
      recordedAt: overrides.observedAt ?? observedAt,
      timezone: overrides.timezone ?? "America/Los_Angeles",
      attributionWindowDays: overrides.attributionWindowDays === undefined ? 7 : overrides.attributionWindowDays,
      attributionBasis: overrides.attributionBasis ?? "click",
      sourceChecksum: parsed.checksum,
      sourceArchivedAt: null,
      fact,
    }));
  });
}

function goal(): AdGoalVersion {
  return {
    id: createEntityId(), productId: createEntityId(), revision: 1, scope,
    fields: AdGoalFieldsSchema.parse({
      mode: "profit_defense", effectiveFrom: "2026-09-01", targetAcosBps: 2000,
      unitPriceMinor: 10000, unitCostMinor: 7000, coreKeywords: [], protectedTerms: [],
      trialEndDate: null, trialSpendLimitMinor: null,
      minimumClicks: 15, minimumPurchases: 2, minimumSpendMinor: 1000,
      monetaryBasis: adCurrencyBasis("USD")!,
    }),
    checksum: "a".repeat(64), createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function analyze(facts: AdStoredFact[], cutoff = "2026-09-25T18:00:00.000Z") {
  return analyzeAdvertising({
    input: {
      accountId, periodStart: "2026-09-01", periodEnd: "2026-09-01",
      marketplace: null, currency: null, evidenceCutoffAt: cutoff,
      idempotencyKey: "synthetic-measurement-analysis",
    },
    facts, goals: [goal()],
  });
}

function productSpend(group: string, amount: string, overrides: Partial<AdImportInput>): AdStoredFact {
  const content = `${commonHeader},Advertised ASIN,Purchases,Sales\n${commonRow.replace(",group,", `,${group},`).replace(",10.00", `,${amount}`)},${asin},2,100.00`;
  const parsed = parse(content, overrides);
  expect(parsed.facts).toHaveLength(1);
  return {
    id: createEntityId(), importId: createEntityId(), accountId, observedAt: overrides.observedAt ?? observedAt,
    recordedAt: overrides.observedAt ?? observedAt, timezone: "America/Los_Angeles",
    attributionWindowDays: overrides.attributionWindowDays === undefined ? 7 : overrides.attributionWindowDays,
    attributionBasis: overrides.attributionBasis ?? "click", sourceChecksum: parsed.checksum,
    sourceArchivedAt: null, fact: parsed.facts[0]!,
  };
}

function budget(facts: AdStoredFact[]) {
  const growth = goal();
  growth.fields = AdGoalFieldsSchema.parse({ ...growth.fields, mode: "rank_growth", coreKeywords: ["custom pillow"],
    trialEndDate: "2026-09-30", trialSpendLimitMinor: 1000 });
  return analyzeAdvertising({ input: { accountId, periodStart: "2026-09-01", periodEnd: "2026-09-01", marketplace: null,
    currency: null, evidenceCutoffAt: "2026-09-25T18:00:00.000Z", idempotencyKey: "synthetic-measurement-budget" }, facts, goals: [growth] });
}

describe("advertising measurement: actual report columns and immutable collection basis", () => {
  it("measurement: keeps distinct customer search terms when Targeting is also present", () => {
    const parsed = parse(`${commonHeader},Targeting,Customer Search Term,7 Day Total Orders (#),7 Day Total Sales ($)\n` +
      `${commonRow},custom pillow,custom dog pillow,1,20.00\n` +
      `${commonRow},custom pillow,custom cat pillow,2,50.00`);
    expect(parsed.reportType).toBe("search_term");
    expect(parsed.acceptedRowCount).toBe(2);
    expect(parsed.rejectedRowCount).toBe(0);
    expect(parsed.facts.map(fact => fact.term)).toEqual(["custom dog pillow", "custom cat pillow"]);
    expect(new Set(parsed.facts.map(fact => fact.entityKey)).size).toBe(2);
    expect(parsed.facts[0]!.sourceFields.Targeting).toBe("custom pillow");
  });

  it("measurement: still identifies a true targeting report without customer search terms", () => {
    const parsed = parse(`${commonHeader},Targeting ID,Targeting,Purchases,Sales\n${commonRow},target-1,custom pillow,1,20.00`);
    expect(parsed.reportType).toBe("targeting");
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]).toMatchObject({ term: "custom pillow", targetId: "target-1" });
  });

  it("measurement: a purchased product report uses Purchased ASIN even when Advertised ASIN is present", () => {
    const parsed = parse(`${commonHeader},Advertised ASIN,Purchased ASIN,Purchases,Sales\n${commonRow},B012345678,B098765432,2,50.00`);
    expect(parsed.reportType).toBe("converted_product");
    expect(parsed.facts[0]).toMatchObject({ asin: "B098765432", sourceFields: { "Advertised ASIN": "B012345678", "Purchased ASIN": "B098765432" } });
  });

  it("measurement: customer search terms retain their grain when targeting and advertised product columns coexist", () => {
    const parsed = parse(`${commonHeader},Advertised ASIN,Targeting,Customer Search Term,Purchases,Sales\n${commonRow},B012345678,custom pillow,custom dog pillow,2,50.00`);
    expect(parsed.reportType).toBe("search_term");
    expect(parsed.facts[0]).toMatchObject({ asin: "B012345678", term: "custom dog pillow", sourceFields: { Targeting: "custom pillow" } });
  });

  it("measurement: never pairs seven-day orders with fourteen-day sales", () => {
    const parsed = parse(`${commonHeader},7 Day Total Orders (#),14 Day Total Sales ($)\n${commonRow},1,50.00`);
    expect(parsed.measurement?.conversion.state).toBe("conflict");
    expect(parsed.diagnostics.map(item => item.code)).toContain("CONVERSION_WINDOW_CONFLICT");
  });

  it("measurement: selects the declared fourteen-day orders and sales together", () => {
    const parsed = parse(`${commonHeader},7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)\n${commonRow},1,2,20.00,50.00`,
      { attributionWindowDays: 14 }, { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" });
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]!.metrics).toMatchObject({ purchases: 2, salesMinor: 5000 });
    expect(parsed.facts[0]!.sourceFields["7 Day Total Sales ($)"]).toBe("20.00");
    expect(parsed.facts[0]!.sourceFields["14 Day Total Sales ($)"]).toBe("50.00");
    expect(parsed.facts[0]!.measurement).toMatchObject({ conversion: { state: "resolved", model: "click", windowDays: 14 },
      columns: { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" } });
  });

  it("measurement: generic aliases do not override an explicitly selected fourteen-day pair", () => {
    const parsed = parse(`${commonHeader},Orders,Sales,14 Day Total Orders (#),14 Day Total Sales ($)\n${commonRow},9,90.00,2,50.00`,
      { attributionWindowDays: 14 }, { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" });
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]!.metrics).toMatchObject({ purchases: 2, salesMinor: 5000 });
  });

  it("measurement: empty selected fourteen-day values do not fall back to a seven-day pair", () => {
    const parsed = parse(`${commonHeader},7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)\n${commonRow},1,,20.00,`,
      { attributionWindowDays: 14 }, { purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)" });
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]!.metrics).toMatchObject({ purchases: null, salesMinor: null });
  });

  it("measurement: simultaneous windows without an explicit selector preserve raw cells and remain unresolved", () => {
    const parsed = parse(`${commonHeader},7 Day Total Orders (#),14 Day Total Orders (#),7 Day Total Sales ($),14 Day Total Sales ($)\n${commonRow},1,2,20.00,50.00`);
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]!.metrics).toMatchObject({ purchases: null, salesMinor: null, spendMinor: 1000 });
    expect(parsed.measurement?.conversion.state).toBe("unresolved");
    expect(parsed.metricCandidates?.salesMinor).toEqual(["7 Day Total Sales ($)", "14 Day Total Sales ($)"]);
    expect(parsed.diagnostics.map(item => item.code)).toContain("METRIC_COLUMN_AMBIGUOUS");
    expect(parsed.facts[0]!.sourceFields["14 Day Total Sales ($)"]).toBe("50.00");
  });

  it("measurement: an explicit selector cannot borrow an impressions column or an absent sales column", () => {
    for (const salesMinor of ["Impressions", "not-a-real-column"]) {
      const parsed = parse(`${commonHeader},Purchases,Sales\n${commonRow},1,20.00`, {}, { salesMinor });
      expect(parsed.facts).toHaveLength(0);
      expect(parsed.rejectedRowCount).toBe(1);
      expect(parsed.diagnostics.map(item => item.code)).toContain("METRIC_COLUMN_SELECTION_INVALID");
    }
  });

  it.each([
    ["JPY", "12", 12],
    ["KWD", "1.234", 1234],
    ["CLF", "1.2345", 12345],
  ] as const)("measurement: converts %s using its actual ISO minor precision", (currency, value, expected) => {
    expect(adMinor(value, currency)).toBe(expected);
  });

  it.each(["ZZZ", "XXX", "XAU"])("measurement: never guesses two minor digits for unknown precision %s", currency => {
    expect(() => adMinor("1.00", currency)).toThrow();
  });

  it.each(["CAD 1.00", "JPY 1"])("measurement: rejects a currency token contradicting the USD row: %s", value => {
    expect(() => adMinor(value, "USD")).toThrow();
  });

  it("measurement: accepts an explicit currency token matching the actual row currency", () => {
    expect(adMinor("USD 1.23", "USD")).toBe(123);
  });

  it("measurement: unknown precision retains original source amounts and counts with null normalized money", () => {
    const parsed = parse(`${commonHeader},Purchases,Sales\n${commonRow.replace(",USD,", ",ZZZ,")},2,123.456`);
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]).toMatchObject({ currency: "ZZZ", metrics: { clicks: 40, purchases: 2, spendMinor: null, salesMinor: null },
      measurement: { monetaryBasis: null }, sourceFields: { Spend: "10.00", Sales: "123.456" } });
    expect(parsed.diagnostics.map(item => item.code)).toContain("CURRENCY_PRECISION_UNKNOWN");
  });

  it("measurement: an immature captured snapshot does not mature when only the analysis cutoff advances", () => {
    const facts = evidence();
    const before = structuredClone(facts);
    const early = analyze(facts, "2026-09-03T18:00:00.000Z");
    const late = analyze(facts);
    const actionable = new Set(["negate_term", "harvest_exact", "lower_bid", "raise_bid"]);
    expect(early.selectedFactCount).toBe(3);
    expect(late.selectedFactCount).toBe(3);
    expect(early.recommendations.filter(item => actionable.has(item.kind))).toHaveLength(0);
    expect(late.recommendations.filter(item => actionable.has(item.kind))).toHaveLength(0);
    expect(facts).toEqual(before);
  });

  it("measurement: a genuinely mature recollected click snapshot can support the original negative review", () => {
    const result = analyze(evidence({ observedAt: "2026-09-10T18:00:00.000Z" }));
    expect(result.recommendations.some(item => item.kind === "negate_term")).toBe(true);
  });

  it.each([
    ["2026-09-08T06:59:59.000Z", false],
    ["2026-09-08T07:00:00.000Z", false],
  ] as const)("measurement: maturity uses the actual collection local day at %s", (at, canReviewNegative) => {
    const result = analyze(evidence({ observedAt: at }));
    expect(result.recommendations.some(item => item.kind === "negate_term")).toBe(canReviewNegative);
  });

  it("measurement: an inclusive end day needs the full seven-day attribution window before genuine recollection supports conversion review", () => {
    const seventhDay = analyze(evidence({ observedAt: "2026-09-08T18:00:00.000Z" }));
    const eighthDay = analyze(evidence({ observedAt: "2026-09-09T18:00:00.000Z" }));
    expect(seventhDay.recommendations.some(item => item.kind === "negate_term")).toBe(false);
    expect(eighthDay.recommendations.some(item => item.kind === "negate_term")).toBe(true);
  });

  it("measurement: a known window with unknown attribution basis cannot generate measured conversion actions", () => {
    const result = analyze(evidence({ observedAt: "2026-09-10T18:00:00.000Z", attributionBasis: "unknown" }));
    expect(result.recommendations.filter(item => ["negate_term", "harvest_exact", "lower_bid", "raise_bid"].includes(item.kind))).toHaveLength(0);
  });

  it.each(["click_and_view", "unknown"] as const)("measurement: %s purchases never become a click CVR even below click count", attributionBasis => {
    const result = analyze(evidence({ observedAt: "2026-09-10T18:00:00.000Z", attributionBasis }));
    expect(result.products).toHaveLength(1);
    expect(result.products[0]!.metrics).toMatchObject({ clicks: 40, purchases: 2 });
    expect(result.products[0]!.ratios.cvrBps).toBeNull();
  });

  it("measurement: retains click CVR for a confirmed mature click-only basis", () => {
    const result = analyze(evidence({ observedAt: "2026-09-10T18:00:00.000Z" }));
    expect(result.products[0]!.ratios.cvrBps).toBe(500);
  });

  it("measurement budget: independent entity spend still triggers the actual product cap when conversions are unresolved", () => {
    const first = productSpend("group-one", "6.00", { attributionBasis: "unknown", attributionWindowDays: null });
    const second = productSpend("group-two", "6.00", { attributionBasis: "unknown", attributionWindowDays: null });
    expect(first.fact.entityKey).not.toBe(second.fact.entityKey);
    expect(first.fact.measurement?.conversion.state).toBe("unresolved");
    expect(second.fact.measurement?.conversion.state).toBe("unresolved");
    expect(budget([first]).recommendations.some(value => value.ruleId === "AD_RANK_TRIAL_LIMIT")).toBe(false);
    const before = structuredClone([first, second]);
    const result = budget([first, second]);
    expect(result.recommendations).toEqual(expect.arrayContaining([expect.objectContaining({
      ruleId: "AD_RANK_TRIAL_LIMIT", kind: "budget_guard", metrics: expect.objectContaining({ spendMinor: 1200 }),
    })]));
    expect(result.products.every(value => value.ratios.cvrBps === null)).toBe(true);
    expect([first, second]).toEqual(before);
  });

  it("measurement budget: conversion-model variants never duplicate entity spend and a changed latest snapshot controls the cap", () => {
    const older = productSpend("same-group", "6.00", { observedAt: "2026-09-10T18:00:00.000Z" });
    const view = productSpend("same-group", "6.00", { observedAt: "2026-09-11T18:00:00.000Z", attributionBasis: "click_and_view" });
    expect(view.fact.entityKey).toBe(older.fact.entityKey);
    expect(view.fact.rowKey).toBe(older.fact.rowKey);
    expect(view.fact.measurement?.conversion.model).toBe("legacy_click_and_view");
    expect(budget([older, view]).recommendations.some(value => value.ruleId === "AD_RANK_TRIAL_LIMIT")).toBe(false);
    const changed = productSpend("same-group", "11.00", { observedAt: "2026-09-12T18:00:00.000Z", attributionBasis: "click_and_view" });
    expect(changed.fact.entityKey).toBe(older.fact.entityKey);
    const result = budget([older, view, changed]);
    const guards = result.recommendations.filter(value => value.ruleId === "AD_RANK_TRIAL_LIMIT");
    expect(guards).toHaveLength(1);
    expect(guards[0]!.metrics).toEqual({ spendMinor: 1100, impressions: null, clicks: null, purchases: null, salesMinor: null });
    expect(guards[0]).not.toHaveProperty("conversion");
  });
});
