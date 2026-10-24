import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION, publicationSubmitRequestText,
  publicationStatusRequestText, publicationSubmitPayloadText } from "@yummyai/contracts/marketplace/publication-submit";
import { STORE_NODE_EXECUTION_PROTOCOL, STORE_NODE_EXECUTION_RESULT_BYTES, type StoreNodeExecutionCredential,
  type StoreNodeAmazonSubmissionLease, type StoreNodeAmazonStatusLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { describe, expect, it, vi } from "vitest";
import { HttpMarketplaceDraftGateway } from "./publication.js";
import { storeNodeAmazonGatewayEnvironment } from "./store-node-amazon-application.js";
import { assertStoreNodeSubmissionLease, createStoreNodeSubmissionTransport } from "./store-node-submission-transport.js";
import type { StoreNodeCapabilityExchange } from "./store-node-capability-transport.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown, headers?: Record<string, string>) => Response.json(value, { headers });
const application = { clientId: "synthetic-public-client", clientSecret: "synthetic-node-app-secret" };
function fixture(kind: "submit" | "status" = "submit", publicApp = false) {
  const seed: StoreNodeExecutionCredential = { account: { platform: "amazon", authorizationMode: publicApp ? "amazon_public" : "amazon_private", region: "NA",
    externalAccountId: "SYNTHETIC-SELLER", grantedScopes: ["product-listing"], marketplaceIds: ["ATVPDKIKX0DER"] },
    credential: publicApp ? { kind: "amazon_public", clientId: application.clientId, sellingPartnerId: "SYNTHETIC-SELLER", refreshToken: "synthetic-refresh" }
      : { clientId: "synthetic-private-client", clientSecret: "synthetic-private-secret", sellingPartnerId: "SYNTHETIC-SELLER", refreshToken: "synthetic-refresh" },
    etsyAppKeySha256: null, ...(publicApp ? { amazonAppClientIdSha256: sha(application.clientId) } : {}) };
  const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU /中文",
    attributes: { item_name: [{ value: "Synthetic approved pillow" }], z: null, A: ["fixed original"] } };
  const target = { accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(), marketplaceId: payload.marketplaceId,
    variantSkuId: createEntityId(), capabilitySnapshotId: createEntityId(), payloadChecksum: sha(publicationSubmitPayloadText(payload)), assetManifestChecksum: "a".repeat(64),
    nodeId: createEntityId(), certificateGeneration: 1, authorizationGeneration: createEntityId(), bindingRevision: 2, sku: payload.sku };
  const common = { protocol: STORE_NODE_EXECUTION_PROTOCOL, id: createEntityId(), accountId: target.accountId, requestId: createEntityId(), claimId: createEntityId(),
    sessionId: createEntityId(), credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 3, nodeId: target.nodeId,
    certificateGeneration: 1, authorizationGeneration: target.authorizationGeneration, bindingRevision: 2, expiresAt: "2026-12-01T00:00:00.000Z", runExpiresAt: "2026-12-01T00:00:00.000Z",
    sealedCredential: { nonce: "A".repeat(16), tag: "A".repeat(22), ciphertext: "AQ", wrappedKey: "A".repeat(512) } };
  const requestId = createEntityId(), operationId = createEntityId();
  let lease: StoreNodeAmazonSubmissionLease | StoreNodeAmazonStatusLease;
  if (kind === "submit") {
    const pinned = { ...target, previewRequestId: createEntityId(), previewEventId: createEntityId(), previewEventSequence: 4, previewExecutionId: createEntityId() };
    lease = { ...common, operation: STORE_NODE_PUBLICATION_SUBMIT_OPERATION, requestChecksum: sha(publicationSubmitRequestText(pinned)),
      input: { operationId, publicationRequestId: requestId, target: pinned, payload } };
  } else {
    const pinned = { ...target, publicationRequestId: requestId, submissionExecutionId: createEntityId(), submissionTargetChecksum: "b".repeat(64),
      sourceEventId: createEntityId(), sourceEventSequence: 5, sourceSubmissionId: "synthetic-original-submission" };
    lease = { ...common, operation: STORE_NODE_PUBLICATION_STATUS_OPERATION, requestChecksum: sha(publicationStatusRequestText(pinned)),
      input: { operationId, publicationRequestId: requestId, target: pinned, payload } };
  }
  return { seed, lease, application: publicApp ? application : undefined };
}
function tokenInit(seed: StoreNodeExecutionCredential, local?: typeof application): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ grant_type: "refresh_token",
    refresh_token: seed.credential.refreshToken!, client_id: local?.clientId ?? seed.credential.clientId!, client_secret: local?.clientSecret ?? seed.credential.clientSecret! }) };
}
function listing(lease: StoreNodeAmazonSubmissionLease | StoreNodeAmazonStatusLease) {
  const submit = lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION, { payload } = lease.input;
  const url = new URL(`https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/SYNTHETIC-SELLER/${encodeURIComponent(payload.sku)}`);
  url.search = new URLSearchParams({ marketplaceIds: payload.marketplaceId, issueLocale: "en_US", ...(!submit ? { includedData: "summaries,issues" } : {}) }).toString();
  return { url, init: { method: submit ? "PUT" : "GET", headers: { "user-agent": "YummyAI/0.1 (Language=TypeScript)", "x-amz-access-token": "synthetic-access", "x-amz-date": "20261023T000000Z",
    ...(submit ? { "content-type": "application/json" } : {}) }, ...(submit ? { body: JSON.stringify({ productType: payload.productType, requirements: "LISTING", attributes: payload.attributes }) } : {}) } satisfies RequestInit };
}

