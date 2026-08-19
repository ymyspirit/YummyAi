import { createHash } from "node:crypto";

import type {
  MarketplaceAuthorizationMode,
  MarketplaceCapability,
  MarketplacePlatform,
  MarketplaceRegion,
  SyncMarketplaceCapabilitiesInput,
} from "@yummyai/contracts";
import { z } from "zod";

import { MarketplaceConnectorError, parseRetryAfter } from "./errors.js";

export interface CapabilitySyncAccountContext {
  authorizationMode: MarketplaceAuthorizationMode;
  externalAccountId: string | null;
  grantedScopes: readonly string[];
  marketplaceIds: readonly string[];
  platform: MarketplacePlatform;
  region: MarketplaceRegion;
}

export interface CapabilitySyncIssue {
  code: string;
  message: string;
  severity: "blocker" | "warning";
}

export interface MarketplaceCapabilitySyncResult {
  capabilities: readonly MarketplaceCapability[];
  data: Record<string, unknown>;
  expiresAt: Date;
  externalAccountId: string;
  healthStatus: "healthy" | "degraded";
  issues: readonly CapabilitySyncIssue[];
  marketplaceIds: readonly string[];
  refreshedCredential?: Readonly<Record<string, string>>;
  refreshedCredentialExpiresAt?: Date;
  sourceChecksum: string;
  sourceVersion: string;
  syncedAt: Date;
}

export interface MarketplaceCapabilityGateway {
  sync(
    account: CapabilitySyncAccountContext,
    credential: Readonly<Record<string, string>>,
    input: SyncMarketplaceCapabilitiesInput,
  ): Promise<MarketplaceCapabilitySyncResult>;
}

export class HttpMarketplaceCapabilityGateway implements MarketplaceCapabilityGateway {
  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  sync(
    account: CapabilitySyncAccountContext,
    credential: Readonly<Record<string, string>>,
    input: SyncMarketplaceCapabilitiesInput,
  ): Promise<MarketplaceCapabilitySyncResult> {
    return account.platform === "amazon"
      ? this.syncAmazon(account, credential, input)
      : this.syncEtsy(account, credential, input);
  }

  private async syncAmazon(
    account: CapabilitySyncAccountContext,
    credential: Readonly<Record<string, string>>,
    input: SyncMarketplaceCapabilitiesInput,
  ): Promise<MarketplaceCapabilitySyncResult> {
    const callCount = input.amazonProductTypes.length * account.marketplaceIds.length;
    if (callCount > 20) {
      throw new MarketplaceConnectorError("amazon", "validation", "Amazon capability sync is limited to 20 product type and marketplace combinations");
    }
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const headers = amazonHeaders(accessToken);
    const participations = await this.requestJson(
      `${endpoint}/sellers/v1/marketplaceParticipations`,
      { headers },
      AmazonParticipationsSchema,
      "amazon",
    );
    const configured = new Set(account.marketplaceIds);
    const selected = participations.payload.filter((entry) => configured.has(entry.marketplace.id));
    const issues: CapabilitySyncIssue[] = [];
    for (const marketplaceId of account.marketplaceIds) {
      const entry = selected.find((candidate) => candidate.marketplace.id === marketplaceId);
      if (!entry) {
        issues.push({ code: "MARKETPLACE_NOT_PARTICIPATING", message: `Seller is not registered for ${marketplaceId}`, severity: "blocker" });
      } else if (!entry.participation.isParticipating || entry.participation.hasSuspendedListings) {
        issues.push({ code: "MARKETPLACE_SUSPENDED", message: `Listing participation is unavailable for ${marketplaceId}`, severity: "blocker" });
      }
    }
    const definitions = await Promise.all(input.amazonProductTypes.flatMap((productType) =>
      account.marketplaceIds.map((marketplaceId) => this.amazonProductDefinition({
        endpoint,
        headers,
        marketplaceId,
        productType,
        sellerId: requireCredential(credential, "sellingPartnerId", "amazon"),
      })),
    ));
    const data: Record<string, unknown> = {
      seller: { sellingPartnerId: requireCredential(credential, "sellingPartnerId", "amazon") },
      participations: participations.payload,
      productDefinitions: definitions,
      issues,
    };
    const sourceChecksum = checksum(data);
    const healthy = issues.every((issue) => issue.severity !== "blocker");
    const capabilities = amazonCapabilities(account.grantedScopes, healthy);
    const syncedAt = new Date();
    return {
      capabilities,
      data,
      expiresAt: new Date(syncedAt.getTime() + input.ttlHours * 60 * 60 * 1_000),
      externalAccountId: requireCredential(credential, "sellingPartnerId", "amazon"),
      healthStatus: healthy ? "healthy" : "degraded",
      issues,
      marketplaceIds: account.marketplaceIds,
      sourceChecksum,
      sourceVersion: `amazon-sellers-v1:${definitions.map((entry) => entry.productTypeVersion).sort().join(",") || "identity-only"}`,
      syncedAt,
    };
  }

