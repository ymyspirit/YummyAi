import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FinanceBillAdjustmentView, FinancePaymentAdjustmentView, FinanceBillBalance, FinancePaymentBalance,
  RecordFinanceBillAdjustmentInput, RecordFinancePaymentAdjustmentInput } from "@yummyai/contracts/finance/payables-adjustments";
import { organizations, users } from "./identity.js";
import { fulfillmentSuppliers } from "./order-routing.js";
import { financePayableBills, financePayablePayments } from "./finance-payables.js";
import { invoiceReconciliations } from "./invoice-reconciliation.js";

/** Append-only corrections. An original principal and every original allocation stay immutable. */
export const financeBillAdjustments = pgTable("finance_bill_adjustments", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  billId: uuid("bill_id").notNull(), supplierId: uuid("supplier_id").notNull(), currency: text("currency").notNull(),
  kind: text("kind").$type<FinanceBillAdjustmentView["kind"]>().notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  externalDocumentId: text("external_document_id"), evidenceReference: text("evidence_reference").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(), reasonCode: text("reason_code").notNull(),
  procurementAdjustmentId: uuid("procurement_adjustment_id"), procurementReviewId: uuid("procurement_review_id"),
  input: jsonb("input").$type<RecordFinanceBillAdjustmentInput>().notNull(),
  balanceAfter: jsonb("balance_after").$type<FinanceBillBalance>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_bill_adjustment_scope").on(t.tenantId, t.id),
  uniqueIndex("finance_bill_adjustment_key").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("finance_bill_adjustment_document").on(t.tenantId, t.supplierId, t.kind, t.externalDocumentId).where(sql`${t.externalDocumentId} is not null`),
  uniqueIndex("finance_bill_adjustment_source_once").on(t.tenantId, t.procurementAdjustmentId).where(sql`${t.procurementAdjustmentId} is not null`),
  uniqueIndex("finance_bill_adjustment_void_once").on(t.tenantId, t.billId).where(sql`${t.kind}='void'`),
  index("finance_bill_adjustment_bill").on(t.tenantId, t.billId),
  foreignKey({ columns: [t.tenantId, t.billId], foreignColumns: [financePayableBills.tenantId, financePayableBills.id], name: "finance_bill_adjustment_bill_fk" }),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "finance_bill_adjustment_supplier_fk" }),
  foreignKey({ columns: [t.tenantId, t.procurementAdjustmentId], foreignColumns: [invoiceReconciliations.tenantId, invoiceReconciliations.id], name: "finance_bill_adjustment_source_fk" }),
  foreignKey({ columns: [t.tenantId, t.procurementReviewId], foreignColumns: [invoiceReconciliations.tenantId, invoiceReconciliations.id], name: "finance_bill_adjustment_review_fk" }),
  check("finance_bill_adjustment_kind", sql`${t.kind} in ('credit','debit','source_acknowledgement','void')`),
  check("finance_bill_adjustment_money", sql`${t.amountMinor} between 0 and 9007199254740991 and finance_minor_digits_20260917(${t.currency}) is not null`),
]);

/** Recorded supplier refunds or correction of an erroneous payment record, never a banking command. */
export const financePaymentAdjustments = pgTable("finance_payment_adjustments", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  paymentId: uuid("payment_id").notNull(), supplierId: uuid("supplier_id").notNull(), currency: text("currency").notNull(),
  kind: text("kind").$type<FinancePaymentAdjustmentView["kind"]>().notNull(), amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  externalDocumentId: text("external_document_id"), evidenceReference: text("evidence_reference").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(), reasonCode: text("reason_code").notNull(),
  input: jsonb("input").$type<RecordFinancePaymentAdjustmentInput>().notNull(),
  balanceAfter: jsonb("balance_after").$type<FinancePaymentBalance>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  uniqueIndex("finance_payment_adjustment_scope").on(t.tenantId, t.id),
  uniqueIndex("finance_payment_adjustment_key").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("finance_payment_adjustment_document").on(t.tenantId, t.supplierId, t.externalDocumentId).where(sql`${t.externalDocumentId} is not null`),
  uniqueIndex("finance_payment_adjustment_void_once").on(t.tenantId, t.paymentId).where(sql`${t.kind}='void'`),
  index("finance_payment_adjustment_payment").on(t.tenantId, t.paymentId),
  foreignKey({ columns: [t.tenantId, t.paymentId], foreignColumns: [financePayablePayments.tenantId, financePayablePayments.id], name: "finance_payment_adjustment_payment_fk" }),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "finance_payment_adjustment_supplier_fk" }),
  check("finance_payment_adjustment_kind", sql`${t.kind} in ('refund','void')`),
  check("finance_payment_adjustment_money", sql`${t.amountMinor} between 1 and 9007199254740991 and finance_minor_digits_20260917(${t.currency}) is not null`),
]);
