import type { MarketplacePlatform } from "@yummyai/contracts";
import { z } from "zod";

import type { MarketplaceConnectorContext, MarketplaceCredentialAccessor } from "./connector.js";
import { MarketplaceConnectorError, parseRetryAfter } from "./errors.js";
import {
  OrderSyncRequestSchema,
  type MarketplaceOrderIngestionAdapter,
  type OrderSyncRequest,
  type ProviderOrderPage,
} from "./order-ingestion.js";
import { normalizeAmazonOrder, normalizeEtsyReceipt } from "./provider-orders.js";

const AccessTokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional() }).passthrough();
const AmazonSearchResponseSchema = z.object({
  orders: z.array(z.unknown()).default([]),
  pagination: z.object({ nextToken: z.string().min(1).nullable().optional() }).passthrough().optional(),
  totalCount: z.number().int().nonnegative().optional(),
}).passthrough();
const EtsyReceiptsResponseSchema = z.object({ count: z.number().int().nonnegative(), results: z.array(z.unknown()) }).passthrough();

export class AmazonOrdersAdapter implements MarketplaceOrderIngestionAdapter {
  readonly platform = "amazon" as const;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  fetchPage(
    context: MarketplaceConnectorContext,
    credentials: MarketplaceCredentialAccessor,
    rawRequest: OrderSyncRequest,
    signal: AbortSignal,
  ): Promise<ProviderOrderPage> {
    if (context.platform !== this.platform) throw new MarketplaceConnectorError(this.platform, "validation", "Amazon adapter received a non-Amazon account");
    if (context.marketplaceIds.length === 0) throw new MarketplaceConnectorError(this.platform, "validation", "Amazon order sync requires at least one marketplace ID");
    const input = OrderSyncRequestSchema.parse(rawRequest);
    return credentials.withCredential(async (credential) => {
      const accessToken = await amazonAccessToken(this.request, this.environment, credential, signal);
      const endpoint = amazonEndpoint(context.region, this.environment);
      const url = new URL("/orders/2026-01-01/orders", `${endpoint}/`);
      url.searchParams.set("marketplaceIds", context.marketplaceIds.join(","));
      url.searchParams.set("lastUpdatedAfter", input.updatedAfter);
      url.searchParams.set("lastUpdatedBefore", input.updatedBefore);
      url.searchParams.set("maxResultsPerPage", String(input.pageSize));
      url.searchParams.set("includedData", "BUYER,RECIPIENT,PROCEEDS,CANCELLATION");
      if (input.checkpoint.cursor) url.searchParams.set("paginationToken", input.checkpoint.cursor);
      const response = await requestJson(this.request, url.toString(), {
        headers: {
          "user-agent": "YummyAI/0.1 (Language=TypeScript)",
          "x-amz-access-token": accessToken,
          "x-amz-date": this.now().toISOString().replace(/[-:]|\.\d{3}/g, ""),
        },
        signal,
      }, AmazonSearchResponseSchema, this.platform);
      const fetchedAt = this.now().toISOString();
      return {
        records: response.orders.map((order, index) => normalizeAmazonOrder(
          context.accountId,
          `search:${input.updatedAfter}:${input.updatedBefore}:${input.checkpoint.cursor ?? "first"}:${index}`,
          order,
        )),
        fetchedAt,
        highWaterAt: input.updatedBefore,
        nextCursor: response.pagination?.nextToken ?? null,
        reportedCount: response.totalCount ?? null,
        sourceVersion: "amazon-orders-2026-01-01",
      };
    });
  }
}

