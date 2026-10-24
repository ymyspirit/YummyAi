import { describe, expect, it } from "vitest";
import {
  addStockQuantity, ceilStockQuantity, compareStockQuantity, formatStockQuantity, negateStockQuantity,
  stockQuantityAtoms, stockQuantityFromRatio, stockQuantityString,
  stockQuantityValue, stockQuantityWithinCommandLimit, subtractStockQuantity,
  sumStockQuantities, wholeStockQuantity,
} from "./quantity.js";

describe("exact stock quantities", () => {
  it("retains whole-number transport and normalizes equivalent decimal input", () => {
    expect(stockQuantityValue(12)).toBe(12);
    expect(stockQuantityValue("0012.0000")).toBe(12);
    expect(stockQuantityValue("-0.000")).toBe(0);
    expect(stockQuantityValue("0.350000000")).toBe("0.35");
    expect(stockQuantityString(12)).toBe("12");
  });

  it("conserves repeated fractional receipts and issues without binary rounding", () => {
    const receipt = sumStockQuantities(Array.from({ length: 100 }, () => "0.01"));
    expect(receipt).toBe(1);
    expect(addStockQuantity("0.1", "0.2")).toBe("0.3");
    expect(subtractStockQuantity(receipt, "0.999999999")).toBe("0.000000001");
    expect(addStockQuantity("-0.35", "0.35")).toBe(0);
    expect(negateStockQuantity("0.35")).toBe("-0.35");
  });

  it("compares the smallest supported remainder at the original maximum", () => {
    expect(compareStockQuantity("2147483646.999999999", 2147483647)).toBe(-1);
    expect(stockQuantityWithinCommandLimit("2147483647")).toBe(true);
    expect(stockQuantityWithinCommandLimit("2147483647.000000001")).toBe(false);
    expect(stockQuantityWithinCommandLimit("-2147483647.000000001")).toBe(false);
  });

  it("keeps aggregate amounts beyond safe JSON integers as strings", () => {
    expect(addStockQuantity("9007199254740991", 1)).toBe("9007199254740992");
    expect(JSON.stringify({ amount: stockQuantityValue("9007199254740992") })).toBe('{"amount":"9007199254740992"}');
    expect(() => addStockQuantity("999999999999999999999999999999", 1)).toThrow(RangeError);
  });

  it("renders precise quantities without the usual three-decimal display rounding", () => {
    expect(formatStockQuantity("1234.123456789")).toBe("1,234.123456789");
    expect(formatStockQuantity("-0.000000001")).toBe("-0.000000001");
    expect(formatStockQuantity("9007199254740992")).toBe("9,007,199,254,740,992");
  });

  it("rejects fractional numbers, scientific notation, invalid values and hidden precision loss", () => {
    for (const value of [0.35, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
      "1e-3", "Infinity", "NaN", " 0.1", "0.1234567890", "1.", ""] as const) {
      expect(() => stockQuantityAtoms(value)).toThrow(RangeError);
    }
  });

  it("converts exact production ratios and refuses an invented rounded third", () => {
    expect(stockQuantityFromRatio(35n * 3n, 100n)).toBe("1.05");
    expect(stockQuantityFromRatio(1n, 1_000_000_000n)).toBe("0.000000001");
    expect(() => stockQuantityFromRatio(1n, 3n)).toThrow(RangeError);
    expect(() => stockQuantityFromRatio(1n, 10_000_000_000n)).toThrow(RangeError);
    expect(() => stockQuantityFromRatio(1n, 0n)).toThrow(RangeError);
  });

  it("distinguishes counted units and explicit purchase coverage from actual consumption", () => {
    expect(wholeStockQuantity("1.000")).toBe(true);
    expect(wholeStockQuantity("1.05")).toBe(false);
    expect(ceilStockQuantity("1.05")).toBe(2);
    expect(ceilStockQuantity("-1.05")).toBe(-1);
    expect(stockQuantityFromRatio(105n, 100n)).toBe("1.05");
  });
});
