import type {
  MarketplaceAuthorizationMode,
  MarketplaceOnlineListingSnapshot,
  MarketplacePlatform,
  MarketplacePublicationIssue,
  MarketplaceQuotaTelemetry,
  MarketplaceQuotaWindow,
  MarketplaceRegion,
} from "@yummyai/contracts";
import { z } from "zod";

import { MarketplaceConnectorError, parseRetryAfter } from "./errors.js";

const basePayload = z.object({
  marketplaceId: z.string().min(1).max(80),
  locale: z.string().min(2).max(20),
}).strict();

export const AmazonPublicationPayloadSchema = basePayload.extend({
  platform: z.literal("amazon"),
  productType: z.string().min(1).max(120),
  sku: z.string().min(1).max(160),
  attributes: z.record(z.string(), z.unknown()),
}).strict();

export const EtsyPublicationPayloadSchema = basePayload.extend({
  platform: z.literal("etsy"),
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(5_000),
  tags: z.array(z.string().min(1).max(20)).max(13),
  price: z.object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  quantity: z.number().int().positive().max(999),
  whoMade: z.enum(["i_did", "collective", "someone_else"]),
  whenMade: z.string().min(1).max(120),
  taxonomyId: z.number().int().positive(),
  shippingProfileId: z.number().int().positive(),
  readinessStateId: z.number().int().positive(),
  shopSectionId: z.number().int().positive().optional(),
  isSupply: z.boolean().optional(),
  inventory: z.object({
    products: z.array(z.object({
      sku: z.string().min(1).max(160),
      propertyValues: z.array(z.object({
        propertyId: z.number().int().positive(),
        propertyName: z.string().min(1).max(120),
        scaleId: z.number().int().positive().optional(),
        valueIds: z.array(z.number().int().positive()),
        values: z.array(z.string().min(1).max(200)),
      }).strict()).max(3),
      offerings: z.array(z.object({
        price: z.object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
        quantity: z.number().int().nonnegative().max(999),
        isEnabled: z.boolean(),
        readinessStateId: z.number().int().positive().optional(),
      }).strict()).min(1),
    }).strict()).min(1).max(500),
    priceOnProperty: z.array(z.number().int().positive()).max(3),
    quantityOnProperty: z.array(z.number().int().positive()).max(3),
    skuOnProperty: z.array(z.number().int().positive()).max(3),
    readinessStateOnProperty: z.array(z.number().int().positive()).max(3),
  }).strict().optional(),
  personalization: z.object({
    instructions: z.string().min(1).max(2_000),
    required: z.boolean(),
    maxAllowedCharacters: z.number().int().min(1).max(1_024),
  }).strict().optional(),
}).strict();

export const MarketplacePublicationPayloadSchema = z.discriminatedUnion("platform", [
  AmazonPublicationPayloadSchema,
  EtsyPublicationPayloadSchema,
]);

export type MarketplacePublicationPayload = z.infer<typeof MarketplacePublicationPayloadSchema>;

export interface MarketplaceMediaInput {
  assetId: string;
  bytes: Uint8Array;
  fileName: string;
  mediaType: string;
  rank: number;
}

export interface PublicationAccountContext {
  authorizationMode: MarketplaceAuthorizationMode;
  externalAccountId: string;
  platform: MarketplacePlatform;
  region: MarketplaceRegion;
}

export interface MarketplaceDraftResult {
  externalListingId?: string;
  externalSubmissionId?: string;
  externalMediaIds?: readonly string[];
  externalState: string;
  issues: readonly MarketplacePublicationIssue[];
  quota?: MarketplaceQuotaTelemetry;
  refreshedCredential?: Readonly<Record<string, string>>;
  refreshedCredentialExpiresAt?: Date;
  status:
    | "validation_passed"
    | "validation_failed"
    | "draft_created"
    | "configuration_applied"
    | "submission_accepted"
    | "media_uploaded"
    | "activation_accepted"
    | "sync_pending"
    | "published"
    | "publication_failed"
    | "deactivated";
  submittedAt: Date;
}

export interface MarketplaceOnlineListingResult {
  issues: readonly MarketplacePublicationIssue[];
  quota?: MarketplaceQuotaTelemetry;
  refreshedCredential?: Readonly<Record<string, string>>;
  refreshedCredentialExpiresAt?: Date;
  snapshot: MarketplaceOnlineListingSnapshot;
}

