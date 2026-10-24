import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import type { FinancePayableBillView, FinancePayablePaymentView, FinancePayablesWorkspaceView } from "@yummyai/contracts/finance/payables";
import type { FinanceBillAdjustmentView, FinancePaymentAdjustmentView } from "@yummyai/contracts/finance/payables-adjustments";
import { ErpIdentityContext } from "../identity/erp-access";
import { PayablesWorkspace } from "./payables-workspace";
import { PayableBillAdjustmentForm, PayableAdjustmentsHistory, type PayableMutationFormProps } from "./payables-adjustments";

const supplierId = createEntityId(), tenantId = createEntityId(), userId = createEntityId(), at = "2026-07-03T00:00:00.000Z";
const rights = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
const bill = (overrides: Partial<FinancePayableBillView> = {}): FinancePayableBillView => ({ id: createEntityId(), supplierId,
  kind: "factory_invoice", externalBillId: "SYNTHETIC-ORIGINAL-BILL", currency: "USD", amountMinor: 100, creditMinor: 20, debitMinor: 5,
  voidedMinor: 0, netAmountMinor: 85, lifecycle: "active", issuedAt: at, dueAt: null, procurementInvoiceId: null, procurementProofId: null,
  sourceStatus: "current", allocatedMinor: 0, outstandingMinor: 85, status: "unallocated", recordedAt: at, ...overrides });
const payment = (overrides: Partial<FinancePayablePaymentView> = {}): FinancePayablePaymentView => ({ id: createEntityId(), supplierId,
  externalPaymentId: "SYNTHETIC-ORIGINAL-PAYMENT", currency: "USD", amountMinor: 100, refundedMinor: 20, voidedMinor: 0, netAmountMinor: 80,
  lifecycle: "active", paidAt: at, method: "bank_transfer", evidenceReference: "SYNTHETIC-PAYMENT-EVIDENCE", evidenceStatus: "operator_recorded",
  allocatedMinor: 0, unallocatedMinor: 80, status: "unallocated", recordedAt: at, ...overrides });
const data = (): FinancePayablesWorkspaceView => ({ suppliers: [{ id: supplierId, name: "Synthetic correction supplier", status: "active" }],
  bills: [], payments: [], allocations: [], releases: [], billAdjustments: [], paymentAdjustments: [], procurementAdjustments: [],
  procurementAdjustmentDiagnostics: [], permissions: { canWrite: true, canReview: true }, truncated: false });
const billEvent = (due: FinancePayableBillView, overrides: Partial<FinanceBillAdjustmentView> = {}): FinanceBillAdjustmentView => ({
  id: createEntityId(), billId: due.id, supplierId, currency: due.currency, kind: "credit", amountMinor: 20,
  externalDocumentId: "SYNTHETIC-ACTUAL-CREDIT", evidenceReference: "Synthetic supplier evidence reference", occurredAt: at,
  reasonCode: "SUPPLIER_CORRECTION", procurementAdjustmentId: null, procurementReviewId: null, recordedAt: at,
  balanceAfter: { amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80,
    allocatedMinor: 0, outstandingMinor: 80, lifecycle: "active" }, ...overrides });
const paymentEvent = (paid: FinancePayablePaymentView, overrides: Partial<FinancePaymentAdjustmentView> = {}): FinancePaymentAdjustmentView => ({
  id: createEntityId(), paymentId: paid.id, supplierId, currency: paid.currency, kind: "refund", amountMinor: 20,
  externalDocumentId: "SYNTHETIC-ACTUAL-REFUND", evidenceReference: "Synthetic actual refund evidence", occurredAt: at,
  reasonCode: "SUPPLIER_RETURNED", evidenceStatus: "operator_recorded", recordedAt: at,
  balanceAfter: { amountMinor: 100, refundedMinor: 20, voidedMinor: 0, netAmountMinor: 80, allocatedMinor: 0, unallocatedMinor: 80, lifecycle: "active" }, ...overrides });
