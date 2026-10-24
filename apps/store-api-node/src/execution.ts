import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { createEntityId } from "@yummyai/contracts/common/ids";
import type { StoreNodeEnrollmentResult, StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { STORE_NODE_EXECUTION_OPERATION, STORE_NODE_EXECUTION_PROTOCOL, STORE_NODE_EXECUTION_RESULT_BYTES, StoreNodeCapabilityResultSchema, StoreNodeExecutionClaimSchema,
  StoreNodeExecutionPermitSchema, StoreNodeExecutionAckSchema, StoreNodeExecutionRuntimeReceiptSchema, StoreNodeExecutionErrorSchema,
  StoreNodeExecutionCompletionPayloadSchema, storeNodeExecutionRequestText, type StoreNodeExecutionCall, type StoreNodeExecutionCredential, type StoreNodeExecutionLease,
  type StoreNodeExecutionStepInput } from "@yummyai/contracts/marketplace/store-node-execution";
import { HttpMarketplaceCapabilityGateway, MarketplaceConnectorError, StoreNodeCapabilityPolicyError, createStoreNodeCapabilityTransport, openStoreNodeSealedCredential,
  sealStoreNodeExecutionPayload, storeNodeExecutionPayloadChecksum, marketplaceCapabilityChecksum, assertStoreNodePublicationLease, StoreNodePublicationPolicyError,
  storeNodeAmazonGatewayEnvironment, StoreNodeAmazonApplicationError, type StoreNodeAmazonApplication, type StoreNodeCapabilityExchange } from "@yummyai/marketplace-connectors";
import { STORE_NODE_PUBLICATION_OPERATION } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION } from "@yummyai/contracts/marketplace/publication-submit";
import { assertStoreNodeSubmissionLease, StoreNodeSubmissionPolicyError } from "@yummyai/marketplace-connectors";
import { StoreNodeError, nodeCheck, safeStoreNodeCode } from "./error.js";
import { StoreNodeExecutionJournal, cacheStoreNodeResponse, replayStoreNodeResponse, type StoreNodeExecutionJournalRow } from "./execution-journal.js";
import { StoreNodeExecutionTransport, StoreNodeExecutionRpcError } from "./execution-transport.js";
import { assertStoreNodeExecutionApplication, type StoreNodeEtsyApplication } from "./sealed-credential.js";
import { executeStoreNodePublication } from "./publication-execution.js";
import { executeStoreNodeSubmission } from "./submission-execution.js";
import type { StoreNodeLocalLock } from "./storage.js";

