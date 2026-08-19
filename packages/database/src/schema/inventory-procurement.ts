import type {
  ProcurementPurchaseLine,
  ProcurementRequestLine,
} from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import {
  bigint,
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

import { organizations, users } from "./identity.js";
import {
  inventoryLocations,
  inventoryLots,
  inventoryMovements,
  inventoryStockItems,
} from "./inventory.js";
import { fulfillmentSuppliers } from "./order-routing.js";

export const inventoryProcurementRequisitions = pgTable("inventory_procurement_requisitions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  status: text("status").default("draft").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_procurement_requisitions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_procurement_requisitions_status_check", sql`${table.status} in ('draft','rfq_open','ordered','cancelled')`),
  check("inventory_procurement_requisitions_version_check", sql`${table.currentVersion} > 0`),
  unique("inventory_procurement_requisitions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_procurement_requisitions_code_unique").on(table.tenantId, table.code),
  uniqueIndex("inventory_procurement_requisitions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("inventory_procurement_requisitions_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const inventoryProcurementRequisitionVersions = pgTable("inventory_procurement_requisition_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requisitionId: uuid("requisition_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  reasonCode: text("reason_code").notNull(),
  lineSnapshot: jsonb("line_snapshot").$type<ProcurementRequestLine[]>().notNull(),
  checksum: text("checksum").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_procurement_req_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_procurement_req_versions_version_check", sql`${table.versionNumber} > 0`),
  check("inventory_procurement_req_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.requisitionId],
    foreignColumns: [inventoryProcurementRequisitions.tenantId, inventoryProcurementRequisitions.id],
    name: "inventory_procurement_req_versions_req_fk",
  }).onDelete("restrict"),
  unique("inventory_procurement_req_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_procurement_req_versions_number_unique").on(table.tenantId, table.requisitionId, table.versionNumber),
]);

