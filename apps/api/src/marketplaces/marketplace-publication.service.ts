import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  MarketplacePublicationEventViewSchema,
  MarketplacePublicationRequestViewSchema,
  createEntityId,
  type CancelMarketplacePublicationInput,
  type CreateMarketplacePublicationInput,
  type ListMarketplacePublicationsInput,
  type MarketplacePublicationEventView,
  type MarketplacePublicationRequestView,
  type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles,
  listingVersions,
  listings,
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  type DatabaseConnection,
  type MarketplacePublicationAssetPin,
  withTenant,
} from "@yummyai/database";
import {
  MarketplacePublicationPayloadSchema,
  type MarketplacePublicationPayload,
} from "@yummyai/marketplace-connectors";
import type { ListingDraft } from "@yummyai/platform-rules";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_PUBLICATION_ENQUEUER } from "../platform.tokens.js";

export interface MarketplacePublicationEnqueuer {
  enqueue(input: {
    delayMs: number;
    publicationRequestId: string;
    requestedBy: string;
    tenantId: string;
  }): Promise<void>;
  cancel(publicationRequestId: string): Promise<void>;
}

@Injectable()
export class MarketplacePublicationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MARKETPLACE_PUBLICATION_ENQUEUER) private readonly enqueuer: MarketplacePublicationEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(
    context: TenantContext,
    input: CreateMarketplacePublicationInput,
  ): Promise<MarketplacePublicationRequestView> {
    const prepared = await this.prepare(context, input);
    const scheduledFor = normalizeSchedule(input.scheduledFor);
    const request = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${prepared.idempotencyKey}, 0))`);
      const [existing] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.idempotencyKey, prepared.idempotencyKey))
        .limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(marketplacePublicationRequests).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: input.accountId,
        capabilitySnapshotId: prepared.capabilitySnapshotId,
        listingId: input.listingId,
        listingVersionId: input.listingVersionId,
        platform: prepared.payload.platform,
        marketplaceId: input.marketplaceId,
        action: prepared.payload.platform === "amazon" ? "amazon_validation_preview" : "etsy_create_draft",
        idempotencyKey: prepared.idempotencyKey,
        payload: prepared.payload,
        payloadChecksum: checksum(prepared.payload),
        assetManifest: prepared.assets,
        scheduledFor,
        createdBy: context.userId,
      }).returning();
      await tx.insert(marketplacePublicationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId: created!.id,
        sequence: 1,
        status: scheduledFor ? "scheduled" : "queued",
        actorUserId: context.userId,
      });
      return created!;
    });

    await this.enqueueIfRequired(context, request);

    await this.audit.record(context, {
      action: "marketplace_publication.enqueue",
      resourceType: "marketplace_publication_request",
      resourceId: request.id,
      result: "success",
      metadata: {
        action: request.action,
        accountId: request.accountId,
        capabilitySnapshotId: request.capabilitySnapshotId,
        listingVersionId: request.listingVersionId,
        marketplaceId: request.marketplaceId,
      },
    });
    return this.get(context, request.id);
  }

  async cancel(
    context: TenantContext,
    requestId: string,
    input: CancelMarketplacePublicationInput,
  ): Promise<MarketplacePublicationRequestView> {
    const shouldCancel = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [request] = await tx.select({ id: marketplacePublicationRequests.id })
        .from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId))
        .limit(1);
      if (!request) throw new NotFoundException("Marketplace publication request not found");
      const [latest] = await tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1);
      if (!latest) throw new NotFoundException("Marketplace publication event not found");
      if (latest.status === "cancelled") return false;
      if (!["scheduled", "queued", "retry_pending"].includes(latest.status)) {
        throw new ConflictException("Only waiting marketplace publications can be cancelled");
      }
      await tx.insert(marketplacePublicationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId,
        sequence: latest.sequence + 1,
        status: "cancelled",
        code: "PUBLICATION_CANCELLED_BY_USER",
        message: input.reason,
        retryable: false,
        actorUserId: context.userId,
      });
      return true;
    });

    if (!shouldCancel) return this.get(context, requestId);

    let queueCleanup = "removed";
    try {
      await this.enqueuer.cancel(requestId);
    } catch {
      queueCleanup = "worker_will_observe_cancelled_event";
    }
    await this.audit.record(context, {
      action: "marketplace_publication.cancel",
      resourceType: "marketplace_publication_request",
      resourceId: requestId,
      result: "success",
      metadata: { queueCleanup },
    });
    return this.get(context, requestId);
  }

  async continue(
    context: TenantContext,
    parentRequestId: string,
  ): Promise<MarketplacePublicationRequestView> {
    const request = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parentRequestId}, 0))`);
      const [parent] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, parentRequestId))
        .limit(1);
      if (!parent) throw new NotFoundException("Marketplace publication request not found");
      const [parentEvent] = await tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, parentRequestId))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1);
      if (!parentEvent) throw new NotFoundException("Marketplace publication event not found");
      const continuation = continuationFor(parent, parentEvent);
      const idempotencyKey = checksum({
        version: 1,
        tenantId: context.tenantId,
        parentRequestId,
        action: continuation.action,
      });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
      const [existing] = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing) return existing;

      const [[account], [listing], [version], [capability]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, parent.accountId)).limit(1),
        tx.select().from(listings).where(eq(listings.id, parent.listingId)).limit(1),
        tx.select().from(listingVersions).where(eq(listingVersions.id, parent.listingVersionId)).limit(1),
        tx.select().from(marketplaceCapabilitySnapshots)
          .where(eq(marketplaceCapabilitySnapshots.accountId, parent.accountId))
          .orderBy(desc(marketplaceCapabilitySnapshots.version))
          .limit(1),
      ]);
      if (!account) throw new NotFoundException("Marketplace account not found");
      if (!listing || !version || version.listingId !== listing.id) {
        throw new NotFoundException("Approved Listing version not found");
      }
      if (!capability) throw new ConflictException("Marketplace capabilities must be synchronized before publication");
      assertAccount(account, parent.marketplaceId);
      assertListing(listing, version, account.platform);
      assertCapability(capability, account.platform, parent.marketplaceId, version.content);
      assertContinuationCapability(account, capability, continuation.action);

      const payload = MarketplacePublicationPayloadSchema.parse(parent.payload);
      if (checksum(parent.payload) !== parent.payloadChecksum || payload.platform !== parent.platform) {
        throw new ConflictException("Pinned marketplace publication payload is invalid");
      }
      const assetIds = parent.assetManifest.map((pin) => pin.assetId);
      const assets = assetIds.length === 0
        ? []
        : await tx.select().from(assetFiles).where(and(
            inArray(assetFiles.id, assetIds),
            isNull(assetFiles.deletedAt),
          ));
      assertPinnedAssets(parent.assetManifest, assets);
      if (continuation.action === "etsy_activate" &&
          !parent.assetManifest.some((pin) => pin.publicationRole !== "supplemental")) {
        throw new UnprocessableEntityException("Etsy activation requires at least one approved listing image");
      }

      const [created] = await tx.insert(marketplacePublicationRequests).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: parent.accountId,
        capabilitySnapshotId: capability.id,
        listingId: parent.listingId,
        listingVersionId: parent.listingVersionId,
        platform: parent.platform,
        marketplaceId: parent.marketplaceId,
        action: continuation.action,
        parentRequestId: parent.id,
        sourceExternalListingId: continuation.sourceExternalListingId,
        idempotencyKey,
        payload,
        payloadChecksum: parent.payloadChecksum,
        assetManifest: parent.assetManifest,
        createdBy: context.userId,
      }).returning();
      await tx.insert(marketplacePublicationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId: created!.id,
        sequence: 1,
        status: "queued",
        actorUserId: context.userId,
      });
      return created!;
    });

    await this.enqueueIfRequired(context, request);
    await this.audit.record(context, {
      action: "marketplace_publication.continue",
      resourceType: "marketplace_publication_request",
      resourceId: request.id,
      result: "success",
      metadata: {
        action: request.action,
        parentRequestId: request.parentRequestId,
        sourceExternalListingId: request.sourceExternalListingId,
      },
    });
    return this.get(context, request.id);
  }

  async get(context: TenantContext, requestId: string): Promise<MarketplacePublicationRequestView> {
    const [request] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, requestId))
        .limit(1),
    );
    if (!request) throw new NotFoundException("Marketplace publication request not found");
    return toRequestView(request, await this.latestEvent(context, requestId));
  }

  async list(
    context: TenantContext,
    input: ListMarketplacePublicationsInput,
  ): Promise<MarketplacePublicationRequestView[]> {
    return withTenant(this.database.db, context, async (tx) => {
      const requests = await tx.select().from(marketplacePublicationRequests)
        .where(and(
          input.accountId ? eq(marketplacePublicationRequests.accountId, input.accountId) : undefined,
          input.listingId ? eq(marketplacePublicationRequests.listingId, input.listingId) : undefined,
        ))
        .orderBy(desc(marketplacePublicationRequests.createdAt))
        .limit(input.limit);
      if (requests.length === 0) return [];
      const events = await tx.select().from(marketplacePublicationEvents)
        .where(inArray(marketplacePublicationEvents.requestId, requests.map((request) => request.id)))
        .orderBy(desc(marketplacePublicationEvents.sequence));
      const currentByRequest = new Map<string, EventRow>();
      for (const event of events) {
        if (!currentByRequest.has(event.requestId)) currentByRequest.set(event.requestId, event);
      }
      return requests.map((request) => {
        const current = currentByRequest.get(request.id);
        if (!current) throw new ConflictException("Marketplace publication request has no event history");
        return toRequestView(request, toEventView(current));
      });
    });
  }

  async events(context: TenantContext, requestId: string): Promise<MarketplacePublicationEventView[]> {
    await this.get(context, requestId);
    const events = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(marketplacePublicationEvents.sequence),
    );
    return events.map(toEventView);
  }

  private async prepare(context: TenantContext, input: CreateMarketplacePublicationInput): Promise<PreparedPublication> {
    return withTenant(this.database.db, context, async (tx) => {
      const [[account], [listing], [version], [capability]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, input.accountId)).limit(1),
        tx.select().from(listings).where(eq(listings.id, input.listingId)).limit(1),
        tx.select().from(listingVersions).where(eq(listingVersions.id, input.listingVersionId)).limit(1),
        tx.select().from(marketplaceCapabilitySnapshots)
          .where(eq(marketplaceCapabilitySnapshots.accountId, input.accountId))
          .orderBy(desc(marketplaceCapabilitySnapshots.version))
          .limit(1),
      ]);
      if (!account) throw new NotFoundException("Marketplace account not found");
      if (!listing || !version || version.listingId !== listing.id) {
        throw new NotFoundException("Approved Listing version not found");
      }
      if (!capability) throw new ConflictException("Marketplace capabilities must be synchronized before publication");
      assertAccount(account, input.marketplaceId);
      assertListing(listing, version, account.platform);
      assertCapability(capability, account.platform, input.marketplaceId, version.content);

      const assetReferences = publicationAssetReferences(version.content);
      for (const reference of assetReferences) {
        if (!z.uuidv7().safeParse(reference.assetId).success) {
          throw new UnprocessableEntityException(`Listing references an invalid asset ID: ${reference.assetId}`);
        }
      }
      const assetIds = assetReferences.map((reference) => reference.assetId);
      const assets = assetIds.length === 0
        ? []
        : await tx.select().from(assetFiles).where(and(
            inArray(assetFiles.id, assetIds),
            isNull(assetFiles.deletedAt),
          ));
      const pins = pinAssets(assetReferences, assets);
      const payload = buildPayload(version.content, input);
      const action = payload.platform === "amazon" ? "amazon_validation_preview" : "etsy_create_draft";
      return {
        assets: pins,
        capabilitySnapshotId: capability.id,
        idempotencyKey: checksum({
          version: 1,
          tenantId: context.tenantId,
          accountId: input.accountId,
          listingVersionId: input.listingVersionId,
          marketplaceId: input.marketplaceId,
          variantSkuId: input.variantSkuId ?? null,
          action,
        }),
        payload,
      };
    });
  }

  private async latestEvent(context: TenantContext, requestId: string): Promise<MarketplacePublicationEventView> {
    const [event] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1),
    );
    if (!event) throw new NotFoundException("Marketplace publication event not found");
    return toEventView(event);
  }

  private async enqueueIfRequired(context: TenantContext, request: RequestRow): Promise<void> {
    const current = await this.latestEvent(context, request.id);
    if (terminalStatus.has(current.status)) return;
    try {
      await this.enqueuer.enqueue({
        delayMs: Math.max(0, (request.scheduledFor?.getTime() ?? Date.now()) - Date.now()),
        publicationRequestId: request.id,
        requestedBy: context.userId,
        tenantId: context.tenantId,
      });
    } catch {
      await this.appendEvent(context, request.id, {
        status: "retry_pending",
        code: "PUBLICATION_QUEUE_UNAVAILABLE",
        message: "Publication queue is unavailable",
        retryable: true,
      });
      await this.audit.record(context, {
        action: "marketplace_publication.enqueue",
        resourceType: "marketplace_publication_request",
        resourceId: request.id,
        result: "failure",
        metadata: { errorCode: "PUBLICATION_QUEUE_UNAVAILABLE" },
      });
      throw new ServiceUnavailableException("Marketplace publication queue is unavailable");
    }
  }

  private async appendEvent(
    context: TenantContext,
    requestId: string,
    event: { status: "retry_pending"; code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const [latest] = await tx.select({ sequence: marketplacePublicationEvents.sequence })
        .from(marketplacePublicationEvents)
        .where(eq(marketplacePublicationEvents.requestId, requestId))
        .orderBy(desc(marketplacePublicationEvents.sequence))
        .limit(1);
      await tx.insert(marketplacePublicationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId,
        sequence: (latest?.sequence ?? 0) + 1,
        status: event.status,
        code: event.code,
        message: event.message,
        retryable: event.retryable,
        actorUserId: context.userId,
      });
    });
  }
}

