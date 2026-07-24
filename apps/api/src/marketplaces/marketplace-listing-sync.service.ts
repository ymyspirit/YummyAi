import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import {
  MarketplaceListingSyncEventViewSchema,
  MarketplaceListingSyncRequestViewSchema,
  createEntityId,
  type CreateMarketplaceListingSyncInput,
  type ListMarketplaceListingSyncsInput,
  type MarketplaceListingSyncEventView,
  type MarketplaceListingSyncRequestView,
  type MarketplaceCapability,
  type TenantContext,
} from "@yummyai/contracts";
import {
  listingVersions,
  listings,
  marketplaceAccounts,
  marketplaceCapabilitySnapshots,
  marketplaceListingSyncEvents,
  marketplaceListingSyncRequests,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { MarketplacePublicationPayloadSchema, desiredOnlineListingState, onlineListingStateForAction, type MarketplacePublicationPayload } from "@yummyai/marketplace-connectors";
import type { ListingDraft } from "@yummyai/platform-rules";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { ChannelInventoryService } from "../channel-inventory/channel-inventory.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_LISTING_SYNC_ENQUEUER } from "../platform.tokens.js";

export interface MarketplaceListingSyncEnqueuer {
  enqueue(input: { syncRequestId: string; requestedBy: string; tenantId: string }): Promise<void>;
}

@Injectable()
export class MarketplaceListingSyncService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MARKETPLACE_LISTING_SYNC_ENQUEUER) private readonly enqueuer: MarketplaceListingSyncEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ChannelInventoryService) private readonly channelInventory: ChannelInventoryService,
  ) {}

  async create(context: TenantContext, input: CreateMarketplaceListingSyncInput): Promise<MarketplaceListingSyncRequestView> {
    const prepared = await this.prepare(context, input);
    const requestKey = input.requestKey ?? createEntityId();
    const idempotencyKey = checksum({ version: 1, tenantId: context.tenantId, requestKey, action: input.action, desiredChecksum: prepared.desiredChecksum });
    const request = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
      const [existing] = await tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(marketplaceListingSyncRequests).values({
        id: createEntityId(), tenantId: context.tenantId, accountId: input.accountId,
        sourcePublicationRequestId: input.sourcePublicationRequestId, listingId: input.listingId,
        listingVersionId: input.listingVersionId, platform: prepared.payload.platform,
        marketplaceId: prepared.payload.marketplaceId, externalListingId: prepared.externalListingId,
        action: input.action, desiredState: prepared.desiredState, desiredChecksum: prepared.desiredChecksum,
        idempotencyKey, createdBy: context.userId,
      }).returning();
      await tx.insert(marketplaceListingSyncEvents).values({ id: createEntityId(), tenantId: context.tenantId, requestId: created!.id, sequence: 1, status: "queued", actorUserId: context.userId });
      return created!;
    });
    try {
      await this.enqueuer.enqueue({ syncRequestId: request.id, requestedBy: context.userId, tenantId: context.tenantId });
    } catch {
      await this.appendFailure(context, request.id, "SYNC_QUEUE_UNAVAILABLE", "Listing sync queue is unavailable");
      throw new ServiceUnavailableException("Listing sync queue is unavailable");
    }
    await this.audit.record(context, { action: "marketplace_listing_sync.enqueue", resourceType: "marketplace_listing_sync_request", resourceId: request.id, result: "success", metadata: { accountId: request.accountId, action: request.action, listingVersionId: request.listingVersionId, sourcePublicationRequestId: request.sourcePublicationRequestId } });
    return this.get(context, request.id);
  }

  async get(context: TenantContext, requestId: string): Promise<MarketplaceListingSyncRequestView> {
    const [request] = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, requestId)).limit(1));
    if (!request) throw new NotFoundException("Marketplace Listing sync request not found");
    return toRequestView(request, await this.latestEvent(context, requestId));
  }

  async list(context: TenantContext, input: ListMarketplaceListingSyncsInput): Promise<MarketplaceListingSyncRequestView[]> {
    return withTenant(this.database.db, context, async (tx) => {
      const requests = await tx.select().from(marketplaceListingSyncRequests).where(and(
        input.accountId ? eq(marketplaceListingSyncRequests.accountId, input.accountId) : undefined,
        input.listingId ? eq(marketplaceListingSyncRequests.listingId, input.listingId) : undefined,
      )).orderBy(desc(marketplaceListingSyncRequests.createdAt)).limit(input.limit);
      if (!requests.length) return [];
      const events = await tx.select().from(marketplaceListingSyncEvents).where(inArray(marketplaceListingSyncEvents.requestId, requests.map((request) => request.id))).orderBy(desc(marketplaceListingSyncEvents.sequence));
      const latest = new Map<string, EventRow>();
      for (const event of events) if (!latest.has(event.requestId)) latest.set(event.requestId, event);
      return requests.map((request) => {
        const event = latest.get(request.id);
        if (!event) throw new ConflictException("Marketplace Listing sync request has no event history");
        return toRequestView(request, toEventView(event));
      });
    });
  }

  async events(context: TenantContext, requestId: string): Promise<MarketplaceListingSyncEventView[]> {
    await this.get(context, requestId);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(marketplaceListingSyncEvents.sequence));
    return rows.map(toEventView);
  }

  private async prepare(context: TenantContext, input: CreateMarketplaceListingSyncInput): Promise<PreparedSync> {
    return withTenant(this.database.db, context, async (tx) => {
      const [[account], [listing], [version], [source], [sourceEvent], [capability]] = await Promise.all([
        tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, input.accountId)).limit(1),
        tx.select().from(listings).where(eq(listings.id, input.listingId)).limit(1),
        tx.select().from(listingVersions).where(eq(listingVersions.id, input.listingVersionId)).limit(1),
        tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.id, input.sourcePublicationRequestId)).limit(1),
        tx.select().from(marketplacePublicationEvents).where(eq(marketplacePublicationEvents.requestId, input.sourcePublicationRequestId)).orderBy(desc(marketplacePublicationEvents.sequence)).limit(1),
        tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, input.accountId)).orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1),
      ]);
      if (!account) throw new NotFoundException("Marketplace account not found");
      if (!listing || !version || version.listingId !== listing.id) throw new NotFoundException("Listing version not found");
      if (!source || !sourceEvent) throw new NotFoundException("Published marketplace request not found");
      if (!capability) throw new ConflictException("Marketplace capabilities must be synchronized before online Listing sync");
      if (source.accountId !== account.id || source.listingId !== listing.id || source.platform !== account.platform) throw new UnprocessableEntityException("Published marketplace request does not match the sync target");
      if (!(["amazon_submit", "amazon_feed_submit", "etsy_activate"] as string[]).includes(source.action) || sourceEvent.status !== "published") throw new ConflictException("Online Listing sync requires a published marketplace request");
      const externalListingId = sourceEvent.externalListingId ?? source.sourceExternalListingId;
      if (!externalListingId) throw new ConflictException("Published marketplace request has no external Listing ID");
      assertSyncAccount(account, capability, input.action, source.marketplaceId);
      if (listing.status !== "approved" || version.status !== "approved" || listing.primaryVersionId !== version.id || version.validation.blockers.length) throw new ConflictException("Online Listing sync requires the current approved Listing version");
      const sourcePayload = MarketplacePublicationPayloadSchema.parse(source.payload);
      const payload = buildSyncPayload(version.content, sourcePayload);
      if (isListingMutation(input.action)) {
        await this.channelInventory.assertMarketplaceAllocations(tx, {
          accountId: account.id,
          platform: payload.platform,
          marketplaceId: payload.marketplaceId,
          listingId: listing.id,
          desired: desiredInventoryTargets(version.content, payload),
        });
      }
      const desired = onlineListingStateForAction(input.action, desiredOnlineListingState(payload));
      return { desiredChecksum: checksum(desired), desiredState: { ...desired, payload }, externalListingId, payload };
    });
  }

  private async latestEvent(context: TenantContext, requestId: string) {
    const [event] = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1));
    if (!event) throw new ConflictException("Marketplace Listing sync request has no event history");
    return toEventView(event);
  }

  private async appendFailure(context: TenantContext, requestId: string, code: string, message: string) {
    await withTenant(this.database.db, context, async (tx) => {
      const [latest] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
      await tx.insert(marketplaceListingSyncEvents).values({ id: createEntityId(), tenantId: context.tenantId, requestId, sequence: (latest?.sequence ?? 0) + 1, status: "failed", code, message, actorUserId: context.userId });
    });
  }
}

