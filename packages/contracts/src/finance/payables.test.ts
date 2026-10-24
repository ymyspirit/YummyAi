import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { AllocateFinancePaymentInputSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePaymentAllocationBatchViewSchema, RecordFinanceBillInputSchema, RecordFinancePaymentInputSchema,
  ReleaseFinanceAllocationInputSchema, parseFinancePayableAmount } from "./payables.js";

const supplierId = createEntityId(), paymentId = createEntityId(), billId = "019f0000-abcd-7000-8000-000000000001", batchId = createEntityId();
const bill = () => ({ supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-INV/001", currency: "USD", amountMinor: 10000,
  issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: "synthetic-bill-original" });
const payment = () => ({ supplierId, externalPaymentId: "SYNTHETIC-PAY/001", currency: "USD", amountMinor: 10000,
  paidAt: "2026-07-02T00:00:00.000Z", method: "bank_transfer", evidenceReference: "SYNTHETIC-RECEIPT/001", idempotencyKey: "synthetic-payment-original" });
const billView = () => ({ ...bill(), id: billId, procurementProofId: null, sourceStatus: "current", allocatedMinor: 0, outstandingMinor: 10000,
  creditMinor: 0, debitMinor: 0, voidedMinor: 0, netAmountMinor: 10000, lifecycle: "active",
  status: "unallocated", recordedAt: "2026-07-02T00:00:00.000Z" });
const allocation = () => ({ id: createEntityId(), batchId, paymentId, billId, supplierId, currency: "USD", amountMinor: 1000, released: false,
  recordedAt: "2026-07-02T00:00:00.000Z" });

