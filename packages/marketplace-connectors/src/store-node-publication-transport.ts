import { createHash } from "node:crypto";
import { PublicationPreviewNodeInputSchema, publicationPreviewPayloadText, publicationPreviewRequestText } from "@yummyai/contracts/marketplace/publication-preview";
import { STORE_NODE_EXECUTION_RESULT_BYTES, StoreNodePublicationLeaseSchema,
  type StoreNodeExecutionCredential, type StoreNodePublicationLease } from "@yummyai/contracts/marketplace/store-node-execution";
import type { StoreNodeCapabilityExchange } from "./store-node-capability-transport.js";
import { assertStoreNodeAmazonApplication, assertStoreNodeAmazonCredentialBinding, type StoreNodeAmazonApplication } from "./store-node-amazon-application.js";

export interface StoreNodePublicationTransportOptions {
  seed: StoreNodeExecutionCredential;
  lease: StoreNodePublicationLease;
  signal?: AbortSignal;
  request?: typeof fetch;
  amazonApplication?: StoreNodeAmazonApplication | null;
  exchange(request: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>): Promise<Response>;
  observeSecret?(value: string): void;
}

export class StoreNodePublicationPolicyError extends Error {
  constructor(readonly code: "store_node_policy_rejected" | "store_node_result_too_large" = "store_node_policy_rejected") {
    super(code);
  }
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const endpoints = { NA: "sellingpartnerapi-na.amazon.com", EU: "sellingpartnerapi-eu.amazon.com", FE: "sellingpartnerapi-fe.amazon.com" };

/** Check the original request before opening any platform connection, including LWA. */
export function assertStoreNodePublicationLease(lease: StoreNodePublicationLease, seed: StoreNodeExecutionCredential): void {
  const parsed = StoreNodePublicationLeaseSchema.safeParse(lease);
  if (!parsed.success) reject();
  const { input, accountId } = parsed.data;
  const { target, payload } = PublicationPreviewNodeInputSchema.parse(input);
  if (target.accountId.toLowerCase() !== accountId.toLowerCase()
    || target.nodeId.toLowerCase() !== lease.nodeId.toLowerCase()
    || target.certificateGeneration !== lease.certificateGeneration
    || target.authorizationGeneration.toLowerCase() !== lease.authorizationGeneration.toLowerCase()
    || target.bindingRevision !== lease.bindingRevision
    || sha(publicationPreviewRequestText(target)) !== lease.requestChecksum
    || sha(publicationPreviewPayloadText(payload)) !== target.payloadChecksum
    || !target.variantSkuId
    || seed.account.platform !== "amazon" || !["amazon_private", "amazon_public"].includes(seed.account.authorizationMode)
    || seed.account.region === "GLOBAL" || !seed.account.marketplaceIds.includes(target.marketplaceId)
    || !seed.account.externalAccountId || seed.account.externalAccountId !== seed.credential.sellingPartnerId
    || !seed.credential.refreshToken
    || seed.account.authorizationMode === "amazon_private" && (!seed.credential.clientId || !seed.credential.clientSecret)) reject();
  assertStoreNodeAmazonCredentialBinding(seed);
}

/** Only the original pinned application LWA exchange and one fixed validation-preview body. */
export function createStoreNodePublicationTransport(options: StoreNodePublicationTransportOptions): typeof fetch {
  assertStoreNodePublicationLease(options.lease, options.seed);
  assertStoreNodeAmazonApplication(options.seed, options.amazonApplication);
  const { seed, lease } = options, { payload } = lease.input;
  const application = seed.account.authorizationMode === "amazon_public" ? options.amazonApplication! : seed.credential;
  if (seed.account.region === "GLOBAL") reject();
  const sellerId = seed.credential.sellingPartnerId;
  if (!sellerId) reject();
  const hostname = endpoints[seed.account.region];
  const pathname = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`;
  const expectedBody = JSON.stringify({ productType: payload.productType, requirements: "LISTING", attributes: payload.attributes });
  const pending = new Map<string, Promise<Response>>();
  let accessToken: string | null = null;

  return (async (raw: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    if (typeof raw !== "string" && !(raw instanceof URL)) reject();
    let url: URL;
    try { url = new URL(String(raw)); } catch { return reject(); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port && url.port !== "443") reject();
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) reject();
    const method = (init.method ?? "GET").toUpperCase(), body = init.body?.toString() ?? "", headers = new Headers(init.headers);
    if (Buffer.byteLength(body) > STORE_NODE_EXECUTION_RESULT_BYTES) reject();
    let requestClass: StoreNodeCapabilityExchange["requestClass"];
    if (url.hostname === "api.amazon.com" && url.pathname === "/auth/o2/token" && !url.search && method === "POST") {
      const values = new URLSearchParams(body);
      if (Array.from(values.keys()).sort().join() !== "client_id,client_secret,grant_type,refresh_token"
        || values.get("grant_type") !== "refresh_token" || values.get("client_id") !== application.clientId
        || values.get("client_secret") !== application.clientSecret || values.get("refresh_token") !== seed.credential.refreshToken
        || !onlyHeaders(headers, ["content-type"]) || headers.get("content-type") !== "application/x-www-form-urlencoded;charset=UTF-8") reject();
      requestClass = "amazon_lwa";
    } else {
      const query = url.searchParams;
      if (method !== "PUT" || url.hostname !== hostname || url.pathname !== pathname
        || Array.from(query.keys()).sort().join() !== "issueLocale,marketplaceIds,mode"
        || query.get("mode") !== "VALIDATION_PREVIEW" || query.get("marketplaceIds") !== payload.marketplaceId
        || query.get("issueLocale") !== payload.locale.replace("-", "_") || body !== expectedBody
        || !onlyHeaders(headers, ["content-type", "user-agent", "x-amz-access-token", "x-amz-date"])
        || headers.get("user-agent") !== "YummyAI/0.1 (Language=TypeScript)"
        || headers.get("content-type") !== "application/json" || !accessToken || headers.get("x-amz-access-token") !== accessToken) reject();
      requestClass = "amazon_listing_validation_preview";
    }
    const stableHeaders = Array.from(headers.entries()).filter(([name]) => name !== "x-amz-date").sort(([a], [b]) => a.localeCompare(b));
    const requestDigest = sha(JSON.stringify(["store-node-publication-request-v1", requestClass, method, url.href, stableHeaders, body]));
    let response = pending.get(requestDigest);
    if (!response) {
      response = options.exchange({ requestClass, requestDigest }, async permitSignal => {
        options.signal?.throwIfAborted();
        const signals = [init.signal, options.signal, permitSignal].filter((value): value is AbortSignal => Boolean(value));
        const received = await (options.request ?? globalThis.fetch)(url, { ...init, method, redirect: "error",
          signal: signals.length ? AbortSignal.any(signals) : undefined });
        if (received.redirected || received.url && new URL(received.url).href !== url.href) {
          await received.body?.cancel(); return reject();
        }
        const bytes = await boundedResponse(received);
        try {
          return new Response(bytes.length ? new Uint8Array(bytes).buffer : null, { status: received.status,
            headers: { "content-type": received.headers.get("content-type") ?? "application/json",
              ...(received.headers.has("retry-after") ? { "retry-after": received.headers.get("retry-after")! } : {}),
              ...(received.headers.has("x-amzn-ratelimit-limit") ? { "x-amzn-ratelimit-limit": received.headers.get("x-amzn-ratelimit-limit")! } : {}) } });
        } finally { bytes.fill(0); }
      });
      pending.set(requestDigest, response);
    }
    const received = (await response).clone();
    if (requestClass === "amazon_lwa" && received.ok) {
      const rawToken: unknown = await received.clone().json().catch(() => null);
      if (!rawToken || typeof rawToken !== "object" || Array.isArray(rawToken)) reject();
      const values = rawToken as Record<string, unknown>, token = values.access_token;
      if (typeof token !== "string" || !token || token.length > 16_384) reject();
      if (accessToken !== null && accessToken !== token) reject();
      accessToken = token;
      options.observeSecret?.(token);
      for (const name of ["refresh_token", "client_secret"] as const) {
        const value = values[name];
        if (typeof value === "string" && value) options.observeSecret?.(value);
      }
    }
    return received;
  }) as typeof fetch;
}

function reject(): never { throw new StoreNodePublicationPolicyError(); }
function onlyHeaders(headers: Headers, allowed: readonly string[]): boolean {
  return Array.from(headers.keys()).every(name => allowed.includes(name));
}
async function boundedResponse(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > STORE_NODE_EXECUTION_RESULT_BYTES)) {
    await response.body?.cancel(); throw new StoreNodePublicationPolicyError("store_node_result_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const entry = await reader.read(); if (entry.done) break; total += entry.value.length;
      if (total > STORE_NODE_EXECUTION_RESULT_BYTES) { await reader.cancel(); throw new StoreNodePublicationPolicyError("store_node_result_too_large"); }
      chunks.push(entry.value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
}
