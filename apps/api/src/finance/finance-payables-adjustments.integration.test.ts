import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalFinancePayablesRequest } from "@yummyai/contracts/finance/payables";
import { canonicalFinancePayableAdjustmentRequest, type RecordFinanceBillAdjustmentInput, type RecordFinancePaymentAdjustmentInput } from "@yummyai/contracts/finance/payables-adjustments";
import { connectDatabase, migrateDatabase, withTenant, memberships, financeBillAdjustments, financePaymentAdjustments,
  financePaymentAllocationBatches, financePaymentAllocations, membershipRoles, roles, type TenantTransaction } from "@yummyai/database";
import { adjustmentCode, adjustmentKey, adjustmentPermissions, existingPayablesTables, financePayablesAdjustmentsFixture,
  protectedAdjustmentFacts, requireFinancePayablesAdjustmentsFixture } from "./finance-payables-adjustments.fixtures.js";

requireFinancePayablesAdjustmentsFixture();
const adjustmentTables = ["finance_bill_adjustments", "finance_payment_adjustments"];
const allTables = [...existingPayablesTables, ...adjustmentTables, ...protectedAdjustmentFacts, "audit_events"];
const common = (expectedNetAmountMinor: number) => ({ expectedNetAmountMinor, evidenceReference: "Synthetic supplier correction evidence",
  occurredAt: "2026-07-03T00:00:00.000Z", reasonCode: "SUPPLIER_CORRECTION", idempotencyKey: adjustmentKey() });
const credit = (amountMinor: number, expectedNetAmountMinor: number): Extract<RecordFinanceBillAdjustmentInput, { kind: "credit" }> =>
  ({ ...common(expectedNetAmountMinor), kind: "credit", amountMinor, externalDocumentId: adjustmentCode() });
const debit = (amountMinor: number, expectedNetAmountMinor: number): Extract<RecordFinanceBillAdjustmentInput, { kind: "debit" }> =>
  ({ ...common(expectedNetAmountMinor), kind: "debit", amountMinor, externalDocumentId: adjustmentCode() });
const refund = (amountMinor: number, expectedNetAmountMinor: number): Extract<RecordFinancePaymentAdjustmentInput, { kind: "refund" }> =>
  ({ ...common(expectedNetAmountMinor), kind: "refund", amountMinor, externalDocumentId: adjustmentCode() });
const voidInput = (expectedNetAmountMinor: number) => ({ ...common(expectedNetAmountMinor), kind: "void" as const });
const sync = (recordId: string, reviewId: string, expectedNetAmountMinor: number): RecordFinanceBillAdjustmentInput =>
  ({ kind: "procurement_sync", procurementAdjustmentId: recordId, procurementReviewId: reviewId, expectedNetAmountMinor, idempotencyKey: adjustmentKey() });
const conflict = (code: string) => ({ status: 409, response: { code } });
const denied = (error: unknown) => error instanceof ForbiddenError || (error as { status?: number }).status === 403;
const pg = (error: unknown) => { const outer = error as { code?: string; message?: string; cause?: { code?: string; message?: string } }; return outer.cause?.code ? outer.cause : outer; };
const sqlFailure = (message: string) => (error: unknown) => pg(error).code === "23514" && Boolean(pg(error).message?.includes(message));

