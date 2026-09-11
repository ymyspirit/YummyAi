import { OrderProtectedDetailsSchema, type OrderProtectedDetails } from "@yummyai/contracts";

export type ParsedAmazonReportLine = {
  externalLineId: string;
  skuCode: string | null;
  title: string;
  quantity: number;
  currency: string;
  /** Amazon's item-price is a line total, including when quantity is greater than one. */
  itemTotalMinor: number;
  shippingTotalMinor: number;
  taxTotalMinor: number;
  customizedUrl: string | null;
  customizedPage: string | null;
};

export type ParsedAmazonReportOrder = {
  externalOrderId: string;
  placedAt: string;
  lines: ParsedAmazonReportLine[];
  protectedDetails: OrderProtectedDetails;
};

const requiredHeaders = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "currency", "item-price"];
const supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));

function fail(row: number, reason: string): never {
  // Never include report values: exception messages can reach infrastructure logs.
  throw new Error(`订单报告第 ${row} 行：${reason}`);
}

/** A strict TSV reader that preserves tabs, line breaks, and quotes inside quoted cells. */
function readTsv(text: string): Array<{ cells: string[]; row: number }> {
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) throw new Error("订单报告超过 20 MiB 大小限制");
  const rows: Array<{ cells: string[]; row: number }> = [];
  const source = text.replace(/^\uFEFF/, "");
  let cells: string[] = [], cell = "", quoted = false, closedQuote = false;
  let physicalRow = 1, rowStart = 1;
  const endCell = () => { cells.push(cell); cell = ""; closedQuote = false; };
  const endRow = () => {
    endCell();
    if (cells.some((value) => value !== "")) rows.push({ cells, row: rowStart });
    cells = [];
    if (rows.length > 20_001) throw new Error("订单报告超过 20000 条订单行限制");
  };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else {
        if (char === "\r" && source[index + 1] === "\n") { cell += "\n"; index++; physicalRow++; }
        else { cell += char; if (char === "\n" || char === "\r") physicalRow++; }
      }
    } else if (char === "\t") endCell();
    else if (char === "\n" || char === "\r") {
      endRow();
      if (char === "\r" && source[index + 1] === "\n") index++;
      physicalRow++; rowStart = physicalRow;
    } else if (closedQuote) fail(rowStart, "引号结束后出现无效字符");
    else if (char === '"' && cell === "") quoted = true;
    else cell += char;
  }
  if (quoted) fail(rowStart, "字段引号未闭合");
  if (cell !== "" || cells.length || closedQuote) endRow();
  return rows;
}

function money(value: string, currency: string, row: number, optional = false): number {
  if (!value && optional) return 0;
  // Do not round, parse floats, accept thousands separators, or infer a currency.
  if (!/^\d+(?:\.\d+)?$/.test(value)) fail(row, "金额格式无效");
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(digits).replace(/0/g, "") !== "") fail(row, "金额精度超过币种允许的小数位");
  const amount = BigInt(whole) * (10n ** BigInt(digits)) + BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail(row, "金额超过可处理范围");
  return Number(amount);
}

function bounded(value: string, max: number, row: number, nullable = false): string {
  if ((!nullable && !value) || value.length > max || value.includes("\0")) fail(row, "字段为空、过长或包含无效字符");
  return value;
}

