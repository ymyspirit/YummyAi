import { describe, expect, it } from "vitest";

import {
  CancelMarketplacePublicationInputSchema,
  CreateMarketplacePublicationInputSchema,
  MarketplacePublicationRequestViewSchema,
} from "../index.js";

const id = "019b0000-0000-7000-8000-000000000001";

describe("marketplace publication contracts", () => {
  it("accepts a request that pins an approved Listing version", () => {
    expect(CreateMarketplacePublicationInputSchema.parse({
      accountId: id,
      listingId: id,
      listingVersionId: id,
      marketplaceId: "ATVPDKIKX0DER",
      variantSkuId: "sku-blue",
      scheduledFor: "2026-07-25T08:00:00.000+08:00",
    })).toMatchObject({ marketplaceId: "ATVPDKIKX0DER" });
    expect(CancelMarketplacePublicationInputSchema.parse({ reason: "Campaign timing changed" }))
      .toEqual({ reason: "Campaign timing changed" });
  });

  it("exposes only checksums and counts instead of provider payloads", () => {
    const parsed = MarketplacePublicationRequestViewSchema.parse({
      id,
      accountId: id,
      capabilitySnapshotId: id,
      listingId: id,
      listingVersionId: id,
      platform: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      action: "amazon_validation_preview",
      parentRequestId: null,
      sourceExternalListingId: null,
      idempotencyKey: "a".repeat(64),
      payloadChecksum: "b".repeat(64),
      assetCount: 1,
      scheduledFor: null,
      createdBy: id,
      createdAt: "2026-07-19T00:00:00.000Z",
      current: {
        id,
        sequence: 1,
        status: "queued",
        code: null,
        message: null,
        issues: [],
        externalListingId: null,
        externalSubmissionId: null,
        externalMediaIds: [],
        externalState: null,
        retryable: false,
        occurredAt: "2026-07-19T00:00:00.000Z",
      },
    });
    expect(parsed).not.toHaveProperty("payload");
    expect(parsed.assetCount).toBe(1);
  });
});