type AccountRow = typeof marketplaceAccounts.$inferSelect;
type CapabilityRow = typeof marketplaceCapabilitySnapshots.$inferSelect;
type RequestRow = typeof marketplaceListingSyncRequests.$inferSelect;
type EventRow = typeof marketplaceListingSyncEvents.$inferSelect;

interface PreparedSync { desiredChecksum: string; desiredState: Record<string, unknown>; externalListingId: string; payload: MarketplacePublicationPayload }

function assertSyncAccount(account: AccountRow, capability: CapabilityRow, action: CreateMarketplaceListingSyncInput["action"], marketplaceId: string) {
  if (account.status !== "active" || account.healthStatus !== "healthy") throw new ConflictException("Marketplace account must be active and healthy before online Listing sync");
  if (account.credentialStatus !== "valid" && account.credentialStatus !== "expiring") throw new UnauthorizedException("Marketplace account is not authorized");
  if (capability.expiresAt.getTime() <= Date.now()) throw new ConflictException("Marketplace capabilities are stale");
  if (!account.externalAccountId || !account.marketplaceIds.includes(marketplaceId) || !capability.marketplaceIds.includes(marketplaceId)) throw new ConflictException("Published marketplace target is not available on the authorized account");
  const required: MarketplaceCapability[] = isListingMutation(action) ? ["listing_write", "inventory_write"] : ["listing_read"];
  for (const capabilityName of required) if (!account.capabilities.includes(capabilityName) || !capability.capabilities.includes(capabilityName)) throw new ConflictException(`Online Listing sync requires ${capabilityName}`);
}

