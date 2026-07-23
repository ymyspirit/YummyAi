import type { MarketplaceAccountView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarketplaceAccountsWorkspace } from "./marketplace-accounts-workspace";

describe("marketplace accounts workspace", () => {
  it("renders operational readiness without exposing credential values", () => {
    const html = renderToStaticMarkup(
      <MarketplaceAccountsWorkspace accounts={[account()]} publications={[]} />,
    );
    for (const label of ["连接", "授权", "能力", "可发布", "listing_write"]) expect(html).toContain(label);
    expect(html).toContain("同步能力");
    expect(html).not.toContain("refresh-token-value");
    expect(html).not.toContain("client-secret-value");
  });

  it("keeps the account creation command available in the empty state", () => {
    const html = renderToStaticMarkup(
      <MarketplaceAccountsWorkspace accounts={[]} publications={[]} />,
    );
    expect(html).toContain("新增店铺连接");
    expect(html).toContain("暂无店铺连接");
  });
});

function account(): MarketplaceAccountView {
  return {
    authorizationMode: "etsy_oauth",
    capabilities: ["listing_read", "listing_write", "media_write", "inventory_write"],
    capabilityExpiresAt: "2026-07-20T00:00:00.000Z",
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