  private async amazonAccessToken(
    account: CapabilitySyncAccountContext,
    credential: Readonly<Record<string, string>>,
  ): Promise<string> {
    const privateApplication = account.authorizationMode === "amazon_private";
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: requireCredential(credential, "refreshToken", "amazon"),
      client_id: privateApplication
        ? requireCredential(credential, "clientId", "amazon")
        : requiredEnvironment(this.environment, "AMAZON_SPAPI_LWA_CLIENT_ID", "amazon"),
      client_secret: privateApplication
        ? requireCredential(credential, "clientSecret", "amazon")
        : requiredEnvironment(this.environment, "AMAZON_SPAPI_LWA_CLIENT_SECRET", "amazon"),
    });
    const token = await this.requestJson(
      "https://api.amazon.com/auth/o2/token",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body },
      AccessTokenSchema,
      "amazon",
    );
    return token.access_token;
  }

  private async amazonProductDefinition(input: {
    endpoint: string;
    headers: HeadersInit;
    marketplaceId: string;
    productType: string;
    sellerId: string;
  }): Promise<Record<string, unknown>> {
    const url = new URL(`/definitions/2020-09-01/productTypes/${encodeURIComponent(input.productType)}`, `${input.endpoint}/`);
    url.search = new URLSearchParams({
      marketplaceIds: input.marketplaceId,
      sellerId: input.sellerId,
      requirements: "LISTING",
      requirementsEnforced: "ENFORCED",
    }).toString();
    const definition = await this.requestJson(url.toString(), { headers: input.headers }, AmazonProductDefinitionSchema, "amazon");
    const schemaDocument = await this.amazonSchemaDocument(definition.schema.link.resource);
    const metaSchemaDocument = await this.amazonSchemaDocument(definition.metaSchema.link.resource);
    return {
      marketplaceIds: definition.marketplaceIds,
      metaSchemaChecksum: definition.metaSchema.link.checksum,
      metaSchemaDocument,
      productType: definition.productType,
      productTypeVersion: definition.productTypeVersion.version,
      requirements: definition.requirements ?? null,
      requirementsEnforced: definition.requirementsEnforced ?? null,
      schemaChecksum: definition.schema.link.checksum,
      schemaDocument,
    };
  }

  private async amazonSchemaDocument(resource: string): Promise<unknown> {
    const url = new URL(resource);
    const allowed = url.protocol === "https:" && (
      url.hostname === "amazonaws.com" ||
      url.hostname.endsWith(".amazonaws.com") ||
      url.hostname === "amazon.com" ||
      url.hostname.endsWith(".amazon.com")
    );
    if (!allowed) throw new MarketplaceConnectorError("amazon", "validation", "Amazon returned an untrusted schema URL");
    return this.requestJson(url.toString(), {}, z.unknown(), "amazon");
  }

  private async syncEtsy(
    account: CapabilitySyncAccountContext,
    credential: Readonly<Record<string, string>>,
    input: SyncMarketplaceCapabilitiesInput,
  ): Promise<MarketplaceCapabilitySyncResult> {
    const clientId = requiredEnvironment(this.environment, "ETSY_APP_KEYSTRING", "etsy");
    const sharedSecret = requiredEnvironment(this.environment, "ETSY_APP_SHARED_SECRET", "etsy");
    const refreshToken = requireCredential(credential, "refreshToken", "etsy");
    const token = await this.requestJson(
      "https://api.etsy.com/v3/public/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      },
      EtsyTokenSchema,
      "etsy",
    );
    const userId = requireCredential(credential, "userId", "etsy");
    if (token.access_token.split(".", 1)[0] !== userId) {
      throw new MarketplaceConnectorError("etsy", "authorization", "Etsy token identity changed");
    }
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "YummyAI/0.1 (Language=TypeScript)",
      "x-api-key": `${clientId}:${sharedSecret}`,
    };
    const base = "https://openapi.etsy.com/v3/application";
    const shop = await this.requestJson(`${base}/users/${encodeURIComponent(userId)}/shops`, { headers }, EtsyShopSchema, "etsy");
    if (String(shop.user_id) !== userId) throw new MarketplaceConnectorError("etsy", "authorization", "Etsy shop owner does not match the authorized user");
    const shopId = String(shop.shop_id);
    const hasShopRead = account.grantedScopes.includes("shops_r");
    const [sections, returnPolicies, taxonomy, shippingProfiles, readinessProfiles, taxonomyProperties] = await Promise.all([
      this.requestJson(`${base}/shops/${shopId}/sections`, { headers }, EtsyListSchema, "etsy"),
      this.requestJson(`${base}/shops/${shopId}/policies/return`, { headers }, EtsyListSchema, "etsy"),
      this.requestJson(`${base}/seller-taxonomy/nodes`, { headers }, EtsyListSchema, "etsy"),
      hasShopRead
        ? this.requestJson(`${base}/shops/${shopId}/shipping-profiles`, { headers }, EtsyListSchema, "etsy")
        : Promise.resolve(null),
      hasShopRead
        ? this.requestJson(`${base}/shops/${shopId}/readiness-state-definitions?limit=100`, { headers }, EtsyListSchema, "etsy")
        : Promise.resolve(null),
      Promise.all(input.etsyTaxonomyNodeIds.map(async (taxonomyId) => ({
        taxonomyId,
        properties: await this.requestJson(`${base}/seller-taxonomy/nodes/${taxonomyId}/properties`, { headers }, EtsyListSchema, "etsy"),
      }))),
    ]);
    const issues: CapabilitySyncIssue[] = hasShopRead
      ? []
      : [{ code: "SHOPS_R_NOT_GRANTED", message: "Shipping and readiness profiles require shops_r", severity: "warning" }];
    const data: Record<string, unknown> = {
      shop,
      sections,
      returnPolicies,
      shippingProfiles,
      readinessProfiles,
      sellerTaxonomy: taxonomy,
      taxonomyProperties,
      issues,
    };
    const sourceChecksum = checksum(data);
    const syncedAt = new Date();
    const refreshedCredential = token.refresh_token === refreshToken
      ? undefined
      : { ...credential, refreshToken: token.refresh_token };
    return {
      capabilities: etsyCapabilities(account.grantedScopes, hasShopRead),
      data,
      expiresAt: new Date(syncedAt.getTime() + input.ttlHours * 60 * 60 * 1_000),
      externalAccountId: shopId,
      healthStatus: "healthy",
      issues,
      marketplaceIds: ["etsy"],
      ...(refreshedCredential ? {
        refreshedCredential,
        refreshedCredentialExpiresAt: new Date(syncedAt.getTime() + 90 * 24 * 60 * 60 * 1_000),
      } : {}),
      sourceChecksum,
      sourceVersion: "etsy-open-api-v3",
      syncedAt,
    };
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    platform: MarketplacePlatform,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal: AbortSignal.timeout(20_000) });
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
            : response.status >= 500
              ? "upstream_retryable"
              : "upstream_terminal";
      throw new MarketplaceConnectorError(platform, code, `Marketplace API returned ${response.status}`, parseRetryAfter(response.headers.get("retry-after")));
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new MarketplaceConnectorError(platform, "upstream_terminal", "Marketplace API response is invalid");
    return parsed.data;
  }
}

const AccessTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).passthrough();
const EtsyTokenSchema = AccessTokenSchema.extend({ refresh_token: z.string().min(1) });
const AmazonParticipationsSchema = z.object({
  payload: z.array(z.object({
    marketplace: z.object({ id: z.string().min(1) }).passthrough(),
    participation: z.object({ isParticipating: z.boolean(), hasSuspendedListings: z.boolean() }).passthrough(),
  }).passthrough()),
}).passthrough();
const AmazonProductDefinitionSchema = z.object({
  metaSchema: z.object({ link: z.object({ resource: z.url(), checksum: z.string() }) }),
  schema: z.object({ link: z.object({ resource: z.url(), checksum: z.string() }) }),
  marketplaceIds: z.array(z.string()),
  productType: z.string(),
  productTypeVersion: z.object({ version: z.string() }).passthrough(),
  requirements: z.string().optional(),
  requirementsEnforced: z.string().optional(),
}).passthrough();
const EtsyShopSchema = z.object({ shop_id: z.number().int().positive(), user_id: z.number().int().positive(), shop_name: z.string() }).passthrough();
const EtsyListSchema = z.object({ count: z.number().int().nonnegative(), results: z.array(z.unknown()) }).passthrough();

function amazonEndpoint(region: MarketplaceRegion, environment: NodeJS.ProcessEnv): string {
  if (region === "GLOBAL") throw new MarketplaceConnectorError("amazon", "validation", "Amazon requires a regional endpoint");
  const override = environment[`AMAZON_SPAPI_ENDPOINT_${region}`]?.trim();
  if (override) return requireHttpsEndpoint(override, "amazon");
  return {
    NA: "https://sellingpartnerapi-na.amazon.com",
    EU: "https://sellingpartnerapi-eu.amazon.com",
    FE: "https://sellingpartnerapi-fe.amazon.com",
  }[region];
}