export interface MarketplaceDraftGateway {
  create(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
  ): Promise<MarketplaceDraftResult>;
  submit(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
  ): Promise<MarketplaceDraftResult>;
  uploadMedia(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
    media: readonly MarketplaceMediaInput[],
  ): Promise<MarketplaceDraftResult>;
  configure(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult>;
  activate(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult>;
  getStatus(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult>;
  readOnlineListing(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult>;
  updateOnlineListingPriceInventory(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult>;
}

export class HttpMarketplaceDraftGateway implements MarketplaceDraftGateway {
  constructor(
    private readonly request: typeof fetch = globalThis.fetch,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  create(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
  ): Promise<MarketplaceDraftResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (payload.platform !== account.platform) {
      throw new MarketplaceConnectorError(account.platform, "validation", "Publication payload does not match the account platform");
    }
    return payload.platform === "amazon"
      ? this.previewAmazon(account, credential, payload)
      : this.createEtsyDraft(account, credential, payload);
  }

  submit(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
  ): Promise<MarketplaceDraftResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (account.platform !== "amazon" || payload.platform !== "amazon") {
      throw new MarketplaceConnectorError(account.platform, "validation", "Only Amazon payloads support direct submission");
    }
    return this.submitAmazon(account, credential, payload);
  }

  uploadMedia(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
    media: readonly MarketplaceMediaInput[],
  ): Promise<MarketplaceDraftResult> {
    if (account.platform !== "etsy") {
      throw new MarketplaceConnectorError(account.platform, "validation", "Listing media upload is only supported for Etsy activation");
    }
    return this.uploadEtsyMedia(account, credential, externalListingId, media);
  }

  configure(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (account.platform !== "etsy" || payload.platform !== "etsy") {
      throw new MarketplaceConnectorError(account.platform, "validation", "Inventory and personalization configuration is only supported for Etsy drafts");
    }
    return this.configureEtsy(account, credential, payload, externalListingId);
  }

  activate(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    if (account.platform !== "etsy") {
      throw new MarketplaceConnectorError(account.platform, "validation", "Explicit activation is only supported for Etsy drafts");
    }
    return this.activateEtsy(account, credential, externalListingId);
  }

  getStatus(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (payload.platform !== account.platform) {
      throw new MarketplaceConnectorError(account.platform, "validation", "Status payload does not match the account platform");
    }
    return payload.platform === "amazon"
      ? this.getAmazonStatus(account, credential, payload, externalListingId)
      : this.getEtsyStatus(account, credential, externalListingId);
  }

  readOnlineListing(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (payload.platform !== account.platform) {
      throw new MarketplaceConnectorError(account.platform, "validation", "Online Listing payload does not match the account platform");
    }
    return payload.platform === "amazon"
      ? this.readAmazonOnlineListing(account, credential, payload, externalListingId)
      : this.readEtsyOnlineListing(account, credential, payload, externalListingId);
  }

  updateOnlineListingPriceInventory(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    input: MarketplacePublicationPayload,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    const payload = MarketplacePublicationPayloadSchema.parse(input);
    if (payload.platform !== account.platform) {
      throw new MarketplaceConnectorError(account.platform, "validation", "Online Listing payload does not match the account platform");
    }
    return payload.platform === "amazon"
      ? this.updateAmazonPriceInventory(account, credential, payload, externalListingId)
      : this.updateEtsyPriceInventory(account, credential, payload, externalListingId);
  }

  private async previewAmazon(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof AmazonPublicationPayloadSchema>,
  ): Promise<MarketplaceDraftResult> {
    const sellerId = requireCredential(credential, "sellingPartnerId", "amazon");
    if (sellerId !== account.externalAccountId) {
      throw new MarketplaceConnectorError("amazon", "authorization", "Amazon seller identity changed");
    }
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const url = new URL(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`,
      `${endpoint}/`,
    );
    url.search = new URLSearchParams({
      marketplaceIds: payload.marketplaceId,
      issueLocale: payload.locale.replace("-", "_"),
      mode: "VALIDATION_PREVIEW",
    }).toString();
    const { data: response, quota } = await this.requestJson(
      url.toString(),
      {
        method: "PUT",
        headers: { ...amazonHeaders(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ productType: payload.productType, requirements: "LISTING", attributes: payload.attributes }),
      },
      AmazonListingResponseSchema,
      "amazon",
      false,
    );
    const issues = response.issues.map(normalizeAmazonIssue);
    const invalid = response.status === "INVALID" || issues.some((issue) => issue.severity === "blocker");
    return {
      externalSubmissionId: response.submissionId,
      externalState: response.status,
      issues,
      ...(quota ? { quota } : {}),
      status: invalid ? "validation_failed" : "validation_passed",
      submittedAt: new Date(),
    };
  }

  private async submitAmazon(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof AmazonPublicationPayloadSchema>,
  ): Promise<MarketplaceDraftResult> {
    const sellerId = requireCredential(credential, "sellingPartnerId", "amazon");
    if (sellerId !== account.externalAccountId) {
      throw new MarketplaceConnectorError("amazon", "authorization", "Amazon seller identity changed");
    }
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const url = new URL(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`,
      `${endpoint}/`,
    );
    url.search = new URLSearchParams({
      marketplaceIds: payload.marketplaceId,
      issueLocale: payload.locale.replace("-", "_"),
    }).toString();
    const { data: response, quota } = await this.requestJson(
      url.toString(),
      {
        method: "PUT",
        headers: { ...amazonHeaders(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ productType: payload.productType, requirements: "LISTING", attributes: payload.attributes }),
      },
      AmazonListingResponseSchema,
      "amazon",
      true,
    );
    const issues = response.issues.map(normalizeAmazonIssue);
    const rejected = response.status === "INVALID" || issues.some((issue) => issue.severity === "blocker");
    return {
      externalListingId: payload.sku,
      externalSubmissionId: response.submissionId,
      externalState: response.status,
      issues,
      ...(quota ? { quota } : {}),
      status: rejected ? "publication_failed" : "submission_accepted",
      submittedAt: new Date(),
    };
  }

  private async getAmazonStatus(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof AmazonPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    if (externalListingId !== payload.sku) {
      throw new MarketplaceConnectorError("amazon", "conflict", "Amazon status target does not match the submitted SKU");
    }
    const sellerId = requireCredential(credential, "sellingPartnerId", "amazon");
    if (sellerId !== account.externalAccountId) {
      throw new MarketplaceConnectorError("amazon", "authorization", "Amazon seller identity changed");
    }
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const url = new URL(
      `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`,
      `${endpoint}/`,
    );
    url.search = new URLSearchParams({
      marketplaceIds: payload.marketplaceId,
      issueLocale: payload.locale.replace("-", "_"),
      includedData: "summaries,issues",
    }).toString();
    const { data: response, quota } = await this.requestJson(
      url.toString(),
      { headers: amazonHeaders(accessToken) },
      AmazonListingStatusResponseSchema,
      "amazon",
      false,
    );
    const issues = response.issues.map(normalizeAmazonIssue);
    const statuses = response.summaries.flatMap((summary) => summary.status);
    const blocker = issues.some((issue) => issue.severity === "blocker");
    const published = statuses.some((status) => status === "BUYABLE" || status === "DISCOVERABLE");
    const deactivated = statuses.some((status) => status === "DELETED");
    return {
      externalListingId,
      externalState: statuses.join(",") || "PROCESSING",
      issues,
      ...(quota ? { quota } : {}),
      status: blocker ? "publication_failed" : deactivated ? "deactivated" : published ? "published" : "sync_pending",
      submittedAt: new Date(),
    };
  }

  private async readAmazonOnlineListing(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof AmazonPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    if (externalListingId !== payload.sku) {
      throw new MarketplaceConnectorError("amazon", "conflict", "Amazon online Listing target does not match the submitted SKU");
    }
    const sellerId = requireCredential(credential, "sellingPartnerId", "amazon");
    if (sellerId !== account.externalAccountId) {
      throw new MarketplaceConnectorError("amazon", "authorization", "Amazon seller identity changed");
    }
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const url = new URL(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`, `${endpoint}/`);
    url.search = new URLSearchParams({
      marketplaceIds: payload.marketplaceId,
      issueLocale: payload.locale.replace("-", "_"),
      includedData: "attributes,summaries,issues,fulfillmentAvailability",
    }).toString();
    const { data: response, quota } = await this.requestJson(url.toString(), { headers: amazonHeaders(accessToken) }, AmazonListingStatusResponseSchema, "amazon", false);
    const statuses = response.summaries.flatMap((summary) => summary.status);
    return {
      issues: response.issues.map(normalizeAmazonIssue),
      ...(quota ? { quota } : {}),
      snapshot: {
        externalState: statuses.join(",") || "UNKNOWN",
        price: response.attributes.purchasable_offer ?? null,
        inventory: response.attributes.fulfillment_availability ?? normalizeAmazonFulfillmentAvailability(response.fulfillmentAvailability),
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async updateAmazonPriceInventory(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof AmazonPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    if (externalListingId !== payload.sku) {
      throw new MarketplaceConnectorError("amazon", "conflict", "Amazon online Listing target does not match the submitted SKU");
    }
    const desired = desiredOnlineListingState(payload);
    const patches: Array<{ op: "replace"; path: string; value: unknown }> = [];
    if (desired.price !== null) patches.push({ op: "replace", path: "/attributes/purchasable_offer", value: desired.price });
    if (desired.inventory !== null) patches.push({ op: "replace", path: "/attributes/fulfillment_availability", value: desired.inventory });
    if (patches.length === 0) {
      throw new MarketplaceConnectorError("amazon", "validation", "Approved Amazon attributes do not contain price or inventory data");
    }
    const sellerId = requireCredential(credential, "sellingPartnerId", "amazon");
    if (sellerId !== account.externalAccountId) throw new MarketplaceConnectorError("amazon", "authorization", "Amazon seller identity changed");
    const accessToken = await this.amazonAccessToken(account, credential);
    const endpoint = amazonEndpoint(account.region, this.environment);
    const url = new URL(`/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(payload.sku)}`, `${endpoint}/`);
    url.search = new URLSearchParams({ marketplaceIds: payload.marketplaceId, issueLocale: payload.locale.replace("-", "_") }).toString();
    const { data: response, quota } = await this.requestJson(url.toString(), {
      method: "PATCH",
      headers: { ...amazonHeaders(accessToken), "content-type": "application/json" },
      body: JSON.stringify({ productType: payload.productType, patches }),
    }, AmazonListingResponseSchema, "amazon", true);
    return {
      issues: response.issues.map(normalizeAmazonIssue),
      ...(quota ? { quota } : {}),
      snapshot: { externalState: response.status, ...desired, observedAt: new Date().toISOString() },
    };
  }

  private async createEtsyDraft(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof EtsyPublicationPayloadSchema>,
  ): Promise<MarketplaceDraftResult> {
    if (payload.marketplaceId !== "etsy") {
      throw new MarketplaceConnectorError("etsy", "validation", "Etsy publications use the etsy marketplace ID");
    }
    const clientId = requiredEnvironment(this.environment, "ETSY_APP_KEYSTRING", "etsy");
    const sharedSecret = requiredEnvironment(this.environment, "ETSY_APP_SHARED_SECRET", "etsy");
    const refreshToken = requireCredential(credential, "refreshToken", "etsy");
    const { data: token } = await this.requestJson(
      "https://api.etsy.com/v3/public/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      },
      EtsyTokenSchema,
      "etsy",
      false,
    );
    const userId = requireCredential(credential, "userId", "etsy");
    if (token.access_token.split(".", 1)[0] !== userId) {
      throw new MarketplaceConnectorError("etsy", "authorization", "Etsy token identity changed");
    }
    const body = new URLSearchParams({
      quantity: String(payload.quantity),
      title: payload.title,
      description: payload.description,
      price: String(payload.price.amount),
      who_made: payload.whoMade,
      when_made: payload.whenMade,
      taxonomy_id: String(payload.taxonomyId),
      shipping_profile_id: String(payload.shippingProfileId),
      readiness_state_id: String(payload.readinessStateId),
    });
    if (payload.tags.length > 0) body.set("tags", payload.tags.join(","));
    if (payload.shopSectionId !== undefined) body.set("shop_section_id", String(payload.shopSectionId));
    if (payload.isSupply !== undefined) body.set("is_supply", String(payload.isSupply));
    const { data: response, quota } = await this.requestJson(
      `https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(account.externalAccountId)}/listings`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "YummyAI/0.1 (Language=TypeScript)",
          "x-api-key": `${clientId}:${sharedSecret}`,
        },
        body,
      },
      EtsyListingResponseSchema,
      "etsy",
      true,
    );
    const refreshedCredential = token.refresh_token === refreshToken
      ? undefined
      : { ...credential, refreshToken: token.refresh_token };
    const submittedAt = new Date();
    return {
      externalListingId: String(response.listing_id),
      externalState: response.state,
      issues: [],
      ...(quota ? { quota } : {}),
      ...(refreshedCredential ? {
        refreshedCredential,
        refreshedCredentialExpiresAt: new Date(submittedAt.getTime() + 90 * 24 * 60 * 60 * 1_000),
      } : {}),
      status: "draft_created",
      submittedAt,
    };
  }

  private async uploadEtsyMedia(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
    media: readonly MarketplaceMediaInput[],
  ): Promise<MarketplaceDraftResult> {
    if (media.length === 0) {
      throw new MarketplaceConnectorError("etsy", "validation", "Etsy activation requires at least one listing image");
    }
    const session = await this.etsySession(credential);
    const externalMediaIds: string[] = [];
    let quota: MarketplaceQuotaTelemetry | undefined;
    for (const asset of [...media].sort((left, right) => left.rank - right.rank)) {
      if (!asset.mediaType.startsWith("image/")) {
        throw new MarketplaceConnectorError("etsy", "validation", "Etsy listing media must be an image");
      }
      const bytes = new ArrayBuffer(asset.bytes.byteLength);
      new Uint8Array(bytes).set(asset.bytes);
      const body = new FormData();
      body.set("image", new Blob([bytes], { type: asset.mediaType }), asset.fileName);
      body.set("rank", String(asset.rank));
      const { data: response, quota: responseQuota } = await this.requestJson(
        `https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(account.externalAccountId)}/listings/${encodeURIComponent(externalListingId)}/images`,
        {
          method: "POST",
          headers: session.headers,
          body,
        },
        EtsyListingImageResponseSchema,
        "etsy",
        true,
      );
      quota = responseQuota ?? quota;
      externalMediaIds.push(String(response.listing_image_id));
    }
    return {
      externalListingId,
      externalMediaIds,
      externalState: "media_uploaded",
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      status: "media_uploaded",
      submittedAt: new Date(),
    };
  }

  private async configureEtsy(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof EtsyPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    const session = await this.etsySession(credential);
    let quota: MarketplaceQuotaTelemetry | undefined;
    if (payload.inventory) {
      const response = await this.requestJson(
        etsyInventoryUrl(externalListingId),
        {
          method: "PUT",
          headers: { ...session.headers, "content-type": "application/json" },
          body: JSON.stringify(toEtsyInventoryBody(payload.inventory)),
        },
        EtsyInventoryResponseSchema,
        "etsy",
        true,
      );
      quota = response.quota ?? quota;
    }
    if (payload.personalization) {
      const url = new URL(
        `/v3/application/shops/${encodeURIComponent(account.externalAccountId)}/listings/${encodeURIComponent(externalListingId)}/personalization`,
        "https://openapi.etsy.com/",
      );
      url.searchParams.set("supports_multiple_personalization_questions", "true");
      const response = await this.requestJson(
        url.toString(),
        {
          method: "POST",
          headers: { ...session.headers, "content-type": "application/json" },
          body: JSON.stringify({
            personalization_questions: [{
              question_type: "text_input",
              question_text: "Personalization",
              instructions: payload.personalization.instructions,
              required: payload.personalization.required,
              max_allowed_characters: payload.personalization.maxAllowedCharacters,
            }],
          }),
        },
        EtsyPersonalizationResponseSchema,
        "etsy",
        true,
      );
      quota = response.quota ?? quota;
    }
    return {
      externalListingId,
      externalState: "configuration_applied",
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      status: "configuration_applied",
      submittedAt: new Date(),
    };
  }

  private async activateEtsy(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    const session = await this.etsySession(credential);
    const { data: response, quota } = await this.requestJson(
      `https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(account.externalAccountId)}/listings/${encodeURIComponent(externalListingId)}`,
      {
        method: "PUT",
        headers: { ...session.headers, "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ state: "active" }),
      },
      EtsyListingResponseSchema,
      "etsy",
      true,
    );
    return {
      externalListingId,
      externalState: response.state,
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      status: "activation_accepted",
      submittedAt: new Date(),
    };
  }

  private async getEtsyStatus(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    externalListingId: string,
  ): Promise<MarketplaceDraftResult> {
    const session = await this.etsySession(credential);
    const { data: response, quota } = await this.requestJson(
      `https://openapi.etsy.com/v3/application/listings/${encodeURIComponent(externalListingId)}`,
      { headers: session.headers },
      EtsyListingResponseSchema,
      "etsy",
      false,
    );
    const status = response.state === "active"
      ? "published"
      : response.state === "expired" || response.state === "removed"
        ? "deactivated"
        : "sync_pending";
    return {
      externalListingId,
      externalState: response.state,
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      status,
      submittedAt: new Date(),
    };
  }

