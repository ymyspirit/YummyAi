import { financeCommandOwnerLock } from "./finance-command-lock.js";
import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { authorize, ForbiddenError, intersectPermissionContexts, Permission, permissionScope } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import type { PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import {
  canonicalFinancePayableAdjustmentRequest,
  FinanceBillAdjustmentViewSchema,
  RecordFinanceBillAdjustmentInputSchema,
  RecordFinancePaymentAdjustmentInputSchema,
} from "@yummyai/contracts/finance/payables-adjustments";
import { InvoiceReconciliationInputSchema } from "@yummyai/contracts/procurement/invoice-reconciliation";
import {
  financeBillAdjustments, financePayableBills, financePayablePayments, financePaymentAdjustments,
  inventoryPurchaseOrders, inventorySupplierInvoiceRequests, inventorySupplierInvoices, invoiceReconciliations,
  loadCurrentMembershipContext, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { billAdjustmentView, paymentAdjustmentView, readBillBalance, readBillSourceStatus, readPaymentBalance } from "./finance-payables-ledger.js";

type BillInput = z.infer<typeof RecordFinanceBillAdjustmentInputSchema>;
type PaymentInput = z.infer<typeof RecordFinancePaymentAdjustmentInputSchema>;
type BillRow = typeof financePayableBills.$inferSelect;
type PaymentRow = typeof financePayablePayments.$inferSelect;
type BillBalance = Awaited<ReturnType<typeof readBillBalance>>;
type PaymentBalance = Awaited<ReturnType<typeof readPaymentBalance>>;
type BillPlan = {
  kind: "credit" | "debit" | "source_acknowledgement" | "void";
  amountMinor: number;
  externalDocumentId: string | null;
  evidenceReference: string;
  occurredAt: Date;
  reasonCode: string;
  procurementAdjustmentId: string | null;
  procurementReviewId: string | null;
};

/** Append-only financial corrections. No transfer, refund instruction, stock
 * movement or duplicate FinanceFacts cost is performed by these endpoints. */
@Injectable()
export class FinancePayablesAdjustmentsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Prospective facts only. The actual writer reuses these plans after its
   * document, scope and source locks; inspection never reserves a correction. */
  async validateCommandInTransaction(tx: TenantTransaction, context: TenantContext, original: PrepareFinanceCommand): Promise<void> {
    const current = await currentAuthority(tx, context);
    if (original.kind === "bill_adjustment_record")
      await billAdjustmentPlan(tx, current, await billRoot(tx, original.targetId), original.input);
    else if (original.kind === "payment_adjustment_record")
      await paymentAdjustmentPlan(tx, current, await paymentRoot(tx, original.targetId), original.input);
    else throw new BadRequestException({ code: "finance_command_kind_invalid", message: "此财务提交不属于应付更正拥有者" });
  }

  async recordBillAdjustment(context: TenantContext, rawBillId: string, raw: unknown): Promise<ReturnType<typeof billAdjustmentView>> {
    return withTenant(this.database.db, context, tx => this.recordBillAdjustmentInTransaction(tx, context, rawBillId, raw));
  }

  async recordBillAdjustmentInTransaction(tx: TenantTransaction, context: TenantContext, rawBillId: string, raw: unknown): Promise<ReturnType<typeof billAdjustmentView>> {
    const billId = parse(EntityIdSchema, rawBillId).toLowerCase();
    const input = parse(RecordFinanceBillAdjustmentInputSchema, raw);
    const checksum = requestChecksum("bill-adjustment", billId, input);
      const current = await currentAuthority(tx, context);
      await financeCommandOwnerLock(tx, current, "bill_adjustment_record", input.idempotencyKey);
      await requestLock(tx, current, "bill-adjustment", input.idempotencyKey);
      const [existing] = await tx.select().from(financeBillAdjustments)
        .where(eq(financeBillAdjustments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        if (existing.billId !== billId) requestMismatch();
        return billAdjustmentView(existing);
      }
      const bill = await billRoot(tx, billId);
      const plan = await billDocumentPlan(tx, bill, input);
      await billDocumentLock(tx, current, bill, plan);
      await scopeLock(tx, current, bill.supplierId, bill.currency);
      if (bill.procurementInvoiceId !== null) {
        const [invoice] = await tx.select({ purchaseOrderId: inventorySupplierInvoices.purchaseOrderId }).from(inventorySupplierInvoices)
          .where(eq(inventorySupplierInvoices.id, bill.procurementInvoiceId)).limit(1);
        if (!invoice) sourceUnavailable();
        await lock(tx, `procurement-order:${current.tenantId}:${invoice.purchaseOrderId}`);
      }
      const { fixedPlan, amountMinor, balanceAfter } = await billAdjustmentPlan(tx, current, bill, input);
      const [row] = await tx.insert(financeBillAdjustments).values({
        id: createEntityId(), tenantId: current.tenantId, billId: bill.id, supplierId: bill.supplierId, currency: bill.currency,
        ...fixedPlan, amountMinor, input, requestChecksum: checksum, idempotencyKey: input.idempotencyKey,
        balanceAfter, recordedBy: current.userId,
      }).returning();
      if (!row) inconsistent();
      const view = billAdjustmentView(row);
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.payables.bill_adjustment_recorded", resourceType: "finance_bill_adjustment", resourceId: row.id, result: "success",
        metadata: { kind: row.kind, billId: bill.id, supplierId: bill.supplierId, currency: bill.currency, amountMinor: row.amountMinor,
          procurementAdjustmentId: row.procurementAdjustmentId, procurementReviewId: row.procurementReviewId },
      });
      return view;
  }

  async recordPaymentAdjustment(context: TenantContext, rawPaymentId: string, raw: unknown): Promise<ReturnType<typeof paymentAdjustmentView>> {
    return withTenant(this.database.db, context, tx => this.recordPaymentAdjustmentInTransaction(tx, context, rawPaymentId, raw));
  }

  async recordPaymentAdjustmentInTransaction(tx: TenantTransaction, context: TenantContext, rawPaymentId: string, raw: unknown): Promise<ReturnType<typeof paymentAdjustmentView>> {
    const paymentId = parse(EntityIdSchema, rawPaymentId).toLowerCase();
    const input = parse(RecordFinancePaymentAdjustmentInputSchema, raw);
    const checksum = requestChecksum("payment-adjustment", paymentId, input);
      const current = await currentAuthority(tx, context);
      await financeCommandOwnerLock(tx, current, "payment_adjustment_record", input.idempotencyKey);
      await requestLock(tx, current, "payment-adjustment", input.idempotencyKey);
      const [existing] = await tx.select().from(financePaymentAdjustments)
        .where(eq(financePaymentAdjustments.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) {
        assertReplay(existing, current, checksum);
        if (existing.paymentId !== paymentId) requestMismatch();
        return paymentAdjustmentView(existing);
      }
      const payment = await paymentRoot(tx, paymentId);
      if (input.kind === "refund")
        await lock(tx, `finance-payables-refund-document:${current.tenantId}:${payment.supplierId}:${input.externalDocumentId}`);
      await scopeLock(tx, current, payment.supplierId, payment.currency);
      const { amountMinor, balanceAfter } = await paymentAdjustmentPlan(tx, current, payment, input);
      const [row] = await tx.insert(financePaymentAdjustments).values({
        id: createEntityId(), tenantId: current.tenantId, paymentId: payment.id, supplierId: payment.supplierId, currency: payment.currency,
        kind: input.kind, amountMinor, externalDocumentId: input.kind === "refund" ? input.externalDocumentId : null,
        evidenceReference: input.evidenceReference, occurredAt: new Date(input.occurredAt), reasonCode: input.reasonCode,
        input, requestChecksum: checksum, idempotencyKey: input.idempotencyKey, balanceAfter, recordedBy: current.userId,
      }).returning();
      if (!row) inconsistent();
      const view = paymentAdjustmentView(row);
      await this.audit.recordInTransaction(tx, current, {
        action: "finance.payables.payment_adjustment_recorded", resourceType: "finance_payment_adjustment", resourceId: row.id, result: "success",
        metadata: { kind: row.kind, paymentId: payment.id, supplierId: payment.supplierId, currency: payment.currency, amountMinor: row.amountMinor },
      });
      return view;
  }
}

async function billRoot(tx: TenantTransaction, billId: string): Promise<BillRow> {
  const [bill] = await tx.select().from(financePayableBills).where(eq(financePayableBills.id, billId)).limit(1);
  if (!bill) throw new NotFoundException("原应付账单不存在");
  return bill;
}

async function paymentRoot(tx: TenantTransaction, paymentId: string): Promise<PaymentRow> {
  const [payment] = await tx.select().from(financePayablePayments).where(eq(financePayablePayments.id, paymentId)).limit(1);
  if (!payment) throw new NotFoundException("原付款记录不存在");
  return payment;
}

function billDocumentPlan(tx: TenantTransaction, bill: BillRow, input: BillInput): Promise<BillPlan> {
  return input.kind === "procurement_sync" ? procurementPlan(tx, bill, input) : Promise.resolve(manualBillPlan(bill, input));
}

async function billAdjustmentPlan(tx: TenantTransaction, current: TenantContext, bill: BillRow, input: BillInput) {
  const fixedPlan = await billDocumentPlan(tx, bill, input);
  await requireUnusedBillSource(tx, bill, fixedPlan);
  const before = await readBillBalance(tx, current.tenantId, bill.id);
  assertExpectedNet(before.netAmountMinor, input.expectedNetAmountMinor);
  if (before.lifecycle === "voided") closed();
  if (input.kind === "void" && bill.procurementInvoiceId !== null) {
    const sourceStatus = await readBillSourceStatus(tx, current.tenantId, bill.id);
    if (before.netAmountMinor !== 0 || before.allocatedMinor !== 0 || sourceStatus !== "current")
      conflict("finance_payables_procurement_void_unavailable", "采购应付须先完成核准更正同步与核对 且净额和有效核销均为零 才能撤销登记");
  }
  const amountMinor = fixedPlan.kind === "void" ? before.netAmountMinor : fixedPlan.amountMinor;
  return { fixedPlan, amountMinor, balanceAfter: projectBillBalance(before, fixedPlan.kind, amountMinor) };
}

async function paymentAdjustmentPlan(tx: TenantTransaction, current: TenantContext, payment: PaymentRow, input: PaymentInput) {
  if (input.kind === "refund" && Date.parse(input.occurredAt) < payment.paidAt.getTime())
    conflict("finance_payables_adjustment_date_invalid", "实际退款发生时间不能早于原付款时间 请核对真实凭据");
  if (input.kind === "refund") {
    const [duplicate] = await tx.select({ id: financePaymentAdjustments.id }).from(financePaymentAdjustments).where(and(
      eq(financePaymentAdjustments.supplierId, payment.supplierId),
      eq(financePaymentAdjustments.externalDocumentId, input.externalDocumentId),
    )).limit(1);
    if (duplicate) documentDuplicate();
  }
  const before = await readPaymentBalance(tx, current.tenantId, payment.id);
  assertExpectedNet(before.netAmountMinor, input.expectedNetAmountMinor);
  if (before.lifecycle === "voided") closed();
  if (input.kind === "void" && before.refundedMinor !== 0)
    conflict("finance_payables_payment_refunded", "该付款已有实际退款凭据 不可再按错误登记全额撤销");
  const amountMinor = input.kind === "void" ? before.netAmountMinor : input.amountMinor;
  return { amountMinor, balanceAfter: projectPaymentBalance(before, input.kind, amountMinor) };
}

async function currentAuthority(tx: TenantTransaction, base: TenantContext) {
  const current = intersectPermissionContexts(base, await loadCurrentMembershipContext(tx, base, { lock: true }));
  authorize(current, Permission.FinanceReview);
  if (permissionScope(current, Permission.FinanceReview) !== "tenant") throw new ForbiddenError(Permission.FinanceReview, "outside_data_scope");
  return current;
}

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException({ code: "finance_payables_input_invalid", message: "应付更正或付款退款填写格式不正确" });
  return parsed.data;
}

