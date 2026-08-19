import { sql } from "drizzle-orm";
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { skus } from "./catalog.js";
import { organizations, users } from "./identity.js";
import { orderLines, orders } from "./order.js";

interface RoutingWeights {
  capability: number;
  region: number;
  cost: number;
  leadTime: number;
  capacity: number;
  quality: number;
  priority: number;
}

interface RoutingThresholds {
  minimumQualityBps: number;
  maximumLeadTimeDays: number;
  maximumUnitCostMinor: number;
  manualApprovalCostMinor: number;
  manualApprovalRiskBps: number;
}

export const fulfillmentSuppliers = pgTable("fulfillment_suppliers", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  status: text("status").default("active").notNull(),
  regionCode: text("region_code").notNull(),
  settlementCurrency: text("settlement_currency").notNull(),
  externalConnectionRef: text("external_connection_ref"),
  priority: integer("priority").default(3).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("fulfillment_suppliers_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("fulfillment_suppliers_kind_check", sql`${table.kind} in ('manual','printify','printful')`),
  check("fulfillment_suppliers_status_check", sql`${table.status} in ('active','suspended','archived')`),
  check("fulfillment_suppliers_currency_check", sql`${table.settlementCurrency} ~ '^[A-Z]{3}$'`),
  check("fulfillment_suppliers_priority_check", sql`${table.priority} between 1 and 5`),
  uniqueIndex("fulfillment_suppliers_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("fulfillment_suppliers_external_unique").on(table.tenantId, table.kind, table.externalConnectionRef),
  index("fulfillment_suppliers_status_idx").on(table.tenantId, table.status, table.priority),
]);

export const supplierCapabilitySnapshots = pgTable("supplier_capability_snapshots", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  supportedSkuIds: jsonb("supported_sku_ids").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  processCodes: jsonb("process_codes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  serviceCountryCodes: jsonb("service_country_codes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  blockedRegionCodes: jsonb("blocked_region_codes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  qualityScoreBps: integer("quality_score_bps").notNull(),
  effectiveAt: timestamp("effective_at", { mode: "date", withTimezone: true }).notNull(),
  sourceVersion: text("source_version").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_capability_snapshots_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_capability_snapshots_version_check", sql`${table.versionNumber} > 0`),
  check("supplier_capability_snapshots_quality_check", sql`${table.qualityScoreBps} between 0 and 10000`),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "supplier_capability_snapshots_supplier_fk" }).onDelete("restrict"),
  uniqueIndex("supplier_capability_snapshots_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_capability_snapshots_version_unique").on(table.tenantId, table.supplierId, table.versionNumber),
  index("supplier_capability_snapshots_effective_idx").on(table.tenantId, table.supplierId, table.effectiveAt),
]);