function isListingMutation(action: CreateMarketplaceListingSyncInput["action"]): boolean {
  return action === "push_price_inventory" || action === "push_full_content";
}

function buildSyncPayload(content: ListingDraft, source: MarketplacePublicationPayload): MarketplacePublicationPayload {
  if (!content.publication || content.publication.platform !== content.platform || source.platform !== content.platform) throw new UnprocessableEntityException("Approved Listing version is missing matching publication settings");
  if (source.platform === "amazon" && content.publication.platform === "amazon") return MarketplacePublicationPayloadSchema.parse({ ...source, productType: content.publication.productType, attributes: content.publication.attributes });
  if (source.platform === "etsy" && content.publication.platform === "etsy") {
    const personalization = content.personalization?.enabled
      ? {
          instructions: content.personalization.instructions ?? "",
          required: content.personalization.required ?? false,
          maxAllowedCharacters: content.personalization.maxAllowedCharacters ?? 256,
        }
      : undefined;
    return MarketplacePublicationPayloadSchema.parse({
      ...source,
      locale: content.locale,
      title: content.title,
      description: content.description,
      tags: content.tags,
      price: content.publication.price,
      quantity: content.publication.quantity,
      whoMade: content.publication.whoMade,
      whenMade: content.publication.whenMade,
      taxonomyId: content.publication.taxonomyId,
      shippingProfileId: content.publication.shippingProfileId,
      readinessStateId: content.publication.readinessStateId,
      shopSectionId: content.publication.shopSectionId,
      isSupply: content.publication.isSupply,
      inventory: content.publication.inventory,
      personalization,
    });
  }
  throw new UnprocessableEntityException("Approved Listing version does not match the published channel");
}

function desiredInventoryTargets(
  content: ListingDraft,
  payload: MarketplacePublicationPayload,
): Array<{ skuCode: string; quantity: number }> {
  if (payload.platform === "amazon") {
    const inventory = payload.attributes.fulfillment_availability;
    if (!Array.isArray(inventory)) return [];
    const quantity = inventory.reduce((total, entry) => {
      if (!entry || typeof entry !== "object") return total;
      const value = (entry as Record<string, unknown>).quantity;
      return total + (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);
    }, 0);
    return [{ skuCode: payload.sku, quantity }];
  }
  if (payload.inventory) {
    return payload.inventory.products.map((product) => ({
      skuCode: product.sku,
      quantity: Math.max(
        0,
        ...product.offerings
          .filter((offering) => offering.isEnabled)
          .map((offering) => offering.quantity),
      ),
    }));
  }
  const variant = content.variants[0];
  if (!variant) throw new UnprocessableEntityException("Etsy inventory sync requires a Listing variant");
  return [{ skuCode: variant.skuCode, quantity: payload.quantity }];
}

function toRequestView(request: RequestRow, current: MarketplaceListingSyncEventView): MarketplaceListingSyncRequestView { return MarketplaceListingSyncRequestViewSchema.parse({ id: request.id, accountId: request.accountId, sourcePublicationRequestId: request.sourcePublicationRequestId, listingId: request.listingId, listingVersionId: request.listingVersionId, platform: request.platform, marketplaceId: request.marketplaceId, externalListingId: request.externalListingId, action: request.action, idempotencyKey: request.idempotencyKey, desiredChecksum: request.desiredChecksum, createdBy: request.createdBy, createdAt: request.createdAt.toISOString(), current }); }
function toEventView(event: EventRow): MarketplaceListingSyncEventView { return MarketplaceListingSyncEventViewSchema.parse({ id: event.id, sequence: event.sequence, status: event.status, code: event.code, message: event.message, issues: event.issues, snapshot: event.snapshot, snapshotChecksum: event.snapshotChecksum, retryable: event.retryable, occurredAt: event.occurredAt.toISOString() }); }
function checksum(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
