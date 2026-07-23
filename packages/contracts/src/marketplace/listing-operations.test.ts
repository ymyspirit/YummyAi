import { describe, expect, it } from "vitest";

import {
  CreateListingReplicationInputSchema,
  CreateMarketplaceAutomationRuleInputSchema,
  CreateMarketplaceListingSyncInputSchema,
  MarketplaceListingSyncRequestViewSchema,
} from "./listing-operations.js";

const id = "0198fbef-4a10-7000-8000-000000000701";
const checksum = "a".repeat(64);

describe("marketplace Listing operation contracts", () => {
  it("accepts a bounded same-platform site replica request", () => {
    expect(CreateListingReplicationInputSchema.parse({
      sourceVersionId: id,
      targetMarketplaceId: "ATVPDKIKX0DER",
      targetLocale: "en-US",
      overrides: { title: "US title" },
    })).toMatchObject({ targetMarketplaceId: "ATVPDKIKX0DER" });
  });

  it("requires a pinned publication when synchronizing an online Listing", () => {
    expect(CreateMarketplaceListingSyncInputSchema.parse({
      accountId: id,
      listingId: id,
      listingVersionId: id,
      sourcePublicationRequestId: id,
      action: "push_price_inventory",
    }).action).toBe("push_price_inventory");
  });

  it("keeps automation actions constrained to guarded publication or sync queues", () => {
    expect(CreateMarketplaceAutomationRuleInputSchema.parse({
      name: "Approved US Listing preview",
      action: { type: "queue_publication", accountId: id, marketplaceId: "ATVPDKIKX0DER" },
    })).toMatchObject({ enabled: false, trigger: "listing_approved" });
  });

  it("parses immutable sync request projections", () => {
    expect(MarketplaceListingSyncRequestViewSchema.parse({
      id,
      accountId: id,
      sourcePublicationRequestId: id,
      listingId: id,
      listingVersionId: id,
      platform: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      externalListingId: "SKU-1",
      action: "read",
      idempotencyKey: checksum,
      desiredChecksum: checksum,
      createdBy: id,
      createdAt: "2026-07-20T00:00:00.000Z",
      current: {
        id,
        sequence: 1,
        status: "queued",
        code: null,
        message: null,
        issues: [],
        snapshot: null,
        snapshotChecksum: null,
        retryable: false,
        occurredAt: "2026-07-20T00:00:00.000Z",
      },
    }).current.status).toBe("queued");
  });
});
