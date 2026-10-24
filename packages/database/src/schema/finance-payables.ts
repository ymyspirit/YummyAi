import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AllocateFinancePaymentInput, RecordFinanceBillInput, RecordFinancePaymentInput } from "@yummyai/contracts/finance/payables";
import { organizations, users } from "./identity.js";
import { fulfillmentSuppliers } from "./order-routing.js";
import { inventorySupplierInvoices } from "./inventory-procurement.js";
import { inventorySupplierInvoiceRequests } from "./procurement-invoice.js";

export const financePayableBills = pgTable("finance_payable_bills", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  supplierId: uuid("supplier_id").notNull(), kind: text("kind").$type<RecordFinanceBillInput["kind"]>().notNull(), externalBillId: text("external_bill_id").notNull(),
  currency: text("currency").notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(), dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
  procurementInvoiceId: uuid("procurement_invoice_id"), procurementProofId: uuid("procurement_proof_id"),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_payable_bill_scope").on(t.tenantId, t.id), uniqueIndex("finance_payable_bill_key").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("finance_payable_bill_external").on(t.tenantId, t.supplierId, t.externalBillId),
  uniqueIndex("finance_payable_bill_procurement").on(t.tenantId, t.procurementInvoiceId).where(sql`${t.procurementInvoiceId} is not null`),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "finance_payable_bill_supplier_fk" }),
  foreignKey({ columns: [t.tenantId, t.procurementInvoiceId], foreignColumns: [inventorySupplierInvoices.tenantId, inventorySupplierInvoices.id], name: "finance_payable_bill_invoice_fk" }),
  foreignKey({ columns: [t.tenantId, t.procurementProofId], foreignColumns: [inventorySupplierInvoiceRequests.tenantId, inventorySupplierInvoiceRequests.id], name: "finance_payable_bill_proof_fk" }),
  check("finance_payable_bill_kind", sql`${t.kind} in ('factory_invoice','supplier_invoice','procurement_invoice') and case when ${t.kind}='procurement_invoice' then ${t.procurementInvoiceId} is not null and ${t.procurementProofId} is not null else ${t.procurementInvoiceId} is null and ${t.procurementProofId} is null end`),
  check("finance_payable_bill_money", sql`${t.amountMinor} between 1 and 9007199254740991 and finance_minor_digits_20260917(${t.currency}) is not null`),
  check("finance_payable_bill_dates", sql`isfinite(${t.issuedAt}) and ${t.issuedAt}>='0001-01-01T00:00:00Z' and ${t.issuedAt}<'10000-01-01T00:00:00Z'
    and date_trunc('milliseconds',${t.issuedAt})=${t.issuedAt} and (${t.dueAt} is null or isfinite(${t.dueAt}) and ${t.dueAt}>=${t.issuedAt}
      and ${t.dueAt}<'10000-01-01T00:00:00Z' and date_trunc('milliseconds',${t.dueAt})=${t.dueAt})`),
  index("finance_payable_bill_recent").on(t.tenantId, t.recordedAt, t.id),
]);

export const financePayablePayments = pgTable("finance_payable_payments", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  supplierId: uuid("supplier_id").notNull(), externalPaymentId: text("external_payment_id").notNull(),
  currency: text("currency").notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }).notNull(), method: text("method").$type<RecordFinancePaymentInput["method"]>().notNull(),
  evidenceReference: text("evidence_reference").notNull(), idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_payable_payment_scope").on(t.tenantId, t.id), uniqueIndex("finance_payable_payment_key").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("finance_payable_payment_external").on(t.tenantId, t.supplierId, t.externalPaymentId),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "finance_payable_payment_supplier_fk" }),
  check("finance_payable_payment_method", sql`${t.method} in ('bank_transfer','card','cash','other')`),
  check("finance_payable_payment_money", sql`${t.amountMinor} between 1 and 9007199254740991 and finance_minor_digits_20260917(${t.currency}) is not null`),
  check("finance_payable_payment_date", sql`isfinite(${t.paidAt}) and ${t.paidAt}>='0001-01-01T00:00:00Z' and ${t.paidAt}<'10000-01-01T00:00:00Z' and date_trunc('milliseconds',${t.paidAt})=${t.paidAt}`),
  index("finance_payable_payment_recent").on(t.tenantId, t.recordedAt, t.id),
]);

export const financePaymentAllocationBatches = pgTable("finance_payment_allocation_batches", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  paymentId: uuid("payment_id").notNull(), input: jsonb("input").$type<AllocateFinancePaymentInput>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  creationTransactionId: text("creation_transaction_id").default(sql`txid_current()::text`).notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_payment_allocation_batch_scope").on(t.tenantId, t.id), uniqueIndex("finance_payment_allocation_batch_key").on(t.tenantId, t.idempotencyKey),
  foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [financePayablePayments.tenantId, financePayablePayments.id], name: "finance_payment_allocation_batch_payment_fk" }),
]);

export const financePaymentAllocations = pgTable("finance_payment_allocations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  batchId: uuid("batch_id").notNull(), paymentId: uuid("payment_id").notNull(), billId: uuid("bill_id").notNull(),
  supplierId: uuid("supplier_id").notNull(), currency: text("currency").notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_payment_allocation_scope").on(t.tenantId, t.id), uniqueIndex("finance_payment_allocation_batch_bill").on(t.tenantId, t.batchId, t.billId),
  foreignKey({ columns: [t.tenantId, t.batchId], foreignColumns: [financePaymentAllocationBatches.tenantId, financePaymentAllocationBatches.id], name: "finance_payment_allocation_batch_fk" }),
  foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [financePayablePayments.tenantId, financePayablePayments.id], name: "finance_payment_allocation_payment_fk" }),
  foreignKey({ columns: [t.tenantId, t.billId], foreignColumns: [financePayableBills.tenantId, financePayableBills.id], name: "finance_payment_allocation_bill_fk" }),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "finance_payment_allocation_supplier_fk" }),
  check("finance_payment_allocation_money", sql`${t.amountMinor} between 1 and 9007199254740991 and finance_minor_digits_20260917(${t.currency}) is not null`),
  index("finance_payment_allocation_payment").on(t.tenantId, t.paymentId), index("finance_payment_allocation_bill").on(t.tenantId, t.billId),
]);

export const financeAllocationReleases = pgTable("finance_allocation_releases", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "restrict" }),
  allocationId: uuid("allocation_id").notNull(), reasonCode: text("reason_code").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_allocation_release_scope").on(t.tenantId, t.id), uniqueIndex("finance_allocation_release_key").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("finance_allocation_release_once").on(t.tenantId, t.allocationId),
  foreignKey({ columns: [t.tenantId, t.allocationId], foreignColumns: [financePaymentAllocations.tenantId, financePaymentAllocations.id], name: "finance_allocation_release_allocation_fk" }),
  check("finance_allocation_release_reason", sql`${t.reasonCode} ~ '^[A-Z0-9][A-Z0-9._-]{0,99}$'`),
]);
