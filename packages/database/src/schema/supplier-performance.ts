import type {
  SupplierKpiEvidenceReference,
  SupplierKpiMetric,
  SupplierKpiMetricDefinition,
  SupplierKpiRawUnit,
  SupplierMissingDataPolicy,
  SupplierScorecardDiagnosticView,
} from "@yummyai/contracts/supplier-performance";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { fulfillmentSuppliers } from "./order-routing.js";

export const supplierKpiDefinitions = pgTable("supplier_kpi_definitions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  status: text("status").default("active").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_kpi_definitions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_kpi_definitions_version_check", sql`${table.currentVersion} > 0`),
  check("supplier_kpi_definitions_status_check", sql`${table.status} in ('active','inactive')`),
  unique("supplier_kpi_definitions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_kpi_definitions_name_unique").on(table.tenantId, table.name),
  index("supplier_kpi_definitions_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const supplierKpiDefinitionVersions = pgTable("supplier_kpi_definition_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  definitionId: uuid("definition_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  missingDataPolicy: text("missing_data_policy").$type<SupplierMissingDataPolicy>().notNull(),
  metrics: jsonb("metrics").$type<SupplierKpiMetricDefinition[]>().notNull(),
  reasonCode: text("reason_code").notNull(),
  checksum: text("checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_kpi_definition_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_kpi_definition_versions_number_check", sql`${table.versionNumber} > 0`),
  check("supplier_kpi_definition_versions_policy_check", sql`${table.missingDataPolicy} in ('exclude','zero','incomplete')`),
  check("supplier_kpi_definition_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.definitionId],
    foreignColumns: [supplierKpiDefinitions.tenantId, supplierKpiDefinitions.id],
    name: "supplier_kpi_definition_versions_definition_fk",
  }).onDelete("restrict"),
  unique("supplier_kpi_definition_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_kpi_definition_versions_number_unique").on(
    table.tenantId,
    table.definitionId,
    table.versionNumber,
  ),
  uniqueIndex("supplier_kpi_definition_versions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const supplierScorecardRuns = pgTable("supplier_scorecard_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull(),
  definitionId: uuid("definition_id").notNull(),
  definitionVersionId: uuid("definition_version_id").notNull(),
  definitionVersion: integer("definition_version").notNull(),
  status: text("status").notNull(),
  overallScoreBps: integer("overall_score_bps"),
  windowStart: timestamp("window_start", { mode: "date", withTimezone: true }).notNull(),
  windowEnd: timestamp("window_end", { mode: "date", withTimezone: true }).notNull(),
  evidenceCutoffAt: timestamp("evidence_cutoff_at", { mode: "date", withTimezone: true }).notNull(),
  diagnostics: jsonb("diagnostics").$type<SupplierScorecardDiagnosticView>().notNull(),
  inputChecksum: text("input_checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  calculatedBy: uuid("calculated_by").references(() => users.id, { onDelete: "set null" }),
  calculatedAt: timestamp("calculated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_scorecard_runs_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_scorecard_runs_version_check", sql`${table.definitionVersion} > 0`),
  check("supplier_scorecard_runs_status_check", sql`${table.status} in ('complete','incomplete')`),
  check("supplier_scorecard_runs_score_check", sql`(${table.status} = 'complete' and ${table.overallScoreBps} between 0 and 10000) or (${table.status} = 'incomplete' and ${table.overallScoreBps} is null)`),
  check("supplier_scorecard_runs_window_check", sql`${table.windowEnd} > ${table.windowStart} and ${table.evidenceCutoffAt} >= ${table.windowEnd}`),
  check("supplier_scorecard_runs_checksum_check", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.supplierId],
    foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id],
    name: "supplier_scorecard_runs_supplier_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.definitionId],
    foreignColumns: [supplierKpiDefinitions.tenantId, supplierKpiDefinitions.id],
    name: "supplier_scorecard_runs_definition_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.definitionVersionId],
    foreignColumns: [supplierKpiDefinitionVersions.tenantId, supplierKpiDefinitionVersions.id],
    name: "supplier_scorecard_runs_definition_version_fk",
  }).onDelete("restrict"),
  unique("supplier_scorecard_runs_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_scorecard_runs_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("supplier_scorecard_runs_supplier_idx").on(table.tenantId, table.supplierId, table.calculatedAt),
]);

export const supplierScorecardMetrics = pgTable("supplier_scorecard_metrics", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull(),
  metric: text("metric").$type<SupplierKpiMetric>().notNull(),
  scoreBps: integer("score_bps"),
  sampleCount: integer("sample_count").notNull(),
  rawNumerator: bigint("raw_numerator", { mode: "number" }).notNull(),
  rawDenominator: bigint("raw_denominator", { mode: "number" }).notNull(),
  rawUnit: text("raw_unit").$type<SupplierKpiRawUnit>().notNull(),
  evidenceReferences: jsonb("evidence_references").$type<SupplierKpiEvidenceReference[]>().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_scorecard_metrics_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_scorecard_metrics_metric_check", sql`${table.metric} in ('quality','on_time_delivery','price_variance','response_time','acceptance','cancellation','capacity_adherence')`),
  check("supplier_scorecard_metrics_score_check", sql`${table.scoreBps} is null or ${table.scoreBps} between 0 and 10000`),
  check("supplier_scorecard_metrics_values_check", sql`${table.sampleCount} >= 0 and ${table.rawNumerator} >= 0 and ${table.rawDenominator} >= 0`),
  check("supplier_scorecard_metrics_unit_check", sql`${table.rawUnit} in ('weighted_bps','sample_ratio','money_ratio','unit_ratio')`),
  foreignKey({
    columns: [table.tenantId, table.runId],
    foreignColumns: [supplierScorecardRuns.tenantId, supplierScorecardRuns.id],
    name: "supplier_scorecard_metrics_run_fk",
  }).onDelete("restrict"),
  unique("supplier_scorecard_metrics_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_scorecard_metrics_run_metric_unique").on(table.tenantId, table.runId, table.metric),
  index("supplier_scorecard_metrics_run_idx").on(table.tenantId, table.runId, table.metric),
]);
