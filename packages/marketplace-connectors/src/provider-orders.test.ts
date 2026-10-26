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

  it("uses the official nested fulfillment promise and financial aliases without human verification", () => {
    const result = normalizeAmazonOrder(createEntityId(), "official-2026-event", officialAmazonOrder());
    expect(result.order).toMatchObject({ providerStatus: "UNSHIPPED", orderTotal: { amountMinor: 5000, currency: "USD" } });
    expect(result.order.lines[0]?.unitPrice).toEqual({ amountMinor: 2500, currency: "USD" });
    expect(result.order.redactedSource).toMatchObject({
      platformShipByAt: "2026-07-24T12:00:00.000Z",
      platformShipBySource: "amazon_orders_2026_fulfillment_ship_by_window",
      platformShipByField: "fulfillment.shipByWindow.latestDateTime",
      lastUpdatedTime: "2026-07-22T09:00:00.000Z",
    });
    expect(result.order.redactedSource).not.toHaveProperty("platformDeadlineVerifiedAt");
    expect(result.order.redactedSource).not.toHaveProperty("verifiedBy");
    expect(JSON.stringify(result.order.redactedSource)).not.toContain("Private fulfillment note");
  });

  it("keeps a missing current promise null instead of using delivery or label dates", () => {
    const order = officialAmazonOrder();
    const result = normalizeAmazonOrder(createEntityId(), "missing-promise", {
      ...order, fulfillment: { fulfillmentStatus: "UNSHIPPED", shipByWindow: {},
        deliverByWindow: { latestDateTime: "2026-07-30T00:00:00Z" },
        labelPrintingWindow: { earliestDateTime: "2026-07-23T00:00:00Z" } },
    });
    expect(result.order.redactedSource.platformShipByAt).toBeNull();
    expect(result.order.redactedSource.lastUpdatedTime).toBe(order.lastUpdatedTime);
    const legacy = normalizeAmazonOrder(createEntityId(), "legacy-no-fulfillment", { ...order, fulfillment: undefined, fulfillmentStatus: "UNSHIPPED" });
    expect(legacy.order.redactedSource.platformShipByAt).toBeNull();
  });

  it.each(["2026-07-24", "invalid", "2026-02-30T12:00:00Z", 42])("rejects a malformed supplied ship-by value: %s", latestDateTime => {
    expect(() => normalizeAmazonOrder(createEntityId(), "invalid-promise", {
      ...officialAmazonOrder(), fulfillment: { fulfillmentStatus: "UNSHIPPED", shipByWindow: { latestDateTime } },
    })).toThrow();
  });

  it("rejects conflicting or missing fulfillment statuses rather than guessing one", () => {
    expect(() => normalizeAmazonOrder(createEntityId(), "conflicting-status", {
      ...officialAmazonOrder(), fulfillmentStatus: "SHIPPED",
    })).toThrow("Amazon fulfillment statuses conflict");
    expect(() => normalizeAmazonOrder(createEntityId(), "missing-status", {
      ...officialAmazonOrder(), fulfillment: { shipByWindow: { latestDateTime: "2026-07-24T12:00:00Z" } },
    })).toThrow("Amazon fulfillment status was not included");
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

function officialAmazonOrder() {
  return {
    orderId: "111-2222222-3333333", createdTime: "2026-07-22T08:00:00.000Z", lastUpdatedTime: "2026-07-22T09:00:00.000Z",
    salesChannel: { marketplaceId: "ATVPDKIKX0DER" },
    fulfillment: { fulfillmentStatus: "UNSHIPPED", shipByWindow: { latestDateTime: "2026-07-24T20:00:00+08:00" }, privateNote: "Private fulfillment note" },
    proceeds: { grandTotal: { amount: "50.00", currencyCode: "USD" } },
    orderItems: [{ orderItemId: "item-1", quantityOrdered: 2,
      product: { asin: "B000TEST", sellerSku: "SKU-1", title: "Custom pillow", price: { unitPrice: { amount: "25.00", currencyCode: "USD" } } },
      proceeds: { breakdowns: [{ type: "ITEM", subtotal: { amount: "50.00", currencyCode: "USD" } }] },
    }],
  };
}
