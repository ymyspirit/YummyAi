import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  CreateProductionBatchInputSchema, CreateProductionOrderInputSchema, CreateProductionRecoveryInputSchema, CreateQualityStandardInputSchema,
  RecordProductionBatchEventInputSchema, RecordProductionMilestoneInputSchema, RecordProductionRecoveryEventInputSchema,
  RecordQualityInspectionInputSchema, createEntityId,
  type CreateProductionBatchInput, type CreateProductionOrderInput, type CreateProductionRecoveryInput, type CreateQualityStandardInput,
  type RecordProductionBatchEventInput, type RecordProductionMilestoneInput, type RecordProductionRecoveryEventInput,
  type RecordQualityInspectionInput, type TenantContext,
} from "@yummyai/contracts";
import {
  assetFiles, designVersions, orderLineCatalogLinks, orderLines, orderRoutingDecisions, orders,
  productionBatchEvents, productionBatchMembers, productionBatches, productionMilestoneEvents,
  productionOrderVersions, productionOrders, productionRecoveryCases, productionRecoveryEvents,
  purchaseOrders, purchaseOrderVersions, qualityDefects, qualityInspections, qualityStandardVersions,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";

@Injectable()
export class OrderProductionService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(context: TenantContext, orderId: string, rawInput: CreateProductionOrderInput) {
    const input = CreateProductionOrderInputSchema.parse(rawInput);
    const productionOrderId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-line:${input.orderLineId}`);
      const [replayed] = await tx.select({ id: productionOrders.id }).from(productionOrders).where(and(
        eq(productionOrders.orderLineId, input.orderLineId), eq(productionOrders.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [record] = await tx.select({ order: orders, line: orderLines }).from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId)).where(and(eq(orderLines.id, input.orderLineId), eq(orderLines.orderId, orderId))).limit(1);
      if (!record) throw new NotFoundException("Order line not found");
      if (record.order.workflowState !== "in_production") throw new ConflictException("Order must be in production before creating production work");
      const [decision] = await tx.select().from(orderRoutingDecisions).where(and(eq(orderRoutingDecisions.id, input.routingDecisionId), eq(orderRoutingDecisions.orderLineId, input.orderLineId))).limit(1);
      if (!decision || decision.status !== "approved" || !decision.selectedSupplierId) throw new ConflictException("An approved routing decision is required");
      const [purchaseVersion] = await tx.select({ version: purchaseOrderVersions, purchase: purchaseOrders }).from(purchaseOrderVersions)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderVersions.purchaseOrderId))
        .where(eq(purchaseOrderVersions.id, input.purchaseOrderVersionId)).limit(1);
      if (!purchaseVersion || purchaseVersion.purchase.status !== "approved" || purchaseVersion.purchase.currentVersionNumber !== purchaseVersion.version.versionNumber ||
        !purchaseVersion.version.routingDecisionIds.includes(decision.id) || !purchaseVersion.version.lineSnapshot.some((line) => line.orderLineId === input.orderLineId)) {
        throw new ConflictException("The current approved purchase-order version does not pin this routing decision and line");
      }
      if (input.designVersionId) {
        const [design] = await tx.select({ status: designVersions.status }).from(designVersions).where(eq(designVersions.id, input.designVersionId)).limit(1);
        if (design?.status !== "approved") throw new ConflictException("Production must pin an approved design version");
      }
      await assertAuthorizedAssets(tx, input.productionAssetIds);
      const id = createEntityId();
      const expectedCompletionAt = new Date(input.expectedCompletionAt);
      await tx.insert(productionOrders).values({
        id, tenantId: context.tenantId, orderId, orderLineId: input.orderLineId, supplierId: decision.selectedSupplierId,
        routingDecisionId: decision.id, purchaseOrderVersionId: purchaseVersion.version.id, source: "initial", status: "planned",
        expectedCompletionAt, idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
      await tx.insert(productionOrderVersions).values({
        id: createEntityId(), tenantId: context.tenantId, productionOrderId: id, versionNumber: 1,
        quantity: record.line.quantity, designVersionId: input.designVersionId, productionAssetIds: input.productionAssetIds,
        encryptedInstructions: this.vault.encrypt(input.instructions), instructionsChecksum: checksum(input.instructions),
        expectedCompletionAt, createdBy: context.userId,
      });
      return id;
    });
    await this.audit.record(context, { action: "production_order.create", resourceType: "production_order", resourceId: productionOrderId, result: "success", metadata: { orderId } });
    return this.get(context, productionOrderId);
  }

  async recordMilestone(context: TenantContext, productionOrderId: string, rawInput: RecordProductionMilestoneInput) {
    const input = RecordProductionMilestoneInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-order:${productionOrderId}`);
      const [record] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!record) throw new NotFoundException("Production order not found");
      if (input.externalEventId) {
        const [replayed] = await tx.select({ id: productionMilestoneEvents.id }).from(productionMilestoneEvents).where(and(
          eq(productionMilestoneEvents.productionOrderId, productionOrderId), eq(productionMilestoneEvents.externalEventId, input.externalEventId),
        )).limit(1);
        if (replayed) return;
      }
      if (record.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Production projection version changed");
      const nextStatus = nextProductionStatus(record.status, input.type);
      await assertAuthorizedAssets(tx, input.evidence.assetIds);
      const [latest] = await tx.select({ sequence: productionMilestoneEvents.sequence }).from(productionMilestoneEvents)
        .where(eq(productionMilestoneEvents.productionOrderId, productionOrderId)).orderBy(desc(productionMilestoneEvents.sequence)).limit(1);
      await tx.insert(productionMilestoneEvents).values({
        id: createEntityId(), tenantId: context.tenantId, productionOrderId, sequence: (latest?.sequence ?? 0) + 1,
        type: input.type, externalEventId: input.externalEventId, evidenceCode: input.evidence.code,
        encryptedEvidenceNote: input.evidence.note ? this.vault.encrypt(input.evidence.note) : null,
        evidenceAssetIds: input.evidence.assetIds, actorUserId: context.userId, occurredAt: new Date(input.occurredAt),
      });
      await tx.update(productionOrders).set({ status: nextStatus, projectionVersion: record.projectionVersion + 1, updatedAt: new Date() })
        .where(and(eq(productionOrders.id, productionOrderId), eq(productionOrders.projectionVersion, input.expectedProjectionVersion)));
    });
    await this.audit.record(context, { action: "production_order.milestone", resourceType: "production_order", resourceId: productionOrderId, result: "success", metadata: { type: input.type } });
    return this.get(context, productionOrderId);
  }

  async createBatch(context: TenantContext, rawInput: CreateProductionBatchInput) {
    const input = CreateProductionBatchInputSchema.parse(rawInput);
    const batchId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-batch-create:${input.supplierId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select({ id: productionBatches.id }).from(productionBatches).where(and(
        eq(productionBatches.supplierId, input.supplierId), eq(productionBatches.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const members = await tx.select().from(productionOrders).where(inArray(productionOrders.id, input.productionOrderIds));
      if (members.length !== input.productionOrderIds.length) throw new NotFoundException("One or more production orders were not found");
      if (members.some((member) => member.supplierId !== input.supplierId)) throw new UnprocessableEntityException("A production batch can contain only one supplier");
      if (members.some((member) => member.status !== "planned")) throw new ConflictException("Only planned production orders can enter a new batch");
      const existingMembers = await tx.select({ productionOrderId: productionBatchMembers.productionOrderId }).from(productionBatchMembers)
        .where(inArray(productionBatchMembers.productionOrderId, input.productionOrderIds));
      if (existingMembers.length) throw new ConflictException("A production order already belongs to a batch");
      const id = createEntityId();
      await tx.insert(productionBatches).values({
        id, tenantId: context.tenantId, supplierId: input.supplierId, expectedCompletionAt: new Date(input.expectedCompletionAt),
        idempotencyKey: input.idempotencyKey, createdBy: context.userId,
      });
      await tx.insert(productionBatchMembers).values(input.productionOrderIds.map((productionOrderId) => ({
        id: createEntityId(), tenantId: context.tenantId, batchId: id, productionOrderId, addedBy: context.userId,
      })));
      return id;
    });
    await this.audit.record(context, { action: "production_batch.create", resourceType: "production_batch", resourceId: batchId, result: "success", metadata: { supplierId: input.supplierId, memberCount: input.productionOrderIds.length } });
    return this.getBatch(context, batchId);
  }

  async recordBatchEvent(context: TenantContext, batchId: string, rawInput: RecordProductionBatchEventInput) {
    const input = RecordProductionBatchEventInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-batch:${batchId}`);
      const [batch] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Production batch not found");
      if (input.externalEventId) {
        const [replayed] = await tx.select({ id: productionBatchEvents.id }).from(productionBatchEvents).where(and(
          eq(productionBatchEvents.batchId, batchId), eq(productionBatchEvents.externalEventId, input.externalEventId),
        )).limit(1);
        if (replayed) return;
      }
      if (batch.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Production batch version changed");
      const nextStatus = nextBatchStatus(batch.status, input.type);
      if (input.type === "completed") {
        const memberIds = (await tx.select({ id: productionBatchMembers.productionOrderId }).from(productionBatchMembers).where(eq(productionBatchMembers.batchId, batchId))).map((member) => member.id);
        const members = await tx.select({ status: productionOrders.status }).from(productionOrders).where(inArray(productionOrders.id, memberIds));
        if (!members.length || members.some((member) => member.status !== "completed")) throw new ConflictException("A batch cannot complete before every production order completes");
      }
      const [latest] = await tx.select({ sequence: productionBatchEvents.sequence }).from(productionBatchEvents)
        .where(eq(productionBatchEvents.batchId, batchId)).orderBy(desc(productionBatchEvents.sequence)).limit(1);
      await tx.insert(productionBatchEvents).values({
        id: createEntityId(), tenantId: context.tenantId, batchId, sequence: (latest?.sequence ?? 0) + 1,
        type: input.type, externalEventId: input.externalEventId, evidenceCode: input.evidenceCode,
        encryptedNote: input.note ? this.vault.encrypt(input.note) : null, actorUserId: context.userId,
        occurredAt: new Date(input.occurredAt),
      });
      await tx.update(productionBatches).set({ status: nextStatus, projectionVersion: batch.projectionVersion + 1, updatedAt: new Date() })
        .where(and(eq(productionBatches.id, batchId), eq(productionBatches.projectionVersion, input.expectedProjectionVersion)));
    });
    await this.audit.record(context, { action: "production_batch.event", resourceType: "production_batch", resourceId: batchId, result: "success", metadata: { type: input.type } });
    return this.getBatch(context, batchId);
  }

  async createQualityStandard(context: TenantContext, rawInput: CreateQualityStandardInput) {
    const input = CreateQualityStandardInputSchema.parse(rawInput);
    const row = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `quality-standard:${input.name}`);
      const [latest] = await tx.select({ version: qualityStandardVersions.versionNumber }).from(qualityStandardVersions)
        .where(eq(qualityStandardVersions.name, input.name)).orderBy(desc(qualityStandardVersions.versionNumber)).limit(1);
      const [created] = await tx.insert(qualityStandardVersions).values({
        id: createEntityId(), tenantId: context.tenantId, ...input, versionNumber: (latest?.version ?? 0) + 1, createdBy: context.userId,
      }).returning();
      return created!;
    });
    return row;
  }

  async inspect(context: TenantContext, productionOrderId: string, rawInput: RecordQualityInspectionInput) {
    const input = RecordQualityInspectionInputSchema.parse(rawInput);
    let orderId = "";
    let inspectionId = "";
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-inspection:${productionOrderId}`);
      const [replayed] = await tx.select({ id: qualityInspections.id }).from(qualityInspections).where(and(
        eq(qualityInspections.productionOrderId, productionOrderId), eq(qualityInspections.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) { inspectionId = replayed.id; return; }
      const [production] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!production) throw new NotFoundException("Production order not found");
      orderId = production.orderId;
      if (production.status !== "completed" && production.status !== "quality_hold") throw new ConflictException("Production must be completed before inspection");
      const [standard] = await tx.select().from(qualityStandardVersions).where(eq(qualityStandardVersions.id, input.qualityStandardVersionId)).limit(1);
      if (!standard) throw new NotFoundException("Quality standard version not found");
      const [catalog] = await tx.select({ skuId: orderLineCatalogLinks.skuId }).from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, production.orderLineId)).limit(1);
      if ((standard.supplierId && standard.supplierId !== production.supplierId) || (standard.skuId && standard.skuId !== catalog?.skuId)) throw new UnprocessableEntityException("Quality standard scope does not match production work");
      if ((input.result === "passed") !== (input.scoreBps >= standard.minimumScoreBps)) throw new UnprocessableEntityException("Inspection result does not match the pinned minimum score");
      await assertAuthorizedAssets(tx, [...input.evidenceAssetIds, ...input.defects.flatMap((defect) => defect.evidenceAssetIds)]);
      inspectionId = createEntityId();
      await tx.insert(qualityInspections).values({
        id: inspectionId, tenantId: context.tenantId, productionOrderId, qualityStandardVersionId: standard.id,
        result: input.result, scoreBps: input.scoreBps, evidenceAssetIds: input.evidenceAssetIds,
        idempotencyKey: input.idempotencyKey, inspectedBy: context.userId, inspectedAt: new Date(input.inspectedAt),
      });
      if (input.defects.length) await tx.insert(qualityDefects).values(input.defects.map((defect) => ({
        id: createEntityId(), tenantId: context.tenantId, productionOrderId, inspectionId, code: defect.code,
        severity: defect.severity, responsibility: defect.responsibility, disposition: defect.disposition,
        encryptedDetail: this.vault.encrypt(defect.note), detailChecksum: checksum(defect.note), evidenceAssetIds: defect.evidenceAssetIds,
      })));
      await tx.update(productionOrders).set({
        status: input.result === "passed" ? "completed" : "quality_hold",
        projectionVersion: production.projectionVersion + 1, updatedAt: new Date(),
      }).where(eq(productionOrders.id, productionOrderId));
    });
    if (input.result === "failed" && orderId) await this.orderService.openException(context, orderId, {
      category: "quality", code: "QUALITY_INSPECTION_FAILED", message: "A production order failed its pinned quality standard.",
      idempotencyKey: `quality-failed:${inspectionId}`,
    });
    await this.audit.record(context, { action: "production_order.inspect", resourceType: "quality_inspection", resourceId: inspectionId, result: "success", metadata: { productionOrderId, result: input.result } });
    return this.get(context, productionOrderId);
  }

  async recover(context: TenantContext, rawInput: CreateProductionRecoveryInput) {
    const input = CreateProductionRecoveryInputSchema.parse(rawInput);
    let replacementId: string | null = null;
    const recoveryId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-recovery:${input.originalProductionOrderId}`);
      const [replayed] = await tx.select({ id: productionRecoveryCases.id }).from(productionRecoveryCases).where(and(
        eq(productionRecoveryCases.originalProductionOrderId, input.originalProductionOrderId), eq(productionRecoveryCases.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) return replayed.id;
      const [original] = await tx.select().from(productionOrders).where(eq(productionOrders.id, input.originalProductionOrderId)).limit(1);
      if (!original) throw new NotFoundException("Original production order not found");
      if (input.defectId) {
        const [defect] = await tx.select({ id: qualityDefects.id }).from(qualityDefects).where(and(eq(qualityDefects.id, input.defectId), eq(qualityDefects.productionOrderId, original.id))).limit(1);
        if (!defect) throw new NotFoundException("Quality defect not found for the original production order");
      }
      const id = createEntityId();
      await tx.insert(productionRecoveryCases).values({
        id, tenantId: context.tenantId, orderId: original.orderId, originalProductionOrderId: original.id,
        defectId: input.defectId, type: input.type, status: input.type === "remake" ? "in_progress" : "open",
        encryptedReason: this.vault.encrypt(input.reason), reasonChecksum: checksum(input.reason),
        compensationAmountMinor: input.compensationAmountMinor, compensationCurrency: input.compensationCurrency,
        expectedCompletionAt: input.expectedCompletionAt ? new Date(input.expectedCompletionAt) : null,
        idempotencyKey: input.idempotencyKey, openedBy: context.userId,
      });
      if (input.type === "remake") {
        const [version] = await tx.select().from(productionOrderVersions).where(and(
          eq(productionOrderVersions.productionOrderId, original.id), eq(productionOrderVersions.versionNumber, original.currentVersionNumber),
        )).limit(1);
        if (!version) throw new ConflictException("Original production version is missing");
        replacementId = createEntityId();
        const expectedCompletionAt = new Date(input.expectedCompletionAt!);
        await tx.insert(productionOrders).values({
          id: replacementId, tenantId: context.tenantId, orderId: original.orderId, orderLineId: original.orderLineId,
          supplierId: original.supplierId, routingDecisionId: original.routingDecisionId,
          purchaseOrderVersionId: original.purchaseOrderVersionId, parentProductionOrderId: original.id,
          source: "remake", status: "planned", expectedCompletionAt,
          idempotencyKey: `remake:${id}`, createdBy: context.userId,
        });
        await tx.insert(productionOrderVersions).values({
          id: createEntityId(), tenantId: context.tenantId, productionOrderId: replacementId, versionNumber: 1,
          quantity: version.quantity, designVersionId: version.designVersionId, productionAssetIds: version.productionAssetIds,
          encryptedInstructions: version.encryptedInstructions, instructionsChecksum: version.instructionsChecksum,
          expectedCompletionAt, createdBy: context.userId,
        });
      }
      return id;
    });
    await this.audit.record(context, { action: "production_order.recovery", resourceType: "production_recovery_case", resourceId: recoveryId, result: "success", metadata: { type: input.type, replacementId } });
    return { recoveryId, replacementProductionOrderId: replacementId };
  }

  async recordRecoveryEvent(context: TenantContext, recoveryCaseId: string, rawInput: RecordProductionRecoveryEventInput) {
    const input = RecordProductionRecoveryEventInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `production-recovery-case:${recoveryCaseId}`);
      const [recovery] = await tx.select().from(productionRecoveryCases).where(eq(productionRecoveryCases.id, recoveryCaseId)).limit(1);
      if (!recovery) throw new NotFoundException("Production recovery case not found");
      if (recovery.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Production recovery version changed");
      const toStatus = nextRecoveryStatus(recovery.status, input.action);
      if (input.action === "resolve") {
        if ((recovery.type === "reship" || recovery.type === "cancellation_compensation") && !input.externalReference) {
          throw new ConflictException("Resolving reship or compensation requires an external evidence reference");
        }
        if (recovery.type === "remake") {
          const [replacement] = await tx.select().from(productionOrders).where(and(
            eq(productionOrders.parentProductionOrderId, recovery.originalProductionOrderId), eq(productionOrders.source, "remake"),
          )).orderBy(desc(productionOrders.createdAt)).limit(1);
          if (!replacement || replacement.status !== "completed") throw new ConflictException("A remake cannot resolve before replacement production completes");
          const [inspection] = await tx.select({ result: qualityInspections.result }).from(qualityInspections)
            .where(eq(qualityInspections.productionOrderId, replacement.id)).orderBy(desc(qualityInspections.inspectedAt)).limit(1);
          if (inspection?.result !== "passed") throw new ConflictException("A remake cannot resolve before replacement quality inspection passes");
        }
      }
      const [latest] = await tx.select({ sequence: productionRecoveryEvents.sequence }).from(productionRecoveryEvents)
        .where(eq(productionRecoveryEvents.recoveryCaseId, recoveryCaseId)).orderBy(desc(productionRecoveryEvents.sequence)).limit(1);
      await tx.insert(productionRecoveryEvents).values({
        id: createEntityId(), tenantId: context.tenantId, recoveryCaseId, sequence: (latest?.sequence ?? 0) + 1,
        action: input.action, fromStatus: recovery.status, toStatus, outcomeCode: input.outcomeCode,
        encryptedNote: input.note ? this.vault.encrypt(input.note) : null, externalReference: input.externalReference,
        actorUserId: context.userId, occurredAt: new Date(input.occurredAt),
      });
      await tx.update(productionRecoveryCases).set({ status: toStatus, projectionVersion: recovery.projectionVersion + 1, updatedAt: new Date() })
        .where(and(eq(productionRecoveryCases.id, recoveryCaseId), eq(productionRecoveryCases.projectionVersion, input.expectedProjectionVersion)));
    });
    await this.audit.record(context, { action: "production_recovery.event", resourceType: "production_recovery_case", resourceId: recoveryCaseId, result: "success", metadata: { action: input.action, outcomeCode: input.outcomeCode } });
    return this.getRecovery(context, recoveryCaseId);
  }

  async get(context: TenantContext, productionOrderId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [productionOrder] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!productionOrder) throw new NotFoundException("Production order not found");
      const versions = await tx.select({
        id: productionOrderVersions.id, versionNumber: productionOrderVersions.versionNumber,
        quantity: productionOrderVersions.quantity, designVersionId: productionOrderVersions.designVersionId,
        productionAssetIds: productionOrderVersions.productionAssetIds, instructionsChecksum: productionOrderVersions.instructionsChecksum,
        expectedCompletionAt: productionOrderVersions.expectedCompletionAt, createdAt: productionOrderVersions.createdAt,
      }).from(productionOrderVersions).where(eq(productionOrderVersions.productionOrderId, productionOrderId)).orderBy(asc(productionOrderVersions.versionNumber));
      const milestones = await tx.select({
        id: productionMilestoneEvents.id, sequence: productionMilestoneEvents.sequence, type: productionMilestoneEvents.type,
        externalEventId: productionMilestoneEvents.externalEventId, evidenceCode: productionMilestoneEvents.evidenceCode,
        evidenceAssetIds: productionMilestoneEvents.evidenceAssetIds, actorUserId: productionMilestoneEvents.actorUserId,
        occurredAt: productionMilestoneEvents.occurredAt,
      }).from(productionMilestoneEvents).where(eq(productionMilestoneEvents.productionOrderId, productionOrderId)).orderBy(asc(productionMilestoneEvents.sequence));
      const inspections = await tx.select().from(qualityInspections).where(eq(qualityInspections.productionOrderId, productionOrderId)).orderBy(desc(qualityInspections.inspectedAt));
      const defects = await tx.select({
        id: qualityDefects.id, inspectionId: qualityDefects.inspectionId, code: qualityDefects.code,
        severity: qualityDefects.severity, responsibility: qualityDefects.responsibility,
        disposition: qualityDefects.disposition, detailChecksum: qualityDefects.detailChecksum,
        evidenceAssetIds: qualityDefects.evidenceAssetIds, createdAt: qualityDefects.createdAt,
      }).from(qualityDefects).where(eq(qualityDefects.productionOrderId, productionOrderId));
      return { productionOrder, versions, milestones, inspections, defects };
    });
  }

  list(context: TenantContext, orderId?: string) {
    return withTenant(this.database.db, context, (tx) => tx.select().from(productionOrders)
      .where(orderId ? eq(productionOrders.orderId, orderId) : undefined)
      .orderBy(asc(productionOrders.expectedCompletionAt)));
  }

  async getBatch(context: TenantContext, batchId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batchId)).limit(1);
      if (!batch) throw new NotFoundException("Production batch not found");
      const members = await tx.select().from(productionBatchMembers).where(eq(productionBatchMembers.batchId, batchId)).orderBy(asc(productionBatchMembers.addedAt));
      const events = await tx.select({
        id: productionBatchEvents.id, sequence: productionBatchEvents.sequence, type: productionBatchEvents.type,
        externalEventId: productionBatchEvents.externalEventId, evidenceCode: productionBatchEvents.evidenceCode,
        actorUserId: productionBatchEvents.actorUserId, occurredAt: productionBatchEvents.occurredAt,
      }).from(productionBatchEvents).where(eq(productionBatchEvents.batchId, batchId)).orderBy(asc(productionBatchEvents.sequence));
      return { batch, members, events };
    });
  }

  async getRecovery(context: TenantContext, recoveryCaseId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [recovery] = await tx.select({
        id: productionRecoveryCases.id, orderId: productionRecoveryCases.orderId,
        originalProductionOrderId: productionRecoveryCases.originalProductionOrderId,
        defectId: productionRecoveryCases.defectId, type: productionRecoveryCases.type, status: productionRecoveryCases.status,
        projectionVersion: productionRecoveryCases.projectionVersion, reasonChecksum: productionRecoveryCases.reasonChecksum,
        compensationAmountMinor: productionRecoveryCases.compensationAmountMinor,
        compensationCurrency: productionRecoveryCases.compensationCurrency,
        expectedCompletionAt: productionRecoveryCases.expectedCompletionAt, openedAt: productionRecoveryCases.openedAt,
      }).from(productionRecoveryCases).where(eq(productionRecoveryCases.id, recoveryCaseId)).limit(1);
      if (!recovery) throw new NotFoundException("Production recovery case not found");
      const events = await tx.select({
        id: productionRecoveryEvents.id, sequence: productionRecoveryEvents.sequence, action: productionRecoveryEvents.action,
        fromStatus: productionRecoveryEvents.fromStatus, toStatus: productionRecoveryEvents.toStatus,
        outcomeCode: productionRecoveryEvents.outcomeCode, externalReference: productionRecoveryEvents.externalReference,
        actorUserId: productionRecoveryEvents.actorUserId, occurredAt: productionRecoveryEvents.occurredAt,
      }).from(productionRecoveryEvents).where(eq(productionRecoveryEvents.recoveryCaseId, recoveryCaseId)).orderBy(asc(productionRecoveryEvents.sequence));
      return { recovery, events };
    });
  }
}

async function assertAuthorizedAssets(tx: TenantTransaction, assetIds: string[]) {
  const unique = [...new Set(assetIds)];
  if (!unique.length) return;
  const assets = await tx.select({ id: assetFiles.id, domain: assetFiles.assetDomain, rights: assetFiles.rightsStatus })
    .from(assetFiles).where(inArray(assetFiles.id, unique));
  if (assets.length !== unique.length || assets.some((asset) => asset.domain !== "authorized" || asset.rights !== "approved")) {
    throw new ConflictException("Production evidence must use tenant-owned authorized assets with approved rights");
  }
}

function nextProductionStatus(current: string, milestone: RecordProductionMilestoneInput["type"]) {
  const allowed: Record<string, Partial<Record<RecordProductionMilestoneInput["type"], string>>> = {
    planned: { submitted: "submitted", cancel_requested: "cancel_requested" },
    submitted: { acknowledged: "acknowledged", failed: "failed", cancel_requested: "cancel_requested" },
    acknowledged: { started: "in_production", failed: "failed", cancel_requested: "cancel_requested" },
    in_production: { completed: "completed", failed: "failed", cancel_requested: "cancel_requested" },
    quality_hold: { cancel_requested: "cancel_requested" },
    cancel_requested: { cancelled: "cancelled", failed: "failed" },
  };
  const next = allowed[current]?.[milestone];
  if (!next) throw new ConflictException(`Production milestone ${milestone} is invalid from ${current}`);
  return next;
}

function nextBatchStatus(current: string, event: RecordProductionBatchEventInput["type"]) {
  const allowed: Record<string, Partial<Record<RecordProductionBatchEventInput["type"], string>>> = {
    planned: { released: "released", cancel_requested: "cancel_requested" },
    released: { started: "in_progress", failed: "failed", cancel_requested: "cancel_requested" },
    in_progress: { completed: "completed", failed: "failed", cancel_requested: "cancel_requested" },
    cancel_requested: { cancelled: "cancelled", failed: "failed" },
  };
  const next = allowed[current]?.[event];
  if (!next) throw new ConflictException(`Production batch event ${event} is invalid from ${current}`);
  return next;
}

function nextRecoveryStatus(current: string, action: RecordProductionRecoveryEventInput["action"]) {
  const allowed: Record<string, Partial<Record<RecordProductionRecoveryEventInput["action"], string>>> = {
    open: { start: "in_progress", resolve: "resolved", cancel: "cancelled" },
    in_progress: { resolve: "resolved", cancel: "cancelled" },
  };
  const next = allowed[current]?.[action];
  if (!next) throw new ConflictException(`Recovery action ${action} is invalid from ${current}`);
  return next;
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }
