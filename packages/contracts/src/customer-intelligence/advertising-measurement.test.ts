import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  AD_MEASUREMENT_ADAPTER,
  AdConversionBasisSchema,
  AdConversionDefinitionSchema,
  AdCurrencyBasisSchema,
  AdCurrencyPrecisionSchema,
  AdFactMeasurementSchema,
  AdFileMeasurementSchema,
  AdMetricColumnSelectionSchema,
  adCurrencyBasis,
  adCurrencyPrecision,
  formatAdMinorAmount,
  parseAdMinorAmount,
} from "./advertising-measurement.js";
import { AdAnalysisResultSchema, AdAnalysisRunSchema, AdFactSchema, AdImportInputSchema, AdMeasurementPinSchema } from "./advertising-workbench.js";

const columns = {
  impressions: "Impressions", clicks: "Clicks", purchases: "14 Day Total Orders (#)",
  spendMinor: "Spend", salesMinor: "14 Day Total Sales ($)", bidMinor: null,
};
const conversion = {
  state: "resolved" as const, model: "click" as const, windowDays: 14,
  source: "Synthetic report settings explicitly confirm click-only attribution",
};
const measurement = () => ({ schemaVersion: 1 as const, adapterVersion: AD_MEASUREMENT_ADAPTER,
  columns, conversion, monetaryBasis: adCurrencyBasis("USD") });
const legacyFact = () => ({
  sourceRow: 2, rowKey: "a".repeat(64), entityKey: "b".repeat(64), reportType: "campaign" as const,
  adProduct: "SP" as const, advertiserId: "synthetic", currency: "USD", marketplace: "US" as const,
  periodStart: "2026-09-01", periodEnd: "2026-09-01", grain: "daily" as const,
  campaignId: "campaign", campaignName: null, adGroupId: null, adGroupName: null,
  asin: null, productName: null, term: null, targetId: null, matchType: null,
  bidMinor: null, status: null, placement: null,
  metrics: { impressions: 100, clicks: 10, purchases: 1, spendMinor: 100, salesMinor: 200 },
  dimensions: {}, sourceFields: { Currency: "USD", Spend: "1.00" }, qualityCodes: [],
});