function amazonHeaders(accessToken: string): HeadersInit {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
  return {
    "user-agent": "YummyAI/0.1 (Language=TypeScript)",
    "x-amz-access-token": accessToken,
    "x-amz-date": now,
  };
}

function amazonCapabilities(scopes: readonly string[], healthy: boolean): MarketplaceCapability[] {
  if (!scopes.includes("product-listing")) return ["catalog_read"];
  return healthy
    ? ["catalog_read", "taxonomy_read", "listing_read", "listing_write", "listing_delete", "media_write", "inventory_write"]
    : ["catalog_read", "taxonomy_read", "listing_read"];
}

function etsyCapabilities(scopes: readonly string[], hasShopRead: boolean): MarketplaceCapability[] {
  const capabilities: MarketplaceCapability[] = ["catalog_read", "taxonomy_read", "shop_read", "policy_read"];
  if (hasShopRead) capabilities.push("shipping_profile_read");
  if (scopes.includes("listings_r")) capabilities.push("listing_read");
  if (scopes.includes("listings_w")) capabilities.push("listing_write", "media_write", "inventory_write");
  if (scopes.includes("listings_d")) capabilities.push("listing_delete");
  return [...new Set(capabilities)];
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string, platform: MarketplacePlatform): string {
  const value = environment[name]?.trim();
  if (!value) throw new MarketplaceConnectorError(platform, "validation", `${name} is not configured`);
  return value;
}

function requireCredential(credential: Readonly<Record<string, string>>, key: string, platform: MarketplacePlatform): string {
  const value = credential[key];
  if (!value) throw new MarketplaceConnectorError(platform, "authorization", "Marketplace credential is incomplete");
  return value;
}

function requireHttpsEndpoint(value: string, platform: MarketplacePlatform): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarketplaceConnectorError(platform, "validation", "Marketplace endpoint is invalid");
  }
  if (url.protocol !== "https:") throw new MarketplaceConnectorError(platform, "validation", "Marketplace endpoint must use HTTPS");
  return url.toString().replace(/\/$/, "");
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("base64url");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
