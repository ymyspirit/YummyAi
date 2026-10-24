import { Permission, erpPermissionContext, requireTenantOrderPermissions } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { ProductionQuantityHistoryQuerySchema, ProductionQuantityWorkspaceSchema, ProductionQuantityReportViewSchema, ProductionQuantityReviewViewSchema } from "@yummyai/contracts/order/production-quantity";
import { productionQuantityReports as reports, productionQuantityReviews as reviews, factoryQuantityReportOrigins as factoryOrigins, withTenant, type DatabaseConnection } from "@yummyai/database";
import { currentOrderAuthority, hasTenantOrderPermissions } from "./order-authority.js";
import { readProductionQuantityBasis } from "./production-quantity-basis.js";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
type ReportRow=typeof reports.$inferSelect;type ReviewRow=typeof reviews.$inferSelect;
const readPermissions = [Permission.OrderRead] as const;
const readOptions = { isolationLevel: "repeatable read", accessMode: "read write" } as const;
const entityId = (value: string) => EntityIdSchema.parse(value).toLowerCase();
export function productionQuantityAuthority(context: TenantContext) {
  return { contextAuthority: erpSessionAuthority(erpPermissionContext(context)), access: {
    canRead: true as const, canWrite: hasTenantOrderPermissions(context, [Permission.OrderWrite]),
  } };
}
export function productionQuantityReportView(row: ReportRow, origin?: typeof factoryOrigins.$inferSelect) {
  return ProductionQuantityReportViewSchema.parse({ id: row.id, productionOrderId: row.productionOrderId,
    productionVersionId: row.productionVersionId, input: row.input, previousReviewId: row.previousReviewId,
    basisFingerprint: row.basisFingerprint, createdBy: row.createdBy, createdAt: row.createdAt.toISOString(),
    ...(origin ? { factoryOrigin: { kind: "factory", assignmentId: origin.assignmentId,
      acceptedFeedbackId: origin.acceptedFeedbackId, factoryId: origin.factoryId, factoryName: origin.factoryName,
      fileChecksum: origin.input.fileChecksum, manufacturingChecksum: origin.input.manufacturingChecksum,
      reference: origin.input.reference } } : {}),
  });
}
export function productionQuantityReviewView(row: ReviewRow) {
  return ProductionQuantityReviewViewSchema.parse({ id: row.id, productionOrderId: row.productionOrderId,
    productionVersionId: row.productionVersionId, reportId: row.reportId, sequence: row.sequence,
    previousReviewId: row.previousReviewId, input: row.input, cumulativeStoppedQuantity: row.cumulativeStoppedQuantity,
    quantities: row.quantities, createdBy: row.createdBy, createdAt: row.createdAt.toISOString() });
}
export class ProductionQuantityReadOwner { constructor(private readonly database:DatabaseConnection){}
async workspace(context: TenantContext, productionOrderId: string, rawQuery: unknown = {}) {
    requireTenantOrderPermissions(context, readPermissions);
    productionOrderId = entityId(productionOrderId);
    const query = ProductionQuantityHistoryQuerySchema.parse(rawQuery);
    const reportsBefore = query.reportsBefore && entityId(query.reportsBefore), reviewsBefore = query.reviewsBefore && entityId(query.reviewsBefore);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, readPermissions, { requireMembership: true });
      const basis = await readProductionQuantityBasis(tx, current, productionOrderId);
      if (reportsBefore && !(await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, reportsBefore), eq(reports.productionOrderId, productionOrderId)))).length)
        throw new OriginalOwnerError(400, { code: "production_quantity_cursor_invalid", message: "数量报告分页位置不属于本生产单" });
      if (reviewsBefore && !(await tx.select({ id: reviews.id }).from(reviews).where(and(eq(reviews.id, reviewsBefore), eq(reviews.productionOrderId, productionOrderId)))).length)
        throw new OriginalOwnerError(400, { code: "production_quantity_cursor_invalid", message: "数量核准分页位置不属于本生产单" });
      const reportRows = await tx.select().from(reports).where(and(eq(reports.productionOrderId, productionOrderId), reportsBefore ? lt(reports.id, reportsBefore) : undefined))
        .orderBy(desc(reports.id)).limit(query.limit + 1);
      const originRows = reportRows.length ? await tx.select().from(factoryOrigins).where(inArray(factoryOrigins.reportId, reportRows.map(row => row.id))) : [];
      const originByReport = new Map(originRows.map(row => [row.reportId, row]));
      const reviewRows = await tx.select().from(reviews).where(and(eq(reviews.productionOrderId, productionOrderId), reviewsBefore ? lt(reviews.id, reviewsBefore) : undefined))
        .orderBy(desc(reviews.id)).limit(query.limit + 1);
      return ProductionQuantityWorkspaceSchema.parse({ ...productionQuantityAuthority(current), basis,
        reports: reportRows.slice(0, query.limit).map(row => productionQuantityReportView(row, originByReport.get(row.id))), reviews: reviewRows.slice(0, query.limit).map(productionQuantityReviewView),
        reportsNextCursor: reportRows.length > query.limit ? reportRows[query.limit - 1]!.id : null,
        reviewsNextCursor: reviewRows.length > query.limit ? reviewRows[query.limit - 1]!.id : null });
    }, readOptions);
  }
}
