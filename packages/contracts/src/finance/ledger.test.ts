import { describe, expect, it } from "vitest";
import { FinanceLedgerDetailInputSchema, FinanceLedgerDetailViewSchema, FinanceLedgerKindSchema,
  FinanceLedgerListInputSchema, FinanceLedgerPageViewSchema, FinanceLedgerSummarySchema,
  financeLedgerDetailParentId, readFinanceLedgerCursorPosition } from "./ledger.js";

const id = (value: number) => `019f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const at = "2026-07-02T00:00:00.000Z", parent = id(1), supplier = id(2);
const summary = (value = 5) => ({ kind: "bills", id: id(value), reference: `SYNTHETIC-${value}`, recordedAt: at,
  amountMinor: 100, currency: "USD", netAmountMinor: 80, status: "unallocated", supplierId: supplier, parentId: supplier });
const page = () => ({ kind: "bills", parentId: supplier, limit: 2, order: "id_desc", consistency: "live", upperBoundId: id(5),
  items: [summary(5), summary(4)], hasMore: true, nextCursor: "Y3Vyc29y" });
const bill = () => ({ id: id(5), supplierId: supplier, kind: "factory_invoice", externalBillId: "SYNTHETIC-LEDGER-BILL", currency: "USD",
  amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80, lifecycle: "active", issuedAt: at,
  dueAt: null, procurementInvoiceId: null, procurementProofId: null, sourceStatus: "current", allocatedMinor: 0,
  outstandingMinor: 80, status: "unallocated", recordedAt: at });
const statement = () => ({ id: parent, accountId: null, provider: "manual", statementKind: "operational_cost",
  sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-LEDGER" }, externalStatementId: "SYNTHETIC-STATEMENT",
  periodStart: at, periodEnd: at, sourceCurrency: "USD", observedAt: at, recordedAt: at, checksum: "a".repeat(64) });
const fact = () => ({ id: id(3), statementId: parent, accountId: null, lineKey: "LINE-1", sourceEntryId: "synthetic:actual:1",
  factType: "production_cost", direction: "debit", amountMinor: 100, currency: "USD", occurredAt: at, recordedAt: at,
  externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
  correctionKind: "original", correctsFactId: null });

describe("complete finance ledger transport keeps query scope and original detail boundaries", () => {
  it("enumerates all fifteen actual record kinds without inventing a balance or publication kind", () => {
    expect(FinanceLedgerKindSchema.options).toEqual(["statements", "facts", "fx_rates", "metrics", "metric_versions", "profit_runs", "contributions",
      "bills", "payments", "allocation_batches", "allocations", "releases", "bill_adjustments", "payment_adjustments", "procurement_adjustments"]);
    expect(FinanceLedgerKindSchema.safeParse("bank_transfers").success).toBe(false);
  });
  it("normalizes UUID case and canonical decimal page sizes with a bounded default", () => {
    expect(FinanceLedgerListInputSchema.parse({ kind: "facts", parentId: parent.toUpperCase() })).toEqual({ kind: "facts", parentId: parent, limit: 25 });
    expect(FinanceLedgerListInputSchema.parse({ kind: "bills", limit: "100" }).limit).toBe(100);
    expect(FinanceLedgerDetailInputSchema.parse({ kind: "facts", id: id(3).toUpperCase(), parentId: parent.toUpperCase() }).id).toBe(id(3));
  });
  it.each([0, 101, 1.5, "01", "+1", "1.0", " 1", "1e1", null])("rejects invalid page size %s", limit => {
    expect(FinanceLedgerListInputSchema.safeParse({ kind: "bills", limit }).success).toBe(false);
  });
  it("rejects unsupported parent filters, absent procurement parents and caller-selected authority", () => {
    for (const kind of ["statements", "fx_rates", "metrics"]) {
      expect(FinanceLedgerListInputSchema.safeParse({ kind, parentId: parent }).success).toBe(false);
      expect(FinanceLedgerDetailInputSchema.safeParse({ kind, id: id(3), parentId: parent }).success).toBe(false);
    }
    expect(FinanceLedgerListInputSchema.safeParse({ kind: "procurement_adjustments" }).success).toBe(false);
    expect(FinanceLedgerDetailInputSchema.safeParse({ kind: "procurement_adjustments", id: id(3) }).success).toBe(false);
    for (const extra of [{ tenantId: parent }, { userId: parent }, { order: "recorded_at_desc" }, { offset: 500 }, { verified: true }])
      expect(FinanceLedgerListInputSchema.safeParse({ kind: "bills", ...extra }).success).toBe(false);
  });
  it("accepts a cursor only as bounded URL-safe transport rather than a caller's authorization", () => {
    expect(FinanceLedgerListInputSchema.safeParse({ kind: "bills", cursor: "YQ_0-" }).success).toBe(true);
    for (const cursor of ["", "YQ==", "a/b", "a+b", "a".repeat(1025)])
      expect(FinanceLedgerListInputSchema.safeParse({ kind: "bills", cursor }).success).toBe(false);
  });
  it("reads a canonical cursor position without treating its plain scope digest as an authorization capability", () => {
    const value = { v: 1 as const, scope: "a".repeat(64), upperId: id(9), id: id(5) };
    const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    expect(readFinanceLedgerCursorPosition(encoded)).toEqual(value);
    const anotherPosition = { ...value, scope: "b".repeat(64), id: id(4) };
    expect(readFinanceLedgerCursorPosition(Buffer.from(JSON.stringify(anotherPosition)).toString("base64url"))).toEqual(anotherPosition);
    // Only the authenticated owner can validate these public positions and scope
    // against an actual tenant, operator, parent, page size and stored anchors.
  });
  it("rejects cursor whitespace, reordered keys and duplicate JSON properties rather than normalizing an ambiguous position", () => {
    const value = { v: 1, scope: "a".repeat(64), upperId: id(9), id: id(5) }, raw = JSON.stringify(value);
    for (const input of [JSON.stringify(value, null, 1), JSON.stringify({ scope: value.scope, v: 1, upperId: value.upperId, id: value.id }),
      `${raw.slice(0, -1)},"id":"${value.id}"}`, `${raw}\n`])
      expect(readFinanceLedgerCursorPosition(Buffer.from(input).toString("base64url"))).toBeNull();
  });
  it("rejects malformed cursor envelopes, invalid base64, non-UUID positions and inverted ID bounds", () => {
    const value = { v: 1, scope: "a".repeat(64), upperId: id(9), id: id(5) }, encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of ["", `${encoded}=`, "not_json", Buffer.from([255]).toString("base64url"),
      ...[null, [], { ...value, v: 2 }, { ...value, scope: "A".repeat(64) }, { ...value, scope: "a" }, { ...value, id: "missing" },
        { ...value, id: id(10) }, { ...value, id: value.id.toUpperCase() }, { ...value, other: true }].map(input => Buffer.from(JSON.stringify(input)).toString("base64url"))])
      expect(readFinanceLedgerCursorPosition(cursor)).toBeNull();
  });
  it("requires strict descending IDs despite equal timestamps and preserves exact safe minor amounts", () => {
    expect(FinanceLedgerPageViewSchema.safeParse(page()).success).toBe(true);
    expect(FinanceLedgerSummarySchema.parse({ ...summary(), amountMinor: Number.MAX_SAFE_INTEGER, netAmountMinor: Number.MAX_SAFE_INTEGER }).amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    for (const items of [[summary(4), summary(5)], [summary(5), summary(5)]])
      expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), items }).success).toBe(false);
  });
  it("makes continuation, page size and the upper ID bound agree", () => {
    for (const changed of [{ hasMore: false }, { nextCursor: null }, { items: [summary(5)] }, { limit: 1 }, { upperBoundId: id(4) }, { upperBoundId: null }])
      expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), ...changed }).success).toBe(false);
    expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), items: [], hasMore: false, nextCursor: null, upperBoundId: null }).success).toBe(true);
    expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), items: [summary(4)], hasMore: false, nextCursor: null }).success).toBe(true);
  });
  it("binds every summary to its collection and selected parent and requires a currency for money", () => {
    expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), items: [{ ...summary(), kind: "payments" }, summary(4)] }).success).toBe(false);
    expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), items: [{ ...summary(), parentId: id(9) }, summary(4)] }).success).toBe(false);
    expect(FinanceLedgerSummarySchema.safeParse({ ...summary(), currency: null }).success).toBe(false);
    expect(FinanceLedgerSummarySchema.safeParse({ ...summary(), amountMinor: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(FinanceLedgerPageViewSchema.safeParse({ ...page(), consistency: "snapshot" }).success).toBe(false);
  });
  it("withholds profit status and totals from list summaries instead of implying verified profit", () => {
    const row = { ...summary(), kind: "profit_runs", amountMinor: null, netAmountMinor: null, status: null, supplierId: null, parentId: parent };
    expect(FinanceLedgerSummarySchema.safeParse(row).success).toBe(true);
    for (const changed of [{ amountMinor: 100 }, { netAmountMinor: 80 }, { status: "complete" }])
      expect(FinanceLedgerSummarySchema.safeParse({ ...row, ...changed }).success).toBe(false);
  });
  it("returns only the original statement header and separately declares its actual facts relation", () => {
    const value = { kind: "statements", id: parent, record: statement(), children: [{ kind: "facts", parentId: parent }] };
    expect(FinanceLedgerDetailViewSchema.safeParse(value).success).toBe(true);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, record: { ...statement(), lines: [fact()] } }).success).toBe(false);
    for (const children of [[], [{ kind: "facts", parentId: id(9) }], [{ kind: "facts", parentId: parent }, { kind: "facts", parentId: parent }], [{ kind: "contributions", parentId: parent }]])
      expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, children }).success).toBe(false);
  });
  it("requires full bill balance conservation while exposing only the real applicable child collections", () => {
    const value = { kind: "bills", id: id(5), record: bill(), children: [{ kind: "allocations", parentId: id(5) }, { kind: "bill_adjustments", parentId: id(5) }] };
    expect(FinanceLedgerDetailViewSchema.safeParse(value).success).toBe(true);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, record: { ...bill(), netAmountMinor: 100 } }).success).toBe(false);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, children: [...value.children, { kind: "procurement_adjustments", parentId: id(5) }] }).success).toBe(false);
    const procurement = { ...bill(), kind: "procurement_invoice", procurementInvoiceId: id(8), procurementProofId: id(9) };
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, record: procurement }).success).toBe(false);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, record: procurement, children: [...value.children, { kind: "procurement_adjustments", parentId: id(5) }] }).success).toBe(true);
  });
  it("binds detail identity and child filters to the original record instead of a requested replacement parent", () => {
    const detail = FinanceLedgerDetailViewSchema.parse({ kind: "facts", id: id(3), record: fact(), children: [] });
    expect(financeLedgerDetailParentId(detail)).toBe(parent);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...detail, id: id(4) }).success).toBe(false);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...detail, children: [{ kind: "facts", parentId: id(3) }] }).success).toBe(false);
  });
  it("retains unsupported actual procurement source IDs as a diagnostic rather than manufacturing a selectable adjustment", () => {
    const value = { kind: "procurement_adjustments", id: id(7), billCurrency: "USD", record: { billId: id(5), procurementAdjustmentId: id(7),
      procurementReviewId: id(8), code: "source_format_not_supported" }, children: [] };
    const detail = FinanceLedgerDetailViewSchema.parse(value); expect(financeLedgerDetailParentId(detail)).toBe(id(5));
    const { billCurrency: omittedCurrency, ...withoutBillCurrency } = value; void omittedCurrency;
    expect(FinanceLedgerDetailViewSchema.safeParse(withoutBillCurrency).success).toBe(false);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, id: id(8) }).success).toBe(false);
    expect(FinanceLedgerDetailViewSchema.safeParse({ ...value, record: { ...value.record, amountMinor: 0 } }).success).toBe(false);
  });
});
