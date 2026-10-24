import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { IncomingCriterion, IncomingReading, evaluateIncomingReadings } from "@yummyai/contracts/procurement/incoming";
import { organizations, users } from "./identity.js";
import { inventoryLocations, inventoryStockItems } from "./inventory.js";
import { inventoryProcurementReceipts, inventoryPurchaseOrders, inventoryPurchaseOrderVersions } from "./inventory-procurement.js";
import { exactStockQuantity, stockQuantity } from "../stock-quantity.js";

const identity = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
});
const request = () => ({ requestChecksum: text("request_checksum").notNull(), idempotencyKey: text("idempotency_key").notNull() });

export const incomingStandards = pgTable("inventory_incoming_standards", {
  ...identity(), ...request(), stockItemId: uuid("stock_item_id").notNull(), code: text("code").notNull(),
  versionNumber: integer("version_number").notNull(), title: text("title").notNull(),
  sourceReference: text("source_reference").notNull(), criteria: jsonb("criteria").$type<IncomingCriterion[]>().notNull(),
}, t => [
  unique("incoming_standards_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("incoming_standards_version_unique").on(t.tenantId, t.stockItemId, t.code, t.versionNumber),
  uniqueIndex("incoming_standards_request_unique").on(t.tenantId, t.idempotencyKey),
  check("incoming_standards_version_check", sql`${t.versionNumber}>0`),
  foreignKey({ columns: [t.tenantId, t.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id], name: "incoming_standards_stock_fk" }).onDelete("restrict"),
]);

export const procurementArrivals = pgTable("inventory_procurement_arrivals", {
  ...identity(), ...request(), code: text("code").notNull(), purchaseOrderId: uuid("purchase_order_id").notNull(),
  purchaseOrderVersionId: uuid("purchase_order_version_id").notNull(),
  arrivedAt: timestamp("arrived_at", { mode: "date", withTimezone: true }).notNull(), externalReference: text("external_reference").notNull(),
}, t => [
  unique("procurement_arrivals_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("procurement_arrivals_code_unique").on(t.tenantId, t.code),
  uniqueIndex("procurement_arrivals_request_unique").on(t.tenantId, t.idempotencyKey),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id], name: "procurement_arrivals_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderVersionId], foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id], name: "procurement_arrivals_version_fk" }).onDelete("restrict"),
]);

export const procurementArrivalLines = pgTable("inventory_procurement_arrival_lines", {
  ...identity(), arrivalId: uuid("arrival_id").notNull(), lineKey: text("line_key").notNull(),
  stockItemId: uuid("stock_item_id").notNull(), holdingLocationId: uuid("holding_location_id").notNull(),
  quantity: stockQuantity("quantity").notNull(), unit: text("unit").notNull(), supplierLotCode: text("supplier_lot_code").notNull(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),
}, t => [
  unique("procurement_arrival_lines_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("procurement_arrival_lines_line_unique").on(t.tenantId, t.arrivalId, t.lineKey),
  check("procurement_arrival_lines_quantity_check", sql`${t.quantity}>0 and ${exactStockQuantity(t.quantity, t.unit)}`),
  check("procurement_arrival_lines_unit_check", sql`${t.unit} in ('each','pair','set','meter','gram','kilogram')`),
  foreignKey({ columns: [t.tenantId, t.arrivalId], foreignColumns: [procurementArrivals.tenantId, procurementArrivals.id], name: "procurement_arrival_lines_arrival_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id], name: "procurement_arrival_lines_stock_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.holdingLocationId], foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id], name: "procurement_arrival_lines_location_fk" }).onDelete("restrict"),
]);