function requestChecksum(operation: "bill-adjustment" | "payment-adjustment", targetId: string, input: BillInput | PaymentInput) {
  return createHash("sha256").update(canonicalFinancePayableAdjustmentRequest(operation, targetId, input)).digest("hex");
}

function assertReplay(row: { recordedBy: string; requestChecksum: string }, current: TenantContext, checksum: string) {
  if (row.recordedBy !== current.userId || row.requestChecksum !== checksum) requestMismatch();
}

function assertExpectedNet(actual: number, expected: number) {
  if (actual !== expected) conflict("finance_payables_balance_changed", "台账净额已变化 请刷新后按当前真实余额重新核对");
}

function manualBillPlan(bill: BillRow, input: BillInput): BillPlan {
  if (input.kind === "procurement_sync") sourceUnavailable();
  if (bill.procurementInvoiceId !== null && input.kind !== "void")
    conflict("finance_payables_procurement_adjustment_required", "采购应付只能同步原采购发票已核准的供应商调整 不可手填贷项或补差");
  return { kind: input.kind, amountMinor: input.kind === "void" ? 0 : input.amountMinor,
    externalDocumentId: input.kind === "void" ? null : input.externalDocumentId,
    evidenceReference: input.evidenceReference, occurredAt: new Date(input.occurredAt), reasonCode: input.reasonCode,
    procurementAdjustmentId: null, procurementReviewId: null };
}

