import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PROTOCOL, type StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION, publicationSubmitPayloadText,
  publicationSubmitRequestText, publicationStatusRequestText } from "@yummyai/contracts/marketplace/publication-submit";
import { STORE_NODE_EXECUTION_OPERATION, STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionClaimInputSchema, StoreNodeExecutionCompleteInputSchema,
  StoreNodeExecutionPermitInputSchema, type StoreNodeExecutionCredential, type StoreNodeAmazonSubmissionLease,
  type StoreNodeAmazonStatusLease, type StoreNodeExecutionCompletionPayloadSchema } from "@yummyai/contracts/marketplace/store-node-execution";
import { createStoreNodeSealedCredential, openStoreNodeExecutionPayload, sealStoreNodeExecutionPayload,
  storeNodeExecutionPayloadChecksum } from "@yummyai/marketplace-connectors";
import type { z } from "zod";
import { executeStoreNodeSubmission } from "./submission-execution.js";
import { runStoreNodeExecution, type StoreNodeExecutionOptions } from "./execution.js";
import { StoreNodeExecutionJournal, cacheStoreNodeResponse } from "./execution-journal.js";
import { StoreNodeExecutionRpcError, StoreNodeExecutionTransport } from "./execution-transport.js";
import { noLinks, type StoreNodeLocalLock } from "./storage.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const application = { clientId: "synthetic-public-client", clientSecret: 'synthetic-node-"app-secret"' };
const pair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const journalPassphrase = "synthetic-submission-journal-passphrase";
function fixture(kind: "submit" | "status" = "submit", publicApp = false, sourceSubmissionId: string | null = "synthetic-original-submission") {
  const future = new Date(Date.now() + 120_000).toISOString(), requestId = createEntityId();
  const seed: StoreNodeExecutionCredential = { account: { platform: "amazon", authorizationMode: publicApp ? "amazon_public" : "amazon_private", region: "NA",
    externalAccountId: "synthetic-seller", grantedScopes: ["product-listing"], marketplaceIds: ["synthetic-market"] },
    credential: publicApp ? { kind: "amazon_public", clientId: application.clientId, sellingPartnerId: "synthetic-seller", refreshToken: "synthetic-original-refresh" }
      : { clientId: "synthetic-private-client", clientSecret: "synthetic-private-secret", sellingPartnerId: "synthetic-seller", refreshToken: "synthetic-original-refresh" },
    etsyAppKeySha256: null, ...(publicApp ? { amazonAppClientIdSha256: sha(application.clientId) } : {}) };
  const payload = { platform: "amazon" as const, marketplaceId: "synthetic-market", locale: "en-US", productType: "HOME", sku: "synthetic-sku",
    attributes: { item_name: [{ value: "Synthetic approved pillow" }] } };
  const target = { accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(), variantSkuId: createEntityId(), marketplaceId: payload.marketplaceId,
    capabilitySnapshotId: createEntityId(), payloadChecksum: sha(publicationSubmitPayloadText(payload)), assetManifestChecksum: "a".repeat(64), sku: payload.sku,
    nodeId: createEntityId(), certificateGeneration: 1, authorizationGeneration: createEntityId(), bindingRevision: 1 };
  const common = { id: createEntityId(), protocol: STORE_NODE_EXECUTION_PROTOCOL, accountId: target.accountId, nodeId: target.nodeId, certificateGeneration: 1,
    authorizationGeneration: target.authorizationGeneration, bindingRevision: 1, requestId: createEntityId(), claimId: createEntityId(), sessionId: createEntityId(),
    credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 1, expiresAt: future, runExpiresAt: future };
  let lease: StoreNodeAmazonSubmissionLease | StoreNodeAmazonStatusLease;
  if (kind === "submit") {
    const pinned = { ...target, previewRequestId: createEntityId(), previewEventId: createEntityId(), previewEventSequence: 3, previewExecutionId: createEntityId() };
    const base = { ...common, requestChecksum: sha(publicationSubmitRequestText(pinned)) };
    const sealed = createStoreNodeSealedCredential(seed, base, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
    lease = { ...base, operation: STORE_NODE_PUBLICATION_SUBMIT_OPERATION, sealedCredential: sealed.sealed,
      input: { operationId: createEntityId(), publicationRequestId: requestId, target: pinned, payload } };
    return { seed, lease, transportKey: sealed.key, amazonApplication: publicApp ? application : undefined };
  }
  const pinned = { ...target, publicationRequestId: requestId, submissionExecutionId: createEntityId(), submissionTargetChecksum: "b".repeat(64),
    sourceEventId: createEntityId(), sourceEventSequence: 5, sourceSubmissionId };
  const base = { ...common, requestChecksum: sha(publicationStatusRequestText(pinned)) };
  const sealed = createStoreNodeSealedCredential(seed, base, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  lease = { ...base, operation: STORE_NODE_PUBLICATION_STATUS_OPERATION, sealedCredential: sealed.sealed,
    input: { operationId: createEntityId(), publicationRequestId: requestId, target: pinned, payload } };
  return { seed, lease, transportKey: sealed.key, amazonApplication: publicApp ? application : undefined };
}
function provider(f: ReturnType<typeof fixture>, response?: () => Response) {
  return vi.fn(async (raw: Parameters<typeof fetch>[0]) => String(raw) === "https://api.amazon.com/auth/o2/token"
    ? Response.json({ access_token: 'synthetic-access-"secret"', expires_in: 3600 }) : response?.() ?? (f.lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION
      ? Response.json({ sku: f.lease.input.target.sku, status: "ACCEPTED", submissionId: "synthetic-server-submission", issues: [] })
      : Response.json({ sku: f.lease.input.target.sku, summaries: [{ status: ["BUYABLE"] }], issues: [] })));
}
async function runtimeFixture(kind: "submit" | "status" = "submit", publicApp = false) {
  const f = fixture(kind, publicApp), { lease } = f, writes: Buffer[] = [], stop = new AbortController();
  const lock: StoreNodeLocalLock = { signal: new AbortController().signal, assertHeld() {}, commit: async () => {}, commitJournal: async bytes => { writes.push(Buffer.from(bytes)); } };
  const journal = await StoreNodeExecutionJournal.create(lease, { passphrase: journalPassphrase, lock, spki: sha(pair.publicKey.export({ type: "spki", format: "der" })) });
  const request = provider(f);
  const heartbeat: StoreNodeHeartbeatView = { protocol: STORE_NODE_PROTOCOL, nodeId: lease.nodeId, accountId: lease.accountId, certificateGeneration: lease.certificateGeneration,
    sessionId: lease.sessionId, sequence: 1, bindingRevision: lease.bindingRevision, bindingState: "active", authorizationGeneration: lease.authorizationGeneration,
    observedAt: new Date().toISOString(), sessionExpiresAt: lease.runExpiresAt, execution: "not_integrated" };
  const parent = path.resolve(tmpdir()), prefix = "yummyai-store-node-submission-";
  await noLinks(parent);
  const directory = await mkdtemp(path.join(parent, prefix));
  const options: StoreNodeExecutionOptions = { directory,
    passphrase: journalPassphrase, identity: { protocol: STORE_NODE_PROTOCOL, nodeId: lease.nodeId, accountId: lease.accountId, certificateGeneration: lease.certificateGeneration,
      certificatePem: "synthetic-unused-cert", caCertificatePem: "synthetic-unused-ca", runtimeOrigin: "https://127.0.0.1:8142", expiresAt: lease.expiresAt },
    key: pair.privateKey, encryptedPrivateKeyPem: "synthetic-unused-private-key", lock, signal: stop.signal, intervalMs: 1000, etsy: null,
    amazonApplication: f.amazonApplication, heartbeat: () => heartbeat, request: request as typeof fetch };
  const receipt = (completionChecksum: string | null) => ({ protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: lease.id, claimId: lease.claimId,
    state: completionChecksum ? "succeeded" : "running", phase: completionChecksum ? "finished" : "collecting", checkpointChecksum: null, credentialVersion: lease.credentialVersion,
    completionChecksum, snapshotId: null, observedAt: new Date().toISOString() });
  const close = async () => {
    f.transportKey.fill(0); for (const bytes of writes) bytes.fill(0);
    expect(path.dirname(directory)).toBe(parent);
    expect(path.basename(directory).startsWith(prefix)).toBe(true);
    await noLinks(directory);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    await rm(directory, { recursive: true, force: false });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { ...f, options, stop, journal, writes, request, receipt, close };
}
function central(f: Awaited<ReturnType<typeof runtimeFixture>>, accept: (value: z.infer<typeof StoreNodeExecutionCompletionPayloadSchema>) => void) {
  return vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
    if (operation === "permit") {
      const input = StoreNodeExecutionPermitInputSchema.parse(raw);
      return { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId, stepId: input.stepId, requestDigest: input.requestDigest,
        permitId: createEntityId(), expiresAt: f.lease.runExpiresAt };
    }
    if (operation === "step") return { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId, acknowledged: true, observedAt: new Date().toISOString() };
    if (operation === "complete") {
      const input = StoreNodeExecutionCompleteInputSchema.parse(raw);
      expect(input).toEqual(f.journal.data.completion);
      accept(openStoreNodeExecutionPayload(input.payload, f.transportKey, f.lease, "completion") as z.infer<typeof StoreNodeExecutionCompletionPayloadSchema>);
      return f.receipt(input.payloadChecksum);
    }
    expect(operation).toBe("receipt"); return f.receipt(null);
  });
}

describe("store node original formal Amazon execution and durable recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses an original accepted submission and preserves the exact server submission receipt", async () => {
    const f = fixture("submit", true), request = provider(f);
    try {
      const result = await executeStoreNodeSubmission({ ...f, request: request as typeof fetch, exchange: async (_call, send) => send() });
      expect(result).toMatchObject({ publicationRequestId: f.lease.input.publicationRequestId, payloadChecksum: f.lease.input.target.payloadChecksum,
        externalListingId: f.lease.input.target.sku, externalSubmissionId: "synthetic-server-submission", status: "submission_accepted" });
      expect(result).not.toHaveProperty("credential"); expect(result).not.toHaveProperty("refreshedCredential"); expect(request).toHaveBeenCalledTimes(2);
    } finally { f.transportKey.fill(0); }
  });

  it.each([null, "synthetic-original-submission"])("retains the original status source receipt %s without claiming the platform returned it", async sourceSubmissionId => {
    const f = fixture("status", false, sourceSubmissionId), request = provider(f);
    try {
      const result = await executeStoreNodeSubmission({ ...f, request: request as typeof fetch, exchange: async (_call, send) => send() });
      expect(result).toMatchObject({ sourceSubmissionId, status: "published", externalListingId: f.lease.input.target.sku });
      expect(result).not.toHaveProperty("externalSubmissionId"); expect(request).toHaveBeenCalledTimes(2);
    } finally { f.transportKey.fill(0); }
  });

  it.each(["refresh", "access", "application"] as const)("rejects original or node-local %s secrets in original parsed result text", async secret => {
    const f = fixture("submit", true), leaked = secret === "refresh" ? f.seed.credential.refreshToken : secret === "access" ? 'synthetic-access-"secret"' : application.clientSecret;
    const request = provider(f, () => Response.json({ sku: f.lease.input.target.sku, status: "INVALID", submissionId: "synthetic-rejected-id",
      issues: [{ code: "SYNTHETIC", message: leaked, severity: "ERROR", attributeNames: [] }] }));
    try { await expect(executeStoreNodeSubmission({ ...f, request: request as typeof fetch, exchange: async (_call, send) => send() })).rejects.toMatchObject({ code: "store_node_secret_output_rejected" }); }
    finally { f.transportKey.fill(0); }
  });

  it.each(["received 503", "received malformed JSON"] as const)("keeps %s after a formal PUT unknown even with durable received HTTP metadata", async failure => {
    const f = await runtimeFixture(), request = provider(f, () => failure === "received 503" ? new Response("synthetic failure", { status: 503 }) : new Response("not synthetic JSON"));
    let finished = false;
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      central(f, result => { expect(result).toEqual({ outcome: "unknown", code: "store_node_operation_unknown" }); finished = true; });
      await runStoreNodeExecution({ ...f.options, request: request as typeof fetch, shouldStop: () => finished });
      expect(f.journal.data.rows.map(row => row.state)).toEqual(["received", "received"]); expect(f.journal.data.completed).toBe(true); expect(request).toHaveBeenCalledTimes(2);
      await runStoreNodeExecution({ ...f.options, request: request as typeof fetch, shouldStop: () => true });
      expect(request).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("preserves a known platform 400 refusal as failure without resubmitting the immutable PUT", async () => {
    const f = await runtimeFixture(), request = provider(f, () => new Response("synthetic invalid request", { status: 400 })); let finished = false;
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      central(f, result => { expect(result).toEqual({ outcome: "failure", code: "store_node_upstream_validation" }); finished = true; });
      await runStoreNodeExecution({ ...f.options, request: request as typeof fetch, shouldStop: () => finished });
      expect(request).toHaveBeenCalledTimes(2); expect(f.journal.data.rows.every(row => row.state === "received")).toBe(true);
    } finally { await f.close(); }
  });

  it("keeps an accepted PUT whose result fails the secret gate uncertain instead of treating it as a safe new write", async () => {
    const f = await runtimeFixture("submit", true), request = provider(f, () => Response.json({ sku: f.lease.input.target.sku, status: "ACCEPTED", submissionId: "synthetic-accepted-id",
      issues: [{ code: "SYNTHETIC", message: application.clientSecret, severity: "WARNING", attributeNames: [] }] })); let finished = false;
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      central(f, result => { expect(result).toEqual({ outcome: "unknown", code: "store_node_operation_unknown" }); finished = true; });
      await runStoreNodeExecution({ ...f.options, request: request as typeof fetch, shouldStop: () => finished });
      expect(request).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("recovers a received PUT after its step ACK is lost using cached original responses and no second platform call", async () => {
    const f = await runtimeFixture();
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      const handler = central(f, () => { throw new Error("completion must not precede lost step receipt recovery"); });
      const original = handler.getMockImplementation()!;
      handler.mockImplementation(async (operation, raw) => {
        if (operation === "step" && f.journal.data.rows.at(-1)?.requestClass === "amazon_listing_submit") { f.stop.abort(); throw new StoreNodeExecutionRpcError("store_node_operation_unknown", true); }
        return original(operation, raw);
      });
      await runStoreNodeExecution(f.options);
      expect(f.request).toHaveBeenCalledTimes(2); expect(f.journal.data.rows.at(-1)).toMatchObject({ state: "received", stepAcknowledged: false }); expect(f.journal.data.completion).toBeNull();
      handler.mockRestore(); let finished = false;
      central(f, result => { expect(result).toMatchObject({ outcome: "publication_submit", result: { externalSubmissionId: "synthetic-server-submission" } }); finished = true; });
      await runStoreNodeExecution({ ...f.options, signal: new AbortController().signal, heartbeat: () => null, shouldStop: () => finished });
      expect(f.request).toHaveBeenCalledTimes(2); expect(f.journal.data.completed).toBe(true); expect(f.journal.data.rows.every(row => row.stepAcknowledged)).toBe(true);
    } finally { await f.close(); }
  });

  it("does not resend a submitted PUT without a persisted response after restart", async () => {
    const f = await runtimeFixture(); let finished = false;
    try {
      await executeStoreNodeSubmission({ ...f, request: f.request as typeof fetch, exchange: async (call, send) => {
        const response = await send(), cached = await cacheStoreNodeResponse(response.clone()), stepId = createEntityId(), writing = call.requestClass === "amazon_listing_submit";
        await f.journal.update(data => { data.rows.push({ stepId, ordinal: data.rows.length + 1, requestClass: call.requestClass, requestDigest: call.requestDigest,
          state: writing ? "submitted" : "received", response: writing ? null : { status: cached.status, contentType: cached.contentType, retryAfter: cached.retryAfter, body: cached.body,
            ...(cached.amazonRateLimit !== undefined ? { amazonRateLimit: cached.amazonRateLimit } : {}) }, stepAcknowledged: !writing,
          permit: { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId, stepId,
            requestDigest: call.requestDigest, permitId: createEntityId(), expiresAt: f.lease.runExpiresAt } }); });
        return response;
      } });
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      central(f, result => { expect(result).toEqual({ outcome: "unknown", code: "store_node_operation_unknown" }); finished = true; });
      await runStoreNodeExecution({ ...f.options, shouldStop: () => finished });
      expect(f.request).toHaveBeenCalledTimes(2); expect(f.journal.data.rows.at(-1)?.state).toBe("unknown");
    } finally { await f.close(); }
  });

  it("replays the exact saved completion before removed local application configuration or fresh heartbeat checks", async () => {
    const f = await runtimeFixture("submit", true); let finished = false;
    try {
      const result = await executeStoreNodeSubmission({ ...f, request: f.request as typeof fetch, exchange: async (_call, send) => send() });
      const payload = sealStoreNodeExecutionPayload({ outcome: "publication_submit", result }, f.transportKey, f.lease, "completion");
      const completion = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: f.lease.nodeId, certificateGeneration: f.lease.certificateGeneration, sessionId: f.lease.sessionId,
        executionId: f.lease.id, claimId: f.lease.claimId, requestChecksum: f.lease.requestChecksum, payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) };
      await f.journal.update(data => { data.completion = completion; });
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      const handler = central(f, value => { expect(value).toMatchObject({ outcome: "publication_submit" }); finished = true; });
      await runStoreNodeExecution({ ...f.options, amazonApplication: null, heartbeat: () => null, shouldStop: () => true });
      expect(finished).toBe(true); expect(handler.mock.calls.map(([operation]) => operation)).toEqual(["receipt", "complete"]);
      expect(f.journal.data.completion).toEqual(completion); expect(f.request).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("closes an already acknowledged completion after a lost response using only its original receipt", async () => {
    const f = await runtimeFixture(); let savedHash: string | null = null;
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      const handler = central(f, () => {}), original = handler.getMockImplementation()!;
      handler.mockImplementation(async (operation, raw) => {
        if (operation === "complete") { savedHash = StoreNodeExecutionCompleteInputSchema.parse(raw).payloadChecksum; f.stop.abort(); throw new StoreNodeExecutionRpcError("store_node_operation_unknown", true); }
        return original(operation, raw);
      });
      await runStoreNodeExecution(f.options); expect(savedHash).not.toBeNull(); expect(f.journal.data.completed).toBe(false);
      handler.mockRestore(); const recovery = vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async operation => { expect(operation).toBe("receipt"); return f.receipt(savedHash); });
      await runStoreNodeExecution({ ...f.options, signal: new AbortController().signal, heartbeat: () => null, shouldStop: () => true });
      expect(recovery).toHaveBeenCalledOnce(); expect(f.journal.data.completed).toBe(true); expect(f.request).toHaveBeenCalledTimes(2);
    } finally { await f.close(); }
  });

  it("advertises the two new explicit operations alongside the unchanged capability and preview operations", async () => {
    const f = await runtimeFixture();
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(null);
      vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
        expect(operation).toBe("claim"); expect(StoreNodeExecutionClaimInputSchema.parse(raw).supportedOperations)
          .toEqual([STORE_NODE_EXECUTION_OPERATION, "marketplace.publication.validation-preview.v1", STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION]);
        f.stop.abort(); return { protocol: STORE_NODE_EXECUTION_PROTOCOL, state: "empty", lease: null, observedAt: new Date().toISOString() };
      });
      await runStoreNodeExecution(f.options); expect(f.request).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
});