export const incomingInspections = pgTable("inventory_incoming_inspections", {
  ...identity(), ...request(), arrivalLineId: uuid("arrival_line_id").notNull(), versionNumber: integer("version_number").notNull(),
  standardVersionId: uuid("standard_version_id").notNull(), acceptedQuantity: stockQuantity("accepted_quantity").notNull(),
  rejectedQuantity: stockQuantity("rejected_quantity").notNull(), sampleQuantity: stockQuantity("sample_quantity").notNull(), unit: text("unit").notNull(),
  rejectionReason: text("rejection_reason"), measuredAt: timestamp("measured_at", { mode: "date", withTimezone: true }).notNull(),
  readings: jsonb("readings").$type<IncomingReading[]>().notNull(), evaluation: jsonb("evaluation").$type<ReturnType<typeof evaluateIncomingReadings>>().notNull(), notes: text("notes"),
}, t => [
  unique("incoming_inspections_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("incoming_inspections_version_unique").on(t.tenantId, t.arrivalLineId, t.versionNumber),
  uniqueIndex("incoming_inspections_request_unique").on(t.tenantId, t.idempotencyKey),
  check("incoming_inspections_version_check", sql`${t.versionNumber}>0`),
  check("incoming_inspections_quantity_check", sql`${t.acceptedQuantity}>=0 and ${t.rejectedQuantity}>=0 and ${t.acceptedQuantity}+${t.rejectedQuantity}>0 and ${t.sampleQuantity}>0 and ${t.sampleQuantity}<=${t.acceptedQuantity}+${t.rejectedQuantity}`),
  check("incoming_inspections_accepted_exact", exactStockQuantity(t.acceptedQuantity, t.unit)),
  check("incoming_inspections_rejected_exact", exactStockQuantity(t.rejectedQuantity, t.unit)),
  check("incoming_inspections_sample_exact", exactStockQuantity(t.sampleQuantity, t.unit)),
  check("incoming_inspections_rejection_check", sql`(${t.rejectedQuantity}>0)=(${t.rejectionReason} is not null)`),
  foreignKey({ columns: [t.tenantId, t.arrivalLineId], foreignColumns: [procurementArrivalLines.tenantId, procurementArrivalLines.id], name: "incoming_inspections_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.standardVersionId], foreignColumns: [incomingStandards.tenantId, incomingStandards.id], name: "incoming_inspections_standard_fk" }).onDelete("restrict"),
]);

export const incomingInspectionReviews = pgTable("inventory_incoming_inspection_reviews", {
  ...identity(), ...request(), inspectionId: uuid("inspection_id").notNull(), decision: text("decision").notNull(), reason: text("reason").notNull(),
}, t => [
  unique("incoming_reviews_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("incoming_reviews_inspection_unique").on(t.tenantId, t.inspectionId),
  uniqueIndex("incoming_reviews_request_unique").on(t.tenantId, t.idempotencyKey),
  check("incoming_reviews_decision_check", sql`${t.decision} in ('approved','rejected')`),
  foreignKey({ columns: [t.tenantId, t.inspectionId], foreignColumns: [incomingInspections.tenantId, incomingInspections.id], name: "incoming_reviews_inspection_fk" }).onDelete("restrict"),
]);

export const incomingPostings = pgTable("inventory_incoming_postings", {
  ...identity(), ...request(), arrivalLineId: uuid("arrival_line_id").notNull(), approvalId: uuid("approval_id").notNull(),
  receiptId: uuid("receipt_id").notNull(), acceptedQuantity: stockQuantity("accepted_quantity").notNull(),
  rejectedQuantity: stockQuantity("rejected_quantity").notNull(), unit: text("unit").notNull(),
  rejectionLocationId: uuid("rejection_location_id"), merchantOwnershipConfirmed: boolean("merchant_ownership_confirmed").notNull(),
  postedAt: timestamp("posted_at", { mode: "date", withTimezone: true }).notNull(),
}, t => [
  unique("incoming_postings_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("incoming_postings_request_unique").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("incoming_postings_receipt_unique").on(t.tenantId, t.receiptId),
  check("incoming_postings_quantity_check", sql`${t.acceptedQuantity}>=0 and ${t.rejectedQuantity}>=0 and ${t.acceptedQuantity}+${t.rejectedQuantity}>0`),
  check("incoming_postings_accepted_exact", exactStockQuantity(t.acceptedQuantity, t.unit)),
  check("incoming_postings_rejected_exact", exactStockQuantity(t.rejectedQuantity, t.unit)),
  check("incoming_postings_rejection_check", sql`(${t.rejectedQuantity}>0)=(${t.rejectionLocationId} is not null)`),
  check("incoming_postings_ownership_check", sql`(${t.acceptedQuantity}>0)=${t.merchantOwnershipConfirmed}`),
  foreignKey({ columns: [t.tenantId, t.arrivalLineId], foreignColumns: [procurementArrivalLines.tenantId, procurementArrivalLines.id], name: "incoming_postings_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.approvalId], foreignColumns: [incomingInspectionReviews.tenantId, incomingInspectionReviews.id], name: "incoming_postings_approval_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.receiptId], foreignColumns: [inventoryProcurementReceipts.tenantId, inventoryProcurementReceipts.id], name: "incoming_postings_receipt_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.rejectionLocationId], foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id], name: "incoming_postings_location_fk" }).onDelete("restrict"),
]);

export const incomingReturns = pgTable("inventory_incoming_returns", {
  ...identity(), ...request(), postingId: uuid("posting_id").notNull(), quantity: stockQuantity("quantity").notNull(), unit: text("unit").notNull(),
  returnedAt: timestamp("returned_at", { mode: "date", withTimezone: true }).notNull(), externalReference: text("external_reference").notNull(), reason: text("reason").notNull(),
}, t => [
  unique("incoming_returns_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("incoming_returns_request_unique").on(t.tenantId, t.idempotencyKey),
  check("incoming_returns_quantity_check", sql`${t.quantity}>0 and ${exactStockQuantity(t.quantity, t.unit)}`),
  foreignKey({ columns: [t.tenantId, t.postingId], foreignColumns: [incomingPostings.tenantId, incomingPostings.id], name: "incoming_returns_posting_fk" }).onDelete("restrict"),
]);