export function parseAmazonOrderReport(text: string): { orders: ParsedAmazonReportOrder[]; rowCount: number; warnings: string[] } {
  const records = readTsv(text);
  if (records.length < 2) throw new Error("订单报告没有可导入的订单行");
  const headers = records[0].cells.map((cell) => cell.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) throw new Error("订单报告包含重复或空白列名");
  if (requiredHeaders.some((header) => !headers.includes(header))) throw new Error("订单报告缺少必要列，请下载亚马逊订单报告原始 TXT 文件");
  const orders = new Map<string, ParsedAmazonReportOrder>();
  const seenLines = new Map<string, { orderId: string; signature: string }>();
  const warnings: string[] = [];
  for (const record of records.slice(1)) {
    const { row, cells } = record;
    if (cells.length !== headers.length) fail(row, "列数与表头不一致");
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index].trim()]));
    const get = (key: string) => values[key] ?? "";
    const externalOrderId = bounded(get("order-id"), 500, row);
    const externalLineId = bounded(get("order-item-id"), 300, row);
    const date = get("purchase-date");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(date) || Number.isNaN(Date.parse(date))) fail(row, "购买时间无效或缺少时区");
    const calendarDate = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date.slice(0, 10)) fail(row, "购买日期不存在");
    const placedAt = new Date(date).toISOString();
    const currency = get("currency").toUpperCase();
    if (!supportedCurrencies.has(currency)) fail(row, "币种无效或暂不支持");
    if (!/^[1-9]\d*$/.test(get("quantity-purchased"))) fail(row, "购买数量必须是正整数");
    const quantity = Number(get("quantity-purchased"));
    if (!Number.isSafeInteger(quantity) || quantity > 100_000) fail(row, "购买数量超过可处理范围");
    const line: ParsedAmazonReportLine = {
      externalLineId, skuCode: bounded(get("sku"), 200, row, true) || null,
      title: bounded(get("product-name"), 1_000, row), quantity, currency,
      itemTotalMinor: money(get("item-price"), currency, row),
      shippingTotalMinor: money(get("shipping-price"), currency, row, true),
      taxTotalMinor: money(get("item-tax"), currency, row, true) + money(get("shipping-tax"), currency, row, true),
      customizedUrl: bounded(get("customized-url"), 10_000, row, true) || null,
      customizedPage: bounded(get("customized-page"), 10_000, row, true) || null,
    };
    if (!Number.isSafeInteger(line.taxTotalMinor)) fail(row, "税额超过可处理范围");
    const email = get("buyer-email") || null;
    const country = get("ship-country").toUpperCase() || null;
    const details = OrderProtectedDetailsSchema.safeParse({
      buyer: { name: get("buyer-name") || null, email, phone: get("buyer-phone-number") || get("ship-phone-number") || null },
      shippingAddress: {
        recipient: get("recipient-name") || null,
        lines: [get("ship-address-1"), get("ship-address-2"), get("ship-address-3")].filter(Boolean),
        city: get("ship-city") || null, region: get("ship-state") || null, postalCode: get("ship-postal-code") || null,
        countryCode: country,
      },
      customizations: [],
    });
    if (!details.success) fail(row, "买家或配送信息格式无效");
    const signature = JSON.stringify({ placedAt, line, protectedDetails: details.data });
    const seen = seenLines.get(externalLineId);
    if (seen) {
      if (seen.orderId !== externalOrderId || seen.signature !== signature) fail(row, "同一订单行出现相互冲突的数据");
      warnings.push(`第 ${row} 行与本批已有订单行相同，已跳过`);
      continue;
    }
    seenLines.set(externalLineId, { orderId: externalOrderId, signature });
    let order = orders.get(externalOrderId);
    if (!order) {
      order = { externalOrderId, placedAt, lines: [], protectedDetails: details.data };
      orders.set(externalOrderId, order);
    } else if (order.placedAt !== placedAt || order.lines[0]?.currency !== currency || JSON.stringify(order.protectedDetails) !== JSON.stringify(details.data)) fail(row, "同一订单的时间、币种或配送信息不一致");
    order.lines.push(line);
    if (order.lines.length > 1_000) fail(row, "单个订单超过 1000 条订单行限制");
    if (["gift-wrap-price", "gift-wrap-tax", "item-promotion-discount", "ship-promotion-discount"].some((key) => get(key) && !/^0(?:\.0+)?$/.test(get(key)))) warnings.push(`第 ${row} 行包含礼品包装或促销金额，当前金额摘要未计入这些项目`);
  }
  return { orders: [...orders.values()], rowCount: records.length - 1, warnings };
}
