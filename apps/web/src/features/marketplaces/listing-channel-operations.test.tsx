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
});