describe("advertising pinned measurement contracts", () => {
  it.each([
    ["JPY", 0, "12", 12],
    ["USD", 2, "1.23", 123],
    ["KWD", 3, "1.234", 1234],
    ["CLF", 4, "1.2345", 12345],
  ] as const)("pins %s to the fixed ISO precision instead of a runtime default", (currency, minorDigits, text, amount) => {
    expect(adCurrencyBasis(currency)).toEqual({
      schemaVersion: 1, currency, minorDigits, currencyTableVersion: "iso4217-2026-09-17-v1",
    });
    expect(parseAdMinorAmount(text, currency)).toBe(amount);
    expect(formatAdMinorAmount(amount, currency, adCurrencyBasis(currency))).toBe(`${currency} ${text}`);
  });

  it.each(["XXX", "XAU", "ZZZ"])("retains unknown precision for %s without inventing a monetary basis", currency => {
    expect(adCurrencyPrecision(currency)).toMatchObject({ currency, minorDigits: null });
    expect(adCurrencyBasis(currency)).toBeNull();
    expect(() => parseAdMinorAmount("1.00", currency)).toThrow();
    expect(parseAdMinorAmount(null, currency)).toBeNull();
    expect(AdCurrencyBasisSchema.safeParse({ ...adCurrencyPrecision(currency), minorDigits: 2 }).success).toBe(false);
  });

  it("rejects forged precision and an unpinned currency table version", () => {
    expect(AdCurrencyPrecisionSchema.safeParse({ ...adCurrencyPrecision("JPY"), minorDigits: 2 }).success).toBe(false);
    expect(AdCurrencyBasisSchema.safeParse({ ...adCurrencyBasis("KWD"), minorDigits: 2 }).success).toBe(false);
    expect(AdCurrencyBasisSchema.safeParse({ ...adCurrencyBasis("USD"), currencyTableVersion: "runtime-intl" }).success).toBe(false);
  });

  it("rejects contradictory leading and trailing currency tokens while preserving valid explicit tokens", () => {
    for (const value of ["CAD 1.00", "1.00 CAD", "JPY 1", "USD 1.00 CAD", "€1.00"])
      expect(() => parseAdMinorAmount(value, "USD")).toThrow();
    expect(parseAdMinorAmount("USD 1.23", "USD")).toBe(123);
    expect(parseAdMinorAmount("1.23 USD", "USD")).toBe(123);
    expect(parseAdMinorAmount("KWD 1.234", "KWD")).toBe(1234);
    expect(parseAdMinorAmount("¥12", "JPY")).toBe(12);
  });

  it("keeps exact trailing zeros but never rounds a nonzero subminor amount", () => {
    expect(parseAdMinorAmount("1.230000", "USD")).toBe(123);
    expect(parseAdMinorAmount("12.000", "JPY")).toBe(12);
    expect(() => parseAdMinorAmount("1.2341", "KWD")).toThrow();
    expect(() => parseAdMinorAmount("0.001", "USD")).toThrow();
    expect(parseAdMinorAmount("0", "USD")).toBe(0);
    expect(parseAdMinorAmount(null, "USD")).toBeNull();
  });

  it("converts the safe integer boundary exactly and refuses overflow or fabricated numeric syntax", () => {
    expect(parseAdMinorAmount("90071992547409.91", "USD")).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatAdMinorAmount(Number.MAX_SAFE_INTEGER, "USD", adCurrencyBasis("USD"))).toBe("USD 90071992547409.91");
    for (const text of ["90071992547409.92", "-1", "1e2", "1,23.00", "NaN"])
      expect(() => parseAdMinorAmount(text, "USD")).toThrow();
  });

  it("does not format historical minor integers as verified major amounts when the original precision was not saved", () => {
    expect(formatAdMinorAmount(123, "JPY")).toBe("JPY 123 保存的最小单位（原精度未保存）");
    expect(formatAdMinorAmount(0, "USD", null)).toContain("原精度未保存");
    expect(() => formatAdMinorAmount(123, "JPY", adCurrencyBasis("USD"))).toThrow();
    expect(formatAdMinorAmount(null, "USD", adCurrencyBasis("USD"))).toBe("待补充");
  });

  it("requires an actual model definition source rather than deriving it from an SP filename", () => {
    expect(AdConversionDefinitionSchema.safeParse({ model: "click", source: "" }).success).toBe(false);
    expect(AdConversionDefinitionSchema.parse({ model: "unknown", source: "" })).toEqual({ model: "unknown", source: "" });
    expect(AdConversionDefinitionSchema.parse({ model: "shopping_signal_2026", source: "Synthetic source explicitly defines shopping signals" }).model).toBe("shopping_signal_2026");
    expect(AdConversionDefinitionSchema.safeParse({ model: "click", source: "Synthetic source", inferredFromFilename: true }).success).toBe(false);
  });

  it("cannot call an unknown model, unknown window or missing definition source resolved", () => {
    expect(AdConversionBasisSchema.parse(conversion).state).toBe("resolved");
    for (const value of [{ ...conversion, model: "unknown" }, { ...conversion, windowDays: null }, { ...conversion, source: null }])
      expect(AdConversionBasisSchema.safeParse(value).success).toBe(false);
    expect(AdConversionBasisSchema.parse({ state: "unresolved", model: "unknown", windowDays: null, source: null }).state).toBe("unresolved");
  });

  it("keeps all-views fourteen-day metrics distinct from click or legacy click-and-view definitions", () => {
    expect(AdConversionBasisSchema.parse({ ...conversion, model: "all_views_14d" }).windowDays).toBe(14);
    expect(AdConversionBasisSchema.safeParse({ ...conversion, model: "all_views_14d", windowDays: 7 }).success).toBe(false);
    expect(AdConversionBasisSchema.parse({ ...conversion, model: "legacy_click_and_view" }).model).toBe("legacy_click_and_view");
  });

  it("uses exact per-file column names and explicit null selections without silently accepting unrelated selector keys", () => {
    expect(AdMetricColumnSelectionSchema.parse({ purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)", bidMinor: null })).toEqual({
      purchases: "14 Day Total Orders (#)", salesMinor: "14 Day Total Sales ($)", bidMinor: null,
    });
    expect(AdMetricColumnSelectionSchema.safeParse({ salesMinor: "" }).success).toBe(false);
    expect(AdMetricColumnSelectionSchema.safeParse({ orders: "Orders" }).success).toBe(false);
  });

  it("pins a unique sorted file currency list and the actual parser adapter version", () => {
    const value = { schemaVersion: 1, adapterVersion: AD_MEASUREMENT_ADAPTER, columns, conversion,
      currencies: [adCurrencyPrecision("CAD"), adCurrencyPrecision("USD")] };
    expect(AdFileMeasurementSchema.parse(value).currencies.map(item => item.currency)).toEqual(["CAD", "USD"]);
    expect(AdFileMeasurementSchema.safeParse({ ...value, currencies: [...value.currencies].reverse() }).success).toBe(false);
    expect(AdFileMeasurementSchema.safeParse({ ...value, currencies: [value.currencies[0], value.currencies[0]] }).success).toBe(false);
    expect(AdFactMeasurementSchema.safeParse({ ...measurement(), adapterVersion: "current" }).success).toBe(false);
  });

  it("retains raw unknown-currency cells and null money without pretending zero or dropping the entire source", () => {
    const fact = { ...legacyFact(), currency: "ZZZ", metrics: { ...legacyFact().metrics, spendMinor: null, salesMinor: null },
      sourceFields: { Currency: "ZZZ", Spend: "1.2345", Sales: "0" }, qualityCodes: ["CURRENCY_PRECISION_UNKNOWN"],
      measurement: { ...measurement(), monetaryBasis: null } };
    expect(AdFactSchema.parse(fact)).toMatchObject({ currency: "ZZZ", metrics: { spendMinor: null, salesMinor: null }, sourceFields: { Spend: "1.2345" } });
    expect(AdFactSchema.safeParse({ ...fact, metrics: { ...fact.metrics, spendMinor: 123 } }).success).toBe(false);
    expect(AdFactSchema.safeParse({ ...legacyFact(), measurement: { ...measurement(), monetaryBasis: adCurrencyBasis("JPY") } }).success).toBe(false);
  });

  it("does not backfill a measurement claim into a legacy normalized fact or old import request", () => {
    const fact = legacyFact();
    expect(AdFactSchema.parse(fact)).toEqual(fact);
    expect(AdFactSchema.parse(fact)).not.toHaveProperty("measurement");
    const input = AdImportInputSchema.parse({ accountId: createEntityId(), marketplaceByCurrency: {}, timezone: "UTC",
      attributionWindowDays: 7, attributionBasis: "click", observedAt: "2026-09-10T00:00:00.000Z",
      files: [{ fileName: "SP.csv", content: "Date,Spend\n2026-09-01,1.00" }], idempotencyKey: "synthetic-legacy-request" });
    expect(input).not.toHaveProperty("conversionDefinition");
    expect(input.files[0]).not.toHaveProperty("metricColumns");
  });

  function pinnedResult() {
    const importId = createEntityId();
    return {
      measurementVersion: 1 as const, measurementPins: [{ importId, currency: "USD", sourceChecksum: "c".repeat(64),
        observedAt: "2026-09-24T18:00:00.000Z", timezone: "America/Los_Angeles", declaredWindowDays: 14,
        declaredBasis: "click" as const, sourceArchivedAt: null, measurement: measurement() }],
      controlType: "search_term" as const, totals: [], products: [], recommendations: [], diagnostics: [],
      evidenceImportIds: [importId], goalVersionIds: [], selectedFactCount: 1, supersededFactCount: 0, dailyTrend: [],
    };
  }

  it("measurement pins: distinguishes two original currencies in one import without duplicating the evidence import", () => {
    const result = pinnedResult(), pin = result.measurementPins[0]!;
    result.measurementPins.push({ ...pin, currency: "CAD", measurement: { ...measurement(), monetaryBasis: adCurrencyBasis("CAD") } });
    expect(AdAnalysisResultSchema.parse(result).measurementPins).toHaveLength(2);
    expect(result.evidenceImportIds).toHaveLength(1);
  });

  it("measurement pins: requires the actual currency and refuses a mismatched original monetary basis", () => {
    const value = pinnedResult().measurementPins[0]!;
    expect(AdMeasurementPinSchema.safeParse(value).success).toBe(true);
    expect(AdMeasurementPinSchema.safeParse({ ...value, currency: "JPY" }).success).toBe(false);
    const missing: Record<string, unknown> = { ...value }; delete missing.currency;
    expect(AdMeasurementPinSchema.safeParse(missing).success).toBe(false);
    expect(AdMeasurementPinSchema.safeParse({ ...value, currency: null, measurement: null }).success).toBe(true);
  });

  it("measurement pins: rejects omitted extra or duplicated source evidence instead of accepting an incomplete pinned result", () => {
    const result = pinnedResult(); expect(AdAnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(AdAnalysisResultSchema.safeParse({ ...result, measurementPins: [] }).success).toBe(false);
    expect(AdAnalysisResultSchema.safeParse({ ...result, measurementPins: [...result.measurementPins, result.measurementPins[0]] }).success).toBe(false);
    expect(AdAnalysisResultSchema.safeParse({ ...result, evidenceImportIds: [...result.evidenceImportIds, createEntityId()] }).success).toBe(false);
    expect(AdAnalysisResultSchema.safeParse({ ...result, evidenceImportIds: [] }).success).toBe(false);
  });

  it("measurement pins: requires version and complete pins together while leaving a legacy result unstamped", () => {
    const result = pinnedResult(); expect(AdAnalysisResultSchema.safeParse(result).success).toBe(true);
    const withoutVersion: Record<string, unknown> = { ...result }; delete withoutVersion.measurementVersion;
    const withoutPins: Record<string, unknown> = { ...result }; delete withoutPins.measurementPins;
    expect(AdAnalysisResultSchema.safeParse(withoutVersion).success).toBe(false);
    expect(AdAnalysisResultSchema.safeParse(withoutPins).success).toBe(false);
    const legacy = { ...withoutVersion }; delete legacy.measurementPins;
    expect(AdAnalysisResultSchema.parse(legacy)).toEqual(legacy);
  });

  it("measurement pins: a saved run cannot include a source collected after its original evidence cutoff", () => {
    const run = { id: createEntityId(), accountId: createEntityId(), periodStart: "2026-09-01", periodEnd: "2026-09-15",
      marketplace: null, currency: null, evidenceCutoffAt: "2026-10-01T00:00:00.000Z", status: "complete",
      inputChecksum: "d".repeat(64), createdAt: "2026-10-01T00:00:00.000Z", result: pinnedResult() };
    expect(AdAnalysisRunSchema.safeParse(run).success).toBe(true);
    expect(AdAnalysisRunSchema.safeParse({ ...run, result: { ...run.result, measurementPins: run.result.measurementPins.map(pin => ({
      ...pin, observedAt: "2026-10-01T00:00:00.001Z",
    })) } }).success).toBe(false);
  });
});
