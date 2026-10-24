import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

const Count = z.int().min(0).max(100_000);
const ReadCount = z.int().nonnegative();
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Key = z.string().trim().min(8).max(200);
const Code = z.string().regex(/^[A-Z0-9_:-]{1,160}$/);
export const ProductionPhysicalQuantitiesSchema = z.object({
  unstartedQuantity: Count.nullable(), inProcessQuantity: Count.nullable(),
  completedQuantity: Count.nullable(), scrappedQuantity: Count.nullable(),
}).strict();
export const ProductionQuantityReportInputSchema = z.object({
  idempotencyKey: Key, productionVersionId: Id, expectedProductionProjectionVersion: z.int().positive(),
  expectedReviewId: Id.nullable(), expectedBasisFingerprint: Fingerprint, observedAt: z.iso.datetime(),
  quantities: ProductionPhysicalQuantitiesSchema, evidenceCode: Code,
  evidenceAssetIds: z.array(Id).max(100),
}).strict().refine(value => new Set(value.evidenceAssetIds).size === value.evidenceAssetIds.length,
  { path: ["evidenceAssetIds"], message: "数量凭证附件不能重复" });
export const ProductionQuantityReviewInputSchema = z.object({
  idempotencyKey: Key, reportId: Id, expectedProductionProjectionVersion: z.int().positive(),
  expectedReviewId: Id.nullable(), expectedBasisFingerprint: Fingerprint,
  stoppedDelta: Count, unstartedAcrossAllPoolsConfirmed: z.boolean(),
  evidenceCode: Code, occurredAt: z.iso.datetime(),
}).strict().refine(value => value.stoppedDelta === 0 || value.unstartedAcrossAllPoolsConfirmed,
  { path: ["unstartedAcrossAllPoolsConfirmed"], message: "停做件须明确在全部绑定资源均未投入" });

