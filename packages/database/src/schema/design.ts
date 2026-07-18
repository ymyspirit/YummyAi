import type { DesignFileRole } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { assetFiles } from "./assets.js";
import { skus } from "./catalog.js";
import { organizations, users } from "./identity.js";

export const designTasks = pgTable("design_tasks", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  skuId: uuid("sku_id").notNull(),
  title: text("title").notNull(),
  brief: text("brief").notNull(),
  status: text("status").default("open").notNull(),
  primaryVersionId: uuid("primary_version_id"),
  dueAt: timestamp("due_at", { mode: "date", withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("design_tasks_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("design_tasks_status_check", sql`${table.status} in ('open','in_review','approved','archived')`),
  foreignKey({ columns: [table.tenantId, table.skuId], foreignColumns: [skus.tenantId, skus.id], name: "design_tasks_sku_fk" }).onDelete("restrict"),
  uniqueIndex("design_tasks_tenant_id_unique").on(table.tenantId, table.id),
  index("design_tasks_sku_idx").on(table.tenantId, table.skuId, table.updatedAt),
]);

export const designVersions = pgTable("design_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  status: text("status").default("pending_review").notNull(),
  changeNote: text("change_note"),
  rejectionReason: text("rejection_reason"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("design_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("design_versions_number_check", sql`${table.versionNumber} > 0`),
  check("design_versions_status_check", sql`${table.status} in ('pending_review','approved','rejected')`),
  check("design_versions_rejection_check", sql`${table.status} <> 'rejected' or length(${table.rejectionReason}) > 0`),
  foreignKey({ columns: [table.tenantId, table.taskId], foreignColumns: [designTasks.tenantId, designTasks.id], name: "design_versions_task_fk" }).onDelete("cascade"),
  uniqueIndex("design_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("design_versions_task_number_unique").on(table.tenantId, table.taskId, table.versionNumber),
  index("design_versions_task_idx").on(table.tenantId, table.taskId, table.createdAt),
]);

export const designVersionFiles = pgTable("design_version_files", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  versionId: uuid("version_id").notNull(),
  assetFileId: uuid("asset_file_id").notNull(),
  role: text("role").$type<DesignFileRole>().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("design_version_files_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("design_version_files_role_check", sql`${table.role} in ('source','effect','production')`),
  foreignKey({ columns: [table.tenantId, table.versionId], foreignColumns: [designVersions.tenantId, designVersions.id], name: "design_version_files_version_fk" }).onDelete("cascade"),
  foreignKey({ columns: [table.tenantId, table.assetFileId], foreignColumns: [assetFiles.tenantId, assetFiles.id], name: "design_version_files_asset_fk" }).onDelete("restrict"),
  uniqueIndex("design_version_files_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("design_version_files_pair_unique").on(table.tenantId, table.versionId, table.assetFileId, table.role),
  index("design_version_files_version_idx").on(table.tenantId, table.versionId, table.role),
]);