  private async readEtsyOnlineListing(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof EtsyPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    const session = await this.etsySession(credential);
    const [listingResponse, inventoryResponse] = await Promise.all([
      this.requestJson(`https://openapi.etsy.com/v3/application/listings/${encodeURIComponent(externalListingId)}`, { headers: session.headers }, EtsyListingResponseSchema, "etsy", false),
      this.requestJson(etsyInventoryUrl(externalListingId), { headers: session.headers }, EtsyInventoryResponseSchema, "etsy", false),
    ]);
    const listing = listingResponse.data;
    const inventory = inventoryResponse.data;
    const quota = inventoryResponse.quota ?? listingResponse.quota;
    return {
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      snapshot: {
        externalState: listing.state,
        price: payload.inventory
          ? inventory.products.map((product) => product.offerings.map((offering) => normalizeEtsyMoney(offering.price, payload.price.currency)))
          : normalizeEtsyMoney(listing.price, payload.price.currency),
        inventory: payload.inventory
          ? normalizeEtsyInventory(inventory)
          : { quantity: listing.quantity ?? 0 },
        observedAt: new Date().toISOString(),
      },
    };
  }

  private async updateEtsyPriceInventory(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
    payload: z.infer<typeof EtsyPublicationPayloadSchema>,
    externalListingId: string,
  ): Promise<MarketplaceOnlineListingResult> {
    const session = await this.etsySession(credential);
    const desired = desiredOnlineListingState(payload);
    let quota: MarketplaceQuotaTelemetry | undefined;
    if (payload.inventory) {
      const response = await this.requestJson(
        etsyInventoryUrl(externalListingId),
        {
          method: "PUT",
          headers: { ...session.headers, "content-type": "application/json" },
          body: JSON.stringify(toEtsyInventoryBody(payload.inventory)),
        },
        EtsyInventoryResponseSchema,
        "etsy",
        true,
      );
      quota = response.quota;
    } else {
      const response = await this.requestJson(
        `https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(account.externalAccountId)}/listings/${encodeURIComponent(externalListingId)}`,
        {
          method: "PUT",
          headers: { ...session.headers, "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({ price: String(payload.price.amount), quantity: String(payload.quantity) }),
        },
        EtsyListingResponseSchema,
        "etsy",
        true,
      );
      quota = response.quota;
    }
    return {
      issues: [],
      ...(quota ? { quota } : {}),
      ...session.rotation,
      snapshot: { externalState: "UPDATE_ACCEPTED", ...desired, observedAt: new Date().toISOString() },
    };
  }

  private async etsySession(
    credential: Readonly<Record<string, string>>,
  ): Promise<{
    headers: Record<string, string>;
    rotation: Pick<MarketplaceDraftResult, "refreshedCredential" | "refreshedCredentialExpiresAt">;
  }> {
    const clientId = requiredEnvironment(this.environment, "ETSY_APP_KEYSTRING", "etsy");
    const sharedSecret = requiredEnvironment(this.environment, "ETSY_APP_SHARED_SECRET", "etsy");
    const refreshToken = requireCredential(credential, "refreshToken", "etsy");
    const { data: token } = await this.requestJson(
      "https://api.etsy.com/v3/public/oauth/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken }),
      },
      EtsyTokenSchema,
      "etsy",
      false,
    );
    const userId = requireCredential(credential, "userId", "etsy");
    if (token.access_token.split(".", 1)[0] !== userId) {
      throw new MarketplaceConnectorError("etsy", "authorization", "Etsy token identity changed");
    }
    const submittedAt = new Date();
    return {
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "user-agent": "YummyAI/0.1 (Language=TypeScript)",
        "x-api-key": `${clientId}:${sharedSecret}`,
      },
      rotation: token.refresh_token === refreshToken
        ? {}
        : {
            refreshedCredential: { ...credential, refreshToken: token.refresh_token },
            refreshedCredentialExpiresAt: new Date(submittedAt.getTime() + 90 * 24 * 60 * 60 * 1_000),
          },
    };
  }

  private async amazonAccessToken(
    account: PublicationAccountContext,
    credential: Readonly<Record<string, string>>,
  ): Promise<string> {
    const privateApplication = account.authorizationMode === "amazon_private";
    const { data: token } = await this.requestJson(
      "https://api.amazon.com/auth/o2/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: requireCredential(credential, "refreshToken", "amazon"),
          client_id: privateApplication
            ? requireCredential(credential, "clientId", "amazon")
            : requiredEnvironment(this.environment, "AMAZON_SPAPI_LWA_CLIENT_ID", "amazon"),
          client_secret: privateApplication
            ? requireCredential(credential, "clientSecret", "amazon")
            : requiredEnvironment(this.environment, "AMAZON_SPAPI_LWA_CLIENT_SECRET", "amazon"),
        }),
      },
      AccessTokenSchema,
      "amazon",
      false,
    );
    return token.access_token;
  }

  private async requestJson<T>(
    url: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    platform: MarketplacePlatform,
    mutation: boolean,
  ): Promise<{ data: T; quota?: MarketplaceQuotaTelemetry }> {
    let response: Response;
    try {
      response = await this.request(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new MarketplaceConnectorError(
        platform,
        mutation ? "upstream_terminal" : "upstream_retryable",
        mutation ? "Marketplace response was not received; reconciliation is required" : "Marketplace API is unavailable",
        undefined,
        mutation,
      );
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403
        ? "authorization"
        : response.status === 429
          ? "rate_limited"
          : response.status === 400 || response.status === 404 || response.status === 409 || response.status === 422
            ? response.status === 409 ? "conflict" : "validation"
            : response.status >= 500
              ? mutation ? "upstream_terminal" : "upstream_retryable"
              : "upstream_terminal";
      throw new MarketplaceConnectorError(
        platform,
        code,
        `Marketplace API returned ${response.status}`,
        parseRetryAfter(response.headers.get("retry-after")),
        mutation && response.status >= 500,
      );
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new MarketplaceConnectorError(
        platform,
        "upstream_terminal",
        "Marketplace API response is invalid; reconciliation is required",
        undefined,
        mutation,
      );
    }
    const quota = normalizeQuotaTelemetry(platform, response.headers);
    return { data: parsed.data, ...(quota ? { quota } : {}) };
  }
}

