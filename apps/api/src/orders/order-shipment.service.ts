import { ShipmentReadOwner, readShipmentPhysicalHandover } from "@yummyai/order-core";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { authorize, erpPermissionContext, ForbiddenError, Permission } from "@yummyai/authz";
import { CreateWholeOrderShipmentInputSchema } from "@yummyai/contracts/order/whole-fulfillment";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { ConflictException, Inject, Injectable, NotFoundException, Optional, ServiceUnavailableException, UnprocessableEntityException } from "@nestjs/common";
import { type ShiposShipmentSource } from "@yummyai/contracts/suppliers/shipos";
import { ShiposService } from "../suppliers/shipos.service.js";
import { AppendShipmentVersionInputSchema, CreateShipmentInputSchema, RecordShipmentWritebackEventInputSchema, RecordTrackingEventInputSchema, RequestShipmentWritebackInputSchema, ReviewShipmentVersionInputSchema, createEntityId, type AppendShipmentVersionInput, type CreateShipmentInput, type RecordShipmentWritebackEventInput, type RecordTrackingEventInput, type RequestShipmentWritebackInput, type ReviewShipmentVersionInput, type ShipmentPackageInput, type TenantContext } from "@yummyai/contracts";
import { assetFiles, orderLines, orders, orderWorkItems, orderWorkEvents, shipmentPackageLines, shipmentPackages, shipmentTrackingEvents, shipmentVersionReviews, shipmentVersions, shipmentWritebackEvents, shipmentWritebackRequests, shipments, shipmentManualConfirmations, shipmentProductionAllocations, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT, SHIPMENT_WRITEBACK_ENQUEUER } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";
import { DispatchOrderShipmentInputSchema, RecordManualShipmentConfirmationInputSchema } from "@yummyai/contracts/order/workspace";
import { physicalPackageEvidence } from "./order-workspace-query.js";
import { currentOrderAuthority, hasTenantOrderPermissions, withOrderAuthority } from "@yummyai/order-core";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { assertShipmentProductionSources, assertStoredShipmentProductionSources, lockShipmentOrder, readShipmentProductionSources } from "./shipment-production-sources.js";
import { ShipmentCreateWorkspaceSchema, ShipmentVersionEditorViewSchema, type ShipmentCreateWorkspace } from "@yummyai/contracts/order/shipment";
import { assertWholeOrderActive, assertWholeOrderPins, lockWholeOrder, lockWholeOrderProduction } from "./whole-order-fulfillment.js";
import { assertOrderFulfillmentCommandFence, type OrderFulfillmentCommandFence } from "./order-fulfillment-command-fence.js";

async function assertArtworkReady(tx: TenantTransaction, orderId: string, lines: Array<{ orderLineId: string; quantity: number }>, excludeShipmentId?: string) {
  const productionSources = await readShipmentProductionSources(tx, orderId, excludeShipmentId);
  const quantities = new Map<string, number>();
  for (const line of lines) quantities.set(line.orderLineId, (quantities.get(line.orderLineId) ?? 0) + line.quantity);
  for (const [lineId, quantity] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
    await lock(tx, `order-work:${lineId}`);
    const scope = await tx.execute(sql`select ol.quantity,w.held from order_lines ol join order_work_items w on w.id=ol.id where ol.id=${lineId} and ol.order_id=${orderId}`);
    if (!scope.length || scope[0]!.held) throw new ConflictException("商品尚未完成生产或已经暂停");
    const ready = productionSources.filter(source => source.orderLineId === lineId && !source.blockers.length).reduce((sum, source) => sum + source.quantity, 0);
    const allocated = await tx.execute(sql`select coalesce(sum(pl.quantity),0)::int as quantity from shipment_package_lines pl join shipment_versions sv on sv.id=pl.shipment_version_id join shipments s on s.id=sv.shipment_id
      where pl.order_line_id=${lineId} and sv.version_number=s.approved_version_number and s.status<>'cancelled' and (${excludeShipmentId ?? null}::uuid is null or s.id<>${excludeShipmentId ?? null}::uuid)`);
    if (quantity + Number(allocated[0]?.quantity ?? 0) > Math.min(ready, Number(scope[0]!.quantity))) throw new ConflictException("发货数量超过已经质检通过的可发数量");
  }
}

