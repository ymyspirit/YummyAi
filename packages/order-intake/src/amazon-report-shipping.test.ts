import { describe, expect, it } from "vitest";
import { parseAmazonOrderReport } from "./amazon-report-parser.js";

function report(promise: string, priced = false) {
  const headers = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "quantity-shipped", "quantity-to-ship", "promise-date"];
  const values = ["SYNTHETIC-ORDER", "SYNTHETIC-LINE", "2026-10-24T00:00:00Z", "SYNTHETIC-SKU", "Synthetic pillow", "2", "1", "1", promise];
  if (priced) { headers.push("currency", "item-price"); values.push("USD", "20.00"); }
  return [headers.join("\t"), values.join("\t")].join("\n");
}

describe("unshipped report platform shipping promises", () => {
  it.each([
    ["2026-10-28T06:59:59+00:00", "2026-10-28T06:59:59.000Z"],
    ["2026-10-28T14:59:59+08:00", "2026-10-28T06:59:59.000Z"],
    ["2026-10-28T06:59:59Z", "2026-10-28T06:59:59.000Z"],
  ])("keeps the exact timezone-qualified ship promise %s", (value, expected) => {
    const result = parseAmazonOrderReport(report(value));
    expect(result.reportType).toBe("unshipped");
    expect(result.orders[0]!.lines[0]!.platformShipByAt).toBe(expected);
    expect(result.orders[0]!.lines[0]!.quantity).toBe(2);
    expect(result.orders[0]!.lines[0]).not.toHaveProperty("shippedQuantity");
  });
  it.each(["", "2026-10-28", "2026-10-28T06:59:59", "2026-02-30T06:59:59Z", "2026-10-28T25:00:00Z", "invalid"])("does not invent a deadline from %s", value => {
    expect(parseAmazonOrderReport(report(value)).orders[0]!.lines[0]!.platformShipByAt).toBeNull();
  });
  it("does not promote an extra promise-date column on a different report family", () => {
    const result = parseAmazonOrderReport(report("2026-10-28T06:59:59Z", true));
    expect(result.reportType).toBe("priced");
    expect(result.orders[0]!.lines[0]).not.toHaveProperty("platformShipByAt");
  });
});
