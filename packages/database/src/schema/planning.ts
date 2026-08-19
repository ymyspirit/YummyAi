import type {
  ForecastGrain, ForecastInputPoint, ForecastMetric, ForecastModel, ForecastScopeType,
  OperatingEvidenceRef, OperatingMetricSource, OperatingMetricUnit,
} from "@yummyai/contracts/planning";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

type ForecastQuantileValue = { quantileBps: number; value: number };
type ForecastOverridePoint = { periodStart: string; medianValue: number };

export const forecastRuns = pgTable("forecast_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  metric: text("metric").$type<ForecastMetric>().notNull(),
  scopeType: text("scope_type").$type<ForecastScopeType>().notNull(),
  scopeKey: text("scope_key").notNull(),
  grain: text("grain").$type<ForecastGrain>().notNull(),
  model: text("model").$type<ForecastModel>().notNull(),
  modelVersion: text("model_version").notNull(),
  inputWindowStart: timestamp("input_window_start", { mode: "date", withTimezone: true }).notNull(),
  inputWindowEnd: timestamp("input_window_end", { mode: "date", withTimezone: true }).notNull(),
  evidenceCutoffAt: timestamp("evidence_cutoff_at", { mode: "date", withTimezone: true }).notNull(),
  horizonStart: timestamp("horizon_start", { mode: "date", withTimezone: true }).notNull(),
  horizonEnd: timestamp("horizon_end", { mode: "date", withTimezone: true }).notNull(),
  quantilesBps: jsonb("quantiles_bps").$type<number[]>().notNull(),
  inputPoints: jsonb("input_points").$type<ForecastInputPoint[]>().notNull(),
  inputChecksum: text("input_checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  generatedBy: uuid("generated_by").references(() => users.id, { onDelete: "set null" }),
  generatedAt: timestamp("generated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_runs_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("forecast_runs_metric_check", sql`${table.metric} in ('sales_units','inventory_available','profit_minor')`),
  check("forecast_runs_scope_check", sql`${table.scopeType} in ('tenant','platform','store','listing','sku')`),
  check("forecast_runs_grain_check", sql`${table.grain} in ('day','week','month')`),
  check("forecast_runs_model_check", sql`${table.model} in ('seasonal_naive_v1','moving_average_v1')`),
  check("forecast_runs_window_check", sql`${table.inputWindowEnd} > ${table.inputWindowStart} and ${table.evidenceCutoffAt} >= ${table.inputWindowEnd} and ${table.horizonStart} >= ${table.inputWindowEnd} and ${table.horizonEnd} > ${table.horizonStart}`),
  check("forecast_runs_checksum_check", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  unique("forecast_runs_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("forecast_runs_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("forecast_runs_scope_idx").on(table.tenantId, table.metric, table.scopeType, table.scopeKey, table.generatedAt),
]);

export const forecastPoints = pgTable("forecast_points", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull(), periodStart: timestamp("period_start", { mode: "date", withTimezone: true }).notNull(),
  values: jsonb("values").$type<ForecastQuantileValue[]>().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_points_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  foreignKey({ columns: [table.tenantId, table.runId], foreignColumns: [forecastRuns.tenantId, forecastRuns.id], name: "forecast_points_run_fk" }).onDelete("restrict"),
  unique("forecast_points_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("forecast_points_period_unique").on(table.tenantId, table.runId, table.periodStart),
]);

export const forecastAccuracyEvaluations = pgTable("forecast_accuracy_evaluations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), runId: uuid("run_id").notNull(),
  evaluationWindowStart: timestamp("evaluation_window_start", { mode: "date", withTimezone: true }).notNull(), evaluationWindowEnd: timestamp("evaluation_window_end", { mode: "date", withTimezone: true }).notNull(),
  actualEvidenceRefs: jsonb("actual_evidence_refs").$type<{ sourceType: string; sourceId: string }[]>().notNull(),
  meanAbsoluteError: bigint("mean_absolute_error", { mode: "number" }).notNull(), weightedAbsolutePercentageErrorBps: integer("weighted_absolute_percentage_error_bps"), biasBps: integer("bias_bps"),
  inputChecksum: text("input_checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(), evaluatedBy: uuid("evaluated_by").references(() => users.id, { onDelete: "set null" }), evaluatedAt: timestamp("evaluated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_accuracy_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("forecast_accuracy_window_check", sql`${table.evaluationWindowEnd} > ${table.evaluationWindowStart}`),
  check("forecast_accuracy_values_check", sql`${table.meanAbsoluteError} >= 0 and (${table.weightedAbsolutePercentageErrorBps} is null or ${table.weightedAbsolutePercentageErrorBps} >= 0)`), check("forecast_accuracy_checksum_check", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.runId], foreignColumns: [forecastRuns.tenantId, forecastRuns.id], name: "forecast_accuracy_run_fk" }).onDelete("restrict"), unique("forecast_accuracy_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("forecast_accuracy_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const forecastOverrideVersions = pgTable("forecast_override_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), runId: uuid("run_id").notNull(), versionNumber: integer("version_number").notNull(), reasonCode: text("reason_code").notNull(),
  points: jsonb("points").$type<ForecastOverridePoint[]>().notNull(), checksum: text("checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(), createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("forecast_overrides_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("forecast_overrides_version_check", sql`${table.versionNumber} > 0`), check("forecast_overrides_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.runId], foreignColumns: [forecastRuns.tenantId, forecastRuns.id], name: "forecast_overrides_run_fk" }).onDelete("restrict"), unique("forecast_overrides_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("forecast_overrides_version_unique").on(table.tenantId, table.runId, table.versionNumber), uniqueIndex("forecast_overrides_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const operatingMetricDefinitions = pgTable("operating_metric_definitions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), key: text("key").notNull(), name: text("name").notNull(), currentVersion: integer("current_version").default(1).notNull(), status: text("status").default("active").notNull(), createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("operating_metric_definitions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_metric_definitions_version_check", sql`${table.currentVersion} > 0`), check("operating_metric_definitions_status_check", sql`${table.status} in ('active','inactive')`), unique("operating_metric_definitions_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_metric_definitions_key_unique").on(table.tenantId, table.key),
]);

export const operatingMetricDefinitionVersions = pgTable("operating_metric_definition_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), definitionId: uuid("definition_id").notNull(), versionNumber: integer("version_number").notNull(), unit: text("unit").$type<OperatingMetricUnit>().notNull(), source: text("source").$type<OperatingMetricSource>().notNull(), maximumAgeSeconds: integer("maximum_age_seconds").notNull(), minimumCompletenessBps: integer("minimum_completeness_bps").notNull(), reasonCode: text("reason_code").notNull(), checksum: text("checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(), createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("operating_metric_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_metric_versions_number_check", sql`${table.versionNumber} > 0`), check("operating_metric_versions_unit_check", sql`${table.unit} in ('count','minor','basis_points','seconds')`), check("operating_metric_versions_source_check", sql`${table.source} in ('forecast','inventory','finance','webhook','system')`), check("operating_metric_versions_threshold_check", sql`${table.maximumAgeSeconds} > 0 and ${table.minimumCompletenessBps} between 0 and 10000`), check("operating_metric_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.definitionId], foreignColumns: [operatingMetricDefinitions.tenantId, operatingMetricDefinitions.id], name: "operating_metric_versions_definition_fk" }).onDelete("restrict"), unique("operating_metric_versions_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_metric_versions_number_unique").on(table.tenantId, table.definitionId, table.versionNumber), uniqueIndex("operating_metric_versions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const operatingMetricSnapshots = pgTable("operating_metric_snapshots", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), definitionId: uuid("definition_id").notNull(), definitionVersionId: uuid("definition_version_id").notNull(), definitionVersion: integer("definition_version").notNull(), value: bigint("value", { mode: "number" }), observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(), completenessBps: integer("completeness_bps").notNull(), sourceRefs: jsonb("source_refs").$type<OperatingEvidenceRef[]>().notNull(), drillThroughHref: text("drill_through_href").notNull(), checksum: text("checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(), recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }), recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("operating_metric_snapshots_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_metric_snapshots_completeness_check", sql`${table.completenessBps} between 0 and 10000`), check("operating_metric_snapshots_href_check", sql`${table.drillThroughHref} like '/%'`), check("operating_metric_snapshots_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.definitionId], foreignColumns: [operatingMetricDefinitions.tenantId, operatingMetricDefinitions.id], name: "operating_metric_snapshots_definition_fk" }).onDelete("restrict"), foreignKey({ columns: [table.tenantId, table.definitionVersionId], foreignColumns: [operatingMetricDefinitionVersions.tenantId, operatingMetricDefinitionVersions.id], name: "operating_metric_snapshots_version_fk" }).onDelete("restrict"), unique("operating_metric_snapshots_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_metric_snapshots_idempotency_unique").on(table.tenantId, table.idempotencyKey), index("operating_metric_snapshots_observed_idx").on(table.tenantId, table.definitionId, table.observedAt),
]);

export const operatingMetricProjections = pgTable("operating_metric_projections", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), definitionId: uuid("definition_id").notNull(), snapshotId: uuid("snapshot_id").notNull(), updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.definitionId], name: "operating_metric_projections_pk" }), foreignKey({ columns: [table.tenantId, table.definitionId], foreignColumns: [operatingMetricDefinitions.tenantId, operatingMetricDefinitions.id], name: "operating_metric_projections_definition_fk" }).onDelete("cascade"), foreignKey({ columns: [table.tenantId, table.snapshotId], foreignColumns: [operatingMetricSnapshots.tenantId, operatingMetricSnapshots.id], name: "operating_metric_projections_snapshot_fk" }).onDelete("restrict"),
]);

export const operatingReconciliations = pgTable("operating_reconciliations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), category: text("category").notNull(), code: text("code").notNull(), status: text("status").default("open").notNull(), metricSnapshotId: uuid("metric_snapshot_id"), sourceRef: jsonb("source_ref").$type<OperatingEvidenceRef | null>(), detailChecksum: text("detail_checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(), openedBy: uuid("opened_by").references(() => users.id, { onDelete: "set null" }), openedAt: timestamp("opened_at", { mode: "date", withTimezone: true }).defaultNow().notNull(), resolvedAt: timestamp("resolved_at", { mode: "date", withTimezone: true }),
}, (table) => [
  check("operating_reconciliations_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_reconciliations_category_check", sql`${table.category} in ('freshness','completeness','projection','provider','webhook')`), check("operating_reconciliations_status_check", sql`${table.status} in ('open','resolved','dismissed')`), check("operating_reconciliations_checksum_check", sql`${table.detailChecksum} ~ '^[0-9a-f]{64}$'`), foreignKey({ columns: [table.tenantId, table.metricSnapshotId], foreignColumns: [operatingMetricSnapshots.tenantId, operatingMetricSnapshots.id], name: "operating_reconciliations_snapshot_fk" }).onDelete("restrict"), unique("operating_reconciliations_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_reconciliations_idempotency_unique").on(table.tenantId, table.idempotencyKey), index("operating_reconciliations_status_idx").on(table.tenantId, table.status, table.openedAt),
]);

