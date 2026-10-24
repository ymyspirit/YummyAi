import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { RecordProcurementInvoiceInput } from "./procurement.js";

export const ProcurementWriteKindSchema = z.enum([
  "requisition_create", "rfq_create", "quote_record",
  "purchase_create", "purchase_revise", "purchase_review",
]);
export type ProcurementWriteKind = z.infer<typeof ProcurementWriteKindSchema>;

function normalizeProcurementValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (["expectedAt", "responseDueAt", "validUntil"].includes(key)) return new Date(value).toISOString();
    if (key.endsWith("Id") || key === "supplierIds") return value.toLowerCase();
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(item => normalizeProcurementValue(item, key));
    if (key === "supplierIds") return items.sort();
    if (key === "lines") return items.sort((a, b) => String((a as { lineKey: string }).lineKey).localeCompare(String((b as { lineKey: string }).lineKey)));
    return items;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeProcurementValue(item, name)]));
  return value;
}

/** Version 1 identity is shared by the actual owner and private transport. */
export function canonicalProcurementWriteRequest(operation: ProcurementWriteKind, targetId: string | null, input: unknown) {
  return canonicalJson({ version: 1, operation, targetId: targetId?.toLowerCase() ?? null, input: normalizeProcurementValue(input) });
}

/** Preserve the actual 0149 invoice identity, including input line order. */
export function canonicalProcurementInvoiceRequest(purchaseOrderId: string, input: RecordProcurementInvoiceInput) {
  return canonicalJson({ version: 1, purchaseOrderId: purchaseOrderId.toLowerCase(),
    input: { ...input, issuedAt: new Date(input.issuedAt).toISOString() } });
}
