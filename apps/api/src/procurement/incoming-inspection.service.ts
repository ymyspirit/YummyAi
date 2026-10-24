import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { compareStockQuantity, sumStockQuantities, stockQuantityMatchesUnit, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
import { ProcurementUnitSchema, convertProcurementQuantity, pinProcurementStockBasis, type ProcurementUnit } from "@yummyai/contracts/procurement/measurement";
import type { ProcurementPurchaseLineSnapshot } from "@yummyai/contracts/procurement";
import {
  PublishIncomingStandardInputSchema, RecordIncomingArrivalInputSchema, RecordIncomingInspectionInputSchema,
  ReviewIncomingInspectionInputSchema, PostIncomingInspectionInputSchema, ReturnIncomingRejectedInputSchema,
  IncomingStandardViewSchema, IncomingArrivalLineViewSchema, IncomingArrivalViewSchema, IncomingWorkspaceViewSchema,
  evaluateIncomingReadings, incomingLineQuantities,
  type PublishIncomingStandardInput, type RecordIncomingArrivalInput, type RecordIncomingInspectionInput,
  type ReviewIncomingInspectionInput, type PostIncomingInspectionInput, type ReturnIncomingRejectedInput,
} from "@yummyai/contracts/procurement/incoming";
import {
  incomingStandards, procurementArrivals, procurementArrivalLines, incomingInspections, incomingInspectionReviews,
  incomingPostings, incomingReturns, inventoryPurchaseOrders, inventoryPurchaseOrderVersions, inventoryStockItems,
  inventoryLocations, inventoryWarehouses, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { PrepareIncomingCommandSchema, type PrepareIncomingCommand, type IncomingCommandScope } from "@yummyai/contracts/procurement/incoming-command";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { ProcurementService } from "./procurement.service.js";

type Order = typeof inventoryPurchaseOrders.$inferSelect;
type Stock = typeof inventoryStockItems.$inferSelect;
type Line = typeof procurementArrivalLines.$inferSelect;
type Standard = typeof incomingStandards.$inferSelect;
type OriginalRequest = { requestChecksum: string; createdBy: string };
const iso = (value: Date) => value.toISOString();
const requestHash = (parent: string, input: unknown) => createHash("sha256").update(canonicalJson({ version: 1, parent: parent.toLowerCase(), input })).digest("hex");
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }

function checkReplay(row: OriginalRequest, current: TenantContext, checksum: string) {
  if (row.createdBy !== current.userId || row.requestChecksum !== checksum)
    conflict("incoming_request_mismatch", "本次请求与原操作者、业务对象或填写不一致 请先核对原记录");
}
function permitted(context: TenantContext, permission: Permission, ownerId: string | null) {
  try { authorize(context, permission, { ownerId }); return true; }
  catch (error) { if (error instanceof ForbiddenError) return false; throw error; }
}
const standardView = (row: Standard) => IncomingStandardViewSchema.parse({
  id: row.id, stockItemId: row.stockItemId, code: row.code, version: row.versionNumber, title: row.title,
  sourceReference: row.sourceReference, criteria: row.criteria, recordedAt: iso(row.createdAt),
});

@Injectable()
export class IncomingInspectionService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ProcurementService) private readonly procurement: ProcurementService,
    @Inject(AuditService) private readonly audit: AuditService) {}

  publishStandard(context: TenantContext, raw: unknown, transaction?: TenantTransaction) {
    const input = PublishIncomingStandardInputSchema.parse(raw), checksum = requestHash(input.stockItemId, input);
    return this.run(context, transaction, async tx => {
      const current = await this.current(tx, context);
      const stock = await this.stock(tx, current, input.stockItemId, true);
      authorize(current, Permission.ProcurementApprove, { ownerId: stock.createdBy });
      await lock(tx, `incoming-standard-key:${current.tenantId}:${input.idempotencyKey}`);
      const [old] = await tx.select().from(incomingStandards).where(eq(incomingStandards.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return standardView(old); }
      await this.checkStandard(tx, stock, input);
      const [saved] = await tx.insert(incomingStandards).values({ id: createEntityId(), tenantId: current.tenantId,
        stockItemId: stock.id, code: input.code, versionNumber: input.expectedVersion + 1, title: input.title,
        sourceReference: input.sourceReference, criteria: input.criteria, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: current.userId }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.standard.publish", resourceType: "incoming_standard",
        resourceId: saved!.id, result: "success", metadata: { stockItemId: stock.id, version: saved!.versionNumber } });
      return standardView(saved!);
    });
  }

  recordArrival(context: TenantContext, purchaseOrderId: string, raw: unknown, transaction?: TenantTransaction) {
    const input = RecordIncomingArrivalInputSchema.parse(raw), checksum = requestHash(purchaseOrderId, input);
    return this.withOrder(context, purchaseOrderId, Permission.ProcurementWrite, `incoming-arrival-key:${input.idempotencyKey}`, async (tx, current, order) => {
      const [old] = await tx.select().from(procurementArrivals).where(eq(procurementArrivals.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return this.arrivalView(tx, current, order, old); }
      const version = await this.checkArrival(tx, current, order, input);
      const [saved] = await tx.insert(procurementArrivals).values({ id: createEntityId(), tenantId: current.tenantId,
        code: input.code, purchaseOrderId: order.id, purchaseOrderVersionId: version.id, arrivedAt: new Date(input.arrivedAt),
        externalReference: input.externalReference, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: current.userId }).returning();
      await tx.insert(procurementArrivalLines).values(input.lines.map(line => ({ id: createEntityId(), tenantId: current.tenantId, arrivalId: saved!.id,
        lineKey: line.lineKey, stockItemId: version.lineSnapshot.find(item => item.lineKey === line.lineKey)!.stockItemId,
        holdingLocationId: line.holdingLocationId, quantity: line.quantity, unit: line.unit, supplierLotCode: line.lotCode,
        expiresAt: line.expiresAt ? new Date(line.expiresAt) : null, createdBy: current.userId })));
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.arrival.record", resourceType: "procurement_arrival",
        resourceId: saved!.id, result: "success", metadata: { purchaseOrderId: order.id, lineCount: input.lines.length } });
      return this.arrivalView(tx, current, order, saved!);
    }, false, transaction);
  }

  recordInspection(context: TenantContext, arrivalLineId: string, raw: unknown, transaction?: TenantTransaction) {
    const input = RecordIncomingInspectionInputSchema.parse(raw), checksum = requestHash(arrivalLineId, input);
    return this.withLine(context, arrivalLineId, Permission.ProcurementWrite, `incoming-inspection-key:${input.idempotencyKey}`, async (tx, current, order, line) => {
      const [old] = await tx.select().from(incomingInspections).where(eq(incomingInspections.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return this.lineView(tx, current, order, line); }
      const { standard, evaluation } = await this.checkInspection(tx, line, input);
      await tx.insert(incomingInspections).values({ id: createEntityId(), tenantId: current.tenantId, arrivalLineId: line.id,
        standardVersionId: standard.id, versionNumber: input.expectedInspectionVersion + 1,
        acceptedQuantity: input.acceptedQuantity, rejectedQuantity: input.rejectedQuantity, sampleQuantity: input.sampleQuantity,
        unit: line.unit, rejectionReason: input.rejectionReason, measuredAt: new Date(input.measuredAt), readings: input.readings,
        evaluation, notes: input.notes, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: current.userId });
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.inspection.record", resourceType: "procurement_arrival_line",
        resourceId: line.id, result: "success", metadata: { version: input.expectedInspectionVersion + 1, complete: evaluation.complete, passed: evaluation.passed } });
      return this.lineView(tx, current, order, line);
    }, false, transaction);
  }

  reviewInspection(context: TenantContext, arrivalLineId: string, raw: unknown, transaction?: TenantTransaction) {
    const input = ReviewIncomingInspectionInputSchema.parse(raw), checksum = requestHash(arrivalLineId, input);
    return this.withLine(context, arrivalLineId, Permission.ProcurementApprove, `incoming-review-key:${input.idempotencyKey}`, async (tx, current, order, line) => {
      const [old] = await tx.select().from(incomingInspectionReviews).where(eq(incomingInspectionReviews.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return this.lineView(tx, current, order, line); }
      const inspection = await this.checkReview(tx, line, input);
      const [saved] = await tx.insert(incomingInspectionReviews).values({ id: createEntityId(), tenantId: current.tenantId,
        inspectionId: inspection.id, decision: input.decision, reason: input.reason, requestChecksum: checksum,
        idempotencyKey: input.idempotencyKey, createdBy: current.userId }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.inspection.review", resourceType: "incoming_inspection_review",
        resourceId: saved!.id, result: "success", metadata: { arrivalLineId: line.id, inspectionId: inspection.id, decision: input.decision } });
      return this.lineView(tx, current, order, line);
    }, false, transaction);
  }

  postInspection(context: TenantContext, arrivalLineId: string, raw: unknown, transaction?: TenantTransaction) {
    const input = PostIncomingInspectionInputSchema.parse(raw), checksum = requestHash(arrivalLineId, input);
    // Every path that can create the same receipt takes its key before the PO
    // lock. This matches legacy receipt order and avoids an inverse lock cycle.
    return this.withLine(context, arrivalLineId, Permission.ProcurementWrite, `procurement-receipt-idempotency:${input.idempotencyKey}`, async (tx, current, order, line) => {
      const stock = await this.stock(tx, current, line.stockItemId, true);
      authorize(current, Permission.InventoryWrite, { ownerId: stock.createdBy });
      const [old] = await tx.select().from(incomingPostings).where(eq(incomingPostings.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return this.lineView(tx, current, order, line); }
      const { review, arrival, version, original } = await this.checkPosting(tx, current, order, line, stock, input);
      const postingId = createEntityId();
      const receipt = await this.procurement.recordReceiptInTransaction(tx, current, order.id, {
        expectedVersion: version.versionNumber, receivedAt: input.postedAt, externalReference: arrival!.externalReference,
        lines: [{ lineKey: line.lineKey,
          receivedQuantity: incomingPurchaseQuantity(original, stock, input.acceptedQuantity, line.unit),
          rejectedQuantity: incomingPurchaseQuantity(original, stock, input.rejectedQuantity, line.unit),
          rejectionReasonCode: compareStockQuantity(input.rejectedQuantity, 0) > 0 ? "INCOMING_INSPECTION_REJECTED" : null,
          // A unique internal stock segment. The actual supplier lot remains on
          // the immutable arrival line and is never replaced by this code.
          lotCode: compareStockQuantity(input.acceptedQuantity, 0) > 0 ? `IN.${postingId.toUpperCase()}` : null,
          expiresAt: line.expiresAt ? iso(line.expiresAt) : null }], idempotencyKey: input.idempotencyKey,
      }, postingId);
      await tx.insert(incomingPostings).values({ id: postingId, tenantId: current.tenantId, arrivalLineId: line.id,
        approvalId: review.id, receiptId: receipt.receipt.id, acceptedQuantity: input.acceptedQuantity, rejectedQuantity: input.rejectedQuantity,
        unit: line.unit, rejectionLocationId: input.rejectionLocationId, merchantOwnershipConfirmed: input.ownershipConfirmation !== null,
        postedAt: new Date(input.postedAt), requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: current.userId });
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.post", resourceType: "incoming_posting",
        resourceId: postingId, result: "success", metadata: { arrivalLineId: line.id, approvalId: review.id, receiptId: receipt.receipt.id } });
      return this.lineView(tx, current, order, line);
    }, true, transaction);
  }

  returnRejected(context: TenantContext, arrivalLineId: string, postingId: string, raw: unknown, transaction?: TenantTransaction) {
    postingId = postingId.toLowerCase();
    const input = ReturnIncomingRejectedInputSchema.parse(raw), checksum = requestHash(arrivalLineId, { postingId, input });
    return this.withLine(context, arrivalLineId, Permission.ProcurementWrite, `incoming-return-key:${input.idempotencyKey}`, async (tx, current, order, line) => {
      const [old] = await tx.select().from(incomingReturns).where(eq(incomingReturns.idempotencyKey, input.idempotencyKey));
      if (old) { checkReplay(old, current, checksum); return this.lineView(tx, current, order, line); }
      const posting = await this.checkReturn(tx, line, postingId, input);
      const [saved] = await tx.insert(incomingReturns).values({ id: createEntityId(), tenantId: current.tenantId, postingId: posting.id,
        quantity: input.quantity, unit: line.unit, returnedAt: new Date(input.returnedAt), externalReference: input.externalReference,
        reason: input.reason, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: current.userId }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "procurement.incoming.return", resourceType: "incoming_return",
        resourceId: saved!.id, result: "success", metadata: { postingId: posting.id, arrivalLineId: line.id } });
      return this.lineView(tx, current, order, line);
    }, false, transaction);
  }

  line(context: TenantContext, arrivalLineId: string, transaction?: TenantTransaction) {
    return this.withLine(context, arrivalLineId, null, null, (tx, current, order, line) => this.lineView(tx, current, order, line), false, transaction);
  }
  lineWorkspace(context: TenantContext, arrivalLineId: string) {
    return this.withLine(context, arrivalLineId, null, null, async (tx, current, order, line) => ({
      line: await this.lineView(tx, current, order, line), contextAuthority: catalogContextAuthority(current), recordingTime: iso(await databaseNow(tx)),
    }));
  }
  workspace(context: TenantContext, purchaseOrderId: string, transaction?: TenantTransaction) {
    return this.withOrder(context, purchaseOrderId, null, null, async (tx, current, order) => {
      const rows = await tx.select().from(procurementArrivals).where(eq(procurementArrivals.purchaseOrderId, order.id))
        .orderBy(desc(procurementArrivals.createdAt), desc(procurementArrivals.id)).limit(51);
      const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id), eq(inventoryPurchaseOrderVersions.versionNumber, order.currentVersion)));
      if (!version) conflict("incoming_purchase_missing", "原采购版本缺失");
      const stockRows = await Promise.all(version.lineSnapshot.map(line => this.stock(tx, current, line.stockItemId, false)));
      const destinationRows = await Promise.all(version.lineSnapshot.map(line => this.location(tx, current, line.destinationLocationId, false)));
      const locationRows = await tx.select({ location: inventoryLocations, warehouse: inventoryWarehouses }).from(inventoryLocations)
        .innerJoin(inventoryWarehouses, eq(inventoryWarehouses.id, inventoryLocations.warehouseId))
        .where(and(eq(inventoryLocations.status, "active"), eq(inventoryWarehouses.status, "active")))
        .orderBy(inventoryLocations.code, inventoryLocations.id).limit(1001);
      if (locationRows.length > 1000) conflict("incoming_options_limit", "库位较多 需要按仓库读取选项后再操作");
      const ids = [...new Set(version.lineSnapshot.map(line => line.stockItemId))];
      const standards = ids.length ? await tx.select().from(incomingStandards).where(inArray(incomingStandards.stockItemId, ids)).orderBy(desc(incomingStandards.createdAt), desc(incomingStandards.id)).limit(501) : [];
      if (standards.length > 500) conflict("incoming_history_limit", "检验标准历史较多 请按物料读取完整历史");
      return IncomingWorkspaceViewSchema.parse({ purchaseOrderId: order.id, purchaseOrderCode: order.code, receivingPolicy: order.receivingPolicy,
        purchaseOrderVersion: order.currentVersion, purchaseOrderStatus: order.status,
        purchaseLines: version.lineSnapshot.map((line, index) => ({ lineKey: line.lineKey, stockItemId: line.stockItemId, stockName: stockRows[index]!.name,
          stockCode: stockRows[index]!.code, quantity: line.quantity, unit: line.unit, stockBasis: line.stockBasis ?? null, destinationLocationId: line.destinationLocationId,
          destinationLocationName: destinationRows[index]!.name })),
        locations: locationRows.filter(row => permitted(current, Permission.InventoryRead, row.location.createdBy) && permitted(current, Permission.InventoryRead, row.warehouse.createdBy))
          .map(row => ({ id: row.location.id, code: row.location.code, name: row.location.name, warehouseName: row.warehouse.name })),
        arrivals: await Promise.all(rows.slice(0, 50).map(row => this.arrivalView(tx, current, order, row))), standards: standards.map(standardView),
        canRecordArrival: !order.archivedAt && ["approved", "partially_received", "reconciliation_required", "received"].includes(order.status) && permitted(current, Permission.ProcurementWrite, order.createdBy),
        canPublishStandard: stockRows.some(stock => stock.status === "active" && permitted(current, Permission.ProcurementApprove, stock.createdBy)),
        standardWritableStockItemIds: [...new Set(stockRows.filter(stock => stock.status === "active" && permitted(current, Permission.ProcurementApprove, stock.createdBy)).map(stock => stock.id))],
        truncated: rows.length > 50, contextAuthority: catalogContextAuthority(current), recordingTime: iso(await databaseNow(tx)) });
    }, false, transaction);
  }

  private async checkStandard(tx: TenantTransaction, stock: Stock, input: PublishIncomingStandardInput, lockStock = true) {
    if (lockStock) await tx.select({ id: inventoryStockItems.id }).from(inventoryStockItems).where(eq(inventoryStockItems.id, stock.id)).for("update");
    const [previous] = await tx.select().from(incomingStandards).where(and(eq(incomingStandards.stockItemId, stock.id), eq(incomingStandards.code, input.code)))
      .orderBy(desc(incomingStandards.versionNumber)).limit(1);
    if ((previous?.versionNumber ?? 0) !== input.expectedVersion) conflict("incoming_standard_changed", "检验标准版本已变化 请核对最新依据");
  }

  private async checkArrival(tx: TenantTransaction, current: TenantContext, order: Order, input: RecordIncomingArrivalInput) {
    if (order.currentVersion !== input.expectedPurchaseOrderVersion)
      conflict("incoming_purchase_changed", "原采购版本已变化 请先核对采购依据");
    if (!["approved", "partially_received", "reconciliation_required", "received"].includes(order.status))
      conflict("incoming_purchase_unapproved", "请先完成原采购版本审核");
    if (new Date(input.arrivedAt) > await databaseNow(tx)) conflict("incoming_time_invalid", "实到时间尚未发生 请核对实际交接时间");
    const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(and(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id), eq(inventoryPurchaseOrderVersions.versionNumber, order.currentVersion)));
    if (!version) conflict("incoming_purchase_missing", "原采购版本缺失");
    for (const line of input.lines) {
      const original = version.lineSnapshot.find(item => item.lineKey === line.lineKey);
      if (!original) conflict("incoming_unit_unavailable", "实到明细与原采购依据不符 请核对原采购版本");
      const stock = await this.stock(tx, current, original.stockItemId, true);
      incomingPurchaseQuantity(original, stock, line.quantity, line.unit);
      await this.location(tx, current, line.holdingLocationId, true);
    }
    return version;
  }

  private async checkInspection(tx: TenantTransaction, line: Line, input: RecordIncomingInspectionInput, lockStock = true) {
    const [previous] = await tx.select().from(incomingInspections).where(eq(incomingInspections.arrivalLineId, line.id)).orderBy(desc(incomingInspections.versionNumber)).limit(1);
    if ((previous?.versionNumber ?? 0) !== input.expectedInspectionVersion) conflict("incoming_inspection_changed", "检验修订已变化 请核对最新记录");
    const [standard] = await tx.select().from(incomingStandards).where(eq(incomingStandards.id, input.standardVersionId));
    if (!standard || standard.stockItemId !== line.stockItemId) conflict("incoming_standard_unavailable", "检验标准不属于本批原物料");
    if (lockStock) await tx.select({ id: inventoryStockItems.id }).from(inventoryStockItems).where(eq(inventoryStockItems.id, line.stockItemId)).for("update");
    const [latestStandard] = await tx.select({ id: incomingStandards.id }).from(incomingStandards).where(and(eq(incomingStandards.stockItemId, line.stockItemId), eq(incomingStandards.code, standard.code)))
      .orderBy(desc(incomingStandards.versionNumber)).limit(1);
    if (latestStandard?.id !== standard.id) conflict("incoming_standard_changed", "新检验须核对该标准的最新版本 原检验依据保持");
    const [arrival] = await tx.select().from(procurementArrivals).where(eq(procurementArrivals.id, line.arrivalId));
    if (!arrival || new Date(input.measuredAt) < arrival.arrivedAt || new Date(input.measuredAt) > await databaseNow(tx))
      conflict("incoming_time_invalid", "请核对到货后的实际测量时间");
    const disposed = await tx.select().from(incomingPostings).where(eq(incomingPostings.arrivalLineId, line.id));
    if (compareStockQuantity(sumStockQuantities([input.acceptedQuantity, input.rejectedQuantity,
      ...disposed.flatMap(item => [item.acceptedQuantity, item.rejectedQuantity])]), line.quantity) > 0)
      conflict("incoming_quantity_changed", "本次检验超过原到货尚未处置的数量");
    for (const quantity of [input.acceptedQuantity, input.rejectedQuantity, input.sampleQuantity])
      if (!stockQuantityMatchesUnit(quantity, line.unit)) conflict("incoming_unit_unavailable", "检验数量与原单位不符");
    const evaluation = evaluateIncomingReadings(standard.criteria, input.readings);
    return { standard, evaluation };
  }

  private async checkReview(tx: TenantTransaction, line: Line, input: ReviewIncomingInspectionInput) {
    const inspection = await this.inspection(tx, line.id, input.expectedInspectionVersion);
    if (inspection.id !== input.inspectionId) conflict("incoming_inspection_changed", "核准对象与原检验记录不一致");
    if (input.decision === "approved" && (!inspection.evaluation.complete || (compareStockQuantity(inspection.acceptedQuantity, 0) > 0 && !inspection.evaluation.passed)))
      conflict("incoming_measurements_incomplete", "缺测量或不合格记录不能核准为接受库存 不支持自动特采");
    const [review] = await tx.select({ id: incomingInspectionReviews.id }).from(incomingInspectionReviews).where(eq(incomingInspectionReviews.inspectionId, inspection.id));
    if (review) conflict("incoming_inspection_reviewed", "原检验已有核准决定 请追加复检记录而非改写历史");
    return inspection;
  }

  private async checkPosting(tx: TenantTransaction, current: TenantContext, order: Order, line: Line, stock: Stock, input: PostIncomingInspectionInput) {
    const inspection = await this.inspection(tx, line.id, input.expectedInspectionVersion);
    const [review] = await tx.select().from(incomingInspectionReviews).where(eq(incomingInspectionReviews.id, input.approvalId));
    if (!review || review.inspectionId !== inspection.id || review.decision !== "approved") conflict("incoming_approval_unavailable", "本次接受入库缺少原检验核准");
    const [arrival] = await tx.select().from(procurementArrivals).where(eq(procurementArrivals.id, line.arrivalId));
    const [version] = await tx.select().from(inventoryPurchaseOrderVersions).where(eq(inventoryPurchaseOrderVersions.id, arrival!.purchaseOrderVersionId));
    if (!version || order.currentVersion !== version.versionNumber) conflict("incoming_purchase_changed", "原采购版本已变化 请先处理到货依据差异");
    const original = version.lineSnapshot.find(item => item.lineKey === line.lineKey);
    if (!original || original.stockItemId !== stock.id) conflict("incoming_unit_unavailable", "原物料与采购依据不一致");
    incomingPurchaseQuantity(original, stock, input.acceptedQuantity, line.unit);
    incomingPurchaseQuantity(original, stock, input.rejectedQuantity, line.unit);
    if (new Date(input.postedAt) < inspection.measuredAt || new Date(input.postedAt) > await databaseNow(tx))
      conflict("incoming_time_invalid", "请核对检验后的实际入库时间");
    if (compareStockQuantity(input.acceptedQuantity, 0) > 0 && line.expiresAt && line.expiresAt <= new Date(input.postedAt))
      conflict("incoming_goods_expired", "原批次在实际入库时已过期 不能加入可用库存");
    await this.location(tx, current, original.destinationLocationId, true);
    if (input.rejectionLocationId) await this.location(tx, current, input.rejectionLocationId, true);
    const previous = await tx.select().from(incomingPostings).where(eq(incomingPostings.approvalId, review.id));
    if (compareStockQuantity(sumStockQuantities([...previous.map(p => p.acceptedQuantity), input.acceptedQuantity]), inspection.acceptedQuantity) > 0 ||
      compareStockQuantity(sumStockQuantities([...previous.map(p => p.rejectedQuantity), input.rejectedQuantity]), inspection.rejectedQuantity) > 0)
      conflict("incoming_quantity_changed", "本次处置超过原核准剩余数量");
    return { review, arrival, version, original };
  }

  private async checkReturn(tx: TenantTransaction, line: Line, postingId: string, input: ReturnIncomingRejectedInput) {
    const [posting] = await tx.select().from(incomingPostings).where(and(eq(incomingPostings.id, postingId), eq(incomingPostings.arrivalLineId, line.id)));
    if (!posting) throw new NotFoundException("原拒收处置不存在");
    if (new Date(input.returnedAt) < posting.postedAt || new Date(input.returnedAt) > await databaseNow(tx))
      conflict("incoming_time_invalid", "请核对拒收处置后的实际退回时间");
    if (!stockQuantityMatchesUnit(input.quantity, line.unit)) conflict("incoming_unit_unavailable", "退回数量与原单位不符");
    const returned = await tx.select().from(incomingReturns).where(eq(incomingReturns.postingId, posting.id));
    if (compareStockQuantity(sumStockQuantities([...returned.map(item => item.quantity), input.quantity]), posting.rejectedQuantity) > 0)
      conflict("incoming_return_exceeded", "本次退回超过原拒收保管剩余数量");
    return posting;
  }

  private async run<T>(context: TenantContext, transaction: TenantTransaction | undefined, action: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    if (!transaction) return withTenant(this.database.db, context, action);
    const [identity] = await transaction.execute<{ tenant: string; actor: string; role: string }>(sql`select current_setting('app.tenant_id',true) as tenant,current_setting('app.user_id',true) as actor,current_user as role`);
    if (identity?.tenant !== context.tenantId.toLowerCase() || identity.actor !== context.userId.toLowerCase() || identity.role !== "yummyai_app")
      throw new ForbiddenError(Permission.ProcurementRead, "outside_data_scope");
    return action(transaction);
  }

  /** Reads use current authority; an old write ceiling never grants a private read. */
  readCommandTargetInTransaction(tx: TenantTransaction, context: TenantContext, scope: IncomingCommandScope,
    source?: { original?: PrepareIncomingCommand; resultId?: string | null }) {
    if (scope.kind === "publish_standard") return this.run(context, tx, async transaction => {
      const current = await this.current(transaction, context);
      const stock = await this.stock(transaction, current, scope.targetId, false);
      return { targetLabel: `${stock.name} · ${stock.code}`, targetDetail: null };
    });
    if (scope.kind === "record_arrival") return this.withOrder(context, scope.targetId, null, null, async (transaction, current, order) => {
      authorize(current, Permission.InventoryRead);
      if (source?.resultId) {
        const [arrival] = await transaction.select().from(procurementArrivals).where(and(eq(procurementArrivals.id, source.resultId), eq(procurementArrivals.purchaseOrderId, order.id)));
        if (!arrival) throw new NotFoundException("原实际到货结果缺失");
        await this.arrivalView(transaction, current, order, arrival);
      } else if (source?.original?.kind === "record_arrival") {
        const input = source.original.input;
        const [version] = await transaction.select().from(inventoryPurchaseOrderVersions).where(and(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id), eq(inventoryPurchaseOrderVersions.versionNumber, input.expectedPurchaseOrderVersion)));
        if (!version) conflict("incoming_purchase_missing", "原采购版本缺失");
        for (const line of input.lines) {
          const original = version.lineSnapshot.find(row => row.lineKey === line.lineKey);
          if (!original) conflict("incoming_purchase_missing", "原采购明细缺失");
          await this.stock(transaction, current, original.stockItemId, false);
          await this.location(transaction, current, line.holdingLocationId, false);
        }
      }
      return { targetLabel: order.code, targetDetail: null };
    }, false, tx);
    return this.withLine(context, scope.targetId, null, null, async (transaction, current, order, line) => {
      const view = await this.lineView(transaction, current, order, line);
      if (source?.original?.kind === "post_inspection" && source.original.input.rejectionLocationId)
        await this.location(transaction, current, source.original.input.rejectionLocationId, false);
      return { targetLabel: `${view.stockName} · ${view.stockCode}`, targetDetail: `原批号 ${view.supplierLotCode} · ${view.holdingLocationName}` };
    }, false, tx);
  }

  /** Snapshot preflight shares all domain guards with execution, without writing
   * a fact or taking a shared-to-exclusive stock lock in a read request. */
  validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, raw: PrepareIncomingCommand) {
    const command = PrepareIncomingCommandSchema.parse(raw);
    if (command.kind === "publish_standard") return this.run(context, tx, async transaction => {
      const current = await this.current(transaction, context);
      const stock = await this.stock(transaction, current, command.targetId, true);
      authorize(current, Permission.ProcurementApprove, { ownerId: stock.createdBy });
      await this.checkStandard(transaction, stock, command.input, false);
    });
    if (command.kind === "record_arrival") return this.withOrder(context, command.targetId, null, null, async (transaction, current, order) => {
      this.writableOrder(current, order, Permission.ProcurementWrite);
      await this.checkArrival(transaction, current, order, command.input);
    }, false, tx);
    return this.withLine(context, command.targetId, null, null, async (transaction, current, order, line) => {
      this.writableOrder(current, order, command.kind === "review_inspection" ? Permission.ProcurementApprove : Permission.ProcurementWrite);
      const stock = await this.stock(transaction, current, line.stockItemId, true);
      await this.location(transaction, current, line.holdingLocationId, true);
      switch (command.kind) {
        case "record_inspection": await this.checkInspection(transaction, line, command.input, false); break;
        case "review_inspection": await this.checkReview(transaction, line, command.input); break;
        case "post_inspection":
          authorize(current, Permission.InventoryWrite, { ownerId: stock.createdBy });
          await this.checkPosting(transaction, current, order, line, stock, command.input); break;
        case "return_rejected": await this.checkReturn(transaction, line, command.postingId, command.input); break;
      }
    }, false, tx);
  }

  /** Only this owner dispatches business mutations. The caller owns the outer
   * transaction so the actual fact, stock and command outcome commit together. */
  async executeCommandInTransaction(tx: TenantTransaction, context: TenantContext, raw: PrepareIncomingCommand) {
    const command = PrepareIncomingCommandSchema.parse(raw);
    switch (command.kind) {
      case "publish_standard": await this.publishStandard(context, command.input, tx); break;
      case "record_arrival": await this.recordArrival(context, command.targetId, command.input, tx); break;
      case "record_inspection": await this.recordInspection(context, command.targetId, command.input, tx); break;
      case "review_inspection": await this.reviewInspection(context, command.targetId, command.input, tx); break;
      case "post_inspection": await this.postInspection(context, command.targetId, command.input, tx); break;
      case "return_rejected": await this.returnRejected(context, command.targetId, command.postingId, command.input, tx); break;
    }
    const tables = { publish_standard: incomingStandards, record_arrival: procurementArrivals, record_inspection: incomingInspections,
      review_inspection: incomingInspectionReviews, post_inspection: incomingPostings, return_rejected: incomingReturns };
    const table = tables[command.kind];
    const [fact] = await tx.select({ id: table.id, actor: table.createdBy }).from(table).where(eq(table.idempotencyKey, command.input.idempotencyKey));
    if (!fact || fact.actor !== context.userId) conflict("incoming_result_missing", "原操作的实际业务结果缺失");
    return fact.id;
  }

  private writableOrder(current: TenantContext, order: Order, permission: Permission) {
    authorize(current, permission, { ownerId: order.createdBy });
    if (order.archivedAt) conflict("incoming_purchase_archived", "原采购单已归档 请先核对业务状态");
  }

  private async current(tx: TenantTransaction, context: TenantContext) {
    const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
    authorize(current, Permission.ProcurementRead);
    return current;
  }
  private async stock(tx: TenantTransaction, current: TenantContext, id: string, active: boolean) {
    const [row] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, id));
    if (!row) throw new NotFoundException("原物料不存在");
    authorize(current, Permission.InventoryRead, { ownerId: row.createdBy });
    if (active && row.status !== "active") conflict("incoming_stock_inactive", "原物料已停用 请先核对业务状态");
    return row;
  }
  private async location(tx: TenantTransaction, current: TenantContext, id: string, active: boolean) {
    const [row] = await tx.select({ location: inventoryLocations, warehouse: inventoryWarehouses }).from(inventoryLocations)
      .innerJoin(inventoryWarehouses, eq(inventoryWarehouses.id, inventoryLocations.warehouseId)).where(eq(inventoryLocations.id, id));
    if (!row) throw new NotFoundException("实际库位不存在");
    authorize(current, Permission.InventoryRead, { ownerId: row.location.createdBy });
    authorize(current, Permission.InventoryRead, { ownerId: row.warehouse.createdBy });
    if (active && (row.location.status !== "active" || row.warehouse.status !== "active")) conflict("incoming_location_inactive", "实际库位或仓库已停用");
    return row.location;
  }
  private withOrder<T>(context: TenantContext, id: string, permission: Permission | null, key: string | null,
    action: (tx: TenantTransaction, current: TenantContext, order: Order) => Promise<T>, receiptKey = false, transaction?: TenantTransaction) {
    id = id.toLowerCase();
    return this.run(context, transaction, async tx => {
      const current = await this.current(tx, context);
      if (key) await lock(tx, receiptKey ? `${key.split(":")[0]}:${current.tenantId}:${key.slice(key.indexOf(":") + 1)}` : `incoming:${current.tenantId}:${key}`);
      if (permission) await lock(tx, `procurement-order:${current.tenantId}:${id}`);
      const query = tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, id));
      const [order] = permission ? await query.for("update") : await query.for("share");
      if (!order) throw new NotFoundException("原采购单不存在");
      authorize(current, Permission.ProcurementRead, { ownerId: order.createdBy });
      if (permission) this.writableOrder(current, order, permission);
      return action(tx, current, order);
    });
  }
  private async withLine<T>(context: TenantContext, id: string, permission: Permission | null, key: string | null,
    action: (tx: TenantTransaction, current: TenantContext, order: Order, line: Line) => Promise<T>, receiptKey = false, transaction?: TenantTransaction) {
    id = id.toLowerCase();
    // Resolving an immutable parent remains under RLS; no private field escapes
    // before the current PO and inventory grants have been checked again.
    const parent = await this.run(context, transaction, async tx => {
      await this.current(tx, context);
      const [row] = await tx.select({ purchaseOrderId: procurementArrivals.purchaseOrderId }).from(procurementArrivalLines)
        .innerJoin(procurementArrivals, eq(procurementArrivalLines.arrivalId, procurementArrivals.id))
        .where(eq(procurementArrivalLines.id, id));
      return row;
    });
    if (!parent) throw new NotFoundException("原到货明细不存在");
    return this.withOrder(context, parent.purchaseOrderId, permission, key, async (tx, current, order) => {
      await lock(tx, `incoming-line:${current.tenantId}:${id}`);
      const [line] = await tx.select().from(procurementArrivalLines).where(eq(procurementArrivalLines.id, id));
      if (!line) throw new NotFoundException("原到货明细不存在");
      await this.stock(tx, current, line.stockItemId, Boolean(permission));
      await this.location(tx, current, line.holdingLocationId, Boolean(permission));
      return action(tx, current, order, line);
    }, receiptKey, transaction);
  }
  private async inspection(tx: TenantTransaction, lineId: string, version: number) {
    const [row] = await tx.select().from(incomingInspections).where(eq(incomingInspections.arrivalLineId, lineId)).orderBy(desc(incomingInspections.versionNumber)).limit(1);
    if (!row || row.versionNumber !== version) conflict("incoming_inspection_changed", "原检验版本已变化 请核对最新记录");
    return row;
  }
  private async arrivalView(tx: TenantTransaction, current: TenantContext, order: Order, row: typeof procurementArrivals.$inferSelect) {
    const lines = await tx.select().from(procurementArrivalLines).where(eq(procurementArrivalLines.arrivalId, row.id)).orderBy(procurementArrivalLines.lineKey);
    return IncomingArrivalViewSchema.parse({ id: row.id, code: row.code, purchaseOrderId: row.purchaseOrderId,
      purchaseOrderVersionId: row.purchaseOrderVersionId, arrivedAt: iso(row.arrivedAt), externalReference: row.externalReference,
      recordedAt: iso(row.createdAt), lines: await Promise.all(lines.map(line => this.lineView(tx, current, order, line))) });
  }
  private async lineView(tx: TenantTransaction, current: TenantContext, order: Order, row: Line) {
    const stock = await this.stock(tx, current, row.stockItemId, false), location = await this.location(tx, current, row.holdingLocationId, false);
    const inspections = await tx.select().from(incomingInspections).where(eq(incomingInspections.arrivalLineId, row.id)).orderBy(desc(incomingInspections.versionNumber)).limit(2001);
    const postings = await tx.select().from(incomingPostings).where(eq(incomingPostings.arrivalLineId, row.id)).orderBy(desc(incomingPostings.createdAt), desc(incomingPostings.id)).limit(2001);
    if (inspections.length > 2000 || postings.length > 2000) conflict("incoming_history_limit", "来料历史较多 请按版本读取完整历史");
    const reviews = inspections.length ? await tx.select().from(incomingInspectionReviews).where(inArray(incomingInspectionReviews.inspectionId, inspections.map(item => item.id))) : [];
    const returns = postings.length ? await tx.select().from(incomingReturns).where(inArray(incomingReturns.postingId, postings.map(item => item.id))).orderBy(incomingReturns.createdAt, incomingReturns.id).limit(2001) : [];
    if (returns.length > 2000) conflict("incoming_history_limit", "来料退回历史较多 请按处置读取完整历史");
    for (const posting of postings) if (posting.rejectionLocationId) await this.location(tx, current, posting.rejectionLocationId, false);
    const quantities = incomingLineQuantities(row.quantity, sumStockQuantities(postings.map(item => item.acceptedQuantity)),
      sumStockQuantities(postings.map(item => item.rejectedQuantity)), sumStockQuantities(returns.map(item => item.quantity)));
    const active = !order.archivedAt && stock.status === "active" && location.status === "active";
    const write = active && permitted(current, Permission.ProcurementWrite, order.createdBy);
    const latest = inspections[0], review = latest ? reviews.find(item => item.inspectionId === latest.id) : null;
    const approvedUsed = review ? postings.filter(item => item.approvalId === review.id) : [];
    const approvedRemaining = latest ? compareStockQuantity(sumStockQuantities([latest.acceptedQuantity, latest.rejectedQuantity]),
      sumStockQuantities(approvedUsed.flatMap(item => [item.acceptedQuantity, item.rejectedQuantity]))) > 0 : false;
    return IncomingArrivalLineViewSchema.parse({ id: row.id, arrivalId: row.arrivalId, lineKey: row.lineKey, stockItemId: row.stockItemId,
      stockName: stock.name, stockCode: stock.code, holdingLocationId: row.holdingLocationId, holdingLocationName: location.name,
      supplierLotCode: row.supplierLotCode, expiresAt: row.expiresAt ? iso(row.expiresAt) : null, unit: row.unit, quantities,
      inspections: inspections.map(item => { const r = reviews.find(value => value.inspectionId === item.id); return { id: item.id, version: item.versionNumber,
        standardVersionId: item.standardVersionId, acceptedQuantity: item.acceptedQuantity, rejectedQuantity: item.rejectedQuantity,
        sampleQuantity: item.sampleQuantity, rejectionReason: item.rejectionReason, measuredAt: iso(item.measuredAt), readings: item.readings,
        evaluation: item.evaluation, notes: item.notes, recordedAt: iso(item.createdAt), review: r ? { id: r.id, inspectionId: r.inspectionId,
          decision: r.decision, reason: r.reason, recordedAt: iso(r.createdAt) } : null }; }),
      postings: postings.map(item => ({ id: item.id, arrivalLineId: item.arrivalLineId, approvalId: item.approvalId, receiptId: item.receiptId,
        acceptedQuantity: item.acceptedQuantity, rejectedQuantity: item.rejectedQuantity, rejectionLocationId: item.rejectionLocationId,
        merchantOwnershipConfirmed: item.merchantOwnershipConfirmed, postedAt: iso(item.postedAt), recordedAt: iso(item.createdAt),
        returns: returns.filter(value => value.postingId === item.id).map(value => ({ id: value.id, postingId: value.postingId,
          quantity: value.quantity, returnedAt: iso(value.returnedAt), externalReference: value.externalReference, reason: value.reason, recordedAt: iso(value.createdAt) })) })),
      canInspect: write && compareStockQuantity(quantities.pending, 0) > 0,
      canReview: active && Boolean(latest && !review) && permitted(current, Permission.ProcurementApprove, order.createdBy),
      canPost: write && review?.decision === "approved" && permitted(current, Permission.InventoryWrite, stock.createdBy) && approvedRemaining && compareStockQuantity(quantities.pending, 0) > 0,
      canReturn: write && compareStockQuantity(quantities.rejectedHeld, 0) > 0 });
  }
}