export const operatingReconciliationEvents = pgTable("operating_reconciliation_events", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), reconciliationId: uuid("reconciliation_id").notNull(), action: text("action").notNull(), fromStatus: text("from_status"), toStatus: text("to_status").notNull(), reasonCode: text("reason_code").notNull(), idempotencyKey: text("idempotency_key").notNull(), actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }), occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("operating_reconciliation_events_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_reconciliation_events_action_check", sql`${table.action} in ('opened','resolved','dismissed')`), foreignKey({ columns: [table.tenantId, table.reconciliationId], foreignColumns: [operatingReconciliations.tenantId, operatingReconciliations.id], name: "operating_reconciliation_events_reconciliation_fk" }).onDelete("restrict"), unique("operating_reconciliation_events_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_reconciliation_events_idempotency_unique").on(table.tenantId, table.reconciliationId, table.idempotencyKey),
]);

export const operatingProjectionRebuilds = pgTable("operating_projection_rebuilds", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), sourceSnapshotCount: integer("source_snapshot_count").notNull(), projectionCount: integer("projection_count").notNull(), beforeChecksum: text("before_checksum").notNull(), afterChecksum: text("after_checksum").notNull(), equivalent: boolean("equivalent").notNull(), idempotencyKey: text("idempotency_key").notNull(), rebuiltBy: uuid("rebuilt_by").references(() => users.id, { onDelete: "set null" }), rebuiltAt: timestamp("rebuilt_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("operating_projection_rebuilds_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`), check("operating_projection_rebuilds_counts_check", sql`${table.sourceSnapshotCount} >= 0 and ${table.projectionCount} >= 0`), check("operating_projection_rebuilds_checksums_check", sql`${table.beforeChecksum} ~ '^[0-9a-f]{64}$' and ${table.afterChecksum} ~ '^[0-9a-f]{64}$'`), unique("operating_projection_rebuilds_tenant_id_unique").on(table.tenantId, table.id), uniqueIndex("operating_projection_rebuilds_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);
