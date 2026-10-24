import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ListingChannelOperations } from "./listing-channel-operations";
import { ErpIdentityContext } from "../identity/erp-access";
import { syncActor } from "./listing-sync.test-fixture";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("./marketplace-actions", () => ({
  createListingReplication: vi.fn(),
  createMarketplaceAutomationRule: vi.fn(),
  setMarketplaceAutomationEnabled: vi.fn(),
}));

describe("Listing channel operations", () => {
  it("preserves replication and automation while hiding private sync facts from an anonymous initial render", () => {
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
    expect(html).toContain("当前无原刊登同步读取权限");
    for (const label of ["多站点复制", "目标语言", "创建站点草稿", "自动化规则", "保存规则"]) expect(html).toContain(label);
    expect(html).not.toContain("保存原同步任务");
  });

  it("does not turn a parent published Feed summary into a verified sync source before the personal workspace GET", () => {
    const html = renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session: syncActor, localDevelopment: false, logout() {} }}><ListingChannelOperations
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
    /></ErpIdentityContext.Provider>);

    expect(html).toContain("正在核对本人原同步依据");
    expect(html).not.toContain("SKU-FEED-1");
    expect(html).not.toContain('value="feed-request"');
    expect(html).toContain("多站点复制"); expect(html).toContain("自动化规则");
  });
});
