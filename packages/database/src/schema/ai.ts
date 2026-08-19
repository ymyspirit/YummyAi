import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import type { AnalysisReport, GeneratedImageProvenance } from "@yummyai/contracts";
import { assetFiles } from "./assets.js";
import { organizations, users } from "./identity.js";

export interface ModelRouteTargetRecord {
  providerConfigId: string;
  providerModel: string;
  timeoutMs: number;
}

export const modelProviderConfigs = pgTable(
  "model_provider_configs",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    endpoint: text("endpoint"),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    status: text("status").default("enabled").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("model_provider_configs_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("model_provider_configs_provider_check", sql`${table.provider} in ('openai', 'anthropic', 'openai-compatible')`),
    check("model_provider_configs_status_check", sql`${table.status} in ('enabled', 'disabled')`),
    uniqueIndex("model_provider_configs_tenant_label_unique").on(table.tenantId, table.label),
    uniqueIndex("model_provider_configs_tenant_id_unique").on(table.tenantId, table.id),
    index("model_provider_configs_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const modelRoutes = pgTable(
  "model_routes",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    taskType: text("task_type").notNull(),
    targets: jsonb("targets").$type<ModelRouteTargetRecord[]>().notNull(),
    status: text("status").default("enabled").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("model_routes_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("model_routes_status_check", sql`${table.status} in ('enabled', 'disabled')`),
    uniqueIndex("model_routes_tenant_model_task_unique").on(table.tenantId, table.modelKey, table.taskType),
    uniqueIndex("model_routes_tenant_id_unique").on(table.tenantId, table.id),
  ],
);

export const aiBudgetPolicies = pgTable("ai_budget_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  monthlyCapUsd: numeric("monthly_cap_usd", { precision: 14, scale: 6 }).notNull(),
  defaultTaskCapUsd: numeric("default_task_cap_usd", { precision: 14, scale: 6 }).notNull(),
  taskCapsUsd: jsonb("task_caps_usd").$type<Record<string, number>>().default(sql`'{}'::jsonb`).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
});

export const aiBudgetLedger = pgTable(
  "ai_budget_ledger",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    taskType: text("task_type").notNull(),
    modelKey: text("model_key").notNull(),
    provider: text("provider").notNull(),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 6 }).notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("ai_budget_ledger_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("ai_budget_ledger_state_check", sql`${table.state} in ('reserved', 'committed', 'released')`),
    check("ai_budget_ledger_amount_check", sql`${table.amountUsd} >= 0`),
    index("ai_budget_ledger_month_idx").on(table.tenantId, table.createdAt),
    index("ai_budget_ledger_request_idx").on(table.tenantId, table.requestId),
  ],
);

export const analysisReports = pgTable(
  "analysis_reports",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    reportSeriesId: uuid("report_series_id").notNull(),
    version: integer("version").notNull(),
    taskType: text("task_type").notNull(),
    status: text("status").notNull(),
    inputSnapshotIds: jsonb("input_snapshot_ids").$type<string[]>().notNull(),
    report: jsonb("report").$type<AnalysisReport>().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("analysis_reports_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("analysis_reports_series_uuidv7_check", sql`substring(${table.reportSeriesId}::text from 15 for 1) = '7'`),
    check("analysis_reports_version_check", sql`${table.version} > 0`),
    check("analysis_reports_task_check", sql`${table.taskType} in ('AI-01','AI-02','AI-03','AI-04','AI-05','AI-06','AI-07','AI-08')`),
    check("analysis_reports_status_check", sql`${table.status} in ('completed', 'failed', 'cancelled')`),
    uniqueIndex("analysis_reports_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("analysis_reports_series_version_unique").on(table.tenantId, table.reportSeriesId, table.version),
    index("analysis_reports_series_created_idx").on(table.tenantId, table.reportSeriesId, table.createdAt),
  ],
);

export const generatedImageProvenance = pgTable(
  "generated_image_provenance",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id").notNull(),
    provider: text("provider").notNull(),
    modelKey: text("model_key").notNull(),
    promptTemplateVersion: text("prompt_template_version").notNull(),
    provenance: jsonb("provenance").$type<GeneratedImageProvenance>().notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull(),
    reviewStatus: text("review_status").default("draft").notNull(),
    aiGenerated: boolean("ai_generated").default(true).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("generated_image_provenance_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("generated_image_provenance_review_check", sql`${table.reviewStatus} in ('draft', 'approved', 'rejected')`),
    check("generated_image_provenance_cost_check", sql`${table.costUsd} >= 0`),
    foreignKey({
      columns: [table.tenantId, table.assetId],
      foreignColumns: [assetFiles.tenantId, assetFiles.id],
      name: "generated_image_provenance_asset_fk",
    }).onDelete("restrict"),
    uniqueIndex("generated_image_provenance_tenant_asset_unique").on(table.tenantId, table.assetId),
    index("generated_image_provenance_status_idx").on(table.tenantId, table.reviewStatus, table.createdAt),
  ],
);