export interface StoreNodeExecutionOptions {
  directory: string; passphrase: string; identity: StoreNodeEnrollmentResult; key: KeyObject; encryptedPrivateKeyPem: string;
  lock: StoreNodeLocalLock; heartbeat(): StoreNodeHeartbeatView | null; signal: AbortSignal; intervalMs: number;
  etsy: StoreNodeEtsyApplication | null; request?: typeof fetch;
  amazonApplication?: StoreNodeAmazonApplication | null;
  shouldStop?(): boolean;
  onState?(status: { state: "working" | "waiting" | "execution_finished" | "execution_blocked"; code?: string }): void;
}
const terminal = new Set(["succeeded", "failed", "cancelled", "expired", "authority_changed", "unknown_outcome"]);
export async function runStoreNodeExecution(options: StoreNodeExecutionOptions): Promise<void> {
  const transport = new StoreNodeExecutionTransport(options);
  // The journal's local encryption is bound to the same public SPKI as state.pe.
  const spki = createHash("sha256").update(createPublicKey(options.key).export({ type: "spki", format: "der" })).digest("hex");
  let journal = await StoreNodeExecutionJournal.open({ ...options, spki });
  while (!options.signal.aborted) {
    // Pending physical receipts and unique refresh checkpoints are recoverable
    // even when the heartbeat owner has already stopped new work.
    if (options.shouldStop?.() && (!journal || journal.data.completed)) break;
    try {
      const heartbeat = options.heartbeat();
      if ((!journal || journal.data.completed) && (!heartbeat || Date.parse(heartbeat.sessionExpiresAt) <= Date.now())) { await pause(options); continue; }
      if (!journal || journal.data.completed) {
        nodeCheck(heartbeat, "store_node_authority_changed");
        if (heartbeat.bindingState !== "active") { await pause(options); continue; }
        const claim = StoreNodeExecutionClaimSchema.parse(await transport.call("claim", {
          protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: options.identity.nodeId, certificateGeneration: options.identity.certificateGeneration,
          sessionId: heartbeat.sessionId, supportedAuthorizationModes: ["amazon_private", ...(options.etsy ? ["etsy_oauth"] : []),
            ...(options.amazonApplication?.clientId && options.amazonApplication.clientSecret ? ["amazon_public"] : [])],
          supportedOperations: [STORE_NODE_EXECUTION_OPERATION, STORE_NODE_PUBLICATION_OPERATION, STORE_NODE_PUBLICATION_SUBMIT_OPERATION, STORE_NODE_PUBLICATION_STATUS_OPERATION],
        }));
        if (!claim.lease) { options.onState?.({ state: "waiting" }); await pause(options); continue; }
        const lease = claim.lease;
        nodeCheck(lease.nodeId === options.identity.nodeId && lease.accountId === options.identity.accountId && lease.certificateGeneration === options.identity.certificateGeneration
          && lease.sessionId === heartbeat.sessionId && lease.authorizationGeneration === heartbeat.authorizationGeneration && lease.bindingRevision === heartbeat.bindingRevision, "store_node_authority_changed");
        journal = await StoreNodeExecutionJournal.create(lease, { ...options, spki });
      }
      nodeCheck(journal.data.lease.nodeId === options.identity.nodeId && journal.data.lease.accountId === options.identity.accountId
        && journal.data.lease.certificateGeneration === options.identity.certificateGeneration, "store_node_authority_changed");
      options.onState?.({ state: "working" });
      await executeJournal(options, journal, transport);
      if (journal.data.completed) options.onState?.({ state: "execution_finished" });
    } catch (error) {
      if (options.signal.aborted) break;
      options.onState?.({ state: "execution_blocked", code: safeCode(error) });
      if (!(error instanceof StoreNodeExecutionRpcError && error.unknownOutcome)) throw error;
    }
    if (options.shouldStop?.()) break;
    await pause(options);
  }
}
async function pause(options: StoreNodeExecutionOptions) { try { await wait(options.intervalMs, undefined, { signal: options.signal }); } catch { if (!options.signal.aborted) throw new StoreNodeError("store_node_execution_failed"); } }
function callPins(lease: StoreNodeExecutionLease): StoreNodeExecutionCall {
  return { protocol: STORE_NODE_EXECUTION_PROTOCOL, nodeId: lease.nodeId, certificateGeneration: lease.certificateGeneration, sessionId: lease.sessionId,
    executionId: lease.id, claimId: lease.claimId, requestChecksum: lease.requestChecksum };
}
async function executeJournal(options: StoreNodeExecutionOptions, journal: StoreNodeExecutionJournal, transport: StoreNodeExecutionTransport) {
  const lease = journal.data.lease, base = callPins(lease), opened = openStoreNodeSealedCredential(lease.sealedCredential, lease, options.key);
  const { payload: seed, key } = opened;
  let exchanges: Promise<void> = Promise.resolve(), exchangeStopped = false, exchangeFailure: unknown;
  try {
    if (lease.operation === STORE_NODE_PUBLICATION_OPERATION) assertStoreNodePublicationLease(lease, seed);
    else if (lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION || lease.operation === STORE_NODE_PUBLICATION_STATUS_OPERATION) assertStoreNodeSubmissionLease(lease, seed);
    else {
      const expectedRequest = storeNodeExecutionRequestText(lease.accountId, { requestId: lease.requestId, requestChecksum: lease.requestChecksum,
        operation: lease.operation, nodeId: lease.nodeId, certificateGeneration: lease.certificateGeneration, authorizationGeneration: lease.authorizationGeneration,
        bindingRevision: lease.bindingRevision, input: lease.input });
      nodeCheck(createHash("sha256").update(expectedRequest).digest("hex") === lease.requestChecksum, "store_node_policy_rejected");
    }
    for (const row of journal.data.rows) {
      if (row.stepAcknowledged || !row.permit) continue;
      if (row.state === "submitted") await journal.update(() => { row.state = "unknown"; });
      if (row.response || row.state === "unknown" || row.state === "not_sent") await reportStep(row);
    }
    if (lease.operation === STORE_NODE_EXECUTION_OPERATION && !journal.data.checkpoint && seed.account.platform === "etsy"
      && journal.data.rows.some(row => row.requestClass === "etsy_refresh" && row.response)) {
      await recoverCachedRefresh();
    }
    if (journal.data.checkpoint && !journal.data.checkpointAcknowledged) await checkpoint();
    const receipt = StoreNodeExecutionRuntimeReceiptSchema.parse(await transport.call("receipt", base)); checkReceipt(receipt, lease);
    if (journal.data.checkpoint && receipt.checkpointChecksum === journal.data.checkpoint.payloadChecksum) await journal.update(data => { data.checkpointAcknowledged = true; });
    if (journal.data.checkpoint && !journal.data.checkpointAcknowledged) await checkpoint();
    if (journal.data.completion && receipt.completionChecksum === journal.data.completion.payloadChecksum || terminal.has(receipt.state)) {
      await journal.update(data => { data.completed = true; }); return;
    }
    if (journal.data.completion) { await complete(); return; }
    const secrets = secretValues(seed, options.etsy, options.amazonApplication);
    try {
      assertStoreNodeExecutionApplication(seed, options.etsy, options.amazonApplication);
      if (lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION || lease.operation === STORE_NODE_PUBLICATION_STATUS_OPERATION) {
        const result = await executeStoreNodeSubmission({ seed, lease, signal: options.signal, request: options.request, exchange, amazonApplication: options.amazonApplication,
          observeSecret: value => { if (value) secrets.add(value); } });
        await storeCompletion({ outcome: lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION ? "publication_submit" : "publication_status", result });
      } else if (lease.operation === STORE_NODE_PUBLICATION_OPERATION) {
        // Cached physical responses may finish their original receipt even after
        // local work stops. exchangeOnce still fences every new platform I/O.
        const result = await executeStoreNodePublication({ seed, lease, signal: options.signal, request: options.request, exchange, amazonApplication: options.amazonApplication,
          observeSecret: value => { if (value) secrets.add(value); } });
        await storeCompletion({ outcome: "publication_validation", result });
      } else {
        assertLive();
        const guardedRequest = createStoreNodeCapabilityTransport({ seed, input: lease.input, signal: options.signal, request: options.request,
          exchange, amazonApplication: options.amazonApplication, observeSecret: value => { if (value) secrets.add(value); } });
        const request: typeof fetch = async (...args) => {
          try { return await guardedRequest(...args); }
          catch (error) {
            // Policy checks after a received response run outside exchange(). Keep
            // this trusted class before the original gateway translates fetch errors.
            if (error instanceof StoreNodeCapabilityPolicyError && !exchangeStopped) { exchangeStopped = true; exchangeFailure = error; }
            throw error;
          }
        };
        const environment = { ...(options.etsy ? { ETSY_APP_KEYSTRING: options.etsy.keystring, ETSY_APP_SHARED_SECRET: options.etsy.sharedSecret } : {}),
          ...storeNodeAmazonGatewayEnvironment(seed, options.amazonApplication) };
        const result = await new HttpMarketplaceCapabilityGateway(request, environment).sync(seed.account, seed.credential, lease.input, {
          beforeCredentialRefresh: async () => { assertLive(); },
          beforeRead: async () => { assertLive(); if (seed.account.platform === "etsy") nodeCheck(journal.data.checkpointAcknowledged, "store_node_operation_unknown"); },
          checkpointCredential: async (credential, expiresAt) => {
            if (!journal.data.checkpoint) {
              const payload = sealStoreNodeExecutionPayload({ credential, expiresAt: expiresAt.toISOString() }, key, lease, "checkpoint");
              await journal.update(data => { data.checkpoint = { ...base, originalCredentialVersion: lease.credentialVersion, payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) }; });
            }
            await checkpoint();
          },
        });
        const projected = StoreNodeCapabilityResultSchema.parse({ capabilities: [...result.capabilities], data: result.data, expiresAt: result.expiresAt.toISOString(),
          externalAccountId: result.externalAccountId, healthStatus: result.healthStatus, issues: [...result.issues], marketplaceIds: [...result.marketplaceIds],
          sourceChecksum: result.sourceChecksum, sourceVersion: result.sourceVersion, syncedAt: result.syncedAt.toISOString() });
        const text = JSON.stringify(projected);
        nodeCheck(Buffer.byteLength(text) <= STORE_NODE_EXECUTION_RESULT_BYTES, "store_node_result_too_large");
        nodeCheck(![...secrets].some(value => text.includes(value) || text.includes(JSON.stringify(value).slice(1, -1))), "store_node_secret_output_rejected");
        nodeCheck(marketplaceCapabilityChecksum(projected.data) === projected.sourceChecksum, "store_node_execution_failed");
        await storeCompletion({ outcome: "success", result: projected });
      }
    } catch (error) {
      await exchanges;
      const failure = exchangeStopped ? exchangeFailure : error;
      // A lost RPC is recovered using the same persisted bytes before touching
      // another provider request. It is not a provider retry permission.
      // The original connector translates fetch errors; retain the adapter's
      // exact internal RPC classification instead of treating that as a platform failure.
      if (failure instanceof StoreNodeExecutionRpcError) throw failure;
      if (options.signal.aborted) throw failure;
      const unknown = journal.data.rows.some(row => row.state === "unknown" || row.state === "submitted")
        || lease.operation === STORE_NODE_PUBLICATION_SUBMIT_OPERATION && (failure instanceof MarketplaceConnectorError && failure.outcomeUncertain
          || journal.data.rows.some(row => row.requestClass === "amazon_listing_submit" && row.response && row.response.status >= 200 && row.response.status < 300));
      await storeCompletion({ outcome: unknown ? "unknown" : "failure", code: unknown ? "store_node_operation_unknown" : safeCode(failure) });
    }
    await complete();

    function assertLive() {
      options.signal.throwIfAborted(); options.lock.assertHeld();
      nodeCheck(!options.shouldStop?.(), "store_node_authority_changed");
      nodeCheck(Date.parse(lease.runExpiresAt) > Date.now() && Date.parse(lease.expiresAt) > Date.now(), "store_node_execution_expired");
    }
    function exchange(request: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>): Promise<Response> {
      // The original owner may request independent documents in parallel. Each
      // physical request still owns one ordered online permit and receipt.
      const operation = exchanges.then(() => {
        if (exchangeStopped) throw exchangeFailure;
        return exchangeOnce(request, send);
      });
      exchanges = operation.then(() => undefined, error => { exchangeStopped = true; exchangeFailure = error; });
      return operation;
    }
    async function exchangeOnce(request: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>): Promise<Response> {
      let row = journal.data.rows.find(value => value.requestDigest === request.requestDigest);
      if (!row && (request.requestClass === "etsy_refresh" || request.requestClass === "amazon_lwa" || request.requestClass === "amazon_listing_validation_preview"
        || request.requestClass === "amazon_listing_submit" || request.requestClass === "amazon_listing_status"))
        nodeCheck(!journal.data.rows.some(value => value.requestClass === request.requestClass), "store_node_policy_rejected");
      if (!row) row = await journal.update(data => {
        nodeCheck(data.rows.length < 128, "store_node_policy_rejected");
        const value: StoreNodeExecutionJournalRow = { stepId: createEntityId(), ordinal: data.rows.length + 1, requestClass: request.requestClass,
          requestDigest: request.requestDigest, state: "prepared", permit: null, response: null, stepAcknowledged: false }; data.rows.push(value); return value;
      });
      nodeCheck(row.requestClass === request.requestClass, "store_node_policy_rejected");
      if (row.state === "unknown" || row.state === "submitted") throw new StoreNodeError("store_node_operation_unknown");
      if (row.state === "not_sent") throw new StoreNodeError("store_node_execution_expired");
      if (!row.response) {
        assertLive();
        if (!row.permit) {
          const permit = StoreNodeExecutionPermitSchema.parse(await transport.call("permit", { ...base, stepId: row.stepId, ordinal: row.ordinal, requestClass: row.requestClass, requestDigest: row.requestDigest }));
          nodeCheck(permit.executionId === lease.id && permit.claimId === lease.claimId && permit.stepId === row.stepId && permit.requestDigest === row.requestDigest, "store_node_policy_rejected");
          await journal.update(() => { row!.permit = permit; });
        }
        if (Date.parse(row.permit!.expiresAt) <= Date.now()) {
          await journal.update(() => { row!.state = "not_sent"; }); await reportStep(row); throw new StoreNodeError("store_node_execution_expired");
        }
        await journal.update(() => { row!.state = "submitted"; });
        try {
          const remaining = Math.min(20000, Date.parse(row.permit!.expiresAt) - Date.now(), Date.parse(lease.runExpiresAt) - Date.now());
          nodeCheck(remaining > 0, "store_node_execution_expired");
          const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
          // The wrapper also has the original provider's 20s abort. The outer
          // permit deadline is checked before acceptance; abort on shutdown is shared.
          try {
            const received = await send(controller.signal); options.signal.throwIfAborted();
            nodeCheck(!controller.signal.aborted, "store_node_operation_unknown");
            const cached = await cacheStoreNodeResponse(received);
            await journal.update(() => { row!.response = { status: cached.status, contentType: cached.contentType, retryAfter: cached.retryAfter, body: cached.body,
              ...(cached.amazonRateLimit !== undefined ? { amazonRateLimit: cached.amazonRateLimit } : {}) }; row!.state = "received"; });
          } finally { clearTimeout(timer); }
        } catch (error) {
          await journal.update(() => { row!.state = "unknown"; });
          try { await reportStep(row); } catch { /* original unknown remains durable */ }
          throw error;
        }
      }
      if (!row.stepAcknowledged) await reportStep(row);
      return replayStoreNodeResponse(row.response!);
    }
    async function reportStep(row: StoreNodeExecutionJournalRow) {
      nodeCheck(row.permit, "store_node_operation_unknown");
      const payload: StoreNodeExecutionStepInput = { ...base, stepId: row.stepId, permitId: row.permit.permitId, requestDigest: row.requestDigest,
        outcome: row.response ? "received" : row.state === "not_sent" ? "not_sent" : "unknown", httpStatus: row.response?.status ?? null,
        responseDigest: row.response ? createHash("sha256").update(Buffer.from(row.response.body, "base64")).digest("hex") : null };
      const ack = StoreNodeExecutionAckSchema.parse(await transport.call("step", payload));
      nodeCheck(ack.executionId === lease.id && ack.claimId === lease.claimId, "store_node_operation_unknown");
      await journal.update(() => { row.stepAcknowledged = true; });
    }
    async function checkpoint() {
      if (journal.data.checkpointAcknowledged) return;
      nodeCheck(journal.data.checkpoint, "store_node_operation_unknown");
      const ack = StoreNodeExecutionRuntimeReceiptSchema.parse(await transport.call("checkpoint", journal.data.checkpoint)); checkReceipt(ack, lease);
      nodeCheck(ack.checkpointChecksum === journal.data.checkpoint.payloadChecksum && ack.credentialVersion === lease.credentialVersion + 1, "store_node_operation_unknown");
      await journal.update(data => { data.checkpointAcknowledged = true; });
    }
    async function recoverCachedRefresh() {
      nodeCheck(lease.operation === STORE_NODE_EXECUTION_OPERATION, "store_node_policy_rejected");
      assertStoreNodeExecutionApplication(seed, options.etsy);
      const recovered = new Error("store_node_cached_checkpoint_finished");
      const request = createStoreNodeCapabilityTransport({ seed, input: lease.input,
        exchange: async metadata => {
          const row = journal.data.rows.find(value => value.requestDigest === metadata.requestDigest && value.requestClass === "etsy_refresh" && value.response);
          nodeCheck(row?.response, "store_node_operation_unknown");
          if (!row.stepAcknowledged) await reportStep(row);
          return replayStoreNodeResponse(row.response);
        } });
      try {
        await new HttpMarketplaceCapabilityGateway(request, { ETSY_APP_KEYSTRING: options.etsy!.keystring, ETSY_APP_SHARED_SECRET: options.etsy!.sharedSecret })
          .sync(seed.account, seed.credential, lease.input, { beforeCredentialRefresh: async () => {}, beforeRead: async () => { throw recovered; },
            checkpointCredential: async (credential, expiresAt) => {
              const payload = sealStoreNodeExecutionPayload({ credential, expiresAt: expiresAt.toISOString() }, key, lease, "checkpoint");
              await journal.update(data => { data.checkpoint = { ...base, originalCredentialVersion: lease.credentialVersion, payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) }; });
              await checkpoint(); throw recovered;
            } });
      } catch (error) { if (error !== recovered) throw error; }
    }
    async function storeCompletion(raw: unknown) {
      const value = StoreNodeExecutionCompletionPayloadSchema.parse(raw);
      const payload = sealStoreNodeExecutionPayload(value, key, lease, "completion");
      await journal.update(data => { data.completion = { ...base, payload, payloadChecksum: storeNodeExecutionPayloadChecksum(payload) }; });
    }
    async function complete() {
      nodeCheck(journal.data.completion, "store_node_operation_unknown");
      const ack = StoreNodeExecutionRuntimeReceiptSchema.parse(await transport.call("complete", journal.data.completion)); checkReceipt(ack, lease);
      nodeCheck(ack.completionChecksum === journal.data.completion.payloadChecksum, "store_node_operation_unknown");
      await journal.update(data => { data.completed = true; });
    }
  } finally { key.fill(0); }
}
function checkReceipt(value: { executionId: string; claimId: string }, lease: StoreNodeExecutionLease) { nodeCheck(value.executionId === lease.id && value.claimId === lease.claimId, "store_node_operation_unknown"); }
function safeCode(error: unknown) {
  if (error instanceof StoreNodeCapabilityPolicyError || error instanceof StoreNodePublicationPolicyError || error instanceof StoreNodeSubmissionPolicyError || error instanceof StoreNodeAmazonApplicationError) return error.code;
  if (error instanceof MarketplaceConnectorError) return ({ authorization: "store_node_upstream_authorization", validation: "store_node_upstream_validation", conflict: "store_node_policy_rejected",
    rate_limited: "store_node_upstream_rate_limited", upstream_retryable: "store_node_upstream_retryable", upstream_terminal: "store_node_upstream_terminal" } as const)[error.code];
  const value = StoreNodeExecutionErrorSchema.safeParse(safeStoreNodeCode(error)); return value.success ? value.data : "store_node_execution_failed";
}
function secretValues(seed: StoreNodeExecutionCredential, etsy: StoreNodeEtsyApplication | null, amazonApplication?: StoreNodeAmazonApplication | null): Set<string> {
  const values = Object.entries(seed.credential).filter(([name, value]) => /token|secret|password/i.test(name) && value).map(([, value]) => value);
  if (etsy) values.push(etsy.sharedSecret, `${etsy.keystring}:${etsy.sharedSecret}`);
  if (amazonApplication) values.push(amazonApplication.clientSecret);
  return new Set(values);
}
