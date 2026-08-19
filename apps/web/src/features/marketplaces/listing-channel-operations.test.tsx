import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ListingChannelOperations } from "./listing-channel-operations";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("./marketplace-actions", () => ({
  createListingReplication: vi.fn(),
  createMarketplaceAutomationRule: vi.fn(),
  createMarketplaceListingSync: vi.fn(),
  setMarketplaceAutomationEnabled: vi.fn(),
}));

describe("Listing channel operations", () => {
  it("offers precise full-content and price/inventory synchronization actions", () => {
    const html = renderToStaticMarkup(<ListingChannelOperations
      accounts={[]}
      automations={[]}
      listing={{
        id: "listing",
        locale: "en-US",
        marketplaceId: "ATVPDKIKX0DER",
        platform: "amazon",
        status: "approved",
        variants: [],
        versionId: "version",
      }}
      publications={[]}
      replications={[]}
      syncs={[]}
    />);

    expect(html).toContain("在线 Listing 同步");
    for (const label of [
      "读取价格与库存",
      "读取完整内容",
      "写入批准价格与库存",
      "写入完整批准内容",
    ]) expect(html).toContain(label);
  });

  it("offers a published Amazon JSON Feed item as an online sync source", () => {
    const html = renderToStaticMarkup(<ListingChannelOperations
      accounts={[]}
      automations={[]}
      listing={{
        id: "listing",
        locale: "en-US",
        marketplaceId: "ATVPDKIKX0DER",
        platform: "amazon",
        status: "approved",
        variants: [],
        versionId: "version",
      }}
      publications={[{
        id: "feed-request",
        accountId: "account",
        capabilitySnapshotId: "capability",
        listingId: "listing",
        listingVersionId: "version",
        platform: "amazon",
        marketplaceId: "ATVPDKIKX0DER",
        action: "amazon_feed_submit",
        batchId: "batch",
        parentRequestId: "preview-request",
        sourceExternalListingId: null,
        idempotencyKey: "a".repeat(64),
        payloadChecksum: "b".repeat(64),
        targetLabel: "SKU-FEED-1",
        assetCount: 0,
        scheduledFor: null,
        createdBy: null,
        createdAt: "2026-07-25T00:00:00.000Z",
        current: {
          id: "event",
          sequence: 1,
          status: "published",
          code: null,
          message: null,
          issues: [],
          externalListingId: "SKU-FEED-1",
          externalSubmissionId: "feed-id",
          externalMediaIds: [],
          externalState: "BUYABLE",
          retryable: false,
          occurredAt: "2026-07-25T00:00:00.000Z",
        },
      }]}
      replications={[]}
      syncs={[]}
    />);

    expect(html).toContain("SKU-FEED-1");
    expect(html).toContain('value="feed-request"');
  });
});
