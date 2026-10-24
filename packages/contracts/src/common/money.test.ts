import { describe, expect, it } from "vitest";
import { currencyMinorDigits, formatMinorAmount, parseMinorAmount } from "./money.js";

describe("currency-aware exact minor amount transport", () => {
  it.each([["JPY", 0], ["USD", 2], ["CNY", 2], ["KWD", 3]] as const)("uses %s's actual minor precision", (currency, digits) => {
    expect(currencyMinorDigits(currency)).toBe(digits);
  });

  it("retains large USD cents that division and toFixed would alter", () => {
    expect(parseMinorAmount("90071992547409.90", "USD")).toBe(9007199254740990);
    expect(formatMinorAmount(9007199254740990, "USD")).toBe("90071992547409.90");
    expect(parseMinorAmount("90071992547409.91", "USD")).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatMinorAmount(Number.MAX_SAFE_INTEGER, "USD")).toBe("90071992547409.91");
    expect(() => parseMinorAmount("90071992547409.92", "USD")).toThrow("money_out_of_range");
  });

  it("parses and formats whole yen and three-digit dinar without a two-digit assumption", () => {
    expect(parseMinorAmount("1200", "JPY")).toBe(1200);
    expect(formatMinorAmount(1200, "JPY")).toBe("1200");
    expect(() => parseMinorAmount("1200.1", "JPY")).toThrow("money_decimal_precision_invalid");
    expect(parseMinorAmount("0.001", "KWD")).toBe(1);
    expect(formatMinorAmount(1, "KWD")).toBe("0.001");
    expect(parseMinorAmount("9007199254740.991", "KWD")).toBe(Number.MAX_SAFE_INTEGER);
    expect(formatMinorAmount(Number.MAX_SAFE_INTEGER, "KWD")).toBe("9007199254740.991");
  });

  it("distinguishes known zero and signed displayed variances", () => {
    expect(parseMinorAmount(" 0000.00 ", "USD")).toBe(0);
    expect(formatMinorAmount(0, "USD")).toBe("0.00");
    expect(formatMinorAmount(-29, "USD")).toBe("-0.29");
    expect(formatMinorAmount(-Number.MAX_SAFE_INTEGER, "KWD")).toBe("-9007199254740.991");
  });

  it.each(["0.001", "1.000", "1e3", "1,200.00", ".29", "1.", "-1", "+1", "NaN", "Infinity", ""])("refuses unsupported USD text %j without rounding", value => {
    expect(() => parseMinorAmount(value, "USD")).toThrow("money_decimal_precision_invalid");
  });

  it("does not invent the precision of an unknown currency", () => {
    expect(currencyMinorDigits("ZZZ")).toBeNull();
    expect(() => parseMinorAmount("1.00", "ZZZ")).toThrow("currency_precision_unknown");
    expect(formatMinorAmount(123, "ZZZ")).toBe("123 最小单位");
  });

  it.each([0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("refuses an inexact displayed integer minor value %s", value => {
    expect(() => formatMinorAmount(value, "USD")).toThrow("money_out_of_range");
  });
});