async function procurementPlan(tx: TenantTransaction, bill: BillRow, input: Extract<BillInput, { kind: "procurement_sync" }>): Promise<BillPlan> {
  if (bill.kind !== "procurement_invoice" || bill.procurementInvoiceId === null || bill.procurementProofId === null) sourceUnavailable();
  const [invoice] = await tx.select().from(inventorySupplierInvoices).where(eq(inventorySupplierInvoices.id, bill.procurementInvoiceId)).limit(1);
  const [proof] = await tx.select().from(inventorySupplierInvoiceRequests).where(eq(inventorySupplierInvoiceRequests.id, bill.procurementProofId)).limit(1);
  const [order] = invoice ? await tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, invoice.purchaseOrderId)).limit(1) : [];
  const [record] = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.id, input.procurementAdjustmentId)).limit(1);
  const [review] = await tx.select().from(invoiceReconciliations).where(eq(invoiceReconciliations.id, input.procurementReviewId)).limit(1);
  if (!invoice || !proof || !order || !record || !review || !invoice.creationTransactionId || invoice.allocationStatus === null
    || invoice.allocationStatus === "legacy_unknown" || proof.evidenceVersion !== 1 || proof.invoiceId !== invoice.id
    || proof.purchaseOrderId !== order.id || proof.idempotencyKey !== invoice.idempotencyKey || proof.createdBy !== invoice.createdBy
    || order.supplierId !== bill.supplierId || invoice.currency !== bill.currency || invoice.totalMinor !== bill.amountMinor
    || invoice.invoiceNumber !== bill.externalBillId || invoice.issuedAt.getTime() !== bill.issuedAt.getTime()
    || record.action !== "adjustment_record" || review.action !== "adjustment_review" || review.adjustmentId !== record.id
    || record.invoiceId !== invoice.id || review.invoiceId !== invoice.id || record.originalProofId !== proof.id || review.originalProofId !== proof.id
    || record.purchaseOrderId !== order.id || review.purchaseOrderId !== order.id
    || record.purchaseOrderVersionId !== proof.purchaseOrderVersionId || review.purchaseOrderVersionId !== proof.purchaseOrderVersionId
    || record.supplierId !== bill.supplierId || review.supplierId !== bill.supplierId) sourceUnavailable();
  const document = InvoiceReconciliationInputSchema.safeParse(record.input);
  const decision = InvoiceReconciliationInputSchema.safeParse(review.input);
  if (!document.success || document.data.action !== "adjustment_record" || !decision.success || decision.data.action !== "adjustment_review"
    || decision.data.decision !== "approved" || decision.data.adjustmentId !== record.id || document.data.document.currency !== bill.currency)
    sourceUnavailable();
  const originalDocument = record.input.action === "adjustment_record" ? record.input.document : null;
  if (!originalDocument || originalDocument.number !== document.data.document.number
    || originalDocument.evidenceReference !== document.data.document.evidenceReference
    || originalDocument.issuedAt !== document.data.document.issuedAt) sourceUnavailable();
  const amountMinor = safeMinor(document.data.lines.reduce((sum, line) => sum + minor(line.amountMinor), 0n));
  // A historical source may carry microseconds or reference characters that
  // this ledger cannot preserve. Reject it instead of silently changing it.
  const sourceFields = FinanceBillAdjustmentViewSchema.shape;
  const sourceDate = sourceFields.occurredAt.safeParse(document.data.document.issuedAt);
  const sourceNumber = sourceFields.externalDocumentId.safeParse(document.data.document.number);
  const sourceEvidence = sourceFields.evidenceReference.safeParse(document.data.document.evidenceReference);
  if (!sourceDate.success || !sourceNumber.success || !sourceEvidence.success
    || sourceNumber.data !== document.data.document.number || sourceEvidence.data !== document.data.document.evidenceReference)
    sourceUnavailable();
  return { kind: amountMinor === 0 ? "source_acknowledgement" : document.data.document.kind === "credit_note" ? "credit" : "debit",
    amountMinor, externalDocumentId: document.data.document.number, evidenceReference: document.data.document.evidenceReference,
    occurredAt: new Date(document.data.document.issuedAt), reasonCode: "PROCUREMENT_APPROVED",
    procurementAdjustmentId: record.id, procurementReviewId: review.id };
}

