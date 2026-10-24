import { createHash, generateKeyPairSync } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PROTOCOL, type StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_EXECUTION_OPERATION, STORE_NODE_EXECUTION_PROTOCOL, StoreNodeExecutionClaimInputSchema, StoreNodeExecutionPermitInputSchema,
  storeNodeExecutionRequestText, type StoreNodeCapabilityLease, type StoreNodeExecutionCredential } from "@yummyai/contracts/marketplace/store-node-execution";
import { createStoreNodeSealedCredential, openStoreNodeExecutionPayload, sealStoreNodeExecutionPayload, storeNodeExecutionPayloadChecksum } from "@yummyai/marketplace-connectors";
import { assertStoreNodeExecutionApplication, storeNodeAmazonApplication } from "./sealed-credential.js";
import { runStoreNodeExecution, type StoreNodeExecutionOptions } from "./execution.js";
import { StoreNodeExecutionJournal } from "./execution-journal.js";
import { StoreNodeExecutionTransport } from "./execution-transport.js";
import { noLinks, type StoreNodeLocalLock } from "./storage.js";

const amazonApplication = { clientId: "synthetic-public-client", clientSecret: "synthetic-node-local-secret" };
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const publicSeed = (): StoreNodeExecutionCredential => ({ account: { platform: "amazon", authorizationMode: "amazon_public", region: "NA",
  externalAccountId: "synthetic-seller", grantedScopes: ["product-listing"], marketplaceIds: ["synthetic-market"] },
  credential: { kind: "amazon_public", clientId: amazonApplication.clientId, sellingPartnerId: "synthetic-seller", refreshToken: "synthetic-public-refresh" },
  etsyAppKeySha256: null, amazonAppClientIdSha256: sha(amazonApplication.clientId) });

