import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpMarketplaceCapabilityGateway } from "./capabilities.js";
import { createStoreNodeCapabilityTransport } from "./store-node-capability-transport.js";
import type { StoreNodeExecutionCredential } from "@yummyai/contracts/marketplace/store-node-execution";
import { storeNodeAmazonGatewayEnvironment } from "./store-node-amazon-application.js";

const input = { amazonProductTypes: [], etsyTaxonomyNodeIds: [], ttlHours: 24 };
const json = (raw: unknown) => new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } });
describe("node capability HTTPS policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("runs the original Etsy parser through only its fixed operation allowlist", async () => {
    const clientId = "synthetic-client", events: string[] = [];
    const seed: StoreNodeExecutionCredential = { account: { authorizationMode: "etsy_oauth", platform: "etsy", region: "GLOBAL", externalAccountId: null,
      grantedScopes: ["shops_r"], marketplaceIds: ["etsy"] }, credential: { userId: "42", refreshToken: "synthetic-old" },
      etsyAppKeySha256: createHash("sha256").update(clientId).digest("hex") };
    const transport = createStoreNodeCapabilityTransport({ seed, input, exchange: async (call, send) => { events.push(call.requestClass); return send(); },
      request: vi.fn(async (url, init) => {
        expect(init?.redirect).toBe("error");
        if (String(url).includes("/oauth/token")) return json({ access_token: "42.synthetic-access", refresh_token: "synthetic-new", expires_in: 3600 });
        if (String(url).endsWith("/users/42/shops")) return json({ user_id: 42, shop_id: 10, shop_name: "Synthetic shop" });
        return json({ count: 0, results: [] });
      }) as typeof fetch });
    const result = await new HttpMarketplaceCapabilityGateway(transport, { ETSY_APP_KEYSTRING: clientId, ETSY_APP_SHARED_SECRET: "synthetic-secret" }).sync(seed.account, seed.credential, input,
      { beforeCredentialRefresh: async () => {}, checkpointCredential: async () => { events.push("checkpoint"); }, beforeRead: async () => {} });
    expect(result.externalAccountId).toBe("10"); expect(events.slice(0, 3)).toEqual(["etsy_refresh", "checkpoint", "etsy_shop"]); expect(events).toHaveLength(8);
    await expect(transport("https://openapi.etsy.com/v3/application/shops/999/receipts")).rejects.toMatchObject({ code: "store_node_policy_rejected" });
  });
  it("rejects arbitrary Amazon storage URLs and forwards no secret to exact derived documents", async () => {
    const seed: StoreNodeExecutionCredential = { account: { authorizationMode: "amazon_private", platform: "amazon", region: "NA", externalAccountId: "synthetic-seller",
      grantedScopes: ["product-listing"], marketplaceIds: ["synthetic-market"] }, credential: { sellingPartnerId: "synthetic-seller", refreshToken: "synthetic-refresh", clientId: "synthetic-client", clientSecret: "synthetic-secret" }, etsyAppKeySha256: null };
    const request = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url).startsWith("https://api.amazon.com/")) return json({ access_token: "synthetic-access", expires_in: 3600 });
      if (String(url).includes("marketplaceParticipations")) return json({ payload: [{ marketplace: { id: "synthetic-market" }, participation: { isParticipating: true, hasSuspendedListings: false } }] });
      if (String(url).includes("/productTypes/")) return json({ metaSchema: { link: { resource: "https://synthetic-doc.s3.amazonaws.com/meta?signature=synthetic", checksum: "native-meta" } },
        schema: { link: { resource: "https://synthetic-doc.s3.amazonaws.com/schema?signature=synthetic", checksum: "native-schema" } }, marketplaceIds: ["synthetic-market"], productType: "HOME", productTypeVersion: { version: "1" } });
      expect(new Headers(init?.headers).has("x-amz-access-token")).toBe(false); return json({ type: "object" });
    });
    const values = { ...input, amazonProductTypes: ["HOME"] };
    const transport = createStoreNodeCapabilityTransport({ seed, input: values, exchange: async (_call, send) => send(), request: request as typeof fetch });
    await expect(transport("https://unregistered.s3.amazonaws.com/private")).rejects.toMatchObject({ code: "store_node_policy_rejected" }); expect(request).not.toHaveBeenCalled();
    const result = await new HttpMarketplaceCapabilityGateway(transport, {}).sync(seed.account, seed.credential, values);
    expect(result.externalAccountId).toBe("synthetic-seller"); expect(request).toHaveBeenCalledTimes(5);
    await expect(transport("https://synthetic-doc.s3.amazonaws.com/other?signature=synthetic")).rejects.toMatchObject({ code: "store_node_policy_rejected" });
  });

  it("uses the original public Amazon capability parser with only the pinned node application secret", async () => {
    const amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-node-only-secret" };
    vi.stubEnv("AMAZON_SPAPI_LWA_CLIENT_SECRET", "synthetic-central-secret-must-not-be-used");
    const seed = publicSeed(amazonApplication.clientId), classes: string[] = [];
    const request = vi.fn(async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(raw) === "https://api.amazon.com/auth/o2/token") {
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ grant_type: "refresh_token", refresh_token: seed.credential.refreshToken,
          client_id: amazonApplication.clientId, client_secret: amazonApplication.clientSecret });
        return json({ access_token: "synthetic-public-access", expires_in: 3600 });
      }
      expect(String(raw)).toBe("https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations");
      return json({ payload: [{ marketplace: { id: "synthetic-market" }, participation: { isParticipating: true, hasSuspendedListings: false } }] });
    });
    const transport = createStoreNodeCapabilityTransport({ seed, input, amazonApplication, request: request as typeof fetch,
      exchange: async (call, send) => { classes.push(call.requestClass); return send(); } });
    const result = await new HttpMarketplaceCapabilityGateway(transport, storeNodeAmazonGatewayEnvironment(seed, amazonApplication)).sync(seed.account, seed.credential, input);
    expect(result.externalAccountId).toBe("synthetic-seller"); expect(classes).toEqual(["amazon_lwa", "amazon_participations"]);
    expect(request).toHaveBeenCalledTimes(2); expect(JSON.stringify(result)).not.toContain(amazonApplication.clientSecret);
    await expect(transport("https://api.amazon.com/auth/o2/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token",
      refresh_token: seed.credential.refreshToken!, client_id: amazonApplication.clientId, client_secret: "synthetic-central-secret-must-not-be-used" }) }))
      .rejects.toMatchObject({ code: "store_node_policy_rejected" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects unpinned public credentials and missing or mismatched local applications before a permit or HTTP", () => {
    const amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-local-secret" }, seed = publicSeed(amazonApplication.clientId);
    const request = vi.fn(), exchange = vi.fn();
    for (const changed of [{ ...seed, amazonAppClientIdSha256: undefined }, { ...seed, credential: { ...seed.credential, clientId: "" } },
      { ...seed, amazonAppClientIdSha256: "a".repeat(64) }, { ...seed, credential: { ...seed.credential, kind: "amazon_private" } }])
      expect(() => createStoreNodeCapabilityTransport({ seed: changed, input, amazonApplication, request, exchange }))
        .toThrow("store_node_application_reauthorization_required");
    for (const local of [null, { ...amazonApplication, clientId: "synthetic-other-application" }])
      expect(() => createStoreNodeCapabilityTransport({ seed, input, amazonApplication: local, request, exchange })).toThrow("store_node_configuration_invalid");
    expect(request).not.toHaveBeenCalled(); expect(exchange).not.toHaveBeenCalled();
  });
});

function publicSeed(clientId: string): StoreNodeExecutionCredential {
  return { account: { authorizationMode: "amazon_public", platform: "amazon", region: "NA", externalAccountId: "synthetic-seller",
    grantedScopes: ["product-listing"], marketplaceIds: ["synthetic-market"] },
    credential: { kind: "amazon_public", clientId, sellingPartnerId: "synthetic-seller", refreshToken: "synthetic-public-refresh" },
    etsyAppKeySha256: null, amazonAppClientIdSha256: createHash("sha256").update(clientId).digest("hex") };
}
