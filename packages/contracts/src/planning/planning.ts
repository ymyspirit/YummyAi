import { z } from "zod";

import { EntityIdSchema } from "@yummyai/contracts/common/ids";

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const CodeSchema = z.string().trim().min(1).max(100).regex(/^[A-Z0-9][A-Z0-9._-]*$/);
const ChecksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const SafeIntegerSchema = z.number().int().safe();

export const ForecastMetricSchema = z.enum(["sales_units", "inventory_available", "profit_minor"]);
export const ForecastModelSchema = z.enum(["seasonal_naive_v1", "moving_average_v1"]);
export const ForecastGrainSchema = z.enum(["day", "week", "month"]);
export const ForecastScopeTypeSchema = z.enum(["tenant", "platform", "store", "listing", "sku"]);
export const ForecastEvidenceTypeSchema = z.enum(["order_event", "inventory_movement", "profit_run"]);

export const ForecastEvidenceRefSchema = z.object({
  sourceType: ForecastEvidenceTypeSchema,
  sourceId: EntityIdSchema,
}).strict();

export const ForecastInputPointSchema = z.object({
  periodStart: z.iso.datetime(),
  value: SafeIntegerSchema,
  evidenceRefs: z.array(ForecastEvidenceRefSchema).min(1).max(500),
}).strict();

export const CreateForecastRunInputSchema = z.object({
  metric: ForecastMetricSchema,
  scopeType: ForecastScopeTypeSchema,
  scopeKey: z.string().trim().min(1).max(200),
  grain: ForecastGrainSchema,
  model: ForecastModelSchema,
  modelVersion: z.string().trim().min(1).max(100),
  inputWindowStart: z.iso.datetime(),
  inputWindowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  horizonStart: z.iso.datetime(),
  horizonEnd: z.iso.datetime(),
  quantilesBps: z.array(z.number().int().min(1).max(9_999)).min(3).max(9),
  inputPoints: z.array(ForecastInputPointSchema).min(2).max(10_000),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  const inputStart = new Date(value.inputWindowStart);
  const inputEnd = new Date(value.inputWindowEnd);
  const cutoff = new Date(value.evidenceCutoffAt);
  const horizonStart = new Date(value.horizonStart);
  const horizonEnd = new Date(value.horizonEnd);
  if (inputEnd <= inputStart) context.addIssue({ code: "custom", path: ["inputWindowEnd"], message: "Input window end must follow start" });
  if (cutoff < inputEnd) context.addIssue({ code: "custom", path: ["evidenceCutoffAt"], message: "Evidence cutoff must cover the complete input window" });
  if (horizonStart < inputEnd) context.addIssue({ code: "custom", path: ["horizonStart"], message: "Forecast horizon cannot begin before the input window ends" });
  if (horizonEnd <= horizonStart) context.addIssue({ code: "custom", path: ["horizonEnd"], message: "Forecast horizon end must follow start" });
  const quantiles = [...value.quantilesBps].sort((left, right) => left - right);
  if (new Set(quantiles).size !== quantiles.length || !quantiles.includes(5_000) || quantiles.some((entry, index) => entry !== value.quantilesBps[index])) {
    context.addIssue({ code: "custom", path: ["quantilesBps"], message: "Quantiles must be unique, ascending, and include 5000 bps" });
  }
  const timestamps = value.inputPoints.map((point) => point.periodStart);
  if (new Set(timestamps).size !== timestamps.length || timestamps.some((entry, index) => index > 0 && entry <= timestamps[index - 1]!)) {
    context.addIssue({ code: "custom", path: ["inputPoints"], message: "Input points must have unique ascending periods" });
  }
  const expectedEvidence = value.metric === "sales_units" ? "order_event" : value.metric === "inventory_available" ? "inventory_movement" : "profit_run";
  for (const [index, point] of value.inputPoints.entries()) {
    const date = new Date(point.periodStart);
    if (date < inputStart || date >= inputEnd) context.addIssue({ code: "custom", path: ["inputPoints", index, "periodStart"], message: "Input point is outside the pinned input window" });
    if (value.metric !== "profit_minor" && point.value < 0) context.addIssue({ code: "custom", path: ["inputPoints", index, "value"], message: "Sales and inventory inputs cannot be negative" });
    if (point.evidenceRefs.some((reference) => reference.sourceType !== expectedEvidence)) context.addIssue({ code: "custom", path: ["inputPoints", index, "evidenceRefs"], message: "Forecast metric and evidence type do not match" });
  }
});

export const EvaluateForecastInputSchema = z.object({
  evaluationWindowStart: z.iso.datetime(),
  evaluationWindowEnd: z.iso.datetime(),
  actualPoints: z.array(ForecastInputPointSchema).min(1).max(10_000),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if (new Date(value.evaluationWindowEnd) <= new Date(value.evaluationWindowStart)) context.addIssue({ code: "custom", path: ["evaluationWindowEnd"], message: "Evaluation window end must follow start" });
});

