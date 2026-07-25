import type { MarketplaceAccountView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketplaceAccountDetail, MarketplaceAccountsWorkspace } from "./marketplace-accounts-workspace";

describe("marketplace accounts workspace", () => {
  it("renders an operator-facing store ledger without exposing connection controls", () => {
    const html = renderToStaticMarkup(
      <MarketplaceAccountsWorkspace accounts={[account()]} publications={[]} />,
    );
    for (const label of ["店铺巡检台账", "授权健康", "能力新鲜度", "可发布", "需处理原因"]) expect(html).toContain(label);
    expect(html).toContain("/stores/0198fbef-4a10-7000-8000-000000000810");
    expect(html).not.toContain("同步能力");
    expect(html).not.toContain("refresh-token-value");
    expect(html).not.toContain("client-secret-value");
  });

  it("keeps credentials, capabilities, and quota telemetry in the store detail", () => {
    const html = renderToStaticMarkup(<MarketplaceAccountDetail account={account()} listingCount={2} orderCount={4} publicationCount={3} />);
    for (const label of ["连接", "授权", "能力", "可发布", "概览", "Listings", "订单", "健康与能力", "设置", "listing_write", "同步能力", "9123/10000/日", "2 个", "3 次", "4 个"]) expect(html).toContain(label);
    for (const anchor of ["#store-overview", "#store-listings", "#store-orders", "#store-health", "#store-settings"]) expect(html).toContain(anchor);
    expect(html).not.toContain("refresh-token-value");
    expect(html).not.toContain("buyer@example.test");
  });

  it("keeps the account creation command available in the empty state", () => {
    const html = renderToStaticMarkup(
      <MarketplaceAccountsWorkspace accounts={[]} publications={[]} />,
    );
    expect(html).toContain("新增店铺连接");
    expect(html).toContain("暂无店铺连接");
  });

  it("renders reset-only quota windows without an undefined value", () => {
    const resetOnlyAccount = account();
    resetOnlyAccount.quota = {
      platform: "amazon",
      windows: [{ scope: "operation", resetAt: "2026-07-25T08:00:00.000Z" }],
      observedAt: "2026-07-24T08:00:00.000Z",
    };
    const html = renderToStaticMarkup(
      <MarketplaceAccountDetail account={resetOnlyAccount} listingCount={0} orderCount={0} publicationCount={0} />,
    );
    expect(html).toContain("重置于");
    expect(html).not.toContain("undefined");
  });
});

function account(): MarketplaceAccountView {
  return {
    authorizationMode: "etsy_oauth",
    capabilities: ["listing_read", "listing_write", "media_write", "inventory_write"],
    capabilityExpiresAt: "2026-07-20T00:00:00.000Z",
    quota: {
      platform: "etsy",
      windows: [{ scope: "day", limit: 10_000, remaining: 9_123 }],
      observedAt: "2026-07-19T01:00:00.000Z",
    },
    createdAt: "2026-07-19T00:00:00.000Z",
    credentialStatus: "valid",
    displayName: "Etsy Main",
    externalAccountId: "9001",
    grantedScopes: ["listings_r", "listings_w", "shops_r"],
    hasCredential: true,
    healthStatus: "healthy",
    id: "0198fbef-4a10-7000-8000-000000000810",
    lastCapabilitySyncAt: "2026-07-19T01:00:00.000Z",
    lastErrorCode: null,
    lastHealthAt: "2026-07-19T01:00:00.000Z",
    marketplaceIds: ["etsy"],
    platform: "etsy",
    region: "GLOBAL",
    requestedScopes: ["listings_r", "listings_w", "shops_r"],
    status: "active",
    updatedAt: "2026-07-19T01:00:00.000Z",
  };
}
