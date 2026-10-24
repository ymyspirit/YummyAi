import { describe, it, expect } from "vitest";
import { adCurrencyBasis, type AdProductSummary, type AdObservation } from "@yummyai/contracts/advertising";
import { adInputMinor, adMajor, adMoney, adRankProgress } from "./advertising-client";
describe("advertising operator evidence", () => {
  it("parses monetary input exactly for the currency without silently rounding extra decimals", () => {
    expect(adInputMinor("0.85", "USD")).toBe(85);
    expect(adInputMinor("100", "JPY")).toBe(100);
    expect(adInputMinor("", "USD")).toBeNull();
    expect(() => adInputMinor("0.851", "USD")).toThrow();
    expect(() => adInputMinor("1e10", "USD")).toThrow();
    expect(() => adInputMinor("9007199254740992", "JPY")).toThrow();
    expect(adMajor(Number.MAX_SAFE_INTEGER, "USD", adCurrencyBasis("USD"))).toBe("90071992547409.91");
    expect(adMoney(Number.MAX_SAFE_INTEGER - 1, "USD", adCurrencyBasis("USD"))).toBe("USD 90071992547409.90");
    expect(adMoney(-1, "USD", adCurrencyBasis("USD"))).toBe("USD -0.01");
    expect(adMoney(12, "JPY", adCurrencyBasis("JPY"))).toBe("JPY 12");
  });
  it("measurement money: preserves an unpinned historical integer and never guesses editable major units", () => {
    expect(adMoney(123, "USD")).toBe("USD 123 保存的最小单位（原精度未保存）");
    expect(adMajor(123, "USD")).toBe("");
    expect(adMoney(null, "USD")).toBe("待补充");
  });
  it("measurement money: respects three-digit money and refuses unknown precision or a mismatched pinned currency", () => {
    expect(adInputMinor("1.234", "KWD")).toBe(1234);
    expect(adMajor(1234, "KWD", adCurrencyBasis("KWD"))).toBe("1.234");
    expect(adMoney(1234, "KWD", adCurrencyBasis("KWD"))).toBe("KWD 1.234");
    expect(() => adInputMinor("1.2341", "KWD")).toThrow();
    expect(() => adInputMinor("1.00", "ZZZ")).toThrow();
    expect(() => adMoney(123, "JPY", adCurrencyBasis("USD"))).toThrow();
  });
  it("uses source-qualified natural ranks and the latest correction per day, never share ranks", () => {
    const record = {
      kind: "organic_rank",
      keyword: "CUSTOM pillow",
      organicRank: 30,
      periodStart: "2026-09-01",
      observedAt: "2026-09-01T10:00:00.000Z",
      createdAt: "2026-09-01T10:00:00.000Z",
      source: "manual natural rank",
    };
    const product = {
      goal: {
        fields: { coreKeywords: ["custom pillow", "missing term"], effectiveFrom: "2026-09-01" },
      },
      observations: [
        record,
        {
          ...record,
          organicRank: 20,
          periodStart: "2026-09-02",
          observedAt: "2026-09-02T10:00:00.000Z",
        },
        {
          ...record,
          organicRank: 15,
          periodStart: "2026-09-02",
          observedAt: "2026-09-02T12:00:00.000Z",
        },
        { ...record, kind: "commerce", organicRank: null },
      ] as AdObservation[],
    } as AdProductSummary;
    const rows = adRankProgress(product);
    expect(rows[0]).toMatchObject({
      baseline: 30,
      latest: 15,
      change: -15,
      source: "manual natural rank",
    });
    expect(rows[1]?.latest).toBeNull();
  });
});