type AccountRow = typeof marketplaceAccounts.$inferSelect;
type CapabilityRow = typeof marketplaceCapabilitySnapshots.$inferSelect;
type ListingRow = typeof listings.$inferSelect;
type ListingVersionRow = typeof listingVersions.$inferSelect;
type AssetRow = typeof assetFiles.$inferSelect;
type RequestRow = typeof marketplacePublicationRequests.$inferSelect;
type EventRow = typeof marketplacePublicationEvents.$inferSelect;

interface PreparedPublication {
  assets: MarketplacePublicationAssetPin[];
  capabilitySnapshotId: string;
  idempotencyKey: string;
  payload: MarketplacePublicationPayload;
}

const terminalStatus = new Set([
  "validation_passed",
  "validation_failed",
  "draft_created",
  "published",
  "publication_failed",
  "deactivated",
  "reconciliation_required",
  "cancelled",
  "failed",
]);

function assertAccount(account: AccountRow, marketplaceId: string): void {
  if (account.status !== "active" || account.healthStatus !== "healthy") {
    throw new ConflictException("Marketplace account must be active and healthy before publication");
  }
  if (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring") {
    throw new UnauthorizedException("Marketplace account is not authorized");
  }
  if (!account.capabilities.includes("listing_write")) {
    throw new ConflictException("Marketplace account does not grant listing_write");
  }
  if (!account.marketplaceIds.includes(marketplaceId)) {
    throw new UnprocessableEntityException("Target marketplace is not authorized for this account");
  }
  if (!account.externalAccountId) {
    throw new ConflictException("Marketplace account authorization is incomplete");
  }
}

