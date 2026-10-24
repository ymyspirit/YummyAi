import { createHash, createPublicKey, sign } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { STORE_NODE_PROTOCOL, StoreNodeEnrollmentResultSchema, StoreNodeHeartbeatInputSchema, StoreNodeHeartbeatViewSchema,
  storeNodeEnrollmentProofText, type StoreNodeHeartbeatView } from "@yummyai/contracts/marketplace/store-node";
import { nodeCheck, safeStoreNodeCode, StoreNodeError } from "./error.js";
import { generateStoreNodeKeys, loadStoreNodeKey, openStoreNodeState, sealStoreNodeState, storeNodeSpki,
  validateStoreNodeBundle, validateStoreNodeIdentity } from "./identity.js";
import { createStoreNodeFile, noLinks, readStoreNodeFile, withStoreNodeLock, type StoreNodeLocalLock } from "./storage.js";
import { storeNodePost } from "./transport.js";
import { runStoreNodeExecution, type StoreNodeExecutionOptions } from "./execution.js";
import type { StoreNodeAmazonApplication, StoreNodeEtsyApplication } from "./sealed-credential.js";

const StateSchema = z.object({ version: z.literal(1), publicKeySpkiSha256: z.string().regex(/^[a-f0-9]{64}$/),
  enrollmentPending: z.boolean(), identity: StoreNodeEnrollmentResultSchema.nullable(),
  pending: StoreNodeHeartbeatInputSchema.nullable(), last: StoreNodeHeartbeatViewSchema.nullable() }).strict();
