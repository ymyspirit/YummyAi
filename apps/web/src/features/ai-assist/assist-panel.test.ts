import { describe, expect, it } from "vitest";
import { assistOrderPriceReady } from "./assist-panel";

describe("order analysis explicit spending policy", () => {
  const priced = { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 3 };

  it("allows an explicitly unlimited task without fabricating missing unit prices", () => {
    expect(assistOrderPriceReady({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null })).toBe(true);
    expect(assistOrderPriceReady({ ...priced, maxTaskCostUsd: null })).toBe(true);
    expect(assistOrderPriceReady(undefined)).toBe(false);
  });

  it("continues requiring both actual unit prices for a finite task cap", () => {
    expect(assistOrderPriceReady(priced)).toBe(true);
    expect(assistOrderPriceReady({ ...priced, inputUsdPerMillion: 0, outputUsdPerMillion: 0 })).toBe(true);
    for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(assistOrderPriceReady({ ...priced, inputUsdPerMillion: value })).toBe(false);
      expect(assistOrderPriceReady({ ...priced, outputUsdPerMillion: value })).toBe(false);
    }
  });

  it("rejects invalid finite caps rather than treating zero or a missing number as unlimited", () => {
    for (const maxTaskCostUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(assistOrderPriceReady({ ...priced, maxTaskCostUsd })).toBe(false);
  });
});
