import { ProductionReadOwner } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { evaluateQualityAssessment } from "@yummyai/contracts/order/quality-assessment";
import { currentOrderAuthority, withOrderAuthority, productionReadyQuantity, productionRemainingQuantity } from "@yummyai/order-core";

import { readShipmentProductionSources } from "./shipment-production-sources.js";
import { assertInspectionReplay, assertQualityEvidenceAssets, assertQualityOrderActive, inspectionRequestChecksum } from "./quality-inspection-evidence.js";
import { RecordQualityGroupsInputSchema } from "@yummyai/contracts/order/quality-groups";
import { assertRootQualityGroupingMutable, currentRootQualityInspection, readQualityGroupTree, recordQualityGroupInspection } from "./quality-groups.js";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, Inject, Injectable, NotFoundException, Optional, UnprocessableEntityException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission, permissionScope } from "@yummyai/authz";
import { requireFactoryTask } from "./factory-access.js";
import { ReleaseOrderArtworkInputSchema, OrderWorkDraftSchema, OrderLineProductionAvailabilitySchema } from "@yummyai/contracts/order/workspace";
import { ReleaseWholeOrderInputSchema, RecordWholeOrderProductionInputSchema, InspectWholeOrderInputSchema, WholeOrderFulfillmentViewSchema, type WholeOrderFulfillmentView, type WholeOrderLinePin } from "@yummyai/contracts/order/whole-fulfillment";
import { CreateProductionBatchInputSchema, CreateProductionOrderInputSchema, CreateProductionRecoveryInputSchema, CreateQualityStandardInputSchema, RecordProductionBatchEventInputSchema, RecordProductionMilestoneInputSchema, RecordProductionRecoveryEventInputSchema, RecordQualityInspectionInputSchema, ProductionOrderStatusSchema, createEntityId, type CreateProductionBatchInput, type CreateQualityStandardInput, type CreateProductionRecoveryInput, type RecordProductionBatchEventInput, type RecordProductionMilestoneInput, type RecordProductionRecoveryEventInput, type RecordQualityInspectionInput, type TenantContext } from "@yummyai/contracts";
import { assetFiles, designVersions, orderLineCatalogLinks, orderLines, orderRoutingDecisions, orders, productionBatchEvents, productionBatchMembers, productionBatches, productionMilestoneEvents, productionOrderVersions, productionOrders, productionRecoveryCases, productionRecoveryEvents, purchaseOrders, purchaseOrderVersions, qualityDefects, qualityInspections, qualityStandardVersions, productionRecoveryGroups, fulfillmentSuppliers, orderWorkItems, productionEditorProjects, orderWorkEvents, productionDeliveryItems, productionDeliveryFeedback, productionEditorRenders, orderWorkRevisions, amazonOrderReportLines, shipments, type DatabaseConnection, type TenantTransaction, withTenant } from "@yummyai/database";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { FactoryDirectoryService, type FactoryRequirement } from "../suppliers/factory-directory.service.js";
import { recordFactoryCapacityMilestoneInTransaction, reserveFactoryCapacityInTransaction } from "../suppliers/factory-capacity.service.js";
import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { orderWorkRevisions as workRevisions, skus as factorySkus, spus as factorySpus } from "@yummyai/database";
import { encryptProductionBytes, decryptProductionBytes } from "@yummyai/production-editor";
import { assertWholeOrderActive, assertWholeOrderPins, lockOrderProductionHeader, lockWholeOrder, lockWholeOrderProduction, wholeOrderBlockers } from "./whole-order-fulfillment.js";
import { sealProductionManufacturing, orderProductionManufacturingOptions, orderProductionFactorySource } from "./production-manufacturing.js";
import { lockManufacturingProductionVersions } from "../catalog/manufacturing-production.js";
import { workProjection, parseWorkLine } from "./order-workspace-query.js";
import { initialProductionAllocatedQuantity } from "./initial-production-quantity.js";
import { assertProductionCommandFence, productionCommandDescriptor, type ProductionCommandFence } from "./production-command-fence.js";
import { assertOrderFulfillmentCommandFence, type OrderFulfillmentCommandFence } from "./order-fulfillment-command-fence.js";

type ReleaseInput = ReturnType<typeof ReleaseOrderArtworkInputSchema.parse>;
type PreparedArtwork = { render: Awaited<ReturnType<ProductionEditorService["getRender"]>>; document: ProductionEditorDocument; revisionId: string | null; operatorInstructions: string };

@Injectable()
export class OrderProductionService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(ProductionEditorService) private readonly editor?: ProductionEditorService,
    @Optional() @Inject(FactoryDirectoryService) private readonly factories?: FactoryDirectoryService,
  ) {}

  async releaseArtwork(context: TenantContext, orderLineId: string, raw: unknown) {
    const receipt = await this.releaseArtworkReceipt(context, orderLineId, raw);
    return this.get(context, receipt.productionOrderIds[0]!);
  }

  /** The receipt resolves at transaction commit, before any optional DTO read. */
  async releaseArtworkReceipt(context: TenantContext, orderLineId: string, raw: unknown, fence?: ProductionCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = ReleaseOrderArtworkInputSchema.parse(raw);
    const replayed = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead],
      tx => this.releaseReplay(tx, context, orderLineId, input));
    if (replayed) return { productionOrderIds: [replayed] };
    const prepared = await this.prepareArtwork(context, orderLineId, input.renderId);
    const id = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead],
      tx => this.releaseInTransaction(tx, context, orderLineId, input, prepared, null, input.idempotencyKey, fence));
    return { productionOrderIds: [id] };
  }

  manufacturingOptions(context: TenantContext, lineId: string, query: { originalProductionOrderId?: string; nativeSpecificationVersionId?: string; after?: string }) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead],
      tx => orderProductionManufacturingOptions(tx, context, this.vault, lineId, query));
  }

  productionAvailability(context: TenantContext, lineId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead], async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
      const [source] = await tx.select({ work: orderWorkItems, line: orderLines }).from(orderWorkItems)
        .innerJoin(orderLines, eq(orderLines.id, orderWorkItems.id)).where(eq(orderWorkItems.id, lineId));
      if (!source || source.work.archivedAt || source.work.expiresAt <= new Date()) throw new NotFoundException("订单商品不存在或制作资料已失效");
      const allocatedQuantity = await initialProductionAllocatedQuantity(tx, lineId);
      return OrderLineProductionAvailabilitySchema.parse({ lineId, orderedQuantity: source.line.quantity, allocatedQuantity,
        availableQuantity: Math.max(0, source.line.quantity - allocatedQuantity), canRelease: current.permissions.includes(Permission.OrderWrite) && permissionScope(current, Permission.OrderWrite) === "tenant",
        revision: source.work.revision, projectionVersion: source.work.projectionVersion });
    });
  }

  private async releaseReplay(tx: TenantTransaction, context: TenantContext, orderLineId: string, input: ReleaseInput, eventIdempotencyKey = input.idempotencyKey) {
    const [old] = await tx.select().from(productionOrders).where(and(eq(productionOrders.orderLineId, orderLineId), eq(productionOrders.idempotencyKey, input.idempotencyKey)));
    if (!old) return null;
    const [event] = await tx.select().from(orderWorkEvents).where(and(eq(orderWorkEvents.workItemId, orderLineId), eq(orderWorkEvents.idempotencyKey, eventIdempotencyKey)));
    if (old.createdBy !== context.userId || !event || event.requestHash !== checksum(JSON.stringify(input)))
      throw new ConflictException("同一次下达生产的重试内容或操作员不能改变");
    return old.id;
  }

  private async prepareArtwork(context: TenantContext, orderLineId: string, renderId: string): Promise<PreparedArtwork> {
    const [work] = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead],
      tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, orderLineId)));
    if (!work) throw new NotFoundException("商品不存在或无权访问");
    if (!this.editor || !work?.editorProjectId || !work.encryptedDataKey || work.expiresAt <= new Date()) throw new ConflictException("生产文件或订单资料不可用");
    const render = await this.editor.getRender(context, work.editorProjectId, renderId);
    const document = (await this.editor.get(context, work.editorProjectId, render.versionId)).version.document;
    if (render.purpose !== "production" || render.status !== "completed" || !render.files.length || !render.preflight?.productionReady || render.versionId !== work.approvedEditorVersionId) throw new ConflictException("请选择已审核版本生成的正式生产文件");
    const [revision] = work.pushedRevisionId ? await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead],
      tx => tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.id, work.pushedRevisionId!))) : [];
    const operatorInstructions = revision ? this.vault.withSecret(work.encryptedDataKey, secret => {
      const key = Buffer.from(secret, "base64");
      try { return OrderWorkDraftSchema.parse(JSON.parse(Buffer.from(decryptProductionBytes(key, Buffer.from(revision.encryptedDraft, "base64"))).toString("utf8"))).instructions; }
      finally { key.fill(0); }
    }) : "";
    return { render, document, revisionId: work.pushedRevisionId, operatorInstructions };
  }

  private async releaseInTransaction(tx: TenantTransaction, context: TenantContext, orderLineId: string, input: ReleaseInput, { render, document, revisionId }: PreparedArtwork, requestChecksum: string | null = null, eventIdempotencyKey = input.idempotencyKey, fence?: ProductionCommandFence, wholeOrder = false) {
      await lock(tx, `production-release-command:${orderLineId}:${input.idempotencyKey}`);
      const replayed = await this.releaseReplay(tx, context, orderLineId, input, eventIdempotencyKey);
      if (replayed) return replayed;
      const [sourceLine] = await tx.select({ orderId: orderLines.orderId }).from(orderLines).where(eq(orderLines.id, orderLineId));
      if (!sourceLine) throw new NotFoundException("订单商品不存在");
      await lockOrderProductionHeader(tx, sourceLine.orderId);
      await lock(tx, `order-work:${orderLineId}`); await lock(tx, `production-line:${orderLineId}`);
      await lockManufacturingProductionVersions(tx, context, [requireManufacturingSelection(input.manufacturing)]);
      if (!wholeOrder) await assertProductionCommandFence(tx, context, productionCommandDescriptor({ kind: "reviewed_line", targetId: orderLineId, input }), fence);
      const [current] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, orderLineId));
      const [line] = await tx.select({ line: orderLines, order: orders }).from(orderLines).innerJoin(orders, eq(orders.id, orderLines.orderId)).where(eq(orderLines.id, orderLineId));
      if (!current || !line || !current.encryptedDataKey || current.expiresAt <= new Date() || current.archivedAt || current.pushedRevisionId !== revisionId || current.revision !== input.expectedRevision || current.projectionVersion !== input.expectedProjectionVersion || current.held || current.artwork !== "approved" || !["not_required", "approved"].includes(current.proof) || line.order.sideState || line.order.addressStatus === "anonymized") throw new ConflictException("订单状态已变化，或文件、客户确认尚未完成");
      const [project] = await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, current.editorProjectId!)).for("update");
      if (!project?.encryptedDataKey || project.currentVersionId !== render.versionId || project.reviewedVersionId !== render.versionId || current.approvedEditorVersionId !== render.versionId) throw new ConflictException("生产文件已变化，请重新审核");
      if (current.proof === "approved" && current.proofEditorVersionId !== render.versionId)
        throw new ConflictException("客户确认未绑定当前生产稿，请核对该版本的客户回复后重新确认");
      const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, input.supplierId));
      if (!supplier || supplier.status !== "active") throw new UnprocessableEntityException("请选择启用的供应商");
      if (!this.factories) throw new ConflictException("工厂配置服务不可用");
      await assertInitialProductionQuantity(tx, orderLineId, { quantity: input.quantity, orderedQuantity: line.line.quantity });
      const productionId = createEntityId(), productionVersionId = createEntityId();
      await tx.insert(productionOrders).values({ id: productionId, tenantId: context.tenantId, orderId: line.order.id, orderLineId,
        supplierId: input.supplierId, factoryId: input.factoryId, sourceWorkItemId: orderLineId, expectedCompletionAt: new Date(input.expectedCompletionAt), idempotencyKey: input.idempotencyKey, requestChecksum, createdBy: context.userId });
      await tx.insert(productionOrderVersions).values({ id: productionVersionId, tenantId: context.tenantId, productionOrderId: productionId, versionNumber: 1,
        quantity: input.quantity, sourceWorkRevisionId: current.pushedRevisionId, sourceEditorProjectId: project.id, sourceEditorVersionId: render.versionId, sourceRenderId: render.id,
        factoryId: input.factoryId, factoryVersionId: input.factoryVersionId, capabilityVersionId: input.capabilityVersionId,
        encryptedInstructions: this.vault.encrypt(input.instructions), instructionsChecksum: checksum(input.instructions), expectedCompletionAt: new Date(input.expectedCompletionAt), createdBy: context.userId });
      const manufacturing = await sealProductionManufacturing(tx, context, this.vault, productionVersionId, input.manufacturing, { kind: "order_work_revision" }, document);
      const requirement = await this.factoryRequirement(tx, orderLineId, input.quantity, document, current.pushedRevisionId, manufacturing);
      await this.factories.pinForRelease(tx, input.factoryId, input.factoryVersionId, input.capabilityVersionId, input.supplierId, requirement);
      await reserveFactoryCapacityInTransaction(tx, context, this.audit, { productionOrderId: productionId, productionVersionId, capacityPlan: input.capacityPlan });
      const encryptedReason = this.vault.withSecret(current.encryptedDataKey!, (secret) => {
        const key = Buffer.from(secret, "base64"); try { return Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(input.instructions)))).toString("base64"); } finally { key.fill(0); }
      });
      await tx.insert(orderWorkEvents).values({ id: createEntityId(), tenantId: context.tenantId, workItemId: orderLineId, action: "release_production", fromState: "approved", toState: "planned", revision: current.revision,
        encryptedReason, idempotencyKey: eventIdempotencyKey, requestHash: checksum(JSON.stringify(input)), actorId: context.userId });
      await tx.update(orderWorkItems).set({ projectionVersion: current.projectionVersion + 1, updatedAt: new Date() }).where(eq(orderWorkItems.id, orderLineId));
      return productionId;
  }

  async releaseWholeOrder(context: TenantContext, orderId: string, raw: unknown) {
    return this.releaseWholeOrderReceipt(context, orderId, raw);
  }

  async releaseWholeOrderReceipt(context: TenantContext, orderId: string, raw: unknown, fence?: ProductionCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = ReleaseWholeOrderInputSchema.parse(raw);
    input.items.sort((a, b) => a.lineId.localeCompare(b.lineId));
    const key = `whole-order:${input.idempotencyKey}`, hash = checksum(JSON.stringify({ orderId, input }));
    const replay = async (tx: TenantTransaction) => {
      const records = await tx.select().from(productionOrders).where(eq(productionOrders.idempotencyKey, key));
      if (!records.length) return null;
      if (records.length !== input.items.length || records.some(record => record.orderId !== orderId || record.createdBy !== context.userId || record.requestChecksum !== hash || !input.items.some(item => item.lineId === record.orderLineId)))
        throw new ConflictException("同一次整单生产重试的订单或内容不能改变");
      return records.map(record => record.id);
    };
    const previous = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], replay);
    if (previous) return { productionOrderIds: previous };
    const prepared = new Map<string, PreparedArtwork>();
    for (const item of input.items) prepared.set(item.lineId, await this.prepareArtwork(context, item.lineId, item.renderId));
    const ids = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async tx => {
      await lock(tx, `whole-production-command:${input.idempotencyKey}`);
      const repeated = await replay(tx); if (repeated) return repeated;
      const { lines } = await lockWholeOrder(tx, orderId);
      for (const line of lines) await lock(tx, `production-line:${line.id}`);
      await assertWholeOrderPins(tx, orderId, input.items);
      await assertWholeOrderActive(tx, orderId);
      await lockManufacturingProductionVersions(tx, context, input.items.map(item => requireManufacturingSelection(item.manufacturing)));
      await assertProductionCommandFence(tx, context, productionCommandDescriptor({ kind: "reviewed_order", targetId: orderId, input }), fence);
      const result: string[] = [];
      for (const line of lines) {
        const item = input.items.find(item => item.lineId === line.id)!;
        try {
          result.push(await this.releaseInTransaction(tx, context, item.lineId, {
            supplierId: input.supplierId, factoryId: input.factoryId, factoryVersionId: input.factoryVersionId,
            expectedCompletionAt: input.expectedCompletionAt, quantity: line.quantity, renderId: item.renderId, capabilityVersionId: item.capabilityVersionId,
            expectedRevision: item.expectedRevision, expectedProjectionVersion: item.expectedProjectionVersion,
            ...(item.manufacturing ? { manufacturing: item.manufacturing } : {}),
            ...(item.capacityPlan ? { capacityPlan: item.capacityPlan } : {}),
            instructions: ["整单一起制作、打包，全部商品同时交付。", productionDocumentInstructions(prepared.get(item.lineId)!), prepared.get(item.lineId)!.operatorInstructions, input.instructions].filter(Boolean).join("\n"),
            idempotencyKey: key,
          }, prepared.get(item.lineId)!, hash, input.idempotencyKey, undefined, true));
        } catch (cause) {
          if (cause instanceof ConflictException || cause instanceof UnprocessableEntityException) throw new ConflictException(`商品 ${line.externalLineId}：${cause.message}`);
          throw cause;
        }
      }
      await this.audit.recordInTransaction(tx, context, { action: "production.whole_order.release", resourceType: "order", resourceId: orderId, result: "success", metadata: { itemCount: lines.length, quantity: lines.reduce((sum, line) => sum + line.quantity, 0) } });
      return result;
    });
    return { productionOrderIds: ids };
  }

  async recordWholeOrderProduction(context: TenantContext, orderId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = RecordWholeOrderProductionInputSchema.parse(raw);
    input.items.sort((a, b) => a.lineId.localeCompare(b.lineId));
    const key = `whole-order:${input.idempotencyKey}`, eventKey = `${key}:${checksum(JSON.stringify({ orderId, input }))}`;
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async tx => {
      await lock(tx, `whole-progress-command:${input.idempotencyKey}`);
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "whole_production_milestone", targetId: orderId, input }, fence);
      const previous = await tx.select({ productionOrderId: productionMilestoneEvents.productionOrderId, key: productionMilestoneEvents.externalEventId, actor: productionMilestoneEvents.actorUserId }).from(productionMilestoneEvents)
        .where(sql`${productionMilestoneEvents.externalEventId} like ${key + ":%"}`);
      if (previous.length) {
        if (previous.length !== input.items.length || previous.some(event => event.key !== eventKey || fence && event.actor !== context.userId || !input.items.some(item => item.productionOrderId === event.productionOrderId))) throw new ConflictException("同一次整单进度重试的内容或操作员不能改变");
        return { productionOrderIds: previous.map(event => event.productionOrderId) };
      }
      await this.assertWholeProductionPins(tx, orderId, input.items);
      for (const item of input.items) {
        const event: RecordProductionMilestoneInput = { type: input.type, expectedProjectionVersion: item.expectedProductionProjectionVersion,
          externalEventId: eventKey, occurredAt: input.occurredAt, evidence: input.evidence };
        await this.applyMilestoneInTransaction(tx, context, item.productionOrderId, event, false, fence ? checksum(JSON.stringify(event)) : undefined);
      }
      await this.audit.recordInTransaction(tx, context, { action: "production.whole_order.progress", resourceType: "order", resourceId: orderId, result: "success", metadata: { type: input.type, itemCount: input.items.length } });
      return { productionOrderIds: input.items.map(item => item.productionOrderId) };
    });
  }

  async inspectWholeOrder(context: TenantContext, orderId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = InspectWholeOrderInputSchema.parse(raw);
    input.items.sort((a, b) => a.lineId.localeCompare(b.lineId));
    const key = `whole-order:${input.idempotencyKey}`, inspectionKey = `${key}:${checksum(JSON.stringify({ orderId, input, ...(input.assessment ? { actor: context.userId } : {}) }))}`;
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async tx => {
      await lock(tx, `whole-quality-command:${input.idempotencyKey}`);
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "whole_quality_inspection", targetId: orderId, input }, fence);
      await assertQualityEvidenceAssets(tx, context, { ...input, defects: [] });
      const previous = await tx.select({ id: qualityInspections.id, productionOrderId: qualityInspections.productionOrderId, key: qualityInspections.idempotencyKey, inspectedBy: qualityInspections.inspectedBy }).from(qualityInspections)
        .where(sql`${qualityInspections.idempotencyKey} like ${key + ":%"}`);
      if (previous.length) {
        if (previous.length !== input.items.length || previous.some(inspection => inspection.key !== inspectionKey || inspection.inspectedBy !== context.userId || !input.items.some(item => item.productionOrderId === inspection.productionOrderId))) throw new ConflictException("同一次整单质检重试的内容或操作员不能改变");
        return { inspectionIds: previous.map(inspection => inspection.id) };
      }
      await this.assertWholeProductionPins(tx, orderId, input.items);
      const inspectionIds: string[] = [];
      if (input.assessment?.criterionResults.some(result => !result.passed))
        throw new UnprocessableEntityException("整单通过仅接受逐项全部通过 有不合格项目请逐件登记缺陷和处理方式");
      for (const item of input.items) {
        const inspection = await this.inspectInTransaction(tx, context, item.productionOrderId, {
          assessment: input.assessment, expectedProductionProjectionVersion: item.expectedProductionProjectionVersion,
          qualityStandardVersionId: input.qualityStandardVersionId, scoreBps: input.scoreBps, inspectedAt: input.inspectedAt,
          evidenceAssetIds: input.evidenceAssetIds, result: "passed", defects: [], idempotencyKey: inspectionKey,
        });
        inspectionIds.push(inspection.inspectionId);
      }
      await this.audit.recordInTransaction(tx, context, { action: "production.whole_order.inspect", resourceType: "order", resourceId: orderId, result: "success", metadata: { itemCount: input.items.length, qualityStandardVersionId: input.qualityStandardVersionId } });
      return { inspectionIds };
    });
  }

  private async assertWholeProductionPins(tx: TenantTransaction, orderId: string, items: Array<WholeOrderLinePin & { productionOrderId: string; expectedProductionProjectionVersion: number }>) {
    await lockWholeOrder(tx, orderId);
    await assertWholeOrderPins(tx, orderId, items);
    await assertWholeOrderActive(tx, orderId);
    await lockWholeOrderProduction(tx, orderId);
    const records = await tx.select().from(productionOrders).where(inArray(productionOrders.id, items.map(item => item.productionOrderId))).orderBy(asc(productionOrders.id)).for("update");
    if (records.length !== items.length || new Set(records.map(record => record.idempotencyKey)).size !== 1 || new Set(records.map(record => record.factoryId)).size !== 1) throw new ConflictException("请核对本次整单生产安排，不能混合不同生产任务");
    for (const item of items) {
      const record = records.find(record => record.id === item.productionOrderId);
      if (!record || record.orderId !== orderId || record.orderLineId !== item.lineId || record.source !== "initial" || !record.idempotencyKey.startsWith("whole-order:") || record.projectionVersion !== item.expectedProductionProjectionVersion) throw new ConflictException("生产记录已变化，请重新读取整单");
      const [version] = await tx.select().from(productionOrderVersions).where(and(eq(productionOrderVersions.productionOrderId, record.id), eq(productionOrderVersions.versionNumber, record.currentVersionNumber)));
      const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, item.lineId));
      const [child] = await tx.select({ id: productionOrders.id }).from(productionOrders).where(and(eq(productionOrders.parentProductionOrderId, record.id), sql`${productionOrders.status}<>'cancelled'`)).limit(1);
      if (version?.quantity !== item.quantity || version.sourceEditorVersionId !== work?.approvedEditorVersionId || child) throw new ConflictException("数量、审核稿或返工记录已变化，请先核对商品生产记录");
    }
  }

  async wholeOrderFulfillment(context: TenantContext, orderId: string) {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderRead, "outside_data_scope");
    const source = await withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
      if (!order) throw new NotFoundException("订单不存在或无权访问");
      const rows = await tx.execute(sql`select v.*,w.editor_project_id as "editorProjectId",w.approved_editor_version_id as "approvedEditorVersionId",
        w.encrypted_data_key is not null and w.expires_at>now() as retained from (${workProjection}) v
        left join order_work_items w on w.id=v.id where v."orderId"=${orderId} order by v.id limit 101`);
      if (!rows.length || rows.length > 100) throw new ConflictException("整单操作支持 1 至 100 件商品任务");
      const existing = await tx.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.orderId, orderId), sql`${shipments.status}<>'cancelled'`));
      const production = await tx.select({ id: productionOrders.id, lineId: productionOrders.orderLineId, status: productionOrders.status,
        projectionVersion: productionOrders.projectionVersion, idempotencyKey: productionOrders.idempotencyKey,
        qualityResult: sql<"passed" | "failed" | null>`(select qi.result from quality_inspections qi where qi.production_order_id=${productionOrders.id} order by qi.created_at desc,qi.id desc limit 1)` })
        .from(productionOrders).where(and(eq(productionOrders.orderId, orderId), eq(productionOrders.source, "initial"), sql`${productionOrders.status}<>'cancelled'`)).orderBy(desc(productionOrders.createdAt), desc(productionOrders.id));
      return { order, rows, production, shipmentIds: existing.map(shipment => shipment.id), shipmentSources: await readShipmentProductionSources(tx, orderId) };
    });
    const items: WholeOrderFulfillmentView["items"] = [], perLineChoices = new Map<string, Awaited<ReturnType<FactoryDirectoryService["choices"]>>>();
    for (const row of source.rows) {
      const projection = Object.fromEntries(Object.entries(row).filter(([key]) => !["approvedEditorVersionId", "retained"].includes(key)));
      const line = parseWorkLine(projection), common = wholeOrderBlockers(row);
      const productionBlockers = [...common], shipmentBlockers = [...common];
      if (!["not_released", "cancelled"].includes(line.production)) productionBlockers.push("已有生产安排，请查看生产记录");
      if (line.readyQuantity < line.quantity) shipmentBlockers.push(`生产或质检未齐：${line.readyQuantity}/${line.quantity} 件`);
      if (!source.shipmentIds.length && line.shippedQuantity > 0) shipmentBlockers.push("已有实际发货记录，请查看原发货单");
      let renderId: string | null = null, fileName: string | null = null, editorVersionNumber: number | null = null;
      if (this.editor && row.editorProjectId && row.retained) {
        try {
          const project = await this.editor.get(context, String(row.editorProjectId));
          const render = project.renders.find(render => render.versionId === project.version.id && render.versionId === row.approvedEditorVersionId && render.purpose === "production" && render.status === "completed" && render.preflight?.productionReady && render.files.length);
          if (render) {
            renderId = render.id; fileName = render.files[0]!.name; editorVersionNumber = project.version.versionNumber;
            if (!productionBlockers.length) perLineChoices.set(line.id, await this.factoryOptions(context, line.id, render.id));
          } else productionBlockers.push("当前审核稿的正式生产文件尚未准备好");
        } catch (cause) {
          if (cause instanceof ForbiddenError) throw cause;
          productionBlockers.push("正式生产文件不可用，请核对制图记录");
        }
      } else productionBlockers.push("尚无可用的正式生产文件");
      const production = source.production.find(record => record.lineId === line.id);
      items.push({ lineId: line.id, quantity: line.quantity, expectedRevision: line.revision, expectedProjectionVersion: line.projectionVersion,
        externalLineId: line.externalLineId, title: line.title, sku: line.skuCode, specification: line.specificationName ?? null,
        readyQuantity: line.readyQuantity, shippedQuantity: line.shippedQuantity, renderId, fileName, editorVersionNumber, productionBlockers, shipmentBlockers, operationBlockers: common,
        production: production ? { id: production.id, status: ProductionOrderStatusSchema.parse(production.status), projectionVersion: production.projectionVersion, wholeOrder: production.idempotencyKey.startsWith("whole-order:"), qualityResult: production.qualityResult } : null });
    }
    const factories: WholeOrderFulfillmentView["factories"] = [];
    if (items.every(item => !item.productionBlockers.length)) {
      for (const { pin } of (perLineChoices.get(items[0]!.lineId) ?? []).filter(choice => !choice.blockers.length)) {
        if (factories.some(factory => factory.factoryId === pin.factoryId)) continue;
        const matching = items.map(item => ({ lineId: item.lineId, choice: perLineChoices.get(item.lineId)?.find(choice => !choice.blockers.length && choice.pin.factoryId === pin.factoryId && choice.pin.factoryVersionId === pin.factoryVersionId) }));
        if (matching.every(item => item.choice)) factories.push({ supplierId: pin.supplierId, supplierName: pin.supplierName, factoryId: pin.factoryId, factoryVersionId: pin.factoryVersionId, factoryName: pin.factoryProfile.name,
          items: matching.map(item => ({ lineId: item.lineId, capabilityVersionId: item.choice!.pin.capabilityVersionId, capabilityName: item.choice!.pin.capabilityProfile.name })) });
      }
    }
    const factoryDiagnostics: WholeOrderFulfillmentView["factoryDiagnostics"] = [];
    if (!factories.length && perLineChoices.size === items.length && this.factories) {
      const directory = await this.factories.directory(context);
      for (const factory of directory.factories) {
        const blockers = [...factory.supplierBlockers];
        if (factory.supplierStatus !== "active") blockers.push("供应商未启用");
        if (factory.profile.status !== "active") blockers.push("工厂未启用");
        const capabilityIds = new Set<string>();
        for (const item of items) {
          const choices = (perLineChoices.get(item.lineId) ?? []).filter(choice => choice.pin.factoryId === factory.id);
          choices.forEach(choice => capabilityIds.add(choice.pin.capabilityId));
          if (!choices.length) blockers.push(`${item.externalLineId}：尚未配置本商品类型的承接能力`);
          else if (!choices.some(choice => !choice.blockers.length)) for (const choice of choices)
            blockers.push(`${item.externalLineId} · ${choice.pin.capabilityProfile.name}：${choice.blockers.join("；")}`);
        }
        factoryDiagnostics.push({ supplierId: factory.supplierId, supplierName: factory.supplierName, factoryId: factory.id,
          factoryName: factory.profile.name, blockers: [...new Set(blockers)], capabilityIds: [...capabilityIds] });
      }
    }
    return WholeOrderFulfillmentViewSchema.parse({ orderId, orderNumber: source.order.externalOrderId, orderStatus: source.rows[0]!.orderStatus ?? null, shipmentSources: source.shipmentSources,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0), shipmentIds: source.shipmentIds,
      platformConfirmationPending: source.rows.some(row => row.platformConfirmationPending === true), items, factories, factoryDiagnostics });
  }

  async factoryOptions(context: TenantContext, orderLineId: string, renderId: string, quantity?: number) {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    const [work] = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead], tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, orderLineId)));
    if (!this.editor || !this.factories || !work?.editorProjectId || !work.encryptedDataKey || work.expiresAt <= new Date()) throw new ConflictException("订单制作资料不可用");
    const render = await this.editor.getRender(context, work.editorProjectId, renderId);
    if (render.purpose !== "production" || render.status !== "completed" || render.versionId !== work.approvedEditorVersionId) throw new ConflictException("请选择已审核的正式文件");
    const document = (await this.editor.get(context, work.editorProjectId, render.versionId)).version.document;
    const requirement = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderPiiRead], async tx => {
      const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, orderLineId));
      if (!line) throw new NotFoundException("订单商品不存在或无权访问");
      const manufacturing = await orderProductionFactorySource(tx, context, this.vault, orderLineId, work.pushedRevisionId, document);
      const requestedQuantity = quantity ?? line.quantity;
      if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > line.quantity) throw new UnprocessableEntityException("请核对本次商品数量");
      return this.factoryRequirement(tx, orderLineId, requestedQuantity, document, work.pushedRevisionId, manufacturing);
    });
    return this.factories.choices(context, requirement);
  }
  async factoryList(context: TenantContext) {
    if (!this.factories || context.dataScope !== "tenant") return [];
    const directory = await this.factories.directory(context);
    return directory.factories.map(factory => ({ id: factory.id, name: factory.profile.name, supplierId: factory.supplierId, supplierName: factory.supplierName, status: factory.profile.status }));
  }
  async commandFactoryLabel(tx: TenantTransaction, context: TenantContext, input: { factoryId: string; factoryVersionId: string; capabilityVersionId: string }) {
    await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
    return (await this.factories?.pinned(tx, input.factoryId, input.factoryVersionId, input.capabilityVersionId))?.factoryProfile.name ?? null;
  }
  private async factoryRequirement(tx: TenantTransaction, orderLineId: string, quantity: number, document?: ProductionEditorDocument, revisionId?: string | null,
    manufacturing?: Awaited<ReturnType<typeof sealProductionManufacturing>>): Promise<FactoryRequirement> {
    const [link] = await tx.select({ skuId: orderLineCatalogLinks.skuId, productPlanId: factorySpus.productPlanId }).from(orderLineCatalogLinks)
      .innerJoin(factorySkus, eq(factorySkus.id, orderLineCatalogLinks.skuId)).innerJoin(factorySpus, eq(factorySpus.id, factorySkus.spuId)).where(eq(orderLineCatalogLinks.orderLineId, orderLineId));
    const [revision] = revisionId ? await tx.select({ templateVersionId: workRevisions.profileVersionId }).from(workRevisions).where(eq(workRevisions.id, revisionId)) : [];
    if (manufacturing && document && manufacturing.productType !== document.productType) throw new ConflictException("制造规格与实际审核稿的产品类型不一致");
    return { skuId: manufacturing ? manufacturing.skuId : link?.skuId ?? null, productPlanId: manufacturing?.productPlanId ?? link?.productPlanId ?? null, quantity, productType: document?.productType ?? manufacturing?.productType,
      longestMm: document?.productType === "shaped_pillow" ? document.spec.declaredLongestMm : document?.productType === "tire_cover" ? document.spec.diameterMm : document ? Math.max(document.spec.widthMm, document.spec.heightMm) : manufacturing?.longestMm ?? null,
      sideMode: document?.productType === "shaped_pillow" ? document.spec.sideMode : manufacturing?.sideMode ?? undefined,
      factoryStandardId: document?.productType === "shaped_pillow" ? document.spec.factoryStandardId : manufacturing?.factoryStandardId ?? undefined, templateVersionId: manufacturing?.templateVersionId ?? revision?.templateVersionId ?? null };
  }
  qualityStandards(context: TenantContext) { return withOrderAuthority(this.database.db, context, [Permission.OrderRead], (tx) => tx.select().from(qualityStandardVersions).orderBy(desc(qualityStandardVersions.createdAt), desc(qualityStandardVersions.id))); }

  async create(context: TenantContext, orderId: string, rawInput: unknown) {
    const receipt = await this.createReceipt(context, orderId, rawInput);
    return this.get(context, receipt.productionOrderIds[0]!);
  }

  async createReceipt(context: TenantContext, orderId: string, rawInput: unknown, fence?: ProductionCommandFence) {
    authorize(context, Permission.OrderWrite);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = CreateProductionOrderInputSchema.parse(rawInput);
    const requestChecksum = checksum(JSON.stringify({ orderId, input }));
    const replay = async (tx: TenantTransaction) => {
      const [replayed] = await tx.select({ id: productionOrders.id, createdBy: productionOrders.createdBy, requestChecksum: productionOrders.requestChecksum }).from(productionOrders).where(and(
        eq(productionOrders.orderLineId, input.orderLineId), eq(productionOrders.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) {
        if (replayed.createdBy !== context.userId || replayed.requestChecksum !== requestChecksum) throw new ConflictException("同一次下达生产的重试内容或操作员不能改变");
        return replayed.id;
      }
      return null;
    };
    const previous = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], replay);
    if (previous) return { productionOrderIds: [previous] };
    const productionOrderId = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lock(tx, `production-create-command:${input.orderLineId}:${input.idempotencyKey}`);
      const repeated = await replay(tx); if (repeated) return repeated;
      await lockOrderProductionHeader(tx, orderId);
      await lock(tx, `production-line:${input.orderLineId}`);
      await lockManufacturingProductionVersions(tx, context, [requireManufacturingSelection(input.manufacturing)]);
      await assertProductionCommandFence(tx, context, productionCommandDescriptor({ kind: "approved_design", targetId: orderId, input }), fence);
      if (!input.productConfirmation) throw new ConflictException("直接生产须明确确认本次完整产品规格及设计来源");
      const [record] = await tx.select({ order: orders, line: orderLines }).from(orderLines)
        .innerJoin(orders, eq(orders.id, orderLines.orderId)).where(and(eq(orderLines.id, input.orderLineId), eq(orderLines.orderId, orderId))).limit(1);
      if (!record) throw new NotFoundException("Order line not found");
      const requestedQuantity = input.quantity ?? record.line.quantity;
      if (record.order.workflowState !== "in_production") throw new ConflictException("Order must be in production before creating production work");
      await assertQualityOrderActive(tx, record.order.id, record.line.id);
      await assertInitialProductionQuantity(tx, input.orderLineId, { quantity: requestedQuantity, orderedQuantity: record.line.quantity });
      const [decision] = await tx.select().from(orderRoutingDecisions).where(and(eq(orderRoutingDecisions.id, input.routingDecisionId), eq(orderRoutingDecisions.orderLineId, input.orderLineId))).limit(1);
      if (!decision || decision.orderId !== orderId || decision.status !== "approved" || !decision.selectedSupplierId) throw new ConflictException("An approved routing decision is required");
      const [purchaseVersion] = await tx.select({ version: purchaseOrderVersions, purchase: purchaseOrders }).from(purchaseOrderVersions)
        .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderVersions.purchaseOrderId))
        .where(eq(purchaseOrderVersions.id, input.purchaseOrderVersionId)).limit(1);
      if (!purchaseVersion || purchaseVersion.purchase.orderId !== orderId || purchaseVersion.purchase.supplierId !== decision.selectedSupplierId ||
        purchaseVersion.purchase.status !== "approved" || purchaseVersion.purchase.currentVersionNumber !== purchaseVersion.version.versionNumber ||
        !purchaseVersion.version.routingDecisionIds.includes(decision.id) || !purchaseVersion.version.lineSnapshot.some((line) => line.orderLineId === input.orderLineId && line.quantity === record.line.quantity)) {
        throw new ConflictException("The current approved purchase-order version does not pin this routing decision and line");
      }
      if (input.designVersionId) {
        const [design] = await tx.select({ status: designVersions.status }).from(designVersions).where(eq(designVersions.id, input.designVersionId)).limit(1);
        if (design?.status !== "approved") throw new ConflictException("Production must pin an approved design version");
      }
      await assertAuthorizedAssets(tx, input.productionAssetIds);
      if (!this.factories) throw new ConflictException("工厂配置服务不可用");
      const id = createEntityId(), versionId = createEntityId();
      const expectedCompletionAt = new Date(input.expectedCompletionAt);
      await tx.insert(productionOrders).values({
        id, tenantId: context.tenantId, orderId, orderLineId: input.orderLineId, supplierId: decision.selectedSupplierId, factoryId: input.factoryId,
        routingDecisionId: decision.id, purchaseOrderVersionId: purchaseVersion.version.id, source: "initial", status: "planned",
        expectedCompletionAt, idempotencyKey: input.idempotencyKey, requestChecksum, createdBy: context.userId,
      });
      await tx.insert(productionOrderVersions).values({
        id: versionId, tenantId: context.tenantId, productionOrderId: id, versionNumber: 1,
        quantity: requestedQuantity, designVersionId: input.designVersionId, productionAssetIds: input.productionAssetIds,
        factoryId: input.factoryId, factoryVersionId: input.factoryVersionId, capabilityVersionId: input.capabilityVersionId,
        encryptedInstructions: this.vault.encrypt(input.instructions), instructionsChecksum: checksum(input.instructions),
        expectedCompletionAt, createdBy: context.userId,
      });
      const manufacturing = await sealProductionManufacturing(tx, context, this.vault, versionId, input.manufacturing, { kind: "approved_product_confirmation", confirmation: input.productConfirmation });
      if (manufacturing.productType !== "rectangular_print") throw new ConflictException("该产品须从已审核生产稿下达 直接设计文件入口尚未核实其完整制作几何");
      await this.factories.pinForRelease(tx, input.factoryId, input.factoryVersionId, input.capabilityVersionId, decision.selectedSupplierId!, await this.factoryRequirement(tx, input.orderLineId, requestedQuantity, undefined, null, manufacturing));
      await reserveFactoryCapacityInTransaction(tx, context, this.audit, { productionOrderId: id, productionVersionId: versionId, capacityPlan: input.capacityPlan });
      await this.audit.recordInTransaction(tx, context, { action: "production_order.create", resourceType: "production_order", resourceId: id, result: "success", metadata: { orderId } });
      return id;
    });
    return { productionOrderIds: [productionOrderId] };
  }

  async recordMilestone(context: TenantContext, productionOrderId: string, rawInput: RecordProductionMilestoneInput, fence?: OrderFulfillmentCommandFence) {
    const input = RecordProductionMilestoneInputSchema.parse(rawInput);
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await this.recordMilestoneInTransaction(tx, context, productionOrderId, input, false, fence);
      await this.audit.recordInTransaction(tx, context, { action: "production_order.milestone", resourceType: "production_order", resourceId: productionOrderId, result: "success", metadata: { type: input.type } });
    });
    return this.get(context, productionOrderId);
  }

  /** Receipt and progress commit together; download alone never calls this. */
  async recordMilestoneInTransaction(tx: TenantTransaction, context: TenantContext, productionOrderId: string, input: RecordProductionMilestoneInput, deliveryReceipt = false, fence?: OrderFulfillmentCommandFence) {
      authorize(context, Permission.OrderWrite);
      return this.applyMilestoneInTransaction(tx,context,productionOrderId,input,deliveryReceipt,fence ? checksum(JSON.stringify(input)) : undefined,fence);
  }

  async recordFactoryDeliveryMilestoneInTransaction(tx:TenantTransaction,context:TenantContext,assignmentId:string,input:RecordProductionMilestoneInput){
      const scope=await requireFactoryTask(tx,context,assignmentId,true);
      const prefix=`DELIVERY:${scope.item.id}:`,sequence=input.externalEventId?.startsWith(prefix)?Number(input.externalEventId.slice(prefix.length)):NaN;
      const [event]=Number.isSafeInteger(sequence)?await tx.select().from(productionDeliveryFeedback).where(and(eq(productionDeliveryFeedback.itemId,scope.item.id),eq(productionDeliveryFeedback.sequence,sequence),eq(productionDeliveryFeedback.recordedBy,context.userId))):[];
      const expected=event?.kind==="received"?"submitted":event?.kind==="accepted"?"acknowledged":event?.kind==="rejected"?"failed":null;
      if(!event||input.type!==expected||input.evidence.code!==`DELIVERY_${event.kind.toUpperCase()}`||input.evidence.note!==null||input.evidence.assetIds.length)throw new ConflictException("工厂回执不能替代其他生产操作");
      return this.applyMilestoneInTransaction(tx,context,scope.item.productionOrderId,input,true);
  }

  private async applyMilestoneInTransaction(tx:TenantTransaction,context:TenantContext,productionOrderId:string,input:RecordProductionMilestoneInput,deliveryReceipt=false,requestChecksum?:string,fence?:OrderFulfillmentCommandFence){
      // Managed commands acquire the original order/privacy locks before the
      // production advisory lock, matching the quality and whole-order owners.
      if (input.externalEventId) await assertOrderFulfillmentCommandFence(tx, context,
        { kind: "production_milestone", targetId: productionOrderId, input: { ...input, externalEventId: input.externalEventId } }, fence);
      else if (fence) throw new ConflictException("持久履约进度必须固定原事件编号");
      await lock(tx, `production-order:${productionOrderId}`);
      const [record] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!record) throw new NotFoundException("Production order not found");
      if (input.externalEventId) {
        const [replayed] = await tx.select().from(productionMilestoneEvents).where(and(
          eq(productionMilestoneEvents.productionOrderId, productionOrderId), eq(productionMilestoneEvents.externalEventId, input.externalEventId),
        )).limit(1);
        if (replayed) {
          if (requestChecksum && (replayed.requestChecksum !== requestChecksum || replayed.actorUserId !== context.userId))
            throw new ConflictException("同一次生产进度的原正文或操作员不能改变");
          return;
        }
      }
      if (record.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Production projection version changed");
      if (["submitted", "acknowledged", "started"].includes(input.type)) {
        const [version] = await tx.select().from(productionOrderVersions).where(and(eq(productionOrderVersions.productionOrderId, record.id), eq(productionOrderVersions.versionNumber, record.currentVersionNumber)));
        const pin = this.factories && record.factoryId && version?.factoryVersionId && version.capabilityVersionId ? await this.factories.pinned(tx, record.factoryId, version.factoryVersionId, version.capabilityVersionId) : null;
        if (!this.factories || !pin) throw new ConflictException("请核对具体工厂后重新安排生产；历史记录会保留");
        await this.factories.lockPins(tx, [pin]);
        const blockers = await this.factories.availability(tx, pin);
        if (blockers.length) throw new ConflictException(blockers.join("；"));
      }
      if (!deliveryReceipt && ["submitted", "acknowledged", "started"].includes(input.type)) {
        const [delivery] = await tx.select({ id: productionDeliveryItems.id }).from(productionDeliveryItems)
          .where(eq(productionDeliveryItems.productionOrderId, productionOrderId)).orderBy(desc(productionDeliveryItems.id)).limit(1);
        if (delivery) {
          const [receipt] = await tx.select({ kind: productionDeliveryFeedback.kind }).from(productionDeliveryFeedback)
            .where(and(eq(productionDeliveryFeedback.itemId, delivery.id), sql`${productionDeliveryFeedback.kind} <> 'rework'`))
            .orderBy(desc(productionDeliveryFeedback.sequence)).limit(1);
          if (input.type !== "started" || receipt?.kind !== "accepted") throw new ConflictException("请在交付包中登记工厂回执；开始生产前须有该文件的接受记录");
        }
      }
      const [quantityReview] = await tx.execute<{ cumulativeStoppedQuantity: number; quantities: { unstartedQuantity: number; inProcessQuantity: number; completedQuantity: number }; occurredAt: string; quantity: number }>(sql`
        select r.cumulative_stopped_quantity as "cumulativeStoppedQuantity",r.quantities,r.input->>'occurredAt' as "occurredAt",v.quantity
        from production_quantity_reviews r join production_order_versions v on v.id=r.production_version_id and v.tenant_id=r.tenant_id
        where r.production_order_id=${record.id} and v.version_number=${record.currentVersionNumber} order by r.sequence desc limit 1`);
      if (input.type === "cancelled" && quantityReview && quantityReview.cumulativeStoppedQuantity > 0 && quantityReview.cumulativeStoppedQuantity < quantityReview.quantity)
        throw new ConflictException({ code: "production_quantity_partial_cancel_blocked", message: "本批只有部分数量停做 请保留并继续处理其余实物 不能登记整批取消" });
      if (input.type === "completed" && quantityReview && (quantityReview.quantities.unstartedQuantity || quantityReview.quantities.inProcessQuantity || !quantityReview.quantities.completedQuantity))
        throw new ConflictException({ code: "production_quantity_remaining_not_complete", message: "尚有未开工、在制或没有已完工实物 请先核对实际剩余数量" });
      let nextStatus: string;
      if (record.status === "cancel_requested" && ["started", "completed"].includes(input.type)) {
        if (!quantityReview || !quantityReview.cumulativeStoppedQuantity || quantityReview.cumulativeStoppedQuantity >= quantityReview.quantity)
          throw new ConflictException({ code: "production_quantity_resume_required", message: "请先保存并核准实际部分停做数量 再据实登记剩余生产" });
        if (new Date(input.occurredAt).getTime() < Date.parse(quantityReview.occurredAt))
          throw new ConflictException({ code: "production_quantity_resume_required", message: "剩余生产发生时间不能早于原数量核准" });
        nextStatus = input.type === "started" ? "in_production" : "completed";
      } else nextStatus = nextProductionStatus(record.status, input.type);
      await assertAuthorizedAssets(tx, input.evidence.assetIds);
      const [latest] = await tx.select({ sequence: productionMilestoneEvents.sequence }).from(productionMilestoneEvents)
        .where(eq(productionMilestoneEvents.productionOrderId, productionOrderId)).orderBy(desc(productionMilestoneEvents.sequence)).limit(1);
      const milestoneEventId = createEntityId();
      await tx.insert(productionMilestoneEvents).values({
        id: milestoneEventId, tenantId: context.tenantId, productionOrderId, sequence: (latest?.sequence ?? 0) + 1,
        type: input.type, externalEventId: input.externalEventId, evidenceCode: input.evidence.code, requestChecksum: requestChecksum ?? null,
        encryptedEvidenceNote: input.evidence.note ? this.vault.encrypt(input.evidence.note) : null,
        evidenceAssetIds: input.evidence.assetIds, actorUserId: context.userId, occurredAt: new Date(input.occurredAt),
      });
      await recordFactoryCapacityMilestoneInTransaction(tx, context, this.audit, { milestoneEventId });
      await tx.update(productionOrders).set({ status: nextStatus, projectionVersion: record.projectionVersion + 1, updatedAt: new Date() })
        .where(and(eq(productionOrders.id, productionOrderId), eq(productionOrders.projectionVersion, input.expectedProjectionVersion)));
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
      if (members.some(member => !member.factoryId) || new Set(members.map(member => member.factoryId)).size !== 1) throw new UnprocessableEntityException("生产批次须属于同一具体工厂，旧单须先核对工厂");
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
    const row = await withOrderAuthority(this.database.db, context, [Permission.OrderWrite], async (tx) => {
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

  async inspect(context: TenantContext, productionOrderId: string, rawInput: RecordQualityInspectionInput, fence?: OrderFulfillmentCommandFence) {
    const input = RecordQualityInspectionInputSchema.parse(rawInput);
    await this.withQualityTransaction(context, productionOrderId, async tx => {
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "quality_inspection", targetId: productionOrderId, input }, fence);
      const { inspectionId, orderId } = await this.inspectInTransaction(tx, context, productionOrderId, input);
      if (!orderId) return;
      if (input.result === "failed") await this.orderService.openExceptionInTransaction(tx, context, orderId, {
        category: "quality", code: "QUALITY_INSPECTION_FAILED", message: "A production order failed its pinned quality standard.",
        idempotencyKey: `quality-failed:${inspectionId}`,
      });
      await this.audit.recordInTransaction(tx, context, { action: "production_order.inspect", resourceType: "quality_inspection", resourceId: inspectionId, result: "success", metadata: { productionOrderId, result: input.result } });
    });
    return this.get(context, productionOrderId);
  }

  async qualityGroups(context: TenantContext, productionOrderId: string) { return originalOwnerOperation(() => new ProductionReadOwner(this.database,this.vault,this.factories).qualityGroups(context, productionOrderId)); }

  async inspectGroups(context: TenantContext, productionOrderId: string, rawInput: unknown, fence?: OrderFulfillmentCommandFence) {
    const input = RecordQualityGroupsInputSchema.parse(rawInput);
    const result = await this.withQualityTransaction(context, productionOrderId, async tx => {
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "quality_group_inspection", targetId: productionOrderId, input }, fence);
      const saved = await recordQualityGroupInspection(tx, context, productionOrderId, input, this.vault);
      if (saved.replayed) return saved;
      if (saved.failed) await this.orderService.openExceptionInTransaction(tx, context, saved.orderId, {
        category: "quality", code: "QUALITY_GROUP_HELD", message: "实物质检组存在待处理数量 请核对原组与缺陷", idempotencyKey: "quality-groups:" + saved.inspectionId,
      });
      await this.audit.recordInTransaction(tx, context, { action: "production_order.inspect_groups", resourceType: "quality_inspection", resourceId: saved.inspectionId,
        result: "success", metadata: { productionOrderId, parentGroupId: input.parentGroupId, groups: input.groups.length } });
      return saved;
    });
    return { inspectionId: result.inspectionId, replayed: result.replayed, workspace: await this.qualityGroups(context, productionOrderId) };
  }

  private withQualityTransaction<T>(context: TenantContext, productionOrderId: string, apply: (tx: TenantTransaction) => Promise<T>) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async tx => {
      const [owner] = await tx.select({ orderId: productionOrders.orderId }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
      if (!owner) throw new NotFoundException("Production order not found");
      // Lock the order before production, matching whole-order operations and
      // the exception owner's sequence update in this same transaction.
      await lock(tx, owner.orderId);
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, owner.orderId)).for("update");
      return apply(tx);
    });
  }

  private async inspectInTransaction(tx: TenantTransaction, context: TenantContext, productionOrderId: string, input: RecordQualityInspectionInput) {
      await lock(tx, "production-order:" + productionOrderId);
      await assertQualityEvidenceAssets(tx, context, input);
      await lock(tx, `production-inspection:${productionOrderId}`);
      const [replayed] = await tx.select().from(qualityInspections).where(and(
        eq(qualityInspections.productionOrderId, productionOrderId), eq(qualityInspections.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) {
        await assertInspectionReplay(tx, context, replayed, input);
        return { inspectionId: replayed.id, orderId: "" };
      }
      const [production] = await tx.select().from(productionOrders).where(eq(productionOrders.id, productionOrderId)).limit(1);
      if (!production) throw new NotFoundException("Production order not found");
      if (production.status !== "completed" && production.status !== "quality_hold") throw new ConflictException("Production must be completed before inspection");
      await assertQualityOrderActive(tx, production.orderId, production.orderLineId, production.id);
      await assertRootQualityGroupingMutable(tx, productionOrderId);
      if (!input.assessment || input.expectedProductionProjectionVersion === undefined)
        throw new UnprocessableEntityException("请逐项核验所选标准并提供原生产版本依据");
      if (production.projectionVersion !== input.expectedProductionProjectionVersion)
        throw new ConflictException("生产记录已变化 请保留填写并重新核对");
      const [standard] = await tx.select().from(qualityStandardVersions).where(eq(qualityStandardVersions.id, input.qualityStandardVersionId)).limit(1);
      if (!standard) throw new NotFoundException("Quality standard version not found");
      const [catalog] = await tx.select({ skuId: orderLineCatalogLinks.skuId }).from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, production.orderLineId)).limit(1);
      if ((standard.supplierId && standard.supplierId !== production.supplierId) || (standard.skuId && standard.skuId !== catalog?.skuId)) throw new UnprocessableEntityException("Quality standard scope does not match production work");
      const evaluation = evaluateQualityAssessment(standard, input.assessment.criterionResults, input.defects);
      if (evaluation.problems.length) throw new UnprocessableEntityException(evaluation.problems.join("；"));
      if (input.scoreBps !== evaluation.scoreBps || input.result !== evaluation.result)
        throw new UnprocessableEntityException("质检总分与结论必须符合逐项核验、阻断项及待处理缺陷");
      if (input.assessment.criterionResults.some(result => !result.passed) && !input.defects.length)
        throw new UnprocessableEntityException("未通过项目必须登记缺陷、责任归属和处理方式");
      if (input.result === "passed") {
        const [replacement] = await tx.select({ id: productionOrders.id }).from(productionOrders)
          .where(and(eq(productionOrders.parentProductionOrderId, productionOrderId), ne(productionOrders.status, "cancelled"))).limit(1);
        if (replacement) throw new ConflictException("原生产单已有补做安排 请先核对并取消不用的补做单后再复检原单");
      }
      const clock = await tx.execute<{ now: Date }>(sql.raw("select clock_timestamp() as now"));
      if (new Date(input.inspectedAt).getTime() > new Date(clock[0]!.now).getTime())
        throw new UnprocessableEntityException("检验发生时间不能晚于数据库当前时间");
      const [previousAssessment] = await tx.select({ inspectedAt: qualityInspections.inspectedAt }).from(qualityInspections)
        .where(eq(qualityInspections.productionOrderId, productionOrderId))
        .orderBy(desc(qualityInspections.inspectedAt), desc(qualityInspections.id)).limit(1);
      if (previousAssessment && new Date(input.inspectedAt).getTime() < previousAssessment.inspectedAt.getTime())
        throw new UnprocessableEntityException("新核验时间早于上一份逐项检验 不能用较早结果覆盖当前结论");
      const [version] = await tx.select({ id: productionOrderVersions.id }).from(productionOrderVersions)
        .where(and(eq(productionOrderVersions.productionOrderId, productionOrderId), eq(productionOrderVersions.versionNumber, production.currentVersionNumber)));
      if (!version) throw new ConflictException("生产版本依据缺失 请核对原生产单");
      const inspectionId = createEntityId();
      await tx.insert(qualityInspections).values({
        id: inspectionId, tenantId: context.tenantId, productionOrderId, qualityStandardVersionId: standard.id,
        result: input.result, scoreBps: input.scoreBps, evidenceAssetIds: input.evidenceAssetIds,
        idempotencyKey: input.idempotencyKey, inspectedBy: context.userId, inspectedAt: new Date(input.inspectedAt),
        assessmentVersion: 2, criterionResults: input.assessment.criterionResults,
        requestChecksum: inspectionRequestChecksum(context, input), productionVersionId: version.id,
        productionProjectionVersion: production.projectionVersion,
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
      return { inspectionId, orderId: production.orderId };
  }

  async recover(context: TenantContext, rawInput: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite);
    const input = CreateProductionRecoveryInputSchema.parse(rawInput);
    const requestChecksum = checksum(JSON.stringify(input));
    const existing = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async tx => {
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "production_recovery", targetId: input.originalProductionOrderId, input }, fence);
      const [replayed] = await tx.select().from(productionRecoveryCases).where(and(eq(productionRecoveryCases.originalProductionOrderId, input.originalProductionOrderId), eq(productionRecoveryCases.idempotencyKey, input.idempotencyKey)));
      if (!replayed) return null;
      await assertRecoveryReplay(tx, context, replayed, input, requestChecksum);
      const [child] = await tx.select({ id: productionOrders.id }).from(productionOrders).where(and(eq(productionOrders.parentProductionOrderId, input.originalProductionOrderId), eq(productionOrders.idempotencyKey, `remake:${replayed.id}`)));
      return { recoveryId: replayed.id, replacementProductionOrderId: child?.id ?? null };
    });
    if (existing) return existing;
    const [basis] = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], tx => tx.select().from(productionOrders).where(eq(productionOrders.id, input.originalProductionOrderId)));
    let reviewed: Awaited<ReturnType<ProductionEditorService["getRender"]>> | null = null;
    let reviewedDocument: ProductionEditorDocument | undefined;
    if (input.reviewedArtwork) {
      authorize(context, Permission.OrderPiiRead);
      const [work] = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], tx => tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, basis?.sourceWorkItemId ?? "00000000-0000-7000-8000-000000000000")));
      if (!this.editor || !work?.editorProjectId || !work.encryptedDataKey || work.expiresAt <= new Date()) throw new ConflictException("返工所需的订单审核稿不可用");
      reviewed = await this.editor.getRender(context, work.editorProjectId, input.reviewedArtwork.renderId);
      reviewedDocument = (await this.editor.get(context, work.editorProjectId, reviewed.versionId)).version.document;
      if (reviewed.status !== "completed" || reviewed.purpose !== "production" || !reviewed.preflight?.productionReady || !reviewed.files.length) throw new ConflictException("返工需要当前已审核版本的正式文件");
    }
    let replacementId: string | null = null;
    const recoveryId = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      if (basis) await lockOrderProductionHeader(tx, basis.orderId);
      if (basis?.sourceWorkItemId) await lock(tx, `order-work:${basis.sourceWorkItemId}`);
      await lock(tx, `production-recovery:${input.originalProductionOrderId}`);
      await lock(tx, `production-order:${input.originalProductionOrderId}`);
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "production_recovery", targetId: input.originalProductionOrderId, input }, fence);
      const [replayed] = await tx.select().from(productionRecoveryCases).where(and(
        eq(productionRecoveryCases.originalProductionOrderId, input.originalProductionOrderId), eq(productionRecoveryCases.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) {
        await assertRecoveryReplay(tx, context, replayed, input, requestChecksum);
        const [child] = await tx.select({ id: productionOrders.id }).from(productionOrders).where(and(eq(productionOrders.parentProductionOrderId, input.originalProductionOrderId), eq(productionOrders.idempotencyKey, `remake:${replayed.id}`)));
        replacementId = child?.id ?? null; return replayed.id;
      }
      if (input.type === "remake") await lockManufacturingProductionVersions(tx, context, [requireManufacturingSelection(input.manufacturing)]);
      const [original] = await tx.select().from(productionOrders).where(eq(productionOrders.id, input.originalProductionOrderId)).limit(1);
      if (!original) throw new NotFoundException("Original production order not found");
      const [currentWork] = original.sourceWorkItemId ? await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, original.sourceWorkItemId)) : [];
      const rootInspection = await currentRootQualityInspection(tx, original.id);
      const selectedGroup = input.qualityGroupId ? (await readQualityGroupTree(tx, original.id)).find(group => group.id === input.qualityGroupId && (group.remakeEligible ?? group.active)) : null;
      if (input.type === "remake" && selectedGroup?.quantityBlockers?.length)
        throw new ConflictException(selectedGroup.quantityBlockers.join("；"));
      if (input.type === "remake") {
        await assertQualityOrderActive(tx, original.orderId, original.orderLineId, original.id, selectedGroup?.id);
        if (input.expectedProductionProjectionVersion !== undefined && input.expectedProductionProjectionVersion !== original.projectionVersion)
          throw new ConflictException("原生产依据已变化 请保留补做填写并重新核对");
        if (rootInspection?.assessmentVersion === 3 && !input.qualityGroupId)
          throw new UnprocessableEntityException("已分组生产需要明确选择待处理实物组与原缺陷");
        if (!selectedGroup && input.defectId) {
          const [unscopedDefect] = await tx.select({ disposition: qualityDefects.disposition }).from(qualityDefects)
            .where(and(eq(qualityDefects.id, input.defectId), eq(qualityDefects.productionOrderId, original.id)));
          if (unscopedDefect?.disposition === "scrap") throw new ConflictException({ code: "quality_scrap_recovery_group_required",
            message: "报废缺陷补做必须保留原实物组及其实际报废份额 不能改用未分组补做" });
        }
        if (input.qualityGroupId && (!selectedGroup || selectedGroup.result !== "failed" || !input.defectId ||
          !selectedGroup.defects.some(defect => defect.id === input.defectId && (["remake", "rework"].includes(defect.disposition) ||
            defect.disposition === "scrap" && (selectedGroup.remainingScrapRemakeQuantity ?? 0) > 0))))
          throw new ConflictException("补做来源必须是当前待处理组及其中需要补做或返工的原缺陷");
        if (selectedGroup && (input.remakeQuantity === null || input.remakeQuantity > selectedGroup.remainingRemakeQuantity))
          throw new ConflictException("补做数量超过原实物组剩余数量 不同缺陷共享同一实物余额");
        if (selectedGroup?.defects.find(defect => defect.id === input.defectId)?.disposition === "scrap" &&
            (input.remakeQuantity === null || input.remakeQuantity > (selectedGroup.remainingScrapRemakeQuantity ?? 0)))
          throw new ConflictException("报废处理只能补做原已归属报废余额 不同缺陷共享原补做占用");
        if (!selectedGroup && !["failed", "cancelled", "quality_hold"].includes(original.status))
          throw new ConflictException("原生产单没有需要补做的失败、取消或质检待处理依据");
        const [order] = await tx.select().from(orders).where(eq(orders.id, original.orderId));
        if (order?.sideState || order?.addressStatus === "anonymized" || currentWork && (!currentWork.encryptedDataKey || currentWork.expiresAt <= new Date() || currentWork.held || currentWork.archivedAt))
          throw new ConflictException("订单已停止或原制作资料不可用 请先核对");
      }
      if (input.reviewedArtwork) {
        const [order] = await tx.select().from(orders).where(eq(orders.id, original.orderId));
        const [supplier] = await tx.select().from(fulfillmentSuppliers).where(eq(fulfillmentSuppliers.id, original.supplierId));
        if (supplier?.status !== "active") throw new ConflictException("返工工厂已停用，请先确认工厂安排");
        const [revision] = currentWork?.pushedRevisionId ? await tx.select().from(orderWorkRevisions).where(and(eq(orderWorkRevisions.id, currentWork.pushedRevisionId), eq(orderWorkRevisions.workItemId, currentWork.id))) : [];
        const [report] = currentWork?.reportLineId ? await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, currentWork.reportLineId)) : [];
        if (!revision || currentWork!.revision !== revision.revision || currentWork!.reportLineId && (!report || report.currentVersionId !== revision.sourceVersionId || report.expiresAt <= new Date())) throw new ConflictException("返工审单来源已改版或到期，请重新核对");
        const [project] = currentWork?.editorProjectId ? await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, currentWork.editorProjectId)).for("update") : [];
        const [render] = reviewed ? await tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, reviewed.id)) : [];
        if (!["failed", "cancelled", "quality_hold"].includes(original.status) && !selectedGroup || !currentWork?.encryptedDataKey || currentWork.expiresAt <= new Date() || currentWork.held || currentWork.archivedAt || currentWork.artwork !== "approved" || !["approved", "not_required"].includes(currentWork.proof) || order?.sideState || order?.addressStatus === "anonymized" || currentWork.revision !== input.reviewedArtwork.expectedRevision || currentWork.projectionVersion !== input.reviewedArtwork.expectedProjectionVersion || !project?.encryptedDataKey || project.status !== "active" || project.expiresAt && project.expiresAt <= new Date() || project.sourceWorkItemId !== currentWork.id || project.sourceWorkRevisionId !== currentWork.pushedRevisionId || project.currentVersionId !== reviewed?.versionId || project.reviewedVersionId !== reviewed?.versionId || currentWork.approvedEditorVersionId !== reviewed?.versionId || currentWork.proof === "approved" && currentWork.proofEditorVersionId !== reviewed?.versionId || render?.status !== "completed" || render.versionId !== reviewed?.versionId) throw new ConflictException("返工原单、当前审核稿或客户确认已变化，请重新核对");
      }
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
        requestChecksum,
      });
      if (input.type === "remake") {
        const [version] = await tx.select().from(productionOrderVersions).where(and(
          eq(productionOrderVersions.productionOrderId, original.id), eq(productionOrderVersions.versionNumber, original.currentVersionNumber),
        )).limit(1);
        if (!version) throw new ConflictException("Original production version is missing");
        if (!selectedGroup && (await tx.execute(sql`select 1 from production_quantity_reviews
          where production_order_id=${original.id} and production_version_id=${version.id} limit 1`)).length)
          throw new ConflictException("本批次已有实际数量核准 补做须先固定真实缺陷实物组 停做量通过剩余订单数量重新安排");
        if (input.remakeQuantity !== null && input.remakeQuantity > version.quantity) throw new ConflictException("返工数量超过原生产单数量");
        if (!selectedGroup) {
          const used = await tx.execute<{ quantity: number }>(sql`select coalesce(sum(${productionRemainingQuantity(sql`child.id`)}),0)::int as quantity from production_orders child
            join production_order_versions child_version on child_version.production_order_id=child.id and child_version.version_number=child.current_version_number
            where child.parent_production_order_id=${original.id}`);
          if ((input.remakeQuantity ?? version.quantity) + (used[0]?.quantity ?? 0) > version.quantity)
            throw new ConflictException("原批次已有补做数量占用 不能按多个缺陷重复申请同一实物");
        }
        if (!this.factories || !original.factoryId || !version.factoryVersionId || !version.capabilityVersionId) throw new ConflictException("原单未确认具体工厂，请核对后重新安排生产");
        const factoryPin = await this.factories.pinned(tx, original.factoryId, version.factoryVersionId, version.capabilityVersionId);
        if (!factoryPin) throw new ConflictException("原单工厂版本不可用");
        replacementId = createEntityId();
        const expectedCompletionAt = new Date(input.expectedCompletionAt!);
        await tx.insert(productionOrders).values({
          id: replacementId, tenantId: context.tenantId, orderId: original.orderId, orderLineId: original.orderLineId,
          supplierId: original.supplierId, factoryId: original.factoryId, routingDecisionId: original.routingDecisionId,
          purchaseOrderVersionId: original.purchaseOrderVersionId, sourceWorkItemId: original.sourceWorkItemId, parentProductionOrderId: original.id,
          source: "remake", status: "planned", expectedCompletionAt,
          idempotencyKey: `remake:${id}`, createdBy: context.userId,
        });
        const replacementVersionId = createEntityId();
        await tx.insert(productionOrderVersions).values({
          id: replacementVersionId, tenantId: context.tenantId, productionOrderId: replacementId, versionNumber: 1,
          quantity: input.remakeQuantity ?? version.quantity, designVersionId: version.designVersionId, productionAssetIds: version.productionAssetIds,
          factoryId: original.factoryId, factoryVersionId: version.factoryVersionId, capabilityVersionId: version.capabilityVersionId,
          sourceWorkRevisionId: reviewed ? currentWork!.pushedRevisionId : version.sourceWorkRevisionId, sourceEditorProjectId: reviewed ? currentWork!.editorProjectId : version.sourceEditorProjectId,
          sourceEditorVersionId: reviewed?.versionId ?? version.sourceEditorVersionId, sourceRenderId: reviewed?.id ?? version.sourceRenderId,
          encryptedInstructions: input.reviewedArtwork ? this.vault.encrypt(input.reviewedArtwork.instructions) : version.encryptedInstructions,
          instructionsChecksum: input.reviewedArtwork ? checksum(input.reviewedArtwork.instructions) : version.instructionsChecksum,
          expectedCompletionAt, createdBy: context.userId,
        });
        const manufacturing = await sealProductionManufacturing(tx, context, this.vault, replacementVersionId, input.manufacturing,
          reviewed ? { kind: "order_work_revision" } : { kind: "original_production_binding", originalProductionVersionId: version.id }, reviewedDocument);
        await this.factories.lockPins(tx, [factoryPin]);
        const factoryBlockers = await this.factories.availability(tx, factoryPin);
        const requirement = await this.factoryRequirement(tx, original.orderLineId, input.remakeQuantity ?? version.quantity, reviewedDocument, reviewed ? currentWork!.pushedRevisionId : version.sourceWorkRevisionId, manufacturing);
        factoryBlockers.push(...await this.factories.requirementBlockersInTransaction(tx, factoryPin, "active", requirement));
        if (factoryBlockers.length) throw new ConflictException(factoryBlockers.join("；"));
        await reserveFactoryCapacityInTransaction(tx, context, this.audit, { productionOrderId: replacementId, productionVersionId: replacementVersionId, capacityPlan: input.capacityPlan });
        if (selectedGroup) await tx.insert(productionRecoveryGroups).values({ recoveryCaseId: id, tenantId: context.tenantId, qualityGroupId: selectedGroup.id,
          productionOrderId: original.id, productionVersionId: selectedGroup.productionVersionId, replacementProductionOrderId: replacementId,
          replacementProductionVersionId: replacementVersionId, quantity: input.remakeQuantity!, selectionConfirmed: input.physicalSelectionConfirmed! });
      }
      await this.audit.recordInTransaction(tx, context, { action: "production_order.recovery", resourceType: "production_recovery_case", resourceId: id, result: "success", metadata: { type: input.type, replacementId } });
      return id;
    });
    return { recoveryId, replacementProductionOrderId: replacementId };
  }

  async recordRecoveryEvent(context: TenantContext, recoveryCaseId: string, rawInput: RecordProductionRecoveryEventInput) {
    const input = RecordProductionRecoveryEventInputSchema.parse(rawInput);
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
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
            eq(productionOrders.parentProductionOrderId, recovery.originalProductionOrderId), eq(productionOrders.idempotencyKey, `remake:${recovery.id}`),
          )).orderBy(desc(productionOrders.createdAt)).limit(1);
          if (!replacement) throw new ConflictException("A remake cannot resolve before replacement production completes");
          await lock(tx, `production-order:${replacement.id}`);
          await lock(tx, `production-inspection:${replacement.id}`);
          const ready = await tx.execute<{ quantity: number; ready: number }>(sql`select pv.quantity,${productionReadyQuantity(sql`${replacement.id}::uuid`)} as ready
            from production_orders child join production_order_versions pv on pv.production_order_id=child.id and pv.version_number=child.current_version_number
            left join production_recovery_groups pinned on pinned.recovery_case_id=${recovery.id}
            where child.id=${replacement.id} and child.status='completed' and (pinned.recovery_case_id is null or
              pinned.replacement_production_order_id=child.id and pinned.replacement_production_version_id=pv.id and pinned.quantity=pv.quantity)`);
          if (!ready[0] || ready[0].ready < ready[0].quantity) throw new ConflictException("A remake cannot resolve before its own replacement quantity passes quality inspection");
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
      await this.audit.recordInTransaction(tx, context, { action: "production_recovery.event", resourceType: "production_recovery_case", resourceId: recoveryCaseId, result: "success", metadata: { action: input.action, outcomeCode: input.outcomeCode } });
    });
    return this.getRecovery(context, recoveryCaseId);
  }

  async get(context: TenantContext, productionOrderId: string) { return originalOwnerOperation(() => new ProductionReadOwner(this.database,this.vault,this.factories).get(context, productionOrderId)); }

  evidenceIndex(context: TenantContext, orderId: string) { return originalOwnerOperation(() => new ProductionReadOwner(this.database,this.vault,this.factories).evidenceIndex(context, orderId)); }

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

  async reviewRecoveries(context: TenantContext, orderId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const rows = await tx.select({ id: productionRecoveryCases.id, originalProductionOrderId: productionRecoveryCases.originalProductionOrderId,
        type: productionRecoveryCases.type, status: productionRecoveryCases.status, openedAt: productionRecoveryCases.openedAt,
      }).from(productionRecoveryCases).where(eq(productionRecoveryCases.orderId, orderId))
        .orderBy(asc(productionRecoveryCases.openedAt), asc(productionRecoveryCases.id)).limit(201);
      return { rows: rows.slice(0, 200), truncated: rows.length > 200 };
    });
  }

  async getRecovery(context: TenantContext, recoveryCaseId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async (tx) => {
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

export async function assertRecoveryReplay(tx: TenantTransaction, context: TenantContext, saved: typeof productionRecoveryCases.$inferSelect, input: CreateProductionRecoveryInput, requestChecksum: string) {
  if (saved.openedBy !== context.userId || saved.requestChecksum && saved.requestChecksum !== requestChecksum)
    throw new ConflictException("同一次返工申请的重试内容或操作员不能改变");
  if (saved.requestChecksum) return;
  if (input.qualityGroupId !== undefined || input.expectedProductionProjectionVersion !== undefined || input.physicalSelectionConfirmed !== undefined || input.reviewedArtwork !== null ||
      saved.type !== input.type || saved.originalProductionOrderId !== input.originalProductionOrderId || saved.defectId !== input.defectId ||
      saved.reasonChecksum !== checksum(input.reason) || saved.compensationAmountMinor !== input.compensationAmountMinor || saved.compensationCurrency !== input.compensationCurrency ||
      (saved.expectedCompletionAt?.toISOString() ?? null) !== (input.expectedCompletionAt ? new Date(input.expectedCompletionAt).toISOString() : null))
    throw new ConflictException("旧补做回执只能按原已记录内容恢复 不能补造分组或新审核依据");
  if (input.type === "remake" && input.remakeQuantity !== null) {
    const versions = await tx.execute<{ quantity: number }>(sql`select pv.quantity from production_orders child join production_order_versions pv on pv.production_order_id=child.id and pv.version_number=1
      where child.parent_production_order_id=${saved.originalProductionOrderId} and child.idempotency_key=${"remake:" + saved.id}`);
    if (versions[0]?.quantity !== input.remakeQuantity) throw new ConflictException("旧补做回执的原数量不能改变");
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
    planned: { submitted: "submitted", failed: "failed", cancel_requested: "cancel_requested" },
    failed: { cancel_requested: "cancel_requested" },
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

function productionDocumentInstructions({ render, document }: PreparedArtwork) {
  const header = `按固定审核稿 ${render.versionId} 及正式文件 ${render.files.map(file => file.name).join("、")} 生产。`;
  if (document.productType !== "shaped_pillow" || document.spec.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id) return header;
  const spec = document.spec, pixels = (mm: number) => Math.round(mm * spec.dpi / 25.4);
  const basis = { artwork: "图案主体", cut_contour: "裁线轮廓", finished: "缝制成品", unconfirmed: "待确认口径" }[spec.sizeBasis];
  return [header,
    `工艺版本：${spec.factoryStandardId}；${spec.dpi} DPI；白底 JPG；${spec.sideMode === "double" ? "双面印刷" : "单面印刷"}。`,
    ...(spec.declaredLongestMm ? [`${basis}最长边：${Number((spec.declaredLongestMm / 10).toFixed(2))} 厘米。`] : []),
    `缝边 ${pixels(spec.whiteBorderMm)} px；黑裁线 ${pixels(spec.cutLineMm)} px；空白条码框 ${spec.barcodeTab.widthMm === null ? "待确认" : pixels(spec.barcodeTab.widthMm)} × ${spec.barcodeTab.heightMm === null ? "待确认" : pixels(spec.barcodeTab.heightMm)} px。`,
    `两片净距 ${pixels(spec.panelGapMm)} px；整图四周留白 ${pixels(spec.sheetMarginMm ?? 0)} px。`,
    `细窄处不少于 ${spec.minimumNeckMm / 10} 厘米；${spec.minimumNeckBasis === "cut_contour" ? "按生产稿两侧裁线之间的最窄处核对" : "测量口径以本单核对记录为准"}。`,
  ].join("\n");
}

/** The caller holds production-line; physical dispatch keeps quantity occupied after cancellation. */
async function assertInitialProductionQuantity(tx: TenantTransaction, orderLineId: string, input: { quantity: number; orderedQuantity: number }) {
  if (await initialProductionAllocatedQuantity(tx, orderLineId) + input.quantity > input.orderedQuantity) throw new ConflictException("下达数量超过订单剩余数量");
}

async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }
function requireManufacturingSelection(selection: { versionId: string } | undefined) {
  if (!selection) throw new ConflictException("请选择本单已批准制造版本并明确确认销售 SKU 数量单位");
  return selection.versionId;
}
