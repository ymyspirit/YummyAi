import { ProductionQuantityReadOwner, productionQuantityAuthority as sharedProductionQuantityAuthority, productionQuantityReportView as sharedProductionQuantityReportView, productionQuantityReviewView as sharedProductionQuantityReviewView } from "@yummyai/order-core";
import { originalOwnerOperation, rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Permission, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";

import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ProductionQuantityReportInputSchema, ProductionQuantityReviewInputSchema, ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema, type ProductionPhysicalQuantities, type ProductionQuantityBasis, type ProductionQuantityReportInput, type ProductionQuantityReviewInput } from "@yummyai/contracts/order/production-quantity";
import { productionQuantityReports as reports, productionQuantityReviews as reviews, factoryQuantityReportOrigins as factoryOrigins, productionOrders, productionOrderVersions, shipments, factoryCapacityReservations, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentOrderAuthority } from "@yummyai/order-core";
import { and, asc, eq, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { applyProductionQuantityCapacityStop } from "../suppliers/factory-capacity.service.js";
import { readProductionQuantityBasis } from "./production-quantity-basis.js";
import { assertQualityEvidenceAssets } from "./quality-inspection-evidence.js";
import { lockShipmentOrder } from "./shipment-production-sources.js";

type ReportRow = typeof reports.$inferSelect;
type ReviewRow = typeof reviews.$inferSelect;
type Operation = "report" | "review";
type KnownQuantities = { [Key in keyof ProductionPhysicalQuantities]: number };
const writePermissions = [Permission.OrderRead, Permission.OrderWrite] as const;
const entityId = (value: string) => EntityIdSchema.parse(value).toLowerCase();

function conflict(code: string): never {
  throw new ConflictException({ code, message: "原生产数量或实物依据已变化 请保留填写并重新核对" });
}

function authority(context: TenantContext) { try { return sharedProductionQuantityAuthority(context); } catch(error) { rethrowOriginalOwnerError(error); } }

function instant(value: string): string {
  const fraction = /\.(\d+)/.exec(value)?.[1];
  if (fraction && /[1-9]/.test(fraction.slice(3)))
    throw new UnprocessableEntityException({ code: "production_quantity_time_invalid", message: "数量凭证时间须能精确表示到毫秒" });
  return new Date(value).toISOString();
}

function normalizeReport(raw: unknown): ProductionQuantityReportInput {
  const value = ProductionQuantityReportInputSchema.parse(raw);
  return ProductionQuantityReportInputSchema.parse({ ...value, productionVersionId: entityId(value.productionVersionId),
    expectedReviewId: value.expectedReviewId === null ? null : entityId(value.expectedReviewId),
    observedAt: instant(value.observedAt), evidenceAssetIds: value.evidenceAssetIds.map(entityId) });
}

function normalizeReview(raw: unknown): ProductionQuantityReviewInput {
  const value = ProductionQuantityReviewInputSchema.parse(raw);
  return { ...value, reportId: entityId(value.reportId),
    expectedReviewId: value.expectedReviewId === null ? null : entityId(value.expectedReviewId), occurredAt: instant(value.occurredAt) };
}

function request(operation: Operation, productionOrderId: string, input: ProductionQuantityReportInput | ProductionQuantityReviewInput) {
  const canonical = canonicalJson({ version: 1, operation, productionOrderId, input });
  return { canonical, checksum: createHash("sha256").update(canonical).digest("hex") };
}

function reportView(row: ReportRow, origin?: typeof factoryOrigins.$inferSelect) { try { return sharedProductionQuantityReportView(row, origin); } catch(error) { rethrowOriginalOwnerError(error); } }

function reviewView(row: ReviewRow) { try { return sharedProductionQuantityReviewView(row); } catch(error) { rethrowOriginalOwnerError(error); } }

async function requestLock(tx: TenantTransaction, current: TenantContext, operation: Operation, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'production-quantity-request:' + current.tenantId + ':' + operation + ':' + key},0))`);
}

export function lockProductionQuantityReportRequest(tx: TenantTransaction, current: TenantContext, key: string) {
  return requestLock(tx, current, "report", key);
}

function assertReplay(row: ReportRow | ReviewRow, current: TenantContext, productionOrderId: string, identity: ReturnType<typeof request>) {
  if (row.createdBy !== current.userId || row.productionOrderId !== productionOrderId ||
      row.requestCanonical !== identity.canonical || row.requestChecksum !== identity.checksum)
    conflict("production_quantity_request_mismatch");
}

/** Serialize with the existing shipment, QC, recovery and capacity owners. */
async function lockBasis(tx: TenantTransaction, productionOrderId: string) {
  const [source] = await tx.select({ orderId: productionOrders.orderId, factoryId: productionOrders.factoryId })
    .from(productionOrders).where(eq(productionOrders.id, productionOrderId));
  if (!source) throw new NotFoundException({ code: "production_quantity_not_found", message: "生产单不存在或无权访问" });
  await lockShipmentOrder(tx, source.orderId);
  const relatedShipments = await tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, source.orderId)).orderBy(asc(shipments.id));
  for (const row of relatedShipments)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'shipment:' + row.id},0))`);
  const reservations = await tx.select({ factoryId: factoryCapacityReservations.factoryId, poolId: factoryCapacityReservations.poolId,
    localDate: factoryCapacityReservations.localDate }).from(factoryCapacityReservations)
    .where(eq(factoryCapacityReservations.productionOrderId, productionOrderId));
  const factoryIds = [...new Set([source.factoryId, ...reservations.map(row => row.factoryId)].filter((value): value is string => value !== null))].sort();
  for (const factoryId of factoryIds)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'factory:' + factoryId}))`);
  for (const poolId of [...new Set(reservations.map(row => row.poolId))].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'factory-capacity-pool:' + poolId},0))`);
  for (const day of [...new Set(reservations.map(row => row.poolId + ':' + row.localDate))].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'factory-capacity-day:' + day},0))`);
}

function assertBasis(basis: ProductionQuantityBasis, input: {
  expectedProductionProjectionVersion: number; expectedReviewId: string | null; expectedBasisFingerprint: string;
}) {
  if (basis.projectionVersion !== input.expectedProductionProjectionVersion || basis.reviewId !== input.expectedReviewId ||
      basis.fingerprint !== input.expectedBasisFingerprint) conflict("production_quantity_basis_changed");
}

function knownQuantities(value: ProductionPhysicalQuantities): KnownQuantities {
  if (value.unstartedQuantity === null || value.inProcessQuantity === null || value.completedQuantity === null || value.scrappedQuantity === null)
    conflict("production_quantity_counts_unknown");
  return { unstartedQuantity: value.unstartedQuantity, inProcessQuantity: value.inProcessQuantity,
    completedQuantity: value.completedQuantity, scrappedQuantity: value.scrappedQuantity };
}

async function assertNotFuture(tx: TenantTransaction, value: string) {
  const [row] = await tx.execute<{ valid: boolean }>(sql`select ${value}::timestamptz<=clock_timestamp() as valid`);
  if (row?.valid !== true)
    throw new UnprocessableEntityException({ code: "production_quantity_time_invalid", message: "数量凭证发生时间不能晚于数据库当前时间" });
}

/** Trusted internal append; callers own live authority and any additional provenance. */
export async function appendProductionQuantityReport(tx: TenantTransaction, current: TenantContext,
  productionOrderId: string, raw: unknown, audit: AuditService): Promise<{ row: ReportRow; replayed: boolean }> {
  productionOrderId = entityId(productionOrderId);
  const input = normalizeReport(raw), identity = request("report", productionOrderId, input);
  await lockProductionQuantityReportRequest(tx, current, input.idempotencyKey);
  const [previous] = await tx.select().from(reports).where(eq(reports.idempotencyKey, input.idempotencyKey));
  if (previous) {
    assertReplay(previous, current, productionOrderId, identity);
    return { row: previous, replayed: true };
  }
  await lockBasis(tx, productionOrderId);
  const basis = await readProductionQuantityBasis(tx, current, productionOrderId);
  assertBasis(basis, input);
  if (basis.productionVersionId !== input.productionVersionId) conflict("production_quantity_basis_changed");
  const knownTotal = Object.values(input.quantities).filter((value): value is number => value !== null).reduce((sum, value) => sum + value, 0);
  if (knownTotal + basis.cumulativeStoppedQuantity > basis.quantity) conflict("production_quantity_balance_invalid");
  const [versionTime] = await tx.select({ valid: sql<boolean>`${input.observedAt}::timestamptz>=${productionOrderVersions.createdAt}` })
    .from(productionOrderVersions).where(and(eq(productionOrderVersions.id, basis.productionVersionId), eq(productionOrderVersions.productionOrderId, productionOrderId)));
  if (versionTime?.valid !== true)
    throw new UnprocessableEntityException({ code: "production_quantity_time_invalid", message: "数量凭证发生时间不能早于原生产版本" });
  await assertNotFuture(tx, input.observedAt);
  await assertQualityEvidenceAssets(tx, current, { evidenceAssetIds: input.evidenceAssetIds, defects: [] });
  const [row] = await tx.insert(reports).values({ id: createEntityId(), tenantId: current.tenantId, productionOrderId,
    productionVersionId: basis.productionVersionId, previousReviewId: basis.reviewId, basisFingerprint: basis.fingerprint,
    input, idempotencyKey: input.idempotencyKey, requestCanonical: identity.canonical, requestChecksum: identity.checksum, createdBy: current.userId }).returning();
  await audit.recordInTransaction(tx, current, { action: "production.quantity.report_recorded", resourceType: "production_quantity_report", resourceId: row!.id,
    result: "success", metadata: { productionOrderId, productionVersionId: basis.productionVersionId } });
  return { row: row!, replayed: false };
}

@Injectable()
export class ProductionQuantityService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService) {}

  async workspace(context: TenantContext, productionOrderId: string, rawQuery: unknown = {}) { return originalOwnerOperation(() => new ProductionQuantityReadOwner(this.database).workspace(context, productionOrderId, rawQuery)); }

  async recordReport(context: TenantContext, productionOrderId: string, raw: unknown) {
    requireTenantOrderPermissions(context, writePermissions);
    productionOrderId = entityId(productionOrderId);
    const input = normalizeReport(raw);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
      const { row, replayed } = await appendProductionQuantityReport(tx, current, productionOrderId, input, this.audit);
      if (!replayed && input.idempotencyKey.startsWith("factory-quantity:"))
        throw new UnprocessableEntityException({ code: "production_quantity_key_reserved", message: "此请求标识由工厂原报告使用" });
      const [origin] = await tx.select().from(factoryOrigins).where(eq(factoryOrigins.reportId, row.id));
      return ProductionQuantityReportResultSchema.parse({ ...authority(current), report: reportView(row, origin), replayed });
    });
  }

  async review(context: TenantContext, productionOrderId: string, raw: unknown) {
    requireTenantOrderPermissions(context, writePermissions);
    productionOrderId = entityId(productionOrderId);
    const input = normalizeReview(raw), identity = request("review", productionOrderId, input);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, writePermissions, { requireMembership: true });
      await requestLock(tx, current, "review", input.idempotencyKey);
      const [previous] = await tx.select().from(reviews).where(eq(reviews.idempotencyKey, input.idempotencyKey));
      if (previous) {
        assertReplay(previous, current, productionOrderId, identity);
        return ProductionQuantityReviewResultSchema.parse({ ...authority(current), review: reviewView(previous), replayed: true });
      }
      await lockBasis(tx, productionOrderId);
      const basis = await readProductionQuantityBasis(tx, current, productionOrderId);
      assertBasis(basis, input);
      if (basis.blockers.length || basis.capacityStatus !== "reserved" || !basis.manufacturingBindingId || !basis.reservations.length)
        conflict("production_quantity_basis_unavailable");
      const [report] = await tx.select().from(reports).where(and(eq(reports.id, input.reportId), eq(reports.productionOrderId, productionOrderId)));
      if (!report) throw new NotFoundException({ code: "production_quantity_report_not_found", message: "数量报告不存在或不属于本生产单" });
      if (report.productionVersionId !== basis.productionVersionId || report.previousReviewId !== basis.reviewId || report.basisFingerprint !== basis.fingerprint)
        conflict("production_quantity_basis_changed");
      if ((await tx.select({ id: reviews.id }).from(reviews).where(eq(reviews.reportId, report.id))).length)
        conflict("production_quantity_report_reviewed");
      const quantities = knownQuantities(report.input.quantities);
      if (Object.values(quantities).reduce((sum, value) => sum + value, 0) + basis.cumulativeStoppedQuantity !== basis.quantity ||
          input.stoppedDelta > quantities.unstartedQuantity) conflict("production_quantity_balance_invalid");
      if (quantities.completedQuantity + quantities.scrappedQuantity < basis.groupedQuantity || quantities.completedQuantity < basis.completedLowerBound)
        conflict("production_quantity_lower_bound_conflict");
      if (basis.currentQuantities) {
        const prior = knownQuantities(basis.currentQuantities);
        if (quantities.scrappedQuantity < prior.scrappedQuantity ||
            quantities.completedQuantity + quantities.scrappedQuantity < prior.completedQuantity + prior.scrappedQuantity ||
            quantities.inProcessQuantity + quantities.completedQuantity + quantities.scrappedQuantity < prior.inProcessQuantity + prior.completedQuantity + prior.scrappedQuantity)
          conflict("production_quantity_lower_bound_conflict");
      }
      await assertNotFuture(tx, input.occurredAt);
      if (Date.parse(input.occurredAt) < Date.parse(report.input.observedAt))
        throw new UnprocessableEntityException({ code: "production_quantity_time_invalid", message: "核准发生时间不能早于原数量报告" });
      const [priorReview] = basis.reviewId ? await tx.select().from(reviews).where(eq(reviews.id, basis.reviewId)) : [];
      if (basis.reviewId && !priorReview) conflict("production_quantity_basis_changed");
      if (priorReview && Date.parse(input.occurredAt) < Date.parse(priorReview.input.occurredAt))
        throw new UnprocessableEntityException({ code: "production_quantity_time_invalid", message: "新核准发生时间不能早于原数量核准" });
      await assertQualityEvidenceAssets(tx, current, { evidenceAssetIds: report.input.evidenceAssetIds, defects: [] });
      const [row] = await tx.insert(reviews).values({ id: createEntityId(), tenantId: current.tenantId, productionOrderId,
        productionVersionId: basis.productionVersionId, reportId: report.id, sequence: (priorReview?.sequence ?? 0) + 1, previousReviewId: basis.reviewId,
        input, quantities: { ...quantities, unstartedQuantity: quantities.unstartedQuantity - input.stoppedDelta },
        stoppedDelta: input.stoppedDelta, cumulativeStoppedQuantity: basis.cumulativeStoppedQuantity + input.stoppedDelta,
        idempotencyKey: input.idempotencyKey, requestCanonical: identity.canonical, requestChecksum: identity.checksum,
        creationTransactionId: sql`pg_current_xact_id()::text`, createdBy: current.userId }).returning();
      await applyProductionQuantityCapacityStop(tx, current, row!.id);
      const [updated] = await tx.update(productionOrders).set({ projectionVersion: basis.projectionVersion + 1, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(productionOrders.id, productionOrderId), eq(productionOrders.projectionVersion, basis.projectionVersion))).returning({ id: productionOrders.id });
      if (!updated) conflict("production_quantity_basis_changed");
      await this.audit.recordInTransaction(tx, current, { action: "production.quantity.reviewed", resourceType: "production_quantity_review", resourceId: row!.id,
        result: "success", metadata: { productionOrderId, productionVersionId: basis.productionVersionId, reportId: report.id, sequence: row!.sequence, stoppedDelta: input.stoppedDelta } });
      return ProductionQuantityReviewResultSchema.parse({ ...authority(current), review: reviewView(row!), replayed: false });
    });
  }
}
