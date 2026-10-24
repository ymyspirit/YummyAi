import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { inventoryProcurementReceipts, inventoryPurchaseOrders, inventoryPurchaseOrderVersions } from "./inventory-procurement.js";

/** Minimal original-request evidence. Existing receipts are never backfilled. */
export const inventoryProcurementReceiptRequests = pgTable("inventory_procurement_receipt_requests", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  receiptId: uuid("receipt_id").notNull(),
  purchaseOrderId: uuid("purchase_order_id").notNull(),
  purchaseOrderVersionId: uuid("purchase_order_version_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  evidenceVersion: integer("evidence_version").default(1).notNull(),
  requestChecksum: text("request_checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, table => [
  check("inventory_receipt_requests_id_check", sql`substring(${table.id}::text from 15 for 1)='7'`),
  check("inventory_receipt_requests_version_check", sql`${table.evidenceVersion}=1`),
  check("inventory_receipt_requests_checksum_check", sql`${table.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  check("inventory_receipt_requests_key_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  foreignKey({ columns: [table.tenantId, table.receiptId], foreignColumns: [inventoryProcurementReceipts.tenantId, inventoryProcurementReceipts.id], name: "inventory_receipt_requests_receipt_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderId], foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id], name: "inventory_receipt_requests_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderVersionId], foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id], name: "inventory_receipt_requests_version_fk" }).onDelete("restrict"),
  uniqueIndex("inventory_receipt_requests_receipt_unique").on(table.tenantId, table.receiptId),
  uniqueIndex("inventory_receipt_requests_key_unique").on(table.tenantId, table.idempotencyKey),
]);