function normalizeQuotaTelemetry(
  platform: MarketplacePlatform,
  headers: Headers,
): MarketplaceQuotaTelemetry | undefined {
  const windows: MarketplaceQuotaWindow[] = [];
  if (platform === "amazon") {
    const limit = positiveHeaderNumber(headers, "x-amzn-ratelimit-limit");
    if (limit !== undefined) windows.push({ scope: "second", limit });
  } else {
    const second = quotaWindow(headers, "second", "x-limit-per-second", "x-remaining-this-second");
    const day = quotaWindow(headers, "day", "x-limit-per-day", "x-remaining-today");
    if (second) windows.push(second);
    if (day) windows.push(day);
  }
  if (windows.length === 0) return undefined;
  return { platform, windows, observedAt: new Date().toISOString() };
}

function quotaWindow(
  headers: Headers,
  scope: MarketplaceQuotaWindow["scope"],
  limitHeader: string,
  remainingHeader: string,
): MarketplaceQuotaWindow | undefined {
  const limit = positiveHeaderNumber(headers, limitHeader);
  const remaining = nonnegativeHeaderNumber(headers, remainingHeader);
  if (limit === undefined && remaining === undefined) return undefined;
  return { scope, ...(limit === undefined ? {} : { limit }), ...(remaining === undefined ? {} : { remaining }) };
}

function positiveHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonnegativeHeaderNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

const AccessTokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).passthrough();
const EtsyTokenSchema = AccessTokenSchema.extend({ refresh_token: z.string().min(1) });
const AmazonIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.string().optional(),
  attributeNames: z.array(z.string()).optional(),
}).passthrough();
const AmazonListingResponseSchema = z.object({
  sku: z.string().optional(),
  status: z.string().min(1),
  submissionId: z.string().min(1),
  issues: z.array(AmazonIssueSchema).default([]),
}).passthrough();
const AmazonListingStatusResponseSchema = z.object({
  sku: z.string().optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  fulfillmentAvailability: z.unknown().optional(),
  summaries: z.array(z.object({ status: z.array(z.string()).default([]) }).passthrough()).default([]),
  issues: z.array(AmazonIssueSchema).default([]),
}).passthrough();
const EtsyListingResponseSchema = z.object({
  listing_id: z.number().int().positive(),
  state: z.string().min(1),
  price: z.unknown().optional(),
  quantity: z.number().int().nonnegative().optional(),
}).passthrough();
const EtsyListingImageResponseSchema = z.object({
  listing_image_id: z.number().int().positive(),
}).passthrough();
const EtsyInventoryResponseSchema = z.object({
  products: z.array(z.object({
    sku: z.string().nullable().optional(),
    property_values: z.array(z.object({
      property_id: z.number().int().positive(),
      property_name: z.string().optional(),
      scale_id: z.number().int().positive().nullable().optional(),
      value_ids: z.array(z.number().int()).default([]),
      values: z.array(z.string()).default([]),
    }).passthrough()).default([]),
    offerings: z.array(z.object({
      price: z.unknown(),
      quantity: z.number().int().nonnegative(),
      is_enabled: z.boolean(),
      readiness_state_id: z.number().int().positive().nullable().optional(),
    }).passthrough()).default([]),
  }).passthrough()).default([]),
  price_on_property: z.array(z.number().int().positive()).default([]),
  quantity_on_property: z.array(z.number().int().positive()).default([]),
  sku_on_property: z.array(z.number().int().positive()).default([]),
  readiness_state_on_property: z.array(z.number().int().positive()).default([]),
}).passthrough();
const EtsyPersonalizationResponseSchema = z.object({}).passthrough();