function incomingPurchaseQuantity(original: ProcurementPurchaseLineSnapshot, stock: Stock, quantity: StockQuantity, actualUnit: string) {
  try {
    const stockUnit = ProcurementUnitSchema.parse(stock.baseUnit), from = ProcurementUnitSchema.parse(actualUnit);
    if (!original.stockBasis) {
      if (original.unit !== from || original.unit !== stockUnit) throw new RangeError("Legacy conversion unavailable");
    } else {
      const expected = pinProcurementStockBasis(original, stockUnit).stockBasis;
      if (canonicalJson(expected) !== canonicalJson(original.stockBasis)) throw new RangeError("Pinned conversion differs");
    }
    // Validate both paths before recording actual arrival/inspection facts.
    convertProcurementQuantity(quantity, from, stockUnit);
    return convertProcurementQuantity(quantity, from, original.unit as ProcurementUnit);
  } catch {
    conflict("incoming_unit_unavailable", "原采购缺少精确单位换算依据 请核对原版本和实际计量单位");
  }
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);
}
async function databaseNow(tx: TenantTransaction) {
  const [row] = await tx.execute<{ milliseconds: string }>(sql`select floor(extract(epoch from clock_timestamp())*1000)::text as milliseconds`);
  const milliseconds = Number(row?.milliseconds);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Incoming database clock unavailable");
  return new Date(milliseconds);
}
