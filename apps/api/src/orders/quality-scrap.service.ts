import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { erpPermissionContext, Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  AllocateQualityScrapInputSchema, QualityScrapHistoryQuerySchema, QualityScrapResultSchema,
  QualityScrapReviewViewSchema, QualityScrapWorkspaceSchema,
  type AllocateQualityScrapInput, type QualityScrapBasis,
} from "@yummyai/contracts/order/quality-scrap";
import {
  productionOrders, qualityScrapAllocations as allocations, qualityScrapReviews as reviews, withTenant,
  type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { currentOrderAuthority, hasTenantOrderPermissions } from "@yummyai/order-core";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { readQualityScrapBasis } from "./quality-scrap-basis.js";
import { assertQualityEvidenceAssets } from "./quality-inspection-evidence.js";

type ReviewRow = typeof reviews.$inferSelect;
const readPermissions = [Permission.OrderRead] as const;
const writePermissions = [Permission.OrderRead, Permission.OrderWrite] as const;
const readOptions = { isolationLevel: "repeatable read", accessMode: "read write" } as const;
const entityId = (value: string) => EntityIdSchema.parse(value).toLowerCase();

function conflict(code: string): never {
  throw new ConflictException({ code, message: "原报废批次或实物组依据已变化 请保留填写并重新核对" });
}

function authority(current: TenantContext) {
  return { contextAuthority: erpSessionAuthority(erpPermissionContext(current)), access: {
    canRead: true as const, canWrite: hasTenantOrderPermissions(current, [Permission.OrderWrite]),
  } };
}

function normalizeInput(raw: unknown): AllocateQualityScrapInput {
  const input = AllocateQualityScrapInputSchema.parse(raw), fraction = /\.(\d+)/.exec(input.occurredAt)?.[1];
  if (fraction && /[1-9]/.test(fraction.slice(3)))
    throw new UnprocessableEntityException({ code: "quality_scrap_time_invalid", message: "报废归属时间须能精确表示到毫秒" });
  return AllocateQualityScrapInputSchema.parse({ ...input,
    productionVersionId: entityId(input.productionVersionId), expectedRootInspectionId: entityId(input.expectedRootInspectionId),
    expectedQuantityReviewId: entityId(input.expectedQuantityReviewId),
    expectedScrapReviewId: input.expectedScrapReviewId === null ? null : entityId(input.expectedScrapReviewId),
    occurredAt: new Date(input.occurredAt).toISOString(), evidenceAssetIds: input.evidenceAssetIds.map(entityId),
    allocations: input.allocations.map(row => ({ ...row, qualityGroupId: entityId(row.qualityGroupId), sourceQuantityReviewId: entityId(row.sourceQuantityReviewId) })),
  });
}

function request(productionOrderId: string, input: AllocateQualityScrapInput) {
  const canonical = canonicalJson({ version: 1, operation: "allocate", productionOrderId, input });
  return { canonical, checksum: createHash("sha256").update(canonical).digest("hex") };
}

function reviewView(row: ReviewRow) {
  return QualityScrapReviewViewSchema.parse({ id: row.id, productionOrderId: row.productionOrderId,
    productionVersionId: row.productionVersionId, rootInspectionId: row.rootInspectionId, quantityReviewId: row.quantityReviewId,
    previousReviewId: row.previousReviewId, input: row.input, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() });
}

function assertBasis(basis: QualityScrapBasis, input: AllocateQualityScrapInput) {
  if (basis.productionVersionId !== input.productionVersionId || basis.projectionVersion !== input.expectedProductionProjectionVersion ||
      basis.rootInspectionId !== input.expectedRootInspectionId || basis.quantityReviewId !== input.expectedQuantityReviewId ||
      basis.scrapReviewId !== input.expectedScrapReviewId || basis.fingerprint !== input.expectedBasisFingerprint)
    conflict("quality_scrap_basis_changed");
  if (basis.blockers.length || basis.rootInspectionId === null || basis.quantityReviewId === null || basis.actualScrappedQuantity === null)
    conflict("quality_scrap_basis_unavailable");
}

function assertAllocationBalances(basis: QualityScrapBasis, input: AllocateQualityScrapInput) {
  const perLot = new Map<string, number>(), perGroup = new Map<string, number>();
  for (const row of input.allocations) {
    const group = basis.groups.find(group => group.qualityGroupId === row.qualityGroupId);
    if (!group || !group.active || group.result !== "failed" || group.allocationBlockers.length)
      conflict("quality_scrap_group_unavailable");
    const lot = basis.lots.find(lot => lot.sourceQuantityReviewId === row.sourceQuantityReviewId);
    if (!lot || lot.scope !== "groupable") conflict("quality_scrap_lot_unavailable");
    perLot.set(row.sourceQuantityReviewId, (perLot.get(row.sourceQuantityReviewId) ?? 0) + row.quantity);
    perGroup.set(row.qualityGroupId, (perGroup.get(row.qualityGroupId) ?? 0) + row.quantity);
  }
  if (input.allocations.reduce((sum, row) => sum + row.quantity, 0) > basis.unassignedQuantity)
    conflict("quality_scrap_quantity_exceeded");
  for (const [lotId, quantity] of perLot)
    if (quantity > basis.lots.find(lot => lot.sourceQuantityReviewId === lotId)!.remainingQuantity)
      conflict("quality_scrap_quantity_exceeded");
  for (const [groupId, quantity] of perGroup)
    if (quantity > basis.groups.find(group => group.qualityGroupId === groupId)!.maxAllocatableQuantity)
      conflict("quality_scrap_quantity_exceeded");
}

/** Preserve exact database timestamps when checking each lot against its group. */
async function assertSourceTimes(tx: TenantTransaction, current: TenantContext, productionOrderId: string, input: AllocateQualityScrapInput) {
  const [time] = await tx.execute<{ valid: boolean }>(sql`select ${input.occurredAt}::timestamptz<=clock_timestamp()
    and exists(select 1 from production_quantity_reviews r where r.tenant_id=${current.tenantId}::uuid
      and r.id=${input.expectedQuantityReviewId}::uuid and r.production_order_id=${productionOrderId}::uuid
      and r.production_version_id=${input.productionVersionId}::uuid
      and ${input.occurredAt}::timestamptz>=(r.input->>'occurredAt')::timestamptz) as valid`);
  if (time?.valid !== true)
    throw new UnprocessableEntityException({ code: "quality_scrap_time_invalid", message: "报废归属发生时间不能早于原数量核准或晚于数据库当前时间" });
  const [sources] = await tx.execute<{ count: number }>(sql`select count(*)::int as count
    from jsonb_to_recordset(${JSON.stringify(input.allocations)}::jsonb) requested("qualityGroupId" uuid,"sourceQuantityReviewId" uuid,quantity integer)
    join quality_inspection_groups g on g.tenant_id=${current.tenantId}::uuid and g.id=requested."qualityGroupId"
    join quality_inspections q on q.tenant_id=g.tenant_id and q.id=g.inspection_id
    join production_quantity_reviews r on r.tenant_id=g.tenant_id and r.id=requested."sourceQuantityReviewId"
    join production_quantity_reports report on report.tenant_id=r.tenant_id and report.id=r.report_id
    where g.production_order_id=${productionOrderId}::uuid and g.production_version_id=${input.productionVersionId}::uuid
      and r.production_order_id=g.production_order_id and r.production_version_id=g.production_version_id
      and q.created_at<=r.created_at and q.created_at<=(report.input->>'observedAt')::timestamptz`);
  if (sources?.count !== input.allocations.length) conflict("quality_scrap_lot_unavailable");
}

@Injectable()
export class QualityScrapService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService) {}

  async workspace(context: TenantContext, productionOrderId: string, rawQuery: unknown = {}) {
    requireTenantOrderPermissions(context, readPermissions);
    productionOrderId = entityId(productionOrderId);
    const query = QualityScrapHistoryQuerySchema.parse(rawQuery), before = query.before && entityId(query.before);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
      const basis = await readQualityScrapBasis(tx, current, productionOrderId);
      if (before && !(await tx.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.id, before), eq(reviews.productionOrderId, productionOrderId)))).length)
        throw new BadRequestException({ code: "quality_scrap_cursor_invalid", message: "报废归属分页位置不属于本生产单" });
      const rows = await tx.select().from(reviews).where(and(eq(reviews.productionOrderId, productionOrderId), before ? lt(reviews.id, before) : undefined))
        .orderBy(desc(reviews.id)).limit(query.limit + 1);
      return QualityScrapWorkspaceSchema.parse({ ...authority(current), basis, reviews: rows.slice(0, query.limit).map(reviewView),
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null });
    }, readOptions);
  }

  async allocate(context: TenantContext, productionOrderId: string, raw: unknown) {
    requireTenantOrderPermissions(context, writePermissions);
    productionOrderId = entityId(productionOrderId);
    const input = normalizeInput(raw), identity = request(productionOrderId, input);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'quality-scrap-request:' + current.tenantId + ':' + input.idempotencyKey},0))`);
      const [previous] = await tx.select().from(reviews).where(eq(reviews.idempotencyKey, input.idempotencyKey));
      if (previous) {
        if (previous.createdBy !== current.userId || previous.productionOrderId !== productionOrderId ||
            previous.requestCanonical !== identity.canonical || previous.requestChecksum !== identity.checksum)
          conflict("quality_scrap_request_mismatch");
        return QualityScrapResultSchema.parse({ ...authority(current), review: reviewView(previous), replayed: true });
      }
      const [production] = await tx.select({ id: productionOrders.id }).from(productionOrders).where(eq(productionOrders.id, productionOrderId));
      if (!production) throw new NotFoundException({ code: "quality_scrap_not_found", message: "生产单不存在或无权访问" });
      await tx.execute(sql`select production_quantity_lock(${current.tenantId}::uuid,${productionOrderId}::uuid)`);
      const basis = await readQualityScrapBasis(tx, current, productionOrderId);
      assertBasis(basis, input);
      assertAllocationBalances(basis, input);
      await assertSourceTimes(tx, current, productionOrderId, input);
      await assertQualityEvidenceAssets(tx, current, { evidenceAssetIds: input.evidenceAssetIds, defects: [] });
      const [row] = await tx.insert(reviews).values({ id: createEntityId(), tenantId: current.tenantId, productionOrderId,
        productionVersionId: basis.productionVersionId, rootInspectionId: input.expectedRootInspectionId, quantityReviewId: input.expectedQuantityReviewId,
        previousReviewId: basis.scrapReviewId, input, idempotencyKey: input.idempotencyKey,
        requestCanonical: identity.canonical, requestChecksum: identity.checksum, creationTransactionId: sql`pg_current_xact_id()::text`, createdBy: current.userId }).returning();
      await tx.insert(allocations).values(input.allocations.map(allocation => ({ id: createEntityId(), tenantId: current.tenantId,
        reviewId: row!.id, productionOrderId, productionVersionId: basis.productionVersionId, qualityGroupId: allocation.qualityGroupId,
        sourceQuantityReviewId: allocation.sourceQuantityReviewId, quantity: allocation.quantity })));
      const [updated] = await tx.update(productionOrders).set({ projectionVersion: basis.projectionVersion + 1, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(productionOrders.id, productionOrderId), eq(productionOrders.projectionVersion, basis.projectionVersion))).returning({ id: productionOrders.id });
      if (!updated) conflict("quality_scrap_basis_changed");
      await this.audit.recordInTransaction(tx, current, { action: "production.quality.scrap_allocated", resourceType: "quality_scrap_review", resourceId: row!.id,
        result: "success", metadata: { productionOrderId, productionVersionId: basis.productionVersionId, rootInspectionId: input.expectedRootInspectionId,
          quantityReviewId: input.expectedQuantityReviewId, allocationCount: input.allocations.length, quantity: input.allocations.reduce((sum, allocation) => sum + allocation.quantity, 0) } });
      return QualityScrapResultSchema.parse({ ...authority(current), review: reviewView(row!), replayed: false });
    });
  }
}
