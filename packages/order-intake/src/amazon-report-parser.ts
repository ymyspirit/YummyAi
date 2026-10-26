import { OrderProtectedDetailsSchema, type OrderProtectedDetails } from "@yummyai/contracts";
import {
  AmazonReportImportErrorSchema, formatAmazonReportImportError, type AmazonReportImportError,
  type AmazonReportImportErrorCode, type AmazonReportRequiredHeader,
} from "@yummyai/contracts/order/report";

export type ParsedAmazonReportLine = {
  externalLineId: string;
  skuCode: string | null;
  title: string;
  quantity: number;
  currency: string | null;
  /** Amazon's item-price is a line total, including when quantity is greater than one. */
  itemTotalMinor: number | null;
  shippingTotalMinor: number | null;
  taxTotalMinor: number | null;
  customizedUrl: string | null;
  customizedPage: string | null;
  /** Only an unshipped report's complete, timezone-qualified promise-date. */
  platformShipByAt?: string | null;
};

export type ParsedAmazonReportOrder = {
  externalOrderId: string;
  placedAt: string;
  lines: ParsedAmazonReportLine[];
  protectedDetails: OrderProtectedDetails;
};

const requiredHeaders: AmazonReportRequiredHeader[] = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased"];
const unshippedHeaders = ["quantity-shipped", "quantity-to-ship", "promise-date"];
const monetaryHeaders = ["item-price", "shipping-price", "item-tax", "shipping-tax", "gift-wrap-price", "gift-wrap-tax", "item-promotion-discount", "ship-promotion-discount"];
const supportedCurrencies = new Set(Intl.supportedValuesOf("currency"));

export class AmazonReportParseError extends Error {
  readonly diagnostic: AmazonReportImportError;

  constructor(diagnostic: AmazonReportImportError) {
    const safe = AmazonReportImportErrorSchema.parse(diagnostic);
    super(formatAmazonReportImportError(safe));
    this.name = "AmazonReportParseError";
    this.diagnostic = safe;
  }
}

function fail(code: AmazonReportImportErrorCode, row?: number, missingHeaders?: AmazonReportRequiredHeader[]): never {
  // Never include report values: exception messages can reach infrastructure logs.
  throw new AmazonReportParseError({ code, ...(row === undefined ? {} : { row }), ...(missingHeaders ? { missingHeaders } : {}) });
}

/** A strict TSV reader that preserves tabs, line breaks, and quotes inside quoted cells. */
function readTsv(text: string): Array<{ cells: string[]; row: number }> {
  if (Buffer.byteLength(text, "utf8") > 20 * 1024 * 1024) fail("report_too_large");
  const rows: Array<{ cells: string[]; row: number }> = [];
  const source = text.replace(/^\uFEFF/, "");
  let cells: string[] = [], cell = "", quoted = false, closedQuote = false;
  let physicalRow = 1, rowStart = 1;
  const endCell = () => { cells.push(cell); cell = ""; closedQuote = false; };
  const endRow = () => {
    endCell();
    if (cells.some((value) => value !== "")) rows.push({ cells, row: rowStart });
    cells = [];
    if (rows.length > 20_001) fail("report_row_limit");
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
    } else if (closedQuote) fail("report_quote_trailing_characters", rowStart);
    else if (char === '"' && cell === "") quoted = true;
    else cell += char;
  }
  if (quoted) fail("report_quote_unclosed", rowStart);
  if (cell !== "" || cells.length || closedQuote) endRow();
  return rows;
}

function money(value: string, currency: string, row: number, optional = false): number {
  if (!value && optional) return 0;
  // Do not round, parse floats, accept thousands separators, or infer a currency.
  if (!/^\d+(?:\.\d+)?$/.test(value)) fail("report_amount_invalid", row);
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(digits).replace(/0/g, "") !== "") fail("report_amount_precision", row);
  const amount = BigInt(whole) * (10n ** BigInt(digits)) + BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) fail("report_amount_overflow", row);
  return Number(amount);
}

function bounded(value: string, max: number, row: number, nullable = false): string {
  if ((!nullable && !value) || value.length > max || value.includes("\0")) fail("report_field_invalid", row);
  return value;
}

function unshippedPromise(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.exec(value);
  if (!match) return null;
  const date = new Date(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) return null;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

export function parseAmazonOrderReport(text: string): { orders: ParsedAmazonReportOrder[]; rowCount: number; warnings: string[]; reportType: "priced" | "unshipped" } {
  const records = readTsv(text);
  if (records.length < 2) fail("report_empty");
  const headers = records[0].cells.map((cell) => cell.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((header) => !header)) fail("report_headers_invalid");
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  if (missingHeaders.length) fail("report_headers_missing", undefined, missingHeaders);
  const hasCurrency = headers.includes("currency"), hasItemPrice = headers.includes("item-price");
  if (hasCurrency !== hasItemPrice || !hasCurrency && monetaryHeaders.some((header) => headers.includes(header))) fail("report_financial_columns_incomplete");
  const priced = hasCurrency && hasItemPrice;
  if (!priced && !unshippedHeaders.every((header) => headers.includes(header))) fail("report_type_unsupported");
  const orders = new Map<string, ParsedAmazonReportOrder>();
  const seenLines = new Map<string, { orderId: string; signature: string }>();
  // Financial absence is represented by null and the report type. Attachment
  // warnings must remain about missing or invalid content, not missing prices.
  const warnings: string[] = [];
  for (const record of records.slice(1)) {
    const { row, cells } = record;
    if (cells.length !== headers.length) fail("report_columns_mismatch", row);
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index].trim()]));
    const get = (key: string) => values[key] ?? "";
    const externalOrderId = bounded(get("order-id"), 500, row);
    const externalLineId = bounded(get("order-item-id"), 300, row);
    const date = get("purchase-date");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(date) || Number.isNaN(Date.parse(date))) fail("report_date_invalid", row);
    const calendarDate = new Date(`${date.slice(0, 10)}T00:00:00Z`);
    if (Number.isNaN(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date.slice(0, 10)) fail("report_date_nonexistent", row);
    const placedAt = new Date(date).toISOString();
    const currency = priced ? get("currency").toUpperCase() : null;
    if (currency !== null && !supportedCurrencies.has(currency)) fail("report_currency_invalid", row);
    if (!/^[1-9]\d*$/.test(get("quantity-purchased"))) fail("report_quantity_invalid", row);
    const quantity = Number(get("quantity-purchased"));
    if (!Number.isSafeInteger(quantity) || quantity > 100_000) fail("report_quantity_overflow", row);
    const line: ParsedAmazonReportLine = {
      externalLineId, skuCode: bounded(get("sku"), 200, row, true) || null,
      title: bounded(get("product-name"), 1_000, row), quantity, currency,
      itemTotalMinor: currency === null ? null : money(get("item-price"), currency, row),
      shippingTotalMinor: currency === null ? null : money(get("shipping-price"), currency, row, true),
      taxTotalMinor: currency === null ? null : money(get("item-tax"), currency, row, true) + money(get("shipping-tax"), currency, row, true),
      customizedUrl: bounded(get("customized-url"), 10_000, row, true) || null,
      customizedPage: bounded(get("customized-page"), 10_000, row, true) || null,
      ...(!priced ? { platformShipByAt: unshippedPromise(get("promise-date")) } : {}),
    };
    if (line.taxTotalMinor !== null && !Number.isSafeInteger(line.taxTotalMinor)) fail("report_tax_overflow", row);
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
    if (!details.success) fail("report_buyer_shipping_invalid", row);
    const signature = JSON.stringify({ placedAt, line, protectedDetails: details.data });
    const seen = seenLines.get(externalLineId);
    if (seen) {
      if (seen.orderId !== externalOrderId || seen.signature !== signature) fail("report_duplicate_conflict", row);
      warnings.push(`第 ${row} 行与本批已有订单行相同，已跳过`);
      continue;
    }
    seenLines.set(externalLineId, { orderId: externalOrderId, signature });
    let order = orders.get(externalOrderId);
    if (!order) {
      order = { externalOrderId, placedAt, lines: [], protectedDetails: details.data };
      orders.set(externalOrderId, order);
    } else if (order.placedAt !== placedAt || order.lines[0]?.currency !== currency || JSON.stringify(order.protectedDetails) !== JSON.stringify(details.data)) fail("report_order_conflict", row);
    order.lines.push(line);
    if (order.lines.length > 1_000) fail("report_order_line_limit", row);
    if (["gift-wrap-price", "gift-wrap-tax", "item-promotion-discount", "ship-promotion-discount"].some((key) => get(key) && !/^0(?:\.0+)?$/.test(get(key)))) warnings.push(`第 ${row} 行包含礼品包装或促销金额，当前金额摘要未计入这些项目`);
  }
  return { orders: [...orders.values()], rowCount: records.length - 1, warnings, reportType: priced ? "priced" : "unshipped" };
}
