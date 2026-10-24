import { describe, expect, it } from "vitest";
import {
  assertProcurementQuantityUnit, convertProcurementQuantity, equivalentProcurementPrice,
  pinProcurementStockBasis, procurementAmountMinor, procurementUnitRatio,
  safeMinorValue, subtractProcurementMinor, sumProcurementMinor,
} from "./measurement.js";

describe("exact procurement measurement and integer minor amounts", () => {
  it("pins the supported metric ratios and never infers pieces from pairs or sets", () => {
    expect(procurementUnitRatio("kilogram", "gram")).toEqual({ numerator: 1000n, denominator: 1n });
    expect(procurementUnitRatio("gram", "kilogram")).toEqual({ numerator: 1n, denominator: 1000n });
    for (const unit of ["each", "pair", "set", "meter", "gram", "kilogram"] as const)
      expect(procurementUnitRatio(unit, unit)).toEqual({ numerator: 1n, denominator: 1n });
    for (const [from, to] of [["pair", "each"], ["set", "each"], ["meter", "gram"]] as const)
      expect(() => procurementUnitRatio(from, to)).toThrow("procurement_unit_conversion_unavailable");
  });

  it("converts actual quantities exactly in both directions without binary decimals", () => {
    expect(convertProcurementQuantity("0.250000000", "kilogram", "gram")).toBe(250);
    expect(convertProcurementQuantity(250, "gram", "kilogram")).toBe("0.25");
    expect(convertProcurementQuantity("0.000000001", "kilogram", "gram")).toBe("0.000001");
    expect(convertProcurementQuantity("2147483646.000000001", "gram", "gram")).toBe("2147483646.000000001");
    expect(convertProcurementQuantity("001.000000000", "meter", "meter")).toBe(1);
  });

  it("rejects conversions below one billionth and checks the converted command limit", () => {
    expect(() => convertProcurementQuantity("0.000000001", "gram", "kilogram")).toThrow(RangeError);
    expect(convertProcurementQuantity("2147483.647", "kilogram", "gram")).toBe(2147483647);
    expect(() => convertProcurementQuantity("2147483.647000001", "kilogram", "gram")).toThrow(RangeError);
    expect(() => convertProcurementQuantity("0.0000000001", "meter", "meter")).toThrow(RangeError);
    expect(() => convertProcurementQuantity(0.25, "kilogram", "gram")).toThrow(RangeError);
  });

  it.each(["each", "pair", "set"] as const)("keeps %s integral before conversion and pricing", unit => {
    expect(convertProcurementQuantity("2.000000000", unit, unit)).toBe(2);
    expect(() => convertProcurementQuantity("0.5", unit, unit)).toThrow(RangeError);
    expect(() => assertProcurementQuantityUnit("0.000000001", unit)).toThrow("procurement_discrete_quantity_invalid");
    expect(() => assertProcurementQuantityUnit(2, unit)).not.toThrow();
  });

  it("pins the original stock unit, exact base quantity and base pricing quantity", () => {
    const original = { quantity: "0.25", unit: "kilogram" as const, priceBasisQuantity: "0.5" };
    expect(pinProcurementStockBasis(original, "gram")).toEqual({ ...original, stockBasis: {
      version: 1, rule: "metric-unit-v1", stockUnit: "gram", stockQuantity: 250,
      conversionNumerator: "1000", conversionDenominator: "1", priceBasisStockQuantity: 500,
    } });
    expect(original).toEqual({ quantity: "0.25", unit: "kilogram", priceBasisQuantity: "0.5" });
    const legacy = pinProcurementStockBasis({ quantity: 2, unit: "kilogram" as const }, "gram");
    expect(legacy.stockBasis.priceBasisStockQuantity).toBe(1000);
    expect(legacy).not.toHaveProperty("priceBasisQuantity");
  });

  it("computes decimal line amounts in minor units without a floating-point product", () => {
    expect(procurementAmountMinor("0.29", 100)).toBe(29);
    expect(procurementAmountMinor("1.000000001", 1_000_000_000)).toBe(1_000_000_001);
    expect(procurementAmountMinor("0.000000001", 1_000_000_000)).toBe(1);
    expect(procurementAmountMinor("0.25", 1200, 1)).toBe(300);
    expect(procurementAmountMinor("0.1", 60, "0.05")).toBe(120);
    expect(procurementAmountMinor("0.000000001", 0)).toBe(0);
  });

  it("refuses a fractional minor amount instead of rounding or hiding it in a later sum", () => {
    for (const [quantity, minor, basis] of [["0.5", 1, 1], [1, 1, 3], ["0.000000001", 1, 1]] as const)
      expect(() => procurementAmountMinor(quantity, minor, basis)).toThrow("procurement_amount_precision_unavailable");
    expect(() => procurementAmountMinor(1, 1, 0)).toThrow("procurement_price_basis_invalid");
    expect(() => procurementAmountMinor(1, 0.5)).toThrow("procurement_money_invalid");
    expect(() => procurementAmountMinor(1, -1)).toThrow("procurement_money_invalid");
  });

  it("preserves the safe boundary and refuses overflow in products, sums and signed variances", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(procurementAmountMinor(1, max)).toBe(max);
    expect(() => procurementAmountMinor(2, max)).toThrow("procurement_money_out_of_range");
    expect(sumProcurementMinor([max - 1, 1])).toBe(max);
    expect(() => sumProcurementMinor([max, 1])).toThrow("procurement_money_out_of_range");
    expect(subtractProcurementMinor(0, max)).toBe(-max);
    expect(() => subtractProcurementMinor(-max, 1)).toThrow("procurement_money_out_of_range");
    expect(() => safeMinorValue(BigInt(max) + 1n)).toThrow("procurement_money_out_of_range");
    expect(() => sumProcurementMinor([1, Number.NaN])).toThrow("procurement_money_invalid");
  });

  it("compares equivalent price bases exactly while detecting a one-minor price change", () => {
    expect(equivalentProcurementPrice(1200, 1, 60, "0.05")).toBe(true);
    expect(equivalentProcurementPrice(1200, 1, 61, "0.05")).toBe(false);
    expect(equivalentProcurementPrice(1, "0.000000001", 1_000_000_000, 1)).toBe(true);
  });
});