function render(value: FinancePayablesWorkspaceView, permissions: string[] = rights) {
  const session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId, userId, permissions, dataScope: "tenant",
    displayName: "Synthetic correction operator", organizationName: "Synthetic correction organization" };
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}><PayablesWorkspace initialData={value} /></ErpIdentityContext.Provider>);
}
function StaticMutation<TInput, TResult>({ title, children, permitted, submitDisabled, submitLabel }: PayableMutationFormProps<TInput, TResult>) {
  return <form aria-label={title}>{children}<button disabled={!permitted || submitDisabled}>{submitLabel}</button></form>;
}
const formCallbacks = { onClose() {}, onSaved() {}, onDenied() {}, async onReload() {} };

describe("payable correction views retain original evidence, net balances and current authority", () => {
  it("shows current net separately from the original principal and the immutable earlier execution snapshot", () => {
    const value = data(), due = bill(), paid = payment(); value.bills = [due]; value.payments = [paid];
    value.billAdjustments = [billEvent(due)]; value.paymentAdjustments = [paymentEvent(paid)];
    const html = render(value); expect(html).toContain("原金额"); expect(html).toContain("USD 1.00"); expect(html).toContain("USD 0.85"); expect(html).toContain("USD 0.80");
    expect(html).toContain("该次执行时快照"); expect(html).toContain("不是当前余额"); expect(html).toContain("SYNTHETIC-ACTUAL-CREDIT");
    expect(html).toContain("SYNTHETIC-ACTUAL-REFUND"); expect(html).toContain("未经银行认证"); expect(html).not.toContain("退款成功");
  });
  it("retains all actual credit, debit and refund references while a truncated history never becomes a reconstructed current balance", () => {
    const value = data(), due = bill(), paid = payment(); value.bills = [due]; value.payments = [paid]; value.truncated = true;
    value.billAdjustments = [billEvent(due), billEvent(due, { kind: "debit", amountMinor: 5, externalDocumentId: "SYNTHETIC-DEBIT", balanceAfter: {
      amountMinor: 100, creditMinor: 20, debitMinor: 5, voidedMinor: 0, netAmountMinor: 85, allocatedMinor: 0, outstandingMinor: 85, lifecycle: "active" } })];
    value.paymentAdjustments = [paymentEvent(paid)];
    const html = render(value); expect(html).toContain("应付贷项"); expect(html).toContain("应付补差"); expect(html).toContain("已发生退款证据");
    expect(html).toContain("SYNTHETIC-DEBIT"); expect(html).toContain("不按截断历史推算余额"); expect(html).toContain("当前列表不完整");
    for (const event of [...value.billAdjustments, ...value.paymentAdjustments]) expect(html).toContain(event.id);
  });
  it("formats actual JPY, KWD and large correction snapshots with the pinned currency precision", () => {
    const value = data(), due = bill({ currency: "JPY" }), paid = payment({ currency: "KWD" });
    value.billAdjustments = [billEvent(due, { amountMinor: 1, balanceAfter: { amountMinor: 1234, creditMinor: 1, debitMinor: 0,
      voidedMinor: 0, netAmountMinor: 1233, allocatedMinor: 0, outstandingMinor: 1233, lifecycle: "active" } })];
    value.paymentAdjustments = [paymentEvent(paid, { amountMinor: 1, balanceAfter: { amountMinor: 1234, refundedMinor: 1,
      voidedMinor: 0, netAmountMinor: 1233, allocatedMinor: 0, unallocatedMinor: 1233, lifecycle: "active" } })];
    value.billAdjustments.push(billEvent(bill(), { amountMinor: 1, balanceAfter: { amountMinor: 9007199254740991, creditMinor: 1, debitMinor: 0,
      voidedMinor: 0, netAmountMinor: 9007199254740990, allocatedMinor: 0, outstandingMinor: 9007199254740990, lifecycle: "active" } }));
    const html = renderToStaticMarkup(<PayableAdjustmentsHistory data={value} />);
    expect(html).toContain("JPY 1233"); expect(html).toContain("KWD 1.233"); expect(html).toContain("USD 90071992547409.90");
    expect(html).toMatch(/<dt>执行后净额<\/dt><dd><span[^>]*>USD 90071992547409\.90<\/span>/);
  });
  it("distinguishes fully credited, refunded and voided records and disables new operations on terminal rows", () => {
    const value = data(); value.bills = [bill({ externalBillId: "CREDITED", creditMinor: 100, debitMinor: 0, netAmountMinor: 0, outstandingMinor: 0, lifecycle: "fully_credited" }),
      bill({ externalBillId: "VOIDED-BILL", creditMinor: 0, debitMinor: 0, voidedMinor: 100, netAmountMinor: 0, outstandingMinor: 0, lifecycle: "voided" })];
    value.payments = [payment({ externalPaymentId: "REFUNDED", refundedMinor: 100, netAmountMinor: 0, unallocatedMinor: 0, lifecycle: "fully_refunded" }),
      payment({ externalPaymentId: "VOIDED-PAYMENT", refundedMinor: 0, voidedMinor: 100, netAmountMinor: 0, unallocatedMinor: 0, lifecycle: "voided" })];
    const html = render(value); expect(html).toContain("已全额贷记"); expect(html).toContain("已全额登记退款"); expect(html).toContain("付款登记已作废");
    const voidedBill = html.match(/<tr[^>]*aria-label="应付账单 VOIDED-BILL"[\s\S]*?<\/tr>/)?.[0];
    const voidedPayment = html.match(/<tr[^>]*aria-label="付款证据 VOIDED-PAYMENT"[\s\S]*?<\/tr>/)?.[0];
    expect(voidedBill).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*更正应付记录/); expect(voidedPayment).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*更正付款记录/);
  });
  it("keeps adjustment histories readable after Review is removed while hiding all correction controls", () => {
    const value = data(), due = bill(), paid = payment(); value.bills = [due]; value.payments = [paid]; value.billAdjustments = [billEvent(due)];
    const html = render(value, [Permission.FinanceRead, Permission.FinanceWrite]);
    expect(html).toContain("SYNTHETIC-ACTUAL-CREDIT"); expect(html).not.toContain("更正应付记录"); expect(html).not.toContain("更正付款记录");
    expect(render({ ...value, permissions: { canWrite: true, canReview: false } })).not.toContain("更正应付记录");
  });
  it("clears private correction evidence with the old payable snapshot when FinanceRead is removed", () => {
    const value = data(), due = bill(), paid = payment(); value.bills = [due]; value.payments = [paid]; value.billAdjustments = [billEvent(due)]; value.paymentAdjustments = [paymentEvent(paid)];
    const html = render(value, [Permission.ProductRead]); expect(html).toContain("当前没有财务读取权限");
    for (const secret of [due.externalBillId, paid.externalPaymentId, "SYNTHETIC-ACTUAL-CREDIT", "SYNTHETIC-ACTUAL-REFUND", value.billAdjustments[0]!.id])
      expect(html).not.toContain(secret);
  });
  it("offers procurement synchronization only from actual unconsumed approved candidates and never free-form source money", () => {
    const value = data(), due = bill({ kind: "procurement_invoice", procurementInvoiceId: createEntityId(), procurementProofId: createEntityId(), sourceStatus: "source_adjusted" });
    const sourceId = createEntityId(), reviewId = createEntityId(); value.bills = [due]; value.procurementAdjustments = [{ billId: due.id,
      procurementAdjustmentId: sourceId, procurementReviewId: reviewId, kind: "credit", amountMinor: 20, externalDocumentId: "ACTUAL-APPROVED-CREDIT",
      evidenceReference: "Actual supplier correction reference", occurredAt: at, mappedEventId: null }];
    const html = renderToStaticMarkup(<PayableBillAdjustmentForm data={value} billId={due.id} MutationForm={StaticMutation} permitted {...formCallbacks} />);
    expect(html).toContain("已批准采购调整"); expect(html).toContain("ACTUAL-APPROVED-CREDIT"); expect(html).toContain(sourceId);
    expect(html).toContain('value="procurement_sync"'); expect(html).not.toContain('value="credit"'); expect(html).not.toContain('name="externalDocumentId"');
    expect(html).not.toContain("贷项金额（主货币单位）"); expect(html).toContain("不手工补造");
  });
  it("retains exact occupied opening balances and all genuine candidate kinds before the operator selects a source", () => {
    const value = data(), due = bill({ kind: "procurement_invoice", procurementInvoiceId: createEntityId(), procurementProofId: createEntityId(),
      creditMinor: 0, debitMinor: 0, netAmountMinor: 100, allocatedMinor: 80, outstandingMinor: 20, status: "partially_allocated", sourceStatus: "source_adjusted" });
    value.bills = [due]; value.procurementAdjustments = [
      { kind: "credit", amountMinor: 40, externalDocumentId: "APPROVED-CREDIT-OVER-FREE-BALANCE" },
      { kind: "credit", amountMinor: 0, externalDocumentId: "APPROVED-QUANTITY-ACK" },
      { kind: "debit", amountMinor: 40, externalDocumentId: "APPROVED-DEBIT" },
    ].map(candidate => ({ ...candidate, kind: candidate.kind as "credit" | "debit", billId: due.id, procurementAdjustmentId: createEntityId(),
      procurementReviewId: createEntityId(), evidenceReference: "Synthetic approved supplier document", occurredAt: at, mappedEventId: null }));
    const html = renderToStaticMarkup(<PayableBillAdjustmentForm data={value} billId={due.id} MutationForm={StaticMutation} permitted {...formCallbacks} />);
    expect(html).toMatch(/<dt>本次打开时净额<\/dt><dd><span[^>]*>USD 1\.00<\/span>/);
    expect(html).toMatch(/<dt>本次打开时已核销<\/dt><dd><span[^>]*>USD 0\.80<\/span>/);
    expect(html).toMatch(/<dt>本次打开时待核销<\/dt><dd><span[^>]*>USD 0\.20<\/span>/);
    for (const candidate of value.procurementAdjustments) {
      expect(html).toContain(candidate.externalDocumentId); expect(html).toContain(`<option value="${candidate.procurementAdjustmentId}">`);
    }
    expect(html).toContain("贷项 · USD 0.40"); expect(html).toContain("贷项 · USD 0.00"); expect(html).toContain("补差 · USD 0.40");
    // This SSR view has no selection. The real browser case selects each source
    // and proves credit blocking, debit/ack availability and zero submission.
    expect(html).toContain('<button disabled="">同步已批准采购调整</button>');
  });
  it("shows a quantity-only source acknowledgement and both real proof IDs without manufacturing a zero-value credit", () => {
    const value = data(), due = bill({ creditMinor: 0, debitMinor: 0, netAmountMinor: 100, outstandingMinor: 100 }), recordId = createEntityId(), reviewId = createEntityId();
    value.bills = [due]; value.billAdjustments = [billEvent(due, { kind: "source_acknowledgement", amountMinor: 0, reasonCode: "PROCUREMENT_APPROVED", procurementAdjustmentId: recordId,
      procurementReviewId: reviewId, balanceAfter: { amountMinor: 100, creditMinor: 0, debitMinor: 0, voidedMinor: 0,
        netAmountMinor: 100, allocatedMinor: 0, outstandingMinor: 100, lifecycle: "active" } })];
    const html = render(value); expect(html).toContain("采购来源确认 无金额变化"); expect(html).toContain(recordId); expect(html).toContain(reviewId);
    expect(html).not.toContain("应付贷项"); expect(html).toContain("实际批准凭据");
  });
  it("keeps unsupported source format explicit with actual IDs and does not silently turn it into a selectable source", () => {
    const value = data(), due = bill({ kind: "procurement_invoice", sourceStatus: "source_adjusted", procurementInvoiceId: createEntityId(), procurementProofId: createEntityId() });
    const sourceId = createEntityId(), reviewId = createEntityId(); value.bills = [due];
    value.procurementAdjustmentDiagnostics = [{ billId: due.id, procurementAdjustmentId: sourceId, procurementReviewId: reviewId, code: "source_format_not_supported" }];
    const html = render(value); expect(html).toContain("来源格式无法精确同步 请核对原采购凭据"); expect(html).toContain(sourceId); expect(html).toContain(reviewId);
    expect(html).toContain("未被清洗或替换");
    const form = renderToStaticMarkup(<PayableBillAdjustmentForm data={value} billId={due.id} MutationForm={StaticMutation} permitted {...formCallbacks} />);
    expect(form).toContain("没有可同步的批准记录"); expect(form).toContain('<button disabled="">同步已批准采购调整</button>');
    expect(form).not.toContain(`<option value="${sourceId}">`);
  });
});