describe.sequential("actual payable corrections, source synchronization and recorded supplier refunds", () => {
  const database = connectDatabase(), f = financePayablesAdjustmentsFixture(database);
  const { context, coworker, outsider, adjustments, payables } = f;
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.restoreRights(); });
  afterAll(async () => { f.destroy(); await database.client.end(); });
  const state = () => f.state(allTables);
  const dueNow = async (id: string) => (await f.workspace()).bills.find(row => row.id === id)!;
  const paidNow = async (id: string) => (await f.workspace()).payments.find(row => row.id === id)!;

  it("appends actual credit and debit documents without rewriting the original bill, stock, invoice or cost facts", async () => {
    const due = await f.bill(100), before = await f.state(protectedAdjustmentFacts);
    const first = await adjustments.recordBillAdjustment(context, due.id, credit(20, 100));
    expect(first).toMatchObject({ billId: due.id, kind: "credit", amountMinor: 20,
      balanceAfter: { amountMinor: 100, creditMinor: 20, debitMinor: 0, netAmountMinor: 80, outstandingMinor: 80 } });
    const second = await adjustments.recordBillAdjustment(context, due.id, debit(5, 80));
    expect(second.balanceAfter).toMatchObject({ amountMinor: 100, creditMinor: 20, debitMinor: 5, netAmountMinor: 85, outstandingMinor: 85 });
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 100, creditMinor: 20, debitMinor: 5, netAmountMinor: 85, lifecycle: "active" });
    expect((await f.workspace()).billAdjustments.find(row => row.id === first.id)).toEqual(first);
    const [stored] = await withTenant(database.db, context, tx => tx.execute<{ amount_minor: string }>(sql`select amount_minor::text from finance_payable_bills where id=${due.id}`));
    expect(stored!.amount_minor).toBe("100"); expect(await f.state(protectedAdjustmentFacts)).toEqual(before);
  });
  it("requires an explicit allocation release before reducing occupied principal and records an actual refund separately", async () => {
    const due = await f.bill(100), paid = await f.payment(100), original = (await f.allocate(paid.id, due.id, 100)).allocations[0]!;
    const before = await state(), billInput = credit(20, 100), paymentInput = refund(20, 100);
    await expect(adjustments.recordBillAdjustment(context, due.id, billInput)).rejects.toMatchObject(conflict("finance_payables_adjustment_requires_release"));
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, paymentInput)).rejects.toMatchObject(conflict("finance_payables_adjustment_requires_release"));
    expect(await state()).toEqual(before);
    await payables.release(context, original.id, { reasonCode: "SOURCE_CHANGED", idempotencyKey: adjustmentKey() });
    expect(await paidNow(paid.id)).toMatchObject({ amountMinor: 100, refundedMinor: 0, netAmountMinor: 100, unallocatedMinor: 100 });
    await adjustments.recordBillAdjustment(context, due.id, billInput); await f.allocate(paid.id, due.id, 80);
    const actualRefund = await adjustments.recordPaymentAdjustment(context, paid.id, paymentInput);
    expect(actualRefund).toMatchObject({ kind: "refund", amountMinor: 20, evidenceStatus: "operator_recorded",
      balanceAfter: { amountMinor: 100, refundedMinor: 20, netAmountMinor: 80, allocatedMinor: 80, unallocatedMinor: 0 } });
    const current = await f.workspace(); expect(current.allocations.find(row => row.id === original.id)).toMatchObject({ amountMinor: 100, released: true });
    expect(current.bills.find(row => row.id === due.id)).toMatchObject({ amountMinor: 100, netAmountMinor: 80, allocatedMinor: 80, outstandingMinor: 0 });
  });
  it("replays the original immutable execution balance after later corrections instead of substituting the current balance", async () => {
    const due = await f.bill(100), paid = await f.payment(100), input = credit(20, 100), paidInput = refund(10, 100);
    const first = await adjustments.recordBillAdjustment(context, due.id, input), paidFirst = await adjustments.recordPaymentAdjustment(context, paid.id, paidInput);
    await adjustments.recordBillAdjustment(context, due.id, debit(5, 80)); await adjustments.recordPaymentAdjustment(context, paid.id, refund(10, 90));
    const before = await state(); expect(await adjustments.recordBillAdjustment(context, due.id, input)).toEqual(first);
    expect(await adjustments.recordPaymentAdjustment(context, paid.id, paidInput)).toEqual(paidFirst); expect(await state()).toEqual(before);
    expect(first.balanceAfter.netAmountMinor).toBe(80); expect((await dueNow(due.id)).netAmountMinor).toBe(85);
    expect(paidFirst.balanceAfter.netAmountMinor).toBe(90); expect((await paidNow(paid.id)).netAmountMinor).toBe(80);
  });
  it("rejects a stale expected net but permits a new actual document only against the current net", async () => {
    const due = await f.bill(100), paid = await f.payment(100);
    await adjustments.recordBillAdjustment(context, due.id, credit(20, 100)); await adjustments.recordPaymentAdjustment(context, paid.id, refund(20, 100));
    const before = await state(); await expect(adjustments.recordBillAdjustment(context, due.id, debit(1, 100))).rejects.toMatchObject(conflict("finance_payables_balance_changed"));
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, refund(1, 100))).rejects.toMatchObject(conflict("finance_payables_balance_changed"));
    expect(await state()).toEqual(before); expect((await adjustments.recordBillAdjustment(context, due.id, debit(1, 80))).balanceAfter.netAmountMinor).toBe(81);
  });
  it.each(["bill", "payment"] as const)("binds a %s correction key to the original target, actor, expected balance and full body", async operation => {
    const a = operation === "bill" ? await f.bill(100) : await f.payment(100), b = operation === "bill" ? await f.bill(100) : await f.payment(100);
    const input = operation === "bill" ? credit(10, 100) : refund(10, 100);
    const invoke = (actor: TenantContext, id: string, raw: unknown) => operation === "bill"
      ? adjustments.recordBillAdjustment(actor, id, raw) : adjustments.recordPaymentAdjustment(actor, id, raw);
    const recorded = await invoke(context, a.id, input), before = await state();
    expect(await invoke(context, a.id, input)).toEqual(recorded);
    for (const changed of [{ ...input, amountMinor: 11 }, { ...input, expectedNetAmountMinor: 90 }, { ...input, evidenceReference: "Changed actual evidence" }])
      await expect(invoke(context, a.id, changed)).rejects.toMatchObject(conflict("finance_payables_request_mismatch"));
    await expect(invoke(context, b.id, input)).rejects.toMatchObject(conflict("finance_payables_request_mismatch"));
    await expect(invoke(coworker, a.id, input)).rejects.toMatchObject(conflict("finance_payables_request_mismatch")); expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("deduplicates the actual supplier %s document across targets, keys and currencies while allowing another supplier", async operation => {
    const otherSupplier = await f.supplier(), a = operation === "bill" ? await f.bill(100) : await f.payment(100);
    const b = operation === "bill" ? await f.bill(100, { currency: "EUR" }) : await f.payment(100, { currency: "EUR" });
    const c = operation === "bill" ? await f.bill(100, { supplierId: otherSupplier }) : await f.payment(100, { supplierId: otherSupplier });
    const input = operation === "bill" ? credit(10, 100) : refund(10, 100);
    const invoke = (id: string, raw: unknown) => operation === "bill" ? adjustments.recordBillAdjustment(context, id, raw) : adjustments.recordPaymentAdjustment(context, id, raw);
    await invoke(a.id, input); const before = await state();
    await expect(invoke(b.id, { ...input, idempotencyKey: adjustmentKey() })).rejects.toMatchObject(conflict("finance_payables_adjustment_document_duplicate"));
    expect(await state()).toEqual(before); expect((await invoke(c.id, { ...input, idempotencyKey: adjustmentKey() })).supplierId).toBe(otherSupplier);
  });
  it("preserves exact safe integers, rejects cumulative debit overflow and rejects credit or refund beyond net principal", async () => {
    const due = await f.bill(Number.MAX_SAFE_INTEGER), paid = await f.payment(Number.MAX_SAFE_INTEGER), before = await state();
    await expect(adjustments.recordBillAdjustment(context, due.id, debit(1, Number.MAX_SAFE_INTEGER))).rejects.toMatchObject({ status: 422, response: { code: "finance_money_overflow" } });
    expect(await state()).toEqual(before);
    const credited = await adjustments.recordBillAdjustment(context, due.id, credit(1, Number.MAX_SAFE_INTEGER));
    const refunded = await adjustments.recordPaymentAdjustment(context, paid.id, refund(1, Number.MAX_SAFE_INTEGER));
    expect(credited.balanceAfter.netAmountMinor).toBe(Number.MAX_SAFE_INTEGER - 1); expect(refunded.balanceAfter.netAmountMinor).toBe(Number.MAX_SAFE_INTEGER - 1);
    const reduced = await state(); await expect(adjustments.recordBillAdjustment(context, due.id, credit(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1))).rejects.toMatchObject(conflict("finance_payables_adjustment_exceeded"));
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, refund(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1))).rejects.toMatchObject(conflict("finance_payables_refund_exceeded"));
    expect(await state()).toEqual(reduced);
  });
  it("distinguishes fully credited and fully refunded histories from voided records", async () => {
    const due = await f.bill(100), paid = await f.payment(100);
    await adjustments.recordBillAdjustment(context, due.id, credit(100, 100)); await adjustments.recordPaymentAdjustment(context, paid.id, refund(100, 100));
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 100, creditMinor: 100, netAmountMinor: 0, lifecycle: "fully_credited" });
    expect(await paidNow(paid.id)).toMatchObject({ amountMinor: 100, refundedMinor: 100, voidedMinor: 0, netAmountMinor: 0, lifecycle: "fully_refunded" });
    const before = await state(); await expect(adjustments.recordPaymentAdjustment(context, paid.id, voidInput(0))).rejects.toMatchObject(conflict("finance_payables_payment_refunded"));
    expect(await state()).toEqual(before);
    await adjustments.recordBillAdjustment(context, due.id, debit(10, 0)); expect(await dueNow(due.id)).toMatchObject({ netAmountMinor: 10, lifecycle: "active", amountMinor: 100 });
  });
  it("appends an explicit bill or payment void and prevents subsequent corrections or new allocations", async () => {
    const due = await f.bill(100), paid = await f.payment(100), billOriginal = voidInput(100), paymentOriginal = voidInput(100);
    const a = await adjustments.recordBillAdjustment(context, due.id, billOriginal), p = await adjustments.recordPaymentAdjustment(context, paid.id, paymentOriginal);
    expect(a.balanceAfter).toMatchObject({ amountMinor: 100, voidedMinor: 100, netAmountMinor: 0, lifecycle: "voided" });
    expect(p.balanceAfter).toMatchObject({ amountMinor: 100, refundedMinor: 0, voidedMinor: 100, netAmountMinor: 0, lifecycle: "voided" });
    const before = await state(); await expect(adjustments.recordBillAdjustment(context, due.id, debit(1, 0))).rejects.toMatchObject(conflict("finance_payables_adjustment_voided"));
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, refund(1, 0))).rejects.toMatchObject(conflict("finance_payables_adjustment_voided"));
    await expect(f.allocate(paid.id, due.id, 1)).rejects.toMatchObject({ status: 409 });
    expect(await adjustments.recordBillAdjustment(context, due.id, billOriginal)).toEqual(a); expect(await adjustments.recordPaymentAdjustment(context, paid.id, paymentOriginal)).toEqual(p);
    expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("serializes two competing %s reductions without a lost update or negative capacity", async operation => {
    const row = operation === "bill" ? await f.bill(100) : await f.payment(100);
    const invoke = () => operation === "bill" ? adjustments.recordBillAdjustment(context, row.id, credit(60, 100)) : adjustments.recordPaymentAdjustment(context, row.id, refund(60, 100));
    const attempts = await Promise.allSettled([invoke(), invoke()]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((attempts.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(conflict("finance_payables_balance_changed"));
    const current = operation === "bill" ? await dueNow(row.id) : await paidNow(row.id); expect(current.netAmountMinor).toBe(40); expect(current.allocatedMinor).toBe(0);
  });
  it.each(["bill", "payment"] as const)("serializes an allocation against a simultaneous %s principal reduction", async operation => {
    const due = await f.bill(100), paid = await f.payment(100), reduce = () => operation === "bill"
      ? adjustments.recordBillAdjustment(context, due.id, credit(40, 100)) : adjustments.recordPaymentAdjustment(context, paid.id, refund(40, 100));
    const attempts = await Promise.allSettled([f.allocate(paid.id, due.id, 80), reduce()]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((attempts.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const currentBill = await dueNow(due.id), currentPayment = await paidNow(paid.id);
    expect(BigInt(currentBill.allocatedMinor) + BigInt(currentBill.outstandingMinor)).toBe(BigInt(currentBill.netAmountMinor));
    expect(BigInt(currentPayment.allocatedMinor) + BigInt(currentPayment.unallocatedMinor)).toBe(BigInt(currentPayment.netAmountMinor));
    expect([0, 80]).toContain(currentBill.allocatedMinor);
  });
  it.each(["bill", "payment"] as const)("commits a repeated concurrent %s original request once with one success audit", async operation => {
    const row = operation === "bill" ? await f.bill(100) : await f.payment(100), input = operation === "bill" ? credit(20, 100) : refund(20, 100);
    const invoke = () => operation === "bill" ? adjustments.recordBillAdjustment(context, row.id, input) : adjustments.recordPaymentAdjustment(context, row.id, input);
    const [first, second] = await Promise.all([invoke(), invoke()]); expect(second).toEqual(first);
    const [audit] = await withTenant(database.db, context, tx => tx.execute<{ count: string }>(sql`select count(*)::text as count from audit_events
      where action=${`finance.payables.${operation === "bill" ? "bill" : "payment"}_adjustment_recorded`} and entity_id=${first.id}`));
    expect(audit!.count).toBe("1");
  });
  it.each(["bill", "payment"] as const)("rolls the %s event, original balance and audit back together on final audit failure", async operation => {
    const row = operation === "bill" ? await f.bill(100) : await f.payment(100), input = operation === "bill" ? credit(20, 100) : refund(20, 100);
    const invoke = () => operation === "bill" ? adjustments.recordBillAdjustment(context, row.id, input) : adjustments.recordPaymentAdjustment(context, row.id, input);
    const before = await state(), spy = vi.spyOn(f.procurement.audit, "recordInTransaction").mockRejectedValue(new Error("Synthetic adjustment audit unavailable"));
    await expect(invoke()).rejects.toThrow("Synthetic adjustment audit unavailable"); expect(spy).toHaveBeenCalledOnce(); expect(await state()).toEqual(before);
    spy.mockRestore(); await expect(invoke()).resolves.toBeDefined();
  });
  it("maps a real approved price credit after bill registration and unlocks only the corrected actual net", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), recorded = await f.record(source, { amountMinor: 20, quantity: 0 });
    const approved = await f.review(source.invoice.id, recorded.id), due = await f.procurementBill(source), paid = await f.payment(240);
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 260, netAmountMinor: 260, sourceStatus: "source_adjusted" });
    await expect(f.allocate(paid.id, due.id, 240)).rejects.toMatchObject(conflict("finance_payables_source_adjusted"));
    const before = await f.state(protectedAdjustmentFacts), actual = await adjustments.recordBillAdjustment(context, due.id, sync(recorded.id, approved.id, 260));
    expect(actual).toMatchObject({ kind: "credit", amountMinor: 20, procurementAdjustmentId: recorded.id, procurementReviewId: approved.id,
      balanceAfter: { amountMinor: 260, creditMinor: 20, netAmountMinor: 240, outstandingMinor: 240 } });
    expect(await dueNow(due.id)).toMatchObject({ sourceStatus: "current", netAmountMinor: 240 }); await f.allocate(paid.id, due.id, 240);
    expect(await dueNow(due.id)).toMatchObject({ allocatedMinor: 240, outstandingMinor: 0 }); expect(await f.state(protectedAdjustmentFacts)).toEqual(before);
    expect((await f.procurement.reconciliation.detail(context, source.invoice.id)).originalStatus).toBe("reconciliation_required");
  });
  it("keeps a paid procurement invoice, actual receipt and original allocation while recording credit, explicit release, reallocation and actual refund", async () => {
    const source = await f.procurement.basis(), due = await f.procurementBill(source), paid = await f.payment(240), original = (await f.allocate(paid.id, due.id, 240)).allocations[0]!;
    const recorded = await f.record(source, { quantity: "0.05", amountMinor: 60 }), approved = await f.review(source.invoice.id, recorded.id);
    const basisBefore = await f.state(protectedAdjustmentFacts), input = sync(recorded.id, approved.id, 240), before = await state();
    await expect(adjustments.recordBillAdjustment(context, due.id, input)).rejects.toMatchObject(conflict("finance_payables_adjustment_requires_release")); expect(await state()).toEqual(before);
    await payables.release(context, original.id, { reasonCode: "SOURCE_CHANGED", idempotencyKey: adjustmentKey() });
    expect(await paidNow(paid.id)).toMatchObject({ amountMinor: 240, refundedMinor: 0, netAmountMinor: 240 });
    await adjustments.recordBillAdjustment(context, due.id, input); await f.allocate(paid.id, due.id, 180);
    await adjustments.recordPaymentAdjustment(context, paid.id, refund(60, 240));
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 240, creditMinor: 60, netAmountMinor: 180, allocatedMinor: 180, sourceStatus: "current" });
    expect(await paidNow(paid.id)).toMatchObject({ amountMinor: 240, refundedMinor: 60, netAmountMinor: 180, allocatedMinor: 180, unallocatedMinor: 0 });
    expect((await f.workspace()).allocations.find(row => row.id === original.id)).toMatchObject({ amountMinor: 240, released: true });
    expect(await f.state(protectedAdjustmentFacts)).toEqual(basisBefore);
  });
  it("synchronizes every approved source independently and does not unlock a bill after mapping only the latest document", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1400 }), first = await f.record(source, { amountMinor: 20 });
    const firstReview = await f.review(source.invoice.id, first.id), second = await f.record(source, { amountMinor: 20 });
    const secondReview = await f.review(source.invoice.id, second.id), due = await f.procurementBill(source);
    await adjustments.recordBillAdjustment(context, due.id, sync(second.id, secondReview.id, 280));
    expect(await dueNow(due.id)).toMatchObject({ netAmountMinor: 260, sourceStatus: "source_adjusted" });
    const options = (await f.workspace()).procurementAdjustments.filter(row => row.billId === due.id);
    expect(options.find(row => row.procurementAdjustmentId === second.id)?.mappedEventId).toBeTruthy();
    expect(options.find(row => row.procurementAdjustmentId === first.id)?.mappedEventId).toBeNull();
    await adjustments.recordBillAdjustment(context, due.id, sync(first.id, firstReview.id, 260));
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 280, creditMinor: 40, netAmountMinor: 240, sourceStatus: "current" });
  });
  it("maps an approved actual debit and a zero-money quantity acknowledgement without inventing a manual correction", async () => {
    const underpriced = await f.procurement.basis({ unitCostMinor: 1100 }), recorded = await f.record(underpriced, { kind: "debit_note", amountMinor: 20, quantity: 0 });
    const approved = await f.review(underpriced.invoice.id, recorded.id), due = await f.procurementBill(underpriced);
    const actual = await adjustments.recordBillAdjustment(context, due.id, sync(recorded.id, approved.id, 220));
    expect(actual).toMatchObject({ kind: "debit", amountMinor: 20, balanceAfter: { debitMinor: 20, netAmountMinor: 240 } });
    expect((await dueNow(due.id)).sourceStatus).toBe("current");
    const quantitySource = await f.procurement.basis({ unitCostMinor: 1140 }), quantityRecord = await f.record(quantitySource, { quantity: "0.01", amountMinor: 0 });
    const quantityReview = await f.review(quantitySource.invoice.id, quantityRecord.id), quantityBill = await f.procurementBill(quantitySource);
    const acknowledgement = await adjustments.recordBillAdjustment(context, quantityBill.id, sync(quantityRecord.id, quantityReview.id, 228));
    expect(acknowledgement).toMatchObject({ kind: "source_acknowledgement", amountMinor: 0,
      balanceAfter: { amountMinor: 228, creditMinor: 0, debitMinor: 0, netAmountMinor: 228 } });
    expect(await dueNow(quantityBill.id)).toMatchObject({ sourceStatus: "current", netAmountMinor: 228 });
  });
  it("rejects pending, rejected, wrong-invoice and record-as-review sources and blocks handwritten procurement credits", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), due = await f.procurementBill(source), pending = await f.record(source, { amountMinor: 20 });
    const other = await f.procurement.basis({ unitCostMinor: 1300 }), otherRecord = await f.record(other, { amountMinor: 20 });
    const otherReview = await f.review(other.invoice.id, otherRecord.id), rejected = await f.review(source.invoice.id, pending.id, "rejected");
    const before = await state();
    for (const input of [sync(pending.id, pending.id, 260), sync(pending.id, rejected.id, 260), sync(otherRecord.id, otherReview.id, 260), sync(pending.id, createEntityId(), 260)])
      await expect(adjustments.recordBillAdjustment(context, due.id, input)).rejects.toMatchObject(conflict("finance_payables_procurement_source_invalid"));
    for (const input of [credit(20, 260), debit(20, 260)])
      await expect(adjustments.recordBillAdjustment(context, due.id, input)).rejects.toMatchObject(conflict("finance_payables_procurement_adjustment_required"));
    await expect(adjustments.recordBillAdjustment(context, due.id, voidInput(260))).rejects.toMatchObject(conflict("finance_payables_procurement_void_unavailable")); expect(await state()).toEqual(before);
  });
  it("maps one approved procurement source once under competing keys and keeps its original result available", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), recorded = await f.record(source, { amountMinor: 20 });
    const approved = await f.review(source.invoice.id, recorded.id), due = await f.procurementBill(source), a = sync(recorded.id, approved.id, 260), b = sync(recorded.id, approved.id, 260);
    const attempts = await Promise.allSettled([adjustments.recordBillAdjustment(context, due.id, a), adjustments.recordBillAdjustment(context, due.id, b)]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((attempts.find(result => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(conflict("finance_payables_procurement_adjustment_already_synced"));
    const winner = attempts[0]!.status === "fulfilled" ? a : b, value = (attempts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof adjustments.recordBillAdjustment>>>).value;
    expect(await adjustments.recordBillAdjustment(context, due.id, winner)).toEqual(value);
    expect((await f.workspace()).billAdjustments.filter(row => row.procurementAdjustmentId === recorded.id)).toHaveLength(1);
  });
  it("does not consume an approved procurement source when the final financial audit fails", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), record = await f.record(source, { amountMinor: 20 });
    const review = await f.review(source.invoice.id, record.id), due = await f.procurementBill(source), input = sync(record.id, review.id, 260);
    const before = await state(), spy = vi.spyOn(f.procurement.audit, "recordInTransaction").mockRejectedValue(new Error("Synthetic source synchronization audit unavailable"));
    await expect(adjustments.recordBillAdjustment(context, due.id, input)).rejects.toThrow("Synthetic source synchronization audit unavailable");
    expect(await state()).toEqual(before); spy.mockRestore();
    expect((await f.workspace()).procurementAdjustments.find(row => row.procurementAdjustmentId === record.id)?.mappedEventId).toBeNull();
    await expect(adjustments.recordBillAdjustment(context, due.id, input)).resolves.toMatchObject({ procurementAdjustmentId: record.id, amountMinor: 20 });
  });
  it("preserves a real 151 document that the new format cannot express and reports its actual IDs instead of sanitizing the source", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), number = `SYNTHETIC\nCREDIT-${adjustmentCode()}`;
    const record = await f.record(source, { amountMinor: 20, number });
    const review = await f.review(source.invoice.id, record.id), due = await f.procurementBill(source), current = await f.workspace();
    expect(current.procurementAdjustmentDiagnostics).toContainEqual({ billId: due.id, procurementAdjustmentId: record.id,
      procurementReviewId: review.id, code: "source_format_not_supported" });
    expect(current.procurementAdjustments.some(row => row.procurementAdjustmentId === record.id)).toBe(false);
    const before = await state(); await expect(adjustments.recordBillAdjustment(context, due.id, sync(record.id, review.id, 260)))
      .rejects.toMatchObject(conflict("finance_payables_procurement_source_invalid")); expect(await state()).toEqual(before);
    expect((await f.procurement.reconciliation.detail(context, source.invoice.id)).adjustments.find(row => row.id === record.id)!.document.number)
      .toBe(number);
  });
  it("requires all real procurement quantity and money to be credited and synchronized before voiding the zero-net bill", async () => {
    const source = await f.procurement.basis(), due = await f.procurementBill(source), record = await f.record(source, { quantity: "0.2", amountMinor: 240 });
    const review = await f.review(source.invoice.id, record.id); await adjustments.recordBillAdjustment(context, due.id, sync(record.id, review.id, 240));
    expect(await dueNow(due.id)).toMatchObject({ amountMinor: 240, netAmountMinor: 0, creditMinor: 240, sourceStatus: "current" });
    const actual = await adjustments.recordBillAdjustment(context, due.id, voidInput(0));
    expect(actual).toMatchObject({ kind: "void", amountMinor: 0, balanceAfter: { amountMinor: 240, netAmountMinor: 0, lifecycle: "voided" } });
  });
  it("keeps pending procurement approvals and unmatched balances blocked after all currently approved sources have been mapped", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), first = await f.record(source, { amountMinor: 20 }), approved = await f.review(source.invoice.id, first.id);
    const due = await f.procurementBill(source); await adjustments.recordBillAdjustment(context, due.id, sync(first.id, approved.id, 260));
    const pending = await f.record(source, { kind: "debit_note", amountMinor: 1, quantity: 0 }), paid = await f.payment(240);
    expect((await dueNow(due.id)).sourceStatus).toBe("source_unreconciled");
    await expect(f.allocate(paid.id, due.id, 240)).rejects.toMatchObject(conflict("finance_payables_source_unreconciled"));
    await f.review(source.invoice.id, pending.id, "rejected"); expect((await dueNow(due.id)).sourceStatus).toBe("current");
    await f.allocate(paid.id, due.id, 240);
  });
  it("allows a current tenant reviewer to record corrections without requiring unrelated FinanceRead or FinanceWrite", async () => {
    const due = await f.bill(100), paid = await f.payment(100), reviewer = { ...context, permissions: [Permission.FinanceReview] };
    await f.rights(context, [Permission.FinanceReview]);
    await expect(adjustments.recordBillAdjustment(reviewer, due.id, credit(20, 100))).resolves.toMatchObject({ billId: due.id });
    await expect(adjustments.recordPaymentAdjustment(reviewer, paid.id, refund(20, 100))).resolves.toMatchObject({ paymentId: paid.id });
    await expect(payables.workspace(reviewer)).rejects.toSatisfy(denied);
  });
  it("checks current review authority before both original replay and new writes while retaining authorized reads", async () => {
    const due = await f.bill(100), paid = await f.payment(100), input = credit(20, 100), paidInput = refund(20, 100);
    await adjustments.recordBillAdjustment(context, due.id, input); await adjustments.recordPaymentAdjustment(context, paid.id, paidInput);
    await f.rights(context, adjustmentPermissions.filter(permission => permission !== Permission.FinanceReview)); const before = await state();
    await expect(adjustments.recordBillAdjustment(context, due.id, input)).rejects.toSatisfy(denied);
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, paidInput)).rejects.toSatisfy(denied);
    expect((await f.workspace()).permissions.canReview).toBe(false); expect(await state()).toEqual(before);
  });
  it.each(["self", "team"] as const)("rejects a stale tenant caller whose current FinanceReview is scoped to %s", async scope => {
    const due = await f.bill(100); await f.rights(context, adjustmentPermissions, scope); const before = await state();
    await expect(adjustments.recordBillAdjustment(context, due.id, credit(20, 100))).rejects.toSatisfy(denied); expect(await state()).toEqual(before);
  });
  it("intersects original session rights with current membership and rejects disabled or fabricated authority", async () => {
    const due = await f.bill(100), paid = await f.payment(100), original = { ...context, permissions: adjustmentPermissions.filter(permission => permission !== Permission.FinanceReview) };
    await expect(adjustments.recordBillAdjustment(original, due.id, credit(20, 100))).rejects.toSatisfy(denied);
    await f.rights(context, [Permission.FinanceRead]); await expect(adjustments.recordPaymentAdjustment(context, paid.id, refund(20, 100))).rejects.toSatisfy(denied);
    await f.rights(context, adjustmentPermissions); await withTenant(database.db, context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.userId, context.userId)));
    await expect(adjustments.recordBillAdjustment(context, due.id, credit(20, 100))).rejects.toSatisfy(denied);
  });
  it("does not widen self-scoped review through a separate tenant-scoped reading role", async () => {
    const due = await f.bill(100), readRoleId = createEntityId();
    await withTenant(database.db, context, async tx => {
      const [member] = await tx.select().from(memberships).where(eq(memberships.userId, context.userId));
      if (!member) throw new Error("Synthetic correction reviewer membership missing");
      await tx.insert(roles).values({ id: readRoleId, tenantId: context.tenantId, name: `Synthetic tenant read ${readRoleId}`, permissions: [Permission.FinanceRead], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member.id, roleId: readRoleId });
    });
    await f.rights(context, [Permission.FinanceReview], "self"); const before = await state();
    expect((await f.workspace()).permissions.canReview).toBe(false);
    await expect(adjustments.recordBillAdjustment(context, due.id, credit(20, 100))).rejects.toSatisfy(denied); expect(await state()).toEqual(before);
  });
  it("denies another actual tenant access to existing correction targets and their immutable histories", async () => {
    const due = await f.bill(100), paid = await f.payment(100); await adjustments.recordBillAdjustment(context, due.id, credit(20, 100));
    await adjustments.recordPaymentAdjustment(context, paid.id, refund(20, 100));
    await expect(adjustments.recordBillAdjustment(outsider, due.id, credit(20, 100))).rejects.toMatchObject({ status: 404 });
    await expect(adjustments.recordPaymentAdjustment(outsider, paid.id, refund(20, 100))).rejects.toMatchObject({ status: 404 });
    const foreign = await payables.workspace(outsider); expect(foreign.billAdjustments).toEqual([]); expect(foreign.paymentAdjustments).toEqual([]);
    for (const table of adjustmentTables) expect(await withTenant(database.db, outsider, tx => tx.execute(sql`select id from ${sql.identifier(table)}`))).toEqual([]);
  });

  function rawBill(due: Awaited<ReturnType<typeof f.bill>>, input = credit(20, due.netAmountMinor)): typeof financeBillAdjustments.$inferInsert {
    return { id: createEntityId(), tenantId: context.tenantId, billId: due.id, supplierId: due.supplierId, currency: due.currency,
      kind: "credit", amountMinor: input.amountMinor, externalDocumentId: input.externalDocumentId, evidenceReference: input.evidenceReference,
      occurredAt: new Date(input.occurredAt), reasonCode: input.reasonCode, procurementAdjustmentId: null, procurementReviewId: null,
      input, idempotencyKey: input.idempotencyKey,
      requestChecksum: createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("bill-adjustment", due.id, input)).digest("hex"),
      recordedBy: context.userId, balanceAfter: { amountMinor: due.amountMinor, creditMinor: due.creditMinor + input.amountMinor,
        debitMinor: due.debitMinor, voidedMinor: due.voidedMinor, netAmountMinor: due.netAmountMinor - input.amountMinor,
        allocatedMinor: due.allocatedMinor, outstandingMinor: due.outstandingMinor - input.amountMinor, lifecycle: "active" } };
  }
  function rawPayment(paid: Awaited<ReturnType<typeof f.payment>>, input = refund(20, paid.netAmountMinor)): typeof financePaymentAdjustments.$inferInsert {
    return { id: createEntityId(), tenantId: context.tenantId, paymentId: paid.id, supplierId: paid.supplierId, currency: paid.currency,
      kind: "refund", amountMinor: input.amountMinor, externalDocumentId: input.externalDocumentId, evidenceReference: input.evidenceReference,
      occurredAt: new Date(input.occurredAt), reasonCode: input.reasonCode, input, idempotencyKey: input.idempotencyKey,
      requestChecksum: createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("payment-adjustment", paid.id, input)).digest("hex"),
      recordedBy: context.userId, balanceAfter: { amountMinor: paid.amountMinor, refundedMinor: paid.refundedMinor + input.amountMinor,
        voidedMinor: paid.voidedMinor, netAmountMinor: paid.netAmountMinor - input.amountMinor,
        allocatedMinor: paid.allocatedMinor, unallocatedMinor: paid.unallocatedMinor - input.amountMinor, lifecycle: "active" } };
  }
  async function rawAudit(tx: TenantTransaction, operation: "bill" | "payment", row: { id: string; supplierId: string; currency: string; kind: string; amountMinor: number }, targetId: string) {
    await f.procurement.audit.recordInTransaction(tx, context, { action: `finance.payables.${operation}_adjustment_recorded`,
      resourceType: `finance_${operation}_adjustment`, resourceId: row.id, result: "success", metadata: {
        [operation === "bill" ? "billId" : "paymentId"]: targetId, supplierId: row.supplierId, currency: row.currency, kind: row.kind, amountMinor: row.amountMinor } });
  }
  it.each(["bill", "payment"] as const)("rejects a raw %s body rewrite even when its checksum and final audit match the rewritten body", async operation => {
    const due = await f.bill(100), paid = await f.payment(100), before = await state();
    await expect(withTenant(database.db, context, async tx => {
      if (operation === "bill") {
        const row = rawBill(due), input = { ...credit(21, 100), idempotencyKey: row.idempotencyKey, externalDocumentId: row.externalDocumentId! };
        row.input = input; row.requestChecksum = createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("bill-adjustment", due.id, input)).digest("hex");
        await rawAudit(tx, operation, row, due.id); await tx.insert(financeBillAdjustments).values(row);
      } else {
        const row = rawPayment(paid), input = { ...refund(21, 100), idempotencyKey: row.idempotencyKey, externalDocumentId: row.externalDocumentId! };
        row.input = input; row.requestChecksum = createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("payment-adjustment", paid.id, input)).digest("hex");
        await rawAudit(tx, operation, row, paid.id); await tx.insert(financePaymentAdjustments).values(row);
      }
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_checksum_invalid")); expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("rejects a forged raw %s execution balance while retaining a fully valid original request and audit", async operation => {
    const due = await f.bill(100), paid = await f.payment(100), before = await state();
    await expect(withTenant(database.db, context, async tx => {
      if (operation === "bill") { const row = rawBill(due); row.balanceAfter.netAmountMinor = 79; row.balanceAfter.outstandingMinor = 79;
        await rawAudit(tx, operation, row, due.id); await tx.insert(financeBillAdjustments).values(row); }
      else { const row = rawPayment(paid); row.balanceAfter.netAmountMinor = 79; row.balanceAfter.unallocatedMinor = 79;
        await rawAudit(tx, operation, row, paid.id); await tx.insert(financePaymentAdjustments).values(row); }
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_result_invalid")); expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("requires the actual %s adjustment and its success audit to commit in the same transaction", async operation => {
    const due = await f.bill(100), paid = await f.payment(100), before = await state(); let inserted = false;
    await expect(withTenant(database.db, context, async tx => {
      if (operation === "bill") await tx.insert(financeBillAdjustments).values(rawBill(due));
      else await tx.insert(financePaymentAdjustments).values(rawPayment(paid)); inserted = true;
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_atomic_audit_missing")); expect(inserted).toBe(true); expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("enforces capacity across both rows of one raw %s reduction INSERT", async operation => {
    const due = await f.bill(100), paid = await f.payment(100), before = await state();
    await expect(withTenant(database.db, context, async tx => {
      if (operation === "bill") {
        const a = rawBill(due, credit(60, 100)), b = rawBill(due, credit(60, 40));
        await rawAudit(tx, operation, a, due.id); await rawAudit(tx, operation, b, due.id); await tx.insert(financeBillAdjustments).values([a, b]);
      } else {
        const a = rawPayment(paid, refund(60, 100)), b = rawPayment(paid, refund(60, 40));
        await rawAudit(tx, operation, a, paid.id); await rawAudit(tx, operation, b, paid.id); await tx.insert(financePaymentAdjustments).values([a, b]);
      }
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_capacity_exceeded")); expect(await state()).toEqual(before);
  });
  it.each(["bill", "payment"] as const)("uses corrected %s net rather than the immutable original amount for a raw allocation", async operation => {
    const due = await f.bill(100), paid = await f.payment(100);
    if (operation === "bill") await adjustments.recordBillAdjustment(context, due.id, credit(40, 100));
    else await adjustments.recordPaymentAdjustment(context, paid.id, refund(40, 100));
    const input = { paymentId: paid.id, allocations: [{ billId: due.id, amountMinor: 80 }], idempotencyKey: adjustmentKey() }, id = createEntityId(), before = await state();
    await expect(withTenant(database.db, context, async tx => {
      await tx.insert(financePaymentAllocationBatches).values({ id, tenantId: context.tenantId, paymentId: paid.id, input,
        idempotencyKey: input.idempotencyKey, requestChecksum: createHash("sha256").update(canonicalFinancePayablesRequest("allocation", input)).digest("hex"), recordedBy: context.userId });
      await f.procurement.audit.recordInTransaction(tx, context, { action: "finance.payables.payment_allocated", resourceType: "finance_payment_allocation_batch",
        resourceId: id, result: "success", metadata: { paymentId: paid.id, allocationCount: 1 } });
      await tx.insert(financePaymentAllocations).values({ id: createEntityId(), tenantId: context.tenantId, batchId: id, paymentId: paid.id,
        billId: due.id, supplierId: due.supplierId, currency: due.currency, amountMinor: 80, recordedBy: context.userId });
    })).rejects.toSatisfy(sqlFailure("finance_payables_allocation_exceeds_evidence")); expect(await state()).toEqual(before);
  });
  it("rejects raw synchronization that changes the actual approved amount even with correct source IDs, checksum and audit", async () => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), record = await f.record(source, { amountMinor: 20 });
    const review = await f.review(source.invoice.id, record.id), due = await f.procurementBill(source), input = sync(record.id, review.id, 260);
    if (record.input.action !== "adjustment_record") throw new Error("Synthetic source record action changed");
    const document = record.input.document, before = await state();
    await expect(withTenant(database.db, context, async tx => {
      const row = { ...rawBill(due, credit(1, 260)), input, idempotencyKey: input.idempotencyKey, reasonCode: "PROCUREMENT_APPROVED",
        procurementAdjustmentId: record.id, procurementReviewId: review.id, externalDocumentId: document.number, evidenceReference: document.evidenceReference,
        occurredAt: new Date(document.issuedAt), requestChecksum: createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("bill-adjustment", due.id, input)).digest("hex") };
      await rawAudit(tx, "bill", row, due.id); await tx.insert(financeBillAdjustments).values(row);
    })).rejects.toSatisfy(sqlFailure("finance_payables_procurement_adjustment_binding_invalid")); expect(await state()).toEqual(before);
  });
  it("forces tenant RLS and denies updates or deletes of either actual correction history", async () => {
    const due = await f.bill(100), paid = await f.payment(100), a = await adjustments.recordBillAdjustment(context, due.id, credit(20, 100));
    const p = await adjustments.recordPaymentAdjustment(context, paid.id, refund(20, 100)), before = await state();
    for (const [table, id] of [["finance_bill_adjustments", a.id], ["finance_payment_adjustments", p.id]] as const) {
      const [policy] = await withTenant(database.db, context, tx => tx.execute<{ forced: boolean; enabled: boolean; owner: boolean; canUpdate: boolean; canDelete: boolean }>(sql`
        select relforcerowsecurity as forced,relrowsecurity as enabled,pg_get_userbyid(relowner)=current_user as owner,
        has_table_privilege(current_user,${table},'UPDATE') as "canUpdate",has_table_privilege(current_user,${table},'DELETE') as "canDelete"
        from pg_class where oid=${table}::regclass`));
      expect(policy).toEqual({ forced: true, enabled: true, owner: false, canUpdate: false, canDelete: false });
      for (const change of [sql`update ${sql.identifier(table)} set amount_minor=1 where id=${id}`, sql`delete from ${sql.identifier(table)} where id=${id}`])
        await expect(withTenant(database.db, context, tx => tx.execute(change))).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    }
    expect(await state()).toEqual(before);
  });
  it("rejects an actual refund dated before its original payment in the API and SQL while allowing correction of an erroneous future payment record", async () => {
    const paid = await f.payment(100), input = { ...refund(20, 100), occurredAt: "2026-07-01T00:00:00.000Z" }, before = await state();
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, input)).rejects.toMatchObject(conflict("finance_payables_adjustment_date_invalid"));
    await expect(withTenant(database.db, context, async tx => {
      const row = rawPayment(paid, input); await rawAudit(tx, "payment", row, paid.id); await tx.insert(financePaymentAdjustments).values(row);
    })).rejects.toSatisfy(sqlFailure("finance_payables_refund_date_invalid")); expect(await state()).toEqual(before);
    const erroneous = await f.payment(100, { paidAt: "2099-07-02T00:00:00.000Z" });
    await expect(adjustments.recordPaymentAdjustment(context, erroneous.id, voidInput(100))).resolves.toMatchObject({ kind: "void",
      balanceAfter: { amountMinor: 100, voidedMinor: 100, refundedMinor: 0, netAmountMinor: 0, lifecycle: "voided" } });
  });
  it.each(["missing", "wrong"] as const)("requires the actual procurement source and review IDs in the same-transaction financial success audit (%s)", async problem => {
    const source = await f.procurement.basis({ unitCostMinor: 1300 }), record = await f.record(source, { amountMinor: 20 });
    const review = await f.review(source.invoice.id, record.id), due = await f.procurementBill(source), input = sync(record.id, review.id, 260);
    if (record.input.action !== "adjustment_record") throw new Error("Synthetic approved source action changed");
    const document = record.input.document, before = await state(); let inserted = false;
    await expect(withTenant(database.db, context, async tx => {
      const row = { ...rawBill(due), input, idempotencyKey: input.idempotencyKey, reasonCode: "PROCUREMENT_APPROVED",
        procurementAdjustmentId: record.id, procurementReviewId: review.id, externalDocumentId: document.number, evidenceReference: document.evidenceReference,
        occurredAt: new Date(document.issuedAt), requestChecksum: createHash("sha256").update(canonicalFinancePayableAdjustmentRequest("bill-adjustment", due.id, input)).digest("hex") };
      await tx.insert(financeBillAdjustments).values(row); inserted = true;
      await f.procurement.audit.recordInTransaction(tx, context, { action: "finance.payables.bill_adjustment_recorded", resourceType: "finance_bill_adjustment",
        resourceId: row.id, result: "success", metadata: { billId: due.id, supplierId: row.supplierId, currency: row.currency,
          kind: row.kind, amountMinor: row.amountMinor,
          ...(problem === "wrong" ? { procurementAdjustmentId: createEntityId(), procurementReviewId: createEntityId() } : {}) } });
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_atomic_audit_missing")); expect(inserted).toBe(true); expect(await state()).toEqual(before);
    expect((await f.workspace()).procurementAdjustments.find(row => row.procurementAdjustmentId === record.id)?.mappedEventId).toBeNull();
    await expect(adjustments.recordBillAdjustment(context, due.id, input)).resolves.toMatchObject({ procurementAdjustmentId: record.id, procurementReviewId: review.id });
  });
  it("preserves legal C1 business-reference characters in both actual correction owners and the SQL ledger", async () => {
    const due = await f.bill(100), paid = await f.payment(100), reference = `SYNTHETIC\u0085\u009F-${adjustmentCode()}`;
    const actualCredit = await adjustments.recordBillAdjustment(context, due.id, { ...credit(20, 100), externalDocumentId: reference, evidenceReference: reference });
    const actualRefund = await adjustments.recordPaymentAdjustment(context, paid.id, { ...refund(20, 100), externalDocumentId: reference, evidenceReference: reference });
    expect(actualCredit).toMatchObject({ externalDocumentId: reference, evidenceReference: reference });
    expect(actualRefund).toMatchObject({ externalDocumentId: reference, evidenceReference: reference });
    const [storedBill] = await withTenant(database.db, context, tx => tx.select().from(financeBillAdjustments).where(eq(financeBillAdjustments.id, actualCredit.id)));
    const [storedPayment] = await withTenant(database.db, context, tx => tx.select().from(financePaymentAdjustments).where(eq(financePaymentAdjustments.id, actualRefund.id)));
    expect(storedBill!.externalDocumentId).toBe(reference); expect(storedPayment!.evidenceReference).toBe(reference);
  });
  it.each(["\u0001", "\u007f"])("rejects forbidden C0/DEL business evidence %# before saving while SQL independently rejects the same exact raw body", async control => {
    const due = await f.bill(100), paid = await f.payment(100), reference = `SYNTHETIC${control}REFERENCE`, before = await state();
    await expect(adjustments.recordBillAdjustment(context, due.id, { ...credit(20, 100), externalDocumentId: reference })).rejects.toMatchObject({ status: 400 });
    await expect(adjustments.recordPaymentAdjustment(context, paid.id, { ...refund(20, 100), evidenceReference: reference })).rejects.toMatchObject({ status: 400 });
    for (const operation of ["bill", "payment"] as const) await expect(withTenant(database.db, context, async tx => {
      if (operation === "bill") {
        const clean = rawBill(due), input = { ...credit(20, 100), idempotencyKey: clean.idempotencyKey, externalDocumentId: reference, evidenceReference: clean.evidenceReference };
        const row = { ...clean, externalDocumentId: reference, input,
          requestChecksum: sql`finance_payables_checksum('bill-adjustment',${due.id}::uuid,${JSON.stringify(input)}::jsonb)` };
        await rawAudit(tx, operation, clean, due.id); await tx.insert(financeBillAdjustments).values(row);
      } else {
        const clean = rawPayment(paid), input = { ...refund(20, 100), idempotencyKey: clean.idempotencyKey, externalDocumentId: clean.externalDocumentId!, evidenceReference: reference };
        const row = { ...clean, evidenceReference: reference, input,
          requestChecksum: sql`finance_payables_checksum('payment-adjustment',${paid.id}::uuid,${JSON.stringify(input)}::jsonb)` };
        await rawAudit(tx, operation, clean, paid.id); await tx.insert(financePaymentAdjustments).values(row);
      }
    })).rejects.toSatisfy(sqlFailure("finance_payables_adjustment_evidence_invalid"));
    expect(await state()).toEqual(before);
  });
});