function assertContinuationCapability(
  account: AccountRow,
  capability: CapabilityRow,
  action: "amazon_submit" | "etsy_activate",
): void {
  if (action !== "etsy_activate") return;
  for (const required of ["media_write", "inventory_write"] as const) {
    if (!account.capabilities.includes(required) || !capability.capabilities.includes(required)) {
      throw new ConflictException(`Etsy activation requires current ${required} capability`);
    }
  }
}

function assertListing(listing: ListingRow, version: ListingVersionRow, platform: string): void {
  if (listing.platform !== platform || version.content.platform !== platform) {
    throw new UnprocessableEntityException("Listing platform does not match the marketplace account");
  }
  if (listing.status !== "approved" || version.status !== "approved" || listing.primaryVersionId !== version.id) {
    throw new ConflictException("Only the current approved Listing version can be published");
  }
  if (version.validation.blockers.length > 0) {
    throw new ConflictException("Listing has blocking validation issues");
  }
  if (!version.content.publication || version.content.publication.platform !== platform) {
    throw new UnprocessableEntityException("Approved Listing version is missing platform publication settings");
  }
}

function assertCapability(
  capability: CapabilityRow,
  platform: string,
  marketplaceId: string,
  content: ListingDraft,
): void {
  if (capability.platform !== platform || !capability.marketplaceIds.includes(marketplaceId)) {
    throw new ConflictException("Latest capability snapshot does not cover the publication target");
  }
  if (capability.expiresAt.getTime() <= Date.now()) {
    throw new ConflictException("Marketplace capabilities are stale; synchronize them before publication");
  }
  if (!capability.capabilities.includes("listing_write")) {
    throw new ConflictException("Latest capability snapshot does not grant listing_write");
  }
  const publication = content.publication!;
  if (publication.platform === "amazon") {
    const definitions = arrayValue(capability.data.productDefinitions);
    const matched = definitions.some((entry) => {
      const definition = recordValue(entry);
      return definition?.productType === publication.productType &&
        arrayValue(definition.marketplaceIds).includes(marketplaceId);
    });
    if (!matched) {
      throw new ConflictException("Amazon Product Type Definition is missing or stale for this publication");
    }
    return;
  }
  const taxonomy = arrayValue(capability.data.taxonomyProperties).some((entry) =>
    recordValue(entry)?.taxonomyId === publication.taxonomyId,
  );
  if (!taxonomy) throw new ConflictException("Etsy taxonomy properties are missing for this publication");
  if (!listResultsContain(capability.data.shippingProfiles, publication.shippingProfileId, ["shipping_profile_id", "id"])) {
    throw new ConflictException("Etsy shipping profile is not present in the latest capability snapshot");
  }
  if (!listResultsContain(capability.data.readinessProfiles, publication.readinessStateId, ["readiness_state_definition_id", "readiness_state_id", "id"])) {
    throw new ConflictException("Etsy readiness profile is not present in the latest capability snapshot");
  }
}

