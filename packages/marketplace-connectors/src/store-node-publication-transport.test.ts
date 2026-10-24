import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PUBLICATION_OPERATION, publicationPreviewPayloadText, publicationPreviewRequestText } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_EXECUTION_PROTOCOL, STORE_NODE_EXECUTION_RESULT_BYTES, type StoreNodeExecutionCredential,
  type StoreNodePublicationLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { describe, expect, it, vi } from "vitest";
import { HttpMarketplaceDraftGateway } from "./publication.js";
import { assertStoreNodePublicationLease, createStoreNodePublicationTransport } from "./store-node-publication-transport.js";
import type { StoreNodeCapabilityExchange } from "./store-node-capability-transport.js";
import { storeNodeAmazonGatewayEnvironment } from "./store-node-amazon-application.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", ...headers } });
function fixture() {
  const seed = { account: { platform: "amazon", authorizationMode: "amazon_private", region: "NA",
    externalAccountId: "SYNTHETIC-SELLER", grantedScopes: ["product-listing"], marketplaceIds: ["ATVPDKIKX0DER"] },
    credential: { sellingPartnerId: "SYNTHETIC-SELLER", clientId: "synthetic-client", clientSecret: "synthetic-client-secret", refreshToken: "synthetic-refresh-token" }, etsyAppKeySha256: null } satisfies StoreNodeExecutionCredential;
  const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU /中文",
    attributes: { item_name: [{ value: "Synthetic pillow" }], z: null, A: ["固定原字段"] } };
  const target = { accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(), marketplaceId: payload.marketplaceId,
    variantSkuId: createEntityId(), capabilitySnapshotId: createEntityId(), payloadChecksum: sha(publicationPreviewPayloadText(payload)),
    assetManifestChecksum: "a".repeat(64), nodeId: createEntityId(), certificateGeneration: 1, authorizationGeneration: createEntityId(), bindingRevision: 2 };
  const lease: StoreNodePublicationLease = { protocol: STORE_NODE_EXECUTION_PROTOCOL, id: createEntityId(), accountId: target.accountId,
    requestId: createEntityId(), requestChecksum: sha(publicationPreviewRequestText(target)), operation: STORE_NODE_PUBLICATION_OPERATION,
    claimId: createEntityId(), sessionId: createEntityId(), credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 3,
    nodeId: target.nodeId, certificateGeneration: 1, authorizationGeneration: target.authorizationGeneration, bindingRevision: 2,
    expiresAt: "2026-12-01T00:00:00.000Z", runExpiresAt: "2026-12-01T00:00:00.000Z",
    sealedCredential: { nonce: "A".repeat(16), tag: "A".repeat(22), ciphertext: "AQ", wrappedKey: "A".repeat(512) },
    input: { publicationRequestId: createEntityId(), target, payload } };
  return { seed, lease };
}
function tokenInit(seed: StoreNodeExecutionCredential): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: seed.credential.refreshToken!, client_id: seed.credential.clientId!, client_secret: seed.credential.clientSecret! }) };
}
function preview(lease: StoreNodePublicationLease) {
  const { payload } = lease.input;
  const url = new URL(`https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SYNTHETIC-SELLER/${encodeURIComponent(payload.sku)}`);
  url.search = new URLSearchParams({ marketplaceIds: payload.marketplaceId, issueLocale: "en_US", mode: "VALIDATION_PREVIEW" }).toString();
  return { url, init: { method: "PUT", headers: { "content-type": "application/json", "user-agent": "YummyAI/0.1 (Language=TypeScript)",
    "x-amz-access-token": "synthetic-access-token", "x-amz-date": "20261022T000000Z" },
    body: JSON.stringify({ productType: payload.productType, requirements: "LISTING", attributes: payload.attributes }) } satisfies RequestInit };
}

