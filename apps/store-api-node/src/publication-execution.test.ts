import { createHash, randomBytes } from "node:crypto";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PUBLICATION_OPERATION, publicationPreviewPayloadText, publicationPreviewRequestText } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionCompleteInputSchema, StoreNodeExecutionCompletionPayloadSchema,
  type StoreNodeExecutionCredential, type StoreNodePublicationLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { openStoreNodeExecutionPayload, sealStoreNodeExecutionPayload, storeNodeExecutionPayloadChecksum } from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";
import { StoreNodeExecutionJournal } from "./execution-journal.js";
import { openStoreNodeJournal } from "./identity.js";
import { executeStoreNodePublication } from "./publication-execution.js";
import type { StoreNodeLocalLock } from "./storage.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
function fixture() {
  const seed: StoreNodeExecutionCredential = { account: { platform: "amazon", authorizationMode: "amazon_private", region: "NA",
    externalAccountId: "SYNTHETIC-SELLER", grantedScopes: ["product-listing"], marketplaceIds: ["ATVPDKIKX0DER"] },
    credential: { sellingPartnerId: "SYNTHETIC-SELLER", clientId: "synthetic-client", clientSecret: "synthetic-original-secret", refreshToken: "synthetic-original-refresh" }, etsyAppKeySha256: null };
  const payload = { platform: "amazon" as const, marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SYNTHETIC-SKU", attributes: { item_name: [{ value: "Synthetic approved pillow" }] } };
  const target = { accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(), variantSkuId: createEntityId(),
    capabilitySnapshotId: createEntityId(), marketplaceId: payload.marketplaceId, payloadChecksum: sha(publicationPreviewPayloadText(payload)), assetManifestChecksum: "a".repeat(64),
    nodeId: createEntityId(), certificateGeneration: 1, authorizationGeneration: createEntityId(), bindingRevision: 1 };
  const lease: StoreNodePublicationLease = { protocol: STORE_NODE_EXECUTION_PROTOCOL, operation: STORE_NODE_PUBLICATION_OPERATION, id: createEntityId(),
    accountId: target.accountId, nodeId: target.nodeId, certificateGeneration: 1, authorizationGeneration: target.authorizationGeneration, bindingRevision: 1,
    requestId: createEntityId(), requestChecksum: sha(publicationPreviewRequestText(target)), claimId: createEntityId(), sessionId: createEntityId(),
    credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 1, expiresAt: "2026-12-01T00:00:00.000Z", runExpiresAt: "2026-12-01T00:00:00.000Z",
    sealedCredential: { nonce: "A".repeat(16), tag: "A".repeat(22), ciphertext: "AQ", wrappedKey: "A".repeat(512) },
    input: { publicationRequestId: createEntityId(), target, payload } };
  return { seed, lease };
}

describe("store node original publication result and durable completion", () => {
  it("returns only the strict original validation result with its publication and payload identity", async () => {
    const { seed, lease } = fixture(), classes: string[] = [];
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).startsWith("https://api.amazon.com/")
      ? json({ access_token: "synthetic-short-access", expires_in: 3600 })
      : json({ sku: lease.input.payload.sku, status: "ACCEPTED", submissionId: "synthetic-validation-submission", issues: [] }));
    const result = await executeStoreNodePublication({ seed, lease, request: request as typeof fetch,
      exchange: async (call, send) => { classes.push(call.requestClass); return send(); } });
    expect(result).toMatchObject({ publicationRequestId: lease.input.publicationRequestId, payloadChecksum: lease.input.target.payloadChecksum,
      status: "validation_passed", externalState: "ACCEPTED", externalSubmissionId: "synthetic-validation-submission", issues: [] });
    expect(result).not.toHaveProperty("refreshedCredential"); expect(result).not.toHaveProperty("credential"); expect(result).not.toHaveProperty("externalListingId");
    expect(classes).toEqual(["amazon_lwa", "amazon_listing_validation_preview"]); expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects both original and newly issued secrets in platform issue text, including escaped values", async () => {
    for (const leaked of ["synthetic-original-refresh", 'synthetic-access-"quoted"']) {
      const { seed, lease } = fixture();
      const request = vi.fn(async (url: Parameters<typeof fetch>[0]) =>
        String(url).startsWith("https://api.amazon.com/") ? json({ access_token: 'synthetic-access-"quoted"', expires_in: 3600 })
          : json({ sku: lease.input.payload.sku, status: "INVALID", submissionId: "synthetic-validation-submission",
            issues: [{ code: "SYNTHETIC", message: leaked, severity: "ERROR", attributeNames: [] }] }));
      await expect(executeStoreNodePublication({ seed, lease, exchange: async (_call, send) => send(), request: request as typeof fetch }))
        .rejects.toMatchObject({ code: "store_node_secret_output_rejected" });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("preserves a local redirect-policy rejection after the original gateway wraps fetch errors", async () => {
    const { seed, lease } = fixture();
    await expect(executeStoreNodePublication({ seed, lease, exchange: async (_call, send) => send(), request: vi.fn(async () => {
      const response = json({ access_token: "synthetic-access", expires_in: 3600 });
      Object.defineProperty(response, "redirected", { value: true }); return response;
    }) as typeof fetch })).rejects.toMatchObject({ code: "store_node_policy_rejected" });
  });

  it("uses node-local public application configuration without placing its secret in the sealed seed or result", async () => {
    const { seed: privateSeed, lease } = fixture(), amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-node-public-secret" };
    const seed: StoreNodeExecutionCredential = { ...privateSeed, account: { ...privateSeed.account, authorizationMode: "amazon_public" },
      credential: { kind: "amazon_public", clientId: amazonApplication.clientId, sellingPartnerId: privateSeed.credential.sellingPartnerId!, refreshToken: "synthetic-public-refresh" },
      amazonAppClientIdSha256: sha(amazonApplication.clientId) };
    const request = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) === "https://api.amazon.com/auth/o2/token") {
        expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({ client_id: amazonApplication.clientId, client_secret: amazonApplication.clientSecret });
        return json({ access_token: "synthetic-public-access", expires_in: 3600 });
      }
      return json({ sku: lease.input.payload.sku, status: "ACCEPTED", submissionId: "synthetic-public-preview", issues: [] });
    });
    const result = await executeStoreNodePublication({ seed, lease, amazonApplication, request: request as typeof fetch, exchange: async (_call, send) => send() });
    expect(result.status).toBe("validation_passed"); expect(request).toHaveBeenCalledTimes(2);
    expect(seed.credential).not.toHaveProperty("clientSecret"); expect(JSON.stringify(result)).not.toContain(amazonApplication.clientSecret);
  });

  it("rejects node-local public application secrets in original parsed issues including JSON escaped text", async () => {
    const { seed: privateSeed, lease } = fixture(), amazonApplication = { clientId: "synthetic-public-client", clientSecret: 'synthetic-node-public-"secret"' };
    const seed: StoreNodeExecutionCredential = { ...privateSeed, account: { ...privateSeed.account, authorizationMode: "amazon_public" },
      credential: { kind: "amazon_public", clientId: amazonApplication.clientId, sellingPartnerId: privateSeed.credential.sellingPartnerId!, refreshToken: "synthetic-public-refresh" },
      amazonAppClientIdSha256: sha(amazonApplication.clientId) };
    const request = vi.fn(async (url: Parameters<typeof fetch>[0]) => String(url).startsWith("https://api.amazon.com/")
      ? json({ access_token: "synthetic-public-access", expires_in: 3600 })
      : json({ sku: lease.input.payload.sku, status: "INVALID", submissionId: "synthetic-public-validation-submission",
        issues: [{ code: "SYNTHETIC", message: amazonApplication.clientSecret, severity: "ERROR", attributeNames: [] }] }));
    await expect(executeStoreNodePublication({ seed, lease, amazonApplication, request: request as typeof fetch, exchange: async (_call, send) => send() }))
      .rejects.toMatchObject({ code: "store_node_secret_output_rejected" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("persists and reuses the same encrypted publication completion instead of generating another response", async () => {
    const { lease } = fixture(), key = randomBytes(32), writes: Buffer[] = [], passphrase = "synthetic-publication-journal-passphrase", spki = "b".repeat(64);
    const lock: StoreNodeLocalLock = { signal: new AbortController().signal, assertHeld() {}, commit: async () => { throw new Error("unexpected heartbeat write"); },
      commitJournal: async cipher => { writes.push(Buffer.from(cipher)); } };
    const result = { publicationRequestId: lease.input.publicationRequestId, payloadChecksum: lease.input.target.payloadChecksum,
      status: "validation_passed", externalState: "ACCEPTED", issues: [], submittedAt: "2026-10-22T00:00:00.000Z" };
    const value = StoreNodeExecutionCompletionPayloadSchema.parse({ outcome: "publication_validation", result });
    try {
      const journal = await StoreNodeExecutionJournal.create(lease, { passphrase, spki, lock });
      const payload = sealStoreNodeExecutionPayload(value, key, lease, "completion");
      const completion = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: lease.nodeId, certificateGeneration: lease.certificateGeneration,
        sessionId: lease.sessionId, executionId: lease.id, claimId: lease.claimId, requestChecksum: lease.requestChecksum,
        payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) };
      await journal.update(data => { data.completion = completion; });
      await journal.update(data => { data.completed = true; });
      const sealed = writes.at(-1); expect(sealed).toBeDefined(); if (!sealed) throw new Error("missing synthetic journal");
      const saved = await openStoreNodeJournal(sealed, passphrase, spki) as Record<string, unknown>;
      const restored = StoreNodeExecutionCompleteInputSchema.parse(saved.completion);
      expect(restored).toEqual(completion); expect(saved.completed).toBe(true);
      expect(StoreNodeExecutionCompletionPayloadSchema.parse(openStoreNodeExecutionPayload(restored.payload, key, lease, "completion"))).toEqual(value);
      expect(sealed.toString()).not.toContain(lease.input.publicationRequestId);
    } finally { key.fill(0); for (const bytes of writes) bytes.fill(0); }
  });
});
