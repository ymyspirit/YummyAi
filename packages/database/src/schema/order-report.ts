import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";
import { orderLines, orders } from "./order.js";

export const amazonOrderReportBatches = pgTable("amazon_order_report_batches", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  marketplaceId: text("marketplace_id").notNull(),
  fileName: text("file_name").notNull(),
  reportChecksum: text("report_checksum").notNull(),
  encryptedReport: text("encrypted_report"),
  rowCount: integer("row_count").notNull(),
  orderCount: integer("order_count").notNull(),
  newOrderCount: integer("new_order_count").default(0).notNull(),
  duplicateOrderCount: integer("duplicate_order_count").default(0).notNull(),
  failedOrderCount: integer("failed_order_count").default(0).notNull(),
  status: text("status").default("importing").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
}, (table) => [
  check("amazon_order_report_batches_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("amazon_order_report_batches_checksum_check", sql`${table.reportChecksum} ~ '^[0-9a-f]{64}$'`),
  check("amazon_order_report_batches_status_check", sql`${table.status} in ('importing','completed','partial','failed')`),
  check("amazon_order_report_batches_counts_check", sql`${table.rowCount} >= 0 and ${table.orderCount} >= 0 and ${table.orderCount} <= ${table.rowCount} and ${table.newOrderCount} >= 0 and ${table.duplicateOrderCount} >= 0 and ${table.failedOrderCount} >= 0 and ${table.newOrderCount} + ${table.duplicateOrderCount} + ${table.failedOrderCount} <= ${table.orderCount}`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "amazon_order_report_batches_account_fk" }).onDelete("restrict"),
  uniqueIndex("amazon_order_report_batches_tenant_id_unique").on(table.tenantId, table.id),
  index("amazon_order_report_batches_account_idx").on(table.tenantId, table.accountId, table.createdAt),
  index("amazon_order_report_batches_retention_idx").on(table.tenantId, table.expiresAt),
]);

export const amazonOrderReportBatchItems = pgTable("amazon_order_report_batch_items", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  batchId: uuid("batch_id").notNull(),
  orderId: uuid("order_id"),
  externalOrderId: text("external_order_id").notNull(),
  status: text("status").notNull(),
  errorCode: text("error_code"),
}, (table) => [
  check("amazon_order_report_batch_items_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("amazon_order_report_batch_items_status_check", sql`${table.status} in ('imported','duplicate','failed')`),
  foreignKey({ columns: [table.tenantId, table.batchId], foreignColumns: [amazonOrderReportBatches.tenantId, amazonOrderReportBatches.id], name: "amazon_order_report_batch_items_batch_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "amazon_order_report_batch_items_order_fk" }).onDelete("restrict"),
  uniqueIndex("amazon_order_report_batch_items_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("amazon_order_report_batch_items_order_unique").on(table.tenantId, table.batchId, table.externalOrderId),
]);

export const amazonOrderReportLines = pgTable("amazon_order_report_lines", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  orderLineId: uuid("order_line_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  sourceChecksum: text("source_checksum").notNull(),
  encryptedSource: text("encrypted_source"),
  itemTotalMinor: bigint("item_total_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  state: text("state").default("pending").notNull(),
  hasPreview: boolean("has_preview").default(false).notNull(),
  lastErrorCode: text("last_error_code"),
  processingToken: uuid("processing_token"),
  processingStartedAt: timestamp("processing_started_at", { mode: "date", withTimezone: true }),
  currentVersionId: uuid("current_version_id"),
  versionNumber: integer("version_number").default(0).notNull(),
  reviewedVersionId: uuid("reviewed_version_id"),
  reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table): PgTableExtraConfigValue[] => [
  check("amazon_order_report_lines_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("amazon_order_report_lines_checksum_check", sql`${table.sourceChecksum} ~ '^[0-9a-f]{64}$'`),
  check("amazon_order_report_lines_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("amazon_order_report_lines_state_check", sql`${table.state} in ('none','pending','processing','ready','partial','failed','expired')`),
  check("amazon_order_report_lines_version_check", sql`${table.versionNumber} >= 0`),
  check("amazon_order_report_lines_claim_check", sql`(${table.processingToken} is null and ${table.processingStartedAt} is null) or (${table.processingToken} is not null and ${table.processingStartedAt} is not null)`),
  foreignKey({ columns: [table.tenantId, table.orderId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.orderId, orderLines.id], name: "amazon_order_report_lines_order_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.batchId], foreignColumns: [amazonOrderReportBatches.tenantId, amazonOrderReportBatches.id], name: "amazon_order_report_lines_batch_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.id, table.currentVersionId], foreignColumns: [amazonOrderReportVersions.tenantId, amazonOrderReportVersions.reportLineId, amazonOrderReportVersions.id], name: "amazon_order_report_lines_current_version_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.id, table.reviewedVersionId], foreignColumns: [amazonOrderReportVersions.tenantId, amazonOrderReportVersions.reportLineId, amazonOrderReportVersions.id], name: "amazon_order_report_lines_reviewed_version_fk" }).onDelete("restrict"),
  uniqueIndex("amazon_order_report_lines_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("amazon_order_report_lines_line_unique").on(table.tenantId, table.orderLineId),
  index("amazon_order_report_lines_state_idx").on(table.tenantId, table.state, table.updatedAt),
  index("amazon_order_report_lines_retention_idx").on(table.tenantId, table.expiresAt),
]);

export const amazonOrderReportVersions = pgTable("amazon_order_report_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  reportLineId: uuid("report_line_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  checksum: text("checksum").notNull(),
  encryptedDocument: text("encrypted_document"),
  encryptedArchive: text("encrypted_archive"),
  scanEngine: text("scan_engine").notNull(),
  scanSignature: text("scan_signature").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
}, (table): PgTableExtraConfigValue[] => [
  check("amazon_order_report_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("amazon_order_report_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  check("amazon_order_report_versions_number_check", sql`${table.versionNumber} > 0`),
  foreignKey({ columns: [table.tenantId, table.reportLineId], foreignColumns: [amazonOrderReportLines.tenantId, amazonOrderReportLines.id], name: "amazon_order_report_versions_line_fk" }).onDelete("restrict"),
  uniqueIndex("amazon_order_report_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("amazon_order_report_versions_line_id_unique").on(table.tenantId, table.reportLineId, table.id),
  uniqueIndex("amazon_order_report_versions_number_unique").on(table.tenantId, table.reportLineId, table.versionNumber),
  index("amazon_order_report_versions_retention_idx").on(table.tenantId, table.expiresAt),
]);
