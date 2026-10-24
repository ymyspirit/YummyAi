import { describe, expect, it } from "vitest";
import { FinanceCalculationMonetaryBasisSchema, buildFinanceCalculationBasis, convertFinanceMinorAmount, formatFinanceMinorAmount, pinFinanceFxBasis } from "./monetary.js";

const version = "iso4217-2026-09-17-v1";
const convert = (amountMinor: number, sourceCurrency: string, targetCurrency: string, rateNumerator: number, rateDenominator: number) =>
  convertFinanceMinorAmount({ amountMinor, sourceCurrency, targetCurrency, rateNumerator, rateDenominator,
    rateBasis: pinFinanceFxBasis(sourceCurrency, targetCurrency), calculationBasis: buildFinanceCalculationBasis([sourceCurrency, targetCurrency]) });

describe("fixed ISO minor units and major currency FX", () => {
  it("pins an explicit major-to-major rate without borrowing host Intl currency precision", () => {
    expect(pinFinanceFxBasis("EUR", "JPY")).toEqual({ schemaVersion: 1, rateUnit: "major_to_major",
      baseMinorDigits: 2, quoteMinorDigits: 0, currencyTableVersion: version });
    expect(pinFinanceFxBasis("KWD", "USD")).toMatchObject({ baseMinorDigits: 3, quoteMinorDigits: 2 });
  });
  it("stores a stable calculation basis with known and unknown currencies separately", () => {
    expect(buildFinanceCalculationBasis(["USD", "XXX", "JPY", "KWD", "ZZZ", "USD"])).toEqual({ schemaVersion: 2,
      algorithm: "iso_minor_fx_v2", rounding: "half_away_from_zero_per_fact", currencyTableVersion: version,
      currencies: [{ currency: "JPY", minorDigits: 0 }, { currency: "KWD", minorDigits: 3 }, { currency: "USD", minorDigits: 2 },
        { currency: "XXX", minorDigits: null }, { currency: "ZZZ", minorDigits: null }] });
  });
  it.each([
    { source: "EUR", target: "JPY", amount: 2000, numerator: 160, denominator: 1, expected: 3200 },
    { source: "JPY", target: "USD", amount: 1234, numerator: 1, denominator: 150, expected: 823 },
    { source: "KWD", target: "USD", amount: 1234, numerator: 3, denominator: 1, expected: 370 },
    { source: "USD", target: "KWD", amount: 123, numerator: 1, denominator: 3, expected: 410 },
    { source: "CLF", target: "USD", amount: 12345, numerator: 1000, denominator: 1, expected: 123450 },
    { source: "USD", target: "CLF", amount: 123, numerator: 1, denominator: 1000, expected: 12 },
  ])("converts $source into $target using both actual minor units", value => {
    expect(convert(value.amount, value.source, value.target, value.numerator, value.denominator)).toEqual({ amountMinor: value.expected, problem: null });
  });
  it.each([{ amount: 1, expected: 1 }, { amount: -1, expected: -1 }, { amount: 0, expected: 0 }])(
    "rounds a signed half-minor $amount away from zero", ({ amount, expected }) => {
      expect(convert(amount, "JPY", "USD", 1, 200)).toEqual({ amountMinor: expected, problem: null });
    });
  it("rounds each fact before adding it, rather than rounding a combined statement", () => {
    const first = convert(1, "JPY", "USD", 1, 200), second = convert(1, "JPY", "USD", 1, 200);
    expect(first.amountMinor! + second.amountMinor!).toBe(2); expect(convert(2, "JPY", "USD", 1, 200).amountMinor).toBe(1);
    expect(convert(4, "JPY", "USD", 1, 1000).amountMinor).toBe(0);
    expect(convert(-4, "JPY", "USD", 1, 1000).amountMinor).toBe(0);
  });
  it("retains a same-currency safe boundary exactly and rejects converted overflow", () => {
    expect(convertFinanceMinorAmount({ amountMinor: Number.MAX_SAFE_INTEGER, sourceCurrency: "USD", targetCurrency: "USD", rateBasis: null,
      calculationBasis: buildFinanceCalculationBasis(["USD"]) })).toEqual({ amountMinor: Number.MAX_SAFE_INTEGER, problem: null });
    expect(() => convert(Number.MAX_SAFE_INTEGER, "USD", "KWD", 1, 1)).toThrow();
    expect(() => convert(Number.MAX_SAFE_INTEGER + 1, "USD", "USD", 1, 1)).toThrow();
  });
  it("interprets an unlabeled old rate only when both known currency precisions are the same", () => {
    expect(convertFinanceMinorAmount({ amountMinor: 2000, sourceCurrency: "EUR", targetCurrency: "USD", rateNumerator: 11, rateDenominator: 10,
      rateBasis: null, calculationBasis: buildFinanceCalculationBasis(["EUR", "USD"]) })).toEqual({ amountMinor: 2200, problem: null });
    expect(convertFinanceMinorAmount({ amountMinor: 2000, sourceCurrency: "EUR", targetCurrency: "JPY", rateNumerator: 160, rateDenominator: 1,
      rateBasis: null, calculationBasis: buildFinanceCalculationBasis(["EUR", "JPY"]) })).toEqual({ amountMinor: null, problem: "fx_rate_unit_unknown" });
  });
  it.each(["ZZZ", "XXX", "XAU", "BGN"])("does not pretend %s has two decimal places", currency => {
    expect(convertFinanceMinorAmount({ amountMinor: 1234, sourceCurrency: currency, targetCurrency: currency, rateBasis: null,
      calculationBasis: buildFinanceCalculationBasis([currency]) })).toEqual({ amountMinor: null, problem: "currency_precision_unknown" });
  });
  it("distinguishes a missing rate from an unknown currency precision", () => {
    expect(convertFinanceMinorAmount({ amountMinor: 100, sourceCurrency: "EUR", targetCurrency: "USD", rateBasis: null,
      calculationBasis: buildFinanceCalculationBasis(["EUR", "USD"]) })).toEqual({ amountMinor: null, problem: null });
    expect(() => pinFinanceFxBasis("XXX", "USD")).toThrow("finance_currency_precision_unknown");
    expect(formatFinanceMinorAmount(1234, "XXX")).toBe("XXX 1234 最小单位（精度待核对）");
  });
  it.each([{ currency: "JPY", minorDigits: 2 }, { currency: "KWD", minorDigits: 2 }])("rejects a forged $currency calculation precision", value => {
    const basis = buildFinanceCalculationBasis([value.currency]);
    expect(FinanceCalculationMonetaryBasisSchema.safeParse({ ...basis, currencies: [value] }).success).toBe(false);
  });
  it.each([
    { amount: 1234, currency: "JPY", expected: "JPY 1234" },
    { amount: 1234, currency: "KWD", expected: "KWD 1.234" },
    { amount: 9007199254740990, currency: "USD", expected: "USD 90071992547409.90" },
    { amount: -9007199254740990, currency: "USD", expected: "USD -90071992547409.90" },
    { amount: 0, currency: "KWD", expected: "KWD 0.000" },
  ])("formats $currency $amount from exact integer digits", ({ amount, currency, expected }) => {
    expect(formatFinanceMinorAmount(amount, currency).replace(/\u00a0/g, " ")).toBe(expected);
  });
});
