import type { OrderProtectedDetails } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";
import { skus } from "./catalog.js";
import { listings, listingVersions } from "./listing.js";
import { marketplaceAccounts } from "./marketplace.js";

export const orderSourceSnapshots = pgTable("order_source_snapshots", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  platform: text("platform").notNull(),
  externalEventId: text("external_event_id").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  normalizedOrderId: uuid("normalized_order_id").notNull(),
  redactedPayload: jsonb("redacted_payload").$type<Record<string, unknown>>().notNull(),
  payloadChecksum: text("payload_checksum").notNull(),
  receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_source_snapshots_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_source_snapshots_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("order_source_snapshots_checksum_check", sql`${table.payloadChecksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "order_source_snapshots_account_fk" }).onDelete("restrict"),
  uniqueIndex("order_source_snapshots_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_source_snapshots_delivery_unique").on(table.tenantId, table.accountId, table.platform, table.externalEventId),
  index("order_source_snapshots_order_idx").on(table.tenantId, table.normalizedOrderId, table.receivedAt),
]);

export const orders = pgTable("orders", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  sourceSnapshotId: uuid("source_snapshot_id").notNull(),
  platform: text("platform").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  providerStatus: text("provider_status").notNull(),
  workflowState: text("workflow_state").default("pending").notNull(),
  sideState: text("side_state"),
  orderTotalMinor: bigint("order_total_minor", { mode: "number" }).notNull(),
  orderCurrency: text("order_currency").notNull(),
  lineCount: integer("line_count").notNull(),
  addressStatus: text("address_status").default("missing").notNull(),
  addressCountryCode: text("address_country_code"),
  latestEventSequence: integer("latest_event_sequence").default(1).notNull(),
  placedAt: timestamp("placed_at", { mode: "date", withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("orders_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("orders_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("orders_workflow_state_check", sql`${table.workflowState} in ('pending','awaiting_customization','awaiting_design','awaiting_customer_approval','awaiting_routing','in_production','awaiting_quality_control','awaiting_shipment','shipped','completed')`),
  check("orders_side_state_check", sql`${table.sideState} is null or ${table.sideState} in ('on_hold','cancelled')`),
  check("orders_currency_check", sql`${table.orderCurrency} ~ '^[A-Z]{3}$'`),
  check("orders_line_count_check", sql`${table.lineCount} > 0`),
  check("orders_address_status_check", sql`${table.addressStatus} in ('missing','protected','anonymized')`),
  check("orders_address_country_check", sql`${table.addressCountryCode} is null or ${table.addressCountryCode} ~ '^[A-Z]{2}$'`),
  check("orders_event_sequence_check", sql`${table.latestEventSequence} > 0`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "orders_account_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.sourceSnapshotId], foreignColumns: [orderSourceSnapshots.tenantId, orderSourceSnapshots.id], name: "orders_source_snapshot_fk" }).onDelete("restrict"),
  uniqueIndex("orders_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("orders_provider_identity_unique").on(table.tenantId, table.accountId, table.platform, table.externalOrderId),
  index("orders_inbox_idx").on(table.tenantId, table.sideState, table.workflowState, table.placedAt),
]);

export const orderLines = pgTable("order_lines", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  externalLineId: text("external_line_id").notNull(),
  externalListingId: text("external_listing_id"),
  skuCode: text("sku_code"),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceMinor: bigint("unit_price_minor", { mode: "number" }).notNull(),
  unitPriceCurrency: text("unit_price_currency").notNull(),
  customizationCount: integer("customization_count").default(0).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_lines_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_lines_quantity_check", sql`${table.quantity} > 0`),
  check("order_lines_currency_check", sql`${table.unitPriceCurrency} ~ '^[A-Z]{3}$'`),
  check("order_lines_customization_count_check", sql`${table.customizationCount} >= 0`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_lines_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_lines_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_lines_external_unique").on(table.tenantId, table.orderId, table.externalLineId),
  index("order_lines_order_idx").on(table.tenantId, table.orderId, table.createdAt),
]);

export const orderExternalReferences = pgTable("order_external_references", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  orderLineId: uuid("order_line_id"),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  externalId: text("external_id").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_external_references_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_external_references_provider_check", sql`${table.provider} in ('amazon','etsy')`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_external_references_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.id], name: "order_external_references_line_fk" }).onDelete("restrict"),
  uniqueIndex("order_external_references_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_external_references_identity_unique").on(table.tenantId, table.orderId, table.kind, table.externalId),
]);

export const orderEvents = pgTable("order_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  fromWorkflowState: text("from_workflow_state"),
  toWorkflowState: text("to_workflow_state"),
  fromSideState: text("from_side_state"),
  toSideState: text("to_side_state"),
  code: text("code"),
  message: text("message"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_events_sequence_check", sql`${table.sequence} > 0`),
  check("order_events_type_check", sql`${table.type} in ('order_ingested','provider_update_received','workflow_transitioned','side_state_changed','exception_opened','exception_resolved','protected_details_accessed','protected_details_anonymized')`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_events_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_events_sequence_unique").on(table.tenantId, table.orderId, table.sequence),
  uniqueIndex("order_events_idempotency_unique").on(table.tenantId, table.orderId, table.idempotencyKey),
  index("order_events_order_idx").on(table.tenantId, table.orderId, table.occurredAt),
]);

export const orderExceptions = pgTable("order_exceptions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  category: text("category").notNull(),
  code: text("code").notNull(),
  message: text("message").notNull(),
  openedBy: uuid("opened_by").references(() => users.id, { onDelete: "set null" }),
  openedAt: timestamp("opened_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_exceptions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_exceptions_category_check", sql`${table.category} in ('address','customization_missing','design_overdue','customer_timeout','sourcing','production','quality','logistics','cancellation_requested','refund','remake','reshipment')`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_exceptions_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_exceptions_tenant_id_unique").on(table.tenantId, table.id),
  index("order_exceptions_order_idx").on(table.tenantId, table.orderId, table.openedAt),
]);

export const orderExceptionEvents = pgTable("order_exception_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  exceptionId: uuid("exception_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(),
  resolution: text("resolution"),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_exception_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_exception_events_sequence_check", sql`${table.sequence} > 0`),
  check("order_exception_events_status_check", sql`${table.status} in ('open','resolved')`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_exception_events_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.exceptionId], foreignColumns: [orderExceptions.tenantId, orderExceptions.id], name: "order_exception_events_exception_fk" }).onDelete("restrict"),
  uniqueIndex("order_exception_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_exception_events_sequence_unique").on(table.tenantId, table.exceptionId, table.sequence),
  uniqueIndex("order_exception_events_idempotency_unique").on(table.tenantId, table.orderId, table.idempotencyKey),
]);

export const orderProtectedDetails = pgTable("order_protected_details", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  encryptedEnvelope: text("encrypted_envelope"),
  envelopeVersion: integer("envelope_version").default(1).notNull(),
  status: text("status").default("protected").notNull(),
  countryCode: text("country_code"),
  retentionExpiresAt: timestamp("retention_expires_at", { mode: "date", withTimezone: true }).notNull(),
  anonymizedAt: timestamp("anonymized_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_protected_details_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_protected_details_version_check", sql`${table.envelopeVersion} > 0`),
  check("order_protected_details_status_check", sql`${table.status} in ('protected','anonymized')`),
  check("order_protected_details_country_check", sql`${table.countryCode} is null or ${table.countryCode} ~ '^[A-Z]{2}$'`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_protected_details_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_protected_details_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_protected_details_order_unique").on(table.tenantId, table.orderId),
  index("order_protected_details_retention_idx").on(table.tenantId, table.status, table.retentionExpiresAt),
]);

export const orderProtectedAccessEvents = pgTable("order_protected_access_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  purpose: text("purpose").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  granted: boolean("granted").notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_protected_access_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_protected_access_events_purpose_check", sql`${table.purpose} in ('fulfillment','customer_support','fraud_review','legal','retention')`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_protected_access_events_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_protected_access_events_tenant_id_unique").on(table.tenantId, table.id),
  index("order_protected_access_events_order_idx").on(table.tenantId, table.orderId, table.occurredAt),
]);

export const orderConnectorCheckpoints = pgTable("order_connector_checkpoints", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  platform: text("platform").notNull(),
  stream: text("stream").notNull(),
  cursor: text("cursor"),
  highWaterAt: timestamp("high_water_at", { mode: "date", withTimezone: true }),
  version: integer("version").default(1).notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_connector_checkpoints_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_connector_checkpoints_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("order_connector_checkpoints_version_check", sql`${table.version} > 0`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "order_connector_checkpoints_account_fk" }).onDelete("restrict"),
  uniqueIndex("order_connector_checkpoints_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_connector_checkpoints_stream_unique").on(table.tenantId, table.accountId, table.platform, table.stream),
]);

export const orderIngestionRuns = pgTable("order_ingestion_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  platform: text("platform").notNull(),
  stream: text("stream").notNull(),
  status: text("status").default("running").notNull(),
  collectedCount: integer("collected_count").default(0).notNull(),
  reportedCount: integer("reported_count"),
  duplicateCount: integer("duplicate_count").default(0).notNull(),
  riskCount: integer("risk_count").default(0).notNull(),
  sourceVersion: text("source_version").notNull(),
  checkpointVersionStart: integer("checkpoint_version_start").notNull(),
  checkpointVersionEnd: integer("checkpoint_version_end"),
  highWaterAt: timestamp("high_water_at", { mode: "date", withTimezone: true }),
  errorCode: text("error_code"),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
}, (table) => [
  check("order_ingestion_runs_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_ingestion_runs_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("order_ingestion_runs_status_check", sql`${table.status} in ('running','completed','partial','failed')`),
  check("order_ingestion_runs_counts_check", sql`${table.collectedCount} >= 0 and (${table.reportedCount} is null or ${table.reportedCount} >= 0) and ${table.duplicateCount} >= 0 and ${table.riskCount} >= 0`),
  check("order_ingestion_runs_versions_check", sql`${table.checkpointVersionStart} > 0 and (${table.checkpointVersionEnd} is null or ${table.checkpointVersionEnd} > ${table.checkpointVersionStart})`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "order_ingestion_runs_account_fk" }).onDelete("restrict"),
  uniqueIndex("order_ingestion_runs_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_ingestion_runs_active_stream_unique")
    .on(table.tenantId, table.accountId, table.platform, table.stream)
    .where(sql`${table.status} = 'running'`),
  index("order_ingestion_runs_account_idx").on(table.tenantId, table.accountId, table.startedAt),
]);

export const orderIngestionRisks = pgTable("order_ingestion_risks", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  ingestionRunId: uuid("ingestion_run_id").notNull(),
  orderId: uuid("order_id"),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  externalOrderId: text("external_order_id").notNull(),
  externalLineId: text("external_line_id"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_ingestion_risks_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_ingestion_risks_code_check", sql`${table.code} in ('duplicate_delivery','address_gap','customization_missing','unsupported_mapping','cancellation_requested','stale_provider_data')`),
  check("order_ingestion_risks_severity_check", sql`${table.severity} in ('blocker','warning','info')`),
  foreignKey({ columns: [table.tenantId, table.ingestionRunId], foreignColumns: [orderIngestionRuns.tenantId, orderIngestionRuns.id], name: "order_ingestion_risks_run_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_ingestion_risks_order_fk" }).onDelete("restrict"),
  uniqueIndex("order_ingestion_risks_tenant_id_unique").on(table.tenantId, table.id),
  index("order_ingestion_risks_run_idx").on(table.tenantId, table.ingestionRunId, table.severity, table.createdAt),
]);

export const orderLineCatalogLinks = pgTable("order_line_catalog_links", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderLineId: uuid("order_line_id").notNull(),
  skuId: uuid("sku_id"),
  listingId: uuid("listing_id"),
  listingVersionId: uuid("listing_version_id"),
  matchSource: text("match_source").notNull(),
  linkedBy: uuid("linked_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_line_catalog_links_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_line_catalog_links_source_check", sql`${table.matchSource} in ('external_listing','sku','manual')`),
  check("order_line_catalog_links_target_check", sql`${table.skuId} is not null or (${table.listingId} is not null and ${table.listingVersionId} is not null)`),
  foreignKey({ columns: [table.tenantId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.id], name: "order_line_catalog_links_order_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.skuId], foreignColumns: [skus.tenantId, skus.id], name: "order_line_catalog_links_sku_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.listingId], foreignColumns: [listings.tenantId, listings.id], name: "order_line_catalog_links_listing_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.listingVersionId], foreignColumns: [listingVersions.tenantId, listingVersions.id], name: "order_line_catalog_links_listing_version_fk" }).onDelete("restrict"),
  uniqueIndex("order_line_catalog_links_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_line_catalog_links_order_line_unique").on(table.tenantId, table.orderLineId),
]);

export type StoredOrderProtectedDetails = OrderProtectedDetails;
