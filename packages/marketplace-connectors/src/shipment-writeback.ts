import type { MarketplacePlatform } from "@yummyai/contracts";
import { z } from "zod";

import type { MarketplaceConnectorContext, MarketplaceCredentialAccessor } from "./connector.js";
import { parseRetryAfter } from "./errors.js";

const ShipmentWritebackInputSchema = z.object({
  externalOrderId: z.string().trim().min(1).max(300),
  shipDate: z.iso.datetime(),
  packages: z.array(z.object({
    packageReferenceId: z.string().trim().min(1).max(160),
    trackingNumber: z.string().trim().min(1).max(200),
    carrierCode: z.string().trim().regex(/^[A-Z0-9_:-]{1,80}$/),
    carrierName: z.string().trim().min(1).max(160),
    carrierService: z.string().trim().min(1).max(160),
    lines: z.array(z.object({ externalLineId: z.string().trim().min(1).max(300), quantity: z.number().int().positive() }).strict()).min(1),
  }).strict()).min(1).max(100),
}).strict();

export type ShipmentWritebackInput = z.infer<typeof ShipmentWritebackInputSchema>;

export interface MarketplaceShipmentWritebackResult {
  status: "accepted" | "rejected" | "uncertain";
  providerCode: string;
  externalReference: string | null;
  retryAfterMs?: number;
}

export interface MarketplaceShipmentWritebackConnector {
  readonly platform: MarketplacePlatform;
  confirm(
    context: MarketplaceConnectorContext,
    credentials: MarketplaceCredentialAccessor,
    input: ShipmentWritebackInput,
    signal: AbortSignal,
  ): Promise<MarketplaceShipmentWritebackResult>;
}

export class AmazonShipmentWritebackConnector implements MarketplaceShipmentWritebackConnector {
  readonly platform = "amazon" as const;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  confirm(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, rawInput: ShipmentWritebackInput, signal: AbortSignal) {
    const input = ShipmentWritebackInputSchema.parse(rawInput);
    if (context.platform !== this.platform || context.marketplaceIds.length === 0) return Promise.resolve(rejected("INVALID_AMAZON_CONTEXT"));
    return credentials.withCredential(async (credential) => {
      const accessToken = await amazonAccessToken(this.request, this.environment, credential, signal);
      const endpoint = amazonEndpoint(context.region, this.environment);
      const references: string[] = [];
      for (const pkg of input.packages) {
        const response = await mutate(this.request, `${endpoint}/orders/v0/orders/${encodeURIComponent(input.externalOrderId)}/shipmentConfirmation`, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": "YummyAI/0.1 (Language=TypeScript)", "x-amz-access-token": accessToken },
          body: JSON.stringify({
            marketplaceId: context.marketplaceIds[0],
            packageDetail: {
              packageReferenceId: pkg.packageReferenceId, carrierCode: pkg.carrierCode, carrierName: pkg.carrierName,
              shippingMethod: pkg.carrierService, trackingNumber: pkg.trackingNumber, shipDate: input.shipDate,
              orderItems: pkg.lines.map((line) => ({ orderItemId: line.externalLineId, quantity: line.quantity })),
            },
          }),
          signal,
        }, this.platform);
        if (response.status !== "accepted") return response;
        references.push(response.externalReference ?? pkg.packageReferenceId);
      }
      return { status: "accepted" as const, providerCode: "HTTP_204", externalReference: references.join(",") };
    });
  }
}

