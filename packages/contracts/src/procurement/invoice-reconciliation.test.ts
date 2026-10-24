import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { canonicalJson } from "../common/canonical-json.js";
import { InvoiceReconciliationInputSchema, InvoiceReconciliationEventSchema, InvoiceReconciliationDetailSchema, InvoiceReconciliationBalanceSchema,
  canonicalInvoiceReconciliationRequest } from "./invoice-reconciliation.js";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema, ProcurementCommandResultSchema,
  ProcurementCommandOperationSchema, canonicalProcurementCommandOriginal } from "./procurement-command.js";
import { ProcurementWriteKindSchema } from "./procurement-cycle.js";

const invoiceId = createEntityId(), lineId = createEntityId(), receiptId = createEntityId(), at = "2026-10-20T01:02:03.000Z";
const fingerprint = "a".repeat(64);
const record = () => ({ action: "adjustment_record" as const, expectedFingerprint: fingerprint, idempotencyKey: "synthetic-invoice-reconciliation",
  reason: "Supplier issued a specific original price correction", document: { kind: "credit_note" as const, number: "CN-ORIGINAL", issuedAt: at,
    currency: "USD", evidenceReference: "Synthetic supplier document CN-ORIGINAL; authenticity not externally verified" },
  lines: [{ invoiceLineId: lineId, quantity: "0.1", unit: "kilogram" as const, amountMinor: 120 }] });
const balance = () => ({ status: "matched" as const, currency: "USD", comparisonCurrency: "USD", unknownReasons: [], netAmountMinor: 120, varianceMinor: 0,
  lines: [{ invoiceLineId: lineId, lineKey: "LINE-1", unit: "kilogram", originalQuantity: "0.2", creditedQuantity: "0.1", netQuantity: "0.1",
    allocatedQuantity: "0.1", unallocatedQuantity: 0, originalAmountMinor: 240, creditAmountMinor: 120, debitAmountMinor: 0, netAmountMinor: 120,
    expectedAmountMinor: 120, varianceMinor: 0 }] });
const event = () => ({ id: createEntityId(), invoiceId, purchaseOrderId: createEntityId(), purchaseOrderVersionId: createEntityId(), originalProofId: createEntityId(),
  sequence: 1, previousId: null, adjustmentId: null, action: "adjustment_record", input: record(), createdBy: createEntityId(), createdAt: at, balance: balance() });

