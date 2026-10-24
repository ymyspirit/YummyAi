import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { FinancePayableBillViewSchema, FinancePayablePaymentViewSchema, FinancePayablesWorkspaceViewSchema } from "./payables.js";
import { canonicalFinancePayableAdjustmentRequest, FinanceBillAdjustmentViewSchema, FinanceBillBalanceSchema,
  FinancePaymentAdjustmentViewSchema, FinancePaymentBalanceSchema, RecordFinanceBillAdjustmentInputSchema,
  RecordFinancePaymentAdjustmentInputSchema } from "./payables-adjustments.js";

const billId = createEntityId(), paymentId = createEntityId(), supplierId = createEntityId();
const at = "2026-07-02T00:00:00.000Z";
const evidence = { externalDocumentId: "SYNTHETIC-CREDIT/001", evidenceReference: "Synthetic supplier credit reference",
  occurredAt: at, reasonCode: "SUPPLIER_CORRECTION", expectedNetAmountMinor: 100, idempotencyKey: "synthetic-adjustment-original" };
const credit = () => ({ ...evidence, kind: "credit", amountMinor: 20 });
const refund = () => ({ ...evidence, kind: "refund", amountMinor: 20 });
const billBalance = () => ({ amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80,
  allocatedMinor: 50, outstandingMinor: 30, lifecycle: "active" });
const paymentBalance = () => ({ amountMinor: 100, refundedMinor: 20, voidedMinor: 0, netAmountMinor: 80,
  allocatedMinor: 50, unallocatedMinor: 30, lifecycle: "active" });
const billEvent = () => ({ id: createEntityId(), billId, supplierId, currency: "USD", kind: "credit", amountMinor: 20,
  externalDocumentId: evidence.externalDocumentId, evidenceReference: evidence.evidenceReference, occurredAt: at,
  reasonCode: evidence.reasonCode, procurementAdjustmentId: null, procurementReviewId: null,
  balanceAfter: billBalance(), recordedAt: at });
const paymentEvent = () => ({ id: createEntityId(), paymentId, supplierId, currency: "USD", kind: "refund", amountMinor: 20,
  externalDocumentId: evidence.externalDocumentId, evidenceReference: evidence.evidenceReference, occurredAt: at,
  reasonCode: evidence.reasonCode, evidenceStatus: "operator_recorded", balanceAfter: paymentBalance(), recordedAt: at });