export class EtsyShipmentWritebackConnector implements MarketplaceShipmentWritebackConnector {
  readonly platform = "etsy" as const;

  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  confirm(context: MarketplaceConnectorContext, credentials: MarketplaceCredentialAccessor, rawInput: ShipmentWritebackInput, signal: AbortSignal) {
    const input = ShipmentWritebackInputSchema.parse(rawInput);
    const shopId = context.externalAccountId;
    if (context.platform !== this.platform || !shopId || !/^\d+$/.test(shopId) || !/^\d+$/.test(input.externalOrderId)) return Promise.resolve(rejected("INVALID_ETSY_CONTEXT"));
    return credentials.withCredential(async (credential) => {
      const { accessToken, clientId, sharedSecret } = await etsyAccessToken(this.request, this.environment, credential, signal);
      const references: string[] = [];
      for (const pkg of input.packages) {
        const response = await mutate(this.request, `https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}/receipts/${encodeURIComponent(input.externalOrderId)}/tracking`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`, "content-type": "application/json",
            "user-agent": "YummyAI/0.1 (Language=TypeScript)", "x-api-key": `${clientId}:${sharedSecret}`,
          },
          body: JSON.stringify({
            tracking_code: pkg.trackingNumber, carrier_name: pkg.carrierName,
            mail_class: pkg.carrierService, send_bcc: false, ship_date: input.shipDate.slice(0, 10),
          }),
          signal,
        }, this.platform);
        if (response.status !== "accepted") return response;
        references.push(response.externalReference ?? pkg.packageReferenceId);
      }
      return { status: "accepted" as const, providerCode: "HTTP_200", externalReference: references.join(",") };
    });
  }
}

async function mutate(request: typeof fetch, url: string, init: RequestInit, platform: MarketplacePlatform): Promise<MarketplaceShipmentWritebackResult> {
  let response: Response;
  try {
    response = await request(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
  } catch {
    return { status: "uncertain", providerCode: "NETWORK_OUTCOME_UNKNOWN", externalReference: null };
  }
  const externalReference = response.headers.get(platform === "amazon" ? "x-amzn-requestid" : "x-request-id");
  if (response.ok) return { status: "accepted", providerCode: `HTTP_${response.status}`, externalReference };
  if (response.status >= 500) return { status: "uncertain", providerCode: `HTTP_${response.status}`, externalReference };
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  return { status: "rejected", providerCode: `HTTP_${response.status}`, externalReference, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function rejected(providerCode: string): MarketplaceShipmentWritebackResult { return { status: "rejected", providerCode, externalReference: null }; }

async function amazonAccessToken(request: typeof fetch, environment: NodeJS.ProcessEnv, credential: Readonly<Record<string, string>>, signal: AbortSignal) {
  if (credential.accessToken?.trim()) return credential.accessToken.trim();
  const clientId = credential.clientId?.trim() || requiredEnvironment(environment, "AMAZON_SPAPI_LWA_CLIENT_ID");
  const clientSecret = credential.clientSecret?.trim() || requiredEnvironment(environment, "AMAZON_SPAPI_LWA_CLIENT_SECRET");
  const response = await request("https://api.amazon.com/auth/o2/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, signal,
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: requiredCredential(credential, "refreshToken"), client_id: clientId, client_secret: clientSecret }),
  });
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (!response.ok || typeof body?.access_token !== "string") throw new TypeError("Amazon credential refresh failed");
  return body.access_token;
}

async function etsyAccessToken(request: typeof fetch, environment: NodeJS.ProcessEnv, credential: Readonly<Record<string, string>>, signal: AbortSignal) {
  const clientId = requiredEnvironment(environment, "ETSY_APP_KEYSTRING");
  const sharedSecret = requiredEnvironment(environment, "ETSY_APP_SHARED_SECRET");
  if (credential.accessToken?.trim()) return { accessToken: credential.accessToken.trim(), clientId, sharedSecret };
  const response = await request("https://api.etsy.com/v3/public/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, signal,
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: requiredCredential(credential, "refreshToken") }),
  });
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (!response.ok || typeof body?.access_token !== "string") throw new TypeError("Etsy credential refresh failed");
  return { accessToken: body.access_token, clientId, sharedSecret };
}

function amazonEndpoint(region: MarketplaceConnectorContext["region"], environment: NodeJS.ProcessEnv) {
  const defaults: Partial<Record<MarketplaceConnectorContext["region"], string>> = { NA: "https://sellingpartnerapi-na.amazon.com", EU: "https://sellingpartnerapi-eu.amazon.com", FE: "https://sellingpartnerapi-fe.amazon.com" };
  const endpoint = environment[`AMAZON_SPAPI_ENDPOINT_${region}`]?.trim() || defaults[region];
  if (!endpoint) throw new TypeError("Amazon shipment endpoint is not configured");
  return endpoint.replace(/\/$/, "");
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string) { const value = environment[name]?.trim(); if (!value) throw new TypeError(`${name} is not configured`); return value; }
function requiredCredential(credential: Readonly<Record<string, string>>, key: string) { const value = credential[key]?.trim(); if (!value) throw new TypeError("Marketplace credential is incomplete"); return value; }
