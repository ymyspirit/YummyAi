import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  AnonymizeOrderProtectedDetailsCommandSchema, ListOrdersInputSchema, NormalizeOrderInputSchema, OpenOrderExceptionCommandSchema, OrderEventViewSchema,
  OrderExceptionCategorySchema, OrderExceptionViewSchema, OrderFulfillmentViewSchema, OrderPiiAccessPurposeSchema,
  OrderProtectedDetailsSchema, OrderSideStateCommandSchema, OrderSideStateSchema, OrderTransitionCommandSchema,
  OrderViewSchema, OrderWorkflowStateSchema, ResolveOrderExceptionCommandSchema, createEntityId,
  type AnonymizeOrderProtectedDetailsCommand, type ListOrdersInput, type NormalizeOrderInput, type OpenOrderExceptionCommand, type OrderEventView,
  type OrderExceptionView, type OrderFulfillmentView, type OrderPiiAccessPurpose, type OrderSideStateCommand,
  type OrderTransitionCommand, type OrderView, type ResolveOrderExceptionCommand, type TenantContext,
} from "@yummyai/contracts";
import {
  listingVersions, listings, marketplaceAccounts, marketplacePublicationEvents, marketplacePublicationRequests,
  orderCustomizationRequirements,
  orderEvents, orderExceptionEvents, orderExceptions, orderExternalReferences, orderLineCatalogLinks, orderLines,
  orderRoutingDecisions, purchaseOrders, purchaseOrderVersions,
  productionOrders, qualityInspections,
  shipmentPackageLines, shipmentVersions, shipments,
  orderProtectedAccessEvents, orderProtectedDetails, orderSourceSnapshots, orders, skus, type DatabaseConnection,
  type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { assertOrderTransition, nextOrderSideState } from "./order-state-machine.js";

@Injectable()
export class OrderService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly piiVault: SecretVault,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async ingestNormalized(context: TenantContext, rawInput: NormalizeOrderInput): Promise<OrderView> {
    return (await this.materializeNormalized(context, rawInput)).order;
  }

  async materializeNormalized(context: TenantContext, rawInput: NormalizeOrderInput): Promise<{ order: OrderView; replayed: boolean; unlinkedLineIds: string[] }> {
    const input = NormalizeOrderInputSchema.parse(rawInput);
    assertRedactedSource(input.redactedSource);
    const orderId = createEntityId();
    const snapshotId = createEntityId();
    const encryptedEnvelope = input.protectedDetails ? this.piiVault.encrypt(JSON.stringify(input.protectedDetails)) : undefined;
    const outcome = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.accountId}:${input.platform}:${input.externalOrderId}`}, 0))`);
      const [existingDelivery] = await tx.select().from(orderSourceSnapshots).where(and(
        eq(orderSourceSnapshots.accountId, input.accountId), eq(orderSourceSnapshots.platform, input.platform), eq(orderSourceSnapshots.externalEventId, input.externalEventId),
      )).limit(1);
      if (existingDelivery) return { orderId: existingDelivery.normalizedOrderId, replayed: true };
      const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, input.accountId)).limit(1);
      if (!account || account.platform !== input.platform) throw new UnprocessableEntityException("Marketplace account does not match the normalized order");
      const [existingOrder] = await tx.select().from(orders).where(and(
        eq(orders.accountId, input.accountId), eq(orders.platform, input.platform), eq(orders.externalOrderId, input.externalOrderId),
      )).limit(1);
      const targetOrderId = existingOrder?.id ?? orderId;
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId, tenantId: context.tenantId, accountId: input.accountId, platform: input.platform,
        externalEventId: input.externalEventId, externalOrderId: input.externalOrderId, normalizedOrderId: targetOrderId,
        redactedPayload: input.redactedSource, payloadChecksum: checksum(input.redactedSource),
      });
      if (existingOrder) {
        const sequence = existingOrder.latestEventSequence + 1;
        if (input.protectedDetails && encryptedEnvelope) {
          const [currentProtected] = await tx.select().from(orderProtectedDetails)
            .where(eq(orderProtectedDetails.orderId, existingOrder.id)).limit(1);
          if (!currentProtected) {
            await tx.insert(orderProtectedDetails).values({
              id: createEntityId(), tenantId: context.tenantId, orderId: existingOrder.id, encryptedEnvelope,
              countryCode: input.protectedDetails.shippingAddress.countryCode, retentionExpiresAt: retentionExpiry(),
            });
          } else if (currentProtected.status === "protected") {
            await tx.update(orderProtectedDetails).set({
              encryptedEnvelope, envelopeVersion: currentProtected.envelopeVersion + 1,
              countryCode: input.protectedDetails.shippingAddress.countryCode,
              retentionExpiresAt: retentionExpiry(), updatedAt: new Date(),
            }).where(and(
              eq(orderProtectedDetails.id, currentProtected.id),
              eq(orderProtectedDetails.envelopeVersion, currentProtected.envelopeVersion),
            ));
          }
        }
        await tx.insert(orderEvents).values({
          id: createEntityId(), tenantId: context.tenantId, orderId: existingOrder.id, sequence,
          type: "provider_update_received", code: input.providerStatus,
          idempotencyKey: `provider:${input.platform}:${input.externalEventId}`, actorUserId: context.userId,
          metadata: { sourceSnapshotId: snapshotId, previousProviderStatus: existingOrder.providerStatus, providerStatus: input.providerStatus },
        });
        await tx.update(orders).set({
          providerStatus: input.providerStatus, latestEventSequence: sequence, updatedAt: new Date(),
          ...(input.protectedDetails && existingOrder.addressStatus !== "anonymized" ? {
            addressStatus: "protected" as const,
            addressCountryCode: input.protectedDetails.shippingAddress.countryCode,
          } : {}),
        }).where(and(eq(orders.id, existingOrder.id), eq(orders.latestEventSequence, existingOrder.latestEventSequence)));
        return { orderId: existingOrder.id, replayed: false };
      }

      const countryCode = input.protectedDetails?.shippingAddress.countryCode ?? null;
      await tx.insert(orders).values({
        id: orderId, tenantId: context.tenantId, accountId: input.accountId, sourceSnapshotId: snapshotId,
        platform: input.platform, externalOrderId: input.externalOrderId, providerStatus: input.providerStatus,
        orderTotalMinor: input.orderTotal.amountMinor, orderCurrency: input.orderTotal.currency, lineCount: input.lines.length,
        addressStatus: input.protectedDetails ? "protected" : "missing", addressCountryCode: countryCode,
        placedAt: new Date(input.placedAt), latestEventSequence: 1,
      });
      const lineRows = input.lines.map((line) => ({
        id: createEntityId(), tenantId: context.tenantId, orderId, externalLineId: line.externalLineId,
        externalListingId: line.externalListingId, skuCode: line.skuCode, title: line.title, quantity: line.quantity,
        unitPriceMinor: line.unitPrice.amountMinor, unitPriceCurrency: line.unitPrice.currency, customizationCount: line.customizationCount,
      }));
      await tx.insert(orderLines).values(lineRows);
      await tx.insert(orderExternalReferences).values([
        { id: createEntityId(), tenantId: context.tenantId, orderId, provider: input.platform, kind: "order", externalId: input.externalOrderId },
        ...lineRows.map((line) => ({ id: createEntityId(), tenantId: context.tenantId, orderId, orderLineId: line.id, provider: input.platform, kind: "order_line", externalId: line.externalLineId })),
      ]);
      await linkOrderLinesToCatalog(tx, context, input.accountId, input.platform, lineRows);
      if (encryptedEnvelope) await tx.insert(orderProtectedDetails).values({
        id: createEntityId(), tenantId: context.tenantId, orderId, encryptedEnvelope,
        countryCode, retentionExpiresAt: retentionExpiry(),
      });
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: context.tenantId, orderId, sequence: 1, type: "order_ingested",
        toWorkflowState: "pending", idempotencyKey: `ingest:${input.platform}:${input.externalEventId}`, actorUserId: context.userId,
        metadata: { sourceSnapshotId: snapshotId, lineCount: input.lines.length },
      });
      return { orderId, replayed: false };
    });
    await this.audit.record(context, { action: "order.ingest", resourceType: "order", resourceId: outcome.orderId, result: "success", metadata: { accountId: input.accountId, platform: input.platform, replayed: outcome.replayed } });
    const order = await this.get(context, outcome.orderId);
    const links = await withTenant(this.database.db, context, (tx) => tx.select({
      orderLineId: orderLineCatalogLinks.orderLineId,
    }).from(orderLineCatalogLinks).where(inArray(orderLineCatalogLinks.orderLineId, order.lines.map((line) => line.id))));
    const linked = new Set(links.map((entry) => entry.orderLineId));
    return { order, replayed: outcome.replayed, unlinkedLineIds: order.lines.filter((line) => !linked.has(line.id)).map((line) => line.externalLineId) };
  }

  async list(context: TenantContext, rawInput: ListOrdersInput): Promise<OrderView[]> {
    const input = ListOrdersInputSchema.parse(rawInput);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(orders).where(and(
      input.accountId ? eq(orders.accountId, input.accountId) : undefined,
      input.workflowState ? eq(orders.workflowState, input.workflowState) : undefined,
      input.sideState === "none" ? isNull(orders.sideState) : input.sideState ? eq(orders.sideState, input.sideState) : undefined,
      input.platform ? eq(orders.platform, input.platform) : undefined,
    )).orderBy(desc(orders.placedAt), desc(orders.id)).limit(input.limit));
    return this.withLines(context, rows);
  }

  async get(context: TenantContext, orderId: string): Promise<OrderView> {
    const [row] = await withTenant(this.database.db, context, (tx) => tx.select().from(orders).where(eq(orders.id, orderId)).limit(1));
    if (!row) throw new NotFoundException("Order not found");
    return (await this.withLines(context, [row]))[0]!;
  }

  async events(context: TenantContext, orderId: string): Promise<OrderEventView[]> {
    await this.get(context, orderId);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(asc(orderEvents.sequence)));
    return rows.map(toEventView);
  }

  async transition(context: TenantContext, orderId: string, rawCommand: OrderTransitionCommand): Promise<OrderView> {
    const command = OrderTransitionCommandSchema.parse(rawCommand);
    await withTenant(this.database.db, context, async (tx) => {
      const row = await lockOrder(tx, orderId);
      if (await hasIdempotentEvent(tx, orderId, command.idempotencyKey)) return;
      assertSequence(row.latestEventSequence, command.expectedSequence);
      const from = OrderWorkflowStateSchema.parse(row.workflowState);
      const sideState = OrderSideStateSchema.nullable().parse(row.sideState);
      try { assertOrderTransition(from, command.toState, sideState); } catch (error) { throw new ConflictException(error instanceof Error ? error.message : "Invalid order transition"); }
      await assertCustomizationGate(tx, row, command.toState);
      await assertRoutingGate(tx, row, command.toState);
      await assertProductionGate(tx, row, command.toState);
      await assertShipmentGate(tx, row, command.toState);
      const sequence = row.latestEventSequence + 1;
      await tx.update(orders).set({ workflowState: command.toState, latestEventSequence: sequence, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.latestEventSequence, command.expectedSequence)));
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "workflow_transitioned",
        fromWorkflowState: from, toWorkflowState: command.toState, message: command.reason,
        idempotencyKey: command.idempotencyKey, actorUserId: context.userId,
      });
    });
    await this.audit.record(context, { action: "order.transition", resourceType: "order", resourceId: orderId, result: "success", metadata: { toState: command.toState } });
    return this.get(context, orderId);
  }

  async changeSideState(context: TenantContext, orderId: string, rawCommand: OrderSideStateCommand): Promise<OrderView> {
    const command = OrderSideStateCommandSchema.parse(rawCommand);
    await withTenant(this.database.db, context, async (tx) => {
      const row = await lockOrder(tx, orderId);
      if (await hasIdempotentEvent(tx, orderId, command.idempotencyKey)) return;
      assertSequence(row.latestEventSequence, command.expectedSequence);
      const workflowState = OrderWorkflowStateSchema.parse(row.workflowState);
      const fromSideState = OrderSideStateSchema.nullable().parse(row.sideState);
      let toSideState;
      try { toSideState = nextOrderSideState(command.action, workflowState, fromSideState); } catch (error) { throw new ConflictException(error instanceof Error ? error.message : "Invalid order side-state action"); }
      const sequence = row.latestEventSequence + 1;
      await tx.update(orders).set({ sideState: toSideState, latestEventSequence: sequence, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.latestEventSequence, command.expectedSequence)));
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "side_state_changed",
        fromSideState, toSideState, code: command.action, message: command.reason,
        idempotencyKey: command.idempotencyKey, actorUserId: context.userId,
      });
    });
    await this.audit.record(context, { action: "order.side_state", resourceType: "order", resourceId: orderId, result: "success", metadata: { action: command.action } });
    return this.get(context, orderId);
  }

  async openException(context: TenantContext, orderId: string, rawCommand: OpenOrderExceptionCommand): Promise<OrderExceptionView> {
    const command = OpenOrderExceptionCommandSchema.parse(rawCommand);
    let exceptionId = createEntityId();
    await withTenant(this.database.db, context, async (tx) => {
      const row = await lockOrder(tx, orderId);
      const [existing] = await tx.select({ exceptionId: orderExceptionEvents.exceptionId }).from(orderExceptionEvents).where(and(eq(orderExceptionEvents.orderId, orderId), eq(orderExceptionEvents.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) { exceptionId = existing.exceptionId; return; }
      const sequence = row.latestEventSequence + 1;
      await tx.insert(orderExceptions).values({ id: exceptionId, tenantId: context.tenantId, orderId, category: command.category, code: command.code, message: command.message, openedBy: context.userId });
      await tx.insert(orderExceptionEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, exceptionId, sequence: 1, status: "open", idempotencyKey: command.idempotencyKey, actorUserId: context.userId });
      await tx.insert(orderEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "exception_opened", code: command.code, message: command.message, idempotencyKey: command.idempotencyKey, actorUserId: context.userId, metadata: { exceptionId, category: command.category } });
      await tx.update(orders).set({ latestEventSequence: sequence, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.latestEventSequence, row.latestEventSequence)));
    });
    await this.audit.record(context, { action: "order.exception.open", resourceType: "order_exception", resourceId: exceptionId, result: "success", metadata: { orderId, category: command.category, code: command.code } });
    return this.requireException(context, orderId, exceptionId);
  }

  async resolveException(context: TenantContext, orderId: string, exceptionId: string, rawCommand: ResolveOrderExceptionCommand): Promise<OrderExceptionView> {
    const command = ResolveOrderExceptionCommandSchema.parse(rawCommand);
    await withTenant(this.database.db, context, async (tx) => {
      const row = await lockOrder(tx, orderId);
      const [exception] = await tx.select().from(orderExceptions).where(and(eq(orderExceptions.id, exceptionId), eq(orderExceptions.orderId, orderId))).limit(1);
      if (!exception) throw new NotFoundException("Order exception not found");
      const [existing] = await tx.select().from(orderExceptionEvents).where(and(eq(orderExceptionEvents.orderId, orderId), eq(orderExceptionEvents.idempotencyKey, command.idempotencyKey))).limit(1);
      if (existing) return;
      const [latest] = await tx.select().from(orderExceptionEvents).where(eq(orderExceptionEvents.exceptionId, exceptionId)).orderBy(desc(orderExceptionEvents.sequence)).limit(1);
      if (!latest || latest.status === "resolved") throw new ConflictException("Order exception is already resolved");
      const sequence = row.latestEventSequence + 1;
      await tx.insert(orderExceptionEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, exceptionId, sequence: latest.sequence + 1, status: "resolved", resolution: command.resolution, idempotencyKey: command.idempotencyKey, actorUserId: context.userId });
      await tx.insert(orderEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "exception_resolved", code: exception.code, message: command.resolution, idempotencyKey: command.idempotencyKey, actorUserId: context.userId, metadata: { exceptionId, category: exception.category } });
      await tx.update(orders).set({ latestEventSequence: sequence, updatedAt: new Date() }).where(and(eq(orders.id, orderId), eq(orders.latestEventSequence, row.latestEventSequence)));
    });
    await this.audit.record(context, { action: "order.exception.resolve", resourceType: "order_exception", resourceId: exceptionId, result: "success", metadata: { orderId } });
    return this.requireException(context, orderId, exceptionId);
  }

  async exceptions(context: TenantContext, orderId: string): Promise<OrderExceptionView[]> {
    await this.get(context, orderId);
    const identities = await withTenant(this.database.db, context, (tx) => tx.select().from(orderExceptions).where(eq(orderExceptions.orderId, orderId)).orderBy(desc(orderExceptions.openedAt)));
    if (!identities.length) return [];
    const events = await withTenant(this.database.db, context, (tx) => tx.select().from(orderExceptionEvents).where(inArray(orderExceptionEvents.exceptionId, identities.map((entry) => entry.id))).orderBy(desc(orderExceptionEvents.sequence)));
    const latest = new Map<string, typeof orderExceptionEvents.$inferSelect>();
    for (const event of events) if (!latest.has(event.exceptionId)) latest.set(event.exceptionId, event);
    return identities.map((identity) => toExceptionView(identity, latest.get(identity.id)!));
  }

  async listExceptions(context: TenantContext, status?: "open" | "resolved"): Promise<OrderExceptionView[]> {
    const identities = await withTenant(this.database.db, context, (tx) => tx.select().from(orderExceptions).orderBy(desc(orderExceptions.openedAt)));
    if (!identities.length) return [];
    const events = await withTenant(this.database.db, context, (tx) => tx.select().from(orderExceptionEvents)
      .where(inArray(orderExceptionEvents.exceptionId, identities.map((entry) => entry.id)))
      .orderBy(desc(orderExceptionEvents.sequence)));
    const latest = new Map<string, typeof orderExceptionEvents.$inferSelect>();
    for (const event of events) if (!latest.has(event.exceptionId)) latest.set(event.exceptionId, event);
    const views = identities.map((identity) => toExceptionView(identity, latest.get(identity.id)!));
    return status ? views.filter((view) => view.status === status) : views;
  }

  async fulfillmentDetails(context: TenantContext, orderId: string, rawPurpose: OrderPiiAccessPurpose): Promise<OrderFulfillmentView> {
    const purpose = OrderPiiAccessPurposeSchema.parse(rawPurpose);
    const accessedAt = new Date();
    const envelope = await withTenant(this.database.db, context, async (tx) => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new NotFoundException("Order not found");
      const [details] = await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1);
      await tx.insert(orderProtectedAccessEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, purpose, actorUserId: context.userId, granted: true, occurredAt: accessedAt });
      return details?.status === "protected" ? details.encryptedEnvelope : undefined;
    });
    const protectedDetails = envelope ? this.piiVault.withSecret(envelope, (plaintext) => OrderProtectedDetailsSchema.parse(JSON.parse(plaintext))) : null;
    await this.audit.record(context, { action: "order.pii.read", resourceType: "order", resourceId: orderId, result: "success", metadata: { purpose, protectedDetailsAvailable: Boolean(protectedDetails) } });
    return OrderFulfillmentViewSchema.parse({ order: await this.get(context, orderId), purpose, protectedDetails, accessedAt: accessedAt.toISOString() });
  }

  async anonymizeProtectedDetails(context: TenantContext, orderId: string, rawCommand: AnonymizeOrderProtectedDetailsCommand, now = new Date()): Promise<OrderView> {
    const command = AnonymizeOrderProtectedDetailsCommandSchema.parse(rawCommand);
    await withTenant(this.database.db, context, async (tx) => {
      const order = await lockOrder(tx, orderId);
      if (await hasIdempotentEvent(tx, orderId, command.idempotencyKey)) return;
      assertSequence(order.latestEventSequence, command.expectedSequence);
      const [details] = await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1);
      if (!details) throw new ConflictException("Order has no protected details to anonymize");
      if (details.status === "anonymized") throw new ConflictException("Order protected details are already anonymized");
      if (details.envelopeVersion !== command.expectedEnvelopeVersion) throw new ConflictException("Protected detail version changed");
      if (details.retentionExpiresAt > now) throw new ConflictException("Protected detail retention period has not expired");
      const [updated] = await tx.update(orderProtectedDetails).set({
        encryptedEnvelope: null, countryCode: null, status: "anonymized", anonymizedAt: now,
        envelopeVersion: details.envelopeVersion + 1, updatedAt: now,
      }).where(and(
        eq(orderProtectedDetails.id, details.id), eq(orderProtectedDetails.envelopeVersion, command.expectedEnvelopeVersion),
        eq(orderProtectedDetails.status, "protected"),
      )).returning({ id: orderProtectedDetails.id });
      if (!updated) throw new ConflictException("Protected detail version changed");
      const sequence = order.latestEventSequence + 1;
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: context.tenantId, orderId, sequence, type: "protected_details_anonymized",
        code: "RETENTION_EXPIRED", idempotencyKey: command.idempotencyKey, actorUserId: context.userId,
        metadata: { previousEnvelopeVersion: details.envelopeVersion, reasonChecksum: checksum(command.reason), retentionExpiresAt: details.retentionExpiresAt.toISOString() },
      });
      await tx.update(orders).set({
        addressStatus: "anonymized", addressCountryCode: null, latestEventSequence: sequence, updatedAt: now,
      }).where(and(eq(orders.id, orderId), eq(orders.latestEventSequence, command.expectedSequence)));
    });
    await this.audit.record(context, {
      action: "order.pii.anonymize", resourceType: "order", resourceId: orderId, result: "success",
      metadata: { reasonChecksum: checksum(command.reason) },
    });
    return this.get(context, orderId);
  }

  private async requireException(context: TenantContext, orderId: string, exceptionId: string): Promise<OrderExceptionView> {
    const items = await this.exceptions(context, orderId);
    const item = items.find((candidate) => candidate.id === exceptionId);
    if (!item) throw new NotFoundException("Order exception not found");
    return item;
  }

  private async withLines(context: TenantContext, rows: Array<typeof orders.$inferSelect>): Promise<OrderView[]> {
    if (!rows.length) return [];
    const lines = await withTenant(this.database.db, context, (tx) => tx.select().from(orderLines).where(inArray(orderLines.orderId, rows.map((row) => row.id))).orderBy(asc(orderLines.createdAt), asc(orderLines.id)));
    const byOrder = new Map<string, Array<typeof orderLines.$inferSelect>>();
    for (const line of lines) byOrder.set(line.orderId, [...(byOrder.get(line.orderId) ?? []), line]);
    return rows.map((row) => toOrderView(row, byOrder.get(row.id) ?? []));
  }
}

interface CatalogLinkableLine {
  id: string;
  externalListingId: string | null;
  skuCode: string | null;
}

async function linkOrderLinesToCatalog(
  tx: TenantTransaction,
  context: TenantContext,
  accountId: string,
  platform: NormalizeOrderInput["platform"],
  lines: CatalogLinkableLine[],
) {
  for (const line of lines) {
    if (line.externalListingId) {
      const [published] = await tx.select({
        listingId: marketplacePublicationRequests.listingId,
        listingVersionId: marketplacePublicationRequests.listingVersionId,
      }).from(marketplacePublicationEvents)
        .innerJoin(marketplacePublicationRequests, and(
          eq(marketplacePublicationRequests.tenantId, marketplacePublicationEvents.tenantId),
          eq(marketplacePublicationRequests.id, marketplacePublicationEvents.requestId),
        ))
        .innerJoin(listingVersions, and(
          eq(listingVersions.tenantId, marketplacePublicationRequests.tenantId),
          eq(listingVersions.id, marketplacePublicationRequests.listingVersionId),
        ))
        .where(and(
          eq(marketplacePublicationRequests.accountId, accountId),
          eq(marketplacePublicationRequests.platform, platform),
          eq(marketplacePublicationEvents.externalListingId, line.externalListingId),
          inArray(listingVersions.status, ["approved", "superseded"]),
        ))
        .orderBy(desc(marketplacePublicationEvents.occurredAt), desc(marketplacePublicationEvents.sequence), asc(marketplacePublicationRequests.id))
        .limit(1);
      if (published) {
        await tx.insert(orderLineCatalogLinks).values({
          id: createEntityId(), tenantId: context.tenantId, orderLineId: line.id,
          listingId: published.listingId, listingVersionId: published.listingVersionId,
          matchSource: "external_listing", linkedBy: context.userId,
        });
        continue;
      }
    }

    if (!line.skuCode) continue;
    const [sku] = await tx.select({ id: skus.id, spuId: skus.spuId }).from(skus)
      .where(and(eq(skus.code, line.skuCode), eq(skus.status, "active")))
      .limit(1);
    if (!sku) continue;
    const [approvedListing] = await tx.select({ id: listings.id, versionId: listings.primaryVersionId }).from(listings)
      .innerJoin(listingVersions, and(
        eq(listingVersions.tenantId, listings.tenantId),
        eq(listingVersions.id, listings.primaryVersionId),
        eq(listingVersions.status, "approved"),
      ))
      .where(and(
        eq(listings.spuId, sku.spuId), eq(listings.platform, platform), eq(listings.status, "approved"),
        isNotNull(listings.primaryVersionId),
      ))
      .orderBy(desc(listings.updatedAt), asc(listings.id))
      .limit(1);
    await tx.insert(orderLineCatalogLinks).values({
      id: createEntityId(), tenantId: context.tenantId, orderLineId: line.id, skuId: sku.id,
      listingId: approvedListing?.id, listingVersionId: approvedListing?.versionId,
      matchSource: "sku", linkedBy: context.userId,
    });
  }
}

