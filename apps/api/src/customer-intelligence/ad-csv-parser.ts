import { createHash } from "node:crypto";
import {
  AdMarketplaceSchema,
  AdParsedFileSchema,
  adCurrencyBasis,
  adCurrencyPrecision,
  parseAdMinorAmount,
  normalizeAdTerm,
  type AdDiagnostic,
  type AdFact,
  type AdImportInput,
  type AdMarketplace,
  type AdParsedFile,
  type AdProduct,
  type AdReportType,
  type AdConversionDefinition,
  type AdConversionBasis,
  type AdMetricColumnSelection,
  type AdMetricColumns,
  type AdMetricCandidates,
  type AdFileMeasurement,
} from "@yummyai/contracts/advertising";

type Options = Pick<AdImportInput, "marketplaceByCurrency" | "dateOrder"> & {
  reportTypeHint?: AdReportType | null;
  adProductHint?: AdProduct | null;
  metricColumns?: AdMetricColumnSelection;
  conversionDefinition?: AdConversionDefinition;
  attributionWindowDays?: number | null;
  attributionBasis?: AdImportInput["attributionBasis"];
};
const aliases = {
  date: ["日期", "Date"],
  range: ["日期范围", "Date range", "Reporting period"],
  start: ["开始日期", "Start Date", "Period Start"],
  end: ["结束日期", "End Date", "Period End"],
  currency: ["预算货币", "Currency", "Budget currency", "Currency code"],
  advertiser: ["广告主账户 ID", "Advertiser account ID", "Advertiser ID"],
  adProduct: ["广告产品", "Ad product", "Advertising product", "Campaign type"],
  campaign: ["广告活动编号", "Campaign ID", "Campaign identifier"],
  campaignName: ["广告活动名称", "Campaign Name"],
  adGroup: ["广告组编号", "Ad Group ID"],
  adGroupName: ["广告组名称", "Ad Group Name"],
  advertisedAsin: ["推广的商品编号", "Advertised ASIN", "Advertised product ID"],
  convertedAsin: ["达成转化的商品的编号", "Purchased ASIN", "Converted product ID"],
  productName: [
    "推广的商品名称",
    "达成转化的商品的名称",
    "Advertised product name",
    "Converted product name",
  ],
  marketplace: [
    "推广的商品站点-Advertised product marketplace",
    "转化的商品市场",
    "投放广告活动的国家/地区",
    "受众细分群国家/地区代码",
    "Benchmark browse category marketplace",
    "Marketplace",
    "Marketplace code",
    "Country",
  ],
  term: ["搜索词", "Customer Search Term", "Search term", "Search query"],
  target: ["投放方案", "Targeting", "Keyword", "Keyword Text"],
  targetId: ["投放方案编号", "Targeting ID", "Target ID", "Keyword ID"],
  match: ["投放匹配类型-Targeting match type", "Match Type", "Targeting match type"],
  bid: ["目标竞价", "Target bid", "Bid", "Keyword Bid"],
  status: ["投放状态", "Targeting status", "Status"],
  placement: ["广告位名称", "Placement", "Placement name"],
  impressions: ["展示量", "Impressions"],
  clicks: ["点击量", "Clicks"],
  purchases: [
    "购买量",
    "Purchases",
    "Orders",
    "7 Day Total Orders (#)",
    "14 Day Total Orders (#)",
    "7 day total orders",
    "14 day total orders",
    "Purchases from clicks",
    "Purchases (all views)",
    "14 day total orders (#) - (Click)",
  ],
  spend: ["总成本", "Spend", "Cost", "Total cost"],
  sales: [
    "销售额",
    "Sales",
    "7 Day Total Sales ($)",
    "14 Day Total Sales ($)",
    "7 day total sales",
    "14 day total sales",
    "Sales from clicks",
    "Sales (all views)",
    "14 day total sales - (Click)",
  ],
} satisfies Record<string, string[]>;