describe("store node public Amazon application and original receipt recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("loads only the complete node-prefixed application and never central application env", () => {
    expect(storeNodeAmazonApplication({ AMAZON_SPAPI_LWA_CLIENT_ID: "central", AMAZON_SPAPI_LWA_CLIENT_SECRET: "central-secret" })).toBeNull();
    const application = storeNodeAmazonApplication({ STORE_NODE_AMAZON_APP_CLIENT_ID: "  synthetic-public-client ", STORE_NODE_AMAZON_APP_CLIENT_SECRET: " synthetic-node-local-secret " });
    expect(application).toEqual(amazonApplication); expect(Object.isFrozen(application)).toBe(true);
    for (const env of [{ STORE_NODE_AMAZON_APP_CLIENT_ID: "client-only" }, { STORE_NODE_AMAZON_APP_CLIENT_SECRET: "secret-only" },
      { STORE_NODE_AMAZON_APP_CLIENT_ID: "x".repeat(16385), STORE_NODE_AMAZON_APP_CLIENT_SECRET: "local-secret" }])
      expect(() => storeNodeAmazonApplication(env)).toThrow("store_node_configuration_invalid");
  });

  it("requires the original public client pin and matching local application without imposing it on private or Etsy", () => {
    const seed = publicSeed();
    expect(() => assertStoreNodeExecutionApplication(seed, null, amazonApplication)).not.toThrow();
    for (const changed of [{ ...seed, amazonAppClientIdSha256: undefined }, { ...seed, credential: { ...seed.credential, clientId: "" } },
      { ...seed, amazonAppClientIdSha256: "a".repeat(64) }])
      expect(() => assertStoreNodeExecutionApplication(changed, null, amazonApplication)).toThrow("store_node_application_reauthorization_required");
    expect(() => assertStoreNodeExecutionApplication(seed, null)).toThrow("store_node_configuration_invalid");
    expect(() => assertStoreNodeExecutionApplication(seed, null, { ...amazonApplication, clientId: "other" })).toThrow("store_node_configuration_invalid");
    expect(() => assertStoreNodeExecutionApplication({ ...seed, account: { ...seed.account, authorizationMode: "amazon_private" },
      credential: { kind: "amazon_private", clientId: "per-store-client", clientSecret: "per-store-secret" }, amazonAppClientIdSha256: undefined }, null)).not.toThrow();
    const etsy = { keystring: "etsy-app", sharedSecret: "etsy-node-secret" };
    expect(() => assertStoreNodeExecutionApplication({ account: { ...seed.account, platform: "etsy", authorizationMode: "etsy_oauth" },
      credential: { kind: "etsy_oauth" }, etsyAppKeySha256: sha(etsy.keystring) }, etsy)).not.toThrow();
  });

  it.each([
    { label: "absent public config", local: null, etsy: null, expected: ["amazon_private"] },
    { label: "complete public config", local: amazonApplication, etsy: null, expected: ["amazon_private", "amazon_public"] },
    { label: "existing Etsy config", local: null, etsy: { keystring: "etsy-app", sharedSecret: "etsy-secret" }, expected: ["amazon_private", "etsy_oauth"] },
  ])("advertises only startup-available authorization modes [$label]", async ({ local, etsy, expected }) => {
    const f = await runtimeFixture();
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(null);
      const transport = vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
        expect(operation).toBe("claim");
        expect(StoreNodeExecutionClaimInputSchema.parse(raw).supportedAuthorizationModes).toEqual(expected);
        f.stop.abort(); return { protocol: STORE_NODE_EXECUTION_PROTOCOL, state: "empty", lease: null, observedAt: new Date().toISOString() };
      });
      await runStoreNodeExecution({ ...f.options, amazonApplication: local, etsy });
      expect(transport).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("replays the exact encrypted completion before checking removed local app config or a fresh heartbeat", async () => {
    const f = await runtimeFixture();
    try {
      const payload = sealStoreNodeExecutionPayload({ outcome: "failure", code: "store_node_upstream_validation" }, f.transportKey, f.lease, "completion");
      const completion = { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: f.lease.nodeId, certificateGeneration: f.lease.certificateGeneration,
        sessionId: f.lease.sessionId, executionId: f.lease.id, claimId: f.lease.claimId, requestChecksum: f.lease.requestChecksum,
        payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) };
      await f.journal.update(data => { data.completion = completion; });
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      const calls: string[] = [];
      vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
        calls.push(operation);
        if (operation === "complete") expect(raw).toEqual(completion);
        return f.receipt(operation === "complete" ? completion.payloadChecksum : null);
      });
      await runStoreNodeExecution({ ...f.options, amazonApplication: null, heartbeat: () => null, shouldStop: () => true });
      expect(calls).toEqual(["receipt", "complete"]); expect(f.journal.data.completed).toBe(true);
      expect(f.journal.data.completion).toEqual(completion); expect(f.request).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("keeps a submitted public LWA without a response unknown after restart instead of buying another request", async () => {
    const f = await runtimeFixture();
    let finished = false;
    try {
      const stepId = createEntityId(), requestDigest = "b".repeat(64);
      await f.journal.update(data => { data.rows.push({ stepId, ordinal: 1, requestClass: "amazon_lwa", requestDigest,
        state: "submitted", response: null, stepAcknowledged: false, permit: { protocol: STORE_NODE_EXECUTION_PROTOCOL,
          executionId: f.lease.id, claimId: f.lease.claimId, stepId, requestDigest, permitId: createEntityId(), expiresAt: f.lease.runExpiresAt } }); });
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      const calls: string[] = [];
      vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
        calls.push(operation);
        if (operation === "step") return { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId,
          acknowledged: true, observedAt: new Date().toISOString() };
        if (operation === "complete") {
          expect(raw).toEqual(f.journal.data.completion);
          expect(openStoreNodeExecutionPayload(f.journal.data.completion!.payload, f.transportKey, f.lease, "completion"))
            .toEqual({ outcome: "unknown", code: "store_node_operation_unknown" });
          finished = true; return f.receipt(f.journal.data.completion!.payloadChecksum);
        }
        expect(operation).toBe("receipt"); return f.receipt(null);
      });
      await runStoreNodeExecution({ ...f.options, shouldStop: () => finished });
      expect(calls).toEqual(["step", "receipt", "complete"]); expect(f.journal.data.rows[0]?.state).toBe("unknown");
      expect(f.request).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("blocks a node-local public secret echoed in the original capability result before storing success", async () => {
    const f = await runtimeFixture(), local = { ...amazonApplication, clientSecret: 'synthetic-public-"local-secret"' };
    let finished = false;
    try {
      vi.spyOn(StoreNodeExecutionJournal, "open").mockResolvedValue(f.journal);
      vi.spyOn(StoreNodeExecutionTransport.prototype, "call").mockImplementation(async (operation, raw) => {
        if (operation === "permit") {
          const input = StoreNodeExecutionPermitInputSchema.parse(raw);
          return { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId,
            stepId: input.stepId, requestDigest: input.requestDigest, permitId: createEntityId(), expiresAt: f.lease.runExpiresAt };
        }
        if (operation === "step") return { protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: f.lease.id, claimId: f.lease.claimId,
          acknowledged: true, observedAt: new Date().toISOString() };
        if (operation === "complete") {
          expect(raw).toEqual(f.journal.data.completion);
          expect(openStoreNodeExecutionPayload(f.journal.data.completion!.payload, f.transportKey, f.lease, "completion"))
            .toEqual({ outcome: "failure", code: "store_node_secret_output_rejected" });
          finished = true; return f.receipt(f.journal.data.completion!.payloadChecksum);
        }
        expect(operation).toBe("receipt"); return f.receipt(null);
      });
      const request = vi.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(url) === "https://api.amazon.com/auth/o2/token") {
          expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(local.clientSecret);
          return Response.json({ access_token: "synthetic-public-access", expires_in: 3600 });
        }
        return Response.json({ payload: [{ marketplace: { id: "synthetic-market", note: local.clientSecret },
          participation: { isParticipating: true, hasSuspendedListings: false } }] });
      });
      await runStoreNodeExecution({ ...f.options, amazonApplication: local, request: request as typeof fetch, shouldStop: () => finished });
      expect(finished).toBe(true); expect(request).toHaveBeenCalledTimes(2); expect(f.journal.data.completed).toBe(true);
    } finally { await f.close(); }
  });
});

