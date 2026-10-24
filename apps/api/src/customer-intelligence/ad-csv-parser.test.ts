import { describe, expect, it } from "vitest";
import { adMinor, adTextId, parseAdCsv, readAdCsv } from "./ad-csv-parser.js";

const options = { marketplaceByCurrency: { USD: "US", CAD: "CA" } as const, dateOrder: null };
const header =
  "日期范围,广告主账户 ID,广告产品,广告活动编号,广告活动名称,预算货币,展示量,点击量,总成本,购买量,销售额";
const campaign = `${header}\n2026年9月6日 - 2026年10月5日,001,Sponsored Products,000123,产品广告,USD,1000,40,12.40,2,64.90`;

describe("Amazon advertising report adapters", () => {
  it("handles quoted delimiters, escaped quotes, BOM and multiline cells without evaluating formulas", () => {
    expect(readAdCsv('\uFEFFa,b\r\n"comma,quote""\nnext","=""000123"""\r\n')).toEqual([
      ["a", "b"],
      ['comma,quote"\nnext', '="000123"'],
    ]);
    expect(adTextId('="000123"')).toBe("000123");
    expect(adTextId('=HYPERLINK("https://example.test")')).toBe(
      '=HYPERLINK("https://example.test")',
    );
    expect(readAdCsv("a;b\r\n1;2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
  it("detects ad products from data even when every file is named SP", () => {
    const csv = `${campaign}\n2026年9月6日 - 2026年10月5日,001,Sponsored Brands,000124,品牌广告,USD,100,4,2.50,1,24.95\n2026年9月6日 - 2026年10月5日,002,Sponsored Display,000125,加拿大广告,CAD,200,5,3.60,1,35.00`;
    const parsed = parseAdCsv("SP_Campaign.csv", csv, options);
    expect(parsed.facts.map((f) => f.adProduct)).toEqual(["SP", "SB", "SD"]);
    expect(parsed.facts.map((f) => f.marketplace)).toEqual(["US", "US", "CA"]);
    expect(parsed.facts[0]?.campaignId).toBe("000123");
    expect(parsed.facts[0]?.metrics.spendMinor).toBe(1240);
    expect(parsed.facts[0]?.grain).toBe("interval");
  });
  it("preserves view-attributed purchases and does not coerce absent sales to zero", () => {
    const parsed = parseAdCsv(
      "SP_Placement.csv",
      "日期范围,广告位名称,广告活动编号,预算货币,展示量,点击量,购买量,总成本,销售额\n2026年10月5日 - 2026年10月5日,商品页面,001,USD,50,0,2,0,",
      options,
    );
    expect(parsed.acceptedRowCount).toBe(1);
    expect(parsed.facts[0]?.metrics).toEqual({
      impressions: 50,
      clicks: 0,
      purchases: 2,
      spendMinor: 0,
      salesMinor: null,
    });
    expect(parsed.facts[0]?.qualityCodes).toContain("PURCHASE_ATTRIBUTION_CHECK");
  });
  it("does not call delivery measurement a competitive benchmark or share rank an organic rank", () => {
    const measurement = parseAdCsv(
      "SP_Industry_standard.csv",
      "日期范围,广告产品,Measurement source,Begin-to-render impressions,点击量\n2026年10月5日 - 2026年10月5日,Sponsored Products,Amazon,140,4",
      options,
    );
    expect(measurement.reportType).toBe("delivery_measurement");
    expect(measurement.facts[0]?.sourceFields["Begin-to-render impressions"]).toBe("140");
    expect(measurement.facts[0]?.metrics.impressions).toBeNull();
    const benchmark = parseAdCsv(
      "SP_Benchmark.csv",
      "日期,Benchmark brand ID,预算货币,CPM (p25),CPM (p50),CPM (p75)\n2026年10月5日,brand,USD,,,",
      options,
    );
    expect(benchmark.diagnostics.map((d) => d.code)).toContain("BENCHMARK_UNAVAILABLE");
    const share = parseAdCsv(
      "share.csv",
      "日期范围,预算货币,搜索词,展示量份额排名\n2026年10月5日 - 2026年10月5日,USD,custom pillow,3",
      options,
    );
    expect(share.reportType).toBe("search_term_share");
    expect(share.diagnostics.map((d) => d.code)).toContain("SHARE_RANK_NOT_ORGANIC");
    expect(share.facts[0]?.campaignId).toBeNull();
    const undated = parseAdCsv(
      "share.csv",
      "日期范围,预算货币,搜索词,展示量份额排名\n,,custom pillow,3",
      options,
    );
    expect(undated.facts[0]).toMatchObject({
      grain: "undated",
      periodStart: null,
      periodEnd: null,
      currency: null,
    });
    expect(undated.acceptedRowCount).toBe(1);
  });
  it("quarantines malformed rows, ambiguous dates and conflicting versions inside a file", () => {
    expect(parseAdCsv("bad.csv", 'a,b\n"unclosed,1', options).diagnostics[0]?.code).toBe(
      "CSV_STRUCTURE_INVALID",
    );
    const duplicate = parseAdCsv("same.csv", `${campaign}\n${campaign.split("\n")[1]}`, options);
    expect(duplicate.acceptedRowCount).toBe(1);
    expect(duplicate.rejectedRowCount).toBe(1);
    const conflict = parseAdCsv(
      "conflict.csv",
      `${campaign}\n${campaign.split("\n")[1]!.replace("12.40", "13.40")}`,
      options,
    );
    expect(conflict.acceptedRowCount).toBe(0);
    expect(conflict.rejectedRowCount).toBe(2);
    const dateCsv = campaign.replace("2026年9月6日 - 2026年10月5日", "09/06/2026 - 10/05/2026");
    expect(parseAdCsv("date.csv", dateCsv, options).rejectedRowCount).toBe(1);
    expect(
      parseAdCsv("date.csv", dateCsv, { ...options, dateOrder: "MDY" }).facts[0]?.periodStart,
    ).toBe("2026-09-06");
    expect(
      parseAdCsv("bad-day.csv", campaign.replace("2026年9月6日", "2026年2月30日"), options)
        .rejectedRowCount,
    ).toBe(1);
  });
  it("keeps money exact and prevents unsafe integer conversion and missing currencies", () => {
    expect(adMinor("$1,234.56", "USD")).toBe(123456);
    expect(adMinor("12", "JPY")).toBe(12);
    expect(adMinor("0.1", "USD")).toBe(10);
    expect(() => adMinor("0.001", "USD")).toThrow("精度");
    expect(() => adMinor("9007199254740992", "USD")).toThrow("安全整数");
    expect(() => adMinor("-1", "USD")).toThrow();
    expect(
      parseAdCsv("currency.csv", campaign.replace(",USD,", ",,"), options).rejectedRowCount,
    ).toBe(1);
    const noDate = campaign.replace("日期范围,", "任意列,");
    expect(parseAdCsv("date.csv", noDate, options).diagnostics[0]?.code).toBe(
      "REPORT_DATES_MISSING",
    );
  });
  it("supports legacy English daily exports and explicit marketplace identity", () => {
    const csv =
      "Date,Campaign ID,Campaign Name,Advertised ASIN,Marketplace,Currency,Impressions,Clicks,Spend,7 Day Total Orders (#),7 Day Total Sales ($)\n2026-10-05,123,Test,B012345678,AMAZON_CA,CAD,100,10,3.5,1,35";
    const parsed = parseAdCsv("arbitrary.csv", csv, options);
    expect(parsed.reportType).toBe("advertised_product");
    expect(parsed.facts[0]).toMatchObject({
      asin: "B012345678",
      marketplace: "CA",
      grain: "daily",
      metrics: { spendMinor: 350, salesMinor: 3500, purchases: 1 },
    });
  });
});
