import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  AddResponsibilityEvidenceInputSchema, CreateAfterSalesCaseInputSchema, CreateReturnShipmentInputSchema,
  DecideAfterSalesCaseInputSchema, LinkReplacementOrderInputSchema, RecordCustomerContactInputSchema,
  RecordReturnTrackingEventInputSchema, createEntityId,
  type AddResponsibilityEvidenceInput, type CreateAfterSalesCaseInput, type CreateReturnShipmentInput,
  type DecideAfterSalesCaseInput, type LinkReplacementOrderInput, type RecordCustomerContactInput,
  type RecordReturnTrackingEventInput, type TenantContext,
} from "@yummyai/contracts";
import {
  afterSalesCases, afterSalesDecisions, afterSalesResponsibilityEvidence, customerContactRecords,
  assetFiles, orders, replacementOrderLinks, returnShipments, returnTrackingEvents,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";

@Injectable()
export class OrderAfterSalesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, orderId: string, rawInput: CreateAfterSalesCaseInput) {
    const input = CreateAfterSalesCaseInputSchema.parse(rawInput);
    const caseId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `after-sales-order:${orderId}`);
      const [replayed] = await tx.select({ id: afterSalesCases.id }).from(afterSalesCases).where(and(
        eq(afterSalesCases.orderId, orderId), eq(afterSalesCases.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new NotFoundException("Order not found");
      const id = createEntityId();
      await tx.insert(afterSalesCases).values({
        id, tenantId: context.tenantId, orderId, type: input.type, reasonCode: input.reasonCode,
        encryptedSummary: this.vault.encrypt(input.summary), summaryChecksum: checksum(input.summary),
        idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
      return id;
    });
    await this.audit.record(context, { action: "after_sales_case.create", resourceType: "after_sales_case", resourceId: caseId, result: "success", metadata: { orderId, type: input.type } });
    return this.get(context, caseId);
  }

  async recordContact(context: TenantContext, caseId: string, rawInput: RecordCustomerContactInput) {
    const input = RecordCustomerContactInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `after-sales-case:${caseId}`);
      const [record] = await tx.select().from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const [replayed] = await tx.select({ id: customerContactRecords.id }).from(customerContactRecords).where(and(
        eq(customerContactRecords.caseId, caseId), eq(customerContactRecords.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      if (["resolved", "cancelled"].includes(record.status)) throw new ConflictException("Closed after-sales case cannot accept contacts");
      await tx.insert(customerContactRecords).values({
        id: createEntityId(), tenantId: context.tenantId, caseId, orderId: record.orderId,
        channel: input.channel, direction: input.direction, encryptedBody: this.vault.encrypt(input.body),
        bodyChecksum: checksum(input.body), externalMessageId: input.externalMessageId,
        idempotencyKey: input.idempotencyKey, actorUserId: context.userId, occurredAt: new Date(input.occurredAt),
      });
      const status = input.direction === "inbound" ? "awaiting_internal" : input.direction === "outbound" ? "awaiting_customer" : record.status;
      await tx.update(afterSalesCases).set({ status, updatedAt: new Date() }).where(eq(afterSalesCases.id, caseId));
    });
    await this.audit.record(context, { action: "after_sales_case.contact", resourceType: "after_sales_case", resourceId: caseId, result: "success", metadata: { channel: input.channel, direction: input.direction } });
    return this.get(context, caseId);
  }

  async decide(context: TenantContext, caseId: string, rawInput: DecideAfterSalesCaseInput) {
    const input = DecideAfterSalesCaseInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `after-sales-case:${caseId}`);
      const [record] = await tx.select().from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const [replayed] = await tx.select({ id: afterSalesDecisions.id }).from(afterSalesDecisions).where(and(
        eq(afterSalesDecisions.caseId, caseId), eq(afterSalesDecisions.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      if (["resolved", "cancelled"].includes(record.status)) throw new ConflictException("Closed after-sales case cannot be decided");
      if (record.currentDecisionVersion !== input.expectedDecisionVersion) throw new ConflictException("After-sales decision version changed");
      const [order] = await tx.select({ total: orders.orderTotalMinor, currency: orders.orderCurrency }).from(orders).where(eq(orders.id, record.orderId)).limit(1);
      if (!order) throw new NotFoundException("Order not found");
      validateRefund(order, input);
      const versionNumber = record.currentDecisionVersion + 1;
      await tx.insert(afterSalesDecisions).values({
        id: createEntityId(), tenantId: context.tenantId, caseId, versionNumber,
        resolution: input.resolution, refundAmountMinor: input.refundAmountMinor, refundCurrency: input.refundCurrency,
        returnRequired: input.returnRequired, responsibilityParty: input.responsibilityParty, reasonCode: input.reasonCode,
        encryptedReason: this.vault.encrypt(input.reason), reasonChecksum: checksum(input.reason),
        idempotencyKey: input.idempotencyKey, decidedBy: context.userId,
      });
      const status = input.resolution === "no_action" ? "rejected" : "approved";
      await tx.update(afterSalesCases).set({ status, currentDecisionVersion: versionNumber, updatedAt: new Date() }).where(eq(afterSalesCases.id, caseId));
    });
    await this.audit.record(context, { action: "after_sales_case.decide", resourceType: "after_sales_case", resourceId: caseId, result: "success", metadata: { resolution: input.resolution, responsibilityParty: input.responsibilityParty } });
    return this.get(context, caseId);
  }

  async createReturnShipment(context: TenantContext, caseId: string, rawInput: CreateReturnShipmentInput) {
    const input = CreateReturnShipmentInputSchema.parse(rawInput);
    let returnShipmentId = "";
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `after-sales-case:${caseId}`);
      const [record] = await tx.select().from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const [replayed] = await tx.select({ id: returnShipments.id }).from(returnShipments).where(and(
        eq(returnShipments.caseId, caseId), eq(returnShipments.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) { returnShipmentId = replayed.id; return; }
      const [decision] = await tx.select().from(afterSalesDecisions).where(and(
        eq(afterSalesDecisions.caseId, caseId), eq(afterSalesDecisions.versionNumber, record.currentDecisionVersion),
      )).limit(1);
      if (record.status !== "approved" || !decision?.returnRequired) throw new ConflictException("An approved return decision is required");
      await assertAuthorizedAsset(tx, input.labelAssetId);
      returnShipmentId = createEntityId();
      await tx.insert(returnShipments).values({
        id: returnShipmentId, tenantId: context.tenantId, caseId, orderId: record.orderId,
        carrierCode: input.carrierCode, trackingNumber: input.trackingNumber, labelAssetId: input.labelAssetId,
        idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
    });
    await this.audit.record(context, { action: "after_sales_return.create", resourceType: "return_shipment", resourceId: returnShipmentId, result: "success", metadata: { caseId } });
    return this.get(context, caseId);
  }

  async recordReturnTracking(context: TenantContext, caseId: string, returnShipmentId: string, rawInput: RecordReturnTrackingEventInput) {
    const input = RecordReturnTrackingEventInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `return-shipment:${returnShipmentId}`);
      const [shipment] = await tx.select().from(returnShipments).where(and(eq(returnShipments.id, returnShipmentId), eq(returnShipments.caseId, caseId))).limit(1);
      if (!shipment) throw new NotFoundException("Return shipment not found");
      const [replayed] = await tx.select({ id: returnTrackingEvents.id }).from(returnTrackingEvents).where(and(
        eq(returnTrackingEvents.provider, input.provider), eq(returnTrackingEvents.externalEventId, input.externalEventId),
      )).limit(1);
      if (replayed) return;
      if (["delivered", "cancelled"].includes(shipment.status)) throw new ConflictException("Return shipment is already terminal");
      const nextStatus = nextReturnStatus(shipment.status, input.status);
      await tx.insert(returnTrackingEvents).values({
        id: createEntityId(), tenantId: context.tenantId, returnShipmentId, status: input.status,
        provider: input.provider, externalEventId: input.externalEventId, detailCode: input.detailCode,
        occurredAt: new Date(input.occurredAt),
      });
      await tx.update(returnShipments).set({ status: nextStatus, updatedAt: new Date() }).where(eq(returnShipments.id, returnShipmentId));
      if (nextStatus === "delivered") await tx.update(afterSalesCases).set({ status: "resolved", updatedAt: new Date() }).where(eq(afterSalesCases.id, caseId));
    });
    await this.audit.record(context, { action: "after_sales_return.tracking", resourceType: "return_shipment", resourceId: returnShipmentId, result: "success", metadata: { caseId, status: input.status } });
    return this.get(context, caseId);
  }

  async linkReplacement(context: TenantContext, caseId: string, rawInput: LinkReplacementOrderInput) {
    const input = LinkReplacementOrderInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `after-sales-case:${caseId}`);
      const [record] = await tx.select().from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const [replayed] = await tx.select({ id: replacementOrderLinks.id }).from(replacementOrderLinks).where(and(
        eq(replacementOrderLinks.caseId, caseId), eq(replacementOrderLinks.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      const [decision] = await tx.select().from(afterSalesDecisions).where(and(
        eq(afterSalesDecisions.caseId, caseId), eq(afterSalesDecisions.versionNumber, record.currentDecisionVersion),
      )).limit(1);
      if (record.status !== "approved" || decision?.resolution !== "replacement") throw new ConflictException("An approved replacement decision is required");
      const [replacement] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, input.replacementOrderId)).limit(1);
      if (!replacement) throw new NotFoundException("Replacement order not found");
      if (input.replacementOrderId === record.orderId) throw new UnprocessableEntityException("Replacement order must differ from source order");
      const lineage = await tx.select({ sourceOrderId: replacementOrderLinks.sourceOrderId, replacementOrderId: replacementOrderLinks.replacementOrderId }).from(replacementOrderLinks);
      if (createsReplacementCycle(lineage, record.orderId, input.replacementOrderId)) throw new UnprocessableEntityException("Replacement lineage cannot contain a cycle");
      await tx.insert(replacementOrderLinks).values({
        id: createEntityId(), tenantId: context.tenantId, caseId, sourceOrderId: record.orderId,
        replacementOrderId: input.replacementOrderId, encryptedReason: this.vault.encrypt(input.reason),
        reasonChecksum: checksum(input.reason), idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
      await tx.update(afterSalesCases).set({ status: "resolved", updatedAt: new Date() }).where(eq(afterSalesCases.id, caseId));
    });
    await this.audit.record(context, { action: "after_sales_replacement.link", resourceType: "after_sales_case", resourceId: caseId, result: "success", metadata: { replacementOrderId: input.replacementOrderId } });
    return this.get(context, caseId);
  }

  async addResponsibilityEvidence(context: TenantContext, caseId: string, rawInput: AddResponsibilityEvidenceInput) {
    const input = AddResponsibilityEvidenceInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      const [record] = await tx.select({ id: afterSalesCases.id }).from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const [replayed] = await tx.select({ id: afterSalesResponsibilityEvidence.id }).from(afterSalesResponsibilityEvidence).where(and(
        eq(afterSalesResponsibilityEvidence.caseId, caseId), eq(afterSalesResponsibilityEvidence.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return;
      await assertAuthorizedAsset(tx, input.assetId);
      await tx.insert(afterSalesResponsibilityEvidence).values({
        id: createEntityId(), tenantId: context.tenantId, caseId, party: input.party, code: input.code,
        encryptedDetail: this.vault.encrypt(input.detail), detailChecksum: checksum(input.detail), assetId: input.assetId,
        idempotencyKey: input.idempotencyKey, recordedBy: context.userId,
      });
    });
    await this.audit.record(context, { action: "after_sales_responsibility.record", resourceType: "after_sales_case", resourceId: caseId, result: "success", metadata: { party: input.party, code: input.code } });
    return this.get(context, caseId);
  }

  async list(context: TenantContext, orderId?: string) {
    return withTenant(this.database.db, context, (tx) => tx.select({
      id: afterSalesCases.id, orderId: afterSalesCases.orderId, type: afterSalesCases.type,
      status: afterSalesCases.status, reasonCode: afterSalesCases.reasonCode,
      summaryChecksum: afterSalesCases.summaryChecksum, currentDecisionVersion: afterSalesCases.currentDecisionVersion,
      createdBy: afterSalesCases.createdBy, createdAt: afterSalesCases.createdAt, updatedAt: afterSalesCases.updatedAt,
    }).from(afterSalesCases).where(orderId ? eq(afterSalesCases.orderId, orderId) : undefined).orderBy(desc(afterSalesCases.updatedAt)));
  }

  async get(context: TenantContext, caseId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [record] = await tx.select({
        id: afterSalesCases.id, orderId: afterSalesCases.orderId, type: afterSalesCases.type,
        status: afterSalesCases.status, reasonCode: afterSalesCases.reasonCode,
        summaryChecksum: afterSalesCases.summaryChecksum, currentDecisionVersion: afterSalesCases.currentDecisionVersion,
        createdBy: afterSalesCases.createdBy, createdAt: afterSalesCases.createdAt, updatedAt: afterSalesCases.updatedAt,
      }).from(afterSalesCases).where(eq(afterSalesCases.id, caseId)).limit(1);
      if (!record) throw new NotFoundException("After-sales case not found");
      const contacts = await tx.select({
        id: customerContactRecords.id, channel: customerContactRecords.channel, direction: customerContactRecords.direction,
        bodyChecksum: customerContactRecords.bodyChecksum, externalMessageId: customerContactRecords.externalMessageId,
        actorUserId: customerContactRecords.actorUserId, occurredAt: customerContactRecords.occurredAt, recordedAt: customerContactRecords.recordedAt,
      }).from(customerContactRecords).where(eq(customerContactRecords.caseId, caseId)).orderBy(asc(customerContactRecords.occurredAt));
      const decisions = await tx.select({
        id: afterSalesDecisions.id, versionNumber: afterSalesDecisions.versionNumber, resolution: afterSalesDecisions.resolution,
        refundAmountMinor: afterSalesDecisions.refundAmountMinor, refundCurrency: afterSalesDecisions.refundCurrency,
        returnRequired: afterSalesDecisions.returnRequired, responsibilityParty: afterSalesDecisions.responsibilityParty,
        reasonCode: afterSalesDecisions.reasonCode, reasonChecksum: afterSalesDecisions.reasonChecksum,
        decidedBy: afterSalesDecisions.decidedBy, decidedAt: afterSalesDecisions.decidedAt,
      }).from(afterSalesDecisions).where(eq(afterSalesDecisions.caseId, caseId)).orderBy(asc(afterSalesDecisions.versionNumber));
      const returns = await tx.select({
        id: returnShipments.id, caseId: returnShipments.caseId, orderId: returnShipments.orderId,
        carrierCode: returnShipments.carrierCode, trackingNumber: returnShipments.trackingNumber,
        status: returnShipments.status, labelAssetId: returnShipments.labelAssetId,
        createdBy: returnShipments.createdBy, createdAt: returnShipments.createdAt, updatedAt: returnShipments.updatedAt,
      }).from(returnShipments).where(eq(returnShipments.caseId, caseId)).orderBy(asc(returnShipments.createdAt));
      const returnEvents = returns.length ? await tx.select().from(returnTrackingEvents).where(inArray(returnTrackingEvents.returnShipmentId, returns.map((entry) => entry.id))).orderBy(asc(returnTrackingEvents.occurredAt)) : [];
      const replacements = await tx.select({
        id: replacementOrderLinks.id, sourceOrderId: replacementOrderLinks.sourceOrderId,
        replacementOrderId: replacementOrderLinks.replacementOrderId, reasonChecksum: replacementOrderLinks.reasonChecksum,
        createdBy: replacementOrderLinks.createdBy, createdAt: replacementOrderLinks.createdAt,
      }).from(replacementOrderLinks).where(eq(replacementOrderLinks.caseId, caseId)).orderBy(asc(replacementOrderLinks.createdAt));
      const responsibilityEvidence = await tx.select({
        id: afterSalesResponsibilityEvidence.id, party: afterSalesResponsibilityEvidence.party,
        code: afterSalesResponsibilityEvidence.code, detailChecksum: afterSalesResponsibilityEvidence.detailChecksum,
        assetId: afterSalesResponsibilityEvidence.assetId, recordedBy: afterSalesResponsibilityEvidence.recordedBy,
        recordedAt: afterSalesResponsibilityEvidence.recordedAt,
      }).from(afterSalesResponsibilityEvidence).where(eq(afterSalesResponsibilityEvidence.caseId, caseId)).orderBy(asc(afterSalesResponsibilityEvidence.recordedAt));
      return { case: record, contacts, decisions, returnShipments: returns, returnTrackingEvents: returnEvents, replacements, responsibilityEvidence };
    });
  }
}