async function lockOrder(tx: TenantTransaction, orderId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${orderId}, 0))`);
  const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!row) throw new NotFoundException("Order not found");
  return row;
}

async function assertCustomizationGate(
  tx: TenantTransaction,
  order: typeof orders.$inferSelect,
  target: OrderTransitionCommand["toState"],
) {
  if (!["awaiting_design", "awaiting_customer_approval", "awaiting_routing", "in_production"].includes(target)) return;
  const requirements = await tx.select().from(orderCustomizationRequirements).where(eq(orderCustomizationRequirements.orderId, order.id));
  if (requirements.length !== order.lineCount) throw new ConflictException("Every order line requires a pinned customization decision before fulfillment can advance");
  const allowed = requirements.every((requirement) => {
    if (target === "awaiting_design") return !["incomplete", "quarantined", "rejected"].includes(requirement.status);
    if (target === "awaiting_customer_approval") {
      if (requirement.fulfillmentPath === "template_ready") return ["ready", "approved"].includes(requirement.status);
      if (requirement.fulfillmentPath === "designer_required") return requirement.status === "approved";
      return ["awaiting_customer", "approved"].includes(requirement.status);
    }
    return ["ready", "approved"].includes(requirement.status);
  });
  if (!allowed) throw new ConflictException("Customization, design, file-scan, or customer-approval prerequisites are incomplete");
}

async function assertRoutingGate(
  tx: TenantTransaction,
  order: typeof orders.$inferSelect,
  target: OrderTransitionCommand["toState"],
) {
  if (target !== "in_production") return;
  const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, order.id));
  const decisions = await tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.orderId, order.id))
    .orderBy(desc(orderRoutingDecisions.versionNumber));
  const latest = new Map<string, typeof orderRoutingDecisions.$inferSelect>();
  for (const decision of decisions) if (!latest.has(decision.orderLineId)) latest.set(decision.orderLineId, decision);
  if (lines.some((line) => latest.get(line.id)?.status !== "approved")) {
    throw new ConflictException("Every order line requires an approved latest routing decision before production");
  }
  const approvedIds = lines.map((line) => latest.get(line.id)!.id);
  const projections = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.orderId, order.id), eq(purchaseOrders.status, "approved")));
  if (!projections.length) throw new ConflictException("Approved purchase orders are required before production");
  const versions = await tx.select().from(purchaseOrderVersions).where(inArray(purchaseOrderVersions.purchaseOrderId, projections.map((entry) => entry.id)));
  const pinned = new Set(versions.filter((version) => projections.some((entry) => entry.id === version.purchaseOrderId && entry.currentVersionNumber === version.versionNumber))
    .flatMap((version) => version.routingDecisionIds));
  if (approvedIds.some((id) => !pinned.has(id))) throw new ConflictException("Purchase-order versions do not cover every approved routing decision");
}

async function assertProductionGate(
  tx: TenantTransaction,
  order: typeof orders.$inferSelect,
  target: OrderTransitionCommand["toState"],
) {
  if (target !== "awaiting_quality_control" && target !== "awaiting_shipment") return;
  const lines = await tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, order.id));
  const production = await tx.select().from(productionOrders).where(eq(productionOrders.orderId, order.id))
    .orderBy(desc(productionOrders.createdAt));
  const latest = new Map<string, typeof productionOrders.$inferSelect>();
  for (const entry of production) if (!latest.has(entry.orderLineId)) latest.set(entry.orderLineId, entry);
  if (lines.some((line) => latest.get(line.id)?.status !== "completed")) {
    throw new ConflictException("Every order line requires a completed latest production order before fulfillment can advance");
  }
  if (target !== "awaiting_shipment") return;
  const latestProductionIds = lines.map((line) => latest.get(line.id)!.id);
  const inspections = await tx.select().from(qualityInspections).where(inArray(qualityInspections.productionOrderId, latestProductionIds))
    .orderBy(desc(qualityInspections.inspectedAt));
  const latestInspection = new Map<string, typeof qualityInspections.$inferSelect>();
  for (const inspection of inspections) if (!latestInspection.has(inspection.productionOrderId)) latestInspection.set(inspection.productionOrderId, inspection);
  if (latestProductionIds.some((id) => latestInspection.get(id)?.result !== "passed")) {
    throw new ConflictException("Every latest production order requires a passed inspection before shipment");
  }
}

async function assertShipmentGate(
  tx: TenantTransaction,
  order: typeof orders.$inferSelect,
  target: OrderTransitionCommand["toState"],
) {
  if (target !== "shipped" && target !== "completed") return;
  const lineRows = await tx.select({ id: orderLines.id, quantity: orderLines.quantity }).from(orderLines).where(eq(orderLines.orderId, order.id));
  const allShipments = await tx.select().from(shipments).where(eq(shipments.orderId, order.id));
  const acceptedStatuses = target === "completed" ? ["delivered"] : ["shipped", "in_transit", "delivered"];
  const accepted = allShipments.filter((entry) => entry.approvedVersionNumber !== null && acceptedStatuses.includes(entry.status));
  if (!accepted.length) throw new ConflictException("Marketplace-acknowledged shipment evidence is required");
  const versions = await tx.select({ id: shipmentVersions.id, shipmentId: shipmentVersions.shipmentId, versionNumber: shipmentVersions.versionNumber })
    .from(shipmentVersions).where(inArray(shipmentVersions.shipmentId, accepted.map((entry) => entry.id)));
  const acceptedVersionIds = versions.filter((version) => accepted.some((entry) => entry.id === version.shipmentId && entry.approvedVersionNumber === version.versionNumber)).map((entry) => entry.id);
  const allocations = await tx.select({ orderLineId: shipmentPackageLines.orderLineId, quantity: shipmentPackageLines.quantity })
    .from(shipmentPackageLines).where(inArray(shipmentPackageLines.shipmentVersionId, acceptedVersionIds));
  const totals = new Map<string, number>();
  for (const allocation of allocations) totals.set(allocation.orderLineId, (totals.get(allocation.orderLineId) ?? 0) + allocation.quantity);
  if (lineRows.some((line) => totals.get(line.id) !== line.quantity)) {
    throw new ConflictException(target === "completed" ? "Every shipped quantity must be delivered before completion" : "Acknowledged shipment versions must cover every order line quantity");
  }
}

async function hasIdempotentEvent(tx: TenantTransaction, orderId: string, idempotencyKey: string) {
  const [event] = await tx.select({ id: orderEvents.id }).from(orderEvents).where(and(eq(orderEvents.orderId, orderId), eq(orderEvents.idempotencyKey, idempotencyKey))).limit(1);
  return Boolean(event);
}

function assertSequence(actual: number, expected: number) { if (actual !== expected) throw new ConflictException(`Order event sequence changed; expected ${expected}, current ${actual}`); }
function checksum(value: unknown) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
function retentionExpiry() { const days = Number(process.env.ORDER_PII_RETENTION_DAYS ?? "90"); if (!Number.isInteger(days) || days < 1 || days > 3_650) throw new TypeError("ORDER_PII_RETENTION_DAYS must be an integer from 1 to 3650"); return new Date(Date.now() + days * 86_400_000); }
function assertRedactedSource(value: unknown, key = "root"): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertRedactedSource(entry, `${key}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(buyer|recipient|name|email|phone|address|postal|zip)/i.test(childKey) && child !== null && child !== "[REDACTED]") throw new UnprocessableEntityException(`Protected source field must be redacted: ${childKey}`);
    assertRedactedSource(child, `${key}.${childKey}`);
  }
}