export const ProductionQuantityCapacityBasisSchema = z.object({
  reservationId: Id, poolId: Id, poolVersionId: Id, localDate: z.iso.date(), unit: z.enum(["each", "minute"]),
  unitsPerItem: z.int().positive(), totalUnits: z.int().positive(),
  grossCommittedUnits: z.int().nonnegative(), grossReleasedUnits: z.int().nonnegative(),
  stopReleasedUnits: z.int().nonnegative(), stopCommitReductionUnits: z.int().nonnegative(),
}).strict();
export const ProductionQuantityBasisSchema = z.object({
  productionOrderId: Id, orderId: Id, orderLineId: Id, productionVersionId: Id,
  projectionVersion: z.int().positive(), status: z.string(), quantity: z.int().positive(),
  factoryId: Id.nullable(), manufacturingBindingId: Id.nullable(), manufacturingVersionId: Id.nullable(),
  unit: z.enum(["each", "pair", "set"]).nullable(),
  reviewId: Id.nullable(), cumulativeStoppedQuantity: Count,
  currentQuantities: ProductionPhysicalQuantitiesSchema.nullable(),
  groupedQuantity: ReadCount, groupedPassedQuantity: ReadCount, allocatedQuantity: ReadCount, shippedQuantity: ReadCount, completedLowerBound: ReadCount,
  unknownShipmentSource: z.boolean(), capacityStatus: z.enum(["reserved", "legacy_unreserved", "legacy_released"]),
  reservations: z.array(ProductionQuantityCapacityBasisSchema).max(32),
  blockers: z.array(z.string()).max(100), fingerprint: Fingerprint,
}).strict().superRefine((value, context) => {
  if (value.shippedQuantity > value.allocatedQuantity || value.groupedPassedQuantity > value.groupedQuantity || value.completedLowerBound < Math.max(value.groupedPassedQuantity, value.allocatedQuantity))
    context.addIssue({ code: "custom", path: ["completedLowerBound"], message: "实物下界须保留质检与实际分配来源" });
  if (value.currentQuantities && Object.values(value.currentQuantities).every(count => count !== null) &&
      Object.values(value.currentQuantities).reduce<number>((sum, count) => sum + (count ?? 0), 0) + value.cumulativeStoppedQuantity !== value.quantity)
    context.addIssue({ code: "custom", path: ["currentQuantities"], message: "实际数量与已核准停做量须覆盖原数量" });
});
export const ProductionQuantityReportViewSchema = z.object({
  id: Id, productionOrderId: Id, productionVersionId: Id, input: ProductionQuantityReportInputSchema,
  previousReviewId: Id.nullable(), basisFingerprint: Fingerprint, createdBy: Id, createdAt: z.iso.datetime(),
  factoryOrigin: z.object({ kind: z.literal("factory"), assignmentId: Id, acceptedFeedbackId: Id,
    factoryId: Id, factoryName: z.string().min(1).max(500), fileChecksum: Fingerprint,
    manufacturingChecksum: Fingerprint, reference: z.string().min(1).max(200),
  }).strict().optional(),
}).strict();
export const ProductionQuantityReviewViewSchema = z.object({
  id: Id, productionOrderId: Id, productionVersionId: Id, reportId: Id, sequence: z.int().positive(),
  previousReviewId: Id.nullable(), input: ProductionQuantityReviewInputSchema,
  cumulativeStoppedQuantity: Count, quantities: ProductionPhysicalQuantitiesSchema,
  createdBy: Id, createdAt: z.iso.datetime(),
}).strict();
const Authority = { contextAuthority: ErpContextAuthoritySchema, access: z.object({ canRead: z.literal(true), canWrite: z.boolean() }).strict() };
export const ProductionQuantityHistoryQuerySchema = z.object({
  reportsBefore: Id.optional(), reviewsBefore: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export const ProductionQuantityWorkspaceSchema = z.object({ ...Authority, basis: ProductionQuantityBasisSchema,
  reports: z.array(ProductionQuantityReportViewSchema).max(50), reviews: z.array(ProductionQuantityReviewViewSchema).max(50),
  reportsNextCursor: Id.nullable(), reviewsNextCursor: Id.nullable(),
}).strict().superRefine((value, context) => {
  const authority = JSON.parse(value.contextAuthority) as { permissions: string[]; dataScope: string; permissionScopes?: Record<string, string> };
  const can = (permission: string) => authority.permissions.includes(permission) && (authority.permissionScopes ? authority.permissionScopes[permission] : authority.dataScope) === "tenant";
  if (!can("order:read") || value.access.canWrite !== can("order:write")) context.addIssue({ code: "custom", path: ["access"], message: "数量操作权限须匹配当前逐项范围" });
  if (value.reports.some(row => row.productionOrderId !== value.basis.productionOrderId) || value.reviews.some(row => row.productionOrderId !== value.basis.productionOrderId))
    context.addIssue({ code: "custom", path: ["basis"], message: "数量历史须属于原生产单" });
});
export const ProductionQuantityReportResultSchema = z.object({ ...Authority, report: ProductionQuantityReportViewSchema, replayed: z.boolean() }).strict();
export const ProductionQuantityReviewResultSchema = z.object({ ...Authority, review: ProductionQuantityReviewViewSchema, replayed: z.boolean() }).strict();

export type ProductionPhysicalQuantities = z.infer<typeof ProductionPhysicalQuantitiesSchema>;
export type ProductionQuantityBasis = z.infer<typeof ProductionQuantityBasisSchema>;
export type ProductionQuantityReportInput = z.infer<typeof ProductionQuantityReportInputSchema>;
export type ProductionQuantityReviewInput = z.infer<typeof ProductionQuantityReviewInputSchema>;
export type ProductionQuantityWorkspace = z.infer<typeof ProductionQuantityWorkspaceSchema>;
export type ProductionQuantityReportView = z.infer<typeof ProductionQuantityReportViewSchema>;
export type ProductionQuantityReviewView = z.infer<typeof ProductionQuantityReviewViewSchema>;
