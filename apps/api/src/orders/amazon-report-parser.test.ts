import { describe, expect, it } from "vitest";
import { AmazonReportImportErrorSchema, formatAmazonReportImportError } from "@yummyai/contracts/order/report";

import { AmazonReportParseError, parseAmazonOrderReport } from "./amazon-report-parser.js";

const headers = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "currency", "item-price", "shipping-price", "item-tax", "shipping-tax", "customized-url", "customized-page", "recipient-name", "ship-address-1", "ship-city", "ship-state", "ship-postal-code", "ship-country"];
const base: Record<string, string> = { "order-id": "SYNTHETIC-ORDER", "order-item-id": "SYNTHETIC-LINE", "purchase-date": "2026-09-01T12:30:00+00:00", sku: "SYNTHETIC-SKU", "product-name": "Synthetic personalized gift", "quantity-purchased": "3", currency: "USD", "item-price": "29.99", "shipping-price": "4.50", "item-tax": "2.00", "shipping-tax": "0.50", "customized-url": "https://example.test/synthetic.zip", "customized-page": "https://example.test/synthetic", "recipient-name": "Synthetic Recipient", "ship-address-1": "Synthetic Address", "ship-city": "Synthetic City", "ship-state": "CA", "ship-postal-code": "00000", "ship-country": "US" };
const quote = (value: string) => /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
function report(rows: Array<Record<string, string | undefined>> = [base], columns = headers) {
  return [columns.join("\t"), ...rows.map((row) => columns.map((column) => quote(row[column] ?? "")).join("\t"))].join("\r\n");
}
const unshippedColumns = [...headers.filter((column) => !["currency", "item-price", "shipping-price", "item-tax", "shipping-tax"].includes(column)), "quantity-shipped", "quantity-to-ship", "promise-date"];
const unshippedRow = { ...base, "quantity-shipped": "0", "quantity-to-ship": "3", "promise-date": "2026-09-05T12:30:00+00:00" };

function diagnosticFor(text: string) {
  try { parseAmazonOrderReport(text); }
  catch (error) {
    expect(error).toBeInstanceOf(AmazonReportParseError);
    return (error as AmazonReportParseError).diagnostic;
  }
  throw new Error("Expected report validation failure");
}