function normalizeAmazonIssue(issue: z.infer<typeof AmazonIssueSchema>): MarketplacePublicationIssue {
  const severity = issue.severity?.toUpperCase();
  return {
    code: issue.code,
    message: issue.message,
    ...(issue.attributeNames?.length ? { path: issue.attributeNames.join(",") } : {}),
    severity: severity === "ERROR" ? "blocker" : severity === "WARNING" ? "warning" : "info",
  };
}

export function desiredOnlineListingState(payload: MarketplacePublicationPayload): { price: unknown | null; inventory: unknown | null } {
  if (payload.platform === "amazon") {
    return {
      price: payload.attributes.purchasable_offer ?? null,
      inventory: payload.attributes.fulfillment_availability ?? null,
    };
  }
  return payload.inventory
    ? { price: payload.inventory.products.map((product) => product.offerings.map((offering) => offering.price)), inventory: toEtsyInventoryBody(payload.inventory) }
    : { price: payload.price, inventory: { quantity: payload.quantity } };
}

function toEtsyInventoryBody(inventory: NonNullable<z.infer<typeof EtsyPublicationPayloadSchema>["inventory"]>) {
  return {
    products: inventory.products.map((product) => ({
      sku: product.sku,
      property_values: product.propertyValues.map((property) => ({
        property_id: property.propertyId,
        property_name: property.propertyName,
        ...(property.scaleId ? { scale_id: property.scaleId } : {}),
        value_ids: property.valueIds,
        values: property.values,
      })),
      offerings: product.offerings.map((offering) => ({
        price: offering.price.amount,
        quantity: offering.quantity,
        is_enabled: offering.isEnabled,
        ...(offering.readinessStateId ? { readiness_state_id: offering.readinessStateId } : {}),
      })),
    })),
    price_on_property: inventory.priceOnProperty,
    quantity_on_property: inventory.quantityOnProperty,
    sku_on_property: inventory.skuOnProperty,
    readiness_state_on_property: inventory.readinessStateOnProperty,
  };
}

