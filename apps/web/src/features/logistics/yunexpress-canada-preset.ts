import type { LogisticsConnectionProfile } from "@yummyai/contracts/logistics";

/** A dated, editable starting point. Saving pins a version; it never changes old tasks. */
export function canadaPillowChannels(): LogisticsConnectionProfile["channels"] {
  return [
    { code: "THPHR", name: "云途全球专线挂号（特惠普货）", divisor: 8000, minimum: 0, minLength: 150, effective: "2026-11-02", cells: "B213/B425/B427" },
    { code: "ZBZXRPH", name: "云途中包专线挂号（特惠普货）", divisor: 12000, minimum: 100, minLength: 200, effective: "2026-10-29", cells: "B70/B72/B144/B165" },
  ].map(row => ({
    code: row.code, name: row.name, countryCodes: ["CA"],
    transitDaysMin: 9, transitDaysMax: 13,
    transitSource: "报价表加拿大 7–9 工作日 按普通周末保守换算 9–13 自然日 不含另行公告的节假日延误 仅作内部排期依据",
    conditionsVerified: true,
    conditionsEvidence: `云途整合渠道-2026-11-02.xlsx ${row.name} ${row.cells} 生效 ${row.effective} 加拿大最长边≤100cm 第二长边≤76cm 长+2(宽+高)≤250cm 重量≤30kg 规则长方体外包装 不适用异形外包装150元附加费 API返回含费用项目的总报价`,
    acceptsBattery: false, maxWeightGrams: 30000, maxDimensionMm: 1000,
    maxSecondDimensionMm: 760, maxLengthPlusGirthMm: 2500,
    minLongestDimensionMm: row.minLength, minSecondDimensionMm: 100,
    volumetricBilling: { divisorCm3PerKg: row.divisor, actualWeightThresholdMultiple: 2,
      minimumGrams: row.minimum, stepGrams: 1 },
  }));
}