describe("store node original Amazon validation preview HTTPS policy", () => {
  it("uses the original parser with exactly LWA and the pinned preview PUT, including original quota", async () => {
    const { seed, lease } = fixture(), calls: string[] = [], observed: string[] = [];
    const request = vi.fn(async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (String(raw) === "https://api.amazon.com/auth/o2/token") return json({ access_token: "synthetic-access-token", expires_in: 3600 });
      const expected = preview(lease); expect(String(raw)).toBe(expected.url.href); expect(init?.method).toBe("PUT"); expect(init?.body).toBe(expected.init.body);
      return json({ sku: lease.input.payload.sku, status: "INVALID", submissionId: "synthetic-submission",
        issues: [{ code: "90220", message: "Brand is required", severity: "ERROR", attributeNames: ["brand"] }] }, { "x-amzn-ratelimit-limit": "5.5" });
    });
    const transport = createStoreNodePublicationTransport({ seed, lease, request: request as typeof fetch, observeSecret: value => observed.push(value),
      exchange: async (call, send) => { calls.push(call.requestClass); expect(call.requestDigest).toMatch(/^[a-f0-9]{64}$/); return send(); } });
    const result = await new HttpMarketplaceDraftGateway(transport, {}).create(seed.account, seed.credential, lease.input.payload);
    expect(result).toMatchObject({ status: "validation_failed", issues: [{ severity: "blocker", path: "brand" }], quota: { windows: [{ limit: 5.5 }] } });
    expect(result.externalListingId).toBeUndefined(); expect(calls).toEqual(["amazon_lwa", "amazon_listing_validation_preview"]);
    expect(observed).toEqual(["synthetic-access-token"]); expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects altered original target, payload and lease pins before acquiring any permit", () => {
    const { seed, lease } = fixture();
    const variants = [
      { ...lease, requestChecksum: "0".repeat(64) },
      { ...lease, accountId: createEntityId() }, { ...lease, certificateGeneration: 2 },
      { ...lease, input: { ...lease.input, payload: { ...lease.input.payload, attributes: { unapproved: true } } } },
      { ...lease, input: { ...lease.input, target: { ...lease.input.target, bindingRevision: 3 } } },
    ];
    for (const altered of variants) expect(() => createStoreNodePublicationTransport({ seed, lease: altered, exchange: async (_call, send) => send() })).toThrow("store_node_policy_rejected");
    expect(() => createStoreNodePublicationTransport({ seed: { ...seed, account: { ...seed.account, externalAccountId: "OTHER-SELLER" } }, lease,
      exchange: async (_call, send) => send() })).toThrow("store_node_policy_rejected");
  });

  it("rejects live submissions, foreign objects, changed bodies and extra query or credential headers without I/O", async () => {
    const { seed, lease } = fixture(), request = vi.fn(async () => json({ access_token: "synthetic-access-token", expires_in: 3600 }));
    const exchange = vi.fn(async (_call: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>) => send());
    const transport = createStoreNodePublicationTransport({ seed, lease, request: request as typeof fetch, exchange });
    await transport("https://api.amazon.com/auth/o2/token", tokenInit(seed));
    const good = preview(lease), cases: Array<[string | URL, RequestInit]> = [
      [good.url.href.replace("VALIDATION_PREVIEW", "LIVE"), good.init],
      [good.url.href.replace("SYNTHETIC-SELLER", "OTHER-SELLER"), good.init],
      [good.url.href.replace("sellingpartnerapi-na", "sellingpartnerapi-eu"), good.init],
      [`${good.url.href}&marketplaceIds=OTHER`, good.init], [good.url.href.replace("en_US", "en_GB"), good.init],
      [good.url, { ...good.init, method: "PATCH" }], [good.url, { ...good.init, body: String(good.init.body).replace("LISTING", "LISTING_PRODUCT_ONLY") }],
      [good.url, { ...good.init, headers: { ...good.init.headers, authorization: "synthetic-forbidden-header" } }],
      [good.url.href.replace("https:", "http:"), good.init], ["https://unregistered.s3.amazonaws.com/document", {}],
    ];
    for (const [url, init] of cases) await expect(transport(url, init)).rejects.toMatchObject({ code: "store_node_policy_rejected" });
    expect(request).toHaveBeenCalledTimes(1); expect(exchange).toHaveBeenCalledTimes(1);
  });

  it("replays original received HTTP responses through the same digests without resubmitting on restart", async () => {
    const { seed, lease } = fixture(), cache = new Map<string, Response>();
    const firstRequest = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).startsWith("https://api.amazon.com/")
      ? json({ access_token: "synthetic-access-token", expires_in: 3600 }) : json({ sku: lease.input.payload.sku, status: "ACCEPTED", submissionId: "synthetic-original", issues: [] }));
    const first = createStoreNodePublicationTransport({ seed, lease, request: firstRequest as typeof fetch,
      exchange: async (call, send) => { const response = await send(); cache.set(call.requestDigest, response.clone()); return response; } });
    await new HttpMarketplaceDraftGateway(first, {}).create(seed.account, seed.credential, lease.input.payload);
    const secondRequest = vi.fn(async () => { throw new Error("unexpected synthetic resubmission"); });
    const second = createStoreNodePublicationTransport({ seed, lease, request: secondRequest as typeof fetch,
      exchange: async call => { const cached = cache.get(call.requestDigest); expect(cached).toBeDefined(); if (!cached) throw new Error("missing synthetic response"); return cached.clone(); } });
    await expect(new HttpMarketplaceDraftGateway(second, {}).create(seed.account, seed.credential, lease.input.payload))
      .resolves.toMatchObject({ status: "validation_passed", externalSubmissionId: "synthetic-original" });
    expect(firstRequest).toHaveBeenCalledTimes(2); expect(secondRequest).not.toHaveBeenCalled(); expect(cache.size).toBe(2);
  });

  it("releases an oversized response before the original gateway can consume its body", async () => {
    const { seed, lease } = fixture(), cancel = vi.fn();
    const transport = createStoreNodePublicationTransport({ seed, lease, exchange: async (_call, send) => send(), request: vi.fn(async () =>
      new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(STORE_NODE_EXECUTION_RESULT_BYTES + 1) } })) as typeof fetch });
    await expect(transport("https://api.amazon.com/auth/o2/token", tokenInit(seed))).rejects.toMatchObject({ code: "store_node_result_too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("runs the public application through the same exact preview PUT and replays its original received responses", async () => {
    const { seed: privateSeed, lease } = fixture(), amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-public-node-secret" };
    const seed: StoreNodeExecutionCredential = { ...privateSeed, account: { ...privateSeed.account, authorizationMode: "amazon_public" },
      credential: { kind: "amazon_public", clientId: amazonApplication.clientId, refreshToken: privateSeed.credential.refreshToken!, sellingPartnerId: privateSeed.credential.sellingPartnerId! },
      amazonAppClientIdSha256: sha(amazonApplication.clientId) };
    const responses = new Map<string, Response>(), request = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) === "https://api.amazon.com/auth/o2/token") {
        expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(amazonApplication.clientSecret);
        return json({ access_token: "synthetic-access-token", expires_in: 3600 });
      }
      expect(String(url)).toBe(preview(lease).url.href); expect(init?.body).toBe(preview(lease).init.body);
      return json({ sku: lease.input.payload.sku, status: "ACCEPTED", submissionId: "synthetic-public-submission", issues: [] });
    });
    const first = createStoreNodePublicationTransport({ seed, lease, amazonApplication, request: request as typeof fetch,
      exchange: async (call, send) => { const response = await send(); responses.set(call.requestDigest, response.clone()); return response; } });
    await expect(new HttpMarketplaceDraftGateway(first, storeNodeAmazonGatewayEnvironment(seed, amazonApplication)).create({ ...seed.account, externalAccountId: "SYNTHETIC-SELLER" }, seed.credential, lease.input.payload))
      .resolves.toMatchObject({ status: "validation_passed", externalSubmissionId: "synthetic-public-submission" });
    const noResend = vi.fn(), second = createStoreNodePublicationTransport({ seed, lease, amazonApplication, request: noResend,
      exchange: async call => { const response = responses.get(call.requestDigest); if (!response) throw new Error("missing synthetic public receipt"); return response.clone(); } });
    await expect(new HttpMarketplaceDraftGateway(second, storeNodeAmazonGatewayEnvironment(seed, amazonApplication)).create({ ...seed.account, externalAccountId: "SYNTHETIC-SELLER" }, seed.credential, lease.input.payload))
      .resolves.toMatchObject({ status: "validation_passed", externalSubmissionId: "synthetic-public-submission" });
    expect(request).toHaveBeenCalledTimes(2); expect(noResend).not.toHaveBeenCalled(); expect(responses.size).toBe(2);
    expect(seed.credential).not.toHaveProperty("clientSecret");
  });

  it("checks public application availability separately from immutable preview lease validity", () => {
    const { seed: privateSeed, lease } = fixture(), amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-public-node-secret" };
    const seed: StoreNodeExecutionCredential = { ...privateSeed, account: { ...privateSeed.account, authorizationMode: "amazon_public" },
      credential: { kind: "amazon_public", clientId: amazonApplication.clientId, refreshToken: privateSeed.credential.refreshToken!, sellingPartnerId: privateSeed.credential.sellingPartnerId! },
      amazonAppClientIdSha256: sha(amazonApplication.clientId) };
    const exchange = vi.fn(), request = vi.fn();
    expect(() => assertStoreNodePublicationLease(lease, seed)).not.toThrow();
    expect(() => createStoreNodePublicationTransport({ seed, lease, exchange, request })).toThrow("store_node_configuration_invalid");
    expect(() => createStoreNodePublicationTransport({ seed, lease, amazonApplication: { ...amazonApplication, clientId: "wrong" }, exchange, request }))
      .toThrow("store_node_configuration_invalid");
    expect(() => createStoreNodePublicationTransport({ seed: { ...seed, amazonAppClientIdSha256: "b".repeat(64) }, lease, amazonApplication, exchange, request }))
      .toThrow("store_node_application_reauthorization_required");
    expect(exchange).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
});
