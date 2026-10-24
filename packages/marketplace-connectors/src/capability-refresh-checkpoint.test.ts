import { describe, expect, it, vi } from "vitest";
import { HttpMarketplaceCapabilityGateway, type MarketplaceCapabilityHooks } from "./capabilities.js";

const account = { authorizationMode: "etsy_oauth", platform: "etsy", region: "GLOBAL", externalAccountId: null,
  marketplaceIds: ["etsy"], grantedScopes: ["listings_r", "shops_r"] } as const;
const input = { amazonProductTypes: [], etsyTaxonomyNodeIds: [], ttlHours: 24 };
const credential = { refreshToken: "synthetic-original-refresh", userId: "42" };
const environment = { ETSY_APP_KEYSTRING: "synthetic-client", ETSY_APP_SHARED_SECRET: "synthetic-secret" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function fixture(overrides: Partial<MarketplaceCapabilityHooks> = {}, tokenUser = "42") {
  const events: string[] = [];
  const hooks: MarketplaceCapabilityHooks = { beforeCredentialRefresh: async () => { events.push("pending"); },
    checkpointCredential: async (next, expiresAt) => { expect(next.refreshToken).toBe("synthetic-next-refresh");
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now()); events.push("saved"); },
    beforeRead: async () => { events.push("authority"); }, ...overrides };
  const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => {
    if (String(url).endsWith("/public/oauth/token")) { events.push("token"); return json({ access_token: `${tokenUser}.synthetic-access`,
      refresh_token: "synthetic-next-refresh", expires_in: 3600 }); }
    events.push("shop"); return json({}, 503);
  });
  return { gateway: new HttpMarketplaceCapabilityGateway(request as typeof fetch, environment), request, hooks, events };
}

describe("rotating credential recovery", () => {
  it("retains the returned credential before a later shop request fails", async () => {
    const f = fixture();
    await expect(f.gateway.sync(account, credential, input, f.hooks)).rejects.toMatchObject({ code: "upstream_retryable" });
    expect(f.events).toEqual(["pending", "token", "saved", "authority", "shop"]);
  });

  it("keeps the secret checkpoint but sends no later request after authority loss", async () => {
    const f = fixture({ beforeRead: async () => { throw new Error("synthetic-member-revoked"); } });
    await expect(f.gateway.sync(account, credential, input, f.hooks)).rejects.toThrow("synthetic-member-revoked");
    expect(f.events).toEqual(["pending", "token", "saved"]);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("does not send a token request when the durable pending marker was rejected", async () => {
    const f = fixture({ beforeCredentialRefresh: async () => { throw new Error("synthetic-write-failed"); } });
    await expect(f.gateway.sync(account, credential, input, f.hooks)).rejects.toThrow("synthetic-write-failed");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("stops before shop I/O if the credential checkpoint failed", async () => {
    const f = fixture({ checkpointCredential: async () => { throw new Error("synthetic-generation-changed"); } });
    await expect(f.gateway.sync(account, credential, input, f.hooks)).rejects.toThrow("synthetic-generation-changed");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(["pending", "token"]);
  });

  it("never stores a token for a different external identity", async () => {
    const f = fixture({}, "99");
    await expect(f.gateway.sync(account, credential, input, f.hooks)).rejects.toMatchObject({ code: "authorization" });
    expect(f.events).toEqual(["pending", "token"]);
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("checkpoints a valid refresh response even when its refresh token is unchanged", async () => {
    const checkpointCredential = vi.fn(async () => {});
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).endsWith("/public/oauth/token")
      ? json({ access_token: "42.synthetic-access", refresh_token: credential.refreshToken, expires_in: 3600 }) : json({}, 503));
    const gateway = new HttpMarketplaceCapabilityGateway(request as typeof fetch, environment);
    await expect(gateway.sync(account, credential, input, { beforeCredentialRefresh: async () => {}, checkpointCredential,
      beforeRead: async () => {} })).rejects.toMatchObject({ code: "upstream_retryable" });
    expect(checkpointCredential).toHaveBeenCalledExactlyOnceWith(credential, expect.any(Date));
  });
});