function headerKey(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_()[\]$%#.-]/g, "");
}
export function adHash(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableAdJson(value))
    .digest("hex");
}
export function stableAdJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableAdJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableAdJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function adTextId(value: string): string {
  const text = value.trim();
  return /^="[^"\r\n]*"$/.test(text) ? text.slice(2, -1) : text;
}
export class AdCsvStructureError extends Error {}

/** RFC-style quoted cells, including doubled quotes and embedded line breaks.
 * Formulas are inert strings; this reader never evaluates a cell. */
export function readAdCsv(content: string): string[][] {
  const input = content.replace(/^\uFEFF/, "");
  if (input.includes("\u0000")) throw new AdCsvStructureError("CSV 含无效的空字符");
  const first = input.split(/\r?\n/, 1)[0] ?? "";
  let delimiter = ",",
    best = 0;
  for (const candidate of [",", "\t", ";"]) {
    let quotes = false,
      count = 0;
    for (let i = 0; i < first.length; i++) {
      if (first[i] === '"') {
        if (quotes && first[i + 1] === '"') i++;
        else quotes = !quotes;
      } else if (!quotes && first[i] === candidate) count++;
    }
    if (count > best) {
      best = count;
      delimiter = candidate;
    }
  }
  const records: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  function finishCell() {
    row.push(cell);
    cell = "";
    closed = false;
  }
  function finishRow() {
    finishCell();
    if (row.some((v) => v.trim())) records.push(row);
    row = [];
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += ch;
    } else if (ch === delimiter) finishCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      finishRow();
    } else if (ch === '"') {
      if (cell || closed) throw new AdCsvStructureError("CSV 引号必须出现在字段开头");
      quoted = true;
    } else {
      if (closed && ch.trim()) throw new AdCsvStructureError("CSV 引号结束后出现多余内容");
      if (!closed) cell += ch;
    }
    if (records.length > 50001 || cell.length > 4000)
      throw new AdCsvStructureError("报告超过 50000 行或单元格长度上限");
  }
  if (quoted) throw new AdCsvStructureError("CSV 引号未闭合，请重新导出文件");
  if (row.length || cell) finishRow();
  return records;
}

