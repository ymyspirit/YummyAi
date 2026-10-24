import { describe, expect, it } from "vitest";
import { marketplaceOAuthAuthorizationUrl } from "./marketplace-lifecycle";
import { MARKETPLACE_OAUTH_COOKIE_PREFIX, marketplaceOAuthCookieName, marketplaceOAuthPendingStateDigest,
  marketplaceOAuthStateDigest, parseMarketplaceOAuthCallback, readMarketplaceOAuthBinding } from "./marketplace-oauth";

const state = "s".repeat(43), otherState = "t".repeat(43);
const etsy = `https://www.etsy.com/oauth/connect?state=${state}&client_id=synthetic-public-client`;
const callback = (query: string) => new URL(`https://erp.example.test/stores/oauth/callback?state=${state}&${query}`);

describe("marketplace lifecycle OAuth input boundaries", () => {
  it("accepts native HTTPS authorization endpoints and rejects unsafe targets or duplicate parameters", () => {
    expect(marketplaceOAuthAuthorizationUrl(etsy, "etsy").state).toBe(state);
    expect(marketplaceOAuthAuthorizationUrl(`https://sellercentral.amazon.com/apps/authorize/consent?state=${state}`, "amazon").state).toBe(state);
    const unsafe = [etsy.replace("https:", "http:"), etsy.replace("www.etsy.com", "www.etsy.com.untrusted.test"),
      etsy.replace("www.etsy.com", "synthetic@www.etsy.com"), `${etsy}#fragment`, etsy.replace("/oauth/connect", "/other"),
      `${etsy}&state=${otherState}`, `${etsy}&client_id=second-client`, etsy.replace(`state=${state}`, "state=too-short"),
      etsy.replace("www.etsy.com", "www.etsy.com:444")];
    for (const target of unsafe) expect(() => marketplaceOAuthAuthorizationUrl(target, "etsy")).toThrow();
    expect(() => marketplaceOAuthAuthorizationUrl(etsy, "amazon")).toThrow();
  });

  it("rejects duplicate or caller-selected callback identity and ambiguous code aliases without echoing provider errors", () => {
    expect(parseMarketplaceOAuthCallback(callback("code=synthetic-etsy-code"))).toEqual({ state, code: "synthetic-etsy-code", sellingPartnerId: undefined, error: false });
    expect(parseMarketplaceOAuthCallback(callback("spapi_oauth_code=synthetic-amazon-code&selling_partner_id=synthetic-seller")))
      .toEqual({ state, code: "synthetic-amazon-code", sellingPartnerId: "synthetic-seller", error: false });
    expect(parseMarketplaceOAuthCallback(callback("error=access_denied&error_description=synthetic-private-detail")))
      .toEqual({ state, code: null, sellingPartnerId: undefined, error: true });
    for (const query of ["code=first&code=second", "code=first&spapi_oauth_code=second", `code=first&state=${otherState}`,
      "code=first&accountId=019f0000-0000-7000-8000-000000000001", "code=first&selling_partner_id=one&selling_partner_id=two",
      "error=access_denied&code=first", "error=one&error=two", "code="])
      expect(() => parseMarketplaceOAuthCallback(callback(query))).toThrow();
  });

  it("keeps concurrent OAuth cookies separate and preserves the exact hex and base64url state digests", () => {
    const hex = "d64b93c9f1b60eb338e5cb415d6a36bd920edd0e9b36f7ea5c730d0e10ff147f";
    expect(marketplaceOAuthStateDigest(state)).toBe(hex);
    expect(marketplaceOAuthPendingStateDigest(state)).toBe("1kuTyfG2DrM45ctBXWo2vZIO3Q6bNvfqXHMNDhD_FH8");
    expect(marketplaceOAuthCookieName(state)).toBe(MARKETPLACE_OAUTH_COOKIE_PREFIX + hex);
    expect(marketplaceOAuthCookieName(otherState)).not.toBe(marketplaceOAuthCookieName(state));
    const binding = { version: 1, accountId: "019f0000-0000-7000-8000-000000000001", actorId: "019f0000-0000-7000-8000-000000000002",
      tenantId: "019f0000-0000-7000-8000-000000000003", platform: "etsy", stateDigest: hex, authority: "a".repeat(64),
      authorizationGeneration: "019f0000-0000-7000-8000-000000000004", expiresAt: "2026-10-22T08:00:00.000Z" };
    expect(readMarketplaceOAuthBinding(JSON.stringify(binding))).toEqual(binding);
    expect(readMarketplaceOAuthBinding(JSON.stringify({ ...binding, code: "synthetic-private-code" }))).toBeNull();
    expect(readMarketplaceOAuthBinding(JSON.stringify({ ...binding, stateDigest: state }))).toBeNull();
  });
});