export const supplierQuotes = pgTable("supplier_quotes", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull(),
  skuId: uuid("sku_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  unitCostMinor: bigint("unit_cost_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  minimumOrderQuantity: integer("minimum_order_quantity").default(1).notNull(),
  leadTimeDays: integer("lead_time_days").notNull(),
  validFrom: timestamp("valid_from", { mode: "date", withTimezone: true }).notNull(),
  validUntil: timestamp("valid_until", { mode: "date", withTimezone: true }).notNull(),
  externalQuoteId: text("external_quote_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_quotes_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_quotes_version_check", sql`${table.versionNumber} > 0`),
  check("supplier_quotes_cost_check", sql`${table.unitCostMinor} >= 0`),
  check("supplier_quotes_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("supplier_quotes_moq_check", sql`${table.minimumOrderQuantity} > 0`),
  check("supplier_quotes_lead_time_check", sql`${table.leadTimeDays} >= 0`),
  check("supplier_quotes_validity_check", sql`${table.validUntil} > ${table.validFrom}`),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "supplier_quotes_supplier_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.skuId], foreignColumns: [skus.tenantId, skus.id], name: "supplier_quotes_sku_fk" }).onDelete("restrict"),
  uniqueIndex("supplier_quotes_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_quotes_version_unique").on(table.tenantId, table.supplierId, table.skuId, table.versionNumber),
  uniqueIndex("supplier_quotes_external_unique").on(table.tenantId, table.supplierId, table.externalQuoteId),
  index("supplier_quotes_lookup_idx").on(table.tenantId, table.skuId, table.validFrom, table.validUntil),
]);

export const supplierCapacityWindows = pgTable("supplier_capacity_windows", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull(),
  windowKey: text("window_key").notNull(),
  versionNumber: integer("version_number").notNull(),
  startsAt: timestamp("starts_at", { mode: "date", withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { mode: "date", withTimezone: true }).notNull(),
  availableUnits: integer("available_units").notNull(),
  reservedUnits: integer("reserved_units").default(0).notNull(),
  sourceVersion: text("source_version").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("supplier_capacity_windows_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("supplier_capacity_windows_version_check", sql`${table.versionNumber} > 0`),
  check("supplier_capacity_windows_range_check", sql`${table.endsAt} > ${table.startsAt}`),
  check("supplier_capacity_windows_units_check", sql`${table.availableUnits} >= 0 and ${table.reservedUnits} between 0 and ${table.availableUnits}`),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "supplier_capacity_windows_supplier_fk" }).onDelete("restrict"),
  uniqueIndex("supplier_capacity_windows_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("supplier_capacity_windows_version_unique").on(table.tenantId, table.supplierId, table.windowKey, table.versionNumber),
  index("supplier_capacity_windows_lookup_idx").on(table.tenantId, table.supplierId, table.startsAt, table.endsAt),
]);

export const routingPolicyVersions = pgTable("routing_policy_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  versionNumber: integer("version_number").notNull(),
  weights: jsonb("weights").$type<RoutingWeights>().notNull(),
  thresholds: jsonb("thresholds").$type<RoutingThresholds>().notNull(),
  tieBreaker: jsonb("tie_breaker").$type<string[]>().notNull(),
  active: boolean("active").default(false).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("routing_policy_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("routing_policy_versions_version_check", sql`${table.versionNumber} > 0`),
  uniqueIndex("routing_policy_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("routing_policy_versions_name_version_unique").on(table.tenantId, table.name, table.versionNumber),
  index("routing_policy_versions_active_idx").on(table.tenantId, table.active, table.createdAt),
]);

export const orderRoutingDecisions = pgTable("order_routing_decisions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  orderLineId: uuid("order_line_id").notNull(),
  routingPolicyVersionId: uuid("routing_policy_version_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  decisionVersion: integer("decision_version").default(1).notNull(),
  status: text("status").notNull(),
  selectedSupplierId: uuid("selected_supplier_id"),
  inputChecksum: text("input_checksum").notNull(),
  requiresApproval: boolean("requires_approval").notNull(),
  approvalReasons: jsonb("approval_reasons").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  selectedAt: timestamp("selected_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_routing_decisions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_routing_decisions_version_check", sql`${table.versionNumber} > 0 and ${table.decisionVersion} > 0`),
  check("order_routing_decisions_status_check", sql`${table.status} in ('no_eligible_supplier','pending_approval','approved','rejected')`),
  check("order_routing_decisions_checksum_check", sql`${table.inputChecksum} ~ '^[0-9a-f]{64}$'`),
  check("order_routing_decisions_selection_check", sql`(${table.status} = 'no_eligible_supplier' and ${table.selectedSupplierId} is null) or (${table.status} <> 'no_eligible_supplier' and ${table.selectedSupplierId} is not null)`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_routing_decisions_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.id], name: "order_routing_decisions_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.routingPolicyVersionId], foreignColumns: [routingPolicyVersions.tenantId, routingPolicyVersions.id], name: "order_routing_decisions_policy_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.selectedSupplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "order_routing_decisions_supplier_fk" }).onDelete("restrict"),
  uniqueIndex("order_routing_decisions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_routing_decisions_line_version_unique").on(table.tenantId, table.orderLineId, table.versionNumber),
  uniqueIndex("order_routing_decisions_idempotency_unique").on(table.tenantId, table.orderLineId, table.idempotencyKey),
  index("order_routing_decisions_status_idx").on(table.tenantId, table.status, table.selectedAt),
]);

