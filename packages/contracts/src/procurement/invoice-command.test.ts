import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { RecordProcurementInvoiceInputSchema } from "./procurement.js";
import { canonicalProcurementInvoiceRequest, ProcurementWriteKindSchema } from "./procurement-cycle.js";
import { canonicalProcurementCommandOriginal, PrepareProcurementCommandSchema, ProcurementCommandQuerySchema,
  ProcurementCommandScopeSchema, ProcurementCommandViewSchema, ProcurementCommandResultSchema, ProcurementCommandOperationSchema } from "./procurement-command.js";

const orderId = "019a0000-0000-7000-8000-000000000001", invoiceId = createEntityId(), at = "2026-10-20T01:02:03.000Z";
const original = { kind: "invoice_record" as const, targetId: orderId, input: {
  expectedVersion: 1, invoiceNumber: "INV-ORIGINAL", currency: "USD", issuedAt: at,
  lines: [{ lineKey: "B", invoicedQuantity: "0.1", unitCostMinor: 1200 },
    { lineKey: "A", invoicedQuantity: "0.000000001", unitCostMinor: 1, priceBasisQuantity: "0.000000001" }], idempotencyKey: "invoice-command-original",
} };

describe("durable invoice originals and unchanged 149 evidence identity", () => {
  it("adds an independent invoice operation without extending the six historical write kinds", () => {
    expect(ProcurementWriteKindSchema.options).toEqual(["requisition_create", "rfq_create", "quote_record", "purchase_create", "purchase_revise", "purchase_review"]);
    expect(ProcurementWriteKindSchema.safeParse("invoice_record").success).toBe(false);
    expect(ProcurementCommandOperationSchema.parse("invoice_record")).toBe("invoice_record");
    expect(ProcurementCommandOperationSchema.safeParse("supply_purchase_create").success).toBe(false);
  });

  it("requires the original purchase version and purchase-order target for a durable invoice", () => {
    expect(PrepareProcurementCommandSchema.parse(original)).toEqual(original);
    const { expectedVersion, ...legacyInput } = original.input;
    expect(expectedVersion).toBe(1);
    expect(RecordProcurementInvoiceInputSchema.parse(legacyInput)).not.toHaveProperty("expectedVersion");
    expect(PrepareProcurementCommandSchema.safeParse({ ...original, input: legacyInput }).success).toBe(false);
    expect(PrepareProcurementCommandSchema.safeParse({ ...original, targetId: null }).success).toBe(false);
    expect(ProcurementCommandScopeSchema.parse({ kind: "invoice_record", targetId: orderId })).toEqual({ kind: "invoice_record", targetId: orderId });
    expect(ProcurementCommandQuerySchema.parse({ kind: "invoice_record", targetId: orderId })).toEqual({ kind: "invoice_record", targetId: orderId });
  });

  it("retains the exact canonical 149 byte structure, including original invoice line order", () => {
    const expected = '{"input":{"currency":"USD","expectedVersion":1,"idempotencyKey":"invoice-command-original","invoiceNumber":"INV-ORIGINAL","issuedAt":"2026-10-20T01:02:03.000Z","lines":[{"invoicedQuantity":"0.1","lineKey":"B","unitCostMinor":1200},{"invoicedQuantity":"0.000000001","lineKey":"A","priceBasisQuantity":"0.000000001","unitCostMinor":1}]},"purchaseOrderId":"019a0000-0000-7000-8000-000000000001","version":1}';
    expect(canonicalProcurementInvoiceRequest(orderId, original.input)).toBe(expected);
    expect(canonicalProcurementCommandOriginal(PrepareProcurementCommandSchema.parse(original))).toBe(expected);
    expect(canonicalProcurementInvoiceRequest(orderId, { ...original.input, lines: [...original.input.lines].reverse() })).not.toBe(expected);
    expect(canonicalProcurementInvoiceRequest(orderId.toUpperCase(), { ...original.input, issuedAt: at.replace(".000Z", "Z") })).toBe(expected);
  });

  it("normalizes supported quantities before binding without adding omitted legacy price bases", () => {
    const parsed = PrepareProcurementCommandSchema.parse({ ...original, input: { ...original.input,
      lines: [{ ...original.input.lines[0]!, invoicedQuantity: "0.100000000" }, original.input.lines[1]!] } });
    if (parsed.kind !== "invoice_record") throw new Error("Unexpected invoice contract kind");
    expect(canonicalProcurementCommandOriginal(parsed)).toBe(canonicalProcurementCommandOriginal(PrepareProcurementCommandSchema.parse(original)));
    expect(parsed.input.lines[0]).not.toHaveProperty("priceBasisQuantity");
    const changed = PrepareProcurementCommandSchema.parse({ ...original, input: { ...original.input,
      lines: [{ ...original.input.lines[0]!, invoicedQuantity: "0.100000001" }, original.input.lines[1]!] } });
    expect(canonicalProcurementCommandOriginal(changed)).not.toBe(canonicalProcurementCommandOriginal(parsed));
  });

  it.each(["tenantId", "authoritySnapshot", "allocationStatus", "allocatedQuantity", "invoiceResultProofId", "result"])("rejects caller-selected %s evidence or authority", field => {
    expect(PrepareProcurementCommandSchema.safeParse({ ...original, [field]: "injected" }).success).toBe(false);
    expect(PrepareProcurementCommandSchema.safeParse({ ...original, input: { ...original.input, [field]: "injected" } }).success).toBe(false);
  });

  const invoice = { id: invoiceId, purchaseOrderId: orderId, invoiceNumber: original.input.invoiceNumber, currency: "USD", issuedAt: at, createdAt: at,
    totalMinor: 121, varianceMinor: 0, comparisonCurrency: "USD", status: "matched", allocationStatus: "complete",
    lines: [{ lineKey: "B", invoicedQuantity: "0.1", unit: "kilogram", unitCostMinor: 1200, priceBasisQuantity: 1, allocatedQuantity: "0.1", varianceMinor: 0 },
      { lineKey: "A", invoicedQuantity: "0.000000001", unit: "meter", unitCostMinor: 1, priceBasisQuantity: "0.000000001", allocatedQuantity: "0.000000001", varianceMinor: 0 }] };
  const prepared = { id: createEntityId(), kind: "invoice_record", targetId: orderId, targetLabel: "Synthetic original invoice", targetDetail: null,
    status: "prepared", createdAt: at, expiresAt: "2026-10-27T01:02:03.000Z", completedAt: null,
    contextAuthority: "synthetic-authority", acknowledged: false, canExecute: true, canCancel: true,
    original, result: null, invoiceResult: null, blockReason: null };
  function succeeded() { return { ...prepared, status: "succeeded", completedAt: at, canExecute: false, canCancel: false,
    result: { kind: "invoice_record", id: invoiceId, versionId: null, version: null }, invoiceResult: invoice }; }

  it("returns the actual immutable invoice with no invented invoice version", () => {
    expect(ProcurementCommandViewSchema.parse(prepared).original).toEqual(original);
    expect(ProcurementCommandViewSchema.parse(succeeded()).invoiceResult).toEqual(invoice);
    expect(ProcurementCommandResultSchema.safeParse({ kind: "invoice_record", id: invoiceId, versionId: createEntityId(), version: 1 }).success).toBe(false);
  });

  it("rejects an invoice receipt from a different invoice, purchase or operation", () => {
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded(), invoiceResult: { ...invoice, id: createEntityId() } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded(), invoiceResult: { ...invoice, purchaseOrderId: createEntityId() } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded(), result: { ...succeeded().result, kind: "purchase_create" } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...prepared, invoiceResult: invoice }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded(), invoiceResult: null }).success).toBe(false);
  });
});
