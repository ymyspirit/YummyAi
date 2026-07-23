import { z } from "zod";

import { EntityIdSchema } from "../common/ids.js";

export const ProductionOrderStatusSchema = z.enum([
  "planned", "submitted", "acknowledged", "in_production", "quality_hold", "completed", "cancel_requested", "cancelled", "failed",
]);

export const CreateProductionOrderInputSchema = z.object({
  orderLineId: EntityIdSchema,
  routingDecisionId: EntityIdSchema,
  purchaseOrderVersionId: EntityIdSchema,
  designVersionId: EntityIdSchema.nullable().default(null),
  productionAssetIds: z.array(EntityIdSchema).max(100).default([]),
  expectedCompletionAt: z.iso.datetime(),
  instructions: z.string().trim().min(1).max(20_000),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

export const ProductionMilestoneTypeSchema = z.enum([
  "submitted", "acknowledged", "started", "completed", "failed", "cancel_requested", "cancelled",
]);

export const RecordProductionMilestoneInputSchema = z.object({
  type: ProductionMilestoneTypeSchema,
  expectedProjectionVersion: z.number().int().positive(),
  externalEventId: z.string().trim().min(1).max(300).nullable().default(null),
  occurredAt: z.iso.datetime(),
  evidence: z.object({
    code: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
    note: z.string().trim().max(2_000).nullable().default(null),
    assetIds: z.array(EntityIdSchema).max(100).default([]),
  }).strict(),
}).strict();

export const CreateQualityStandardInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  skuId: EntityIdSchema.nullable().default(null),
  supplierId: EntityIdSchema.nullable().default(null),
  minimumScoreBps: z.number().int().min(0).max(10_000),
  criteria: z.array(z.object({
    code: z.string().regex(/^[A-Z0-9_:-]{1,160}$/), label: z.string().trim().min(1).max(300),
    weightBps: z.number().int().min(0).max(10_000), blocking: z.boolean().default(false),
  }).strict()).min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.criteria.reduce((total, criterion) => total + criterion.weightBps, 0) !== 10_000) context.addIssue({ code: "custom", path: ["criteria"], message: "Quality criterion weights must total 10000 basis points" });
  const codes = new Set(value.criteria.map((criterion) => criterion.code));
  if (codes.size !== value.criteria.length) context.addIssue({ code: "custom", path: ["criteria"], message: "Quality criterion codes must be unique" });
});

export const QualityDefectSeveritySchema = z.enum(["minor", "major", "critical"]);
export const QualityResponsibilitySchema = z.enum(["supplier", "internal", "carrier", "customer", "unknown"]);
export const QualityDispositionSchema = z.enum(["accept", "rework", "remake", "reship", "refund", "cancel"]);

export const RecordQualityInspectionInputSchema = z.object({
  qualityStandardVersionId: EntityIdSchema,
  result: z.enum(["passed", "failed"]),
  scoreBps: z.number().int().min(0).max(10_000),
  inspectedAt: z.iso.datetime(),
  evidenceAssetIds: z.array(EntityIdSchema).max(100).default([]),
  defects: z.array(z.object({
    code: z.string().regex(/^[A-Z0-9_:-]{1,160}$/), severity: QualityDefectSeveritySchema,
    responsibility: QualityResponsibilitySchema, disposition: QualityDispositionSchema,
    note: z.string().trim().min(1).max(2_000), evidenceAssetIds: z.array(EntityIdSchema).max(100).default([]),
  }).strict()).max(200).default([]),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((value, context) => {
  if (value.result === "passed" && value.defects.some((defect) => defect.severity === "critical")) context.addIssue({ code: "custom", path: ["defects"], message: "A passed inspection cannot contain a critical defect" });
  if (value.result === "failed" && value.defects.length === 0) context.addIssue({ code: "custom", path: ["defects"], message: "A failed inspection requires at least one defect" });
});

export const CreateProductionRecoveryInputSchema = z.object({
  type: z.enum(["remake", "reship", "cancellation_compensation"]),
  originalProductionOrderId: EntityIdSchema,
  defectId: EntityIdSchema.nullable().default(null),
  reason: z.string().trim().min(1).max(2_000),
  compensationAmountMinor: z.number().int().nonnegative().nullable().default(null),
  compensationCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  expectedCompletionAt: z.iso.datetime().nullable().default(null),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((value, context) => {
  const hasCompensation = value.compensationAmountMinor !== null || value.compensationCurrency !== null;
  if (value.type === "cancellation_compensation" && (value.compensationAmountMinor === null || value.compensationCurrency === null)) context.addIssue({ code: "custom", path: ["compensationAmountMinor"], message: "Cancellation compensation requires amount and currency" });
  if (value.type !== "cancellation_compensation" && hasCompensation) context.addIssue({ code: "custom", path: ["compensationAmountMinor"], message: "Only cancellation compensation accepts financial fields" });
  if (value.type === "remake" && value.expectedCompletionAt === null) context.addIssue({ code: "custom", path: ["expectedCompletionAt"], message: "A remake requires an expected completion timestamp" });
});

export const CreateProductionBatchInputSchema = z.object({
  supplierId: EntityIdSchema,
  productionOrderIds: z.array(EntityIdSchema).min(1).max(1_000),
  expectedCompletionAt: z.iso.datetime(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().refine((value) => new Set(value.productionOrderIds).size === value.productionOrderIds.length, {
  path: ["productionOrderIds"], message: "Production order IDs must be unique",
});

export const RecordProductionBatchEventInputSchema = z.object({
  type: z.enum(["released", "started", "completed", "failed", "cancel_requested", "cancelled"]),
  expectedProjectionVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  externalEventId: z.string().trim().min(1).max(300).nullable().default(null),
  evidenceCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
  note: z.string().trim().max(2_000).nullable().default(null),
}).strict();

export const RecordProductionRecoveryEventInputSchema = z.object({
  action: z.enum(["start", "resolve", "cancel"]),
  expectedProjectionVersion: z.number().int().positive(),
  outcomeCode: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
  note: z.string().trim().max(2_000).nullable().default(null),
  externalReference: z.string().trim().min(1).max(300).nullable().default(null),
  occurredAt: z.iso.datetime(),
}).strict();

export type ProductionOrderStatus = z.infer<typeof ProductionOrderStatusSchema>;
export type CreateProductionOrderInput = z.infer<typeof CreateProductionOrderInputSchema>;
export type RecordProductionMilestoneInput = z.infer<typeof RecordProductionMilestoneInputSchema>;
export type CreateQualityStandardInput = z.infer<typeof CreateQualityStandardInputSchema>;
export type RecordQualityInspectionInput = z.infer<typeof RecordQualityInspectionInputSchema>;
export type CreateProductionRecoveryInput = z.infer<typeof CreateProductionRecoveryInputSchema>;
export type CreateProductionBatchInput = z.infer<typeof CreateProductionBatchInputSchema>;
export type RecordProductionBatchEventInput = z.infer<typeof RecordProductionBatchEventInputSchema>;
export type RecordProductionRecoveryEventInput = z.infer<typeof RecordProductionRecoveryEventInputSchema>;
