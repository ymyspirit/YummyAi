import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  PrepareProcurementCommandSchema, ProcurementCommandEmptyBodySchema,
  ProcurementCommandListSchema, ProcurementCommandQuerySchema,
  ProcurementCommandScopeSchema, ProcurementCommandViewSchema,
  canonicalProcurementCommandOriginal,
  type PrepareProcurementCommand, type ProcurementCommandView,
} from "./procurement-command.js";

const targetId = createEntityId(), stockItemId = createEntityId(), locationId = createEntityId(), supplierId = createEntityId();
const at = "2026-10-21T00:00:00.000Z";
const line = { lineKey: "COTTON-1", stockItemId, destinationLocationId: locationId, quantity: 20, unit: "each" as const };
const purchase = { code: "PO-QA", supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: at,
  lines: [{ ...line, unitCostMinor: 123 }], idempotencyKey: "synthetic-command-purchase" };
const originals: PrepareProcurementCommand[] = [
  { kind: "requisition_create", targetId: null, input: { code: "REQ-QA", reasonCode: "SYNTHETIC", lines: [line], idempotencyKey: "synthetic-command-requisition" } },
  { kind: "rfq_create", targetId, input: { expectedRequisitionVersion: 1, supplierIds: [supplierId], responseDueAt: at, idempotencyKey: "synthetic-command-rfq" } },
  { kind: "quote_record", targetId, input: { supplierId, currency: "USD", validUntil: at, lines: [{ lineKey: line.lineKey, unitCostMinor: 123, minimumOrderQuantity: 10, leadTimeDays: 2 }], idempotencyKey: "synthetic-command-quote" } },
  { kind: "purchase_create", targetId: null, input: purchase },
  { kind: "supply_purchase_create", targetId, input: { purpose: "custom_order", expectedVersion: 1, code: "SUPPLY-PO-QA", destinationLocationId: locationId,
    quantity: 20, expectedAt: at, idempotencyKey: "synthetic-command-supply" } },
  { kind: "purchase_revise", targetId, input: { expectedVersion: 1, currency: "USD", expectedAt: at, lines: purchase.lines, idempotencyKey: "synthetic-command-revise" } },
  { kind: "purchase_review", targetId, input: { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: "synthetic-command-review" } },
];

function prepared(original = originals[0]!): ProcurementCommandView {
  return { id: createEntityId(), kind: original.kind, targetId: original.targetId, targetLabel: "Synthetic original procurement",
    targetDetail: null, status: "prepared", createdAt: "2026-10-20T00:00:00.000Z", expiresAt: "2026-10-27T00:00:00.000Z", completedAt: null,
    contextAuthority: "synthetic-current-authority", acknowledged: false, canExecute: true, canCancel: true,
    original, result: null, blockReason: null };
}

