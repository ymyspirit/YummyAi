import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HttpMarketplaceAuthorizationGateway,
  MarketplaceAuthorizationError,
} from "./authorization.js";

describe("marketplace authorization gateway", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("builds the Etsy PKCE request with the exact configured redirect URI", () => {
    vi.stubEnv("ETSY_APP_KEYSTRING", "etsy-key");
    vi.stubEnv("ETSY_APP_SHARED_SECRET", "etsy-shared-secret");
    vi.stubEnv("ETSY_OAUTH_REDIRECT_URI", "https://erp.example.test/oauth/etsy");
    const request = new HttpMarketplaceAuthorizationGateway().createAuthorizationRequest({
      platform: "etsy",
      authorizationMode: "etsy_oauth",
      region: "GLOBAL",
      requestedScopes: ["listings_r", "listings_w", "shops_r"],
    }, "state-value-that-is-longer-than-32-characters", "pkce-challenge");
    const url = new URL(request.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://www.etsy.com/oauth/connect");
    expect(url.searchParams.get("redirect_uri")).toBe("https://erp.example.test/oauth/etsy");
    expect(url.searchParams.get("scope")).toBe("listings_r listings_w shops_r");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("pkce-challenge");
  });

  it("builds the regional Amazon draft authorization request", () => {
    vi.stubEnv("AMAZON_SPAPI_APPLICATION_ID", "amzn1.sellerapps.app.test");
    vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_ID", "lwa-client");
    vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_SECRET", "lwa-secret");
    vi.stubEnv("AMAZON_SPAPI_OAUTH_REDIRECT_URI", "https://erp.example.test/oauth/amazon");
    vi.stubEnv("AMAZON_SPAPI_AUTH_BASE_URL_EU", "https://sellercentral.amazon.co.uk");
    vi.stubEnv("AMAZON_SPAPI_APP_DRAFT", "1");
    const request = new HttpMarketplaceAuthorizationGateway().createAuthorizationRequest({
      platform: "amazon",
      authorizationMode: "amazon_public",
      region: "EU",
      requestedScopes: ["product-listing"],
    }, "state-value-that-is-longer-than-32-characters", null);
    const url = new URL(request.authorizationUrl);
    expect(url.origin + url.pathname).toBe("https://sellercentral.amazon.co.uk/apps/authorize/consent");
    expect(url.searchParams.get("application_id")).toBe("amzn1.sellerapps.app.test");
    expect(url.searchParams.get("version")).toBe("beta");
    expect(url.toString()).not.toContain("lwa-secret");
  });

  it("fails closed when OAuth configuration is missing or non-HTTPS", () => {
    vi.stubEnv("ETSY_APP_KEYSTRING", "etsy-key");
    vi.stubEnv("ETSY_APP_SHARED_SECRET", "etsy-shared-secret");
    vi.stubEnv("ETSY_OAUTH_REDIRECT_URI", "http://localhost:3000/oauth/etsy");
    expect(() => new HttpMarketplaceAuthorizationGateway().createAuthorizationRequest({
      platform: "etsy",
      authorizationMode: "etsy_oauth",
      region: "GLOBAL",
      requestedScopes: ["listings_w"],
    }, "state-value-that-is-longer-than-32-characters", "challenge"))
      .toThrow(MarketplaceAuthorizationError);
  });
});