export const OverrideForecastInputSchema = z.object({
  expectedLatestVersion: z.number().int().nonnegative(),
  reasonCode: CodeSchema,
  points: z.array(z.object({ periodStart: z.iso.datetime(), medianValue: SafeIntegerSchema }).strict()).min(1).max(1_000),
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const ForecastQuantileValueSchema = z.object({ quantileBps: z.number().int(), value: SafeIntegerSchema }).strict();
export const ForecastPointViewSchema = z.object({ id: EntityIdSchema, periodStart: z.iso.datetime(), values: z.array(ForecastQuantileValueSchema) }).strict();
export const ForecastAccuracyViewSchema = z.object({
  id: EntityIdSchema,
  evaluationWindowStart: z.iso.datetime(),
  evaluationWindowEnd: z.iso.datetime(),
  actualEvidenceRefs: z.array(ForecastEvidenceRefSchema),
  meanAbsoluteError: z.number().nonnegative(),
  weightedAbsolutePercentageErrorBps: z.number().int().nonnegative().nullable(),
  biasBps: z.number().int().nullable(),
  inputChecksum: ChecksumSchema,
  evaluatedAt: z.iso.datetime(),
}).strict();
export const ForecastOverrideViewSchema = z.object({
  id: EntityIdSchema,
  versionNumber: z.number().int().positive(),
  reasonCode: CodeSchema,
  points: z.array(z.object({ periodStart: z.iso.datetime(), medianValue: SafeIntegerSchema }).strict()),
  checksum: ChecksumSchema,
  createdAt: z.iso.datetime(),
}).strict();
export const ForecastRunViewSchema = z.object({
  id: EntityIdSchema,
  metric: ForecastMetricSchema,
  scopeType: ForecastScopeTypeSchema,
  scopeKey: z.string(),
  grain: ForecastGrainSchema,
  model: ForecastModelSchema,
  modelVersion: z.string(),
  inputWindowStart: z.iso.datetime(),
  inputWindowEnd: z.iso.datetime(),
  evidenceCutoffAt: z.iso.datetime(),
  horizonStart: z.iso.datetime(),
  horizonEnd: z.iso.datetime(),
  quantilesBps: z.array(z.number().int()),
  inputPoints: z.array(ForecastInputPointSchema),
  inputChecksum: ChecksumSchema,
  generatedAt: z.iso.datetime(),
  points: z.array(ForecastPointViewSchema),
  accuracy: z.array(ForecastAccuracyViewSchema),
  overrides: z.array(ForecastOverrideViewSchema),
}).strict();

export const OperatingMetricSourceSchema = z.enum(["forecast", "inventory", "finance", "webhook", "system"]);
export const OperatingMetricUnitSchema = z.enum(["count", "minor", "basis_points", "seconds"]);
export const OperatingMetricStateSchema = z.enum(["current", "stale", "incomplete", "unavailable"]);
export const OperatingEvidenceRefSchema = z.object({ sourceType: z.string().trim().min(1).max(80), sourceId: EntityIdSchema }).strict();

export const UpsertOperatingMetricDefinitionInputSchema = z.object({
  definitionId: EntityIdSchema.nullable().default(null),
  key: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.-]*$/),
  name: z.string().trim().min(1).max(160),
  unit: OperatingMetricUnitSchema,
  source: OperatingMetricSourceSchema,
  maximumAgeSeconds: z.number().int().positive().max(31_536_000),
  minimumCompletenessBps: z.number().int().min(0).max(10_000),
  reasonCode: CodeSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();

export const RecordOperatingMetricSnapshotInputSchema = z.object({
  definitionId: EntityIdSchema,
  expectedDefinitionVersion: z.number().int().positive(),
  value: SafeIntegerSchema.nullable(),
  observedAt: z.iso.datetime(),
  completenessBps: z.number().int().min(0).max(10_000),
  sourceRefs: z.array(OperatingEvidenceRefSchema).max(2_000),
  drillThroughHref: z.string().trim().min(1).max(500).regex(/^\/[a-z0-9/_?=&.-]*$/),
  idempotencyKey: IdempotencyKeySchema,
}).strict().superRefine((value, context) => {
  if ((value.value === null) !== (value.sourceRefs.length === 0)) context.addIssue({ code: "custom", path: ["sourceRefs"], message: "Unavailable metrics must not claim source evidence; available metrics require it" });
});

export const OpenOperatingReconciliationInputSchema = z.object({
  category: z.enum(["freshness", "completeness", "projection", "provider", "webhook"]),
  code: CodeSchema,
  metricSnapshotId: EntityIdSchema.nullable().default(null),
  sourceRef: OperatingEvidenceRefSchema.nullable().default(null),
  detailChecksum: ChecksumSchema,
  idempotencyKey: IdempotencyKeySchema,
}).strict();
export const ResolveOperatingReconciliationInputSchema = z.object({ expectedStatus: z.literal("open"), outcome: z.enum(["resolved", "dismissed"]), reasonCode: CodeSchema, idempotencyKey: IdempotencyKeySchema }).strict();
export const RebuildOperatingProjectionsInputSchema = z.object({ idempotencyKey: IdempotencyKeySchema }).strict();

export const OperatingMetricDefinitionViewSchema = z.object({
  id: EntityIdSchema, key: z.string(), name: z.string(), currentVersion: z.number().int().positive(), status: z.enum(["active", "inactive"]),
  version: z.object({ id: EntityIdSchema, versionNumber: z.number().int().positive(), unit: OperatingMetricUnitSchema, source: OperatingMetricSourceSchema, maximumAgeSeconds: z.number().int().positive(), minimumCompletenessBps: z.number().int(), reasonCode: CodeSchema, checksum: ChecksumSchema, createdAt: z.iso.datetime() }).strict(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export const OperatingMetricSnapshotViewSchema = z.object({
  id: EntityIdSchema, definitionId: EntityIdSchema, definitionVersionId: EntityIdSchema, definitionVersion: z.number().int().positive(), value: SafeIntegerSchema.nullable(), observedAt: z.iso.datetime(), recordedAt: z.iso.datetime(), completenessBps: z.number().int(), sourceRefs: z.array(OperatingEvidenceRefSchema), drillThroughHref: z.string(), checksum: ChecksumSchema, state: OperatingMetricStateSchema, ageSeconds: z.number().int().nonnegative(),
}).strict();
export const OperatingMetricProjectionViewSchema = z.object({ definitionId: EntityIdSchema, snapshot: OperatingMetricSnapshotViewSchema }).strict();
export const OperatingReconciliationViewSchema = z.object({ id: EntityIdSchema, category: z.string(), code: CodeSchema, status: z.enum(["open", "resolved", "dismissed"]), metricSnapshotId: EntityIdSchema.nullable(), sourceRef: OperatingEvidenceRefSchema.nullable(), detailChecksum: ChecksumSchema, openedAt: z.iso.datetime(), resolvedAt: z.iso.datetime().nullable() }).strict();
export const OperatingProjectionRebuildViewSchema = z.object({ id: EntityIdSchema, sourceSnapshotCount: z.number().int().nonnegative(), projectionCount: z.number().int().nonnegative(), beforeChecksum: ChecksumSchema, afterChecksum: ChecksumSchema, equivalent: z.boolean(), rebuiltAt: z.iso.datetime() }).strict();
export const PlanningWorkspaceViewSchema = z.object({ forecasts: z.array(ForecastRunViewSchema), metricDefinitions: z.array(OperatingMetricDefinitionViewSchema), metricProjections: z.array(OperatingMetricProjectionViewSchema), reconciliations: z.array(OperatingReconciliationViewSchema), rebuilds: z.array(OperatingProjectionRebuildViewSchema) }).strict();

export type ForecastMetric = z.infer<typeof ForecastMetricSchema>;
export type ForecastModel = z.infer<typeof ForecastModelSchema>;
export type ForecastGrain = z.infer<typeof ForecastGrainSchema>;
export type ForecastScopeType = z.infer<typeof ForecastScopeTypeSchema>;
export type ForecastEvidenceType = z.infer<typeof ForecastEvidenceTypeSchema>;
export type ForecastEvidenceRef = z.infer<typeof ForecastEvidenceRefSchema>;
export type ForecastInputPoint = z.infer<typeof ForecastInputPointSchema>;
export type CreateForecastRunInput = z.infer<typeof CreateForecastRunInputSchema>;
export type EvaluateForecastInput = z.infer<typeof EvaluateForecastInputSchema>;
export type OverrideForecastInput = z.infer<typeof OverrideForecastInputSchema>;
export type ForecastRunView = z.infer<typeof ForecastRunViewSchema>;
export type OperatingMetricSource = z.infer<typeof OperatingMetricSourceSchema>;
export type OperatingMetricUnit = z.infer<typeof OperatingMetricUnitSchema>;
export type OperatingEvidenceRef = z.infer<typeof OperatingEvidenceRefSchema>;
export type UpsertOperatingMetricDefinitionInput = z.infer<typeof UpsertOperatingMetricDefinitionInputSchema>;
export type RecordOperatingMetricSnapshotInput = z.infer<typeof RecordOperatingMetricSnapshotInputSchema>;
export type OpenOperatingReconciliationInput = z.infer<typeof OpenOperatingReconciliationInputSchema>;
export type ResolveOperatingReconciliationInput = z.infer<typeof ResolveOperatingReconciliationInputSchema>;
export type RebuildOperatingProjectionsInput = z.infer<typeof RebuildOperatingProjectionsInputSchema>;
export type PlanningWorkspaceView = z.infer<typeof PlanningWorkspaceViewSchema>;