export const inventoryProcurementRfqs = pgTable("inventory_procurement_rfqs", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requisitionId: uuid("requisition_id").notNull(),
  requisitionVersionId: uuid("requisition_version_id").notNull(),
  status: text("status").default("open").notNull(),
  supplierIds: jsonb("supplier_ids").$type<string[]>().notNull(),
  responseDueAt: timestamp("response_due_at", { mode: "date", withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_procurement_rfqs_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_procurement_rfqs_status_check", sql`${table.status} in ('open','closed','cancelled')`),
  foreignKey({
    columns: [table.tenantId, table.requisitionId],
    foreignColumns: [inventoryProcurementRequisitions.tenantId, inventoryProcurementRequisitions.id],
    name: "inventory_procurement_rfqs_req_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.requisitionVersionId],
    foreignColumns: [inventoryProcurementRequisitionVersions.tenantId, inventoryProcurementRequisitionVersions.id],
    name: "inventory_procurement_rfqs_req_version_fk",
  }).onDelete("restrict"),
  unique("inventory_procurement_rfqs_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_procurement_rfqs_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("inventory_procurement_rfqs_status_idx").on(table.tenantId, table.status, table.responseDueAt),
]);

export const inventorySupplierQuoteVersions = pgTable("inventory_supplier_quote_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  rfqId: uuid("rfq_id").notNull(),
  supplierId: uuid("supplier_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  currency: text("currency").notNull(),
  validUntil: timestamp("valid_until", { mode: "date", withTimezone: true }).notNull(),
  lineSnapshot: jsonb("line_snapshot").$type<Array<{
    lineKey: string;
    unitCostMinor: number;
    minimumOrderQuantity: number;
    leadTimeDays: number;
  }>>().notNull(),
  totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
  checksum: text("checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_supplier_quote_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_supplier_quote_versions_version_check", sql`${table.versionNumber} > 0`),
  check("inventory_supplier_quote_versions_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("inventory_supplier_quote_versions_total_check", sql`${table.totalMinor} >= 0`),
  check("inventory_supplier_quote_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.rfqId],
    foreignColumns: [inventoryProcurementRfqs.tenantId, inventoryProcurementRfqs.id],
    name: "inventory_supplier_quote_versions_rfq_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.supplierId],
    foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id],
    name: "inventory_supplier_quote_versions_supplier_fk",
  }).onDelete("restrict"),
  unique("inventory_supplier_quote_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_supplier_quote_versions_number_unique").on(table.tenantId, table.rfqId, table.supplierId, table.versionNumber),
  uniqueIndex("inventory_supplier_quote_versions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const inventoryPurchaseOrders = pgTable("inventory_purchase_orders", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  supplierId: uuid("supplier_id").notNull(),
  requisitionId: uuid("requisition_id"),
  quoteId: uuid("quote_id"),
  status: text("status").default("draft").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  expectedAt: timestamp("expected_at", { mode: "date", withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_purchase_orders_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_purchase_orders_status_check", sql`${table.status} in ('draft','approved','rejected','partially_received','received','reconciliation_required','cancelled')`),
  check("inventory_purchase_orders_version_check", sql`${table.currentVersion} > 0`),
  foreignKey({
    columns: [table.tenantId, table.supplierId],
    foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id],
    name: "inventory_purchase_orders_supplier_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.requisitionId],
    foreignColumns: [inventoryProcurementRequisitions.tenantId, inventoryProcurementRequisitions.id],
    name: "inventory_purchase_orders_req_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.quoteId],
    foreignColumns: [inventorySupplierQuoteVersions.tenantId, inventorySupplierQuoteVersions.id],
    name: "inventory_purchase_orders_quote_fk",
  }).onDelete("restrict"),
  unique("inventory_purchase_orders_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_purchase_orders_code_unique").on(table.tenantId, table.code),
  uniqueIndex("inventory_purchase_orders_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("inventory_purchase_orders_status_idx").on(table.tenantId, table.status, table.expectedAt),
]);

export const inventoryPurchaseOrderVersions = pgTable("inventory_purchase_order_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  currency: text("currency").notNull(),
  expectedAt: timestamp("expected_at", { mode: "date", withTimezone: true }).notNull(),
  lineSnapshot: jsonb("line_snapshot").$type<ProcurementPurchaseLine[]>().notNull(),
  totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
  checksum: text("checksum").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_purchase_order_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_purchase_order_versions_version_check", sql`${table.versionNumber} > 0`),
  check("inventory_purchase_order_versions_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("inventory_purchase_order_versions_total_check", sql`${table.totalMinor} >= 0`),
  check("inventory_purchase_order_versions_checksum_check", sql`${table.checksum} ~ '^[0-9a-f]{64}$'`),
  foreignKey({
    columns: [table.tenantId, table.purchaseOrderId],
    foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id],
    name: "inventory_purchase_order_versions_order_fk",
  }).onDelete("restrict"),
  unique("inventory_purchase_order_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_purchase_order_versions_number_unique").on(table.tenantId, table.purchaseOrderId, table.versionNumber),
]);

export const inventoryPurchaseOrderEvents = pgTable("inventory_purchase_order_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  sequence: integer("sequence").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reasonCode: text("reason_code"),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_purchase_order_events_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_purchase_order_events_sequence_check", sql`${table.sequence} > 0`),
  check("inventory_purchase_order_events_action_check", sql`${table.action} in ('created','revised','approved','rejected','partially_received','received','reconciliation_required','cancelled')`),
  foreignKey({
    columns: [table.tenantId, table.purchaseOrderId],
    foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id],
    name: "inventory_purchase_order_events_order_fk",
  }).onDelete("restrict"),
  uniqueIndex("inventory_purchase_order_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_purchase_order_events_sequence_unique").on(table.tenantId, table.purchaseOrderId, table.sequence),
  uniqueIndex("inventory_purchase_order_events_idempotency_unique").on(table.tenantId, table.purchaseOrderId, table.idempotencyKey),
]);

export const inventoryProcurementReceipts = pgTable("inventory_procurement_receipts", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  purchaseOrderVersionId: uuid("purchase_order_version_id").notNull(),
  receivedAt: timestamp("received_at", { mode: "date", withTimezone: true }).notNull(),
  externalReference: text("external_reference"),
  hasVariance: boolean("has_variance").default(false).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_procurement_receipts_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  foreignKey({
    columns: [table.tenantId, table.purchaseOrderId],
    foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id],
    name: "inventory_procurement_receipts_order_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.purchaseOrderVersionId],
    foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id],
    name: "inventory_procurement_receipts_version_fk",
  }).onDelete("restrict"),
  unique("inventory_procurement_receipts_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_procurement_receipts_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("inventory_procurement_receipts_order_idx").on(table.tenantId, table.purchaseOrderId, table.receivedAt),
]);

