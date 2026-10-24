import type { MarketplaceAccountView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PublicationPanel } from "./publication-panel";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./marketplace-actions", () => ({
  cancelMarketplacePublication: vi.fn(),
  continueMarketplacePublication: vi.fn(),
  createMarketplacePublication: vi.fn(),
}));
const first = account("0198fbef-4a10-7000-8000-000000000920", ["ATVPDKIKX0DER"]);
const target = account("0198fbef-4a10-7000-8000-000000000921", ["ATVPDKIKX0DER", "A1F83G8C2ARO7P"]);
const listing = {
  id: "0198fbef-4a10-7000-8000-000000000910",
  versionId: "0198fbef-4a10-7000-8000-000000000911",
  platform: "etsy" as const,
  status: "approved" as const,
  validationBlockers: 0,
  variants: [],
};
describe("sales plan publication handoff", () => {
  it("preserves the operator's target account and site instead of the first account", () => {
    const html = renderToStaticMarkup(
      <PublicationPanel
        accounts={[first, target]}
        initialAccountId={target.id}
        initialMarketplaceId="A1F83G8C2ARO7P"
        listing={listing}
        publications={[]}
      />,
    );
    expect(html).toContain(`value="${target.id}" selected=""`);
    expect(html).toContain('value="A1F83G8C2ARO7P" selected=""');
    expect(html).not.toContain(`value="${first.id}" selected=""`);
  });
  it("does not silently use another store when the requested account is unavailable", () => {
    const html = renderToStaticMarkup(
      <PublicationPanel
        accounts={[first]}
        initialAccountId={target.id}
        listing={listing}
        publications={[]}
      />,
    );
    expect(html).toContain("销售方案所选店铺当前不可用");
    expect(html).not.toContain(`value="${first.id}" selected=""`);
    expect(html).toContain('value="" selected=""');
  });
  it("requires a site choice when the requested marketplace is not authorized", () => {
    const html = renderToStaticMarkup(
      <PublicationPanel
        accounts={[first]}
        initialAccountId={first.id}
        initialMarketplaceId="A1F83G8C2ARO7P"
        listing={listing}
        publications={[]}
      />,
    );
    expect(html).not.toContain('value="ATVPDKIKX0DER" selected=""');
    expect(html).toContain('value="" selected=""');
  });
});
function account(id: string, marketplaceIds: string[]): MarketplaceAccountView {
  return {
    id,
    displayName: id,
    platform: "etsy",
    status: "active",
    authorizationMode: "amazon_private",
    capabilities: ["listing_read", "listing_write"],
    capabilityExpiresAt: "2099-07-26T00:00:00.000Z",
    quota: null,
    createdAt: "2026-10-07T00:00:00.000Z",
    credentialStatus: "valid",
    externalAccountId: "SYNTHETIC",
    grantedScopes: ["product-listing"],
    hasCredential: true,
    healthStatus: "healthy",
    lastCapabilitySyncAt: "2026-10-07T00:00:00.000Z",
    lastErrorCode: null,
    lastHealthAt: "2026-10-07T00:00:00.000Z",
    marketplaceIds,
    region: "NA",
    requestedScopes: ["product-listing"],
    updatedAt: "2026-10-07T00:00:00.000Z",
  };
}