type State = z.infer<typeof StateSchema>;
export interface StoreNodeIdentityOptions { directory: string; passphrase: string }
export interface StoreNodeStatus { state: "initialized" | "enrolled" | "online" | "offline" | "stopped"; execution: "not_integrated"; publicKeySpkiSha256?: string; sequence?: number; code?: string }
export async function initializeStoreNode(options: StoreNodeIdentityOptions): Promise<StoreNodeStatus> {
  return withStoreNodeLock(options.directory, async lock => {
    const keys = await generateStoreNodeKeys(options.passphrase); lock.assertHeld();
    await createStoreNodeFile(options.directory, "private-key.pem", keys.privateKeyPem);
    await createStoreNodeFile(options.directory, "public-key.pem", keys.publicKeyPem);
    const state: State = { version: 1, publicKeySpkiSha256: keys.publicKeySpkiSha256, enrollmentPending: false, identity: null, pending: null, last: null };
    await save(lock, state, options.passphrase);
    return { state: "initialized", execution: "not_integrated", publicKeySpkiSha256: keys.publicKeySpkiSha256 };
  });
}
async function load(options: StoreNodeIdentityOptions) {
  const publicBytes = await readStoreNodeFile(options.directory, "public-key.pem"), privateBytes = await readStoreNodeFile(options.directory, "private-key.pem");
  try {
    const publicKeyPem = publicBytes.toString("utf8"), encryptedPrivateKeyPem = privateBytes.toString("utf8"),
      key = loadStoreNodeKey(publicKeyPem, encryptedPrivateKeyPem, options.passphrase), spki = storeNodeSpki(key);
    const encrypted = await readStoreNodeFile(options.directory, "state.pe");
    try {
      const state = StateSchema.parse(await openStoreNodeState(encrypted, options.passphrase, spki));
      nodeCheck(state.publicKeySpkiSha256 === spki);
      return { publicKeyPem, encryptedPrivateKeyPem, key, state };
    } finally { encrypted.fill(0); }
  } catch { throw new StoreNodeError("store_node_identity_invalid"); }
  finally { privateBytes.fill(0); publicBytes.fill(0); }
}
async function save(lock: StoreNodeLocalLock, state: State, passphrase: string) {
  const cipher = await sealStoreNodeState(StateSchema.parse(state), passphrase, state.publicKeySpkiSha256);
  try { await lock.commit(cipher); } finally { cipher.fill(0); }
}
export async function enrollStoreNode(options: StoreNodeIdentityOptions & { bundlePath: string; signal?: AbortSignal }): Promise<StoreNodeStatus> {
  return withStoreNodeLock(options.directory, async lock => {
    const { key, publicKeyPem, state } = await load(options);
    const signal = options.signal ? AbortSignal.any([options.signal, lock.signal]) : lock.signal;
    signal.throwIfAborted(); await noLinks(options.bundlePath);
    const stat = await lstat(options.bundlePath); nodeCheck(stat.isFile() && stat.size <= 32768, "store_node_enrollment_invalid");
    const bytes = await readFile(options.bundlePath);
    let raw: unknown;
    try { nodeCheck(bytes.length <= 32768, "store_node_enrollment_invalid"); raw = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)); }
    finally { bytes.fill(0); }
    const bundle = validateStoreNodeBundle(raw, state.publicKeySpkiSha256);
    if (state.identity) nodeCheck(bundle.nodeId === state.identity.nodeId && bundle.accountId === state.identity.accountId
      && bundle.certificateGeneration > state.identity.certificateGeneration, "store_node_reissue_required");
    state.enrollmentPending = true; await save(lock, state, options.passphrase);
    const signature = sign("sha256", Buffer.from(storeNodeEnrollmentProofText(bundle.nodeId,
      createHash("sha256").update(bundle.ticketToken).digest("hex"), state.publicKeySpkiSha256)), key).toString("base64url");
    const response = await storeNodePost({ origin: bundle.enrollmentOrigin, path: "/v1/store-nodes/enroll", caCertificatePem: bundle.caCertificatePem,
      body: { protocol: STORE_NODE_PROTOCOL, nodeId: bundle.nodeId, ticketToken: bundle.ticketToken, publicKeyPem, signature }, signal });
    const identity = validateStoreNodeIdentity(response, key);
    nodeCheck(identity.nodeId === bundle.nodeId && identity.accountId === bundle.accountId && identity.certificateGeneration === bundle.certificateGeneration
      && identity.caCertificatePem === bundle.caCertificatePem && identity.runtimeOrigin === bundle.runtimeOrigin, "store_node_enrollment_invalid");
    signal.throwIfAborted(); lock.assertHeld();
    state.identity = identity; state.enrollmentPending = false; state.pending = null; state.last = null;
    await save(lock, state, options.passphrase);
    return { state: "enrolled", execution: "not_integrated", publicKeySpkiSha256: storeNodeSpki(createPublicKey(key)) };
  });
}
export async function runStoreNode(options: StoreNodeIdentityOptions & { signal?: AbortSignal; intervalMs?: number; onState?: (status: StoreNodeStatus) => void }): Promise<void> {
  return runNode(options);
}
export async function workStoreNode(options: StoreNodeIdentityOptions & { signal?: AbortSignal; intervalMs?: number; onState?: (status: StoreNodeStatus) => void;
  etsy?: StoreNodeEtsyApplication | null; amazonApplication?: StoreNodeAmazonApplication | null;
  request?: typeof fetch; onExecutionState?: StoreNodeExecutionOptions["onState"] }): Promise<void> {
  return runNode(options, { etsy: options.etsy ?? null, amazonApplication: options.amazonApplication ?? null, request: options.request, onState: options.onExecutionState });
}
async function runNode(options: StoreNodeIdentityOptions & { signal?: AbortSignal; intervalMs?: number; onState?: (status: StoreNodeStatus) => void },
  execution?: Pick<StoreNodeExecutionOptions, "etsy" | "amazonApplication" | "request" | "onState">): Promise<void> {
  const intervalMs = options.intervalMs ?? 10000; nodeCheck(Number.isInteger(intervalMs) && intervalMs >= 1000 && intervalMs <= 60000, "store_node_arguments_invalid");
  await withStoreNodeLock(options.directory, async lock => {
    const { key, state, encryptedPrivateKeyPem } = await load(options);
    nodeCheck(!state.enrollmentPending && state.identity, "store_node_reissue_required");
    const workerStop = new AbortController();
    const identity = validateStoreNodeIdentity(state.identity, key), signal = AbortSignal.any([lock.signal, workerStop.signal, ...(options.signal ? [options.signal] : [])]);
    if (state.last) checkResponse(state.last, identity, state.last.sessionId, state.last.sequence);
    if (state.pending) nodeCheck(state.pending.nodeId === identity.nodeId && state.pending.certificateGeneration === identity.certificateGeneration
      && (state.last ? state.pending.sessionId === state.last.sessionId && state.pending.sequence === state.last.sequence + 1 : state.pending.sequence === 1), "store_node_identity_invalid");
    let acknowledgedHeartbeat: StoreNodeHeartbeatView | null = null;
    const heartbeatLoop = async () => { try {
      while (!signal.aborted) {
        validateStoreNodeIdentity(identity, key); lock.assertHeld();
        if (!state.pending) {
          const sequence = (state.last?.sequence ?? 0) + 1; nodeCheck(sequence <= 2147483647, "store_node_reissue_required");
          state.pending = StoreNodeHeartbeatInputSchema.parse({ protocol: STORE_NODE_PROTOCOL, nodeId: identity.nodeId,
            certificateGeneration: identity.certificateGeneration, sessionId: state.last?.sessionId ?? createEntityId(), sequence });
          await save(lock, state, options.passphrase);
        }
        const pending = state.pending;
        try {
          const raw = await storeNodePost({ origin: identity.runtimeOrigin, path: "/v1/store-nodes/runtime/heartbeat", caCertificatePem: identity.caCertificatePem,
            certificatePem: identity.certificatePem, encryptedPrivateKeyPem, passphrase: options.passphrase, body: pending, signal });
          const parsed = StoreNodeHeartbeatViewSchema.safeParse(raw); nodeCheck(parsed.success, "store_node_response_invalid");
          const response = parsed.data; checkResponse(response, identity, pending.sessionId, pending.sequence);
          nodeCheck(!state.last || response.bindingRevision >= state.last.bindingRevision, "store_node_response_invalid");
          signal.throwIfAborted(); lock.assertHeld(); state.last = response; state.pending = null;
          await save(lock, state, options.passphrase);
          acknowledgedHeartbeat = response;
          options.onState?.({ state: "online", execution: "not_integrated", sequence: response.sequence });
        } catch (error) {
          acknowledgedHeartbeat = null;
          if (signal.aborted) break;
          const code = safeStoreNodeCode(error);
          if (["store_node_reissue_required", "store_node_authority_rejected", "store_node_storage_unavailable", "store_node_identity_invalid", "store_node_response_invalid"].includes(code)) throw error;
          options.onState?.({ state: "offline", execution: "not_integrated", code });
        }
        try { await wait(intervalMs, undefined, { signal }); } catch { if (!signal.aborted) throw new StoreNodeError("store_node_unavailable"); }
      }
    } finally { options.onState?.({ state: "stopped", execution: "not_integrated" }); } };
    if (!execution) await heartbeatLoop();
    else {
      let heartbeatFailure: unknown, executionFailure: unknown, stopNewWork = false;
      const heartbeat = heartbeatLoop().catch(error => { heartbeatFailure = error; stopNewWork = true; });
      const worker = runStoreNodeExecution({ ...options, ...execution, directory: options.directory, passphrase: options.passphrase,
        identity, key, encryptedPrivateKeyPem, lock, signal, intervalMs, heartbeat: () => acknowledgedHeartbeat, shouldStop: () => stopNewWork, onState: execution.onState })
        .catch(error => { executionFailure = error; workerStop.abort(); });
      // Lost membership stops the next operation, but does not abort a submitted
      // refresh before its unique returned token can reach the checkpoint owner.
      await Promise.all([heartbeat, worker]);
      if (heartbeatFailure) throw heartbeatFailure; if (executionFailure) throw executionFailure;
    }
    if (lock.signal.aborted) throw new StoreNodeError("store_node_storage_unavailable");
  });
}
function checkResponse(response: StoreNodeHeartbeatView, identity: z.infer<typeof StoreNodeEnrollmentResultSchema>, sessionId: string, sequence: number) {
  nodeCheck(response.nodeId === identity.nodeId && response.accountId === identity.accountId && response.certificateGeneration === identity.certificateGeneration
    && response.sessionId === sessionId && response.sequence === sequence && Date.parse(response.sessionExpiresAt) > Date.parse(response.observedAt), "store_node_response_invalid");
}