describe("store node fixed Amazon submission and status HTTPS boundary", () => {
  it.each(["submit", "status"] as const)("uses the original %s parser and exactly its two fixed HTTP requests for private and public grants", async kind => {
    for (const publicApp of [false, true]) {
      const f = fixture(kind, publicApp), classes: string[] = [], observed: string[] = [];
      const request = vi.fn(async (raw: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        if (String(raw) === "https://api.amazon.com/auth/o2/token") {
          expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(f.application?.clientSecret ?? f.seed.credential.clientSecret);
          return json({ access_token: "synthetic-access", expires_in: 3600 });
        }
        const expected = listing(f.lease); expect(String(raw)).toBe(expected.url.href); expect(init?.method).toBe(expected.init.method); expect(init?.body).toBe(expected.init.body);
        return kind === "submit" ? json({ sku: f.lease.input.payload.sku, status: "ACCEPTED", submissionId: "synthetic-submit-id", issues: [] }, { "x-amzn-ratelimit-limit": "5.5" })
          : json({ sku: f.lease.input.payload.sku, summaries: [{ status: ["BUYABLE"] }], issues: [] }, { "x-amzn-ratelimit-limit": "5.5" });
      });
      const transport = createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, amazonApplication: f.application, request: request as typeof fetch,
        observeSecret: value => observed.push(value), exchange: async (call, send) => { classes.push(call.requestClass); expect(call.requestDigest).toMatch(/^[a-f0-9]{64}$/); return send(); } });
      const gateway = new HttpMarketplaceDraftGateway(transport, storeNodeAmazonGatewayEnvironment(f.seed, f.application)), account = { ...f.seed.account, externalAccountId: "SYNTHETIC-SELLER" };
      const result = kind === "submit" ? await gateway.submit(account, f.seed.credential, f.lease.input.payload)
        : await gateway.getStatus(account, f.seed.credential, f.lease.input.payload, f.lease.input.target.sku);
      expect(result).toMatchObject({ status: kind === "submit" ? "submission_accepted" : "published", externalListingId: f.lease.input.target.sku, quota: { windows: [{ limit: 5.5 }] } });
      expect(classes).toEqual(["amazon_lwa", kind === "submit" ? "amazon_listing_submit" : "amazon_listing_status"]);
      expect(observed).toEqual(["synthetic-access"]); expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects changed original source identity, checksums and payload before any permit", () => {
    for (const kind of ["submit", "status"] as const) {
      const f = fixture(kind), exchange = vi.fn(), request = vi.fn();
      const changedPayload = structuredClone(f.lease), changedSku = structuredClone(f.lease);
      changedPayload.input.payload.attributes = { replacement: true }; changedSku.input.target.sku = "OTHER";
      const variants = [{ ...f.lease, requestChecksum: "0".repeat(64) }, { ...f.lease, accountId: createEntityId() }, { ...f.lease, certificateGeneration: 2 },
        changedPayload, changedSku];
      for (const lease of variants) expect(() => createStoreNodeSubmissionTransport({ seed: f.seed, lease, exchange, request })).toThrow("store_node_policy_rejected");
      expect(exchange).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    }
  });

  it.each(["submit", "status"] as const)("rejects preview, opposite action, foreign target, extra queries and credential headers for %s", async kind => {
    const f = fixture(kind), request = vi.fn(async () => json({ access_token: "synthetic-access", expires_in: 3600 }));
    const exchange = vi.fn(async (_call: StoreNodeCapabilityExchange, send: () => Promise<Response>) => send());
    const transport = createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, request: request as typeof fetch, exchange });
    await transport("https://api.amazon.com/auth/o2/token", tokenInit(f.seed));
    const good = listing(f.lease), cases: Array<[string | URL, RequestInit]> = [
      [`${good.url.href}&mode=VALIDATION_PREVIEW`, good.init], [`${good.url.href}&marketplaceIds=FOREIGN`, good.init],
      [good.url.href.replace("SYNTHETIC-SELLER", "FOREIGN"), good.init], [good.url.href.replace("sellingpartnerapi-na", "sellingpartnerapi-eu"), good.init],
      [good.url, { ...good.init, method: kind === "submit" ? "GET" : "PUT" }], [good.url, { ...good.init, body: "{}" }],
      [good.url, { ...good.init, headers: { ...good.init.headers, authorization: "synthetic-leak" } }], [good.url.href.replace("https:", "http:"), good.init],
      ["https://sellingpartnerapi-na.amazon.com/feeds/2021-06-30/feeds", good.init],
    ];
    for (const [url, init] of cases) await expect(transport(url, init)).rejects.toMatchObject({ code: "store_node_policy_rejected" });
    expect(request).toHaveBeenCalledTimes(1); expect(exchange).toHaveBeenCalledTimes(1);
  });

  it.each(["submit", "status"] as const)("replays cached %s responses with identical digests without another physical request", async kind => {
    const f = fixture(kind), cache = new Map<string, Response>();
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).startsWith("https://api.amazon.com/") ? json({ access_token: "synthetic-access", expires_in: 3600 })
      : kind === "submit" ? json({ sku: f.lease.input.target.sku, status: "ACCEPTED", submissionId: "synthetic-cached-id", issues: [] })
        : json({ sku: f.lease.input.target.sku, summaries: [{ status: ["BUYABLE"] }], issues: [] }));
    const account = { ...f.seed.account, externalAccountId: "SYNTHETIC-SELLER" };
    for (const restoring of [false, true]) {
      const noRequest = vi.fn(), transport = createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, request: restoring ? noRequest : request as typeof fetch,
        exchange: async (call, send) => {
          if (restoring) { const cached = cache.get(call.requestDigest); if (!cached) throw new Error("missing synthetic original response"); return cached.clone(); }
          const response = await send(); cache.set(call.requestDigest, response.clone()); return response;
        } });
      const gateway = new HttpMarketplaceDraftGateway(transport, {});
      const result = kind === "submit" ? await gateway.submit(account, f.seed.credential, f.lease.input.payload) : await gateway.getStatus(account, f.seed.credential, f.lease.input.payload, f.lease.input.target.sku);
      expect(result.status).toBe(kind === "submit" ? "submission_accepted" : "published"); expect(noRequest).not.toHaveBeenCalled();
    }
    expect(request).toHaveBeenCalledTimes(2); expect(cache.size).toBe(2);
  });

  it("keeps immutable public lease verification independent of local application availability", () => {
    const f = fixture("submit", true), exchange = vi.fn(), request = vi.fn();
    expect(() => assertStoreNodeSubmissionLease(f.lease, f.seed)).not.toThrow();
    expect(() => createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, exchange, request })).toThrow("store_node_configuration_invalid");
    expect(() => createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, amazonApplication: { ...application, clientId: "other" }, exchange, request })).toThrow("store_node_configuration_invalid");
    expect(() => createStoreNodeSubmissionTransport({ seed: { ...f.seed, amazonAppClientIdSha256: "f".repeat(64) }, lease: f.lease, amazonApplication: application, exchange, request }))
      .toThrow("store_node_application_reauthorization_required");
    expect(exchange).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });

  it("rejects redirects and cancels oversized bodies inside the original exchange", async () => {
    const f = fixture(), cancel = vi.fn();
    const transport = createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, exchange: async (_call, send) => send(), request: vi.fn(async () =>
      new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(STORE_NODE_EXECUTION_RESULT_BYTES + 1) } })) as typeof fetch });
    await expect(transport("https://api.amazon.com/auth/o2/token", tokenInit(f.seed))).rejects.toMatchObject({ code: "store_node_result_too_large" });
    expect(cancel).toHaveBeenCalledOnce();
    const redirected = createStoreNodeSubmissionTransport({ seed: f.seed, lease: f.lease, exchange: async (_call, send) => send(), request: vi.fn(async () => {
      const response = json({ access_token: "synthetic-access", expires_in: 3600 }); Object.defineProperty(response, "redirected", { value: true }); return response;
    }) as typeof fetch });
    await expect(redirected("https://api.amazon.com/auth/o2/token", tokenInit(f.seed))).rejects.toMatchObject({ code: "store_node_policy_rejected" });
  });
});