describe("recoverable procurement command boundary", () => {
  it.each(originals.map(original => [original.kind, original] as const))("keeps the complete original for %s", (_kind, original) => {
    expect(PrepareProcurementCommandSchema.parse(original)).toEqual(original);
    expect(ProcurementCommandViewSchema.parse(prepared(original)).original).toEqual(original);
  });

  it("binds root creation and existing-object operations to different target scopes", () => {
    for (const original of originals) {
      const wrong = { ...original, targetId: original.targetId === null ? targetId : null };
      expect(PrepareProcurementCommandSchema.safeParse(wrong).success).toBe(false);
      expect(ProcurementCommandScopeSchema.safeParse({ kind: wrong.kind, targetId: wrong.targetId }).success).toBe(false);
    }
    expect(ProcurementCommandScopeSchema.parse({ kind: "rfq_create", targetId: targetId.toUpperCase() }).targetId).toBe(targetId);
  });

  it("rejects caller-selected tenants, authority, supplied results and expanded original bodies", () => {
    for (const original of originals) {
      for (const extra of [{ tenantId: createEntityId() }, { createdBy: createEntityId() }, { authoritySnapshot: { permissions: ["procurement:approve"] } }, { resultId: createEntityId() }])
        expect(PrepareProcurementCommandSchema.safeParse({ ...original, ...extra }).success).toBe(false);
      expect(PrepareProcurementCommandSchema.safeParse({ ...original, input: { ...original.input, supplierContactApproved: true } }).success).toBe(false);
    }
    for (const replacement of [purchase, { input: purchase }, { decision: "approved" }, { idempotencyKey: "new-replacement-key" }])
      expect(ProcurementCommandEmptyBodySchema.safeParse(replacement).success).toBe(false);
    expect(ProcurementCommandEmptyBodySchema.parse({})).toEqual({});
  });

  it("preserves whole purchase quantities and rejects duplicate lines or duplicate normalized suppliers", () => {
    expect(PrepareProcurementCommandSchema.safeParse({ ...originals[3], input: { ...purchase, lines: [{ ...purchase.lines[0]!, quantity: 0.5 }] } }).success).toBe(false);
    expect(PrepareProcurementCommandSchema.safeParse({ ...originals[3], input: { ...purchase, lines: [purchase.lines[0]!, purchase.lines[0]!] } }).success).toBe(false);
    const rfq = originals[1]!;
    expect(PrepareProcurementCommandSchema.safeParse({ ...rfq, input: { ...rfq.input, supplierIds: [supplierId, supplierId.toUpperCase()] } }).success).toBe(false);
  });

  it("treats reordered lines and suppliers as equivalent while retaining the original business values", () => {
    const original: PrepareProcurementCommand = { kind: "purchase_create", targetId: null,
      input: { ...purchase, lines: [...purchase.lines, { ...purchase.lines[0]!, lineKey: "COTTON-2", stockItemId: createEntityId() }] } };
    expect(canonicalProcurementCommandOriginal({ ...original, input: { ...original.input,
      expectedAt: original.input.expectedAt.replace("Z", "0Z"), lines: [...original.input.lines].reverse() } })).toBe(canonicalProcurementCommandOriginal(original));
    const secondSupplier = createEntityId(), rfq: Extract<PrepareProcurementCommand, { kind: "rfq_create" }> = { kind: "rfq_create", targetId,
      input: { expectedRequisitionVersion: 1, supplierIds: [supplierId, secondSupplier], responseDueAt: at, idempotencyKey: "synthetic-canonical-rfq" } };
    expect(canonicalProcurementCommandOriginal({ ...rfq, targetId: rfq.targetId.toUpperCase(), input: { ...rfq.input,
      supplierIds: [secondSupplier.toUpperCase(), supplierId.toUpperCase()] } })).toBe(canonicalProcurementCommandOriginal(rfq));
  });

  it("does not fold business code or original request-key case into another request identity", () => {
    const original: PrepareProcurementCommand = { kind: "purchase_create", targetId: null, input: purchase };
    expect(canonicalProcurementCommandOriginal({ ...original, input: { ...purchase, code: purchase.code.toLowerCase() } })).not.toBe(canonicalProcurementCommandOriginal(original));
    expect(canonicalProcurementCommandOriginal({ ...original, input: { ...purchase, idempotencyKey: purchase.idempotencyKey.toUpperCase() } })).not.toBe(canonicalProcurementCommandOriginal(original));
  });

  it("requires one actual result for success and forbids results on merely prepared or cancelled work", () => {
    const initial = prepared();
    const result = { kind: initial.kind, id: createEntityId(), versionId: createEntityId(), version: 1 };
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, result }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, status: "succeeded", completedAt: at, canExecute: false, canCancel: false }).success).toBe(false);
    const succeeded = { ...initial, status: "succeeded", completedAt: at, canExecute: false, canCancel: false, result };
    expect(ProcurementCommandViewSchema.parse(succeeded).result).toEqual(result);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded, status: "cancelled" }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded, result: { ...result, versionId: null } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...succeeded, result: { ...result, kind: "purchase_review" } }).success).toBe(false);
  });

  it("does not return an original belonging to a different operation or target", () => {
    const initial = prepared(originals[1]!);
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, original: { ...initial.original, targetId: createEntityId() } }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, original: originals[2] }).success).toBe(false);
  });

  it("does not enable execution after expiry, input loss, authority loss or acknowledgement", () => {
    const initial = prepared();
    for (const blockReason of ["expired", "input_unavailable", "permission_denied", "basis_changed"] as const) {
      expect(ProcurementCommandViewSchema.safeParse({ ...initial, blockReason }).success).toBe(false);
      expect(ProcurementCommandViewSchema.safeParse({ ...initial, blockReason, canExecute: false }).success).toBe(true);
    }
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, original: null }).success).toBe(false);
    expect(ProcurementCommandViewSchema.safeParse({ ...initial, acknowledged: true, original: null, canExecute: false }).success).toBe(false);
    const cancelled = { ...initial, status: "cancelled", completedAt: at, canExecute: false, canCancel: false, original: null, acknowledged: true };
    expect(ProcurementCommandViewSchema.safeParse(cancelled).success).toBe(true);
    expect(ProcurementCommandViewSchema.safeParse({ ...cancelled, original: initial.original }).success).toBe(false);
  });

  it("keeps recovery independent from workspace pages and limits each recovery response", () => {
    const items = Array.from({ length: 50 }, () => prepared());
    expect(ProcurementCommandListSchema.parse({ items, nextCursor: items[49]!.id, unavailableCount: 2, contextAuthority: "current" }).items).toHaveLength(50);
    expect(ProcurementCommandListSchema.safeParse({ items: [...items, prepared()], nextCursor: null, unavailableCount: 0, contextAuthority: "current" }).success).toBe(false);
    expect(ProcurementCommandListSchema.safeParse({ items: [], nextCursor: null, unavailableCount: -1, contextAuthority: "current" }).success).toBe(false);
    expect(ProcurementCommandQuerySchema.parse({ before: items[49]!.id })).toEqual({ before: items[49]!.id });
    expect(ProcurementCommandQuerySchema.safeParse({ kind: "purchase_create", targetId }).success).toBe(false);
    expect(ProcurementCommandQuerySchema.safeParse({ tenantId: createEntityId() }).success).toBe(false);
  });
});
