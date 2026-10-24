import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  canonicalFinanceCommandOriginal, FINANCE_COMMAND_CONTRACT, FINANCE_COMMAND_MAX_CIPHERTEXT_BYTES,
  FINANCE_COMMAND_MAX_PLAINTEXT_BYTES, FinanceCommandDetailSchema, FinanceCommandEmptyBodySchema,
  FinanceCommandKindSchema, FinanceCommandListSchema, FinanceCommandOriginalSchema, FinanceCommandQuerySchema,
  FinanceCommandResultSchema, FinanceCommandSummarySchema, PrepareFinanceCommandSchema,
  type FinanceCommandDetail, type PrepareFinanceCommand,
} from "./finance-command.js";

const metricId = createEntityId(), paymentId = createEntityId(), billId = createEntityId(), baseRunId = createEntityId();
const supplierId = createEntityId(), factId = createEntityId(), statementId = createEntityId();
const at = "2026-07-15T00:00:00.000Z", hash = "a".repeat(64), key = "synthetic-finance-command-original";
const statement = { sourceIdentity: { schemaVersion: 2 as const, kind: "named_source" as const, sourceName: "SYNTHETIC-COMMAND" },
  accountId: null, provider: "manual" as const, statementKind: "operational_cost" as const, externalStatementId: "SYNTHETIC-REPORT",
  periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", sourceCurrency: "USD", observedAt: at,
  idempotencyKey: key, lines: [{ lineKey: "fee", sourceEntryId: "synthetic-external-fee-1", factType: "production_cost" as const,
    direction: "debit" as const, amountMinor: 29, currency: "USD", occurredAt: at, externalReference: null,
    orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original" as const, correctsFactId: null }] };
const originals: PrepareFinanceCommand[] = [
  { kind: "statement_record", targetId: null, input: statement },
  { kind: "fx_rate_record", targetId: null, input: { source: "SYNTHETIC.CMD", baseCurrency: "JPY", quoteCurrency: "USD",
    rateNumerator: 1, rateDenominator: 150, effectiveAt: at, retrievedAt: at, rateUnit: "major_to_major", idempotencyKey: key } },
  { kind: "metric_upsert", targetId: null, input: { metricId: null, name: "Synthetic immutable metric", reportingCurrency: "USD",
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
    reasonCode: "SYNTHETIC", idempotencyKey: key } },
  { kind: "profit_calculate", targetId: metricId, input: { metricId, expectedMetricVersion: 1, statementIds: [statementId], fxRateIds: [],
    coverageDimension: "aggregate", idempotencyKey: key } },
  { kind: "bill_record", targetId: null, input: { supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-BILL", currency: "USD",
    amountMinor: 100, issuedAt: at, dueAt: null, procurementInvoiceId: null, idempotencyKey: key } },
  { kind: "payment_record", targetId: null, input: { supplierId, externalPaymentId: "SYNTHETIC-PAY", currency: "USD", amountMinor: 100,
    paidAt: at, method: "bank_transfer", evidenceReference: "SYNTHETIC-EVIDENCE", idempotencyKey: key } },
  { kind: "payment_allocate", targetId: paymentId, input: { paymentId, allocations: [{ billId, amountMinor: 29 }], idempotencyKey: key } },
  { kind: "allocation_release", targetId: createEntityId(), input: { reasonCode: "SOURCE_CHANGED", idempotencyKey: key } },
  { kind: "bill_adjustment_record", targetId: billId, input: { kind: "credit", expectedNetAmountMinor: 100, amountMinor: 29,
    externalDocumentId: "SYNTHETIC-CREDIT", evidenceReference: "SYNTHETIC-EVIDENCE", occurredAt: at, reasonCode: "SYNTHETIC", idempotencyKey: key } },
  { kind: "payment_adjustment_record", targetId: paymentId, input: { kind: "refund", expectedNetAmountMinor: 100, amountMinor: 29,
    externalDocumentId: "SYNTHETIC-REFUND", evidenceReference: "SYNTHETIC-EVIDENCE", occurredAt: at, reasonCode: "SYNTHETIC", idempotencyKey: key } },
  { kind: "cost_version_approve", targetId: null, input: { baseRunId, baseInputChecksum: hash, allocationId: null, expectedVersion: null,
    dimension: "period", method: "equal", sources: [{ rootFactId: factId, targets: [{ key: "2026-07", weight: "1" }] }],
    reasonCode: "SYNTHETIC", basisDescription: "Explicit synthetic period assignment", previewChecksum: hash, idempotencyKey: key } },
  { kind: "allocated_profit_calculate", targetId: baseRunId, input: { baseRunId, baseInputChecksum: hash, dimension: "period",
    versionIds: [createEntityId()], idempotencyKey: key } },
];
function prepared(): FinanceCommandDetail {
  return { id: createEntityId(), kind: "statement_record", targetId: null, status: "prepared", requestKey: key,
    createdAt: at, expiresAt: "2026-07-22T00:00:00.000Z", completedAt: null, acknowledged: false, originalRetained: true,
    result: null, contextAuthority: "synthetic-finance-authority", canExecute: true, canCancel: true, canAcknowledge: false, blockReason: null };
}
function summary(value = prepared()) {
  const { canExecute, canCancel, canAcknowledge, blockReason, ...small } = value;
  void canExecute; void canCancel; void canAcknowledge; void blockReason;
  return small;
}

describe("durable original finance submission contract", () => {
  it.each(originals.map(original => [original.kind, original] as const))("retains the actual owner input for %s without translating money or pinned versions", (_kind, original) => {
    expect(PrepareFinanceCommandSchema.parse(original)).toEqual(original);
    expect(FinanceCommandOriginalSchema.parse({ id: createEntityId(), original, blockReason: null, contextAuthority: "synthetic-finance-authority" }).original).toEqual(original);
  });
  it("covers exactly twelve actual owner kinds and no read, transfer or implicit approval operation", () => {
    expect(new Set(originals.map(original => original.kind))).toEqual(new Set(FinanceCommandKindSchema.options));
    for (const kind of ["preview", "workspace", "bank_transfer", "publish", "invoice_record"])
      expect(FinanceCommandKindSchema.safeParse(kind).success).toBe(false);
  });
  it("rejects a different envelope target for every owner input that already pins a target", () => {
    for (const original of originals.filter(row => ["metric_upsert", "profit_calculate", "payment_allocate", "cost_version_approve", "allocated_profit_calculate"].includes(row.kind)))
      expect(PrepareFinanceCommandSchema.safeParse({ ...original, targetId: createEntityId() }).success).toBe(false);
    const update = { ...originals[2]!, targetId: metricId, input: { ...originals[2]!.input, metricId, expectedVersion: 1 } };
    expect(PrepareFinanceCommandSchema.safeParse(update).success).toBe(true);
  });
  it("rejects caller authority, selected tenant, forged result and extra owner input", () => {
    for (const original of originals) {
      for (const extra of [{ tenantId: createEntityId() }, { createdBy: createEntityId() }, { authoritySnapshot: {} }, { resultId: createEntityId() }])
        expect(PrepareFinanceCommandSchema.safeParse({ ...original, ...extra }).success).toBe(false);
      expect(PrepareFinanceCommandSchema.safeParse({ ...original, input: { ...original.input, executeAutomatically: true } }).success).toBe(false);
    }
  });
  it("preserves optional owner semantics instead of silently adding FX units or aggregate coverage", () => {
    const rate = originals[1]!, run = originals[3]!;
    if (rate.kind !== "fx_rate_record" || run.kind !== "profit_calculate") throw new Error("Synthetic kinds differ");
    const { rateUnit, ...oldRate } = rate.input; const { coverageDimension, ...oldRun } = run.input; void rateUnit; void coverageDimension;
    const parsedRate = PrepareFinanceCommandSchema.parse({ ...rate, input: oldRate });
    const parsedRun = PrepareFinanceCommandSchema.parse({ ...run, input: oldRun });
    expect(parsedRate.input).not.toHaveProperty("rateUnit"); expect(parsedRun.input).not.toHaveProperty("coverageDimension");
    expect(canonicalFinanceCommandOriginal(parsedRate)).not.toBe(canonicalFinanceCommandOriginal(rate));
    expect(canonicalFinanceCommandOriginal(parsedRun)).not.toBe(canonicalFinanceCommandOriginal(run));
  });
  it("retains original case, Unicode, array order and safe-integer amounts in the encrypted-body canonical text", () => {
    const original = originals[0]!;
    if (original.kind !== "statement_record") throw new Error("Synthetic statement expected");
    const changed = { ...original, input: { ...original.input, externalStatementId: "真实编号\nSynthetic\"Document", lines: [
      { ...original.input.lines[0]!, amountMinor: Number.MAX_SAFE_INTEGER },
      { ...original.input.lines[0]!, lineKey: "second", sourceEntryId: "synthetic-second", amountMinor: 1 },
    ] } };
    const canonical = canonicalFinanceCommandOriginal(PrepareFinanceCommandSchema.parse(changed));
    expect(JSON.parse(canonical)).toEqual(changed);
    expect(canonicalFinanceCommandOriginal({ ...changed, input: { ...changed.input, lines: [...changed.input.lines].reverse() } })).not.toBe(canonical);
    expect(canonicalFinanceCommandOriginal({ ...changed, input: { ...changed.input, idempotencyKey: key.toUpperCase() } })).not.toBe(canonical);
  });
  it("accepts the full 20000-line owner contract without returning the body in a summary", () => {
    const original = originals[0]!;
    if (original.kind !== "statement_record") throw new Error("Synthetic statement expected");
    const input = { ...original.input, lines: Array.from({ length: 20_000 }, (_, index) => ({ ...original.input.lines[0]!, lineKey: `line-${index}`, sourceEntryId: `event-${index}` })) };
    expect(PrepareFinanceCommandSchema.parse({ ...original, input }).input).toHaveProperty("lines.length", 20_000);
    expect(PrepareFinanceCommandSchema.safeParse({ ...original, input: { ...input, lines: [...input.lines, { ...input.lines[0]!, lineKey: "overflow", sourceEntryId: "overflow" }] } }).success).toBe(false);
    expect(FINANCE_COMMAND_CONTRACT).toBe("finance-command-v1");
    expect(FINANCE_COMMAND_MAX_PLAINTEXT_BYTES).toBe(32 * 1024 * 1024); expect(FINANCE_COMMAND_MAX_CIPHERTEXT_BYTES).toBe(45 * 1024 * 1024);
    expect(FinanceCommandSummarySchema.safeParse({ ...summary(), original }).success).toBe(false);
    expect(FinanceCommandDetailSchema.safeParse({ ...prepared(), original }).success).toBe(false);
  });
  it("allows only an empty explicit action body", () => {
    expect(FinanceCommandEmptyBodySchema.parse({})).toEqual({});
    for (const value of [null, undefined, [], { input: originals[0] }, { idempotencyKey: key }, { confirmed: true }])
      expect(FinanceCommandEmptyBodySchema.safeParse(value).success).toBe(false);
  });
  it("separates the root filter from an absent filter and normalizes only IDs", () => {
    expect(FinanceCommandQuerySchema.parse({ targetId: "root" })).toEqual({ targetId: null });
    expect(FinanceCommandQuerySchema.parse({})).toEqual({});
    expect(FinanceCommandQuerySchema.parse({ targetId: metricId.toUpperCase(), before: paymentId.toUpperCase() })).toEqual({ targetId: metricId, before: paymentId });
    for (const raw of [{ targetId: null }, { tenantId: supplierId }, { userId: supplierId }, { before: "last" }, { kind: "preview" }])
      expect(FinanceCommandQuerySchema.safeParse(raw).success).toBe(false);
  });
  it("uses actual immutable metric and allocation versions rather than a mutable parent ID", () => {
    for (const kind of ["metric_upsert", "cost_version_approve"] as const) {
      expect(FinanceCommandResultSchema.parse({ kind, id: createEntityId(), parentId: metricId, version: 1 })).toMatchObject({ parentId: metricId, version: 1 });
      for (const wrong of [{ parentId: null, version: null }, { parentId: metricId, version: null }, { parentId: null, version: 1 }])
        expect(FinanceCommandResultSchema.safeParse({ kind, id: createEntityId(), ...wrong }).success).toBe(false);
    }
    expect(FinanceCommandResultSchema.parse({ kind: "payment_allocate", id: createEntityId(), parentId: null, version: null }).version).toBeNull();
    expect(FinanceCommandResultSchema.safeParse({ kind: "bill_record", id: createEntityId(), parentId: metricId, version: 1 }).success).toBe(false);
  });
  it("requires an actual matching receipt only on succeeded commands and never manufactures a prepared completion", () => {
    const initial = prepared(), result = { kind: initial.kind, id: createEntityId(), parentId: null, version: null };
    expect(FinanceCommandDetailSchema.safeParse({ ...initial, result }).success).toBe(false);
    expect(FinanceCommandDetailSchema.safeParse({ ...initial, status: "succeeded", completedAt: at, canExecute: false, canCancel: false }).success).toBe(false);
    const done = { ...initial, status: "succeeded", completedAt: at, result, canExecute: false, canCancel: false, canAcknowledge: true };
    expect(FinanceCommandDetailSchema.parse(done).result).toEqual(result);
    expect(FinanceCommandDetailSchema.safeParse({ ...done, result: { ...result, kind: "fx_rate_record" } }).success).toBe(false);
    expect(FinanceCommandDetailSchema.safeParse({ ...done, acknowledged: true, originalRetained: true }).success).toBe(false);
    expect(FinanceCommandDetailSchema.parse({ ...done, acknowledged: true, originalRetained: false, canAcknowledge: false }).result).toEqual(result);
  });
  it("disables execution after basis, authority, input or time loss while retaining a small honest receipt", () => {
    for (const blockReason of ["basis_changed", "permission_denied", "input_unavailable", "expired"] as const) {
      expect(FinanceCommandDetailSchema.safeParse({ ...prepared(), blockReason }).success).toBe(false);
      expect(FinanceCommandDetailSchema.safeParse({ ...prepared(), blockReason, canExecute: false }).success).toBe(true);
    }
    expect(FinanceCommandDetailSchema.safeParse({ ...prepared(), originalRetained: false }).success).toBe(false);
    expect(FinanceCommandDetailSchema.safeParse({ ...prepared(), canAcknowledge: true }).success).toBe(false);
    expect(FinanceCommandOriginalSchema.parse({ id: createEntityId(), original: null, blockReason: "input_unavailable", contextAuthority: "synthetic-finance-authority" }).original).toBeNull();
    expect(FinanceCommandOriginalSchema.safeParse({ id: createEntityId(), original: originals[0], blockReason: null }).success).toBe(false);
  });
  it("bounds metadata pages and does not accept private bodies or arbitrary supplied balances", () => {
    const items = Array.from({ length: 50 }, () => summary());
    expect(FinanceCommandListSchema.parse({ items, nextCursor: items[49]!.id, unavailableCount: 0, contextAuthority: "current" }).items).toHaveLength(50);
    expect(FinanceCommandListSchema.safeParse({ items: [...items, summary()], nextCursor: null, unavailableCount: 0, contextAuthority: "current" }).success).toBe(false);
    expect(FinanceCommandListSchema.safeParse({ items: [], nextCursor: null, unavailableCount: 51, contextAuthority: "current" }).success).toBe(false);
    expect(FinanceCommandSummarySchema.safeParse({ ...summary(), balanceAfter: { netAmountMinor: 0 } }).success).toBe(false);
  });
});