describe("supplier corrections and actual payment refunds keep original money and evidence", () => {
  it("separates bill credit/debit, approved procurement synchronization and void requests", () => {
    expect(RecordFinanceBillAdjustmentInputSchema.parse(credit()).kind).toBe("credit");
    expect(RecordFinanceBillAdjustmentInputSchema.parse({ ...credit(), kind: "debit" }).kind).toBe("debit");
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ kind: "procurement_sync", procurementAdjustmentId: createEntityId(),
      procurementReviewId: createEntityId(), expectedNetAmountMinor: 0, idempotencyKey: evidence.idempotencyKey }).success).toBe(true);
    const { externalDocumentId: omitted, ...voidInput } = evidence; void omitted;
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...voidInput, kind: "void" }).success).toBe(true);
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...voidInput, kind: "void", amountMinor: 100 }).success).toBe(false);
  });
  it("does not let caller-supplied money or references override an actual procurement review", () => {
    const source = { kind: "procurement_sync", procurementAdjustmentId: createEntityId(), procurementReviewId: createEntityId(),
      expectedNetAmountMinor: 100, idempotencyKey: evidence.idempotencyKey };
    for (const extra of [{ amountMinor: 1 }, { currency: "USD" }, { externalDocumentId: "FAKE" }, { evidenceReference: "FAKE" },
      { recordedBy: createEntityId() }, { tenantId: createEntityId() }])
      expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...source, ...extra }).success).toBe(false);
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...source, procurementReviewId: null }).success).toBe(false);
  });
  it("requires a real refund document while keeping void separate from a refund", () => {
    expect(RecordFinancePaymentAdjustmentInputSchema.parse(refund()).kind).toBe("refund");
    const { externalDocumentId: omitted, ...voidInput } = evidence; void omitted;
    expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...voidInput, kind: "void" }).success).toBe(true);
    expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...refund(), kind: "void" }).success).toBe(false);
    expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...refund(), externalDocumentId: "" }).success).toBe(false);
  });
  it.each([0, -1, 0.5, "20", Number.MAX_SAFE_INTEGER + 1])("rejects nonpositive, fractional or unsafe money %s", amountMinor => {
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...credit(), amountMinor }).success).toBe(false);
    expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...refund(), amountMinor }).success).toBe(false);
  });
  it("requires an exact nonnegative expected net including zero and rejects caller authority", () => {
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...credit(), expectedNetAmountMinor: 0 }).success).toBe(true);
    for (const expectedNetAmountMinor of [-1, 0.5, "100", Number.MAX_SAFE_INTEGER + 1])
      expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...credit(), expectedNetAmountMinor }).success).toBe(false);
    for (const extra of [{ tenantId: createEntityId() }, { createdBy: createEntityId() }, { approved: true }, { bankAccount: "SYNTHETIC" }]) {
      expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...credit(), ...extra }).success).toBe(false);
      expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...refund(), ...extra }).success).toBe(false);
    }
  });
  it("normalizes UUIDs and exact millisecond date aliases without losing meaningful evidence text", () => {
    const id = "019f0000-abcd-7000-8000-000000000001", source = { kind: "procurement_sync", procurementAdjustmentId: id.toUpperCase(),
      procurementReviewId: id, expectedNetAmountMinor: 100, idempotencyKey: evidence.idempotencyKey };
    expect(RecordFinanceBillAdjustmentInputSchema.parse(source)).toMatchObject({ procurementAdjustmentId: id });
    const original = canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, credit());
    expect(canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, { ...credit(), occurredAt: "2026-07-02T00:00:00Z" })).toBe(original);
    expect(canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, { ...credit(), externalDocumentId: "synthetic-credit/001" })).not.toBe(original);
  });
  it.each(["2026-07-02T00:00:00.0001Z", "0000-07-02T00:00:00Z"])("rejects untransportable original business date %s", occurredAt => {
    expect(RecordFinanceBillAdjustmentInputSchema.safeParse({ ...credit(), occurredAt }).success).toBe(false);
    expect(RecordFinancePaymentAdjustmentInputSchema.safeParse({ ...refund(), occurredAt }).success).toBe(false);
  });
  it("binds canonical request identity to operation, actual target, expected balance and original body", () => {
    const original = canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, credit());
    expect(canonicalFinancePayableAdjustmentRequest("bill-adjustment", createEntityId(), credit())).not.toBe(original);
    expect(canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, { ...credit(), expectedNetAmountMinor: 99 })).not.toBe(original);
    expect(canonicalFinancePayableAdjustmentRequest("bill-adjustment", billId, { ...credit(), amountMinor: 21 })).not.toBe(original);
    expect(canonicalFinancePayableAdjustmentRequest("payment-adjustment", billId, refund())).not.toBe(original);
  });
  it("keeps the original bill immutable and reconciles net principal with active allocations", () => {
    expect(FinanceBillBalanceSchema.safeParse(billBalance()).success).toBe(true);
    for (const changed of [{ netAmountMinor: 100 }, { outstandingMinor: 50 }, { creditMinor: 21 }, { lifecycle: "fully_credited" }])
      expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), ...changed }).success).toBe(false);
    expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), amountMinor: Number.MAX_SAFE_INTEGER, creditMinor: 1,
      netAmountMinor: Number.MAX_SAFE_INTEGER - 1, allocatedMinor: 0, outstandingMinor: Number.MAX_SAFE_INTEGER - 1 }).success).toBe(true);
    expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), amountMinor: Number.MAX_SAFE_INTEGER, creditMinor: 0,
      debitMinor: 1, netAmountMinor: Number.MAX_SAFE_INTEGER, allocatedMinor: 0, outstandingMinor: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
  it("makes refunds reduce actual payment principal while an allocation release leaves it unchanged", () => {
    expect(FinancePaymentBalanceSchema.safeParse(paymentBalance()).success).toBe(true);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), allocatedMinor: 0, unallocatedMinor: 80 }).success).toBe(true);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), allocatedMinor: 0, unallocatedMinor: 100 }).success).toBe(false);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), refundedMinor: 0 }).success).toBe(false);
  });
  it("requires fully credited and fully refunded lifecycles to have zero net and zero occupied capacity", () => {
    expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), creditMinor: 100, netAmountMinor: 0, allocatedMinor: 0, outstandingMinor: 0, lifecycle: "fully_credited" }).success).toBe(true);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), refundedMinor: 100, netAmountMinor: 0, allocatedMinor: 0, unallocatedMinor: 0, lifecycle: "fully_refunded" }).success).toBe(true);
    expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), lifecycle: "fully_credited" }).success).toBe(false);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), lifecycle: "fully_refunded" }).success).toBe(false);
  });
  it("distinguishes bill void after credit from payment void, which cannot conceal an actual refund", () => {
    expect(FinanceBillBalanceSchema.safeParse({ ...billBalance(), voidedMinor: 80, netAmountMinor: 0, allocatedMinor: 0, outstandingMinor: 0, lifecycle: "voided" }).success).toBe(true);
    expect(FinancePaymentBalanceSchema.safeParse({ amountMinor: 100, refundedMinor: 0, voidedMinor: 100, netAmountMinor: 0,
      allocatedMinor: 0, unallocatedMinor: 0, lifecycle: "voided" }).success).toBe(true);
    expect(FinancePaymentBalanceSchema.safeParse({ ...paymentBalance(), voidedMinor: 80, netAmountMinor: 0, allocatedMinor: 0, unallocatedMinor: 0, lifecycle: "voided" }).success).toBe(false);
  });
  it("represents a zero-money quantity-only procurement acknowledgement without inventing a credit amount", () => {
    const source = { ...billEvent(), kind: "source_acknowledgement", amountMinor: 0, reasonCode: "PROCUREMENT_APPROVED", procurementAdjustmentId: createEntityId(), procurementReviewId: createEntityId(),
      balanceAfter: { ...billBalance(), creditMinor: 0, netAmountMinor: 100, outstandingMinor: 50 } };
    expect(FinanceBillAdjustmentViewSchema.safeParse(source).success).toBe(true);
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...source, reasonCode: "SUPPLIER_CORRECTION" }).success).toBe(false);
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...source, amountMinor: 1 }).success).toBe(false);
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...source, procurementReviewId: null }).success).toBe(false);
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...billEvent(), amountMinor: 0 }).success).toBe(false);
  });
  it("keeps a refund operator-recorded and rejects fabricated bank verification or missing document proof", () => {
    expect(FinancePaymentAdjustmentViewSchema.safeParse(paymentEvent()).success).toBe(true);
    expect(FinancePaymentAdjustmentViewSchema.safeParse({ ...paymentEvent(), evidenceStatus: "bank_verified" }).success).toBe(false);
    expect(FinancePaymentAdjustmentViewSchema.safeParse({ ...paymentEvent(), externalDocumentId: null }).success).toBe(false);
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...billEvent(), procurementAdjustmentId: createEntityId(), procurementReviewId: null }).success).toBe(false);
  });
  it.each(["XXX", "ZZZ", "XAU"])("rejects unknown %s precision in saved correction receipts", currency => {
    expect(FinanceBillAdjustmentViewSchema.safeParse({ ...billEvent(), currency }).success).toBe(false);
    expect(FinancePaymentAdjustmentViewSchema.safeParse({ ...paymentEvent(), currency }).success).toBe(false);
  });
  it("requires the current payable views and workspace to expose real adjustment histories and net fields", () => {
    const base = { id: billId, supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-BILL", currency: "USD", ...billBalance(),
      issuedAt: at, dueAt: null, procurementInvoiceId: null, procurementProofId: null, sourceStatus: "current", status: "partially_allocated", recordedAt: at };
    const paid = { id: paymentId, supplierId, externalPaymentId: "SYNTHETIC-PAYMENT", currency: "USD", ...paymentBalance(), paidAt: at,
      method: "bank_transfer", evidenceReference: "SYNTHETIC-EVIDENCE", evidenceStatus: "operator_recorded", status: "partially_allocated", recordedAt: at };
    expect(FinancePayableBillViewSchema.safeParse(base).success).toBe(true);
    expect(FinancePayablePaymentViewSchema.safeParse(paid).success).toBe(true);
    expect(FinancePayablesWorkspaceViewSchema.safeParse({ suppliers: [], bills: [base], payments: [paid], allocations: [], releases: [],
      billAdjustments: [billEvent()], paymentAdjustments: [paymentEvent()], procurementAdjustments: [], procurementAdjustmentDiagnostics: [],
      permissions: { canWrite: false, canReview: true }, truncated: false }).success).toBe(true);
    expect(FinancePayableBillViewSchema.safeParse({ ...base, netAmountMinor: 100 }).success).toBe(false);
  });
});
