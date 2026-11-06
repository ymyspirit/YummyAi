import { createHash } from "node:crypto";
import { orderSyncNodeRequestText } from "@yummyai/contracts/order/sync";
import { STORE_NODE_EXECUTION_RESULT_BYTES, StoreNodeOrderSyncLeaseSchema,
  type StoreNodeExecutionCredential, type StoreNodeOrderSyncLease } from "@yummyai/contracts/marketplace/store-node-execution";
import { assertStoreNodeAmazonApplication, assertStoreNodeAmazonCredentialBinding, type StoreNodeAmazonApplication } from "./store-node-amazon-application.js";
import type { StoreNodeCapabilityExchange } from "./store-node-capability-transport.js";

export interface StoreNodeOrdersTransportOptions {
  seed: StoreNodeExecutionCredential; lease: StoreNodeOrderSyncLease; signal?: AbortSignal; request?: typeof fetch;
  amazonApplication?: StoreNodeAmazonApplication | null;
  exchange(request: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>): Promise<Response>;
  observeSecret?(value: string): void;
}
export class StoreNodeOrdersPolicyError extends Error {
  constructor(readonly code: "store_node_policy_rejected" | "store_node_result_too_large" = "store_node_policy_rejected") { super(code); }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const endpoints = { NA: "sellingpartnerapi-na.amazon.com", EU: "sellingpartnerapi-eu.amazon.com", FE: "sellingpartnerapi-fe.amazon.com" };
function reject(): never { throw new StoreNodeOrdersPolicyError(); }
export function assertStoreNodeOrdersLease(lease: StoreNodeOrderSyncLease, seed: StoreNodeExecutionCredential) {
  const value = StoreNodeOrderSyncLeaseSchema.parse(lease);
  if (sha(orderSyncNodeRequestText(value.accountId, value, value.input)) !== value.requestChecksum
    || seed.account.platform !== "amazon" || !["amazon_private", "amazon_public"].includes(seed.account.authorizationMode)
    || seed.account.region === "GLOBAL" || !seed.account.marketplaceIds.length || seed.account.marketplaceIds.length > 50
    || !seed.account.externalAccountId || seed.account.externalAccountId !== seed.credential.sellingPartnerId || !seed.credential.refreshToken
    || seed.account.authorizationMode === "amazon_private" && (!seed.credential.clientId || !seed.credential.clientSecret)) reject();
  assertStoreNodeAmazonCredentialBinding(seed);
}

/** One original token request and one fixed orders page; no writes, redirects or arbitrary URLs. */
export function createStoreNodeOrdersTransport(options: StoreNodeOrdersTransportOptions): typeof fetch {
  assertStoreNodeOrdersLease(options.lease, options.seed);
  assertStoreNodeAmazonApplication(options.seed, options.amazonApplication);
  const { seed, lease } = options, application = seed.account.authorizationMode === "amazon_public" ? options.amazonApplication! : seed.credential;
  if (seed.account.region === "GLOBAL") reject();
  const hostname = endpoints[seed.account.region], input = lease.input.request;
  const expected = new URLSearchParams({ marketplaceIds: seed.account.marketplaceIds.join(","), lastUpdatedAfter: input.updatedAfter,
    lastUpdatedBefore: input.updatedBefore, maxResultsPerPage: String(input.pageSize), includedData: "BUYER,RECIPIENT,PROCEEDS,CANCELLATION,FULFILLMENT" });
  if (input.checkpoint.cursor) expected.set("paginationToken", input.checkpoint.cursor);
  const pending = new Map<string, Promise<Response>>();
  let accessToken: string | null = null;
  return (async (raw: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    if (typeof raw !== "string" && !(raw instanceof URL)) reject();
    let url: URL; try { url = new URL(String(raw)); } catch { return reject(); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") reject();
    if (init.body != null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) reject();
    const method = (init.method ?? "GET").toUpperCase(), body = init.body?.toString() ?? "", headers = new Headers(init.headers);
    if (Buffer.byteLength(body) > STORE_NODE_EXECUTION_RESULT_BYTES) reject();
    let requestClass: StoreNodeCapabilityExchange["requestClass"];
    if (url.hostname === "api.amazon.com" && url.pathname === "/auth/o2/token" && !url.search && method === "POST") {
      const values = new URLSearchParams(body);
      if (Array.from(values.keys()).sort().join() !== "client_id,client_secret,grant_type,refresh_token"
        || values.get("grant_type") !== "refresh_token" || values.get("client_id") !== application.clientId
        || values.get("client_secret") !== application.clientSecret || values.get("refresh_token") !== seed.credential.refreshToken
        || Array.from(headers.keys()).some(name => name !== "content-type") || headers.get("content-type") !== "application/x-www-form-urlencoded;charset=UTF-8") reject();
      requestClass = "amazon_lwa";
    } else {
      const keys = Array.from(expected.keys());
      if (url.hostname !== hostname || url.pathname !== "/orders/2026-01-01/orders" || method !== "GET" || body || !accessToken
        || headers.get("x-amz-access-token") !== accessToken || headers.get("user-agent") !== "YummyAI/0.1 (Language=TypeScript)"
        || Array.from(headers.keys()).some(name => !["user-agent", "x-amz-access-token", "x-amz-date"].includes(name))
        || Array.from(url.searchParams.keys()).sort().join() !== keys.sort().join()
        || keys.some(name => url.searchParams.get(name) !== expected.get(name))) reject();
      requestClass = "amazon_orders";
    }
    const stableHeaders = Array.from(headers.entries()).filter(([name]) => name !== "x-amz-date").sort(([a], [b]) => a.localeCompare(b));
    const requestDigest = sha(JSON.stringify([lease.operation, requestClass, method, url.href, stableHeaders, body]));
    let response = pending.get(requestDigest);
    if (!response) {
      response = options.exchange({ requestClass, requestDigest }, async permitSignal => {
        options.signal?.throwIfAborted();
        const signals = [init.signal, options.signal, permitSignal].filter((value): value is AbortSignal => Boolean(value));
        const received = await (options.request ?? globalThis.fetch)(url, { ...init, method, redirect: "error",
          signal: signals.length ? AbortSignal.any(signals) : undefined });
        if (received.redirected || received.url && new URL(received.url).href !== url.href) { await received.body?.cancel(); return reject(); }
        const length = received.headers.get("content-length");
        if (length && (!/^\d+$/.test(length) || Number(length) > STORE_NODE_EXECUTION_RESULT_BYTES)) {
          await received.body?.cancel(); throw new StoreNodeOrdersPolicyError("store_node_result_too_large");
        }
        const reader = received.body?.getReader(), chunks: Uint8Array[] = []; let total = 0;
        try {
          if (reader) while (true) {
            const part = await reader.read(); if (part.done) break; total += part.value.length; chunks.push(part.value);
            if (total > STORE_NODE_EXECUTION_RESULT_BYTES) { await reader.cancel(); throw new StoreNodeOrdersPolicyError("store_node_result_too_large"); }
          }
          return new Response(total ? Buffer.concat(chunks) : null, { status: received.status,
            headers: { "content-type": received.headers.get("content-type") ?? "application/json",
              ...(received.headers.has("retry-after") ? { "retry-after": received.headers.get("retry-after")! } : {}) } });
        } finally { reader?.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
      });
      pending.set(requestDigest, response);
    }
    const received = (await response).clone();
    if (requestClass === "amazon_lwa" && received.ok) {
      const token: unknown = await received.clone().json().catch(() => null);
      if (!token || typeof token !== "object" || !("access_token" in token) || typeof token.access_token !== "string"
        || !token.access_token || token.access_token.length > 16_384 || accessToken !== null && accessToken !== token.access_token) reject();
      accessToken = token.access_token; options.observeSecret?.(accessToken);
    }
    return received;
  }) as typeof fetch;
}
