import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import type { ProcurementCommandKind, ProcurementCommandView, ProcurementCommandOperation } from "@yummyai/contracts/procurement/procurement-command";
import { organizations, users } from "./identity.js";
import { inventoryProcurementWriteRequests } from "./procurement-write-request.js";
import { inventorySupplierInvoiceRequests } from "./procurement-invoice.js";
import { invoiceReconciliations } from "./invoice-reconciliation.js";

/** Retained originals and private proof references; actual procurement stays in its owners. */
export const procurementCommands = pgTable("inventory_procurement_commands", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  kind: text("kind").$type<ProcurementCommandKind>().notNull(), operation: text("operation").$type<ProcurementCommandOperation>().notNull(), targetId: uuid("target_id"),
  requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(), encryptedInput: text("encrypted_input"),
  contractVersion: text("contract_version").notNull().default("procurement-command-v1"),
  status: text("status").$type<ProcurementCommandView["status"]>().notNull().default("prepared"),
  resultProofId: uuid("result_proof_id"), invoiceResultProofId: uuid("invoice_result_proof_id"), reconciliationResultProofId: uuid("reconciliation_result_proof_id"), errorCode: text("error_code").$type<"input_unavailable">(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
  redactedAt: timestamp("redacted_at", { mode: "date", withTimezone: true }),
}, t => [
  uniqueIndex("procurement_commands_scope").on(t.tenantId, t.id),
  uniqueIndex("procurement_commands_key").on(t.tenantId, t.operation, t.requestKey),
  uniqueIndex("procurement_commands_unacknowledged").on(t.tenantId, t.kind, t.createdBy, sql`coalesce(${t.targetId},'00000000-0000-0000-0000-000000000000'::uuid)`).where(sql`${t.acknowledgedAt} is null`),
  index("procurement_commands_retention").on(t.tenantId, t.expiresAt).where(sql`${t.encryptedInput} is not null`),
  foreignKey({ columns: [t.tenantId, t.resultProofId], foreignColumns: [inventoryProcurementWriteRequests.tenantId, inventoryProcurementWriteRequests.id], name: "procurement_command_proof_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.invoiceResultProofId], foreignColumns: [inventorySupplierInvoiceRequests.tenantId, inventorySupplierInvoiceRequests.id], name: "procurement_command_invoice_proof_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.reconciliationResultProofId], foreignColumns: [invoiceReconciliations.tenantId, invoiceReconciliations.id], name: "procurement_command_reconciliation_fk" }).onDelete("restrict"),
  check("procurement_commands_status", sql`${t.status} in ('prepared','succeeded','cancelled','expired')`),
  check("procurement_commands_result", sql`(${t.status}='succeeded')=(${t.resultProofId} is not null or ${t.invoiceResultProofId} is not null or ${t.reconciliationResultProofId} is not null) and (${t.status}='prepared')=(${t.completedAt} is null)
    and (case when ${t.kind}='invoice_record' then ${t.resultProofId} is null and ${t.reconciliationResultProofId} is null when ${t.kind}='invoice_reconcile' then ${t.resultProofId} is null and ${t.invoiceResultProofId} is null else ${t.invoiceResultProofId} is null and ${t.reconciliationResultProofId} is null end)`),
]);
