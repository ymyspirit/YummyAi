import { FinanceBillBalanceSchema, FinancePaymentBalanceSchema, FinanceBillAdjustmentViewSchema,
  FinancePaymentAdjustmentViewSchema } from "@yummyai/contracts/finance/payables-adjustments";
import { FinanceBillSourceStatusSchema } from "@yummyai/contracts/finance/payables";
import { financePayableBills, financePayablePayments, type financeBillAdjustments, type financePaymentAdjustments, type TenantTransaction } from "@yummyai/database";
import { inArray, sql } from "drizzle-orm";

export async function readBillStates(tx: TenantTransaction, tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, { balance: ReturnType<typeof FinanceBillBalanceSchema.parse>; sourceStatus: ReturnType<typeof FinanceBillSourceStatusSchema.parse> }>();
  const rows = await tx.select({ id: financePayableBills.id,
    balance: sql`finance_payables_bill_balance(${tenantId}::uuid,${financePayableBills.id})`,
    status: sql`finance_payable_bill_source_status(${tenantId}::uuid,${financePayableBills.id})` })
    .from(financePayableBills).where(inArray(financePayableBills.id, ids));
  return new Map(rows.map(row => [row.id, { balance: FinanceBillBalanceSchema.parse(row.balance), sourceStatus: FinanceBillSourceStatusSchema.parse(row.status) }]));
}
export async function readPaymentBalances(tx: TenantTransaction, tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, ReturnType<typeof FinancePaymentBalanceSchema.parse>>();
  const rows = await tx.select({ id: financePayablePayments.id, balance: sql`finance_payables_payment_balance(${tenantId}::uuid,${financePayablePayments.id})` })
    .from(financePayablePayments).where(inArray(financePayablePayments.id, ids));
  return new Map(rows.map(row => [row.id, FinancePaymentBalanceSchema.parse(row.balance)]));
}

export async function readBillBalance(tx: TenantTransaction, tenantId: string, billId: string) {
  const [row] = await tx.execute(sql`select finance_payables_bill_balance(${tenantId}::uuid,${billId}::uuid) as balance`);
  return FinanceBillBalanceSchema.parse(row?.balance);
}
export async function readPaymentBalance(tx: TenantTransaction, tenantId: string, paymentId: string) {
  const [row] = await tx.execute(sql`select finance_payables_payment_balance(${tenantId}::uuid,${paymentId}::uuid) as balance`);
  return FinancePaymentBalanceSchema.parse(row?.balance);
}
export async function readBillSourceStatus(tx: TenantTransaction, tenantId: string, billId: string) {
  const [row] = await tx.execute(sql`select finance_payable_bill_source_status(${tenantId}::uuid,${billId}::uuid) as status`);
  return FinanceBillSourceStatusSchema.parse(row?.status);
}
export function billAdjustmentView(row: typeof financeBillAdjustments.$inferSelect) {
  return FinanceBillAdjustmentViewSchema.parse({ id: row.id, billId: row.billId, supplierId: row.supplierId, currency: row.currency,
    kind: row.kind, amountMinor: row.amountMinor, externalDocumentId: row.externalDocumentId, evidenceReference: row.evidenceReference,
    occurredAt: row.occurredAt.toISOString(), reasonCode: row.reasonCode, procurementAdjustmentId: row.procurementAdjustmentId,
    procurementReviewId: row.procurementReviewId, balanceAfter: row.balanceAfter, recordedAt: row.recordedAt.toISOString() });
}
export function paymentAdjustmentView(row: typeof financePaymentAdjustments.$inferSelect) {
  return FinancePaymentAdjustmentViewSchema.parse({ id: row.id, paymentId: row.paymentId, supplierId: row.supplierId, currency: row.currency,
    kind: row.kind, amountMinor: row.amountMinor, externalDocumentId: row.externalDocumentId, evidenceReference: row.evidenceReference,
    occurredAt: row.occurredAt.toISOString(), reasonCode: row.reasonCode, evidenceStatus: "operator_recorded",
    balanceAfter: row.balanceAfter, recordedAt: row.recordedAt.toISOString() });
}
