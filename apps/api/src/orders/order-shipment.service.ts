import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import {
  AppendShipmentVersionInputSchema, CreateShipmentInputSchema, RecordShipmentWritebackEventInputSchema,
  RecordTrackingEventInputSchema, RequestShipmentWritebackInputSchema, ReviewShipmentVersionInputSchema,
  createEntityId, type AppendShipmentVersionInput, type CreateShipmentInput, type RecordShipmentWritebackEventInput,
  type RecordTrackingEventInput, type RequestShipmentWritebackInput, type ReviewShipmentVersionInput,
  type ShipmentPackageInput, type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles, orderLines, orders, shipmentPackageLines, shipmentPackages, shipmentTrackingEvents,
  shipmentVersionReviews, shipmentVersions, shipmentWritebackEvents, shipmentWritebackRequests, shipments,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT, SHIPMENT_WRITEBACK_ENQUEUER } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";

@Injectable()
export class OrderShipmentService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SHIPMENT_WRITEBACK_ENQUEUER) private readonly enqueuer: ShipmentWritebackEnqueuer,
  ) {}

  async create(context: TenantContext, orderId: string, rawInput: CreateShipmentInput) {
    const input = CreateShipmentInputSchema.parse(rawInput);
    const shipmentId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment-create:${orderId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select({ id: shipments.id }).from(shipments).where(and(
        eq(shipments.orderId, orderId), eq(shipments.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new NotFoundException("Order not found");
      if (order.workflowState !== "awaiting_shipment" || order.sideState) throw new ConflictException("Order must be active and awaiting shipment");
      await assertVersionContent(tx, orderId, input.packages);
      const id = createEntityId(); const versionId = createEntityId();
      await tx.insert(shipments).values({ id, tenantId: context.tenantId, orderId, idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      await insertVersion(tx, context, id, versionId, 1, input, input.idempotencyKey);
      return id;
    });
    await this.audit.record(context, { action: "shipment.create", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { orderId } });
    return this.get(context, shipmentId);
  }

  async appendVersion(context: TenantContext, shipmentId: string, rawInput: AppendShipmentVersionInput) {
    const input = AppendShipmentVersionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      const [replayed] = await tx.select({ id: shipmentVersions.id }).from(shipmentVersions).where(and(
        eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      if (!['draft', 'approved'].includes(shipment.status)) throw new ConflictException("A dispatched shipment cannot be revised");
      if (shipment.currentVersionNumber !== input.expectedCurrentVersion) throw new ConflictException("Shipment version changed");
      await assertVersionContent(tx, shipment.orderId, input.packages);
      const nextVersion = shipment.currentVersionNumber + 1;
      await insertVersion(tx, context, shipmentId, createEntityId(), nextVersion, input, input.idempotencyKey);
      await tx.update(shipments).set({ currentVersionNumber: nextVersion, status: "draft", updatedAt: new Date() })
        .where(and(eq(shipments.id, shipmentId), eq(shipments.currentVersionNumber, input.expectedCurrentVersion)));
    });
    await this.audit.record(context, { action: "shipment.version.append", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: {} });
    return this.get(context, shipmentId);
  }

  async reviewVersion(context: TenantContext, shipmentId: string, versionId: string, rawInput: ReviewShipmentVersionInput) {
    const input = ReviewShipmentVersionInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      const [replayed] = await tx.select({ id: shipmentVersionReviews.id }).from(shipmentVersionReviews).where(and(
        eq(shipmentVersionReviews.shipmentId, shipmentId), eq(shipmentVersionReviews.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      if (shipment.currentVersionNumber !== input.expectedCurrentVersion) throw new ConflictException("Shipment version changed");
      if (!['draft', 'approved'].includes(shipment.status)) throw new ConflictException("A dispatched shipment cannot be reviewed");
      const [version] = await tx.select().from(shipmentVersions).where(and(
        eq(shipmentVersions.id, versionId), eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.currentVersionNumber),
      )).limit(1);
      if (!version) throw new NotFoundException("Current shipment version not found");
      const [existingReview] = await tx.select({ id: shipmentVersionReviews.id }).from(shipmentVersionReviews)
        .where(eq(shipmentVersionReviews.shipmentVersionId, versionId)).limit(1);
      if (existingReview) throw new ConflictException("Shipment version already has a final review");
      if (input.decision === "approved") await assertApprovedAllocation(tx, shipment, versionId);
      await tx.insert(shipmentVersionReviews).values({
        id: createEntityId(), tenantId: context.tenantId, shipmentId, shipmentVersionId: versionId,
        decision: input.decision, reasonCode: input.reasonCode, encryptedReason: this.vault.encrypt(input.reason),
        reasonChecksum: checksum(input.reason), idempotencyKey: input.idempotencyKey, reviewedBy: context.userId,
      });
      await tx.update(shipments).set({
        status: input.decision === "approved" ? "approved" : (shipment.approvedVersionNumber ? "approved" : "draft"),
        approvedVersionNumber: input.decision === "approved" ? version.versionNumber : shipment.approvedVersionNumber,
        updatedAt: new Date(),
      }).where(eq(shipments.id, shipmentId));
    });
    await this.audit.record(context, { action: "shipment.version.review", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { versionId, decision: input.decision, reasonCode: input.reasonCode } });
    return this.get(context, shipmentId);
  }

  async requestWriteback(context: TenantContext, shipmentId: string, rawInput: RequestShipmentWritebackInput) {
    const input = RequestShipmentWritebackInputSchema.parse(rawInput);
    const requestId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment-writeback-create:${shipmentId}`);
      const [replayed] = await tx.select({ id: shipmentWritebackRequests.id }).from(shipmentWritebackRequests).where(and(
        eq(shipmentWritebackRequests.shipmentId, shipmentId), eq(shipmentWritebackRequests.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      if (shipment.status !== "approved" || shipment.approvedVersionNumber !== shipment.currentVersionNumber) throw new ConflictException("Only the current approved shipment version can be written back");
      const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.id, input.shipmentVersionId), eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.currentVersionNumber))).limit(1);
      if (!version) throw new NotFoundException("Approved shipment version not found");
      const [approval] = await tx.select({ decision: shipmentVersionReviews.decision }).from(shipmentVersionReviews).where(eq(shipmentVersionReviews.shipmentVersionId, version.id)).limit(1);
      if (approval?.decision !== "approved") throw new ConflictException("Shipment version approval evidence is missing");
      const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId)).limit(1);
      if (!order || order.workflowState !== "awaiting_shipment" || order.sideState) throw new ConflictException("Order is not eligible for shipment writeback");
      const id = createEntityId();
      await tx.insert(shipmentWritebackRequests).values({
        id, tenantId: context.tenantId, shipmentId, shipmentVersionId: version.id, orderId: order.id,
        accountId: order.accountId, platform: order.platform, externalOrderId: order.externalOrderId,
        idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
      await tx.update(shipments).set({ status: "writeback_pending", updatedAt: new Date() }).where(eq(shipments.id, shipmentId));
      return id;
    });
    try {
      await this.enqueuer.enqueue({ writebackRequestId: requestId, requestedBy: context.userId, tenantId: context.tenantId });
    } catch {
      await this.recordWritebackEvent(context, requestId, {
        action: "rejected", expectedProjectionVersion: 1, providerCode: "QUEUE_UNAVAILABLE", externalReference: null,
        occurredAt: new Date().toISOString(),
      });
      throw new ServiceUnavailableException("Shipment writeback queue is unavailable");
    }
    await this.audit.record(context, { action: "shipment.writeback.request", resourceType: "shipment_writeback", resourceId: requestId, result: "success", metadata: { shipmentId } });
    return this.getWriteback(context, requestId);
  }

  async recordWritebackEvent(context: TenantContext, requestId: string, rawInput: RecordShipmentWritebackEventInput) {
    const input = RecordShipmentWritebackEventInputSchema.parse(rawInput);
    let orderId = ""; let shipmentId = ""; let replayed = false;
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment-writeback:${requestId}`);
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, requestId)).limit(1);
      if (!request) throw new NotFoundException("Shipment writeback request not found");
      orderId = request.orderId; shipmentId = request.shipmentId;
      const [latest] = await tx.select().from(shipmentWritebackEvents)
        .where(eq(shipmentWritebackEvents.requestId, requestId)).orderBy(desc(shipmentWritebackEvents.sequence)).limit(1);
      if (latest?.action === input.action && latest.providerCode === input.providerCode && latest.externalReference === input.externalReference) {
        replayed = true;
        return;
      }
      if (request.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Shipment writeback version changed");
      const toStatus = nextWritebackStatus(request.status, input.action);
      await tx.insert(shipmentWritebackEvents).values({
        id: createEntityId(), tenantId: context.tenantId, requestId, sequence: (latest?.sequence ?? 0) + 1,
        action: input.action, fromStatus: request.status, toStatus, providerCode: input.providerCode,
        externalReference: input.externalReference, actorUserId: context.userId, occurredAt: new Date(input.occurredAt),
      });
      await tx.update(shipmentWritebackRequests).set({ status: toStatus, projectionVersion: request.projectionVersion + 1, updatedAt: new Date() })
        .where(and(eq(shipmentWritebackRequests.id, requestId), eq(shipmentWritebackRequests.projectionVersion, input.expectedProjectionVersion)));
      const shipmentStatus = input.action === "accepted" || input.action === "reconcile_accepted" ? "shipped"
        : input.action === "rejected" || input.action === "reconcile_rejected" ? "approved"
          : input.action === "uncertain" ? "exception" : "writeback_pending";
      await tx.update(shipments).set({ status: shipmentStatus, updatedAt: new Date() }).where(eq(shipments.id, request.shipmentId));
    });
    if (input.action === "accepted" || input.action === "reconcile_accepted") await this.convergeOrderShipped(context, orderId, requestId);
    if (["rejected", "uncertain", "reconcile_rejected"].includes(input.action)) await this.orderService.openException(context, orderId, {
      category: "logistics", code: input.action === "uncertain" ? "SHIPMENT_WRITEBACK_UNCERTAIN" : "SHIPMENT_WRITEBACK_REJECTED",
      message: "Shipment writeback requires operational reconciliation.", idempotencyKey: `shipment-writeback-exception:${requestId}:${input.action}`,
    });
    await this.audit.record(context, { action: "shipment.writeback.event", resourceType: "shipment_writeback", resourceId: requestId, result: "success", metadata: { shipmentId, action: input.action, providerCode: input.providerCode, replayed } });
    return this.getWriteback(context, requestId);
  }

  async recordTrackingEvent(context: TenantContext, shipmentId: string, rawInput: RecordTrackingEventInput) {
    const input = RecordTrackingEventInputSchema.parse(rawInput);
    let orderId = ""; let shouldComplete = false; let needsException = false;
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `shipment-tracking:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      orderId = shipment.orderId;
      if (!shipment.approvedVersionNumber || !["shipped", "in_transit", "delivered", "exception"].includes(shipment.status)) throw new ConflictException("Tracking requires an acknowledged shipment");
      const [version] = await tx.select({ id: shipmentVersions.id, promisedDeliveryAt: shipmentVersions.promisedDeliveryAt }).from(shipmentVersions).where(and(
        eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.approvedVersionNumber),
      )).limit(1);
      const [pkg] = await tx.select({ id: shipmentPackages.id }).from(shipmentPackages).where(and(
        eq(shipmentPackages.id, input.packageId), eq(shipmentPackages.shipmentVersionId, version!.id),
      )).limit(1);
      if (!pkg) throw new NotFoundException("Package not found in the approved shipment version");
      const [replayed] = await tx.select({ id: shipmentTrackingEvents.id }).from(shipmentTrackingEvents).where(and(
        eq(shipmentTrackingEvents.provider, input.provider), eq(shipmentTrackingEvents.externalEventId, input.externalEventId),
      )).limit(1);
      if (!replayed) {
        await tx.insert(shipmentTrackingEvents).values({
          id: createEntityId(), tenantId: context.tenantId, shipmentId, packageId: input.packageId,
          status: input.status, provider: input.provider, externalEventId: input.externalEventId,
          detailCode: input.detailCode, estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
          occurredAt: new Date(input.occurredAt),
        });
      }
      const packages = await tx.select({ id: shipmentPackages.id }).from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version!.id));
      const events = await tx.select().from(shipmentTrackingEvents).where(inArray(shipmentTrackingEvents.packageId, packages.map((entry) => entry.id)))
        .orderBy(desc(shipmentTrackingEvents.occurredAt), desc(shipmentTrackingEvents.recordedAt));
      const latest = new Map<string, typeof shipmentTrackingEvents.$inferSelect>();
      for (const event of events) if (!latest.has(event.packageId)) latest.set(event.packageId, event);
      shouldComplete = packages.every((entry) => latest.get(entry.id)?.status === "delivered");
      needsException = ["delivery_exception", "returned"].includes(input.status)
        || Boolean(version!.promisedDeliveryAt && input.estimatedDeliveryAt && new Date(input.estimatedDeliveryAt) > version!.promisedDeliveryAt);
      const status = shouldComplete || (shipment.status === "delivered" && !needsException) ? "delivered" : needsException ? "exception" : "in_transit";
      await tx.update(shipments).set({ status, updatedAt: new Date() }).where(eq(shipments.id, shipmentId));
    });
    if (needsException) await this.orderService.openException(context, orderId, {
      category: "logistics", code: input.status === "delivery_exception" || input.status === "returned" ? "DELIVERY_EXCEPTION" : "DELIVERY_DELAYED",
      message: "Carrier tracking requires operational attention.", idempotencyKey: `tracking-exception:${input.provider}:${input.externalEventId}`,
    });
    if (shouldComplete) await this.convergeOrderCompleted(context, orderId, shipmentId);
    await this.audit.record(context, { action: "shipment.tracking.event", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { status: input.status, provider: input.provider } });
    return this.get(context, shipmentId);
  }

  async get(context: TenantContext, shipmentId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      const versions = await tx.select().from(shipmentVersions).where(eq(shipmentVersions.shipmentId, shipmentId)).orderBy(asc(shipmentVersions.versionNumber));
      const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentId, shipmentId)).orderBy(asc(shipmentPackages.createdAt));
      const packageLines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentId, shipmentId)).orderBy(asc(shipmentPackageLines.createdAt));
      const reviews = await tx.select({
        id: shipmentVersionReviews.id, shipmentVersionId: shipmentVersionReviews.shipmentVersionId,
        decision: shipmentVersionReviews.decision, reasonCode: shipmentVersionReviews.reasonCode,
        reasonChecksum: shipmentVersionReviews.reasonChecksum, reviewedBy: shipmentVersionReviews.reviewedBy,
        reviewedAt: shipmentVersionReviews.reviewedAt,
      }).from(shipmentVersionReviews).where(eq(shipmentVersionReviews.shipmentId, shipmentId)).orderBy(asc(shipmentVersionReviews.reviewedAt));
      const tracking = await tx.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, shipmentId)).orderBy(asc(shipmentTrackingEvents.occurredAt));
      const writebacks = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.shipmentId, shipmentId)).orderBy(asc(shipmentWritebackRequests.createdAt));
      return { shipment, versions, packages, packageLines, reviews, tracking, writebacks };
    });
  }

  async getWriteback(context: TenantContext, requestId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, requestId)).limit(1);
      if (!request) throw new NotFoundException("Shipment writeback request not found");
      const events = await tx.select().from(shipmentWritebackEvents).where(eq(shipmentWritebackEvents.requestId, requestId)).orderBy(asc(shipmentWritebackEvents.sequence));
      return { request, events };
    });
  }

  list(context: TenantContext, orderId?: string) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(shipments).where(orderId ? eq(shipments.orderId, orderId) : undefined).orderBy(desc(shipments.updatedAt)));
  }

  private async convergeOrderShipped(context: TenantContext, orderId: string, requestId: string) {
    const order = await this.orderService.get(context, orderId);
    if (order.workflowState !== "awaiting_shipment") return;
    try {
      await this.orderService.transition(context, orderId, { toState: "shipped", expectedSequence: order.latestEventSequence, idempotencyKey: `shipment-accepted:${requestId}`, reason: "Marketplace accepted shipment evidence" });
    } catch (error) {
      if (error instanceof ConflictException && error.message === "Acknowledged shipment versions must cover every order line quantity") return;
      throw error;
    }
  }

  private async convergeOrderCompleted(context: TenantContext, orderId: string, shipmentId: string) {
    const order = await this.orderService.get(context, orderId);
    if (order.workflowState !== "shipped") return;
    try {
      await this.orderService.transition(context, orderId, { toState: "completed", expectedSequence: order.latestEventSequence, idempotencyKey: `shipment-delivered:${shipmentId}`, reason: "All acknowledged packages were delivered" });
    } catch (error) {
      if (error instanceof ConflictException && error.message === "Every shipped quantity must be delivered before completion") return;
      throw error;
    }
  }
}

async function insertVersion(
  tx: TenantTransaction, context: TenantContext, shipmentId: string, versionId: string, versionNumber: number,
  input: CreateShipmentInput | AppendShipmentVersionInput, idempotencyKey: string,
) {
  await tx.insert(shipmentVersions).values({
    id: versionId, tenantId: context.tenantId, shipmentId, versionNumber, shipDate: new Date(input.shipDate),
    promisedDeliveryAt: input.promisedDeliveryAt ? new Date(input.promisedDeliveryAt) : null,
    estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
    shipFromCountryCode: input.shipFromCountryCode, idempotencyKey, createdBy: context.userId,
  });
  for (const entry of input.packages) {
    const packageId = createEntityId();
    await tx.insert(shipmentPackages).values({
      id: packageId, tenantId: context.tenantId, shipmentId, shipmentVersionId: versionId,
      packageReferenceId: entry.packageReferenceId, trackingNumber: entry.trackingNumber,
      carrierCode: entry.carrierCode, carrierName: entry.carrierName, carrierService: entry.carrierService,
      labelAssetId: entry.labelAssetId, externalLabelId: entry.externalLabelId,
      labelCostMinor: entry.labelCostMinor, labelCurrency: entry.labelCurrency, weightGrams: entry.weightGrams,
      lengthMm: entry.dimensionsMm?.length ?? null, widthMm: entry.dimensionsMm?.width ?? null, heightMm: entry.dimensionsMm?.height ?? null,
    });
    await tx.insert(shipmentPackageLines).values(entry.lines.map((line) => ({
      id: createEntityId(), tenantId: context.tenantId, shipmentId, shipmentVersionId: versionId,
      packageId, orderLineId: line.orderLineId, quantity: line.quantity,
    })));
  }
}

async function assertVersionContent(tx: TenantTransaction, orderId: string, packages: ShipmentPackageInput[]) {
  const lines = await tx.select({ id: orderLines.id, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, orderId));
  const allowed = new Map(lines.map((line) => [line.id, line.quantity]));
  const totals = new Map<string, number>();
  for (const entry of packages) for (const line of entry.lines) {
    if (!allowed.has(line.orderLineId)) throw new UnprocessableEntityException("Shipment package references an order line outside the order");
    totals.set(line.orderLineId, (totals.get(line.orderLineId) ?? 0) + line.quantity);
  }
  for (const [lineId, quantity] of totals) if (quantity > allowed.get(lineId)!) throw new UnprocessableEntityException("Shipment version quantity exceeds ordered quantity");
  const labelIds = [...new Set(packages.flatMap((entry) => entry.labelAssetId ? [entry.labelAssetId] : []))];
  if (labelIds.length) {
    const assets = await tx.select({ id: assetFiles.id }).from(assetFiles).where(and(
      inArray(assetFiles.id, labelIds), eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), sql`${assetFiles.deletedAt} is null`,
    ));
    if (assets.length !== labelIds.length) throw new UnprocessableEntityException("Shipment labels must use authorized assets with approved rights");
  }
}

async function assertApprovedAllocation(tx: TenantTransaction, shipment: typeof shipments.$inferSelect, versionId: string) {
  const orderLineRows = await tx.select({ id: orderLines.id, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, shipment.orderId));
  const otherShipments = await tx.select().from(shipments).where(and(
    eq(shipments.orderId, shipment.orderId), ne(shipments.id, shipment.id), isNotNull(shipments.approvedVersionNumber), ne(shipments.status, "cancelled"),
  ));
  const otherVersions = otherShipments.length ? await tx.select({ id: shipmentVersions.id, shipmentId: shipmentVersions.shipmentId, versionNumber: shipmentVersions.versionNumber })
    .from(shipmentVersions).where(inArray(shipmentVersions.shipmentId, otherShipments.map((entry) => entry.id))) : [];
  const approvedVersionIds = otherVersions.filter((version) => otherShipments.some((entry) => entry.id === version.shipmentId && entry.approvedVersionNumber === version.versionNumber)).map((entry) => entry.id);
  const versionIds = [versionId, ...approvedVersionIds];
  const allocations = await tx.select({ orderLineId: shipmentPackageLines.orderLineId, quantity: shipmentPackageLines.quantity })
    .from(shipmentPackageLines).where(inArray(shipmentPackageLines.shipmentVersionId, versionIds));
  const totals = new Map<string, number>();
  for (const allocation of allocations) totals.set(allocation.orderLineId, (totals.get(allocation.orderLineId) ?? 0) + allocation.quantity);
  for (const line of orderLineRows) if ((totals.get(line.id) ?? 0) > line.quantity) throw new ConflictException("Approved shipments would exceed ordered quantity");
}

function nextWritebackStatus(current: string, action: RecordShipmentWritebackEventInput["action"]) {
  const allowed: Record<string, Partial<Record<RecordShipmentWritebackEventInput["action"], string>>> = {
    queued: { dispatched: "dispatched", rejected: "rejected" },
    dispatched: { accepted: "accepted", rejected: "rejected", uncertain: "reconciliation_required" },
    reconciliation_required: { reconcile_accepted: "reconciled", reconcile_rejected: "reconciled" },
  };
  const next = allowed[current]?.[action];
  if (!next) throw new ConflictException(`Shipment writeback action ${action} is invalid from ${current}`);
  return next;
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }

export interface ShipmentWritebackEnqueuer {
  enqueue(input: { writebackRequestId: string; requestedBy: string; tenantId: string }): Promise<void>;
}