export const productionOrderCandidates = pgTable("production_order_candidates", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  routingDecisionId: uuid("routing_decision_id").notNull(),
  supplierId: uuid("supplier_id").notNull(),
  quoteId: uuid("quote_id").notNull(),
  capabilitySnapshotId: uuid("capability_snapshot_id").notNull(),
  capacityWindowId: uuid("capacity_window_id").notNull(),
  rank: integer("rank").notNull(),
  eligible: boolean("eligible").notNull(),
  exclusionCodes: jsonb("exclusion_codes").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  scores: jsonb("scores").$type<Record<string, number>>().notNull(),
  unitCostMinor: bigint("unit_cost_minor", { mode: "number" }).notNull(),
  leadTimeDays: integer("lead_time_days").notNull(),
  availableUnits: integer("available_units").notNull(),
  qualityScoreBps: integer("quality_score_bps").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("production_order_candidates_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("production_order_candidates_rank_check", sql`${table.rank} > 0`),
  check("production_order_candidates_metrics_check", sql`${table.unitCostMinor} >= 0 and ${table.leadTimeDays} >= 0 and ${table.availableUnits} >= 0 and ${table.qualityScoreBps} between 0 and 10000`),
  foreignKey({ columns: [table.tenantId, table.routingDecisionId], foreignColumns: [orderRoutingDecisions.tenantId, orderRoutingDecisions.id], name: "production_order_candidates_decision_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "production_order_candidates_supplier_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.quoteId], foreignColumns: [supplierQuotes.tenantId, supplierQuotes.id], name: "production_order_candidates_quote_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.capabilitySnapshotId], foreignColumns: [supplierCapabilitySnapshots.tenantId, supplierCapabilitySnapshots.id], name: "production_order_candidates_capability_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.capacityWindowId], foreignColumns: [supplierCapacityWindows.tenantId, supplierCapacityWindows.id], name: "production_order_candidates_capacity_fk" }).onDelete("restrict"),
  uniqueIndex("production_order_candidates_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("production_order_candidates_rank_unique").on(table.tenantId, table.routingDecisionId, table.rank),
  uniqueIndex("production_order_candidates_supplier_unique").on(table.tenantId, table.routingDecisionId, table.supplierId),
]);

export const orderRoutingDecisionEvents = pgTable("order_routing_decision_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  routingDecisionId: uuid("routing_decision_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  supplierId: uuid("supplier_id"),
  reasonCode: text("reason_code"),
  reason: text("reason"),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_routing_decision_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_routing_decision_events_sequence_check", sql`${table.sequence} > 0`),
  check("order_routing_decision_events_type_check", sql`${table.type} in ('evaluated','approved','rejected','overridden')`),
  check("order_routing_decision_events_override_reason_check", sql`${table.type} <> 'overridden' or (${table.supplierId} is not null and ${table.reasonCode} is not null and ${table.reason} is not null)`),
  foreignKey({ columns: [table.tenantId, table.routingDecisionId], foreignColumns: [orderRoutingDecisions.tenantId, orderRoutingDecisions.id], name: "order_routing_decision_events_decision_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "order_routing_decision_events_supplier_fk" }).onDelete("restrict"),
  uniqueIndex("order_routing_decision_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_routing_decision_events_sequence_unique").on(table.tenantId, table.routingDecisionId, table.sequence),
]);

export const purchaseOrders = pgTable("purchase_orders", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull(),
  orderId: uuid("order_id").notNull(),
  status: text("status").default("draft").notNull(),
  currentVersionNumber: integer("current_version_number").default(1).notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("purchase_orders_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("purchase_orders_status_check", sql`${table.status} in ('draft','pending_approval','approved','submitted','acknowledged','reconciliation_required','cancelled')`),
  check("purchase_orders_version_check", sql`${table.currentVersionNumber} > 0`),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "purchase_orders_supplier_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "purchase_orders_order_fk" }).onDelete("restrict"),
  uniqueIndex("purchase_orders_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("purchase_orders_order_supplier_unique").on(table.tenantId, table.orderId, table.supplierId),
  index("purchase_orders_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const purchaseOrderVersions = pgTable("purchase_order_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  currency: text("currency").notNull(),
  totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
  lineSnapshot: jsonb("line_snapshot").$type<Array<{ orderLineId: string; quantity: number; unitCostMinor: number }>>().notNull(),
  routingDecisionIds: jsonb("routing_decision_ids").$type<string[]>().notNull(),
  checksum: text("checksum").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("purchase_order_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("purchase_order_versions_version_check", sql`${table.versionNumber} > 0`),
  check("purchase_order_versions_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("purchase_order_versions_total_check", sql`${table.totalMinor} >= 0`),
  check("purchase_order_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderId], foreignColumns: [purchaseOrders.tenantId, purchaseOrders.id], name: "purchase_order_versions_order_fk" }).onDelete("restrict"),
  uniqueIndex("purchase_order_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("purchase_order_versions_number_unique").on(table.tenantId, table.purchaseOrderId, table.versionNumber),
]);
