import { createEntityId } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

import type { MarketplaceConnectorContext, MarketplaceCredentialAccessor } from "./connector.js";
import type { MarketplaceConnectorError } from "./errors.js";
import { AmazonOrdersAdapter, EtsyReceiptsAdapter } from "./order-adapters.js";
import type { OrderSyncRequest } from "./order-ingestion.js";

const now = () => new Date("2026-07-22T12:00:00.000Z");

describe("authorized order HTTP adapters", () => {
  it("requests a bounded Amazon page with selective data and preserves the next token", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "amazon-access" }))
      .mockResolvedValueOnce(json({ orders: [amazonOrder()], pagination: { nextToken: "page-3" }, totalCount: 9 }));
    const result = await new AmazonOrdersAdapter(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    }, now).fetchPage(amazonContext(), credential({ refreshToken: "refresh", clientId: "client", clientSecret: "secret" }), syncRequest("page-2"), new AbortController().signal);

    expect(result).toMatchObject({ nextCursor: "page-3", reportedCount: 9, sourceVersion: "amazon-orders-2026-01-01" });
    expect(result.records[0]?.order.externalOrderId).toBe("111-2222222-3333333");
    const url = new URL(String(request.mock.calls[1]![0]));
    expect(url.pathname).toBe("/orders/2026-01-01/orders");
    expect(url.searchParams.get("paginationToken")).toBe("page-2");
    expect(url.searchParams.get("includedData")).toBe("BUYER,RECIPIENT,PROCEEDS,CANCELLATION");
    expect(JSON.stringify(result.records[0]?.order.redactedSource)).not.toContain("buyer@example.test");
  });

  it("uses Etsy updated-time pagination and advances an opaque offset cursor", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "12345.etsy-access", refresh_token: "rotated" }))
      .mockResolvedValueOnce(json({ count: 3, results: [etsyReceipt()] }));
    const result = await new EtsyReceiptsAdapter(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key", ETSY_APP_SHARED_SECRET: "etsy-secret",
    }, now).fetchPage(etsyContext(), credential({ refreshToken: "refresh" }), syncRequest("1"), new AbortController().signal);

    expect(result).toMatchObject({ nextCursor: "2", reportedCount: 3, sourceVersion: "etsy-open-api-v3" });
    const url = new URL(String(request.mock.calls[1]![0]));
    expect(url.pathname).toBe("/v3/application/shops/12345/receipts");
    expect(url.searchParams.get("offset")).toBe("1");
    expect(url.searchParams.get("sort_on")).toBe("updated");
    expect(url.searchParams.get("min_last_modified")).toBe("1784718000");
  });

  it("returns rate-limit timing to the job retry boundary without retrying blindly", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(json({ access_token: "amazon-access" }))
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
    const promise = new AmazonOrdersAdapter(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    }, now).fetchPage(amazonContext(), credential({ refreshToken: "refresh", clientId: "client", clientSecret: "secret" }), syncRequest(null), new AbortController().signal);

    await expect(promise).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 2_000 } satisfies Partial<MarketplaceConnectorError>);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function syncRequest(cursor: string | null): OrderSyncRequest {
  return {
    checkpoint: { cursor, highWaterAt: "2026-07-22T10:00:00.000Z", version: 2 },
    updatedAfter: "2026-07-22T11:00:00.000Z", updatedBefore: "2026-07-22T12:00:00.000Z",
    pageSize: 50, maxPages: 20,
  };
}

function amazonContext(): MarketplaceConnectorContext {
  return { accountId: createEntityId(), tenantId: createEntityId(), platform: "amazon", externalAccountId: "seller-1", region: "NA", marketplaceIds: ["ATVPDKIKX0DER"] };
}

function etsyContext(): MarketplaceConnectorContext {
  return { accountId: createEntityId(), tenantId: createEntityId(), platform: "etsy", externalAccountId: "12345", region: "GLOBAL", marketplaceIds: ["etsy"] };
}

function credential(value: Record<string, string>): MarketplaceCredentialAccessor {
  return { withCredential: (callback) => callback(value) };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function amazonOrder() {
  return {
    orderId: "111-2222222-3333333", createdTime: "2026-07-22T09:00:00.000Z", lastUpdatedTime: "2026-07-22T11:30:00.000Z",
    fulfillmentStatus: "UNSHIPPED", salesChannel: { marketplaceId: "ATVPDKIKX0DER" },
    orderTotal: { amount: "25.00", currencyCode: "USD" },
    orderItems: [{ orderItemId: "item-1", product: { asin: "B000TEST", sellerSku: "SKU-1", title: "Custom mug" }, quantityOrdered: 1, unitPrice: { amount: "25.00", currencyCode: "USD" } }],
    buyer: { name: "Buyer", email: "buyer@example.test" },
    recipient: { name: "Buyer", addressLines: ["Secret street"], city: "Seattle", stateOrRegion: "WA", postalCode: "98101", countryCode: "US" },
  };
}

function etsyReceipt() {
  return {
    receipt_id: 1001, status: "paid", created_timestamp: 1_784_714_400, updated_timestamp: 1_784_718_000,
    grandtotal: { amount: 2500, divisor: 100, currency_code: "USD" },
    transactions: [{ transaction_id: 5001, listing_id: 7001, title: "Custom mug", quantity: 1, sku: "SKU-1", price: { amount: 2500, divisor: 100, currency_code: "USD" } }],
  };
}
