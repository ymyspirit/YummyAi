import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { InvoiceReconciliationInput, InvoiceReconciliationBalance } from "@yummyai/contracts/procurement/invoice-reconciliation";
import { organizations, users } from "./identity.js";
import { inventorySupplierInvoices, inventorySupplierInvoiceLines, inventoryProcurementReceiptLines, inventoryPurchaseOrders, inventoryPurchaseOrderVersions } from "./inventory-procurement.js";
import { inventorySupplierInvoiceRequests, inventorySupplierInvoiceAllocations } from "./procurement-invoice.js";
import { exactStockQuantity, stockQuantity } from "../stock-quantity.js";

/** Actual immutable document, business review, or later-receipt matching event; also the command's actual proof. */
export const invoiceReconciliations = pgTable("inventory_invoice_reconciliations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  invoiceId: uuid("invoice_id").notNull(), originalProofId: uuid("original_proof_id").notNull(),
  purchaseOrderId: uuid("purchase_order_id").notNull(), purchaseOrderVersionId: uuid("purchase_order_version_id").notNull(),
  supplierId: uuid("supplier_id").notNull(), sequence: integer("sequence").notNull(), previousId: uuid("previous_id"), adjustmentId: uuid("adjustment_id"),
  action: text("action").$type<InvoiceReconciliationInput["action"]>().notNull(),
  input: jsonb("input").$type<InvoiceReconciliationInput>().notNull(), balance: jsonb("balance").$type<InvoiceReconciliationBalance>().notNull(),
  documentKey: text("document_key"), requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  creationTransactionId: text("creation_transaction_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("invoice_reconciliation_scope").on(t.tenantId, t.id),
  uniqueIndex("invoice_reconciliation_key").on(t.tenantId, t.requestKey),
  uniqueIndex("invoice_reconciliation_sequence").on(t.tenantId, t.invoiceId, t.sequence),
  uniqueIndex("invoice_reconciliation_review").on(t.tenantId, t.adjustmentId).where(sql`${t.adjustmentId} is not null`),
  uniqueIndex("invoice_reconciliation_document").on(t.tenantId, t.supplierId, t.documentKey).where(sql`${t.documentKey} is not null`),
  foreignKey({ columns: [t.tenantId, t.invoiceId], foreignColumns: [inventorySupplierInvoices.tenantId, inventorySupplierInvoices.id], name: "invoice_reconciliation_invoice_fk" }),
  foreignKey({ columns: [t.tenantId, t.originalProofId], foreignColumns: [inventorySupplierInvoiceRequests.tenantId, inventorySupplierInvoiceRequests.id], name: "invoice_reconciliation_original_fk" }),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderId], foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id], name: "invoice_reconciliation_order_fk" }),
  foreignKey({ columns: [t.tenantId, t.purchaseOrderVersionId], foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id], name: "invoice_reconciliation_version_fk" }),
  foreignKey({ columns: [t.tenantId, t.previousId], foreignColumns: [t.tenantId, t.id], name: "invoice_reconciliation_previous_fk" }),
  foreignKey({ columns: [t.tenantId, t.adjustmentId], foreignColumns: [t.tenantId, t.id], name: "invoice_reconciliation_adjustment_fk" }),
  check("invoice_reconciliation_action", sql`${t.action} in ('adjustment_record','adjustment_review','receipt_match') and ${t.sequence}>0`),
  check("invoice_reconciliation_checksum", sql`${t.requestChecksum} ~ '^[a-f0-9]{64}$' and length(${t.requestKey}) between 8 and 200`),
]);

/** Financial receipt occupation only. It never creates or changes actual stock. */
export const invoiceAllocationEffects = pgTable("inventory_invoice_allocation_effects", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  eventId: uuid("event_id").notNull(), invoiceLineId: uuid("invoice_line_id").notNull(), receiptLineId: uuid("receipt_line_id").notNull(),
  kind: text("kind").$type<"consume" | "release">().notNull(), quantity: stockQuantity("quantity").notNull(), unit: text("unit").notNull(),
  sourceAllocationId: uuid("source_allocation_id"), sourceEffectId: uuid("source_effect_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("invoice_allocation_effect_scope").on(t.tenantId, t.id),
  foreignKey({ columns: [t.tenantId, t.eventId], foreignColumns: [invoiceReconciliations.tenantId, invoiceReconciliations.id], name: "invoice_effect_event_fk" }),
  foreignKey({ columns: [t.tenantId, t.invoiceLineId], foreignColumns: [inventorySupplierInvoiceLines.tenantId, inventorySupplierInvoiceLines.id], name: "invoice_effect_line_fk" }),
  foreignKey({ columns: [t.tenantId, t.receiptLineId], foreignColumns: [inventoryProcurementReceiptLines.tenantId, inventoryProcurementReceiptLines.id], name: "invoice_effect_receipt_fk" }),
  foreignKey({ columns: [t.tenantId, t.sourceAllocationId], foreignColumns: [inventorySupplierInvoiceAllocations.tenantId, inventorySupplierInvoiceAllocations.id], name: "invoice_effect_source_fk" }),
  foreignKey({ columns: [t.tenantId, t.sourceEffectId], foreignColumns: [t.tenantId, t.id], name: "invoice_effect_source_effect_fk" }),
  check("invoice_effect_quantity", sql`${t.quantity}>0 and ${exactStockQuantity(t.quantity, t.unit)}`),
  check("invoice_effect_kind", sql`${t.kind} in ('consume','release') and (case when ${t.kind}='consume' then ${t.sourceAllocationId} is null and ${t.sourceEffectId} is null else (${t.sourceAllocationId} is null)<>(${t.sourceEffectId} is null) end)`),
]);