async function runtimeFixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 3072 }), future = new Date(Date.now() + 120_000).toISOString();
  const base = { id: createEntityId(), nodeId: createEntityId(), accountId: createEntityId(), certificateGeneration: 1,
    authorizationGeneration: createEntityId(), bindingRevision: 1, requestId: createEntityId(), requestChecksum: "c".repeat(64), claimId: createEntityId(),
    sessionId: createEntityId(), credentialUseId: createEntityId(), credentialId: createEntityId(), credentialVersion: 1 };
  const input = { amazonProductTypes: [], etsyTaxonomyNodeIds: [], ttlHours: 24 };
  base.requestChecksum = sha(storeNodeExecutionRequestText(base.accountId, { requestId: base.requestId, requestChecksum: base.requestChecksum,
    operation: STORE_NODE_EXECUTION_OPERATION, nodeId: base.nodeId, certificateGeneration: base.certificateGeneration,
    authorizationGeneration: base.authorizationGeneration, bindingRevision: base.bindingRevision, input }));
  const sealed = createStoreNodeSealedCredential(publicSeed(), base, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  const lease: StoreNodeCapabilityLease = { ...base, protocol: STORE_NODE_EXECUTION_PROTOCOL, operation: STORE_NODE_EXECUTION_OPERATION,
    input, expiresAt: future, runExpiresAt: future, sealedCredential: sealed.sealed };
  const stop = new AbortController(), lock: StoreNodeLocalLock = { signal: new AbortController().signal, assertHeld() {}, commit: async () => {}, commitJournal: async () => {} };
  const journal = await StoreNodeExecutionJournal.create(lease, { lock, passphrase: "synthetic-public-unit-passphrase", spki: sha(pair.publicKey.export({ type: "spki", format: "der" })) });
  const request = vi.fn(async () => { throw new Error("unexpected synthetic provider request"); });
  const heartbeat: StoreNodeHeartbeatView = { protocol: STORE_NODE_PROTOCOL, nodeId: base.nodeId, accountId: base.accountId, certificateGeneration: 1,
    sessionId: base.sessionId, sequence: 1, bindingRevision: 1, bindingState: "active", authorizationGeneration: base.authorizationGeneration,
    observedAt: new Date().toISOString(), sessionExpiresAt: future, execution: "not_integrated" };
  const parent = path.resolve(tmpdir()), prefix = "yummyai-store-node-amazon-";
  await noLinks(parent);
  const directory = await mkdtemp(path.join(parent, prefix));
  const options: StoreNodeExecutionOptions = { directory,
    passphrase: "synthetic-public-unit-passphrase", identity: { protocol: STORE_NODE_PROTOCOL, nodeId: base.nodeId, accountId: base.accountId,
      certificateGeneration: 1, certificatePem: "synthetic-unused-cert", caCertificatePem: "synthetic-unused-ca", runtimeOrigin: "https://127.0.0.1:8142", expiresAt: future },
    key: pair.privateKey, encryptedPrivateKeyPem: "synthetic-unused-key", lock, signal: stop.signal, intervalMs: 1000, etsy: null,
    amazonApplication, request: request as typeof fetch, heartbeat: () => heartbeat };
  const receipt = (completionChecksum: string | null) => ({ protocol: STORE_NODE_EXECUTION_PROTOCOL, executionId: base.id, claimId: base.claimId,
    state: completionChecksum ? "failed" : "running", phase: completionChecksum ? "finished" : "collecting", checkpointChecksum: null,
    credentialVersion: 1, completionChecksum, snapshotId: null, observedAt: new Date().toISOString() });
  const close = async () => {
    sealed.key.fill(0);
    expect(path.dirname(directory)).toBe(parent);
    expect(path.basename(directory).startsWith(prefix)).toBe(true);
    await noLinks(directory);
    expect((await lstat(directory)).isDirectory()).toBe(true);
    await rm(directory, { recursive: true, force: false });
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { options, journal, lease, stop, request, receipt, transportKey: sealed.key, close };
}
