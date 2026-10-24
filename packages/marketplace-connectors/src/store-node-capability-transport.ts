import { createHash } from "node:crypto";
import { STORE_NODE_EXECUTION_RESULT_BYTES, type StoreNodeExecutionCredential, type StoreNodeExecutionRequestClass } from "@yummyai/contracts/marketplace/store-node-execution";
import type { SyncMarketplaceCapabilitiesInput } from "@yummyai/contracts";
import { assertStoreNodeAmazonApplication, type StoreNodeAmazonApplication } from "./store-node-amazon-application.js";

export interface StoreNodeCapabilityExchange { requestClass: StoreNodeExecutionRequestClass; requestDigest: string }
export interface StoreNodeCapabilityTransportOptions {
  seed: StoreNodeExecutionCredential; input: SyncMarketplaceCapabilitiesInput; signal?: AbortSignal; request?: typeof fetch;
  amazonApplication?: StoreNodeAmazonApplication | null;
  exchange(request: StoreNodeCapabilityExchange, send: (signal?: AbortSignal) => Promise<Response>): Promise<Response>;
  observeSecret?(value: string): void;
}
export class StoreNodeCapabilityPolicyError extends Error {
  constructor(readonly code: "store_node_policy_rejected" | "store_node_result_too_large" = "store_node_policy_rejected") { super(code); }
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** A transport for the original capability parser. It is not a URL proxy. */
export function createStoreNodeCapabilityTransport(options: StoreNodeCapabilityTransportOptions): typeof fetch {
  const derived = new Map<string, StoreNodeExecutionRequestClass>();
  const pending = new Map<string, Promise<Response>>();
  let shopId: string | null = null;
  const { seed, input } = options;
  assertStoreNodeAmazonApplication(seed, options.amazonApplication);
  const application = seed.account.authorizationMode === "amazon_public" ? options.amazonApplication! : seed.credential;
  const endpoint = { NA: "sellingpartnerapi-na.amazon.com", EU: "sellingpartnerapi-eu.amazon.com", FE: "sellingpartnerapi-fe.amazon.com" };
  const reject = (): never => { throw new StoreNodeCapabilityPolicyError(); };
  const classify = (url: URL, method: string, body: string, headers: Headers): StoreNodeExecutionRequestClass => {
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return reject();
    if (seed.account.platform === "amazon") {
      if (seed.account.authorizationMode !== "amazon_private" && seed.account.authorizationMode !== "amazon_public") return reject();
      if (url.hostname === "api.amazon.com" && url.pathname === "/auth/o2/token" && !url.search && method === "POST") {
        const values = new URLSearchParams(body);
        if (Array.from(values.keys()).sort().join() !== "client_id,client_secret,grant_type,refresh_token" || values.get("grant_type") !== "refresh_token"
          || values.get("client_id") !== application.clientId || values.get("client_secret") !== application.clientSecret || values.get("refresh_token") !== seed.credential.refreshToken) return reject();
        return "amazon_lwa";
      }
      if (method !== "GET" || body) return reject();
      const document = derived.get(url.href);
      if (document) {
        if (headers.has("authorization") || headers.has("x-api-key") || headers.has("x-amz-access-token")) return reject();
        return document;
      }
      if (seed.account.region === "GLOBAL" || url.hostname !== endpoint[seed.account.region]) return reject();
      if (url.pathname === "/sellers/v1/marketplaceParticipations" && !url.search) return "amazon_participations";
      const match = /^\/definitions\/2020-09-01\/productTypes\/([A-Z0-9_]+)$/.exec(url.pathname), query = url.searchParams;
      if (!match || !input.amazonProductTypes.includes(match[1]!) || Array.from(query.keys()).sort().join() !== "marketplaceIds,requirements,requirementsEnforced,sellerId"
        || !seed.account.marketplaceIds.includes(query.get("marketplaceIds") ?? "") || query.get("sellerId") !== seed.credential.sellingPartnerId
        || query.get("requirements") !== "LISTING" || query.get("requirementsEnforced") !== "ENFORCED") return reject();
      return "amazon_product_definition";
    }
    if (seed.account.platform !== "etsy" || seed.account.authorizationMode !== "etsy_oauth") return reject();
    if (url.hostname === "api.etsy.com" && url.pathname === "/v3/public/oauth/token" && !url.search && method === "POST") {
      const values = new URLSearchParams(body);
      if (Array.from(values.keys()).sort().join() !== "client_id,grant_type,refresh_token" || values.get("grant_type") !== "refresh_token"
        || values.get("refresh_token") !== seed.credential.refreshToken || sha(values.get("client_id") ?? "") !== seed.etsyAppKeySha256) return reject();
      return "etsy_refresh";
    }
    if (method !== "GET" || body || url.hostname !== "openapi.etsy.com") return reject();
    if (url.pathname === `/v3/application/users/${encodeURIComponent(seed.credential.userId ?? "")}/shops` && !url.search) return "etsy_shop";
    if (url.pathname === "/v3/application/seller-taxonomy/nodes" && !url.search) return "etsy_taxonomy";
    const taxonomy = /^\/v3\/application\/seller-taxonomy\/nodes\/(\d+)\/properties$/.exec(url.pathname);
    if (taxonomy && input.etsyTaxonomyNodeIds.includes(Number(taxonomy[1])) && !url.search) return "etsy_taxonomy_properties";
    if (!shopId) return reject();
    const prefix = `/v3/application/shops/${shopId}/`;
    if (!url.pathname.startsWith(prefix)) return reject();
    const suffix = url.pathname.slice(prefix.length);
    if (suffix === "sections" && !url.search) return "etsy_sections";
    if (suffix === "policies/return" && !url.search) return "etsy_return_policies";
    if (!seed.account.grantedScopes.includes("shops_r")) return reject();
    if (suffix === "shipping-profiles" && !url.search) return "etsy_shipping_profiles";
    if (suffix === "readiness-state-definitions" && url.search === "?limit=100") return "etsy_readiness_profiles";
    return reject();
  };
  return (async (raw: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    if (typeof raw !== "string" && !(raw instanceof URL)) return reject();
    const url = new URL(String(raw)), method = (init.method ?? "GET").toUpperCase(), headers = new Headers(init.headers);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) return reject();
    const body = init.body?.toString() ?? "", requestClass = classify(url, method, body, headers);
    // Transport-generated dates are not business request identity. Original cached
    // responses remain reusable when the process resumes on a later wall clock.
    const stableHeaders = Array.from(headers.entries()).filter(([name]) => name !== "x-amz-date").sort(([a], [b]) => a.localeCompare(b));
    const requestDigest = sha(JSON.stringify(["store-node-capability-request-v1", requestClass, method, url.href, stableHeaders, body]));
    let result = pending.get(requestDigest);
    if (!result) {
      result = options.exchange({ requestClass, requestDigest }, async permitSignal => {
        options.signal?.throwIfAborted();
        const signals = [init.signal, options.signal, permitSignal].filter((value): value is AbortSignal => Boolean(value));
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        const response = await (options.request ?? globalThis.fetch)(url, { ...init, method, redirect: "error", signal });
        if (response.redirected || (response.url && new URL(response.url).href !== url.href)) { await response.body?.cancel(); return reject(); }
        const bytes = await boundedResponse(response);
        return new Response(new Uint8Array(bytes).buffer, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json",
          ...(response.headers.has("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {}) } });
      });
      pending.set(requestDigest, result);
    }
    const response = (await result).clone();
    if (response.ok) {
      const value: unknown = await response.clone().json().catch(() => null);
      if (value && typeof value === "object") {
        const object = value as Record<string, unknown>;
        if (requestClass === "amazon_product_definition") for (const [field, kind] of [["schema", "amazon_schema"], ["metaSchema", "amazon_meta_schema"]] as const) {
          const resource = ((object[field] as { link?: { resource?: unknown } } | undefined)?.link)?.resource;
          if (typeof resource !== "string") return reject();
          const document = new URL(resource);
          if (document.protocol !== "https:" || document.username || document.password || document.hash || (document.port && document.port !== "443")
            || !(document.hostname === "amazonaws.com" || document.hostname.endsWith(".amazonaws.com") || document.hostname === "amazon.com" || document.hostname.endsWith(".amazon.com"))) return reject();
          derived.set(document.href, kind);
        }
        if (requestClass === "etsy_shop") {
          if (String(object.user_id) !== seed.credential.userId || !Number.isSafeInteger(object.shop_id) || Number(object.shop_id) <= 0) return reject();
          shopId = String(object.shop_id);
        }
        if (requestClass === "etsy_refresh" || requestClass === "amazon_lwa") for (const key of ["access_token", "refresh_token"])
          if (typeof object[key] === "string") options.observeSecret?.(object[key]);
      }
    }
    return response;
  }) as typeof fetch;
}
async function boundedResponse(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > STORE_NODE_EXECUTION_RESULT_BYTES)) { await response.body?.cancel(); throw new StoreNodeCapabilityPolicyError("store_node_result_too_large"); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) { const entry = await reader.read(); if (entry.done) break; total += entry.value.length;
      if (total > STORE_NODE_EXECUTION_RESULT_BYTES) { await reader.cancel(); throw new StoreNodeCapabilityPolicyError("store_node_result_too_large"); } chunks.push(entry.value); }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); for (const chunk of chunks) chunk.fill(0); }
}