async function billDocumentLock(tx: TenantTransaction, current: TenantContext, bill: BillRow, plan: BillPlan) {
  if (plan.procurementAdjustmentId !== null)
    await lock(tx, `finance-payables-procurement-adjustment:${current.tenantId}:${plan.procurementAdjustmentId}`);
  if (plan.externalDocumentId !== null)
    await lock(tx, `finance-payables-adjustment-document:${current.tenantId}:${bill.supplierId}:${plan.kind}:${plan.externalDocumentId}`);
}

async function requireUnusedBillSource(tx: TenantTransaction, bill: BillRow, plan: BillPlan) {
  if (plan.procurementAdjustmentId !== null) {
    const [duplicate] = await tx.select({ id: financeBillAdjustments.id }).from(financeBillAdjustments)
      .where(eq(financeBillAdjustments.procurementAdjustmentId, plan.procurementAdjustmentId)).limit(1);
    if (duplicate) conflict("finance_payables_procurement_adjustment_already_synced", "该采购核准调整已同步 不可换账单或请求键重复入账");
  }
  if (plan.externalDocumentId !== null) {
    const [duplicate] = await tx.select({ id: financeBillAdjustments.id }).from(financeBillAdjustments).where(and(
      eq(financeBillAdjustments.supplierId, bill.supplierId), eq(financeBillAdjustments.kind, plan.kind),
      eq(financeBillAdjustments.externalDocumentId, plan.externalDocumentId),
    )).limit(1);
    if (duplicate) documentDuplicate();
  }
}