export const inventoryProcurementReceiptLines = pgTable("inventory_procurement_receipt_lines", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").notNull(),
  lineKey: text("line_key").notNull(),
  stockItemId: uuid("stock_item_id").notNull(),
  destinationLocationId: uuid("destination_location_id").notNull(),
  receivedQuantity: integer("received_quantity").notNull(),
  rejectedQuantity: integer("rejected_quantity").notNull(),
  rejectionReasonCode: text("rejection_reason_code"),
  unit: text("unit").notNull(),
  unitCostMinor: bigint("unit_cost_minor", { mode: "number" }).notNull(),
  lotId: uuid("lot_id"),
  movementId: uuid("movement_id"),
}, (table) => [
  check("inventory_procurement_receipt_lines_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_procurement_receipt_lines_quantity_check", sql`${table.receivedQuantity} >= 0 and ${table.rejectedQuantity} >= 0 and (${table.receivedQuantity} + ${table.rejectedQuantity}) > 0`),
  check("inventory_procurement_receipt_lines_rejection_check", sql`(${table.rejectedQuantity} = 0 and ${table.rejectionReasonCode} is null) or (${table.rejectedQuantity} > 0 and ${table.rejectionReasonCode} is not null)`),
  check("inventory_procurement_receipt_lines_unit_check", sql`${table.unit} in ('each','pair','set','meter','gram','kilogram')`),
  check("inventory_procurement_receipt_lines_cost_check", sql`${table.unitCostMinor} >= 0`),
  foreignKey({
    columns: [table.tenantId, table.receiptId],
    foreignColumns: [inventoryProcurementReceipts.tenantId, inventoryProcurementReceipts.id],
    name: "inventory_procurement_receipt_lines_receipt_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "inventory_procurement_receipt_lines_stock_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.destinationLocationId],
    foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    name: "inventory_procurement_receipt_lines_location_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.lotId],
    foreignColumns: [inventoryLots.tenantId, inventoryLots.id],
    name: "inventory_procurement_receipt_lines_lot_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.movementId],
    foreignColumns: [inventoryMovements.tenantId, inventoryMovements.id],
    name: "inventory_procurement_receipt_lines_movement_fk",
  }).onDelete("restrict"),
  uniqueIndex("inventory_procurement_receipt_lines_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_procurement_receipt_lines_line_unique").on(table.tenantId, table.receiptId, table.lineKey),
]);

export const inventorySupplierInvoices = pgTable("inventory_supplier_invoices", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  invoiceNumber: text("invoice_number").notNull(),
  currency: text("currency").notNull(),
  totalMinor: bigint("total_minor", { mode: "number" }).notNull(),
  varianceMinor: bigint("variance_minor", { mode: "number" }).notNull(),
  status: text("status").notNull(),
  issuedAt: timestamp("issued_at", { mode: "date", withTimezone: true }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_supplier_invoices_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_supplier_invoices_currency_check", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("inventory_supplier_invoices_total_check", sql`${table.totalMinor} >= 0`),
  check("inventory_supplier_invoices_status_check", sql`${table.status} in ('matched','reconciliation_required')`),
  foreignKey({
    columns: [table.tenantId, table.purchaseOrderId],
    foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id],
    name: "inventory_supplier_invoices_order_fk",
  }).onDelete("restrict"),
  unique("inventory_supplier_invoices_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_supplier_invoices_number_unique").on(table.tenantId, table.purchaseOrderId, table.invoiceNumber),
  uniqueIndex("inventory_supplier_invoices_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const inventorySupplierInvoiceLines = pgTable("inventory_supplier_invoice_lines", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull(),
  lineKey: text("line_key").notNull(),
  invoicedQuantity: integer("invoiced_quantity").notNull(),
  unitCostMinor: bigint("unit_cost_minor", { mode: "number" }).notNull(),
  varianceMinor: bigint("variance_minor", { mode: "number" }).notNull(),
}, (table) => [
  check("inventory_supplier_invoice_lines_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_supplier_invoice_lines_quantity_check", sql`${table.invoicedQuantity} > 0`),
  check("inventory_supplier_invoice_lines_cost_check", sql`${table.unitCostMinor} >= 0`),
  foreignKey({
    columns: [table.tenantId, table.invoiceId],
    foreignColumns: [inventorySupplierInvoices.tenantId, inventorySupplierInvoices.id],
    name: "inventory_supplier_invoice_lines_invoice_fk",
  }).onDelete("restrict"),
  uniqueIndex("inventory_supplier_invoice_lines_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_supplier_invoice_lines_line_unique").on(table.tenantId, table.invoiceId, table.lineKey),
]);