describe("Amazon order report parser", () => {
  it("keeps item-price as the line total and parses protected shipping details separately", () => {
    const result = parseAmazonOrderReport(report());
    expect(result.rowCount).toBe(1);
    expect(result.orders[0].lines[0]).toMatchObject({ quantity: 3, itemTotalMinor: 2999, shippingTotalMinor: 450, taxTotalMinor: 250 });
    expect(result.orders[0].placedAt).toBe("2026-09-01T12:30:00.000Z");
    expect(result.orders[0].protectedDetails.shippingAddress).toMatchObject({ recipient: "Synthetic Recipient", lines: ["Synthetic Address"], countryCode: "US" });
    expect(result.reportType).toBe("priced");
  });

  it("accepts identifiable unshipped reports while retaining every missing financial value as unknown", () => {
    const result = parseAmazonOrderReport(report([unshippedRow], unshippedColumns));
    expect(result.reportType).toBe("unshipped");
    expect(result.orders[0].lines[0]).toMatchObject({ quantity: 3, currency: null, itemTotalMinor: null, shippingTotalMinor: null, taxTotalMinor: null, customizedUrl: base["customized-url"] });
    expect(result.orders[0].protectedDetails.shippingAddress.countryCode).toBe("US");
    expect(result.warnings).toEqual([]);
  });

  it.each(["currency", "item-price", "shipping-price", "item-tax", "shipping-tax", "gift-wrap-price", "item-promotion-discount"])("rejects partial financial headers in an unshipped report: %s", (column) => {
    expect(diagnosticFor(report([unshippedRow], [...unshippedColumns, column]))).toEqual({ code: "report_financial_columns_incomplete" });
  });

  it.each(["quantity-shipped", "quantity-to-ship", "promise-date"])("requires the unshipped report signature when financial columns are absent: %s", (column) => {
    expect(diagnosticFor(report([unshippedRow], unshippedColumns.filter((header) => header !== column)))).toEqual({ code: "report_type_unsupported" });
  });

  it("does not treat invalid or blank financial fields in a priced unshipped report as unknown", () => {
    const columns = [...unshippedColumns, "currency", "item-price"];
    expect(diagnosticFor(report([{ ...unshippedRow, currency: "" }], columns))).toEqual({ code: "report_currency_invalid", row: 2 });
    expect(diagnosticFor(report([{ ...unshippedRow, "item-price": "" }], columns))).toEqual({ code: "report_amount_invalid", row: 2 });
    expect(diagnosticFor(report([{ ...unshippedRow, "item-price": "1e3" }], columns))).toEqual({ code: "report_amount_invalid", row: 2 });
    expect(parseAmazonOrderReport(report([unshippedRow], columns)).orders[0].lines[0]).toMatchObject({ currency: "USD", itemTotalMinor: 2999 });
  });

  it("preserves explicit zero financial facts rather than turning them into unknown values", () => {
    expect(parseAmazonOrderReport(report([{ ...base, "item-price": "0", "shipping-price": "0", "item-tax": "0", "shipping-tax": "0" }])).orders[0].lines[0])
      .toMatchObject({ currency: "USD", itemTotalMinor: 0, shippingTotalMinor: 0, taxTotalMinor: 0 });
  });

  it("handles a BOM, CRLF, quoted tabs, quoted newlines, escaped quotes, and the final newline", () => {
    const title = 'Synthetic\t"gift"\nsecond line';
    const result = parseAmazonOrderReport(`\uFEFF${report([{ ...base, "product-name": title }])}\r\n`);
    expect(result.orders[0].lines[0].title).toBe(title);
  });

  it("accepts literal inch marks inside unquoted TSV titles", () => {
    const original = report().replace("Synthetic personalized gift", 'Synthetic 12" pillow');
    expect(parseAmazonOrderReport(original).orders[0].lines[0].title).toBe('Synthetic 12" pillow');
  });

  it("groups multiple items into one order and preserves ordinary items without custom links", () => {
    const result = parseAmazonOrderReport(report([base, { ...base, "order-item-id": "SECOND-LINE", "customized-url": "", "customized-page": "" }, { ...base, "order-id": "SECOND-ORDER", "order-item-id": "THIRD-LINE" }]));
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0].lines).toHaveLength(2);
    expect(result.orders[0].lines[1].customizedUrl).toBeNull();
  });

  it("deduplicates identical rows but reports the source row count", () => {
    const result = parseAmazonOrderReport(report([base, base]));
    expect(result.rowCount).toBe(2);
    expect(result.orders[0].lines).toHaveLength(1);
    expect(result.warnings).toEqual(["第 3 行与本批已有订单行相同，已跳过"]);
  });

  it.each([
    { "item-price": "30.00" },
    { "order-id": "OTHER-ORDER" },
    { "ship-address-1": "Another Synthetic Address" },
  ])("rejects conflicting duplicates instead of silently overwriting them: %j", (change) => {
    expect(() => parseAmazonOrderReport(report([base, { ...base, ...change }]))).toThrow("第 3 行：同一订单行出现相互冲突的数据");
  });

  it.each([
    { "ship-address-1": "Another Synthetic Address" },
    { currency: "EUR" },
    { "purchase-date": "2026-09-02T12:30:00Z" },
  ])("rejects conflicting order-level data: %j", (change) => {
    expect(() => parseAmazonOrderReport(report([base, { ...base, "order-item-id": "OTHER-LINE", ...change }]))).toThrow("同一订单的时间、币种或配送信息不一致");
  });

  it.each([
    ["JPY", "1200", 1200], ["JPY", "1200.00", 1200], ["BHD", "1.234", 1234], ["USD", "0.29", 29],
  ])("uses the currency's minor units for %s", (currency, amount, expected) => {
    const result = parseAmazonOrderReport(report([{ ...base, currency: String(currency), "item-price": String(amount), "shipping-price": "", "item-tax": "", "shipping-tax": "" }]));
    expect(result.orders[0].lines[0].itemTotalMinor).toBe(expected);
  });

  it.each(["1.001", "-1", "1,000.00", "NaN", "1e3", "9007199254740992.00", ""])('rejects unsafe amount "%s"', (amount) => {
    expect(() => parseAmazonOrderReport(report([{ ...base, "item-price": amount }]))).toThrow("金额");
  });

  it.each(["0", "-1", "1.5", "100001", "NaN"])("rejects invalid quantity %s", (quantity) => {
    expect(() => parseAmazonOrderReport(report([{ ...base, "quantity-purchased": quantity }]))).toThrow("数量");
  });

  it("requires the source report headers and does not guess an absent currency", () => {
    expect(() => parseAmazonOrderReport(report([base], headers.filter((header) => header !== "order-item-id")))).toThrow("缺少必要列");
    expect(() => parseAmazonOrderReport(report([{ ...base, currency: "" }]))).toThrow("币种");
    expect(() => parseAmazonOrderReport(report([base], [...headers, "currency"]))).toThrow("重复");
  });

  it("does not leak source values in malformed-row errors", () => {
    const source = report([{ ...base, "quantity-purchased": "PRIVATE-BUYER-VALUE" }]);
    try { parseAmazonOrderReport(source); throw new Error("Expected parser rejection"); }
    catch (error) { expect((error as Error).message).toBe("订单报告第 2 行：购买数量必须是正整数"); }
  });

  it("reports physical row numbers across quoted multiline fields without including private values", () => {
    const source = report([{ ...base, "product-name": "Synthetic first\nsecond\nthird" }, { ...base, "order-item-id": "SECOND-LINE", "quantity-purchased": "PRIVATE-BUYER-VALUE" }]);
    const diagnostic = diagnosticFor(source);
    expect(diagnostic).toEqual({ code: "report_quantity_invalid", row: 5 });
    expect(formatAmazonReportImportError(diagnostic)).toBe("订单报告第 5 行：购买数量必须是正整数");
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
  });

  it("lists only known missing column names and rejects arbitrary diagnostic text", () => {
    const source = report([base], headers.filter((header) => header !== "order-item-id").concat("PRIVATE-BUYER-HEADER"));
    const diagnostic = diagnosticFor(source);
    expect(diagnostic).toEqual({ code: "report_headers_missing", missingHeaders: ["order-item-id"] });
    expect(formatAmazonReportImportError(diagnostic)).toContain("缺少：order-item-id");
    expect(formatAmazonReportImportError(diagnostic)).not.toContain("PRIVATE");
    expect(AmazonReportImportErrorSchema.safeParse({ code: "report_headers_missing", missingHeaders: ["PRIVATE-BUYER-HEADER"] }).success).toBe(false);
    expect(AmazonReportImportErrorSchema.safeParse({ code: "report_quantity_invalid", row: 2, message: "PRIVATE-BUYER-VALUE" }).success).toBe(false);
    expect(AmazonReportImportErrorSchema.safeParse({ code: "PRIVATE-BUYER-VALUE" }).success).toBe(false);
  });

  it("rejects malformed quotes, inconsistent columns, invalid dates and blank reports", () => {
    expect(() => parseAmazonOrderReport(`${headers.join("\t")}\n"unterminated`)).toThrow("引号未闭合");
    expect(() => parseAmazonOrderReport(`${report()}\tunexpected`)).toThrow("列数");
    expect(() => parseAmazonOrderReport(report([{ ...base, "purchase-date": "2026-09-01 12:30:00" }]))).toThrow("时间");
    expect(() => parseAmazonOrderReport(report([{ ...base, "purchase-date": "2026-02-30T12:30:00Z" }]))).toThrow("日期不存在");
    expect(() => parseAmazonOrderReport("\uFEFF\r\n")).toThrow("没有可导入");
  });

  it("reports nonzero monetary components that this summary does not include", () => {
    const result = parseAmazonOrderReport(report([{ ...base, "item-promotion-discount": "1.00" }], [...headers, "item-promotion-discount"]));
    expect(result.warnings.join(" ")).toContain("促销金额");
    expect(result.orders[0].lines[0].itemTotalMinor).toBe(2999);
  });
});