function projectBillBalance(before: BillBalance, kind: BillPlan["kind"], amount: number): BillBalance {
  const credits = minor(before.creditMinor) + (kind === "credit" ? minor(amount) : 0n);
  const debits = minor(before.debitMinor) + (kind === "debit" ? minor(amount) : 0n);
  const voided = minor(before.voidedMinor) + (kind === "void" ? minor(amount) : 0n);
  const net = minor(before.amountMinor) + debits - credits - voided;
  if (net < 0n) conflict("finance_payables_adjustment_exceeded", "贷项金额超过应付净额 请核对真实供应商凭据");
  if (net < minor(before.allocatedMinor)) needsRelease();
  return { amountMinor: before.amountMinor, creditMinor: safeMinor(credits), debitMinor: safeMinor(debits), voidedMinor: safeMinor(voided),
    netAmountMinor: safeMinor(net), allocatedMinor: before.allocatedMinor, outstandingMinor: safeMinor(net - minor(before.allocatedMinor)),
    lifecycle: kind === "void" ? "voided" : net === 0n ? "fully_credited" : "active" };
}

function projectPaymentBalance(before: PaymentBalance, kind: PaymentInput["kind"], amount: number): PaymentBalance {
  const refunded = minor(before.refundedMinor) + (kind === "refund" ? minor(amount) : 0n);
  const voided = minor(before.voidedMinor) + (kind === "void" ? minor(amount) : 0n);
  const net = minor(before.amountMinor) - refunded - voided;
  if (net < 0n) conflict("finance_payables_refund_exceeded", "累计实际退款超过原付款尚未退回金额");
  if (net < minor(before.allocatedMinor)) needsRelease();
  return { amountMinor: before.amountMinor, refundedMinor: safeMinor(refunded), voidedMinor: safeMinor(voided), netAmountMinor: safeMinor(net),
    allocatedMinor: before.allocatedMinor, unallocatedMinor: safeMinor(net - minor(before.allocatedMinor)),
    lifecycle: kind === "void" ? "voided" : net === 0n ? "fully_refunded" : "active" };
}

