import { describe, expect, it, vi } from "vitest";

import type { MarketplaceConnectorError } from "./errors.js";
import { HttpMarketplaceCapabilityGateway } from "./capabilities.js";

describe("marketplace capability gateway", () => {
  it("syncs Amazon participations and product schemas without retaining signed links", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.amazon.com/auth/o2/token") {
        return json({ access_token: "amazon-access-secret", expires_in: 3600 });
      }
      if (url.endsWith("/sellers/v1/marketplaceParticipations")) {
        expect(new Headers(init?.headers).get("x-amz-access-token")).toBe("amazon-access-secret");
        return json({ payload: [{
          marketplace: { id: "ATVPDKIKX0DER", name: "US" },
          participation: { isParticipating: true, hasSuspendedListings: false },
        }] });
      }
      if (url.includes("/definitions/2020-09-01/productTypes/HOME")) {
        const parsed = new URL(url);
        expect(parsed.searchParams.get("sellerId")).toBe("A1SELLER");
        return json({
          metaSchema: { link: { resource: "https://s3.amazonaws.com/yummy-test/meta?X-Amz-Signature=temporary", checksum: "meta-check" } },
          schema: { link: { resource: "https://s3.amazonaws.com/yummy-test/schema?X-Amz-Signature=temporary", checksum: "schema-check" } },
          marketplaceIds: ["ATVPDKIKX0DER"],
          productType: "HOME",
          productTypeVersion: { version: "v-home-1", latest: true },
          requirements: "LISTING",
          requirementsEnforced: "ENFORCED",
        });
      }
      if (url.includes("/yummy-test/meta")) return json({ $schema: "amazon-meta", properties: {} });
      if (url.includes("/yummy-test/schema")) return json({ $schema: "product-schema", required: ["item_name"] });
      throw new Error(`Unexpected URL: ${url}`);
    });
    const gateway = new HttpMarketplaceCapabilityGateway(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    });
    const result = await gateway.sync({
      authorizationMode: "amazon_private",
      externalAccountId: "A1SELLER",
      grantedScopes: ["product-listing"],
      marketplaceIds: ["ATVPDKIKX0DER"],
      platform: "amazon",
      region: "NA",
    }, {
      kind: "amazon_private",
      clientId: "lwa-client",
      clientSecret: "lwa-secret",
      refreshToken: "amazon-refresh-secret",
      sellingPartnerId: "A1SELLER",
    }, {
      amazonProductTypes: ["HOME"],
      etsyTaxonomyNodeIds: [],
      ttlHours: 24,
    });
    expect(result).toMatchObject({ externalAccountId: "A1SELLER", healthStatus: "healthy" });
    expect(result.capabilities).toContain("listing_write");
    expect(JSON.stringify(result.data)).not.toMatch(/X-Amz-Signature|amazon-access-secret|amazon-refresh-secret/);
    expect(result.data.productDefinitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ productType: "HOME", productTypeVersion: "v-home-1", schemaChecksum: "schema-check" }),
    ]));
  });

  it("degrades Amazon listing capabilities when a configured marketplace is suspended", async () => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth/o2/token")) return json({ access_token: "access", expires_in: 3600 });
      return json({ payload: [{
        marketplace: { id: "ATVPDKIKX0DER" },
        participation: { isParticipating: true, hasSuspendedListings: true },
      }] });
    });
    const result = await new HttpMarketplaceCapabilityGateway(request as typeof fetch, {
      AMAZON_SPAPI_ENDPOINT_NA: "https://spapi.example.test",
    }).sync({
      authorizationMode: "amazon_private",
      externalAccountId: "A1SELLER",
      grantedScopes: ["product-listing"],
      marketplaceIds: ["ATVPDKIKX0DER"],
      platform: "amazon",
      region: "NA",
    }, {
      kind: "amazon_private",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      sellingPartnerId: "A1SELLER",
    }, { amazonProductTypes: [], etsyTaxonomyNodeIds: [], ttlHours: 24 });
    expect(result.healthStatus).toBe("degraded");
    expect(result.capabilities).not.toContain("listing_write");
    expect(result.issues).toEqual([expect.objectContaining({ code: "MARKETPLACE_SUSPENDED", severity: "blocker" })]);
  });

  it("syncs Etsy shop configuration and returns a rotated refresh grant", async () => {
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return json({ access_token: "12345.access-secret", refresh_token: "12345.rotated-refresh", expires_in: 3600 });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("etsy-key:etsy-shared");
      expect(headers.get("authorization")).toBe("Bearer 12345.access-secret");
      if (url.endsWith("/users/12345/shops")) return json({ shop_id: 9001, user_id: 12345, shop_name: "Yummy Shop" });
      if (url.endsWith("/seller-taxonomy/nodes/42/properties")) return json({ count: 1, results: [{ property_id: 1 }] });
      return json({ count: 1, results: [{ id: url.split("/").at(-1) }] });
    });
    const result = await new HttpMarketplaceCapabilityGateway(request as typeof fetch, {
      ETSY_APP_KEYSTRING: "etsy-key",
      ETSY_APP_SHARED_SECRET: "etsy-shared",
    }).sync({
      authorizationMode: "etsy_oauth",
      externalAccountId: "12345",
      grantedScopes: ["listings_r", "listings_w", "shops_r"],
      marketplaceIds: ["etsy"],
      platform: "etsy",
      region: "GLOBAL",
    }, {
      kind: "etsy_oauth",
      refreshToken: "12345.old-refresh",
      userId: "12345",
    }, { amazonProductTypes: [], etsyTaxonomyNodeIds: [42], ttlHours: 12 });
    expect(result).toMatchObject({ externalAccountId: "9001", healthStatus: "healthy", sourceVersion: "etsy-open-api-v3" });
    expect(result.capabilities).toEqual(expect.arrayContaining(["shop_read", "shipping_profile_read", "listing_write"]));
    expect(result.refreshedCredential).toMatchObject({ refreshToken: "12345.rotated-refresh", userId: "12345" });
    expect(JSON.stringify(result.data)).not.toMatch(/access-secret|rotated-refresh|etsy-shared/);
  });

  it("normalizes rate limits with retry timing", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
    const promise = new HttpMarketplaceCapabilityGateway(request as typeof fetch).sync({
      authorizationMode: "amazon_private",
      externalAccountId: "A1SELLER",
      grantedScopes: [],
      marketplaceIds: ["ATVPDKIKX0DER"],
      platform: "amazon",
      region: "NA",
    }, {
      kind: "amazon_private",
      clientId: "client",
      clientSecret: "secret",
      refreshToken: "refresh",
      sellingPartnerId: "A1SELLER",
    }, { amazonProductTypes: [], etsyTaxonomyNodeIds: [], ttlHours: 24 });
    await expect(promise).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 2_000,
      retryable: true,
    } satisfies Partial<MarketplaceConnectorError>);
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
