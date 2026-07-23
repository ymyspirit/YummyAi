import { createEntityId } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { normalizeAmazonOrder, normalizeAmazonOrderChange, normalizeEtsyReceipt } from "./provider-orders.js";

describe("provider order normalizers", () => {
  it("normalizes Amazon Orders v2026-01-01 and keeps PII out of redacted evidence", () => {
    const result = normalizeAmazonOrder(createEntityId(), "amazon-event-1", {
      orderId: "111-2222222-3333333", createdTime: "2026-07-22T08:00:00.000Z", lastUpdatedTime: "2026-07-22T09:00:00.000Z",
      fulfillmentStatus: "UNSHIPPED", salesChannel: { marketplaceId: "ATVPDKIKX0DER" },
      orderTotal: { amount: "25.40", currencyCode: "USD" },
      buyer: { name: "Buyer Name", email: "buyer@example.test" },
      recipient: { name: "Buyer Name", addressLines: ["Secret street"], city: "Troy", postalCode: "48083", countryCode: "US" },
      orderItems: [{ orderItemId: "item-1", product: { asin: "B000TEST", sellerSku: "SKU-1", title: "Custom pillow" }, quantityOrdered: 1, unitPrice: { amount: "25.40", currencyCode: "USD" }, customization: [{ name: "Name", value: "Olivia" }] }],
    });
    expect(result.order).toMatchObject({ platform: "amazon", externalOrderId: "111-2222222-3333333", orderTotal: { amountMinor: 2540, currency: "USD" } });
    expect(result.order.protectedDetails?.customizations[0]?.values[0]).toMatchObject({ label: "Name", value: "Olivia" });
    expect(JSON.stringify(result.order.redactedSource)).not.toMatch(/Buyer Name|buyer@example|Secret street|Olivia/);
  });

  it("turns ORDER_CHANGE into an enrichment reference and detects buyer cancellation", () => {
    expect(normalizeAmazonOrderChange({
      NotificationType: "ORDER_CHANGE", PayloadVersion: "1.0", EventTime: "2026-07-22T10:00:00.000Z",
      NotificationMetadata: { NotificationId: "notification-1" },
      Payload: { OrderChangeNotification: {
        AmazonOrderId: "111-2222222-3333333", OrderChangeType: "BuyerRequestedChange",
        OrderChangeTrigger: { TimeOfOrderChange: "2026-07-22T09:59:00.000Z", ChangeReason: "Buyer Requested Cancel" },
        Summary: { OrderStatus: "Unshipped", MarketplaceId: "ATVPDKIKX0DER" },
      } },
    })).toMatchObject({ externalEventId: "notification-1", buyerRequestedCancellation: true, providerUpdatedAt: "2026-07-22T09:59:00.000Z" });
  });

  it("normalizes Etsy receipt transactions, money, address, and variations", () => {
    const result = normalizeEtsyReceipt(createEntityId(), {
      receipt_id: 9001, status: "paid", created_timestamp: 1784707200, updated_timestamp: 1784710800,
      grandtotal: { amount: 2475, divisor: 100, currency_code: "USD" },
      buyer_email: "buyer@example.test", name: "Buyer Name", first_line: "Secret street", city: "Troy", state: "MI", zip: "48083", country_iso: "US",
      message_from_buyer: "Use blue thread",
      transactions: [{ transaction_id: 7001, listing_id: 1788834009, title: "Personalized pillow", quantity: 1, sku: "PILLOW-1", price: { amount: 2475, divisor: 100, currency_code: "USD" }, variations: [{ formatted_name: "Size", formatted_value: "14x14" }] }],
    });
    expect(result.order).toMatchObject({ platform: "etsy", externalOrderId: "9001", orderTotal: { amountMinor: 2475, currency: "USD" } });
    expect(result.order.lines[0]).toMatchObject({ externalLineId: "7001", externalListingId: "1788834009", customizationCount: 2 });
    expect(JSON.stringify(result.order.redactedSource)).not.toMatch(/Buyer Name|buyer@example|Secret street|blue thread/);
  });
});