function buildPayload(content: ListingDraft, input: CreateMarketplacePublicationInput): MarketplacePublicationPayload {
  const publication = content.publication!;
  if (publication.platform === "amazon") {
    if (!input.variantSkuId) throw new UnprocessableEntityException("Amazon publication requires variantSkuId");
    const variant = content.variants.find((candidate) => candidate.skuId === input.variantSkuId);
    if (!variant) throw new UnprocessableEntityException("Amazon publication variant is not part of the approved Listing version");
    return MarketplacePublicationPayloadSchema.parse({
      platform: "amazon",
      marketplaceId: input.marketplaceId,
      locale: content.locale,
      productType: publication.productType,
      sku: variant.skuCode,
      attributes: publication.attributes,
    });
  }
  if (input.variantSkuId) throw new UnprocessableEntityException("Etsy draft creation does not accept variantSkuId");
  if (content.variants.length > 1 && !publication.inventory) {
    throw new UnprocessableEntityException("Etsy listings with multiple variants require a complete inventory mapping");
  }
  const personalization = content.personalization?.enabled
    ? {
        instructions: content.personalization.instructions ?? "",
        required: content.personalization.required ?? false,
        maxAllowedCharacters: content.personalization.maxAllowedCharacters ?? 256,
      }
    : undefined;
  if (personalization && !personalization.instructions.trim()) {
    throw new UnprocessableEntityException("Enabled Etsy personalization requires instructions");
  }
  return MarketplacePublicationPayloadSchema.parse({
    platform: "etsy",
    marketplaceId: input.marketplaceId,
    locale: content.locale,
    title: content.title,
    description: content.description,
    tags: content.tags,
    price: publication.price,
    quantity: publication.quantity,
    whoMade: publication.whoMade,
    whenMade: publication.whenMade,
    taxonomyId: publication.taxonomyId,
    shippingProfileId: publication.shippingProfileId,
    readinessStateId: publication.readinessStateId,
    shopSectionId: publication.shopSectionId,
    isSupply: publication.isSupply,
    inventory: publication.inventory,
    personalization,
  });
}

interface PublicationAssetReference {
  assetId: string;
  publicationRole: "listing_media" | "supplemental";
  rank?: number;
}

function publicationAssetReferences(content: ListingDraft): PublicationAssetReference[] {
  const references: PublicationAssetReference[] = [];
  const seen = new Set<string>();
  for (const assetId of [...(content.mainImageId ? [content.mainImageId] : []), ...content.mediaAssetIds]) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    references.push({ assetId, publicationRole: "listing_media", rank: references.length + 1 });
  }
  for (const assetId of content.aPlusModules?.flatMap((module) => module.assetIds) ?? []) {
    if (seen.has(assetId)) continue;
    seen.add(assetId);
    references.push({ assetId, publicationRole: "supplemental" });
  }
  return references;
}

function pinAssets(references: readonly PublicationAssetReference[], assets: readonly AssetRow[]): MarketplacePublicationAssetPin[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  return references.map((reference) => {
    const asset = byId.get(reference.assetId);
    if (!asset) throw new UnprocessableEntityException(`Listing asset is missing or deleted: ${reference.assetId}`);
    if (asset.assetDomain !== "authorized") {
      throw new UnprocessableEntityException(`Research-domain asset cannot be published: ${reference.assetId}`);
    }
    if (asset.rightsStatus !== "approved") {
      throw new UnprocessableEntityException(`Listing asset does not have approved rights: ${reference.assetId}`);
    }
    return {
      assetId: asset.id,
      assetVersion: asset.version,
      assetDomain: "authorized",
      rightsStatus: "approved",
      checksumSha256: asset.checksumSha256,
      objectKey: asset.objectKey,
      fileName: asset.fileName,
      mediaType: asset.mediaType,
      publicationRole: reference.publicationRole,
      rank: reference.rank,
    };
  });
}

function assertPinnedAssets(pins: readonly MarketplacePublicationAssetPin[], assets: readonly AssetRow[]): void {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  for (const pin of pins) {
    const asset = byId.get(pin.assetId);
    if (!asset || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" ||
        asset.version !== pin.assetVersion || asset.checksumSha256 !== pin.checksumSha256 ||
        asset.objectKey !== pin.objectKey || asset.fileName !== pin.fileName || asset.mediaType !== pin.mediaType) {
      throw new ConflictException(`Pinned authorized asset is no longer publishable: ${pin.assetId}`);
    }
  }
}

function continuationFor(
  request: RequestRow,
  event: EventRow,
): { action: "amazon_submit" | "etsy_activate"; sourceExternalListingId: string | null } {
  if (request.action === "amazon_validation_preview" && event.status === "validation_passed") {
    return { action: "amazon_submit", sourceExternalListingId: null };
  }
  if (request.action === "etsy_create_draft" && event.status === "draft_created" && event.externalListingId) {
    return { action: "etsy_activate", sourceExternalListingId: event.externalListingId };
  }
  throw new ConflictException("Publication request is not ready for the next marketplace action");
}

function listResultsContain(value: unknown, id: number, keys: readonly string[]): boolean {
  const list = recordValue(value);
  return arrayValue(list?.results).some((entry) => {
    const result = recordValue(entry);
    return keys.some((key) => Number(result?.[key]) === id);
  });
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toRequestView(request: RequestRow, current: MarketplacePublicationEventView): MarketplacePublicationRequestView {
  return MarketplacePublicationRequestViewSchema.parse({
    id: request.id,
    accountId: request.accountId,
    capabilitySnapshotId: request.capabilitySnapshotId,
    listingId: request.listingId,
    listingVersionId: request.listingVersionId,
    platform: request.platform,
    marketplaceId: request.marketplaceId,
    action: request.action,
    parentRequestId: request.parentRequestId,
    sourceExternalListingId: request.sourceExternalListingId,
    idempotencyKey: request.idempotencyKey,
    payloadChecksum: request.payloadChecksum,
    assetCount: request.assetManifest.length,
    scheduledFor: request.scheduledFor?.toISOString() ?? null,
    createdBy: request.createdBy,
    createdAt: request.createdAt.toISOString(),
    current,
  });
}

function normalizeSchedule(value: string | undefined): Date | null {
  if (!value) return null;
  const scheduledFor = new Date(value);
  const now = Date.now();
  if (scheduledFor.getTime() <= now) {
    throw new UnprocessableEntityException("Scheduled publication time must be in the future");
  }
  if (scheduledFor.getTime() > now + 90 * 24 * 60 * 60 * 1_000) {
    throw new UnprocessableEntityException("Scheduled publication time cannot exceed 90 days");
  }
  return scheduledFor;
}

function toEventView(event: EventRow): MarketplacePublicationEventView {
  return MarketplacePublicationEventViewSchema.parse({
    id: event.id,
    sequence: event.sequence,
    status: event.status,
    code: event.code,
    message: event.message,
    issues: event.issues,
    externalListingId: event.externalListingId,
    externalSubmissionId: event.externalSubmissionId,
    externalMediaIds: event.externalMediaIds,
    externalState: event.externalState,
    retryable: event.retryable,
    occurredAt: event.occurredAt.toISOString(),
  });
}