@Injectable()
export class OrderShipmentService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SHIPMENT_WRITEBACK_ENQUEUER) private readonly enqueuer: ShipmentWritebackEnqueuer,
    @Optional() @Inject(ShiposService) private readonly shipos?: ShiposService,
  ) {}

  /** Original partial/multi-package basis only; reading never reserves quantity. */
  async createWorkspace(context: TenantContext, orderId: string): Promise<ShipmentCreateWorkspace> {
    return withTenant(this.database.db, context, async tx => {
      const required = [Permission.OrderRead, Permission.OrderPiiRead];
      const admitted = await currentOrderAuthority(tx, context, required, { requireMembership: true, lock: false });
      const [order] = await tx.select({ id: orders.id, externalOrderId: orders.externalOrderId,
        latestEventSequence: orders.latestEventSequence, sideState: orders.sideState, addressStatus: orders.addressStatus })
        .from(orders).where(eq(orders.id, orderId));
      if (!order) throw new NotFoundException("订单不存在或无权访问");
      const lines = await tx.select({ lineId: orderLines.id, title: orderLines.title, quantity: orderLines.quantity })
        .from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.id)).limit(101);
      if (!lines.length || lines.length > 100) throw new UnprocessableEntityException("独立装箱依据支持 1 至 100 项原订单商品 请核对原订单范围");
      const originalSources = await readShipmentProductionSources(tx, orderId);
      if (originalSources.length > 1_000) throw new UnprocessableEntityException("本单生产来源超过 1000 项 无法完整核对装箱依据");
      const work = await tx.select({ lineId: orderWorkItems.id, held: orderWorkItems.held,
        archived: sql<boolean>`${orderWorkItems.archivedAt} is not null`,
        cleared: sql<boolean>`${orderWorkItems.encryptedDataKey} is null`,
        expired: sql<boolean>`${orderWorkItems.expiresAt}<=now()` })
        .from(orderWorkItems).where(inArray(orderWorkItems.id, lines.map(line => line.lineId)));
      const workByLine = new Map(work.map(row => [row.lineId, row]));
      const sources = originalSources.map(source => {
        // An absent work row is not evidence that a legitimate direct order's
        // private source was cleared. Only project restrictions that exist.
        const originalWork = workByLine.get(source.orderLineId), restricted: string[] = [];
        if (originalWork?.held) restricted.push("原商品已暂停 不能用于新装箱");
        if (originalWork?.archived) restricted.push("原商品已归档 不能用于新装箱");
        if (originalWork?.cleared) restricted.push("原商品制作资料已清理 不能用于新装箱");
        if (originalWork?.expired) restricted.push("原商品制作资料已到期 不能用于新装箱");
        return restricted.length ? { ...source, availableQuantity: 0, blockers: [...source.blockers, ...restricted] } : source;
      });
      const current = await currentOrderAuthority(tx, admitted, required, { requireMembership: true, lock: false });
      const blockers: string[] = [];
      if (!hasTenantOrderPermissions(current, [Permission.OrderWrite])) blockers.push("当前账号没有订单写入权限");
      if (order.sideState === "on_hold") blockers.push("订单已暂停 请先核对原订单状态");
      if (order.sideState === "cancelled") blockers.push("订单已取消 不能新建包裹");
      if (order.addressStatus === "anonymized") blockers.push("原订单资料已清理 不能新建包裹");
      if (!sources.some(source => !source.blockers.length && source.availableQuantity > 0 && source.qualityInspectionId !== null))
        blockers.push("当前没有可用的原生产与质检来源 请先核对生产进度 实物组和已占用数量");
      return ShipmentCreateWorkspaceSchema.parse({ orderId: order.id, orderNumber: order.externalOrderId,
        orderSequence: order.latestEventSequence, contextAuthority: erpSessionAuthority(erpPermissionContext(current)), lines, sources,
        canCreate: blockers.length === 0, blockers });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  async createWholeOrder(context: TenantContext, orderId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (context.dataScope !== "tenant") throw new ForbiddenError(Permission.OrderWrite, "outside_data_scope");
    const input = CreateWholeOrderShipmentInputSchema.parse(raw);
    input.items.sort((a, b) => a.lineId.localeCompare(b.lineId));
    const key = `whole-order:${input.idempotencyKey}`, hash = checksum(JSON.stringify({ orderId, input }));
    const shipmentId = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async tx => {
      await lock(tx, `whole-shipment-command:${input.idempotencyKey}`);
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "whole_shipment_create", targetId: orderId, input }, fence);
      const [previous] = await tx.select().from(shipments).where(eq(shipments.idempotencyKey, key));
      if (previous) {
        const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, previous.id), eq(shipmentVersions.versionNumber, 1)));
        if (previous.orderId !== orderId || version?.idempotencyKey !== `${key}:${hash}` || version.createdBy !== context.userId) throw new ConflictException("同一次整单发货重试的订单、内容或操作员不能改变");
        return previous.id;
      }
      await lock(tx, `shipment-create:${orderId}`);
      const { order } = await lockWholeOrder(tx, orderId);
      await assertWholeOrderPins(tx, orderId, input.items);
      await assertWholeOrderActive(tx, orderId);
      await lockWholeOrderProduction(tx, orderId);
      const existing = await tx.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.orderId, orderId), ne(shipments.status, "cancelled"))).limit(1);
      if (existing.length) throw new ConflictException("订单已有包裹，请核对原发货单，不能重复创建整单包裹");
      const content = CreateShipmentInputSchema.parse({ shipDate: input.shipDate, shipFromCountryCode: input.shipFromCountryCode, idempotencyKey: key,
        packages: [{ packageReferenceId: `${order.externalOrderId.slice(0, 157)}-1`, trackingNumber: input.trackingNumber, carrierCode: input.carrierCode,
          carrierName: input.carrierName, carrierService: input.carrierService, lines: input.items.map(item => ({ orderLineId: item.lineId, quantity: item.quantity, ...(item.productionAllocations ? { productionAllocations: item.productionAllocations } : {}) })) }] });
      await assertArtworkReady(tx, orderId, content.packages[0]!.lines);
      await assertVersionContent(tx, orderId, content.packages);
      await assertShipmentProductionSources(tx, orderId, content.packages);
      if (input.shiposSource && !this.shipos) throw new ServiceUnavailableException("ShipOS 来源暂不可核对，请稍后重试");
      const shiposSource = input.shiposSource ? await this.shipos!.pinShipmentEvidence(context, tx, orderId, input.shiposSource, input) : null;
      const id = createEntityId();
      await tx.insert(shipments).values({ id, tenantId: context.tenantId, orderId, idempotencyKey: key, createdBy: context.userId });
      await insertVersion(tx, context, id, createEntityId(), 1, content, `${key}:${hash}`, shiposSource);
      await this.audit.recordInTransaction(tx, context, { action: "shipment.whole_order.create", resourceType: "shipment", resourceId: id, result: "success", metadata: { orderId, itemCount: input.items.length, quantity: input.items.reduce((sum, item) => sum + item.quantity, 0) } });
      return id;
    });
    return this.get(context, shipmentId);
  }

  async create(context: TenantContext, orderId: string, rawInput: CreateShipmentInput, fence?: OrderFulfillmentCommandFence) {
    const input = CreateShipmentInputSchema.parse(rawInput);
    const shipmentId = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lockShipmentOrder(tx, orderId);
      await lock(tx, `shipment-create:${orderId}:${input.idempotencyKey}`);
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "shipment_create", targetId: orderId, input }, fence);
      const [replayed] = await tx.select({ id: shipments.id }).from(shipments).where(and(
        eq(shipments.orderId, orderId), eq(shipments.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) { await assertShipmentVersionReplay(tx, context, replayed.id, input, 1); return replayed.id; }
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (!order) throw new NotFoundException("Order not found");
      if (order.sideState || order.addressStatus === "anonymized") throw new ConflictException("Order must be active before shipment");
      if (order.workflowState !== "awaiting_shipment") await assertArtworkReady(tx, orderId, input.packages.flatMap((pkg) => pkg.lines));
      await assertVersionContent(tx, orderId, input.packages);
      await assertShipmentProductionSources(tx, orderId, input.packages);
      const id = createEntityId(); const versionId = createEntityId();
      await tx.insert(shipments).values({ id, tenantId: context.tenantId, orderId, idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      await insertVersion(tx, context, id, versionId, 1, input, input.idempotencyKey);
      await this.audit.recordInTransaction(tx, context, { action: "shipment.create", resourceType: "shipment", resourceId: id, result: "success", metadata: { orderId } });
      return id;
    });
    return this.get(context, shipmentId);
  }

  async appendVersion(context: TenantContext, shipmentId: string, rawInput: AppendShipmentVersionInput, fence?: OrderFulfillmentCommandFence) {
    const input = AppendShipmentVersionInputSchema.parse(rawInput);
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lockExistingShipmentOrder(tx, shipmentId);
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "shipment_version", targetId: shipmentId, input }, fence);
      const [replayed] = await tx.select({ id: shipmentVersions.id, versionNumber: shipmentVersions.versionNumber }).from(shipmentVersions).where(and(
        eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) { await assertShipmentVersionReplay(tx, context, shipmentId, input, replayed.versionNumber); return; }
      if (!["draft", "approved", "shipped"].includes(shipment.status)) throw new ConflictException("A dispatched shipment cannot be revised");
      if (await hasPhysicalShipmentEvidence(tx, shipmentId)) throw new ConflictException("A physically dispatched shipment cannot be revised");
      if (shipment.currentVersionNumber !== input.expectedCurrentVersion) throw new ConflictException("Shipment version changed");
      const [originalVersion] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.currentVersionNumber)));
      if (!originalVersion) throw new ConflictException("原包裹版本不可用 请重新核对");
      const originalPackages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, originalVersion.id));
      const originalLines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, originalVersion.id));
      const sourceOnly = await hasPlatformShipmentAcknowledgement(tx, shipmentId);
      if (shipment.status === "shipped" && !sourceOnly) throw new ConflictException("原发货状态缺少实际交运或平台确认依据 请先人工核对原记录");
      if (sourceOnly && !sameShipmentPlan(originalVersion, originalPackages, originalLines, input))
        throw new ConflictException("平台已有发货确认 这里只能核对并修订生产来源 运单、商品或数量变化须先处理平台差异");
      if (shipment.idempotencyKey.startsWith("whole-order:")) await assertWholeOrderShipment(tx, shipment.orderId, input.packages, shipmentId);
      await assertVersionContent(tx, shipment.orderId, input.packages);
      await assertShipmentProductionSources(tx, shipment.orderId, input.packages, shipmentId);
      const nextVersion = shipment.currentVersionNumber + 1;
      const keepShipos = originalVersion?.shiposSource && originalVersion.shipFromCountryCode === input.shipFromCountryCode
        && originalPackages.length === input.packages.length && input.packages.every(pkg => originalPackages.some(old =>
          old.packageReferenceId === pkg.packageReferenceId && old.trackingNumber === pkg.trackingNumber && old.carrierCode === pkg.carrierCode
          && old.carrierName === pkg.carrierName && old.carrierService === pkg.carrierService && old.labelAssetId === pkg.labelAssetId && old.externalLabelId === pkg.externalLabelId));
      await insertVersion(tx, context, shipmentId, createEntityId(), nextVersion, input, input.idempotencyKey, keepShipos ? originalVersion.shiposSource : null);
      await tx.update(shipments).set({ currentVersionNumber: nextVersion, status: "draft", updatedAt: new Date() })
        .where(and(eq(shipments.id, shipmentId), eq(shipments.currentVersionNumber, input.expectedCurrentVersion)));
      await this.audit.recordInTransaction(tx, context, { action: "shipment.version.append", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: {} });
    });
    return this.get(context, shipmentId);
  }

  /** Record actual handover evidence independently of marketplace writeback. */
  async dispatch(context: TenantContext, shipmentId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    const input = DispatchOrderShipmentInputSchema.parse(raw);
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async (tx) => {
      await lockExistingShipmentOrder(tx, shipmentId);
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
      if (!shipment) throw new NotFoundException("发货单不存在");
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "shipment_dispatch", targetId: shipmentId, input }, fence);
      const [replayed] = await tx.select().from(shipmentTrackingEvents).where(and(eq(shipmentTrackingEvents.shipmentId, shipmentId), eq(shipmentTrackingEvents.externalEventId, input.idempotencyKey)));
      if (replayed) {
        const [oldEvent] = replayed.recordedBy === null ? await tx.select({ actorId: orderWorkEvents.actorId }).from(orderWorkEvents)
          .where(eq(orderWorkEvents.idempotencyKey, input.idempotencyKey)).limit(1) : [];
        if ((replayed.recordedBy ?? oldEvent?.actorId) !== context.userId || replayed.detailCode !== `HANDOVER_${checksum(JSON.stringify(input))}`)
          throw new ConflictException("同一次交运重试的内容或操作员不能改变");
        return;
      }
      if (["draft", "cancelled"].includes(shipment.status) || shipment.approvedVersionNumber !== input.expectedVersion || shipment.currentVersionNumber !== input.expectedVersion) throw new ConflictException("请先审核当前包裹版本");
      if (await hasPhysicalShipmentEvidence(tx, shipmentId)) throw new ConflictException("已有包裹交运记录，请核对逐包物流，不能重复登记整单交运");
      const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId));
      if (!order || order.sideState) throw new ConflictException("订单已暂停或取消");
      const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, input.expectedVersion)));
      if (!version) throw new ConflictException("原包裹版本不可用 请重新核对");
      await assertStoredShipmentProductionSources(tx, order.id, shipmentId, version.id);
      await assertApprovedAllocation(tx, shipment, version.id);
      const allocations = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version!.id));
      if (shipment.idempotencyKey.startsWith("whole-order:")) {
        const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version!.id));
        await assertWholeOrderShipment(tx, order.id, packages.map(pkg => ({ lines: allocations.filter(line => line.packageId === pkg.id) })), shipmentId);
      } else if (!["awaiting_shipment", "shipped"].includes(order.workflowState)) await assertArtworkReady(tx, order.id, allocations, shipmentId);
      const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version!.id));
      await tx.insert(shipmentTrackingEvents).values(packages.map((pkg, index) => ({ id: createEntityId(), tenantId: context.tenantId,
        shipmentId, packageId: pkg.id, status: "picked_up", provider: "manual", externalEventId: index ? `${input.idempotencyKey}:${index}` : input.idempotencyKey,
        detailCode: `HANDOVER_${checksum(JSON.stringify(input))}`, occurredAt: new Date(input.occurredAt), recordedBy: context.userId })));
      for (const lineId of [...new Set(allocations.map((allocation) => allocation.orderLineId))].sort()) {
        await lock(tx, `order-work:${lineId}`);
        const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, lineId));
        if (!work?.encryptedDataKey) continue;
        const reason = this.vault.withSecret(work.encryptedDataKey, (value) => { const key = Buffer.from(value, "base64"); try { return Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(`发货单 ${shipmentId} · ${input.reason}`)))).toString("base64"); } finally { key.fill(0); } });
        await tx.insert(orderWorkEvents).values({ id: createEntityId(), tenantId: context.tenantId, workItemId: lineId, revision: work.revision, action: "dispatch", fromState: "approved", toState: "shipped", actorId: context.userId, encryptedReason: reason, idempotencyKey: input.idempotencyKey, requestHash: checksum(JSON.stringify(input)), occurredAt: new Date(input.occurredAt) });
        await tx.update(orderWorkItems).set({ projectionVersion: work.projectionVersion + 1, updatedAt: new Date() }).where(eq(orderWorkItems.id, lineId));
      }
      await tx.update(shipments).set({ status: "shipped", updatedAt: new Date() }).where(eq(shipments.id, shipmentId));
      await this.audit.recordInTransaction(tx, context, { action: "shipment.manual_handover", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { reasonChecksum: checksum(input.reason), version: input.expectedVersion } });
    });
    return this.get(context, shipmentId);
  }

  async reviewVersion(context: TenantContext, shipmentId: string, versionId: string, rawInput: ReviewShipmentVersionInput, fence?: OrderFulfillmentCommandFence) {
    const input = ReviewShipmentVersionInputSchema.parse(rawInput);
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lockExistingShipmentOrder(tx, shipmentId);
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "shipment_review", targetId: shipmentId, versionId, input }, fence);
      const [replayed] = await tx.select().from(shipmentVersionReviews).where(and(
        eq(shipmentVersionReviews.shipmentId, shipmentId), eq(shipmentVersionReviews.idempotencyKey, input.idempotencyKey),
      )).limit(1);
      if (replayed) {
        const [original] = await tx.select({ versionNumber: shipmentVersions.versionNumber }).from(shipmentVersions).where(eq(shipmentVersions.id, replayed.shipmentVersionId));
        if (replayed.shipmentVersionId !== versionId || replayed.reviewedBy !== context.userId || replayed.decision !== input.decision
          || replayed.reasonCode !== input.reasonCode || replayed.reasonChecksum !== checksum(input.reason) || original?.versionNumber !== input.expectedCurrentVersion)
          throw new ConflictException("同一次包裹审核重试的内容、版本或操作员不能改变");
        return;
      }
      if (shipment.currentVersionNumber !== input.expectedCurrentVersion) throw new ConflictException("Shipment version changed");
      if (!['draft', 'approved'].includes(shipment.status)) throw new ConflictException("A dispatched shipment cannot be reviewed");
      if (await hasPhysicalShipmentEvidence(tx, shipmentId)) throw new ConflictException("A physically dispatched shipment cannot be reviewed");
      const [version] = await tx.select().from(shipmentVersions).where(and(
        eq(shipmentVersions.id, versionId), eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.currentVersionNumber),
      )).limit(1);
      if (!version) throw new NotFoundException("Current shipment version not found");
      const [existingReview] = await tx.select({ id: shipmentVersionReviews.id }).from(shipmentVersionReviews)
        .where(eq(shipmentVersionReviews.shipmentVersionId, versionId)).limit(1);
      if (existingReview) throw new ConflictException("Shipment version already has a final review");
      if (input.decision === "approved") {
        await assertStoredShipmentProductionSources(tx, shipment.orderId, shipmentId, versionId);
        if (shipment.idempotencyKey.startsWith("whole-order:")) {
          const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, versionId));
          const allocations = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, versionId));
          await assertWholeOrderShipment(tx, shipment.orderId, packages.map(pkg => ({ lines: allocations.filter(line => line.packageId === pkg.id) })), shipmentId);
        }
        await assertApprovedAllocation(tx, shipment, versionId);
      }
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
      await this.audit.recordInTransaction(tx, context, { action: "shipment.version.review", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { versionId, decision: input.decision, reasonCode: input.reasonCode } });
    });
    return this.get(context, shipmentId);
  }

  async requestWriteback(context: TenantContext, shipmentId: string, rawInput: RequestShipmentWritebackInput) {
    const input = RequestShipmentWritebackInputSchema.parse(rawInput);
    const requestId = await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lock(tx, `shipment-writeback-create:${shipmentId}`);
      await lock(tx, `shipment:${shipmentId}`);
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
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lock(tx, `shipment-writeback:${requestId}`);
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, requestId)).limit(1);
      if (!request) throw new NotFoundException("Shipment writeback request not found");
      await lock(tx, `shipment:${request.shipmentId}`);
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
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, request.shipmentId));
      const physicallyDispatched = shipment && (await physicalHandover(tx, shipment)).dispatchedPackageCount > 0;
      const shipmentStatus = physicallyDispatched
        ? ["shipped", "in_transit", "delivered", "exception"].includes(shipment.status) ? shipment.status : "shipped"
        : input.action === "accepted" || input.action === "reconcile_accepted" ? "shipped"
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
    let orderId = ""; let shouldComplete = false; let needsException = false; let sourceException = false;
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite], async (tx) => {
      await lockExistingShipmentOrder(tx, shipmentId);
      await lock(tx, `shipment:${shipmentId}`);
      await lock(tx, `shipment-tracking:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).limit(1);
      if (!shipment) throw new NotFoundException("Shipment not found");
      orderId = shipment.orderId;
      const [replayed] = await tx.select().from(shipmentTrackingEvents).where(and(
        eq(shipmentTrackingEvents.provider, input.provider), eq(shipmentTrackingEvents.externalEventId, input.externalEventId),
      )).limit(1);
      if (replayed) {
        if (replayed.shipmentId !== shipmentId || replayed.packageId !== input.packageId || replayed.status !== input.status
          || replayed.detailCode !== input.detailCode || replayed.occurredAt.toISOString() !== new Date(input.occurredAt).toISOString()
          || (replayed.estimatedDeliveryAt?.toISOString() ?? null) !== (input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt).toISOString() : null)
          || (replayed.recordedBy !== null && replayed.recordedBy !== context.userId))
          throw new ConflictException("同一物流事件的内容、包裹或操作员不能改变");
        return;
      }
      const [pkg] = await tx.select({ id: shipmentPackages.id, shipmentVersionId: shipmentPackages.shipmentVersionId }).from(shipmentPackages).where(and(
        eq(shipmentPackages.id, input.packageId), eq(shipmentPackages.shipmentId, shipmentId),
      )).limit(1);
      if (!pkg) throw new NotFoundException("Package not found in this shipment");
      const [version] = await tx.select({ id: shipmentVersions.id, versionNumber: shipmentVersions.versionNumber, promisedDeliveryAt: shipmentVersions.promisedDeliveryAt }).from(shipmentVersions)
        .where(and(eq(shipmentVersions.id, pkg.shipmentVersionId), eq(shipmentVersions.shipmentId, shipmentId))).limit(1);
      if (!version) throw new NotFoundException("Original package version not found");
      if (["picked_up", "in_transit", "out_for_delivery", "delivered", "returned"].includes(input.status)) {
        sourceException = shipment.status === "cancelled" || shipment.currentVersionNumber !== shipment.approvedVersionNumber || version.versionNumber !== shipment.approvedVersionNumber;
        try { await assertStoredShipmentProductionSources(tx, shipment.orderId, shipmentId, version!.id); }
        catch (error) { if (!(error instanceof ConflictException)) throw error; sourceException = true; }
      }
      if (!replayed) {
        await tx.insert(shipmentTrackingEvents).values({
          id: createEntityId(), tenantId: context.tenantId, shipmentId, packageId: input.packageId,
          status: input.status, provider: input.provider, externalEventId: input.externalEventId,
          detailCode: input.detailCode, estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
          occurredAt: new Date(input.occurredAt),
          recordedBy: context.userId,
        });
      }
      const packages = await tx.select({ id: shipmentPackages.id }).from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version!.id));
      const events = await tx.select().from(shipmentTrackingEvents).where(inArray(shipmentTrackingEvents.packageId, packages.map((entry) => entry.id)))
        .orderBy(desc(shipmentTrackingEvents.occurredAt), desc(shipmentTrackingEvents.recordedAt));
      const latest = new Map<string, typeof shipmentTrackingEvents.$inferSelect>();
      for (const event of events) if (!latest.has(event.packageId)) latest.set(event.packageId, event);
      shouldComplete = version.versionNumber === shipment.approvedVersionNumber && packages.length > 0 && packages.every((entry) => latest.get(entry.id)?.status === "delivered");
      needsException = sourceException || ["delivery_exception", "returned"].includes(input.status)
        || Boolean(version!.promisedDeliveryAt && input.estimatedDeliveryAt && new Date(input.estimatedDeliveryAt) > version!.promisedDeliveryAt);
      const physicallyDispatched = (await physicalHandover(tx, shipment)).dispatchedPackageCount > 0;
      const status = shouldComplete || (shipment.status === "delivered" && !needsException) ? "delivered" : needsException ? "exception" : physicallyDispatched ? "in_transit" : shipment.status;
      await tx.update(shipments).set({ status, updatedAt: new Date() }).where(eq(shipments.id, shipmentId));
    });
    if (needsException) await this.orderService.openException(context, orderId, {
      category: "logistics", code: sourceException ? "PRODUCTION_SOURCE_CHANGED_AT_HANDOVER" : input.status === "delivery_exception" || input.status === "returned" ? "DELIVERY_EXCEPTION" : "DELIVERY_DELAYED",
      message: sourceException ? "Physical carrier evidence is preserved; recheck the pinned production source and quality before further fulfillment." : "Carrier tracking requires operational attention.", idempotencyKey: `tracking-exception:${input.provider}:${input.externalEventId}`,
    });
    if (shouldComplete) await this.convergeOrderCompleted(context, orderId, shipmentId);
    await this.audit.record(context, { action: "shipment.tracking.event", resourceType: "shipment", resourceId: shipmentId, result: "success", metadata: { status: input.status, provider: input.provider } });
    return this.get(context, shipmentId);
  }

  /** Evidence of an operator's completed platform check; never submits a marketplace request. */
  async recordManualConfirmation(context: TenantContext, shipmentId: string, raw: unknown, fence?: OrderFulfillmentCommandFence) {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    const input = RecordManualShipmentConfirmationInputSchema.parse(raw);
    if (Date.parse(input.confirmedAt) > Date.now() + 60_000)
      throw new UnprocessableEntityException("平台确认时间不能在未来");
    await withOrderAuthority(this.database.db, context, [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], async (tx) => {
      await lock(tx, `shipment:${shipmentId}`);
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
      if (!shipment) throw new NotFoundException("发货单不存在");
      await assertOrderFulfillmentCommandFence(tx, context, { kind: "shipment_platform_confirmation", targetId: shipmentId, input }, fence);
      const [previous] = await tx.select().from(shipmentManualConfirmations).where(and(
        eq(shipmentManualConfirmations.shipmentId, shipmentId), eq(shipmentManualConfirmations.idempotencyKey, input.idempotencyKey)));
      const requestHash = checksum(JSON.stringify(input));
      if (previous) { if (previous.requestHash !== requestHash || fence && previous.recordedBy !== context.userId) throw new ConflictException("同一次平台核对重试的内容或操作员不能改变"); return; }
      if (shipment.currentVersionNumber !== input.expectedVersion || shipment.approvedVersionNumber !== input.expectedVersion
        || !(await physicalHandover(tx, shipment)).allDispatched)
        throw new ConflictException("请先核对当前包裹并记录实际交运，再登记平台确认");
      const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId));
      if (!order || order.sideState || order.addressStatus === 'anonymized') throw new ConflictException("订单已暂停、取消或清理");
      const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, input.expectedVersion)));
      const allocations = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version!.id));
      for (const lineId of [...new Set(allocations.map((line) => line.orderLineId))].sort()) {
        await lock(tx, `order-work:${lineId}`);
        const [work] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, lineId));
        if (!work?.encryptedDataKey || work.expiresAt <= new Date() || work.archivedAt)
          throw new ConflictException("订单资料已到保存期限或已归档，无法保存平台核对凭证");
        const encryptedReason = this.vault.withSecret(work.encryptedDataKey, (secret) => {
          const key = Buffer.from(secret, "base64");
          try { return Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(
            `发货单 ${shipmentId} · 包裹版本 ${input.expectedVersion} · 平台确认时间 ${input.confirmedAt} · ${input.evidenceReference}`,
          )))).toString("base64"); } finally { key.fill(0); }
        });
        await tx.insert(orderWorkEvents).values({ id: createEntityId(), tenantId: context.tenantId, workItemId: lineId,
          action: "platform_shipment_confirmed", fromState: "unverified", toState: "manually_verified", revision: work.revision,
          encryptedReason, idempotencyKey: input.idempotencyKey, requestHash, actorId: context.userId });
        await tx.update(orderWorkItems).set({ projectionVersion: work.projectionVersion + 1, updatedAt: new Date() }).where(eq(orderWorkItems.id, lineId));
      }
      await tx.insert(shipmentManualConfirmations).values({ id: createEntityId(), tenantId: context.tenantId, shipmentId,
        shipmentVersionId: version!.id, confirmedAt: new Date(input.confirmedAt), recordedBy: context.userId,
        idempotencyKey: input.idempotencyKey, requestHash });
      await this.audit.recordInTransaction(tx, context, { action: "shipment.platform_manually_verified", resourceType: "shipment",
        resourceId: shipmentId, result: "success", metadata: { version: input.expectedVersion, evidenceChecksum: checksum(input.evidenceReference) } });
    });
    return this.get(context, shipmentId);
  }

  async get(context: TenantContext, shipmentId: string) { return originalOwnerOperation(() => new ShipmentReadOwner(this.database).get(context, shipmentId)); }

  async getWriteback(context: TenantContext, requestId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async (tx) => {
      const [request] = await tx.select().from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.id, requestId)).limit(1);
      if (!request) throw new NotFoundException("Shipment writeback request not found");
      const events = await tx.select().from(shipmentWritebackEvents).where(eq(shipmentWritebackEvents.requestId, requestId)).orderBy(asc(shipmentWritebackEvents.sequence));
      return { request, events };
    });
  }

  evidenceIndex(context: TenantContext, orderId: string) { return originalOwnerOperation(() => new ShipmentReadOwner(this.database).evidenceIndex(context, orderId)); }

  list(context: TenantContext, orderId?: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], (tx) => tx.select().from(shipments).where(orderId ? eq(shipments.orderId, orderId) : undefined).orderBy(desc(shipments.updatedAt)));
  }

  productionSources(context: TenantContext, orderId: string, excludeShipmentId?: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const [order] = await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
      if (!order) throw new NotFoundException("订单不存在或无权访问");
      if (excludeShipmentId) {
        const [shipment] = await tx.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, excludeShipmentId));
        if (shipment?.orderId !== orderId) throw new NotFoundException("发货单不属于该订单或无权访问");
      }
      return readShipmentProductionSources(tx, orderId, excludeShipmentId);
    });
  }

  versionEditor(context: TenantContext, shipmentId: string) {
    return withOrderAuthority(this.database.db, context, [Permission.OrderRead], async tx => {
      const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId));
      if (!shipment) throw new NotFoundException("发货单不存在或无权访问");
      const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, shipment.currentVersionNumber)));
      if (!version) throw new ConflictException("原包裹版本不可用 请重新核对");
      const [order] = await tx.select().from(orders).where(eq(orders.id, shipment.orderId));
      const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version.id)).orderBy(asc(shipmentPackages.id));
      const packageLines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version.id)).orderBy(asc(shipmentPackageLines.id));
      const sources = await tx.select().from(shipmentProductionAllocations).where(eq(shipmentProductionAllocations.shipmentVersionId, version.id));
      const lines = await tx.select({ lineId: orderLines.id, title: orderLines.title }).from(orderLines).where(eq(orderLines.orderId, shipment.orderId));
      const blockers: string[] = [];
      if (!["draft", "approved", "shipped"].includes(shipment.status)) blockers.push("当前发货单已交运、取消或正在回传 请先核对实际状态");
      if (await hasPhysicalShipmentEvidence(tx, shipmentId)) blockers.push("本单原包裹已有实际物流记录 请保留原发货版本并处理异常");
      if (!order || order.sideState || order.addressStatus === "anonymized") blockers.push("订单已暂停、取消或资料不可用");
      const sourceOnly = await hasPlatformShipmentAcknowledgement(tx, shipmentId);
      if (shipment.status === "shipped" && !sourceOnly) blockers.push("原发货状态缺少实际交运或平台确认依据 请先人工核对原记录");
      return ShipmentVersionEditorViewSchema.parse({ shipmentId, orderId: shipment.orderId, versionId: version.id, versionNumber: version.versionNumber,
        productionSourceVersion: version.productionSourceVersion, canRevise: blockers.length === 0, blockers, lines, sourceOnly,
        sources: await readShipmentProductionSources(tx, shipment.orderId, shipmentId),
        content: { shipDate: version.shipDate.toISOString(), promisedDeliveryAt: version.promisedDeliveryAt?.toISOString() ?? null,
          estimatedDeliveryAt: version.estimatedDeliveryAt?.toISOString() ?? null, shipFromCountryCode: version.shipFromCountryCode,
          packages: packages.map(pkg => ({ packageReferenceId: pkg.packageReferenceId, trackingNumber: pkg.trackingNumber, carrierCode: pkg.carrierCode,
            carrierName: pkg.carrierName, carrierService: pkg.carrierService, labelAssetId: pkg.labelAssetId, externalLabelId: pkg.externalLabelId,
            labelCostMinor: pkg.labelCostMinor, labelCurrency: pkg.labelCurrency, weightGrams: pkg.weightGrams,
            dimensionsMm: pkg.lengthMm === null ? null : { length: pkg.lengthMm, width: pkg.widthMm, height: pkg.heightMm },
            lines: packageLines.filter(line => line.packageId === pkg.id).map(line => ({ orderLineId: line.orderLineId, quantity: line.quantity,
              ...([1, 2].includes(version.productionSourceVersion ?? 0) ? { productionAllocations: sources.filter(source => source.packageLineId === line.id).map(source => ({
                productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
                ...(source.qualityGroupId ? { qualityGroupId: source.qualityGroupId } : {}),
                expectedProductionProjectionVersion: source.productionProjectionVersion, quantity: source.quantity,
              })) } : {}),
            })),
          })),
        },
      });
    });
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

async function physicalHandover(tx: TenantTransaction, shipment: typeof shipments.$inferSelect) { return originalOwnerOperation(() => readShipmentPhysicalHandover(tx, shipment)); }

async function assertWholeOrderShipment(tx: TenantTransaction, orderId: string, packages: Array<{ lines: Array<{ orderLineId: string; quantity: number }> }>, shipmentId?: string) {
  const { lines } = await lockWholeOrder(tx, orderId);
  if (packages.length !== 1 || packages[0]!.lines.length !== lines.length) throw new ConflictException("整单必须把全部商品装入一个包裹");
  const quantities = new Map(packages[0]!.lines.map(line => [line.orderLineId, line.quantity]));
  if (quantities.size !== lines.length || lines.some(line => quantities.get(line.id) !== line.quantity)) throw new ConflictException("包裹必须包含订单全部商品及完整数量，请重新核对整单");
  await assertWholeOrderActive(tx, orderId);
  await lockWholeOrderProduction(tx, orderId);
  await assertArtworkReady(tx, orderId, packages[0]!.lines, shipmentId);
}

async function insertVersion(
  tx: TenantTransaction, context: TenantContext, shipmentId: string, versionId: string, versionNumber: number,
  input: CreateShipmentInput | AppendShipmentVersionInput, idempotencyKey: string,
  shiposSource: ShiposShipmentSource | null = null,
) {
  await tx.insert(shipmentVersions).values({
    id: versionId, tenantId: context.tenantId, shipmentId, versionNumber, shipDate: new Date(input.shipDate),
    promisedDeliveryAt: input.promisedDeliveryAt ? new Date(input.promisedDeliveryAt) : null,
    estimatedDeliveryAt: input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null,
    shipFromCountryCode: input.shipFromCountryCode, shiposSource, idempotencyKey, createdBy: context.userId,
    productionSourceVersion: 2, requestChecksum: shipmentVersionChecksum(context, input),
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
    for (const line of entry.lines) {
      const packageLineId = createEntityId();
      await tx.insert(shipmentPackageLines).values({
        id: packageLineId, tenantId: context.tenantId, shipmentId, shipmentVersionId: versionId,
        packageId, orderLineId: line.orderLineId, quantity: line.quantity,
      });
      if (!line.productionAllocations?.length) throw new UnprocessableEntityException("新包裹必须记录生产来源");
      await tx.insert(shipmentProductionAllocations).values(line.productionAllocations.map(source => ({
        id: createEntityId(), tenantId: context.tenantId, shipmentId, shipmentVersionId: versionId, packageId,
        packageLineId, orderLineId: line.orderLineId, productionOrderId: source.productionOrderId,
        productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
        qualityGroupId: source.qualityGroupId ?? null, qualityResult: source.qualityGroupId ? null : "passed", groupQualityResult: source.qualityGroupId ? "passed" : null,
        productionProjectionVersion: source.expectedProductionProjectionVersion, quantity: source.quantity,
      })));
    }
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
  const allocations = await tx.execute<{ orderLineId: string; quantity: number }>(sql`select pl.order_line_id as "orderLineId",pl.quantity
    from shipment_package_lines pl join shipment_versions sv on sv.id=pl.shipment_version_id join shipments s on s.id=sv.shipment_id
    where s.order_id=${shipment.orderId} and (sv.id=${versionId}
      or (s.id<>${shipment.id} and s.status<>'cancelled' and sv.version_number=s.approved_version_number)
      or (sv.id<>${versionId} and ${physicalPackageEvidence(sql`pl.package_id`)}))`);
  const totals = new Map<string, number>();
  for (const allocation of allocations) totals.set(allocation.orderLineId, (totals.get(allocation.orderLineId) ?? 0) + allocation.quantity);
  for (const line of orderLineRows) if ((totals.get(line.id) ?? 0) > line.quantity) throw new ConflictException("Approved shipments would exceed ordered quantity");
}

async function lockExistingShipmentOrder(tx: TenantTransaction, shipmentId: string) {
  const [shipment] = await tx.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, shipmentId));
  if (!shipment) throw new NotFoundException("Shipment not found");
  await lockShipmentOrder(tx, shipment.orderId);
}

async function hasPhysicalShipmentEvidence(tx: TenantTransaction, shipmentId: string) {
  return (await tx.select({ id: shipmentPackages.id }).from(shipmentPackages)
    .where(and(eq(shipmentPackages.shipmentId, shipmentId), physicalPackageEvidence(sql`${shipmentPackages.id}`))).limit(1)).length > 0;
}

/** A platform acknowledgement cannot authorize changing its original shipping plan. */
function sameShipmentPlan(version: typeof shipmentVersions.$inferSelect, packages: Array<typeof shipmentPackages.$inferSelect>, lines: Array<typeof shipmentPackageLines.$inferSelect>, input: AppendShipmentVersionInput) {
  const normalized = normalizeShipmentDates(input);
  if (version.shipDate.toISOString() !== new Date(input.shipDate).toISOString()
    || (version.promisedDeliveryAt?.toISOString() ?? null) !== normalized.promisedDeliveryAt
    || (version.estimatedDeliveryAt?.toISOString() ?? null) !== normalized.estimatedDeliveryAt
    || version.shipFromCountryCode !== input.shipFromCountryCode || packages.length !== input.packages.length) return false;
  return input.packages.every(pkg => {
    const old = packages.find(row => row.packageReferenceId === pkg.packageReferenceId);
    if (!old) return false;
    const oldLines = lines.filter(line => line.packageId === old.id);
    return old.trackingNumber === pkg.trackingNumber && old.carrierCode === pkg.carrierCode && old.carrierName === pkg.carrierName && old.carrierService === pkg.carrierService
      && old.labelAssetId === pkg.labelAssetId && old.externalLabelId === pkg.externalLabelId && old.labelCostMinor === pkg.labelCostMinor && old.labelCurrency === pkg.labelCurrency
      && old.weightGrams === pkg.weightGrams && old.lengthMm === (pkg.dimensionsMm?.length ?? null) && old.widthMm === (pkg.dimensionsMm?.width ?? null) && old.heightMm === (pkg.dimensionsMm?.height ?? null)
      && oldLines.length === pkg.lines.length && pkg.lines.every(line => oldLines.some(previous => previous.orderLineId === line.orderLineId && previous.quantity === line.quantity));
  });
}

async function hasPlatformShipmentAcknowledgement(tx: TenantTransaction, shipmentId: string) {
  return (await tx.select({ id: shipmentWritebackRequests.id }).from(shipmentWritebackRequests)
    .where(and(eq(shipmentWritebackRequests.shipmentId, shipmentId), inArray(shipmentWritebackRequests.status, ["accepted", "reconciled"]))).limit(1)).length > 0;
}

function shipmentVersionChecksum(context: TenantContext, input: CreateShipmentInput | AppendShipmentVersionInput) {
  return checksum(canonicalJson({ actor: context.userId, input: normalizeShipmentDates(input) }));
}

function normalizeShipmentDates(input: CreateShipmentInput | AppendShipmentVersionInput) {
  return { ...input, shipDate: new Date(input.shipDate).toISOString(),
    promisedDeliveryAt: input.promisedDeliveryAt === null ? null : new Date(input.promisedDeliveryAt).toISOString(),
    estimatedDeliveryAt: input.estimatedDeliveryAt === null ? null : new Date(input.estimatedDeliveryAt).toISOString() };
}

export async function assertShipmentVersionReplay(tx: TenantTransaction, context: TenantContext, shipmentId: string, input: CreateShipmentInput | AppendShipmentVersionInput, versionNumber: number) {
  const [version] = await tx.select().from(shipmentVersions).where(and(eq(shipmentVersions.shipmentId, shipmentId), eq(shipmentVersions.versionNumber, versionNumber)));
  if (!version || version.createdBy !== context.userId) throw new ConflictException("同一次包裹重试的操作员不能改变");
  if (version.requestChecksum !== null) {
    if (version.requestChecksum !== shipmentVersionChecksum(context, input)) throw new ConflictException("同一次包裹重试的内容不能改变");
    return;
  }
  // Recover legacy receipts from their immutable original columns, never today's production state.
  const packages = await tx.select().from(shipmentPackages).where(eq(shipmentPackages.shipmentVersionId, version.id));
  const lines = await tx.select().from(shipmentPackageLines).where(eq(shipmentPackageLines.shipmentVersionId, version.id));
  const stored = {
    shipDate: version.shipDate.toISOString(), promisedDeliveryAt: version.promisedDeliveryAt?.toISOString() ?? null,
    estimatedDeliveryAt: version.estimatedDeliveryAt?.toISOString() ?? null, shipFromCountryCode: version.shipFromCountryCode,
    idempotencyKey: input.idempotencyKey,
    ...("expectedCurrentVersion" in input ? { expectedCurrentVersion: version.versionNumber - 1 } : {}),
    packages: input.packages.map(pkg => {
      const original = packages.find(row => row.packageReferenceId === pkg.packageReferenceId);
      return original ? { packageReferenceId: original.packageReferenceId, trackingNumber: original.trackingNumber,
        carrierCode: original.carrierCode, carrierName: original.carrierName, carrierService: original.carrierService,
        labelAssetId: original.labelAssetId, externalLabelId: original.externalLabelId,
        labelCostMinor: original.labelCostMinor, labelCurrency: original.labelCurrency, weightGrams: original.weightGrams,
        dimensionsMm: original.lengthMm === null ? null : { length: original.lengthMm, width: original.widthMm, height: original.heightMm },
        lines: pkg.lines.map(line => {
          const old = lines.find(row => row.packageId === original.id && row.orderLineId === line.orderLineId);
          return old ? { orderLineId: old.orderLineId, quantity: old.quantity } : null;
        }),
      } : null;
    }),
  };
  if (packages.length !== input.packages.length || lines.length !== input.packages.reduce((sum, pkg) => sum + pkg.lines.length, 0)
    || canonicalJson(stored) !== canonicalJson(normalizeShipmentDates(input))) throw new ConflictException("同一次历史包裹重试的内容不能改变");
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
