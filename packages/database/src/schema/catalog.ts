import type { CustomizationDefinition } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

export const productPlans = pgTable(
  "product_plans",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").default("researching").notNull(),
    sourceReportIds: jsonb("source_report_ids").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    targetCostAmount: numeric("target_cost_amount", { precision: 14, scale: 2 }),
    targetCostCurrency: text("target_cost_currency"),
    customization: jsonb("customization").$type<CustomizationDefinition>().notNull(),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("product_plans_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("product_plans_status_check", sql`${table.status} in ('researching','pending_approval','approved','developing','listing','ready','archived')`),
    check("product_plans_cost_check", sql`(${table.targetCostAmount} is null and ${table.targetCostCurrency} is null) or (${table.targetCostAmount} >= 0 and ${table.targetCostCurrency} ~ '^[A-Z]{3}$')`),
    uniqueIndex("product_plans_tenant_id_unique").on(table.tenantId, table.id),
    index("product_plans_status_idx").on(table.tenantId, table.status, table.updatedAt),
  ],
);

export const spus = pgTable(
  "spus",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    productPlanId: uuid("product_plan_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    status: text("status").default("developing").notNull(),
    customization: jsonb("customization").$type<CustomizationDefinition>().notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("spus_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("spus_status_check", sql`${table.status} in ('developing','listing','ready','archived')`),
    foreignKey({ columns: [table.tenantId, table.productPlanId], foreignColumns: [productPlans.tenantId, productPlans.id], name: "spus_product_plan_fk" }).onDelete("restrict"),
    uniqueIndex("spus_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("spus_tenant_code_unique").on(table.tenantId, table.code),
    uniqueIndex("spus_tenant_plan_unique").on(table.tenantId, table.productPlanId),
    index("spus_plan_idx").on(table.tenantId, table.productPlanId),
  ],
);

export const skus = pgTable(
  "skus",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    spuId: uuid("spu_id").notNull(),
    code: text("code").notNull(),
    attributes: jsonb("attributes").$type<Record<string, string>>().default(sql`'{}'::jsonb`).notNull(),
    unitCostAmount: numeric("unit_cost_amount", { precision: 14, scale: 2 }),
    unitCostCurrency: text("unit_cost_currency"),
    status: text("status").default("draft").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("skus_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("skus_status_check", sql`${table.status} in ('draft','active','archived')`),
    check("skus_cost_check", sql`(${table.unitCostAmount} is null and ${table.unitCostCurrency} is null) or (${table.unitCostAmount} >= 0 and ${table.unitCostCurrency} ~ '^[A-Z]{3}$')`),
    foreignKey({ columns: [table.tenantId, table.spuId], foreignColumns: [spus.tenantId, spus.id], name: "skus_spu_fk" }).onDelete("restrict"),
    uniqueIndex("skus_tenant_id_unique").on(table.tenantId, table.id),
    uniqueIndex("skus_tenant_code_unique").on(table.tenantId, table.code),
    index("skus_spu_idx").on(table.tenantId, table.spuId),
  ],
);

export const supplierCandidates = pgTable(
  "supplier_candidates",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    productPlanId: uuid("product_plan_id").notNull(),
    name: text("name").notNull(),
    priority: integer("priority").notNull(),
    status: text("status").default("candidate").notNull(),
    quotedCostAmount: numeric("quoted_cost_amount", { precision: 14, scale: 2 }),
    quotedCostCurrency: text("quoted_cost_currency"),
    minimumOrderQuantity: integer("minimum_order_quantity"),
    leadTimeDays: integer("lead_time_days"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("supplier_candidates_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("supplier_candidates_priority_check", sql`${table.priority} between 1 and 5`),
    check("supplier_candidates_status_check", sql`${table.status} in ('candidate','contacted','approved','rejected')`),
    check("supplier_candidates_cost_check", sql`(${table.quotedCostAmount} is null and ${table.quotedCostCurrency} is null) or (${table.quotedCostAmount} >= 0 and ${table.quotedCostCurrency} ~ '^[A-Z]{3}$')`),
    check("supplier_candidates_moq_check", sql`${table.minimumOrderQuantity} is null or ${table.minimumOrderQuantity} > 0`),
    check("supplier_candidates_lead_time_check", sql`${table.leadTimeDays} is null or ${table.leadTimeDays} >= 0`),
    foreignKey({ columns: [table.tenantId, table.productPlanId], foreignColumns: [productPlans.tenantId, productPlans.id], name: "supplier_candidates_product_plan_fk" }).onDelete("cascade"),
    uniqueIndex("supplier_candidates_tenant_id_unique").on(table.tenantId, table.id),
    index("supplier_candidates_priority_idx").on(table.tenantId, table.productPlanId, table.priority),
  ],
);
