import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);

export const SupplierKpiMetricSchema = z.enum([
  "quality",
  "on_time_delivery",
  "price_variance",
  "response_time",
  "acceptance",
  "cancellation",
  "capacity_adherence",
]);

export const SupplierMissingDataPolicySchema = z.enum(["exclude", "zero", "incomplete"]);
export const SupplierScorecardStatusSchema = z.enum(["complete", "incomplete"]);
export const SupplierKpiRawUnitSchema = z.enum([
  "weighted_bps",
  "sample_ratio",
  "money_ratio",
  "unit_ratio",
]);

export const SupplierKpiMetricDefinitionSchema = z.object({
  metric: SupplierKpiMetricSchema,
  weightBps: z.number().int().min(0).max(10_000),
  minimumSampleCount: z.number().int().positive().max(100_000),
  responseTargetHours: z.number().int().positive().max(8_760).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.metric === "response_time") !== (value.responseTargetHours !== null)) {
    context.addIssue({
      code: "custom",
      path: ["responseTargetHours"],
      message: "Only response-time KPI definitions require a response target",
    });
  }
});

export const UpsertSupplierKpiDefinitionInputSchema = z.object({
  definitionId: EntityIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(160),
  missingDataPolicy: SupplierMissingDataPolicySchema,
  metrics: z.array(SupplierKpiMetricDefinitionSchema).length(7),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const metrics = value.metrics.map((metric) => metric.metric);
  if (new Set(metrics).size !== metrics.length) {
    context.addIssue({ code: "custom", path: ["metrics"], message: "KPI metrics must be unique" });
  }
  if (value.metrics.reduce((sum, metric) => sum + metric.weightBps, 0) !== 10_000) {
    context.addIssue({ code: "custom", path: ["metrics"], message: "KPI weights must sum to 10000 bps" });
  }
});

export const CalculateSupplierScorecardInputSchema = z.object({
  definitionId: EntityIdSchema,
  expectedDefinitionVersion: z.number().int().positive(),
  supplierId: EntityIdSchema,
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const start = new Date(value.windowStart);
  const end = new Date(value.windowEnd);
  const cutoff = new Date(value.evidenceCutoffAt);
  if (end <= start) {
    context.addIssue({ code: "custom", path: ["windowEnd"], message: "Scorecard window end must follow its start" });
  }
  if (cutoff < end) {
    context.addIssue({ code: "custom", path: ["evidenceCutoffAt"], message: "Evidence cutoff must not precede the scorecard window end" });
  }
});

export const SupplierKpiEvidenceReferenceSchema = z.object({
  sourceType: z.string().trim().min(1).max(80),
  sourceId: EntityIdSchema,
}).strict();

export const SupplierKpiDefinitionVersionViewSchema = z.object({
  id: EntityIdSchema,
  definitionId: EntityIdSchema,
  versionNumber: z.number().int().positive(),
  missingDataPolicy: SupplierMissingDataPolicySchema,
  metrics: z.array(SupplierKpiMetricDefinitionSchema).length(7),
  reasonCode: z.string(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
}).strict();

export const SupplierKpiDefinitionViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  currentVersion: z.number().int().positive(),
  status: z.enum(["active", "inactive"]),
  version: SupplierKpiDefinitionVersionViewSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const SupplierScorecardMetricViewSchema = z.object({
  id: EntityIdSchema,
  metric: SupplierKpiMetricSchema,
  scoreBps: z.number().int().min(0).max(10_000).nullable(),
  sampleCount: z.number().int().nonnegative(),
  rawNumerator: z.number().int().safe().nonnegative(),
  rawDenominator: z.number().int().safe().nonnegative(),
  rawUnit: SupplierKpiRawUnitSchema,
  evidenceReferences: z.array(SupplierKpiEvidenceReferenceSchema),
}).strict();

export const SupplierScorecardDiagnosticViewSchema = z.object({
  missingMetrics: z.array(SupplierKpiMetricSchema),
  insufficientSampleMetrics: z.array(SupplierKpiMetricSchema),
}).strict();

export const SupplierScorecardRunViewSchema = z.object({
  id: EntityIdSchema,
  supplierId: EntityIdSchema,
  definitionId: EntityIdSchema,
  definitionVersionId: EntityIdSchema,
  definitionVersion: z.number().int().positive(),
  status: SupplierScorecardStatusSchema,
  overallScoreBps: z.number().int().min(0).max(10_000).nullable(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  diagnostics: SupplierScorecardDiagnosticViewSchema,
  inputChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  calculatedAt: z.iso.datetime(),
  metrics: z.array(SupplierScorecardMetricViewSchema).length(7),
}).strict();

export const SupplierPerformanceSupplierViewSchema = z.object({
  id: EntityIdSchema,
  name: z.string(),
  kind: z.enum(["manual", "printify", "printful"]),
  status: z.enum(["active", "suspended", "archived"]),
  regionCode: z.string(),
}).strict();

export const SupplierPerformanceWorkspaceViewSchema = z.object({
  suppliers: z.array(SupplierPerformanceSupplierViewSchema),
  definitions: z.array(SupplierKpiDefinitionViewSchema),
  scorecards: z.array(SupplierScorecardRunViewSchema),
}).strict();

export type SupplierKpiMetric = z.infer<typeof SupplierKpiMetricSchema>;
export type SupplierKpiRawUnit = z.infer<typeof SupplierKpiRawUnitSchema>;
export type SupplierMissingDataPolicy = z.infer<typeof SupplierMissingDataPolicySchema>;
export type SupplierKpiMetricDefinition = z.infer<typeof SupplierKpiMetricDefinitionSchema>;
export type UpsertSupplierKpiDefinitionInput = z.infer<typeof UpsertSupplierKpiDefinitionInputSchema>;
export type CalculateSupplierScorecardInput = z.infer<typeof CalculateSupplierScorecardInputSchema>;
export type SupplierKpiEvidenceReference = z.infer<typeof SupplierKpiEvidenceReferenceSchema>;
export type SupplierKpiDefinitionView = z.infer<typeof SupplierKpiDefinitionViewSchema>;
export type SupplierScorecardMetricView = z.infer<typeof SupplierScorecardMetricViewSchema>;
export type SupplierScorecardDiagnosticView = z.infer<typeof SupplierScorecardDiagnosticViewSchema>;
export type SupplierScorecardRunView = z.infer<typeof SupplierScorecardRunViewSchema>;
export type SupplierPerformanceWorkspaceView = z.infer<typeof SupplierPerformanceWorkspaceViewSchema>;
