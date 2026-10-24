import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { inventorySupplierInvoices, inventorySupplierInvoiceLines, inventoryProcurementReceiptLines, inventoryPurchaseOrders, inventoryPurchaseOrderVersions } from "./inventory-procurement.js";
import { exactStockQuantity, stockQuantity } from "../stock-quantity.js";

export const inventorySupplierInvoiceRequests = pgTable("inventory_supplier_invoice_requests", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  invoiceId: uuid("invoice_id").notNull(), purchaseOrderId: uuid("purchase_order_id").notNull(), purchaseOrderVersionId: uuid("purchase_order_version_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }), evidenceVersion: integer("evidence_version").default(1).notNull(),
  requestChecksum: text("request_checksum").notNull(), idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  check("supplier_invoice_request_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("supplier_invoice_request_version_check", sql`${t.evidenceVersion}=1`),
  check("supplier_invoice_request_checksum_check", sql`${t.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  check("supplier_invoice_request_key_check", sql`length(${t.idempotencyKey}) between 8 and 200`),
  foreignKey({ columns: [t.tenantId, t.invoiceId], foreignColumns: [inventorySupplierInvoices.tenantId, inventorySupplierInvoices.id], name: "supplier_invoice_request_invoice_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id], name: "supplier_invoice_request_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderVersionId], foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id], name: "supplier_invoice_request_version_fk" }).onDelete("restrict"),
  uniqueIndex("supplier_invoice_request_invoice_unique").on(t.tenantId, t.invoiceId),
  uniqueIndex("supplier_invoice_request_key_unique").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("supplier_invoice_request_tenant_id_unique").on(t.tenantId, t.id),
]);

/** Accepted receipt quantities can be allocated once across partial invoices. */
export const inventorySupplierInvoiceAllocations = pgTable("inventory_supplier_invoice_allocations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  invoiceLineId: uuid("invoice_line_id").notNull(), receiptLineId: uuid("receipt_line_id").notNull(),
  quantity: stockQuantity("quantity").notNull(), unit: text("unit").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  check("supplier_invoice_allocation_id_check", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("supplier_invoice_allocation_quantity_check", sql`${t.quantity}>0 and ${exactStockQuantity(t.quantity, t.unit)}`),
  check("supplier_invoice_allocation_unit_check", sql`${t.unit} in ('each','pair','set','meter','gram','kilogram')`),
  foreignKey({ columns: [t.tenantId, t.invoiceLineId], foreignColumns: [inventorySupplierInvoiceLines.tenantId, inventorySupplierInvoiceLines.id], name: "supplier_invoice_allocation_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.receiptLineId], foreignColumns: [inventoryProcurementReceiptLines.tenantId, inventoryProcurementReceiptLines.id], name: "supplier_invoice_allocation_receipt_fk" }).onDelete("restrict"),
  uniqueIndex("supplier_invoice_allocation_pair_unique").on(t.tenantId, t.invoiceLineId, t.receiptLineId),
  uniqueIndex("supplier_invoice_allocation_scope").on(t.tenantId, t.id),
]);
