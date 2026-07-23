import { createEntityId, type NormalizeOrderInput } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  advanceOrderCheckpoint,
  assessOrderIngestion,
  executeOrderSync,
  planOrderSync,
  type MarketplaceOrderIngestionAdapter,
} from "./order-ingestion.js";

describe("marketplace order ingestion boundary", () => {
  it("plans a bounded initial backfill and clamps late-update overlap to that window", () => {
    const now = new Date("2026-07-22T12:00:00.000Z");
    expect(planOrderSync({ checkpoint: { cursor: null, highWaterAt: null, version: 1 }, now })).toMatchObject({
      updatedAfter: "2026-07-15T12:00:00.000Z",
      updatedBefore: now.toISOString(),
      pageSize: 50,
      maxPages: 20,
    });
    expect(planOrderSync({
      checkpoint: { cursor: null, highWaterAt: "2026-07-22T11:58:00.000Z", version: 2 },
      now,
    }).updatedAfter).toBe("2026-07-22T11:53:00.000Z");
    expect(() => planOrderSync({ checkpoint: { cursor: null, highWaterAt: null, version: 1 }, now, requestedBackfillDays: 31 })).toThrow(/between 1 and 30/);
  });

  it("advances cursors without publishing an unfinished page high-water mark", () => {
    const first = advanceOrderCheckpoint(
      { cursor: null, highWaterAt: "2026-07-22T10:00:00.000Z", version: 1 },
      page({ nextCursor: "page-2", highWaterAt: "2026-07-22T11:00:00.000Z" }),
    );
    expect(first).toEqual({ cursor: "page-2", highWaterAt: "2026-07-22T10:00:00.000Z", version: 2 });
    expect(advanceOrderCheckpoint(first, page({ nextCursor: null, highWaterAt: "2026-07-22T11:00:00.000Z" }))).toEqual({
      cursor: null,
      highWaterAt: "2026-07-22T11:00:00.000Z",
      version: 3,
    });
    expect(() => advanceOrderCheckpoint(first, page({ nextCursor: null, highWaterAt: "2026-07-22T09:00:00.000Z" }))).toThrow(/backwards/);
  });

  it("detects replay, fulfillment, customization, mapping, cancellation, and freshness risks without exposing PII", () => {
    const order = fixtureOrder();
    const risks = assessOrderIngestion({
      fetchedAt: "2026-07-22T12:00:00.000Z",
      records: [
        { order, providerUpdatedAt: "2026-07-22T10:00:00.000Z", requiresCustomizationLineIds: ["line-1"], buyerRequestedCancellation: true },
        { order, providerUpdatedAt: "2026-07-22T12:00:00.000Z" },
      ],
    });
    expect(new Set(risks.map((entry) => entry.code))).toEqual(new Set([
      "address_gap", "customization_missing", "unsupported_mapping", "cancellation_requested", "stale_provider_data", "duplicate_delivery",
    ]));
    expect(JSON.stringify(risks)).not.toMatch(/buyer@example\.test|Buyer Name|Secret street/);
  });

  it("executes bounded pagination, materializes replay-safely, and reports a partial cursor", async () => {
    const order = fixtureOrder();
    const adapter: MarketplaceOrderIngestionAdapter = {
      platform: "amazon",
      fetchPage: async (_context, _credentials, request) => ({
        records: [orderRecord(order)],
        fetchedAt: "2026-07-22T12:00:00.000Z",
        highWaterAt: "2026-07-22T12:00:00.000Z",
        nextCursor: request.checkpoint.cursor ? "page-3" : "page-2",
        reportedCount: 3,
        sourceVersion: "fixture-v2",
      }),
    };
    const deliveries = new Set<string>();
    const result = await executeOrderSync({
      adapter,
      context: { accountId: order.accountId, tenantId: createEntityId(), platform: "amazon", externalAccountId: "seller", region: "NA", marketplaceIds: ["ATVPDKIKX0DER"] },
      credentials: { withCredential: (callback) => callback({ refreshToken: "not-exposed" }) },
      request: { checkpoint: { cursor: null, highWaterAt: null, version: 1 }, updatedAfter: "2026-07-22T10:00:00.000Z", updatedBefore: "2026-07-22T12:00:00.000Z", pageSize: 50, maxPages: 2 },
      signal: new AbortController().signal,
      materialize: async (candidate) => {
        const replayed = deliveries.has(candidate.externalEventId);
        deliveries.add(candidate.externalEventId);
        return { replayed };
      },
    });
    expect(result).toMatchObject({ collectedCount: 2, reportedCount: 3, duplicateCount: 1, pageCount: 2, nextCursor: "page-3", status: "partial", sourceVersion: "fixture-v2" });
    expect(result.risks.some((risk) => risk.code === "duplicate_delivery")).toBe(true);
  });
});

function page(overrides: { nextCursor: string | null; highWaterAt: string }) {
  return {
    fetchedAt: "2026-07-22T12:00:00.000Z",
    reportedCount: 2,
    sourceVersion: "fixture-v1",
    ...overrides,
  };
}

function fixtureOrder(): NormalizeOrderInput {
  return {
    accountId: createEntityId(),
    platform: "amazon",
    externalEventId: "event-1",
    externalOrderId: "order-1",
    providerStatus: "unshipped",
    placedAt: "2026-07-22T09:00:00.000Z",
    orderTotal: { amountMinor: 2500, currency: "USD" },
    lines: [{
      externalLineId: "line-1", externalListingId: null, skuCode: null, title: "Custom product",
      quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0,
    }],
    redactedSource: { source: "fixture" },
    protectedDetails: {
      buyer: { name: "Buyer Name", email: "buyer@example.test", phone: null },
      shippingAddress: { recipient: "Buyer Name", lines: ["Secret street"], city: "City", region: null, postalCode: null, countryCode: "US" },
      customizations: [],
    },
  };
}

function orderRecord(order: NormalizeOrderInput) {
  return { order, providerUpdatedAt: "2026-07-22T11:55:00.000Z" };
}
