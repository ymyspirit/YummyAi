import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, erpPermissionContext, intersectPermissionContexts, Permission, type PermissionValue } from "@yummyai/authz";
import { assertCatalogListingAccess, catalogOwnerFilter, currentCatalogContext } from "@yummyai/catalog-core";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  CreateMarketplaceListingSyncInputSchema, ListMarketplaceListingSyncsInputSchema,
  MarketplaceListingSyncEventViewSchema, MarketplaceListingSyncRequestViewSchema, createEntityId,
  type CreateMarketplaceListingSyncInput, type ListMarketplaceListingSyncsInput,
  type MarketplaceListingSyncEventView, type MarketplaceListingSyncRequestView,
  type MarketplaceCapability, type TenantContext,
} from "@yummyai/contracts";
import { LISTING_SYNC_INTENT_PROTOCOL, ListingSyncIntentLookupSchema, ListingSyncIntentReceiptSchema,
  ListingSyncIntentWorkspaceSchema, listingSyncIntentRequestText, type ListingSyncIntentLookup,
  type ListingSyncIntentReceipt, type ListingSyncIntentWorkspace } from "@yummyai/contracts/marketplace/listing-sync-intent";
import {
  listingVersions, listings, loadCurrentMembershipContext, marketplaceAccounts, marketplaceCapabilitySnapshots,
  marketplaceListingSyncEvents, marketplaceListingSyncIntents, marketplaceListingSyncRequests,
  marketplacePublicationEvents, marketplacePublicationRequests, type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { MarketplacePublicationPayloadSchema, desiredOnlineListingState, onlineListingStateForAction, type MarketplacePublicationPayload } from "@yummyai/marketplace-connectors";
import type { ListingDraft } from "@yummyai/platform-rules";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { withCatalogTenant } from "../catalog/catalog-access.js";
import { ChannelInventoryService } from "../channel-inventory/channel-inventory.service.js";
import { DATABASE_CONNECTION, MARKETPLACE_LISTING_SYNC_ENQUEUER } from "../platform.tokens.js";
import { currentMarketplaceAuthority, databaseNow } from "./marketplace-authority.js";

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

  async create(ceiling: TenantContext, raw: CreateMarketplaceListingSyncInput): Promise<MarketplaceListingSyncRequestView> {
    const input = CreateMarketplaceListingSyncInputSchema.parse(raw);
    const originalRequestKey = input.requestKey ?? createEntityId();
    const requestKey = originalRequestKey.toLowerCase();
    const requestChecksum = createHash("sha256").update(listingSyncIntentRequestText(input)).digest("hex");
    const saved = await withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, Permission.ListingPublish);
      authorize(context, Permission.StoreRead);
      const lockKey = `listing-sync-intent:${context.tenantId.toLowerCase()}:${context.userId.toLowerCase()}:${requestKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [intent] = await tx.select().from(marketplaceListingSyncIntents).where(and(
        eq(marketplaceListingSyncIntents.createdBy, context.userId), eq(marketplaceListingSyncIntents.requestKey, requestKey),
      )).limit(1);
      if (intent) {
        const request = await this.request(tx, intent.requestId);
        await this.access(tx, context, request, Permission.ListingPublish);
        this.assertIntentRequest(intent, request, context);
        this.assertIntentChecksum(intent.requestChecksum, requestChecksum);
        return { request, replayed: true };
      }
      const access = await this.access(tx, context, input, Permission.ListingPublish);
      const legacy = input.requestKey ? await this.legacyRequest(tx, context, input, originalRequestKey) : null;
      if (legacy) return this.recoverLegacy(tx, context, legacy, input, requestKey, requestChecksum);
      const prepared = await this.prepare(tx, input, access);
      const legacyKey = checksum({ version: 1, tenantId: context.tenantId, requestKey: originalRequestKey,
        action: input.action, desiredChecksum: prepared.desiredChecksum });
      const [collision] = await tx.select().from(marketplaceListingSyncRequests)
        .where(eq(marketplaceListingSyncRequests.idempotencyKey, legacyKey)).limit(1);
      if (collision) return this.recoverLegacy(tx, context, collision, input, requestKey, requestChecksum);
      // Version 1 hashes and historical requests remain unchanged. A new intent
      // binds the actor, original key and complete immutable target instead.
      const idempotencyKey = checksum({ version: 2, tenantId: context.tenantId, createdBy: context.userId, requestKey, requestChecksum });
      const [request] = await tx.insert(marketplaceListingSyncRequests).values({
        id: createEntityId(), tenantId: context.tenantId, accountId: input.accountId,
        sourcePublicationRequestId: input.sourcePublicationRequestId, listingId: input.listingId,
        listingVersionId: input.listingVersionId, platform: prepared.payload.platform,
        marketplaceId: prepared.payload.marketplaceId, externalListingId: prepared.externalListingId,
        action: input.action, desiredState: prepared.desiredState, desiredChecksum: prepared.desiredChecksum,
        idempotencyKey, createdBy: context.userId,
      }).returning();
      if (!request) throw new ConflictException("Marketplace Listing sync request could not be saved");
      await tx.insert(marketplaceListingSyncEvents).values({ id: createEntityId(), tenantId: context.tenantId,
        requestId: request.id, sequence: 1, status: "queued", actorUserId: context.userId });
      await tx.insert(marketplaceListingSyncIntents).values({ id: createEntityId(), tenantId: context.tenantId,
        requestKey, createdBy: context.userId, requestId: request.id, requestChecksum });
      await this.audit.recordInTransaction(tx, context, { action: "marketplace_listing_sync.intent.create", resourceType: "marketplace_listing_sync_request",
        resourceId: request.id, result: "success", metadata: { accountId: request.accountId, action: request.action,
          listingVersionId: request.listingVersionId, sourcePublicationRequestId: request.sourcePublicationRequestId,
          requestKey, requestChecksum, dispatch: "pending" } });
      return { request, replayed: false };
    });
    if (!saved.replayed) {
      try { await this.enqueuer.enqueue({ syncRequestId: saved.request.id, requestedBy: ceiling.userId, tenantId: ceiling.tenantId }); }
      catch {
        await this.appendFailure(ceiling, saved.request.id, "SYNC_QUEUE_UNAVAILABLE", "Listing sync queue is unavailable");
        throw new ServiceUnavailableException({ code: "listing_sync_queue_unavailable", message: "Listing sync queue is unavailable" });
      }
    }
    return this.view(ceiling, saved.request.id, Permission.ListingPublish);
  }

  async receipt(ceiling: TenantContext, raw: ListingSyncIntentLookup): Promise<ListingSyncIntentReceipt> {
    const input = ListingSyncIntentLookupSchema.parse(raw);
    return withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, Permission.ListingRead);
      authorize(context, Permission.StoreRead);
      const [intent] = await tx.select().from(marketplaceListingSyncIntents).where(and(
        eq(marketplaceListingSyncIntents.createdBy, context.userId), eq(marketplaceListingSyncIntents.requestKey, input.requestKey),
      )).limit(1);
      let request: MarketplaceListingSyncRequestView | null = null;
      if (intent) {
        const original = await this.request(tx, intent.requestId);
        await this.access(tx, context, original, Permission.ListingRead);
        this.assertIntentRequest(intent, original, context);
        this.assertIntentChecksum(intent.requestChecksum, input.requestChecksum);
        request = toRequestView(original, await this.latestEvent(tx, original.id));
      }
      return ListingSyncIntentReceiptSchema.parse({ protocol: LISTING_SYNC_INTENT_PROTOCOL, ...input,
        found: request !== null, request, observedAt: (await databaseNow(tx)).toISOString() });
    });
  }

  async workspace(ceiling: TenantContext, listingId: string): Promise<ListingSyncIntentWorkspace> {
    return withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, Permission.ListingRead);
      authorize(context, Permission.StoreRead);
      const listing = await assertCatalogListingAccess(tx, context, listingId, [Permission.ListingRead], "share");
      const [version] = listing.primaryVersionId ? await tx.select().from(listingVersions).where(and(
        eq(listingVersions.id, listing.primaryVersionId), eq(listingVersions.listingId, listing.id),
      )).limit(1) : [];
      const sourceEvent = tx.select({ status: marketplacePublicationEvents.status, externalListingId: marketplacePublicationEvents.externalListingId })
        .from(marketplacePublicationEvents).where(eq(marketplacePublicationEvents.requestId, marketplacePublicationRequests.id))
        .orderBy(desc(marketplacePublicationEvents.sequence)).limit(1).as("intent_source_event");
      const sources = context.permissions.includes(Permission.StoreRead) ? await tx.select({
        accountId: marketplaceAccounts.id, accountName: marketplaceAccounts.displayName,
        sourcePublicationRequestId: marketplacePublicationRequests.id, listingVersionId: marketplacePublicationRequests.listingVersionId,
        platform: marketplacePublicationRequests.platform, marketplaceId: marketplacePublicationRequests.marketplaceId,
        externalListingId: sql<string>`coalesce(${sourceEvent.externalListingId}, ${marketplacePublicationRequests.sourceExternalListingId})`,
      }).from(marketplacePublicationRequests).innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplacePublicationRequests.accountId))
        .innerJoin(listingVersions, and(eq(listingVersions.id, marketplacePublicationRequests.listingVersionId), eq(listingVersions.listingId, listing.id)))
        .innerJoinLateral(sourceEvent, sql`true`).where(and(eq(marketplacePublicationRequests.listingId, listing.id),
          eq(marketplacePublicationRequests.platform, listing.platform), eq(marketplaceAccounts.platform, listing.platform),
          isNull(marketplaceAccounts.deletedAt), catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
          inArray(marketplacePublicationRequests.action, ["amazon_submit", "amazon_feed_submit", "etsy_activate"]),
          eq(sourceEvent.status, "published"), sql`coalesce(${sourceEvent.externalListingId}, ${marketplacePublicationRequests.sourceExternalListingId}) is not null`))
        .orderBy(desc(marketplacePublicationRequests.createdAt), desc(marketplacePublicationRequests.id)).limit(100) : [];
      const recent = context.permissions.includes(Permission.StoreRead) ? await this.listInTransaction(tx, context, { listingId: listing.id, limit: 20 }) : [];
      let publish = false;
      try { authorize(context, Permission.ListingPublish, { ownerId: listing.createdBy }); publish = true; } catch { /* Read-only workspace. */ }
      return ListingSyncIntentWorkspaceSchema.parse({ protocol: LISTING_SYNC_INTENT_PROTOCOL,
        context: { actorId: context.userId, tenantId: context.tenantId,
          authority: createHash("sha256").update(erpSessionAuthority(erpPermissionContext(context))).digest("hex") },
        listing: { id: listing.id, currentVersionId: listing.primaryVersionId, status: listing.status },
        access: { canRead: true, canSubmit: publish && listing.status === "approved" && version?.status === "approved" && version.validation.blockers.length === 0 && sources.length > 0 },
        sources, recent, observedAt: (await databaseNow(tx)).toISOString() });
    });
  }

  get(context: TenantContext, requestId: string): Promise<MarketplaceListingSyncRequestView> { return this.view(context, requestId, Permission.ListingRead); }

  async list(ceiling: TenantContext, raw: ListMarketplaceListingSyncsInput): Promise<MarketplaceListingSyncRequestView[]> {
    const input = ListMarketplaceListingSyncsInputSchema.parse(raw);
    return withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, Permission.ListingRead);
      authorize(context, Permission.StoreRead);
      if (input.listingId) await assertCatalogListingAccess(tx, context, input.listingId, [Permission.ListingRead], "share");
      if (input.accountId) await this.account(tx, context, input.accountId);
      return this.listInTransaction(tx, context, input);
    });
  }

  async events(ceiling: TenantContext, requestId: string): Promise<MarketplaceListingSyncEventView[]> {
    return withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, Permission.ListingRead), request = await this.request(tx, requestId);
      await this.access(tx, context, request, Permission.ListingRead);
      return (await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId))
        .orderBy(marketplaceListingSyncEvents.sequence)).map(toEventView);
    });
  }

  private async current(tx: TenantTransaction, ceiling: TenantContext, permission: PermissionValue) {
    const context = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
    authorize(context, permission);
    return currentCatalogContext(tx, context);
  }
  private async account(tx: TenantTransaction, context: TenantContext, id: string) {
    const [account] = await tx.select().from(marketplaceAccounts).where(and(eq(marketplaceAccounts.id, id), isNull(marketplaceAccounts.deletedAt))).limit(1).for("share");
    if (!account) throw new NotFoundException("Marketplace account not found");
    await currentMarketplaceAuthority(tx, context, Permission.StoreRead, account);
    return account;
  }
  private async access(tx: TenantTransaction, context: TenantContext, target: { accountId: string; listingId: string }, permission: PermissionValue) {
    const account = await this.account(tx, context, target.accountId);
    const listing = await assertCatalogListingAccess(tx, context, target.listingId, [permission], "share");
    return { account, listing };
  }
  private async request(tx: TenantTransaction, id: string) {
    const [request] = await tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, id)).limit(1);
    if (!request) throw new NotFoundException("Marketplace Listing sync request not found");
    return request;
  }
  private async legacyRequest(tx: TenantTransaction, context: TenantContext, input: CreateMarketplaceListingSyncInput, requestKey: string): Promise<RequestRow | null> {
    let before: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const rows = await tx.select().from(marketplaceListingSyncRequests).where(and(
        eq(marketplaceListingSyncRequests.createdBy, context.userId), eq(marketplaceListingSyncRequests.accountId, input.accountId),
        eq(marketplaceListingSyncRequests.listingId, input.listingId), eq(marketplaceListingSyncRequests.listingVersionId, input.listingVersionId),
        eq(marketplaceListingSyncRequests.sourcePublicationRequestId, input.sourcePublicationRequestId), eq(marketplaceListingSyncRequests.action, input.action),
        before ? lt(marketplaceListingSyncRequests.id, before) : undefined,
      )).orderBy(desc(marketplaceListingSyncRequests.id)).limit(100);
      for (const request of rows) {
        // The v1 request key was case-sensitive and the desired checksum was
        // captured by that request. Do not substitute today's mutable basis.
        if (request.idempotencyKey === checksum({ version: 1, tenantId: context.tenantId, requestKey,
          action: input.action, desiredChecksum: request.desiredChecksum })) return request;
      }
      if (rows.length < 100) return null;
      before = rows[rows.length - 1]!.id;
    }
    throw new ConflictException({ code: "listing_sync_intent_conflict", message: "历史请求数量超出自动核对范围 请先核对原任务" });
  }
  private async recoverLegacy(tx: TenantTransaction, context: TenantContext, request: RequestRow, input: CreateMarketplaceListingSyncInput,
    requestKey: string, requestChecksum: string): Promise<{ request: RequestRow; replayed: true }> {
    const targetChecksum = createHash("sha256").update(listingSyncIntentRequestText({ accountId: request.accountId,
      listingId: request.listingId, listingVersionId: request.listingVersionId, sourcePublicationRequestId: request.sourcePublicationRequestId,
      action: CreateMarketplaceListingSyncInputSchema.shape.action.parse(request.action) })).digest("hex");
    if (request.createdBy !== context.userId || targetChecksum !== requestChecksum) {
      throw new ConflictException({ code: "listing_sync_intent_conflict", message: "原请求标识已用于另一组同步目标 请读取原回执" });
    }
    await tx.insert(marketplaceListingSyncIntents).values({ id: createEntityId(), tenantId: context.tenantId,
      requestKey, createdBy: context.userId, requestId: request.id, requestChecksum });
    await this.audit.recordInTransaction(tx, context, { action: "marketplace_listing_sync.intent.create", resourceType: "marketplace_listing_sync_request",
      resourceId: request.id, result: "success", metadata: { accountId: request.accountId, action: input.action,
        listingVersionId: request.listingVersionId, sourcePublicationRequestId: request.sourcePublicationRequestId,
        requestKey, requestChecksum, recovered_legacy: true, dispatch: "not_requeued" } });
    return { request, replayed: true };
  }
  private assertIntentChecksum(original: string, requested: string) {
    if (original !== requested) throw new ConflictException({ code: "listing_sync_intent_conflict", message: "原请求标识已用于另一组同步目标 请读取原回执" });
  }
  private assertIntentRequest(intent: typeof marketplaceListingSyncIntents.$inferSelect, request: RequestRow, context: TenantContext) {
    if (intent.createdBy !== context.userId || request.createdBy !== context.userId) throw new NotFoundException("Marketplace Listing sync request not found");
    const expected = createHash("sha256").update(listingSyncIntentRequestText({ accountId: request.accountId,
      listingId: request.listingId, listingVersionId: request.listingVersionId,
      sourcePublicationRequestId: request.sourcePublicationRequestId, action: CreateMarketplaceListingSyncInputSchema.shape.action.parse(request.action) })).digest("hex");
    this.assertIntentChecksum(intent.requestChecksum, expected);
  }
  private async view(ceiling: TenantContext, id: string, permission: PermissionValue) {
    return withCatalogTenant(this.database.db, ceiling, async tx => {
      const context = await this.current(tx, ceiling, permission), request = await this.request(tx, id);
      await this.access(tx, context, request, permission);
      return toRequestView(request, await this.latestEvent(tx, id));
    });
  }
  private async listInTransaction(tx: TenantTransaction, context: TenantContext, input: ListMarketplaceListingSyncsInput) {
    const rows = await tx.select({ request: marketplaceListingSyncRequests }).from(marketplaceListingSyncRequests)
      .innerJoin(listings, eq(listings.id, marketplaceListingSyncRequests.listingId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, marketplaceListingSyncRequests.accountId)).where(and(
        input.accountId ? eq(marketplaceListingSyncRequests.accountId, input.accountId) : undefined,
        input.listingId ? eq(marketplaceListingSyncRequests.listingId, input.listingId) : undefined,
        isNull(marketplaceAccounts.deletedAt), catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
        catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
      )).orderBy(desc(marketplaceListingSyncRequests.createdAt), desc(marketplaceListingSyncRequests.id)).limit(input.limit);
    const requests = rows.map(row => row.request);
    if (!requests.length) return [];
    const events = await tx.select().from(marketplaceListingSyncEvents).where(inArray(marketplaceListingSyncEvents.requestId, requests.map(request => request.id)))
      .orderBy(desc(marketplaceListingSyncEvents.sequence));
    const latest = new Map<string, EventRow>();
    for (const event of events) if (!latest.has(event.requestId)) latest.set(event.requestId, event);
    return requests.map(request => {
      const event = latest.get(request.id);
      if (!event) throw new ConflictException("Marketplace Listing sync request has no event history");
      return toRequestView(request, toEventView(event));
    });
  }

  private async prepare(tx: TenantTransaction, input: CreateMarketplaceListingSyncInput,
    { account, listing }: { account: AccountRow; listing: typeof listings.$inferSelect }): Promise<PreparedSync> {
    const [[version], [source], [sourceEvent], [capability]] = await Promise.all([
      tx.select().from(listingVersions).where(eq(listingVersions.id, input.listingVersionId)).limit(1),
      tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.id, input.sourcePublicationRequestId)).limit(1),
      tx.select().from(marketplacePublicationEvents).where(eq(marketplacePublicationEvents.requestId, input.sourcePublicationRequestId)).orderBy(desc(marketplacePublicationEvents.sequence)).limit(1),
      tx.select().from(marketplaceCapabilitySnapshots).where(eq(marketplaceCapabilitySnapshots.accountId, input.accountId)).orderBy(desc(marketplaceCapabilitySnapshots.version)).limit(1),
    ]);
    if (!version || version.listingId !== listing.id) throw new NotFoundException("Listing version not found");
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
    if (isListingMutation(input.action)) await this.channelInventory.assertMarketplaceAllocations(tx, {
      accountId: account.id, platform: payload.platform, marketplaceId: payload.marketplaceId, listingId: listing.id,
      desired: desiredInventoryTargets(version.content, payload),
    });
    const desired = onlineListingStateForAction(input.action, desiredOnlineListingState(payload));
    return { desiredChecksum: checksum(desired), desiredState: { ...desired, payload }, externalListingId, payload };
  }
  private async latestEvent(tx: TenantTransaction, requestId: string) {
    const [event] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
    if (!event) throw new ConflictException("Marketplace Listing sync request has no event history");
    return toEventView(event);
  }
  private async appendFailure(context: TenantContext, requestId: string, code: string, message: string) {
    await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${requestId}, 0))`);
      const request = await this.request(tx, requestId);
      if (request.createdBy !== context.userId) return;
      const [latest] = await tx.select().from(marketplaceListingSyncEvents).where(eq(marketplaceListingSyncEvents.requestId, requestId)).orderBy(desc(marketplaceListingSyncEvents.sequence)).limit(1);
      if (!latest || latest.status !== "queued") return;
      await tx.insert(marketplaceListingSyncEvents).values({ id: createEntityId(), tenantId: context.tenantId, requestId, sequence: latest.sequence + 1, status: "failed", code, message, actorUserId: context.userId });
      await this.audit.recordInTransaction(tx, context, { action: "marketplace_listing_sync.enqueue", resourceType: "marketplace_listing_sync_request", resourceId: requestId,
        result: "failure", metadata: { code, dispatch: "unconfirmed" } });
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