export function detectAdReportType(headers: string[]): AdReportType | null {
  const keys = new Set(headers.map(headerKey));
  const has = (...values: string[]) => values.some((v) => keys.has(headerKey(v)));
  if (has("Measurement source", "Begin-to-render impressions", "Measurable impressions (rendered)"))
    return "delivery_measurement";
  if (has("Benchmark browse category ID", "Benchmark brand ID", "CPM (p50)")) return "benchmark";
  if (has("细分受众群 ID", "Audience segment ID", "Audience ID")) return "audience";
  if (has("展示量份额排名", "Search term impression rank", "Search term impression share"))
    return "search_term_share";
  if (has("搜索结果首页首位展示量份额", "Top-of-search impression share"))
    return "top_of_search_share";
  // Specific report grains keep their identity when broader context columns
  // (advertised ASIN or targeting) also appear in the same original report.
  if (has(...aliases.convertedAsin)) return "converted_product";
  if (has(...aliases.term)) return "search_term";
  if (has(...aliases.target, ...aliases.targetId)) return "targeting";
  if (has(...aliases.placement)) return "placement";
  if (has(...aliases.advertisedAsin)) return "advertised_product";
  if (
    has(...aliases.campaign, ...aliases.campaignName) &&
    has(...aliases.spend, ...aliases.impressions)
  )
    return "campaign";
  return null;
}
function text(value: string | undefined): string | null {
  const v = value?.trim() ?? "";
  return !v || /^(?:n\/?a|null|none|--?|—)$/i.test(v) ? null : v;
}
function decimal(value: string): string {
  const v = value.trim();
  if (!/^(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)$/.test(v))
    throw new Error("数值格式无效；请保留原始小数点和千位格式");
  return v.replaceAll(",", "");
}
function safeNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("数值超过安全整数上限");
  return Number(value);
}
export function adMinor(value: string | null, currency: string): number | null {
  try { return parseAdMinorAmount(value, currency); }
  catch (error) {
    if (error instanceof RangeError && error.message.includes("固定币种最小单位"))
      throw new RangeError("金额精度超过货币最小单位，请先核对报告精度");
    throw error;
  }
}
function count(value: string | null): number | null {
  if (value === null) return null;
  const v = decimal(value);
  if (!/^\d+(?:\.0+)?$/.test(v)) throw new Error("展示、点击和购买量必须为非负整数");
  return safeNumber(BigInt(v.split(".")[0]!));
}
function isoDay(year: number, month: number, day: number): string {
  const result = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = new Date(`${result}T00:00:00Z`);
  if (
    year < 2000 ||
    year > 2200 ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== result
  )
    throw new Error("报告日期无效");
  return result;
}
function day(value: string, order: Options["dateOrder"]): string {
  const v = value.trim(),
    ymd = /^(\d{4})(?:年|[-/.])(\d{1,2})(?:月|[-/.])(\d{1,2})日?$/.exec(v);
  if (ymd) return isoDay(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const local = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/.exec(v);
  if (local) {
    const a = Number(local[1]),
      b = Number(local[2]);
    const chosen = order ?? (a > 12 ? "DMY" : b > 12 ? "MDY" : a === b ? "MDY" : null);
    if (!chosen) throw new Error("日期格式有歧义，请指定 月/日/年 或 日/月/年");
    return isoDay(Number(local[3]), chosen === "MDY" ? a : b, chosen === "MDY" ? b : a);
  }
  const named =
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/i.exec(v);
  if (named)
    return isoDay(
      Number(named[3]),
      ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
        named[1]!.toLowerCase(),
      ) + 1,
      Number(named[2]),
    );
  throw new Error("无法识别报告日期，请检查日期列或日期范围");
}
export function adProduct(value: string | null): AdProduct | null {
  const v = (value ?? "").replace(/[\s_-]/g, "").toLowerCase();
  if (["sp", "sponsoredproducts", "商品推广"].includes(v)) return "SP";
  if (["sb", "sponsoredbrands", "品牌推广"].includes(v)) return "SB";
  if (["sd", "sponsoreddisplay", "展示型推广"].includes(v)) return "SD";
  return null;
}
export function adMarketplace(value: string | null): AdMarketplace | null {
  if (!value) return null;
  const v = value
    .toUpperCase()
    .replace(/^HTTPS?:\/\//, "")
    .replace(/^WWW\./, "");
  const valid = AdMarketplaceSchema.safeParse(v);
  if (valid.success) return valid.data;
  const names: Record<string, AdMarketplace> = {
    "AMAZON.COM": "US",
    AMAZON_US: "US",
    "AMAZON.CA": "CA",
    AMAZON_CA: "CA",
    "AMAZON.COM.MX": "MX",
    AMAZON_MX: "MX",
    "AMAZON.COM.BR": "BR",
    AMAZON_BR: "BR",
    "AMAZON.CO.UK": "UK",
    AMAZON_UK: "UK",
    GB: "UK",
    "AMAZON.DE": "DE",
    AMAZON_DE: "DE",
    "AMAZON.FR": "FR",
    AMAZON_FR: "FR",
    "AMAZON.IT": "IT",
    AMAZON_IT: "IT",
    "AMAZON.ES": "ES",
    AMAZON_ES: "ES",
    "AMAZON.CO.JP": "JP",
    AMAZON_JP: "JP",
    "AMAZON.COM.AU": "AU",
    AMAZON_AU: "AU",
    "AMAZON.IN": "IN",
    AMAZON_IN: "IN",
    ATVPDKIKX0DER: "US",
    A2EUQ1WTGCTBG2: "CA",
    A1AM78C64UM0Y8: "MX",
    A1F83G8C2ARO7P: "UK",
    A1PA6795UKMFR9: "DE",
  };
  return names[v] ?? null;
}

const metricFields = ["impressions", "clicks", "purchases", "spendMinor", "salesMinor", "bidMinor"] as const;
const metricAlias = { impressions: "impressions", clicks: "clicks", purchases: "purchases",
  spendMinor: "spend", salesMinor: "sales", bidMinor: "bid" } as const;
function headerWindow(header: string | null) {
  const match = header?.normalize("NFKC").match(/\b([1-9][0-9]?)[\s_-]*(?:day|天)/i);
  return match ? Number(match[1]) : null;
}
function columnModel(header: string | null): "click" | "all_views" | null {
  const key = header ? headerKey(header) : "";
  if (key.includes("allviews")) return "all_views";
  if (key.includes("fromclicks") || key.endsWith("click")) return "click";
  return null;
}
function resolveMetricColumns(headers: string[], options: Options) {
  const columns: AdMetricColumns = { impressions: null, clicks: null, purchases: null,
    spendMinor: null, salesMinor: null, bidMinor: null };
  const candidates: AdMetricCandidates = { impressions: [], clicks: [], purchases: [], spendMinor: [], salesMinor: [], bidMinor: [] };
  const diagnostics: AdDiagnostic[] = [];
  const diagnose = (code: string, severity: AdDiagnostic["severity"], message: string, column: string | null = null) =>
    diagnostics.push({ code, severity, message, row: null, column });
  let invalidSelection = false, conversionAmbiguous = false;
  for (const field of metricFields) {
    const names = new Set(aliases[metricAlias[field]].map(headerKey));
    candidates[field] = headers.filter(header => names.has(headerKey(header)));
    const selected = options.metricColumns?.[field];
    if (selected !== undefined) {
      if (selected !== null && !candidates[field].includes(selected)) {
        invalidSelection = true;
        diagnose("METRIC_COLUMN_SELECTION_INVALID", "error", "选择的列不存在或不属于该指标，请使用预览中的实际候选列", selected);
      } else columns[field] = selected;
    } else if (candidates[field].length === 1) columns[field] = candidates[field][0]!;
    else if (candidates[field].length > 1) {
      if (field === "purchases" || field === "salesMinor") conversionAmbiguous = true;
      diagnose("METRIC_COLUMN_AMBIGUOUS", "warning", "同一指标存在多列，未自动选取，请明确选择原报告列", candidates[field][0]!);
    }
  }
  const used = Object.values(columns).filter((column): column is string => column !== null);
  if (new Set(used).size !== used.length) {
    invalidSelection = true;
    diagnose("METRIC_COLUMN_SELECTION_INVALID", "error", "不同指标不能复用同一个原报告列");
  }
  const windows = [headerWindow(columns.purchases), headerWindow(columns.salesMinor)].filter((value): value is number => value !== null);
  const declared = options.attributionWindowDays ?? null;
  let conflict = invalidSelection;
  if (new Set(windows).size > 1 || declared !== null && windows.some(window => window !== declared)) {
    conflict = true;
    diagnose("CONVERSION_WINDOW_CONFLICT", "error", "购买量、销售额列及声明的归因窗口不一致，不能混用7天与14天指标");
  }
  const definition = options.conversionDefinition, model = definition?.model ?? "unknown";
  const source = definition && definition.source.trim().length >= 3 ? definition.source.trim() : null;
  const kinds = [columnModel(columns.purchases), columnModel(columns.salesMinor)].filter(Boolean);
  if (new Set(kinds).size > 1 || model !== "unknown" && (
    model === "click" && kinds.includes("all_views") || model !== "click" && kinds.includes("click")
    || model !== "all_views_14d" && kinds.includes("all_views")
  ) || model !== "unknown" && options.attributionBasis !== undefined && options.attributionBasis !== "unknown" && (
    model === "click" ? options.attributionBasis !== "click" : options.attributionBasis !== "click_and_view"
  )) {
    conflict = true;
    diagnose("CONVERSION_MODEL_CONFLICT", "error", "所选转化列、明确核对的模型及声明基础不一致，不能把点击和全部浏览归因互换");
  }
  let windowDays = declared ?? (new Set(windows).size === 1 ? windows[0]! : null);
  if (model === "all_views_14d") {
    if (declared !== null && declared !== 14 || windows.some(window => window !== 14)) {
      conflict = true;
      diagnose("CONVERSION_WINDOW_CONFLICT", "error", "全部浏览指标固定14天窗口，不能使用其他窗口的列或声明");
    }
    windowDays = 14;
  }
  const conversion: AdConversionBasis = {
    state: conflict ? "conflict" : model !== "unknown" && source !== null && windowDays !== null
      && !conversionAmbiguous && (columns.purchases !== null || columns.salesMinor !== null) ? "resolved" : "unresolved",
    model, windowDays, source,
  };
  if (conversion.state === "unresolved")
    diagnose("CONVERSION_DEFINITION_UNRESOLVED", "warning", "原报告数值继续保留；请核对转化列、模型、窗口及定义来源后再作转化决策");
  return { columns, candidates, conversion, diagnostics, invalidSelection };
}

export function parseAdCsv(fileName: string, content: string, options: Options): AdParsedFile {
  const checksum = adHash(content),
    byteSize = Buffer.byteLength(content, "utf8"),
    diagnostics: AdDiagnostic[] = [];
  let diagnosticCount = 0;
  const currencies = new Map<string, ReturnType<typeof adCurrencyPrecision>>();
  const unknownCurrencies = new Set<string>();
  function diagnose(
    code: string,
    severity: AdDiagnostic["severity"],
    message: string,
    row: number | null = null,
    column: string | null = null,
  ) {
    diagnosticCount++;
    if (diagnostics.length < 250) diagnostics.push({ code, severity, message, row, column });
  }
  function result(
    headers: string[],
    reportType: AdReportType | null,
    sourceRowCount: number,
    facts: AdFact[],
    rejectedRowCount: number,
    selectedMetrics?: ReturnType<typeof resolveMetricColumns>,
  ) {
    const measurement: AdFileMeasurement | undefined = selectedMetrics ? {
      schemaVersion: 1, adapterVersion: "amazon_csv_measurement_v1",
      columns: selectedMetrics.columns, conversion: selectedMetrics.conversion,
      currencies: [...currencies.values()].sort((a, b) => a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0),
    } : undefined;
    return AdParsedFileSchema.parse({
      fileName,
      checksum,
      byteSize,
      headers,
      reportType,
      sourceRowCount,
      acceptedRowCount: facts.length,
      rejectedRowCount,
      diagnosticCount,
      diagnostics,
      facts,
      ...(measurement ? { measurement, metricCandidates: selectedMetrics!.candidates } : {}),
    });
  }
  if (byteSize > 5 * 1024 * 1024) {
    diagnose("FILE_TOO_LARGE", "error", "单个报告最大 5 MiB");
    return result([], null, 0, [], 0);
  }
  let table: string[][];
  try {
    table = readAdCsv(content);
  } catch (error) {
    diagnose(
      "CSV_STRUCTURE_INVALID",
      "error",
      error instanceof Error ? error.message : "CSV 格式无效",
    );
    return result([], null, 0, [], 0);
  }
  const headers = (table.shift() ?? []).map((h) => h.trim());
  if (
    !headers.length ||
    headers.length > 200 ||
    headers.some((h) => !h || h.length > 200) ||
    new Set(headers.map(headerKey)).size !== headers.length
  ) {
    diagnose("CSV_HEADERS_INVALID", "error", "报告表头为空、重复或超过上限");
    return result([], null, table.length, [], table.length);
  }
  const detected = detectAdReportType(headers),
    reportType = detected ?? options.reportTypeHint ?? null;
  if (!reportType || (detected && options.reportTypeHint && detected !== options.reportTypeHint)) {
    diagnose(
      "REPORT_TYPE_UNRESOLVED",
      "error",
      detected ? "手动选择的报表类型与表头不一致" : "无法识别报表类型，请在预览中明确选择",
    );
    return result(headers, reportType, table.length, [], table.length);
  }
  const headerMap = new Map(headers.map((h) => [headerKey(h), h]));
  const col = (field: keyof typeof aliases) =>
    aliases[field].map((v) => headerMap.get(headerKey(v))).find(Boolean);
  if (!col("date") && !col("range") && !(col("start") && col("end"))) {
    diagnose("REPORT_DATES_MISSING", "error", "缺少日期或日期范围，不能把上传日期当作统计日期");
    return result(headers, reportType, table.length, [], table.length);
  }
  const selectedMetrics = resolveMetricColumns(headers, options);
  for (const entry of selectedMetrics.diagnostics)
    diagnose(entry.code, entry.severity, entry.message, entry.row, entry.column);
  if (selectedMetrics.invalidSelection) return result(headers, reportType, table.length, [], table.length, selectedMetrics);
  if (
    reportType === "benchmark" &&
    headers
      .filter((h) => /\(p(?:25|50|75)\)/i.test(h))
      .every((h) => table.every((r) => !text(r[headers.indexOf(h)])))
  )
    diagnose("BENCHMARK_UNAVAILABLE", "warning", "同行分位值为空，暂不能进行同行比较");
  if (reportType === "delivery_measurement")
    diagnose(
      "DELIVERY_NOT_BENCHMARK",
      "info",
      "行业标准报告用于广告投放与可见性测量，不是类目业绩基准",
    );
  if (reportType === "search_term_share")
    diagnose(
      "SHARE_RANK_NOT_ORGANIC",
      "info",
      "展示量份额排名是广告份额排名，不是自然排名；该报告为账户搜索词维度",
    );
  const facts: AdFact[] = [],
    seen = new Map<string, string>(),
    conflicted = new Set<string>();
  let rejected = 0,
    intervals = 0,
    missingMarkets = 0,
    unknownProducts = 0;
  for (let index = 0; index < table.length; index++) {
    const cells = table[index]!,
      sourceRow = index + 2;
    if (cells.length !== headers.length) {
      rejected++;
      diagnose("ROW_WIDTH_INVALID", "error", "字段数量与表头不一致", sourceRow);
      continue;
    }
    const sourceFields = Object.fromEntries(headers.map((h, i) => [h, cells[i]!]));
    const get = (field: keyof typeof aliases) => text(sourceFields[col(field) ?? ""]);
    const getMetric = (field: keyof AdMetricColumns) => text(sourceFields[selectedMetrics!.columns[field] ?? ""]);
    const id = (field: keyof typeof aliases) => {
      const v = get(field);
      return v === null ? null : adTextId(v);
    };
    try {
      let periodStart: string | null, periodEnd: string | null;
      if (get("date")) periodStart = periodEnd = day(get("date")!, options.dateOrder);
      else if (get("range")) {
        const parts = get("range")!.split(/\s+[-–—]\s+|\s*(?:至|\bto\b)\s*/i);
        if (parts.length !== 2) throw new Error("日期范围需要明确的开始和结束日期");
        periodStart = day(parts[0]!, options.dateOrder);
        periodEnd = day(parts[1]!, options.dateOrder);
      } else if (get("start") && get("end")) {
        periodStart = day(get("start")!, options.dateOrder);
        periodEnd = day(get("end")!, options.dateOrder);
      } else {
        periodStart = periodEnd = null;
        diagnose(
          "PERIOD_UNRESOLVED",
          "warning",
          "该行未提供统计日期，作为待确认来源保留，不参与时间分析",
          sourceRow,
        );
      }
      if (periodStart && periodEnd && periodEnd < periodStart)
        throw new Error("结束日期早于开始日期");
      const currency = get("currency")?.toUpperCase() ?? null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error("无法识别预算货币代码");
      if (!currency && (getMetric("spendMinor") !== null || getMetric("salesMinor") !== null || getMetric("bidMinor") !== null))
        throw new Error("金额或竞价缺少货币，不能猜测币种");
      if (currency && !currencies.has(currency)) {
        if (currencies.size >= 2000) throw new Error("报告币种种类超过上限，请按实际币种拆分报告");
        currencies.set(currency, adCurrencyPrecision(currency));
      }
      const monetaryBasis = currency ? adCurrencyBasis(currency) : null;
      const explicitMarket = adMarketplace(get("marketplace")),
        marketplace =
          explicitMarket ?? (currency ? (options.marketplaceByCurrency[currency] ?? null) : null);
      if (get("marketplace") && !explicitMarket)
        diagnose(
          "MARKETPLACE_UNRECOGNIZED",
          "warning",
          "报表中的站点未识别，使用已声明的币种映射或保留待确认",
          sourceRow,
          col("marketplace") ?? null,
        );
      const campaignId = id("campaign"),
        adGroupId = id("adGroup"),
        targetId = id("targetId"),
        advertiserId = id("advertiser");
      const rawAsin =
        get(
          reportType === "converted_product" ? "convertedAsin" : "advertisedAsin",
        )?.toUpperCase() ?? null;
      const asin = rawAsin && /^[A-Z0-9]{10}$/.test(rawAsin) ? rawAsin : null;
      const qualityCodes: string[] = [];
      if (!periodStart || !periodEnd) qualityCodes.push("PERIOD_UNRESOLVED");
      if (selectedMetrics.conversion.state !== "resolved")
        qualityCodes.push(selectedMetrics.conversion.state === "conflict" ? "CONVERSION_MEASUREMENT_CONFLICT" : "CONVERSION_DEFINITION_UNRESOLVED");
      if (currency && !monetaryBasis) {
        qualityCodes.push("CURRENCY_PRECISION_UNKNOWN");
        if (!unknownCurrencies.has(currency)) {
          unknownCurrencies.add(currency);
          diagnose("CURRENCY_PRECISION_UNKNOWN", "warning", `${currency} 的固定币种精度未知，金额未按默认两位转换；原单元格继续保留`, sourceRow, col("currency") ?? null);
        }
      }
      if (rawAsin && !asin) {
        qualityCodes.push("PRODUCT_ID_NOT_ASIN");
        diagnose(
          "PRODUCT_ID_NOT_ASIN",
          "warning",
          "商品编号不是有效 ASIN，保留来源并等待产品映射",
          sourceRow,
        );
      }
      const product = adProduct(get("adProduct")) ?? options.adProductHint ?? null;
      const metrics = {
        impressions: count(getMetric("impressions")),
        clicks: count(getMetric("clicks")),
        purchases: count(getMetric("purchases")),
        spendMinor: currency && monetaryBasis ? adMinor(getMetric("spendMinor"), currency) : null,
        salesMinor: currency && monetaryBasis ? adMinor(getMetric("salesMinor"), currency) : null,
      };
      if (
        metrics.clicks !== null &&
        metrics.impressions !== null &&
        metrics.clicks > metrics.impressions
      )
        qualityCodes.push("CLICK_IMPRESSION_CHECK");
      if (
        metrics.purchases !== null &&
        metrics.clicks !== null &&
        metrics.purchases > metrics.clicks
      )
        qualityCodes.push("PURCHASE_ATTRIBUTION_CHECK");
      if (!marketplace) {
        missingMarkets++;
        qualityCodes.push("MARKETPLACE_UNRESOLVED");
      }
      if (
        !product &&
        !["benchmark", "converted_product", "audience", "advertised_product"].includes(reportType)
      )
        unknownProducts++;
      const term = get(reportType === "targeting" ? "target" : "term"),
        placement = get("placement"),
        matchType = get("match");
      const dimensions: Record<string, string> = {};
      for (const h of headers)
        if (
          /广告组合编号|portfolio.?id|父级编号|parent.?id|商品 SKU|advertised.?sku|广告位分类|placement.?class|网站或应用程序|website|app.?name|placement.?size|细分受众群|audience|benchmark (?:brand|browse)|measurement source|^环境$|^environment$|设备类型|device.?type|delivery.?format|initiation.?type|广告插播位置|视频广告位类型|交易编号|交易类型|^deal/i.test(
            h,
          )
        )
          if (text(sourceFields[h])) dimensions[h] = sourceFields[h]!.trim();
      const identity = {
        reportType,
        advertiserId,
        currency,
        marketplace,
        adProduct: campaignId ? null : product,
        campaignId,
        campaignNameFallback: campaignId ? null : get("campaignName"),
        adGroupId,
        adGroupNameFallback: adGroupId ? null : get("adGroupName"),
        targetId,
        asin,
        term: term === null ? null : normalizeAdTerm(term),
        matchType,
        placement,
        dimensions,
      };
      const entityKey = adHash(identity),
        rowKey = adHash({ entityKey, periodStart, periodEnd });
      const sourceHash = adHash(sourceFields);
      if (conflicted.has(rowKey)) {
        rejected++;
        diagnose(
          "CONFLICTING_ROWS",
          "error",
          "该事实区间已有冲突值，全部保留在原始来源中等待核对",
          sourceRow,
        );
        continue;
      }
      if (seen.has(rowKey)) {
        rejected++;
        diagnose(
          seen.get(rowKey) === sourceHash ? "DUPLICATE_ROW" : "CONFLICTING_ROWS",
          seen.get(rowKey) === sourceHash ? "warning" : "error",
          seen.get(rowKey) === sourceHash
            ? "同一事实重复出现，已保留一次"
            : "同一事实区间出现冲突值，需要核对原始报告",
          sourceRow,
        );
        if (seen.get(rowKey) !== sourceHash) {
          const earlier = facts.findIndex((f) => f.rowKey === rowKey);
          if (earlier >= 0) {
            facts.splice(earlier, 1);
            rejected++;
          }
          conflicted.add(rowKey);
        }
        continue;
      }
      seen.set(rowKey, sourceHash);
      const fact: AdFact = {
        sourceRow,
        rowKey,
        entityKey,
        reportType,
        adProduct: product,
        advertiserId,
        currency,
        marketplace,
        periodStart,
        periodEnd,
        grain: periodStart === null ? "undated" : periodStart === periodEnd ? "daily" : "interval",
        campaignId,
        campaignName: get("campaignName"),
        adGroupId,
        adGroupName: get("adGroupName"),
        asin,
        productName: get("productName"),
        term,
        targetId,
        matchType,
        bidMinor: currency && monetaryBasis ? adMinor(getMetric("bidMinor"), currency) : null,
        status: get("status"),
        placement,
        metrics,
        dimensions,
        sourceFields,
        qualityCodes,
        measurement: { schemaVersion: 1, adapterVersion: "amazon_csv_measurement_v1",
          columns: selectedMetrics.columns, conversion: selectedMetrics.conversion, monetaryBasis },
      };
      if (fact.grain === "interval") intervals++;
      facts.push(AdParsedFileSchema.shape.facts.element.parse(fact));
    } catch (error) {
      rejected++;
      diagnose(
        "ROW_VALUE_INVALID",
        "error",
        error instanceof Error && !error.message.startsWith("[")
          ? error.message.slice(0, 300)
          : "字段值不符合报表约束，请检查 ID、日期和指标",
        sourceRow,
      );
    }
  }
  if (intervals)
    diagnose("INTERVAL_SUMMARY", "info", `${intervals} 行为区间汇总，不会拆分成虚构的日趋势`);
  if (missingMarkets)
    diagnose(
      "MARKETPLACE_MAPPING_REQUIRED",
      "warning",
      `${missingMarkets} 行缺少可确认的站点；请补充币种与站点映射`,
    );
  if (unknownProducts)
    diagnose(
      "AD_PRODUCT_UNRESOLVED",
      "info",
      `${unknownProducts} 行未直接声明 SP/SB/SD，需要关联 Campaign 或手动确认`,
    );
  if (facts.some((f) => f.qualityCodes.includes("PURCHASE_ATTRIBUTION_CHECK")))
    diagnose(
      "PURCHASE_ATTRIBUTION_CHECK",
      "warning",
      "部分购买量大于点击量，保留归因证据并暂停这些行的点击转化率计算",
    );
  return result(headers, reportType, table.length, facts, rejected, selectedMetrics);
}