function normalizeEtsyInventory(inventory: z.infer<typeof EtsyInventoryResponseSchema>) {
  return {
    products: inventory.products.map((product) => ({
      sku: product.sku ?? "",
      property_values: product.property_values.map((property) => ({
        property_id: property.property_id,
        ...(property.property_name ? { property_name: property.property_name } : {}),
        ...(property.scale_id ? { scale_id: property.scale_id } : {}),
        value_ids: property.value_ids,
        values: property.values,
      })),
      offerings: product.offerings.map((offering) => ({
        price: normalizeEtsyMoney(offering.price, "USD")?.amount ?? 0,
        quantity: offering.quantity,
        is_enabled: offering.is_enabled,
        ...(offering.readiness_state_id ? { readiness_state_id: offering.readiness_state_id } : {}),
      })),
    })),
    price_on_property: inventory.price_on_property,
    quantity_on_property: inventory.quantity_on_property,
    sku_on_property: inventory.sku_on_property,
    readiness_state_on_property: inventory.readiness_state_on_property,
  };
}

function normalizeEtsyMoney(value: unknown, fallbackCurrency: string): { amount: number; currency: string } | null {
  if (typeof value === "number" && Number.isFinite(value)) return { amount: value, currency: fallbackCurrency };
  if (!value || typeof value !== "object") return null;
  const money = value as Record<string, unknown>;
  const rawAmount = typeof money.amount === "number" ? money.amount : Number(money.amount);
  const divisor = typeof money.divisor === "number" ? money.divisor : Number(money.divisor ?? 1);
  if (!Number.isFinite(rawAmount) || !Number.isFinite(divisor) || divisor <= 0) return null;
  const currency = typeof money.currency_code === "string"
    ? money.currency_code
    : typeof money.currency === "string" ? money.currency : fallbackCurrency;
  return { amount: rawAmount / divisor, currency };
}

function normalizeAmazonFulfillmentAvailability(value: unknown): unknown | null {
  if (!Array.isArray(value)) return null;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const source = entry as Record<string, unknown>;
    return {
      ...(typeof source.fulfillmentChannelCode === "string" ? { fulfillment_channel_code: source.fulfillmentChannelCode } : {}),
      ...(typeof source.quantity === "number" ? { quantity: source.quantity } : {}),
      ...(typeof source.marketplaceId === "string" ? { marketplace_id: source.marketplaceId } : {}),
    };
  });
}

function etsyInventoryUrl(externalListingId: string): string {
  return `https://openapi.etsy.com/v3/application/listings/${encodeURIComponent(externalListingId)}/inventory?legacy=true`;
}

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
  return {
    "user-agent": "YummyAI/0.1 (Language=TypeScript)",
    "x-amz-access-token": accessToken,
    "x-amz-date": new Date().toISOString().replace(/[-:]|\.\d{3}/g, ""),
  };
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