describe("actual payables and recorded payments keep their identities and exact money", () => {
  it.each([
    { value: "1234", currency: "JPY", expected: 1234 }, { value: "1.234", currency: "KWD", expected: 1234 },
    { value: "1.2345", currency: "CLF", expected: 12345 }, { value: "90071992547409.90", currency: "USD", expected: 9007199254740990 },
    { value: "90071992547409.91", currency: "USD", expected: Number.MAX_SAFE_INTEGER }, { value: "0.01", currency: "USD", expected: 1 },
  ])("parses $currency $value without float multiplication", ({ value, currency, expected }) => expect(parseFinancePayableAmount(value, currency)).toBe(expected));
  it.each(["0", "-1", "1e2", ".1", "01", "0.001", "90071992547409.92"])("rejects invalid or unrepresentable USD amount %s", value => {
    expect(() => parseFinancePayableAmount(value, "USD")).toThrow();
  });
  it.each(["ZZZ", "XXX", "XAU"])("does not create %s money with assumed precision", currency => {
    expect(() => parseFinancePayableAmount("1", currency)).toThrow("finance_currency_precision_unknown");
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), currency }).success).toBe(false);
    expect(RecordFinancePaymentInputSchema.safeParse({ ...payment(), currency }).success).toBe(false);
  });
  it("binds procurement source presence to the procurement bill kind", () => {
    expect(RecordFinanceBillInputSchema.safeParse(bill()).success).toBe(true);
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), kind: "procurement_invoice", procurementInvoiceId: createEntityId() }).success).toBe(true);
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), kind: "procurement_invoice" }).success).toBe(false);
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), procurementInvoiceId: createEntityId() }).success).toBe(false);
  });
  it("accepts equal real dates in equivalent ISO representations and rejects a genuinely earlier due date", () => {
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), issuedAt: "2026-07-01T00:00:00Z", dueAt: "2026-07-01T00:00:00.000Z" }).success).toBe(true);
    expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), dueAt: "2026-06-30T23:59:59.999Z" }).success).toBe(false);
  });
  it("rejects caller-selected authority, bank account details and unsupported amount shapes", () => {
    for (const extra of [{ tenantId: createEntityId() }, { createdBy: createEntityId() }, { permissions: ["finance:write"] }])
      expect(RecordFinanceBillInputSchema.safeParse({ ...bill(), ...extra }).success).toBe(false);
    expect(RecordFinancePaymentInputSchema.safeParse({ ...payment(), bankAccount: "SYNTHETIC-FORBIDDEN" }).success).toBe(false);
    for (const amountMinor of [0, -1, 1.2, "100", Number.MAX_SAFE_INTEGER + 1])
      expect(RecordFinancePaymentInputSchema.safeParse({ ...payment(), amountMinor }).success).toBe(false);
  });
  it("uses exact safe sums and rejects a duplicated bill including a UUID case alias", () => {
    const base = { paymentId, allocations: [{ billId, amountMinor: 100 }], idempotencyKey: "synthetic-allocation-original" };
    expect(AllocateFinancePaymentInputSchema.safeParse(base).success).toBe(true);
    expect(AllocateFinancePaymentInputSchema.safeParse({ ...base, allocations: [...base.allocations, { billId: billId.toUpperCase(), amountMinor: 1 }] }).success).toBe(false);
    expect(AllocateFinancePaymentInputSchema.safeParse({ ...base, allocations: [{ billId, amountMinor: Number.MAX_SAFE_INTEGER }, { billId: createEntityId(), amountMinor: 1 }] }).success).toBe(false);
  });
  it("keeps a payment operator-recorded and conserves bill and payment balances", () => {
    const { idempotencyKey: omittedBill, ...view } = billView(); void omittedBill;
    expect(FinancePayableBillViewSchema.safeParse(view).success).toBe(true);
    expect(FinancePayableBillViewSchema.safeParse({ ...view, allocatedMinor: 1000 }).success).toBe(false);
    expect(FinancePayableBillViewSchema.safeParse({ ...view, status: "fully_allocated" }).success).toBe(false);
    const { idempotencyKey: omittedPayment, ...body } = payment(); void omittedPayment;
    const paid = { ...body, id: paymentId, evidenceStatus: "operator_recorded", allocatedMinor: 1000, unallocatedMinor: 9000,
      refundedMinor: 0, voidedMinor: 0, netAmountMinor: 10000, lifecycle: "active",
      status: "partially_allocated", recordedAt: "2026-07-02T00:00:00.000Z" };
    expect(FinancePayablePaymentViewSchema.safeParse(paid).success).toBe(true);
    expect(FinancePayablePaymentViewSchema.safeParse({ ...paid, evidenceStatus: "bank_verified" }).success).toBe(false);
    expect(FinancePayablePaymentViewSchema.safeParse({ ...paid, unallocatedMinor: 10000 }).success).toBe(false);
  });
  it("binds every allocation result to its actual batch and payment", () => {
    const value = { id: batchId, paymentId, allocations: [allocation()], recordedAt: "2026-07-02T00:00:00.000Z" };
    expect(FinancePaymentAllocationBatchViewSchema.safeParse(value).success).toBe(true);
    expect(FinancePaymentAllocationBatchViewSchema.safeParse({ ...value, allocations: [{ ...value.allocations[0]!, batchId: createEntityId() }] }).success).toBe(false);
    expect(FinancePaymentAllocationBatchViewSchema.safeParse({ ...value, allocations: [{ ...value.allocations[0]!, paymentId: createEntityId() }] }).success).toBe(false);
    expect(FinancePaymentAllocationBatchViewSchema.safeParse({ ...value, allocations: [...value.allocations, { ...allocation(), billId }] }).success).toBe(false);
  });
  it("releases an actual allocation with a reason and an original key rather than a caller-set released status", () => {
    expect(ReleaseFinanceAllocationInputSchema.safeParse({ reasonCode: "WRONG_BILL", idempotencyKey: "synthetic-release-original" }).success).toBe(true);
    expect(ReleaseFinanceAllocationInputSchema.safeParse({ reasonCode: "WRONG_BILL", idempotencyKey: "synthetic-release-original", released: true }).success).toBe(false);
  });
});
