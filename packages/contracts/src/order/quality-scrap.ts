import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

const Count = z.int().min(0).max(100_000);
const ReadCount = z.int().nonnegative();
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const QualityScrapAllocationInputSchema = z.object({
  qualityGroupId: Id, sourceQuantityReviewId: Id, quantity: Count.positive(),
}).strict();
export const AllocateQualityScrapInputSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200), productionVersionId: Id,
  expectedProductionProjectionVersion: z.int().positive(), expectedRootInspectionId: Id,
  expectedQuantityReviewId: Id, expectedScrapReviewId: Id.nullable(), expectedBasisFingerprint: Fingerprint,
  physicalSegregationConfirmed: z.literal(true), occurredAt: z.iso.datetime(),
  evidenceCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/), evidenceAssetIds: z.array(Id).max(100),
  allocations: z.array(QualityScrapAllocationInputSchema).min(1).max(100),
}).strict().superRefine((input, context) => {
  if (new Set(input.evidenceAssetIds).size !== input.evidenceAssetIds.length)
    context.addIssue({ code: "custom", path: ["evidenceAssetIds"], message: "报废归属凭证附件不能重复" });
  if (new Set(input.allocations.map(row => row.qualityGroupId + ":" + row.sourceQuantityReviewId)).size !== input.allocations.length)
    context.addIssue({ code: "custom", path: ["allocations"], message: "同一原组与新增报废批次只能填写一行" });
  if (input.allocations.reduce((sum, row) => sum + row.quantity, 0) > 100_000)
    context.addIssue({ code: "custom", path: ["allocations"], message: "本次报废归属数量超出支持范围" });
});

export const QualityScrapLotSchema = z.object({
  sourceQuantityReviewId: Id, reportId: Id, observedAt: z.iso.datetime(), reviewedAt: z.iso.datetime(),
  quantity: ReadCount.positive(), allocatedQuantity: ReadCount, remainingQuantity: ReadCount,
  scope: z.enum(["groupable", "before_root", "ambiguous", "no_root"]),
}).strict().refine(row => row.allocatedQuantity + row.remainingQuantity === row.quantity,
  { path: ["remainingQuantity"], message: "新增报废批次须保留已归属与未归属的完整余额" });
export const QualityScrapGroupBasisSchema = z.object({
  qualityGroupId: Id, inspectionId: Id, label: z.string(), quantity: ReadCount.positive(),
  inspectionRecordedAt: z.iso.datetime(), active: z.boolean(), result: z.enum(["passed", "failed"]),
  scrappedQuantity: ReadCount, reinspectableQuantity: ReadCount, maxAllocatableQuantity: ReadCount,
  remakeEligible: z.boolean(), remakeQuantity: ReadCount, remainingRemakeQuantity: ReadCount,
  remainingScrapRemakeQuantity: ReadCount, allocatedQuantity: ReadCount,
  allocationBlockers: z.array(z.string()),
}).strict().superRefine((row, context) => {
  if (row.scrappedQuantity > row.quantity || row.reinspectableQuantity > row.quantity - row.scrappedQuantity ||
      !row.active && row.reinspectableQuantity !== 0 || row.remainingScrapRemakeQuantity > row.scrappedQuantity)
    context.addIssue({ code: "custom", path: ["scrappedQuantity"], message: "已报废实物不能重入复检或扩大原组补做量" });
});
export const QualityScrapBasisSchema = z.object({
  productionOrderId: Id, orderId: Id, productionVersionId: Id, projectionVersion: z.int().positive(),
  rootInspectionId: Id.nullable(), quantityReviewId: Id.nullable(), scrapReviewId: Id.nullable(),
  actualScrappedQuantity: ReadCount.nullable(), mappedScrappedQuantity: ReadCount, unassignedQuantity: ReadCount,
  unassignedGroupQuantity: ReadCount, outsideRootQuantity: ReadCount, ambiguousQuantity: ReadCount,
  groups: z.array(QualityScrapGroupBasisSchema), lots: z.array(QualityScrapLotSchema),
  blockers: z.array(z.string()), fingerprint: Fingerprint,
}).strict().superRefine((value, context) => {
  if (value.actualScrappedQuantity !== null && value.mappedScrappedQuantity + value.unassignedQuantity !== value.actualScrappedQuantity ||
      value.unassignedGroupQuantity + value.outsideRootQuantity + value.ambiguousQuantity > value.unassignedQuantity)
    context.addIssue({ code: "custom", path: ["unassignedQuantity"], message: "报废归属余额必须来自原数量核准且不得重复计算" });
});
export const QualityScrapReviewViewSchema = z.object({
  id: Id, productionOrderId: Id, productionVersionId: Id, rootInspectionId: Id, quantityReviewId: Id,
  previousReviewId: Id.nullable(), input: AllocateQualityScrapInputSchema,
  createdBy: Id, createdAt: z.iso.datetime(),
}).strict().refine(value => value.productionVersionId === value.input.productionVersionId &&
  value.rootInspectionId === value.input.expectedRootInspectionId && value.quantityReviewId === value.input.expectedQuantityReviewId &&
  value.previousReviewId === value.input.expectedScrapReviewId,
  { path: ["input"], message: "归属回执必须固定原生产、检验、数量核准及前一归属依据" });
const Authority = {
  contextAuthority: ErpContextAuthoritySchema,
  access: z.object({ canRead: z.literal(true), canWrite: z.boolean() }).strict(),
};
export const QualityScrapHistoryQuerySchema = z.object({
  before: Id.optional(), limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
export const QualityScrapWorkspaceSchema = z.object({
  ...Authority, basis: QualityScrapBasisSchema, reviews: z.array(QualityScrapReviewViewSchema).max(50), nextCursor: Id.nullable(),
}).strict().superRefine((value, context) => {
  const authority = JSON.parse(value.contextAuthority) as { permissions: string[]; dataScope: string; permissionScopes?: Record<string, string> };
  const can = (permission: string) => authority.permissions.includes(permission) && (authority.permissionScopes ? authority.permissionScopes[permission] : authority.dataScope) === "tenant";
  if (!can("order:read") || value.access.canWrite !== can("order:write"))
    context.addIssue({ code: "custom", path: ["access"], message: "归属操作权限须匹配当前逐项范围" });
  if (value.reviews.some(row => row.productionOrderId !== value.basis.productionOrderId))
    context.addIssue({ code: "custom", path: ["reviews"], message: "归属历史须属于原生产单" });
});
export const QualityScrapResultSchema = z.object({ ...Authority, review: QualityScrapReviewViewSchema, replayed: z.boolean() }).strict()
  .superRefine((value, context) => {
    const authority = JSON.parse(value.contextAuthority) as { permissions: string[]; dataScope: string; permissionScopes?: Record<string, string> };
    const can = (permission: string) => authority.permissions.includes(permission) && (authority.permissionScopes ? authority.permissionScopes[permission] : authority.dataScope) === "tenant";
    if (!can("order:read") || value.access.canWrite !== can("order:write"))
      context.addIssue({ code: "custom", path: ["access"], message: "归属回执权限须匹配当前逐项范围" });
  });
export type AllocateQualityScrapInput = z.infer<typeof AllocateQualityScrapInputSchema>;
export type QualityScrapBasis = z.infer<typeof QualityScrapBasisSchema>;
export type QualityScrapGroupBasis = z.infer<typeof QualityScrapGroupBasisSchema>;
export type QualityScrapWorkspace = z.infer<typeof QualityScrapWorkspaceSchema>;
export type QualityScrapReviewView = z.infer<typeof QualityScrapReviewViewSchema>;
