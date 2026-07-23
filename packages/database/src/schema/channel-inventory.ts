import type {
  ChannelAllocationTarget,
  NetworkStockCondition,
  NetworkStockSource,
} from "@yummyai/contracts/channel-inventory";
import { sql } from "drizzle-orm";
import {
  boolean,
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

import { inventoryLocations, inventoryStockItems, inventoryWarehouses } from "./inventory.js";
import { organizations, users } from "./identity.js";
import { listings } from "./listing.js";
import { marketplaceAccounts, marketplaceListingSyncRequests } from "./marketplace.js";

export const networkInventorySnapshots = pgTable("network_inventory_snapshots", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id"),
  provider: text("provider").notNull(),
  scopeKey: text("scope_key").notNull(),
  providerSnapshotId: text("provider_snapshot_id"),
  observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(),
  checksum: text("checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  recordedBy: uuid("recorded_by").references(() => users.id, { onDelete: "set null" }),
  recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("network_inventory_snapshots_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("network_inventory_snapshots_provider_check", sql`${table.provider} in ('internal','amazon','etsy','third_party','supplier')`),
  check("network_inventory_snapshots_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.accountId],
    foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    name: "network_inventory_snapshots_account_fk",
  }).onDelete("restrict"),
  unique("network_inventory_snapshots_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("network_inventory_snapshots_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("network_inventory_snapshots_scope_idx").on(table.tenantId, table.provider, table.scopeKey, table.observedAt),
]);

export const networkInventorySnapshotLines = pgTable("network_inventory_snapshot_lines", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").notNull(),
  lineNumber: integer("line_number").notNull(),
  stockItemId: uuid("stock_item_id").notNull(),
  warehouseId: uuid("warehouse_id"),
  locationId: uuid("location_id"),
  externalSku: text("external_sku"),
  source: text("source").$type<NetworkStockSource>().notNull(),
  condition: text("condition").$type<NetworkStockCondition>().notNull(),
  quantity: integer("quantity").notNull(),
  unit: text("unit").notNull(),
}, (table) => [
  check("network_inventory_snapshot_lines_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("network_inventory_snapshot_lines_number_check", sql`${table.lineNumber} > 0`),
  check("network_inventory_snapshot_lines_source_check", sql`${table.source} in ('owned','fba','fbm','overseas_3pl','supplier','in_transit','virtual')`),
  check("network_inventory_snapshot_lines_condition_check", sql`${table.condition} in ('sellable','quarantine','damaged')`),
  check("network_inventory_snapshot_lines_quantity_check", sql`${table.quantity} >= 0`),
  check("network_inventory_snapshot_lines_unit_check", sql`${table.unit} in ('each','pair','set','meter','gram','kilogram')`),
  foreignKey({
    columns: [table.tenantId, table.snapshotId],
    foreignColumns: [networkInventorySnapshots.tenantId, networkInventorySnapshots.id],
    name: "network_inventory_snapshot_lines_snapshot_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "network_inventory_snapshot_lines_stock_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.warehouseId],
    foreignColumns: [inventoryWarehouses.tenantId, inventoryWarehouses.id],
    name: "network_inventory_snapshot_lines_warehouse_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.locationId],
    foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    name: "network_inventory_snapshot_lines_location_fk",
  }).onDelete("restrict"),
  unique("network_inventory_snapshot_lines_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("network_inventory_snapshot_lines_number_unique").on(table.tenantId, table.snapshotId, table.lineNumber),
  index("network_inventory_snapshot_lines_stock_idx").on(table.tenantId, table.stockItemId, table.source, table.condition),
]);

export const networkInventoryConnectorCheckpoints = pgTable("network_inventory_connector_checkpoints", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  snapshotId: uuid("snapshot_id").notNull(),
  accountId: uuid("account_id"),
  provider: text("provider").notNull(),
  scopeKey: text("scope_key").notNull(),
  sequence: integer("sequence").notNull(),
  cursor: text("cursor"),
  observedAt: timestamp("observed_at", { mode: "date", withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("network_inventory_connector_checkpoints_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("network_inventory_connector_checkpoints_provider_check", sql`${table.provider} in ('internal','amazon','etsy','third_party','supplier')`),
  check("network_inventory_connector_checkpoints_sequence_check", sql`${table.sequence} > 0`),
  foreignKey({
    columns: [table.tenantId, table.snapshotId],
    foreignColumns: [networkInventorySnapshots.tenantId, networkInventorySnapshots.id],
    name: "network_inventory_connector_checkpoints_snapshot_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.accountId],
    foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    name: "network_inventory_connector_checkpoints_account_fk",
  }).onDelete("restrict"),
  unique("network_inventory_connector_checkpoints_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("network_inventory_connector_checkpoints_snapshot_unique").on(table.tenantId, table.snapshotId),
  uniqueIndex("network_inventory_connector_checkpoints_sequence_unique").on(table.tenantId, table.provider, table.scopeKey, table.sequence),
  index("network_inventory_connector_checkpoints_latest_idx").on(table.tenantId, table.provider, table.scopeKey, table.sequence),
]);

export const channelAllocationPolicies = pgTable("channel_allocation_policies", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stockItemId: uuid("stock_item_id").notNull(),
  name: text("name").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  status: text("status").default("active").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_allocation_policies_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("channel_allocation_policies_version_check", sql`${table.currentVersion} > 0`),
  check("channel_allocation_policies_status_check", sql`${table.status} in ('active','inactive')`),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "channel_allocation_policies_stock_fk",
  }).onDelete("restrict"),
  unique("channel_allocation_policies_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_allocation_policies_stock_unique").on(table.tenantId, table.stockItemId),
  index("channel_allocation_policies_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const channelAllocationPolicyVersions = pgTable("channel_allocation_policy_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  eligibleSources: jsonb("eligible_sources").$type<NetworkStockSource[]>().notNull(),
  allowVirtual: boolean("allow_virtual").default(false).notNull(),
  safetyBufferQuantity: integer("safety_buffer_quantity").default(0).notNull(),
  channels: jsonb("channels").$type<ChannelAllocationTarget[]>().notNull(),
  reasonCode: text("reason_code").notNull(),
  checksum: text("checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_allocation_policy_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("channel_allocation_policy_versions_number_check", sql`${table.versionNumber} > 0`),
  check("channel_allocation_policy_versions_buffer_check", sql`${table.safetyBufferQuantity} >= 0`),
  check("channel_allocation_policy_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.policyId],
    foreignColumns: [channelAllocationPolicies.tenantId, channelAllocationPolicies.id],
    name: "channel_allocation_policy_versions_policy_fk",
  }).onDelete("restrict"),
  unique("channel_allocation_policy_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_allocation_policy_versions_number_unique").on(table.tenantId, table.policyId, table.versionNumber),
  uniqueIndex("channel_allocation_policy_versions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const channelAllocationRuns = pgTable("channel_allocation_runs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull(),
  policyVersionId: uuid("policy_version_id").notNull(),
  stockItemId: uuid("stock_item_id").notNull(),
  eligibleQuantity: integer("eligible_quantity").notNull(),
  allocatableQuantity: integer("allocatable_quantity").notNull(),
  allocatedQuantity: integer("allocated_quantity").notNull(),
  unit: text("unit").notNull(),
  inputChecksum: text("input_checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  calculatedBy: uuid("calculated_by").references(() => users.id, { onDelete: "set null" }),
  calculatedAt: timestamp("calculated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_allocation_runs_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("channel_allocation_runs_quantity_check", sql`${table.eligibleQuantity} >= 0 and ${table.allocatableQuantity} >= 0 and ${table.allocatedQuantity} >= 0 and ${table.allocatableQuantity} <= ${table.eligibleQuantity} and ${table.allocatedQuantity} <= ${table.allocatableQuantity}`),
  check("channel_allocation_runs_unit_check", sql`${table.unit} in ('each','pair','set','meter','gram','kilogram')`),
  check("channel_allocation_runs_checksum_check", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.policyId],
    foreignColumns: [channelAllocationPolicies.tenantId, channelAllocationPolicies.id],
    name: "channel_allocation_runs_policy_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.policyVersionId],
    foreignColumns: [channelAllocationPolicyVersions.tenantId, channelAllocationPolicyVersions.id],
    name: "channel_allocation_runs_policy_version_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "channel_allocation_runs_stock_fk",
  }).onDelete("restrict"),
  unique("channel_allocation_runs_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_allocation_runs_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("channel_allocation_runs_policy_idx").on(table.tenantId, table.policyId, table.calculatedAt),
]);

export const channelAvailabilityProjections = pgTable("channel_availability_projections", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull(),
  stockItemId: uuid("stock_item_id").notNull(),
  accountId: uuid("account_id").notNull(),
  platform: text("platform").notNull(),
  marketplaceId: text("marketplace_id").notNull(),
  listingId: uuid("listing_id"),
  priority: integer("priority").notNull(),
  capQuantity: integer("cap_quantity"),
  bufferQuantity: integer("buffer_quantity").default(0).notNull(),
  allocatedQuantity: integer("allocated_quantity").notNull(),
  unit: text("unit").notNull(),
  sourceTrace: jsonb("source_trace").$type<Array<{
    snapshotId: string;
    source: NetworkStockSource;
    condition: NetworkStockCondition;
    quantity: number;
  }>>().notNull(),
  calculatedAt: timestamp("calculated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_availability_projections_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("channel_availability_projections_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("channel_availability_projections_quantity_check", sql`${table.priority} > 0 and ${table.bufferQuantity} >= 0 and ${table.allocatedQuantity} >= 0 and (${table.capQuantity} is null or ${table.capQuantity} >= 0)`),
  check("channel_availability_projections_unit_check", sql`${table.unit} in ('each','pair','set','meter','gram','kilogram')`),
  foreignKey({
    columns: [table.tenantId, table.runId],
    foreignColumns: [channelAllocationRuns.tenantId, channelAllocationRuns.id],
    name: "channel_availability_projections_run_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "channel_availability_projections_stock_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.accountId],
    foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    name: "channel_availability_projections_account_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.listingId],
    foreignColumns: [listings.tenantId, listings.id],
    name: "channel_availability_projections_listing_fk",
  }).onDelete("restrict"),
  unique("channel_availability_projections_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_availability_projections_target_unique").on(table.tenantId, table.runId, table.accountId, table.marketplaceId, table.listingId),
  index("channel_availability_projections_target_idx").on(table.tenantId, table.accountId, table.marketplaceId, table.listingId, table.calculatedAt),
]);

export const channelMutationReconciliations = pgTable("channel_mutation_reconciliations", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull(),
  listingId: uuid("listing_id"),
  syncRequestId: uuid("sync_request_id"),
  mutationKey: text("mutation_key").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_mutation_reconciliations_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  foreignKey({
    columns: [table.tenantId, table.accountId],
    foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id],
    name: "channel_mutation_reconciliations_account_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.listingId],
    foreignColumns: [listings.tenantId, listings.id],
    name: "channel_mutation_reconciliations_listing_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.syncRequestId],
    foreignColumns: [marketplaceListingSyncRequests.tenantId, marketplaceListingSyncRequests.id],
    name: "channel_mutation_reconciliations_sync_fk",
  }).onDelete("restrict"),
  unique("channel_mutation_reconciliations_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_mutation_reconciliations_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("channel_mutation_reconciliations_account_idx").on(table.tenantId, table.accountId, table.createdAt),
]);

export const channelMutationReconciliationEvents = pgTable("channel_mutation_reconciliation_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  reconciliationId: uuid("reconciliation_id").notNull(),
  sequence: integer("sequence").notNull(),
  status: text("status").notNull(),
  reasonCode: text("reason_code").notNull(),
  message: text("message").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("channel_mutation_reconciliation_events_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("channel_mutation_reconciliation_events_sequence_check", sql`${table.sequence} > 0`),
  check("channel_mutation_reconciliation_events_status_check", sql`${table.status} in ('open','confirmed','rejected')`),
  foreignKey({
    columns: [table.tenantId, table.reconciliationId],
    foreignColumns: [channelMutationReconciliations.tenantId, channelMutationReconciliations.id],
    name: "channel_mutation_reconciliation_events_reconciliation_fk",
  }).onDelete("restrict"),
  unique("channel_mutation_reconciliation_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("channel_mutation_reconciliation_events_sequence_unique").on(table.tenantId, table.reconciliationId, table.sequence),
  uniqueIndex("channel_mutation_reconciliation_events_idempotency_unique").on(table.tenantId, table.reconciliationId, table.idempotencyKey),
]);
