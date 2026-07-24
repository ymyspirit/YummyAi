import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import {
  MarketplacePublicationBatchViewSchema,
  MarketplacePublicationEventViewSchema,
  MarketplacePublicationRequestViewSchema,
  createEntityId,
  type CancelMarketplacePublicationInput,
  type CreateMarketplacePublicationBatchInput,
  type CreateMarketplacePublicationInput,
  type ListMarketplacePublicationBatchesInput,
  type MarketplacePublicationBatchStatus,
  type MarketplacePublicationBatchView,
  type MarketplacePublicationEventView,
  type MarketplacePublicationRequestView,
  type TenantContext,
} from "@yummyai/contracts";
import {
  listingVersions,
  marketplacePublicationBatches,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { MarketplacePublicationPayloadSchema } from "@yummyai/marketplace-connectors";
import { desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import {
  DATABASE_CONNECTION,
  MARKETPLACE_PUBLICATION_BATCH_ENQUEUER,
  MARKETPLACE_PUBLICATION_ENQUEUER,
} from "../platform.tokens.js";
import {
  MarketplacePublicationService,
  type MarketplacePublicationEnqueuer,
  type PreparedPublication,
} from "./marketplace-publication.service.js";

export interface MarketplacePublicationBatchEnqueuer {
  enqueue(input: { delayMs: number; publicationBatchId: string; requestedBy: string; tenantId: string }): Promise<void>;
  cancel(publicationBatchId: string): Promise<void>;
}

@Injectable()
export class MarketplacePublicationBatchService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(MarketplacePublicationService) private readonly publications: MarketplacePublicationService,
    @Inject(MARKETPLACE_PUBLICATION_ENQUEUER) private readonly publicationEnqueuer: MarketplacePublicationEnqueuer,
    @Inject(MARKETPLACE_PUBLICATION_BATCH_ENQUEUER) private readonly batchEnqueuer: MarketplacePublicationBatchEnqueuer,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, input: CreateMarketplacePublicationBatchInput): Promise<MarketplacePublicationBatchView> {
    const scheduledFor = normalizeSchedule(input.scheduledFor);
    const prepared = await Promise.all(input.items.map(async (item) => ({
      input: { accountId: input.accountId, marketplaceId: input.marketplaceId, ...item } satisfies CreateMarketplacePublicationInput,
      prepared: await this.publications.prepareForBatch(context, {
        accountId: input.accountId,
        marketplaceId: input.marketplaceId,
        ...item,
      }),
    })));
    const platform = prepared[0]!.prepared.payload.platform;
    const capabilitySnapshotId = commonCapability(prepared.map((item) => item.prepared));
    if (prepared.some((item) => item.prepared.payload.platform !== platform)) {
      throw new UnprocessableEntityException("Publication batch items must target one marketplace platform");
    }
    const idempotencyKey = checksum({
      version: 1,
      tenantId: context.tenantId,
      accountId: input.accountId,
      marketplaceId: input.marketplaceId,
      action: "initial",
      items: input.items.map(itemIdentity).toSorted(),
    });
    const batchId = createEntityId();
    const batch = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
      const [existing] = await tx.select().from(marketplacePublicationBatches)
        .where(eq(marketplacePublicationBatches.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(marketplacePublicationBatches).values({
        id: batchId,
        tenantId: context.tenantId,
        accountId: input.accountId,
        capabilitySnapshotId,
        platform,
        marketplaceId: input.marketplaceId,
        action: "initial",
        idempotencyKey,
        itemCount: prepared.length,
        scheduledFor,
        createdBy: context.userId,
      }).returning();
      const requests = await tx.insert(marketplacePublicationRequests).values(prepared.map(({ input: item, prepared: itemPrepared }, index) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: input.accountId,
        capabilitySnapshotId,
        listingId: item.listingId,
        listingVersionId: item.listingVersionId,
        platform,
        marketplaceId: input.marketplaceId,
        action: platform === "amazon" ? "amazon_validation_preview" : "etsy_create_draft",
        batchId: created!.id,
        idempotencyKey: checksum({ version: 1, tenantId: context.tenantId, batchId: created!.id, item: index, action: "initial" }),
        payload: itemPrepared.payload,
        payloadChecksum: checksum(itemPrepared.payload),
        assetManifest: itemPrepared.assets,
        scheduledFor,
        createdBy: context.userId,
      }))).returning();
      await tx.insert(marketplacePublicationEvents).values(requests.map((request) => ({
        id: createEntityId(), tenantId: context.tenantId, requestId: request.id, sequence: 1,
        status: scheduledFor ? "scheduled" : "queued", actorUserId: context.userId,
      })));
      return created!;
    });

    await this.enqueueBatchChildren(context, batch.id);
    await this.audit.record(context, {
      action: "marketplace_publication_batch.enqueue",
      resourceType: "marketplace_publication_batch",
      resourceId: batch.id,
      result: "success",
      metadata: { accountId: batch.accountId, action: batch.action, itemCount: batch.itemCount, marketplaceId: batch.marketplaceId },
    });
    return this.get(context, batch.id);
  }

  async continue(context: TenantContext, parentBatchId: string): Promise<MarketplacePublicationBatchView> {
    const parentWorkspace = await this.workspace(context, parentBatchId);
    if (parentWorkspace.batch.action !== "initial") throw new ConflictException("Only an initial publication batch can continue");
    assertBatchReadyToContinue(parentWorkspace);
    const prepared = await Promise.all(parentWorkspace.requests.map(async (parent) => {
      const payload = MarketplacePublicationPayloadSchema.parse(parent.payload);
      let variantSkuId: string | undefined;
      if (payload.platform === "amazon") {
        const [version] = await withTenant(this.database.db, context, (tx) => tx.select({ content: listingVersions.content })
          .from(listingVersions).where(eq(listingVersions.id, parent.listingVersionId)).limit(1));
        variantSkuId = version?.content.variants.find((variant) => variant.skuCode === payload.sku)?.skuId;
        if (!variantSkuId) throw new ConflictException("Pinned Amazon batch SKU is no longer present in the approved version");
      }
      const current = await this.publications.prepareForBatch(context, {
        accountId: parent.accountId,
        listingId: parent.listingId,
        listingVersionId: parent.listingVersionId,
        marketplaceId: parent.marketplaceId,
        ...(variantSkuId ? { variantSkuId } : {}),
      });
      if (checksum(current.payload) !== parent.payloadChecksum || checksum(current.assets) !== checksum(parent.assetManifest)) {
        throw new ConflictException("Pinned batch publication content or assets no longer match the current approved version");
      }
      if (parent.platform === "etsy" && !parent.assetManifest.some((pin) => pin.publicationRole !== "supplemental")) {
        throw new UnprocessableEntityException("Etsy activation requires at least one approved listing image");
      }
      return { current, parent, parentEvent: parentWorkspace.latest.get(parent.id)! };
    }));
    const capabilitySnapshotId = commonCapability(prepared.map((item) => item.current));
    const idempotencyKey = checksum({ version: 1, tenantId: context.tenantId, parentBatchId, action: "continue" });
    const batchId = createEntityId();
    const batch = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${parentBatchId}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyKey}, 0))`);
      const [existing] = await tx.select().from(marketplacePublicationBatches)
        .where(eq(marketplacePublicationBatches.idempotencyKey, idempotencyKey)).limit(1);
      if (existing) return existing;
      const [created] = await tx.insert(marketplacePublicationBatches).values({
        id: batchId,
        tenantId: context.tenantId,
        accountId: parentWorkspace.batch.accountId,
        capabilitySnapshotId,
        platform: parentWorkspace.batch.platform,
        marketplaceId: parentWorkspace.batch.marketplaceId,
        action: "continue",
        parentBatchId,
        idempotencyKey,
        itemCount: prepared.length,
        createdBy: context.userId,
      }).returning();
      const requests = await tx.insert(marketplacePublicationRequests).values(prepared.map(({ parent, parentEvent }, index) => ({
        id: createEntityId(),
        tenantId: context.tenantId,
        accountId: parent.accountId,
        capabilitySnapshotId,
        listingId: parent.listingId,
        listingVersionId: parent.listingVersionId,
        platform: parent.platform,
        marketplaceId: parent.marketplaceId,
        action: parent.platform === "amazon" ? "amazon_feed_submit" : "etsy_activate",
        batchId: created!.id,
        parentRequestId: parent.id,
        sourceExternalListingId: parent.platform === "etsy" ? parentEvent.externalListingId : null,
        idempotencyKey: checksum({ version: 1, tenantId: context.tenantId, batchId: created!.id, item: index, action: "continue" }),
        payload: parent.payload,
        payloadChecksum: parent.payloadChecksum,
        assetManifest: parent.assetManifest,
        createdBy: context.userId,
      }))).returning();
      await tx.insert(marketplacePublicationEvents).values(requests.map((request) => ({
        id: createEntityId(), tenantId: context.tenantId, requestId: request.id, sequence: 1,
        status: "queued", actorUserId: context.userId,
      })));
      return created!;
    });

    await this.enqueueBatchChildren(context, batch.id);
    await this.audit.record(context, {
      action: "marketplace_publication_batch.continue",
      resourceType: "marketplace_publication_batch",
      resourceId: batch.id,
      result: "success",
      metadata: { itemCount: batch.itemCount, parentBatchId },
    });
    return this.get(context, batch.id);
  }

  async cancel(context: TenantContext, batchId: string, input: CancelMarketplacePublicationInput): Promise<MarketplacePublicationBatchView> {
    const requestIds = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${batchId}, 0))`);
      const [batch] = await tx.select().from(marketplacePublicationBatches).where(eq(marketplacePublicationBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Marketplace publication batch not found");
      const requests = await tx.select().from(marketplacePublicationRequests).where(eq(marketplacePublicationRequests.batchId, batchId));
      const events = await tx.select().from(marketplacePublicationEvents)
        .where(inArray(marketplacePublicationEvents.requestId, requests.map((request) => request.id)))
        .orderBy(desc(marketplacePublicationEvents.sequence));
      const latest = latestEvents(events);
      if (requests.some((request) => !waitingStatuses.has(latest.get(request.id)?.status ?? ""))) {
        throw new ConflictException("A publication batch can be cancelled only while every item is waiting");
      }
      await tx.insert(marketplacePublicationEvents).values(requests.map((request) => ({
        id: createEntityId(), tenantId: context.tenantId, requestId: request.id,
        sequence: latest.get(request.id)!.sequence + 1, status: "cancelled",
        code: "PUBLICATION_BATCH_CANCELLED_BY_USER", message: input.reason, retryable: false,
        actorUserId: context.userId,
      })));
      return requests.map((request) => request.id);
    });
    await Promise.allSettled([
      this.batchEnqueuer.cancel(batchId),
      ...requestIds.map((requestId) => this.publicationEnqueuer.cancel(requestId)),
    ]);
    await this.audit.record(context, {
      action: "marketplace_publication_batch.cancel",
      resourceType: "marketplace_publication_batch",
      resourceId: batchId,
      result: "success",
      metadata: { itemCount: requestIds.length },
    });
    return this.get(context, batchId);
  }

  async get(context: TenantContext, batchId: string): Promise<MarketplacePublicationBatchView> {
    return toBatchView(await this.workspace(context, batchId));
  }

  async list(context: TenantContext, input: ListMarketplacePublicationBatchesInput): Promise<MarketplacePublicationBatchView[]> {
    const batches = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplacePublicationBatches)
      .where(input.accountId ? eq(marketplacePublicationBatches.accountId, input.accountId) : undefined)
      .orderBy(desc(marketplacePublicationBatches.createdAt)).limit(input.limit));
    return Promise.all(batches.map((batch) => this.get(context, batch.id)));
  }

  private async enqueueBatchChildren(context: TenantContext, batchId: string): Promise<void> {
    const workspace = await this.workspace(context, batchId);
    const delayMs = Math.max(0, (workspace.batch.scheduledFor?.getTime() ?? Date.now()) - Date.now());
    if (workspace.batch.action === "continue" && workspace.batch.platform === "amazon") {
      try {
        await this.batchEnqueuer.enqueue({ delayMs, publicationBatchId: batchId, requestedBy: context.userId, tenantId: context.tenantId });
        return;
      } catch {
        await this.appendQueueFailures(context, workspace.requests, workspace.latest, "PUBLICATION_BATCH_QUEUE_UNAVAILABLE");
        throw new ServiceUnavailableException("Marketplace publication batch queue is unavailable");
      }
    }
    const pending = workspace.requests.filter((request) => waitingStatuses.has(workspace.latest.get(request.id)?.status ?? ""));
    const results = await Promise.allSettled(pending.map((request) => this.publicationEnqueuer.enqueue({
      delayMs,
      publicationRequestId: request.id,
      requestedBy: context.userId,
      tenantId: context.tenantId,
    })));
    const failed = pending.filter((_request, index) => results[index]?.status === "rejected");
    if (failed.length) {
      await this.appendQueueFailures(context, failed, workspace.latest, "PUBLICATION_QUEUE_UNAVAILABLE");
      throw new ServiceUnavailableException("Marketplace publication queue is unavailable for one or more batch items");
    }
  }

  private async appendQueueFailures(
    context: TenantContext,
    requests: RequestRow[],
    latest: Map<string, EventRow>,
    code: string,
  ): Promise<void> {
    await withTenant(this.database.db, context, (tx) => tx.insert(marketplacePublicationEvents).values(requests.map((request) => ({
      id: createEntityId(), tenantId: context.tenantId, requestId: request.id,
      sequence: (latest.get(request.id)?.sequence ?? 0) + 1,
      status: "retry_pending", code, message: "Publication batch queue admission failed", retryable: true,
      actorUserId: context.userId,
    }))));
  }

  private async workspace(context: TenantContext, batchId: string): Promise<BatchWorkspace> {
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(marketplacePublicationBatches).where(eq(marketplacePublicationBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Marketplace publication batch not found");
      const requests = await tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.batchId, batchId)).orderBy(marketplacePublicationRequests.createdAt);
      const events = requests.length
        ? await tx.select().from(marketplacePublicationEvents)
            .where(inArray(marketplacePublicationEvents.requestId, requests.map((request) => request.id)))
            .orderBy(desc(marketplacePublicationEvents.sequence))
        : [];
      const latest = latestEvents(events);
      if (requests.length !== batch.itemCount || requests.some((request) => !latest.has(request.id))) {
        throw new ConflictException("Marketplace publication batch is missing immutable item history");
      }
      return { batch, requests, latest };
    });
  }
}

type BatchRow = typeof marketplacePublicationBatches.$inferSelect;
type RequestRow = typeof marketplacePublicationRequests.$inferSelect;
type EventRow = typeof marketplacePublicationEvents.$inferSelect;
interface BatchWorkspace { batch: BatchRow; requests: RequestRow[]; latest: Map<string, EventRow> }

const waitingStatuses = new Set(["scheduled", "queued", "retry_pending"]);
const processingStatuses = new Set(["processing", "submission_accepted", "configuration_applied", "media_uploaded", "activation_accepted", "sync_pending"]);
const failedStatuses = new Set(["validation_failed", "publication_failed", "failed", "deactivated"]);

function toBatchView(workspace: BatchWorkspace): MarketplacePublicationBatchView {
  const items = workspace.requests.map((request) => toRequestView(request, workspace.latest.get(request.id)!));
  const statuses = items.map((item) => item.current.status);
  const successStatus = workspace.batch.action === "initial"
    ? workspace.batch.platform === "amazon" ? "validation_passed" : "draft_created"
    : "published";
  const counts = {
    total: items.length,
    waiting: statuses.filter((status) => waitingStatuses.has(status)).length,
    succeeded: statuses.filter((status) => status === successStatus).length,
    failed: statuses.filter((status) => failedStatuses.has(status)).length,
    reconciliationRequired: statuses.filter((status) => status === "reconciliation_required").length,
    cancelled: statuses.filter((status) => status === "cancelled").length,
  };
  const status = batchStatus(workspace.batch, statuses, counts);
  return MarketplacePublicationBatchViewSchema.parse({
    id: workspace.batch.id,
    accountId: workspace.batch.accountId,
    capabilitySnapshotId: workspace.batch.capabilitySnapshotId,
    platform: workspace.batch.platform,
    marketplaceId: workspace.batch.marketplaceId,
    action: workspace.batch.action,
    parentBatchId: workspace.batch.parentBatchId,
    idempotencyKey: workspace.batch.idempotencyKey,
    itemCount: workspace.batch.itemCount,
    scheduledFor: workspace.batch.scheduledFor?.toISOString() ?? null,
    createdBy: workspace.batch.createdBy,
    createdAt: workspace.batch.createdAt.toISOString(),
    status,
    counts,
    items,
  });
}

function batchStatus(
  batch: BatchRow,
  statuses: MarketplacePublicationRequestView["current"]["status"][],
  counts: MarketplacePublicationBatchView["counts"],
): MarketplacePublicationBatchStatus {
  if (counts.cancelled === counts.total) return "cancelled";
  if (counts.reconciliationRequired > 0) return "reconciliation_required";
  if (counts.succeeded === counts.total) return batch.action === "initial" ? "ready_to_continue" : "completed";
  if (counts.failed === counts.total) return "failed";
  if (counts.failed > 0 || counts.cancelled > 0) return "partial";
  if (statuses.every((status) => status === "scheduled")) return "scheduled";
  if (statuses.every((status) => waitingStatuses.has(status))) return "queued";
  if (statuses.some((status) => processingStatuses.has(status)) || counts.succeeded > 0) return "processing";
  return "queued";
}

function assertBatchReadyToContinue(workspace: BatchWorkspace): void {
  const expected = workspace.batch.platform === "amazon" ? "validation_passed" : "draft_created";
  const invalid = workspace.requests.find((request) => workspace.latest.get(request.id)?.status !== expected);
  if (invalid) throw new ConflictException(`Every batch item must be ${expected} before continuation`);
}

function latestEvents(events: EventRow[]): Map<string, EventRow> {
  const latest = new Map<string, EventRow>();
  for (const event of events) if (!latest.has(event.requestId)) latest.set(event.requestId, event);
  return latest;
}

function toRequestView(request: RequestRow, current: EventRow): MarketplacePublicationRequestView {
  const payload = MarketplacePublicationPayloadSchema.safeParse(request.payload);
  return MarketplacePublicationRequestViewSchema.parse({
    id: request.id,
    accountId: request.accountId,
    capabilitySnapshotId: request.capabilitySnapshotId,
    listingId: request.listingId,
    listingVersionId: request.listingVersionId,
    platform: request.platform,
    marketplaceId: request.marketplaceId,
    action: request.action,
    batchId: request.batchId,
    parentRequestId: request.parentRequestId,
    sourceExternalListingId: request.sourceExternalListingId,
    idempotencyKey: request.idempotencyKey,
    payloadChecksum: request.payloadChecksum,
    targetLabel: payload.success
      ? payload.data.platform === "amazon" ? payload.data.sku : payload.data.title
      : null,
    assetCount: request.assetManifest.length,
    scheduledFor: request.scheduledFor?.toISOString() ?? null,
    createdBy: request.createdBy,
    createdAt: request.createdAt.toISOString(),
    current: toEventView(current),
  });
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

function commonCapability(items: PreparedPublication[]): string {
  const capabilitySnapshotId = items[0]?.capabilitySnapshotId;
  if (!capabilitySnapshotId || items.some((item) => item.capabilitySnapshotId !== capabilitySnapshotId)) {
    throw new ConflictException("Publication batch preflight did not pin one capability snapshot");
  }
  return capabilitySnapshotId;
}

function normalizeSchedule(value: string | undefined): Date | null {
  if (!value) return null;
  const scheduledFor = new Date(value);
  const now = Date.now();
  if (scheduledFor.getTime() <= now) throw new UnprocessableEntityException("Scheduled publication time must be in the future");
  if (scheduledFor.getTime() > now + 90 * 24 * 60 * 60 * 1_000) throw new UnprocessableEntityException("Scheduled publication time cannot exceed 90 days");
  return scheduledFor;
}

function itemIdentity(item: CreateMarketplacePublicationBatchInput["items"][number]): string {
  return `${item.listingId}:${item.listingVersionId}:${item.variantSkuId ?? ""}`;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
