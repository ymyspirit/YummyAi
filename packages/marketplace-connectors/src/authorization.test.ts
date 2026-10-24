import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HttpMarketplaceAuthorizationGateway,
  MarketplaceAuthorizationError,
} from "./authorization.js";

describe("marketplace authorization gateway", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

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

  it("pins the exact public application client sent during code exchange without storing its secret", async () => {
    vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_ID", "synthetic-original-public-client");
    vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_SECRET", "synthetic-central-application-secret");
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.amazon.com/auth/o2/token");
      expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: "authorization_code", code: "synthetic-single-use-code",
        redirect_uri: "https://erp.example.test/callback", client_id: "synthetic-original-public-client", client_secret: "synthetic-central-application-secret" });
      vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_ID", "synthetic-config-changed-during-response");
      return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "bearer" });
    });
    vi.stubGlobal("fetch", request);
    const result = await new HttpMarketplaceAuthorizationGateway().exchangeAuthorizationCode({ platform: "amazon", authorizationMode: "amazon_public",
      region: "NA", requestedScopes: ["product-listing"] }, { code: "synthetic-single-use-code", pkceVerifier: null,
      redirectUri: "https://erp.example.test/callback", sellingPartnerId: "synthetic-seller" });
    expect(result.credential).toEqual({ kind: "amazon_public", clientId: "synthetic-original-public-client", refreshToken: "synthetic-refresh", sellingPartnerId: "synthetic-seller" });
    expect(JSON.stringify(result)).not.toContain("synthetic-central-application-secret");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