function toOrderView(row: typeof orders.$inferSelect, lines: Array<typeof orderLines.$inferSelect>): OrderView {
  return OrderViewSchema.parse({
    id: row.id, accountId: row.accountId, platform: row.platform, externalOrderId: row.externalOrderId,
    providerStatus: row.providerStatus, workflowState: row.workflowState, sideState: row.sideState,
    orderTotal: { amountMinor: row.orderTotalMinor, currency: row.orderCurrency }, lineCount: row.lineCount,
    address: { status: row.addressStatus, countryCode: row.addressCountryCode }, latestEventSequence: row.latestEventSequence,
    placedAt: row.placedAt.toISOString(), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    lines: lines.map((line) => ({ id: line.id, externalLineId: line.externalLineId, externalListingId: line.externalListingId, skuCode: line.skuCode, title: line.title, quantity: line.quantity, unitPrice: { amountMinor: line.unitPriceMinor, currency: line.unitPriceCurrency }, customizationCount: line.customizationCount })),
  });
}

function toEventView(row: typeof orderEvents.$inferSelect): OrderEventView {
  return OrderEventViewSchema.parse({ id: row.id, sequence: row.sequence, type: row.type, fromWorkflowState: row.fromWorkflowState, toWorkflowState: row.toWorkflowState, fromSideState: row.fromSideState, toSideState: row.toSideState, code: row.code, message: row.message, idempotencyKey: row.idempotencyKey, occurredAt: row.occurredAt.toISOString() });
}

function toExceptionView(identity: typeof orderExceptions.$inferSelect, latest: typeof orderExceptionEvents.$inferSelect): OrderExceptionView {
  return OrderExceptionViewSchema.parse({ id: identity.id, orderId: identity.orderId, category: OrderExceptionCategorySchema.parse(identity.category), code: identity.code, message: identity.message, status: latest.status, resolution: latest.resolution, openedAt: identity.openedAt.toISOString(), resolvedAt: latest.status === "resolved" ? latest.occurredAt.toISOString() : null });
}
