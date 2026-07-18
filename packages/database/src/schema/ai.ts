import { sql } from "drizzle-orm";
import { check, index, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