export const inventoryReplenishmentPolicies = pgTable("inventory_replenishment_policies", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stockItemId: uuid("stock_item_id").notNull(),
  locationId: uuid("location_id").notNull(),
  currentVersion: integer("current_version").default(1).notNull(),
  status: text("status").default("active").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_replenishment_policies_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_replenishment_policies_version_check", sql`${table.currentVersion} > 0`),
  check("inventory_replenishment_policies_status_check", sql`${table.status} in ('active','inactive')`),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "inventory_replenishment_policies_stock_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.locationId],
    foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    name: "inventory_replenishment_policies_location_fk",
  }).onDelete("restrict"),
  unique("inventory_replenishment_policies_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_replenishment_policies_dimension_unique").on(table.tenantId, table.stockItemId, table.locationId),
]);

export const inventoryReplenishmentPolicyVersions = pgTable("inventory_replenishment_policy_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  reorderPoint: integer("reorder_point").notNull(),
  safetyStock: integer("safety_stock").notNull(),
  minimumOrderQuantity: integer("minimum_order_quantity").notNull(),
  leadTimeDays: integer("lead_time_days").notNull(),
  serviceLevelBps: integer("service_level_bps").notNull(),
  reviewIntervalDays: integer("review_interval_days").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_replenishment_policy_versions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_replenishment_policy_versions_version_check", sql`${table.versionNumber} > 0`),
  check("inventory_replenishment_policy_versions_quantity_check", sql`${table.reorderPoint} >= 0 and ${table.safetyStock} >= 0 and ${table.minimumOrderQuantity} > 0`),
  check("inventory_replenishment_policy_versions_days_check", sql`${table.leadTimeDays} >= 0 and ${table.reviewIntervalDays} > 0`),
  check("inventory_replenishment_policy_versions_service_check", sql`${table.serviceLevelBps} between 0 and 10000`),
  foreignKey({
    columns: [table.tenantId, table.policyId],
    foreignColumns: [inventoryReplenishmentPolicies.tenantId, inventoryReplenishmentPolicies.id],
    name: "inventory_replenishment_policy_versions_policy_fk",
  }).onDelete("restrict"),
  unique("inventory_replenishment_policy_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_replenishment_policy_versions_number_unique").on(table.tenantId, table.policyId, table.versionNumber),
  uniqueIndex("inventory_replenishment_policy_versions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
]);

export const inventoryReplenishmentSuggestions = pgTable("inventory_replenishment_suggestions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").notNull(),
  policyVersionId: uuid("policy_version_id").notNull(),
  stockItemId: uuid("stock_item_id").notNull(),
  locationId: uuid("location_id").notNull(),
  availableQuantity: integer("available_quantity").notNull(),
  inTransitQuantity: integer("in_transit_quantity").notNull(),
  suggestedQuantity: integer("suggested_quantity").notNull(),
  status: text("status").default("open").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("inventory_replenishment_suggestions_id_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("inventory_replenishment_suggestions_quantity_check", sql`${table.inTransitQuantity} >= 0 and ${table.suggestedQuantity} >= 0`),
  check("inventory_replenishment_suggestions_status_check", sql`${table.status} in ('open','converted','dismissed')`),
  foreignKey({
    columns: [table.tenantId, table.policyId],
    foreignColumns: [inventoryReplenishmentPolicies.tenantId, inventoryReplenishmentPolicies.id],
    name: "inventory_replenishment_suggestions_policy_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.policyVersionId],
    foreignColumns: [inventoryReplenishmentPolicyVersions.tenantId, inventoryReplenishmentPolicyVersions.id],
    name: "inventory_replenishment_suggestions_version_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.stockItemId],
    foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id],
    name: "inventory_replenishment_suggestions_stock_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.tenantId, table.locationId],
    foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id],
    name: "inventory_replenishment_suggestions_location_fk",
  }).onDelete("restrict"),
  uniqueIndex("inventory_replenishment_suggestions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_replenishment_suggestions_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("inventory_replenishment_suggestions_status_idx").on(table.tenantId, table.status, table.createdAt),
]);
