import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { FinanceFactViewSchema } from "@yummyai/contracts/finance";

export const OrderReviewQuerySchema = z.object({
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  platform: z.enum(["amazon", "etsy"]).optional(),
  sku: z.string().trim().min(1).max(150).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.from && value.to && (Date.parse(value.from) >= Date.parse(value.to)
    || Date.parse(value.to) - Date.parse(value.from) > 93 * 86400000))
    ctx.addIssue({ code: "custom", path: ["to"], message: "请选择不超过 93 天的有效期间" });
});
export const OrderReviewEventSchema = z.object({
  id: Id, stage: z.enum(["intake", "artwork", "review", "factory", "production", "handover", "recovery"]),
  label: z.string(), occurredAt: z.iso.datetime(), reference: z.string().nullable(),
  versionId: Id.nullable(), versionNumber: z.int().nonnegative().nullable(),
  note: z.string().nullable(),
}).strict();
const Duration = z.object({
  label: z.string(), from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable(),
  minutes: z.number().nonnegative().nullable(), status: z.enum(["complete", "pending", "unknown", "invalid"]),
}).strict();
const Profit = z.object({
  status: z.enum(["verified", "incomplete", "unavailable"]),
  runId: Id.nullable(), metricVersionId: Id.nullable(), metricVersion: z.int().positive().nullable(),
  allocationRunId: Id.nullable().optional(), allocationVersionSetChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  allocationDimension: z.enum(["order", "order_line", "sku", "listing", "period"]).nullable().optional(),
  calculatedAt: z.iso.datetime().nullable(), currency: z.string().nullable(),
  revenueMinor: z.int().safe().nullable(), costMinor: z.int().safe().nullable(), profitMinor: z.int().safe().nullable(),
  blockers: z.array(z.string()),
  lines: z.array(z.object({ lineId: Id, revenueMinor: z.int().safe(), costMinor: z.int().safe(), profitMinor: z.int().safe() }).strict()),
}).strict();
export const OrderReviewLineSchema = z.object({
  id: Id, skuCode: z.string().nullable(), title: z.string(), quantity: z.int().positive(),
  skuId: Id.nullable(), recipeVersionId: Id.nullable(), recipeVersionNumber: z.int().positive().nullable(),
  specification: z.string().nullable(), specificationVersionId: Id.nullable().default(null),
  specificationVersionNumber: z.int().positive().nullable().default(null), profileVersionId: Id.nullable(),
  basisStatus: z.enum(["pinned", "missing", "expired"]),
  factoryId: Id.nullable(), factoryName: z.string().nullable(), factoryStatus: z.enum(["pinned", "missing", "multiple", "unknown"]),
  events: z.array(OrderReviewEventSchema), durations: z.array(Duration),
  deadline: z.object({
    shipByAt: z.iso.datetime().nullable(), handedOverAt: z.iso.datetime().nullable(),
    handedOverQuantity: z.int().nonnegative(),
    status: z.enum(["unknown", "pending", "on_time", "late", "overdue"]), lateMinutes: z.number().nonnegative().nullable(),
  }).strict(),
  reviewRejections: z.int().nonnegative().nullable(), factoryRejections: z.int().nonnegative().nullable(),
  remakeCount: z.int().nonnegative().nullable(), remakeQuantity: z.int().nonnegative().nullable(),
  blockers: z.array(z.string()),
}).strict();
export const OrderReviewCostEvidenceSchema = z.object({
  id: Id, lineId: Id.nullable(), source: z.enum(["model", "factory", "refund", "shipment"]),
  current: z.boolean().default(true),
  basis: z.enum(["quote", "confirmed", "unknown", "not_required"]),
  amountMinor: z.int().safe().nonnegative().nullable(), amountUsd: z.number().nonnegative().nullable(),
  currency: z.string().nullable(), reference: z.string().nullable(),
  ledgerFactIds: z.array(Id), note: z.string(),
}).strict();
export const OrderReviewReworkSchema = z.object({
  id: Id, lineId: Id, source: z.enum(["review", "factory", "recovery"]), kind: z.string(),
  occurredAt: z.iso.datetime(), reference: z.string().nullable(), reason: z.string(),
  originalProductionOrderId: Id.nullable(), replacementProductionOrderId: Id.nullable(),
  originalVersionId: Id.nullable(), originalVersionNumber: z.int().positive().nullable(),
  replacementVersionId: Id.nullable(), replacementVersionNumber: z.int().positive().nullable(),
  affectedQuantity: z.int().positive().nullable(),
}).strict();
export const OrderReviewViewSchema = z.object({
  orderId: Id, externalOrderId: z.string(), placedAt: z.iso.datetime(), builtAt: z.iso.datetime(),
  lines: z.array(OrderReviewLineSchema).min(1).max(100),
  facts: z.array(FinanceFactViewSchema), costs: z.array(OrderReviewCostEvidenceSchema),
  profit: Profit, rework: z.array(OrderReviewReworkSchema), diagnostics: z.array(z.string()),
}).strict();
export const OrderSkuReviewSchema = z.object({
  skuCode: z.string().nullable(), skuId: Id.nullable(), recipeVersionId: Id.nullable(),
  recipeVersionNumber: z.int().positive().nullable(), specification: z.string().nullable(),
  specificationVersionId: Id.nullable().default(null), specificationVersionNumber: z.int().positive().nullable().default(null), profileVersionId: Id.nullable(),
  factoryId: Id.nullable(), factoryName: z.string().nullable(), factoryStatus: OrderReviewLineSchema.shape.factoryStatus,
  orderCount: z.int().nonnegative(), lineCount: z.int().nonnegative(), quantity: z.int().nonnegative(),
  onTime: z.int().nonnegative(), late: z.int().nonnegative(), overdue: z.int().nonnegative(),
  pending: z.int().nonnegative(), unknownDeadline: z.int().nonnegative(), onTimeBps: z.int().min(0).max(10000).nullable(),
  reviewRejections: z.int().nonnegative().nullable(), factoryRejections: z.int().nonnegative().nullable(),
  remakeLineCount: z.int().nonnegative().nullable(), remakeCount: z.int().nonnegative().nullable(), remakeQuantity: z.int().nonnegative().nullable(),
  remakeBps: z.int().min(0).max(10000).nullable(),
  verifiedProfitLines: z.int().nonnegative(), unallocatedProfitLines: z.int().nonnegative(),
  profitTotals: z.array(z.object({
    currency: z.string(), metricVersionId: Id, metricVersion: z.int().positive(),
    allocationVersionSetChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    allocationDimension: z.enum(["order", "order_line", "sku", "listing", "period"]).nullable().optional(),
    revenueMinor: z.int().safe(), costMinor: z.int().safe(), profitMinor: z.int().safe(), lineCount: z.int().nonnegative(),
  }).strict()),
}).strict();
export const OrderReviewWorkspaceSchema = z.object({
  from: z.iso.datetime(), to: z.iso.datetime(), builtAt: z.iso.datetime(),
  orderCount: z.int().nonnegative(), totalOrderCount: z.int().nonnegative(), truncated: z.boolean(),
  failedOrderCount: z.int().nonnegative(), diagnostics: z.array(z.string()),
  groups: z.array(OrderSkuReviewSchema),
  orders: z.array(z.object({
    orderId: Id, lineId: Id, externalOrderId: z.string(), profitStatus: Profit.shape.status,
    reworkCount: z.int().nonnegative(), diagnostics: z.array(z.string()),
  }).strict()),
}).strict();
export type OrderReviewQuery = z.infer<typeof OrderReviewQuerySchema>;
export type OrderReviewEvent = z.infer<typeof OrderReviewEventSchema>;
export type OrderReviewLine = z.infer<typeof OrderReviewLineSchema>;
export type OrderReviewCostEvidence = z.infer<typeof OrderReviewCostEvidenceSchema>;
export type OrderReviewRework = z.infer<typeof OrderReviewReworkSchema>;
export type OrderReviewView = z.infer<typeof OrderReviewViewSchema>;
export type OrderReviewWorkspace = z.infer<typeof OrderReviewWorkspaceSchema>;
export type OrderSkuReview = z.infer<typeof OrderSkuReviewSchema>;