function minor(amount: number) {
  if (!Number.isSafeInteger(amount) || amount < 0) moneyOverflow();
  return BigInt(amount);
}

function safeMinor(amount: bigint) {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) moneyOverflow();
  return Number(amount);
}

function moneyOverflow(): never { throw new UnprocessableEntityException({ code: "finance_money_overflow", message: "金额超出可精确记录的范围" }); }
function sourceUnavailable(): never { conflict("finance_payables_procurement_source_invalid", "原采购发票或已核准调整依据不完整 不可自动同步应付更正"); }
function documentDuplicate(): never { conflict("finance_payables_adjustment_document_duplicate", "该供应商的更正或退款凭据已有记录 不可换日期或账单重复登记"); }
function needsRelease(): never { conflict("finance_payables_adjustment_requires_release", "更正后的金额低于有效核销 请先撤销相关核销 再按净额重新核销"); }
function closed(): never { conflict("finance_payables_adjustment_voided", "原登记已撤销 不可再追加更正或核销"); }
function inconsistent(): never { conflict("finance_payables_ledger_inconsistent", "更正账本依据不完整 请核对原始凭据"); }
function requestMismatch(): never { conflict("finance_payables_request_mismatch", "该请求键已绑定原目标 填写和操作者 请核对原始提交"); }
function conflict(code: string, message: string): never { throw new ConflictException({ code, message }); }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`); }
function requestLock(tx: TenantTransaction, current: TenantContext, operation: "bill-adjustment" | "payment-adjustment", key: string) {
  return lock(tx, `finance-payables-request:${current.tenantId}:${operation}:${key}`);
}
function scopeLock(tx: TenantTransaction, current: TenantContext, supplierId: string, currency: string) {
  return lock(tx, `finance-payables-scope:${current.tenantId}:${supplierId}:${currency}`);
}
