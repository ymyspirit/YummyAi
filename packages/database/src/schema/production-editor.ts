import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";
import { amazonOrderReportLines, amazonOrderReportVersions } from "./order-report.js";

export const productionEditorProjects = pgTable("production_editor_projects", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  name: text("name").notNull(), status: text("status").notNull().default("active"),
  encryptedDataKey: text("encrypted_data_key"),
  sourceReportLineId: uuid("source_report_line_id"), sourceReportVersionId: uuid("source_report_version_id"),
  currentVersionId: uuid("current_version_id"), versionNumber: integer("version_number").notNull().default(0),
  reviewedVersionId: uuid("reviewed_version_id"), reviewedBy: uuid("reviewed_by").references(() => users.id), reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("production_editor_projects_tenant_id_unique").on(table.tenantId, table.id),
  check("production_editor_projects_state_check", sql`${table.status} in ('active','expired','deleted')`),
  check("production_editor_projects_source_check", sql`(${table.sourceReportLineId} is null and ${table.sourceReportVersionId} is null) or (${table.sourceReportLineId} is not null and ${table.sourceReportVersionId} is not null and ${table.expiresAt} is not null)`),
  foreignKey({ columns: [table.tenantId, table.sourceReportLineId], foreignColumns: [amazonOrderReportLines.tenantId, amazonOrderReportLines.id], name: "production_editor_projects_report_line_fk" }),
  foreignKey({ columns: [table.tenantId, table.sourceReportLineId, table.sourceReportVersionId], foreignColumns: [amazonOrderReportVersions.tenantId, amazonOrderReportVersions.reportLineId, amazonOrderReportVersions.id], name: "production_editor_projects_report_version_fk" }),
  foreignKey({ columns: [table.tenantId, table.id, table.currentVersionId], foreignColumns: [productionEditorVersions.tenantId, productionEditorVersions.projectId, productionEditorVersions.id], name: "production_editor_projects_current_version_fk" }),
  foreignKey({ columns: [table.tenantId, table.id, table.reviewedVersionId], foreignColumns: [productionEditorVersions.tenantId, productionEditorVersions.projectId, productionEditorVersions.id], name: "production_editor_projects_review_version_fk" }),
  index("production_editor_projects_retention_idx").on(table.tenantId, table.expiresAt),
]);

export const productionEditorVersions = pgTable("production_editor_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), projectId: uuid("project_id").notNull(),
  versionNumber: integer("version_number").notNull(), encryptedDocument: text("encrypted_document").notNull(), checksum: text("checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table): PgTableExtraConfigValue[] => [
  uniqueIndex("production_editor_versions_scope_unique").on(table.tenantId, table.projectId, table.id),
  uniqueIndex("production_editor_versions_number_unique").on(table.tenantId, table.projectId, table.versionNumber),
  foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [productionEditorProjects.tenantId, productionEditorProjects.id], name: "production_editor_versions_project_fk" }),
]);

export const productionEditorImages = pgTable("production_editor_images", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), projectId: uuid("project_id").notNull(),
  encryptedMetadata: text("encrypted_metadata").notNull(), originalObjectKey: text("original_object_key").notNull(), previewObjectKey: text("preview_object_key").notNull(),
  checksum: text("checksum").notNull(), byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("production_editor_images_scope_unique").on(table.tenantId, table.projectId, table.id),
  foreignKey({ columns: [table.tenantId, table.projectId], foreignColumns: [productionEditorProjects.tenantId, productionEditorProjects.id], name: "production_editor_images_project_fk" }),
]);

export const productionEditorRenders = pgTable("production_editor_renders", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), projectId: uuid("project_id").notNull(), versionId: uuid("version_id").notNull(),
  status: text("status").notNull().default("queued"), encryptedOptions: text("encrypted_options").notNull(), encryptedManifest: text("encrypted_manifest"),
  processingToken: uuid("processing_token"), startedAt: timestamp("started_at", { mode: "date", withTimezone: true }), attempt: integer("attempt").notNull().default(0), errorCode: text("error_code"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("production_editor_renders_tenant_id_unique").on(table.tenantId, table.id),
  check("production_editor_renders_state_check", sql`${table.status} in ('queued','processing','completed','failed')`),
  foreignKey({ columns: [table.tenantId, table.projectId, table.versionId], foreignColumns: [productionEditorVersions.tenantId, productionEditorVersions.projectId, productionEditorVersions.id], name: "production_editor_renders_version_fk" }),
]);