function validateRefund(order: { total: number; currency: string }, input: DecideAfterSalesCaseInput) {
  if (input.refundAmountMinor === null) return;
  if (input.refundCurrency !== order.currency) throw new UnprocessableEntityException("Refund currency must match order currency");
  if (input.refundAmountMinor <= 0 || input.refundAmountMinor > order.total) throw new UnprocessableEntityException("Refund amount must be positive and cannot exceed order total");
  if (input.resolution === "full_refund" && input.refundAmountMinor !== order.total) throw new UnprocessableEntityException("Full refund must equal order total");
  if (input.resolution === "partial_refund" && input.refundAmountMinor >= order.total) throw new UnprocessableEntityException("Partial refund must be less than order total");
}

function nextReturnStatus(current: string, event: RecordReturnTrackingEventInput["status"]) {
  const allowed: Record<string, ReadonlySet<string>> = {
    label_created: new Set(["label_created", "in_transit", "cancelled"]),
    in_transit: new Set(["in_transit", "delivered", "lost"]),
    lost: new Set(["in_transit", "delivered", "cancelled"]),
  };
  if (!allowed[current]?.has(event)) throw new ConflictException(`Return tracking status ${event} is invalid from ${current}`);
  return event;
}

function createsReplacementCycle(links: Array<{ sourceOrderId: string; replacementOrderId: string }>, sourceOrderId: string, replacementOrderId: string) {
  const next = new Map<string, string[]>();
  for (const link of [...links, { sourceOrderId, replacementOrderId }]) next.set(link.sourceOrderId, [...(next.get(link.sourceOrderId) ?? []), link.replacementOrderId]);
  const pending = [replacementOrderId]; const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === sourceOrderId) return true;
    if (visited.has(current)) continue;
    visited.add(current); pending.push(...(next.get(current) ?? []));
  }
  return false;
}

async function assertAuthorizedAsset(tx: TenantTransaction, assetId: string | null) {
  if (!assetId) return;
  const [asset] = await tx.select({ id: assetFiles.id }).from(assetFiles).where(and(
    eq(assetFiles.id, assetId), eq(assetFiles.assetDomain, "authorized"), eq(assetFiles.rightsStatus, "approved"), sql`${assetFiles.deletedAt} is null`,
  )).limit(1);
  if (!asset) throw new UnprocessableEntityException("After-sales evidence must use an authorized asset with approved rights");
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }
