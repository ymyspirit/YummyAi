import type { ProcurementWriteKind } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { inventoryProcurementRequisitions, inventoryProcurementRfqs, inventorySupplierQuoteVersions,
  inventoryPurchaseOrders, inventoryPurchaseOrderVersions, inventoryPurchaseOrderEvents } from "./inventory-procurement.js";

/** Minimal immutable binding. It contains no raw form and never backfills old facts. */
export const inventoryProcurementWriteRequests = pgTable("inventory_procurement_write_requests", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  operation: text("operation").$type<ProcurementWriteKind>().notNull(),
  targetId: uuid("target_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  evidenceVersion: integer("evidence_version").default(1).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestChecksum: text("request_checksum").notNull(),
  requisitionId: uuid("requisition_id"),
  rfqId: uuid("rfq_id"),
  quoteId: uuid("quote_id"),
  purchaseOrderId: uuid("purchase_order_id"),
  purchaseOrderVersionId: uuid("purchase_order_version_id"),
  purchaseOrderEventId: uuid("purchase_order_event_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, table => [
  check("procurement_write_id_check", sql`substring(${table.id}::text from 15 for 1)='7'`),
  check("procurement_write_kind_check", sql`${table.operation} in ('requisition_create','rfq_create','quote_record','purchase_create','purchase_revise','purchase_review')`),
  check("procurement_write_evidence_check", sql`${table.evidenceVersion}=1`),
  check("procurement_write_key_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  check("procurement_write_checksum_check", sql`${table.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.requisitionId], foreignColumns: [inventoryProcurementRequisitions.tenantId, inventoryProcurementRequisitions.id], name: "procurement_write_req_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.rfqId], foreignColumns: [inventoryProcurementRfqs.tenantId, inventoryProcurementRfqs.id], name: "procurement_write_rfq_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.quoteId], foreignColumns: [inventorySupplierQuoteVersions.tenantId, inventorySupplierQuoteVersions.id], name: "procurement_write_quote_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderId], foreignColumns: [inventoryPurchaseOrders.tenantId, inventoryPurchaseOrders.id], name: "procurement_write_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderVersionId], foreignColumns: [inventoryPurchaseOrderVersions.tenantId, inventoryPurchaseOrderVersions.id], name: "procurement_write_version_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.purchaseOrderEventId], foreignColumns: [inventoryPurchaseOrderEvents.tenantId, inventoryPurchaseOrderEvents.id], name: "procurement_write_event_fk" }).onDelete("restrict"),
  uniqueIndex("procurement_write_key_unique").on(table.tenantId, table.operation, table.idempotencyKey),
  uniqueIndex("procurement_write_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("procurement_write_req_unique").on(table.tenantId, table.requisitionId).where(sql`${table.operation}='requisition_create'`),
  uniqueIndex("procurement_write_rfq_unique").on(table.tenantId, table.rfqId).where(sql`${table.operation}='rfq_create'`),
  uniqueIndex("procurement_write_quote_unique").on(table.tenantId, table.quoteId).where(sql`${table.operation}='quote_record'`),
  uniqueIndex("procurement_write_event_unique").on(table.tenantId, table.purchaseOrderEventId).where(sql`${table.purchaseOrderEventId} is not null`),
]);