export class EtsyReceiptsAdapter implements MarketplaceOrderIngestionAdapter {
  readonly platform = "etsy" as const;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  fetchPage(
    context: MarketplaceConnectorContext,
    credentials: MarketplaceCredentialAccessor,
    rawRequest: OrderSyncRequest,
    signal: AbortSignal,
  ): Promise<ProviderOrderPage> {
    if (context.platform !== this.platform) throw new MarketplaceConnectorError(this.platform, "validation", "Etsy adapter received a non-Etsy account");
    const shopId = context.externalAccountId;
    if (!shopId || !/^\d+$/.test(shopId)) throw new MarketplaceConnectorError(this.platform, "validation", "Etsy order sync requires the authorized numeric shop ID");
    const input = OrderSyncRequestSchema.parse(rawRequest);
    const offset = input.checkpoint.cursor === null ? 0 : parseOffset(input.checkpoint.cursor);
    return credentials.withCredential(async (credential) => {
      const { accessToken, clientId, sharedSecret } = await etsyAccessToken(this.request, this.environment, credential, signal);
      const url = new URL(`/v3/application/shops/${encodeURIComponent(shopId)}/receipts`, "https://openapi.etsy.com");
      url.searchParams.set("min_last_modified", String(Math.floor(Date.parse(input.updatedAfter) / 1_000)));
      url.searchParams.set("max_last_modified", String(Math.ceil(Date.parse(input.updatedBefore) / 1_000)));
      url.searchParams.set("limit", String(input.pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("sort_on", "updated");
      url.searchParams.set("sort_order", "asc");
      url.searchParams.set("legacy", "true");
      const response = await requestJson(this.request, url.toString(), {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "user-agent": "YummyAI/0.1 (Language=TypeScript)",
          "x-api-key": `${clientId}:${sharedSecret}`,
        },
        signal,
      }, EtsyReceiptsResponseSchema, this.platform);
      const consumed = offset + response.results.length;
      return {
        records: response.results.map((receipt) => normalizeEtsyReceipt(context.accountId, receipt)),
        fetchedAt: this.now().toISOString(),
        highWaterAt: input.updatedBefore,
        nextCursor: consumed < response.count && response.results.length > 0 ? String(consumed) : null,
        reportedCount: response.count,
        sourceVersion: "etsy-open-api-v3",
      };
    });
  }
}

async function amazonAccessToken(
  request: typeof fetch,
  environment: NodeJS.ProcessEnv,
  credential: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<string> {
  const clientId = credential.clientId?.trim() || requiredEnvironment(environment, "AMAZON_SPAPI_LWA_CLIENT_ID", "amazon");
  const clientSecret = credential.clientSecret?.trim() || requiredEnvironment(environment, "AMAZON_SPAPI_LWA_CLIENT_SECRET", "amazon");
  const token = await requestJson(request, "https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, signal,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: requireCredential(credential, "refreshToken", "amazon"), client_id: clientId, client_secret: clientSecret }),
  }, AccessTokenSchema, "amazon");
  return token.access_token;
}

async function etsyAccessToken(
  request: typeof fetch,
  environment: NodeJS.ProcessEnv,
  credential: Readonly<Record<string, string>>,
  signal: AbortSignal,
) {
  const clientId = requiredEnvironment(environment, "ETSY_APP_KEYSTRING", "etsy");
  const sharedSecret = requiredEnvironment(environment, "ETSY_APP_SHARED_SECRET", "etsy");
  const token = await requestJson(request, "https://api.etsy.com/v3/public/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, signal,
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: requireCredential(credential, "refreshToken", "etsy") }),
  }, AccessTokenSchema, "etsy");
  return { accessToken: token.access_token, clientId, sharedSecret };
}

async function requestJson<T>(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  platform: MarketplacePlatform,
): Promise<T> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch {
    throw new MarketplaceConnectorError(platform, "upstream_retryable", "Marketplace API is unavailable");
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? "authorization"
      : response.status === 429
        ? "rate_limited"
        : response.status === 400 || response.status === 404 || response.status === 422
          ? "validation"
          : response.status >= 500 ? "upstream_retryable" : "upstream_terminal";
    throw new MarketplaceConnectorError(platform, code, `Marketplace API returned ${response.status}`, parseRetryAfter(response.headers.get("retry-after")));
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new MarketplaceConnectorError(platform, "upstream_terminal", "Marketplace API response is invalid");
  return parsed.data;
}

function amazonEndpoint(region: MarketplaceConnectorContext["region"], environment: NodeJS.ProcessEnv): string {
  const defaults: Partial<Record<MarketplaceConnectorContext["region"], string>> = {
    NA: "https://sellingpartnerapi-na.amazon.com",
    EU: "https://sellingpartnerapi-eu.amazon.com",
    FE: "https://sellingpartnerapi-fe.amazon.com",
  };
  const endpoint = environment[`AMAZON_SPAPI_ENDPOINT_${region}`]?.trim() || defaults[region];
  if (!endpoint) throw new MarketplaceConnectorError("amazon", "validation", "Amazon order sync requires an Amazon SP-API region");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:") throw new MarketplaceConnectorError("amazon", "validation", "Amazon SP-API endpoint must use HTTPS");
  return parsed.toString().replace(/\/$/, "");
}

function parseOffset(value: string): number {
  if (!/^\d+$/.test(value)) throw new MarketplaceConnectorError("etsy", "validation", "Etsy receipt cursor is invalid");
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) throw new MarketplaceConnectorError("etsy", "validation", "Etsy receipt cursor is invalid");
  return offset;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string, platform: MarketplacePlatform): string {
  const value = environment[name]?.trim();
  if (!value) throw new MarketplaceConnectorError(platform, "validation", `${name} is not configured`);
  return value;
}

function requireCredential(credential: Readonly<Record<string, string>>, key: string, platform: MarketplacePlatform): string {
  const value = credential[key]?.trim();
  if (!value) throw new MarketplaceConnectorError(platform, "authorization", "Marketplace credential is incomplete");
  return value;
}