describe("invoice correction originals preserve evidence, quantities and unknown amounts", () => {
  it("adds one invoice-targeted command without changing the six historical owner operation kinds", () => {
    const original = { kind: "invoice_reconcile", targetId: invoiceId, input: record() };
    expect(PrepareProcurementCommandSchema.parse(original)).toEqual(original);
    expect(ProcurementCommandOperationSchema.parse("invoice_reconcile")).toBe("invoice_reconcile");
    expect(ProcurementWriteKindSchema.options).toEqual(["requisition_create", "rfq_create", "quote_record", "purchase_create", "purchase_revise", "purchase_review"]);
    expect(PrepareProcurementCommandSchema.safeParse({ ...original, targetId: null }).success).toBe(false);
  });
  it("normalizes nine-place quantities before binding the unchanged invoice target and supplier document", () => {
    const parsed = InvoiceReconciliationInputSchema.parse({ ...record(), lines: [{ ...record().lines[0]!, quantity: "0.100000000" }] });
    expect(parsed).toEqual(record());
    expect(canonicalProcurementCommandOriginal(PrepareProcurementCommandSchema.parse({ kind: "invoice_reconcile", targetId: invoiceId, input: parsed })))
      .toEqual(canonicalInvoiceReconciliationRequest(invoiceId, record()));
    const changed = InvoiceReconciliationInputSchema.parse({ ...record(), lines: [{ ...record().lines[0]!, quantity: "0.100000001" }] });
    expect(canonicalJson(canonicalInvoiceReconciliationRequest(invoiceId, changed))).not.toBe(canonicalJson(canonicalInvoiceReconciliationRequest(invoiceId, parsed)));
  });
  it("binds normalized document dates and the original invoice identity without sorting original lines", () => {
    const source = record(), second = { ...source.lines[0]!, invoiceLineId: createEntityId() };
    const original = { ...source, lines: [...source.lines, second] };
    expect(canonicalInvoiceReconciliationRequest(invoiceId.toUpperCase(), { ...original, document: { ...source.document, issuedAt: at.replace(".000Z", "Z") } }))
      .toEqual(canonicalInvoiceReconciliationRequest(invoiceId, original));
    expect(canonicalJson(canonicalInvoiceReconciliationRequest(invoiceId, { ...original, lines: [...original.lines].reverse() })))
      .not.toBe(canonicalJson(canonicalInvoiceReconciliationRequest(invoiceId, original)));
  });
  it("accepts amount-only debit evidence and rejects a debit that consumes receipt quantity", () => {
    const debit = { ...record(), document: { ...record().document, kind: "debit_note" }, lines: [{ ...record().lines[0]!, quantity: 0, amountMinor: 20 }] };
    expect(InvoiceReconciliationInputSchema.parse(debit)).toEqual(debit);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...debit, lines: [{ ...debit.lines[0]!, quantity: "0.1" }] }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...debit, lines: [{ ...debit.lines[0]!, amountMinor: 0 }] }).success).toBe(false);
  });
  it.each([0.1, "0.0000000001", "1e-3", "-0.1", "2147483647.000000001"])("rejects an unsafe adjustment quantity %s", quantity => {
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), lines: [{ ...record().lines[0]!, quantity }] }).success).toBe(false);
  });
  it("keeps count-unit whole constraints and actual zero-quantity money corrections distinct", () => {
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), lines: [{ ...record().lines[0]!, quantity: "0.1", unit: "each" }] }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.parse({ ...record(), lines: [{ ...record().lines[0]!, quantity: "001.000", unit: "each" }] })).toMatchObject({ lines: [{ quantity: 1 }] });
    expect(InvoiceReconciliationInputSchema.parse({ ...record(), lines: [{ ...record().lines[0]!, quantity: 0, amountMinor: 20 }] })).toMatchObject({ lines: [{ quantity: 0, amountMinor: 20 }] });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects a non-minor or unsafe adjustment amount %s", amountMinor => {
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), lines: [{ ...record().lines[0]!, amountMinor }] }).success).toBe(false);
  });
  it.each(["tenantId", "createdBy", "approved", "status", "balance", "sourceAllocationId", "releaseQuantity"])("rejects caller-forged %s", field => {
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), [field]: "injected" }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), lines: [{ ...record().lines[0]!, [field]: "injected" }] }).success).toBe(false);
  });
  it("requires a precise current fingerprint and actual document reference", () => {
    for (const expectedFingerprint of ["", "a".repeat(63), "A".repeat(64)])
      expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), expectedFingerprint }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), document: { ...record().document, evidenceReference: " " } }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...record(), lines: [...record().lines, ...record().lines] }).success).toBe(false);
  });
  it("requires a real receipt, original line and positive quantity for later matching", () => {
    const match = { action: "receipt_match", expectedFingerprint: fingerprint, reason: "Actual later accepted receipt", idempotencyKey: "synthetic-match-original",
      lines: [{ invoiceLineId: lineId, receiptLineId: receiptId, quantity: "0.05", unit: "kilogram" }] };
    expect(InvoiceReconciliationInputSchema.parse(match)).toEqual(match);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...match, lines: [{ ...match.lines[0]!, quantity: 0 }] }).success).toBe(false);
    expect(InvoiceReconciliationInputSchema.safeParse({ ...match, lines: [...match.lines, ...match.lines] }).success).toBe(false);
  });
  it("retains unknown differences as null independently from known zero", () => {
    const unknown = { ...balance(), status: "unknown", currency: "EUR", unknownReasons: ["currency_mismatch"], varianceMinor: null,
      lines: balance().lines.map(line => ({ ...line, expectedAmountMinor: null, varianceMinor: null })) };
    expect(InvoiceReconciliationEventSchema.parse({ ...event(), balance: unknown }).balance.varianceMinor).toBeNull();
    expect(InvoiceReconciliationEventSchema.parse(event()).balance.varianceMinor).toBe(0);
  });
  it("binds review facts to their original adjustment and records no invented event version", () => {
    const adjustmentId = createEntityId(), review = { ...event(), action: "adjustment_review", adjustmentId,
      input: { action: "adjustment_review", adjustmentId, decision: "approved", expectedFingerprint: fingerprint, reason: "Actual evidence checked", idempotencyKey: "synthetic-review-original" } };
    expect(InvoiceReconciliationEventSchema.parse(review).adjustmentId).toBe(adjustmentId);
    expect(InvoiceReconciliationEventSchema.safeParse({ ...review, adjustmentId: createEntityId() }).success).toBe(false);
    expect(ProcurementCommandResultSchema.safeParse({ kind: "invoice_reconcile", id: review.id, versionId: createEntityId(), version: 1 }).success).toBe(false);
  });
  it("requires the exact actual reconciliation result after execution and after input clearance", () => {
    const actual = event(), view = { id: createEntityId(), kind: "invoice_reconcile", targetId: invoiceId, targetLabel: "Synthetic invoice", targetDetail: null,
      status: "succeeded", createdAt: at, expiresAt: "2026-10-27T01:02:03.000Z", completedAt: at, contextAuthority: "synthetic-authority",
      acknowledged: false, canExecute: false, canCancel: false, original: { kind: "invoice_reconcile", targetId: invoiceId, input: actual.input },
      result: { kind: "invoice_reconcile", id: actual.id, versionId: null, version: null }, reconciliationResult: actual, blockReason: null };
    expect(ProcurementCommandViewSchema.parse(view).reconciliationResult).toEqual(actual);
    expect(ProcurementCommandViewSchema.parse({ ...view, acknowledged: true, original: null }).reconciliationResult).toEqual(actual);
    expect(ProcurementCommandViewSchema.safeParse({ ...view, reconciliationResult: null }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...view, reconciliationResult: { ...actual, invoiceId: createEntityId() } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...view, result: { ...view.result, id: createEntityId() } }).success).toBe(false);
  });
  it("keeps supplier identity, safe original status and unknown legacy proof explicit in detail", () => {
    const detail = { invoiceId, invoiceNumber: "INV-LEGACY", originalStatus: "reconciliation_required", purchaseOrderId: createEntityId(), purchaseOrderCode: "PO-LEGACY",
      purchaseOrderVersionId: null, supplierId: createEntityId(), originalProofId: null, fingerprint, canRecord: false, canApprove: false, blockReason: "legacy_basis_missing",
      balance: { ...balance(), status: "unknown", comparisonCurrency: null, varianceMinor: null, unknownReasons: ["legacy_basis_missing"],
        lines: balance().lines.map(line => ({ ...line, allocatedQuantity: null, unallocatedQuantity: null, expectedAmountMinor: null, varianceMinor: null })) },
      adjustments: [], events: [], receipts: [] };
    expect(InvoiceReconciliationDetailSchema.parse(detail)).toEqual(detail);
  });
  it("rejects forged reconciliation balances with unmatched quantities or currency", () => {
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), lines: balance().lines.map(line => ({ ...line, allocatedQuantity: 0, unallocatedQuantity: "0.1" })) }).success).toBe(false);
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), currency: "EUR" }).success).toBe(false);
  });
  it("rejects forged reconciliation balances whose credited and net quantities differ from the original", () => {
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), lines: balance().lines.map(line => ({ ...line, netQuantity: "0.2", allocatedQuantity: "0.2" })) }).success).toBe(false);
  });
  it("rejects forged reconciliation balances whose amount is not original plus debit minus credit", () => {
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), netAmountMinor: 121, varianceMinor: 1,
      lines: balance().lines.map(line => ({ ...line, netAmountMinor: 121, varianceMinor: 1 })) }).success).toBe(false);
  });
  it("rejects forged reconciliation balances whose header disagrees with actual lines", () => {
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), netAmountMinor: 121 }).success).toBe(false);
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), varianceMinor: 1 }).success).toBe(false);
  });
  it("rejects forged reconciliation balances marked fully credited while still occupying a receipt", () => {
    expect(InvoiceReconciliationBalanceSchema.safeParse({ ...balance(), status: "fully_credited", netAmountMinor: 0,
      lines: balance().lines.map(line => ({ ...line, creditedQuantity: "0.2", netQuantity: 0, creditAmountMinor: 240, netAmountMinor: 0,
        allocatedQuantity: "0.1", expectedAmountMinor: 0 })) }).success).toBe(false);
  });
});
