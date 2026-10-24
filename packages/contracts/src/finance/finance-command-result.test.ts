import { describe, expect, it } from "vitest";
import { FinanceCommandQuerySchema, type FinanceCommandKind } from "./finance-command.js";
import { buildFinanceCalculationBasis, pinFinanceFxBasis } from "./monetary.js";
import { FINANCE_COST_ALLOCATION_ALGORITHM, splitFinanceCostMinor } from "./cost-allocation.js";
import {
  FinanceCommandRecordedResultSchema, FinanceCommandResultPageQuerySchema, FinanceCommandResultPageSchema,
  financeCommandResultSections, readFinanceCommandResultCursorPosition,
} from "./finance-command-result.js";

const id = (n: number) => `019f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-07-03T00:00:00.100Z", hash = "a".repeat(64);
const kinds = Object.keys(financeCommandResultSections) as FinanceCommandKind[];
const cursor = (offset = 25, anchor = id(25)) => Buffer.from(JSON.stringify({ v: 1, scope: hash, offset, anchor })).toString("base64url");
const verified = { verified: true, checkedAt: at, problems: [] };
const fact = (n = 70) => ({ id: id(n), statementId: id(10), accountId: null, lineKey: `synthetic-${n}`, sourceEntryId: `actual-component-${n}`,
  factType: "production_cost" as const, direction: "debit" as const, amountMinor: 29, currency: "USD", occurredAt: at,
  externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
  correctionKind: "original" as const, correctsFactId: null, recordedAt: at });
const allocation = (n = 70) => ({ id: id(n), batchId: id(10), paymentId: id(20), billId: id(30), supplierId: id(40),
  currency: "USD", amountMinor: 20, recordedAt: at });
const target = (key: string) => ({ dimension: "period" as const, key, label: key, orderId: null, orderLineId: null, skuId: null,
  listingId: null, accountId: null, spuId: null, catalogLinkId: null, period: key, periodStart: `${key}-01T00:00:00.000Z`,
  periodEnd: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1)).toISOString(), basisChecksum: hash });
const shares = () => splitFinanceCostMinor(1, [{ key: "2026-07", weight: "1" }, { key: "2026-08", weight: "1" }])
  .map(({ key, ...share }) => ({ target: target(key), ...share }));
const source = () => ({ rootFactId: id(50), contributionId: id(51), factId: id(50), statementId: id(52), statementChecksum: hash,
  sourceEntryId: "synthetic:original:carrier", factType: "carrier_cost" as const, effectSign: 1 as const,
  sourceCurrency: "JPY", sourceAmountMinor: 150, reportingCurrency: "USD", reportingAmountMinor: 1,
  fxRateId: id(53), sourceChainChecksum: hash });
const billBalance = { amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80,
  allocatedMinor: 50, outstandingMinor: 30, lifecycle: "active" as const };
const paymentBalance = { amountMinor: 100, refundedMinor: 20, voidedMinor: 0, netAmountMinor: 80,
  allocatedMinor: 50, unallocatedMinor: 30, lifecycle: "active" as const };

function sample(kind: FinanceCommandKind) {
  const ordinary = { parentId: null, version: null };
  const records = {
    statement_record: { id: id(10), sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC" }, accountId: null,
      provider: "manual", statementKind: "operational_cost", externalStatementId: "SYNTHETIC-REPORT", periodStart: at, periodEnd: at,
      sourceCurrency: "USD", observedAt: at, recordedAt: at, checksum: hash },
    fx_rate_record: { id: id(10), source: "SYNTHETIC", baseCurrency: "JPY", quoteCurrency: "USD", rateNumerator: 1, rateDenominator: 150,
      effectiveAt: at, retrievedAt: at, recordedAt: at, checksum: hash, monetaryBasis: pinFinanceFxBasis("JPY", "USD") },
    metric_upsert: { id: id(10), metricId: id(20), versionNumber: 1, name: "Original pinned metric name", reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"],
      reasonCode: "SYNTHETIC", checksum: hash, createdAt: at },
    profit_calculate: { id: id(10), metricId: id(20), metricVersionId: id(21), metricVersion: 1, reportingCurrency: "USD", status: "complete",
      revenueMinor: 100, costMinor: 29, profitMinor: 71, marginBps: 7100, statementIds: [id(30)], fxRateIds: [],
      diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] }, inputChecksum: hash, calculatedAt: at,
      sourceIdentityVersion: 1, monetaryBasis: buildFinanceCalculationBasis(["USD"]) },
    bill_record: { id: id(10), supplierId: id(40), kind: "factory_invoice", externalBillId: "SYNTHETIC-BILL", currency: "USD", amountMinor: 100,
      issuedAt: at, dueAt: null, procurementInvoiceId: null, procurementProofId: null, recordedAt: at },
    payment_record: { id: id(10), supplierId: id(40), externalPaymentId: "SYNTHETIC-PAYMENT", currency: "KWD", amountMinor: 1001,
      paidAt: at, method: "bank_transfer", evidenceReference: "SYNTHETIC-PAYMENT-EVIDENCE", evidenceStatus: "operator_recorded", recordedAt: at },
    payment_allocate: { id: id(10), paymentId: id(20), recordedAt: at, allocationCount: 1 },
    allocation_release: { id: id(10), allocationId: id(70), reasonCode: "SOURCE_CHANGED", recordedAt: at, allocation: allocation() },
    bill_adjustment_record: { id: id(10), billId: id(20), supplierId: id(40), currency: "USD", kind: "credit", amountMinor: 20,
      externalDocumentId: "SYNTHETIC-CREDIT", evidenceReference: "Synthetic supplier document", occurredAt: at, reasonCode: "SYNTHETIC",
      procurementAdjustmentId: null, procurementReviewId: null, balanceAfter: billBalance, recordedAt: at },
    payment_adjustment_record: { id: id(10), paymentId: id(20), supplierId: id(40), currency: "USD", kind: "refund", amountMinor: 20,
      externalDocumentId: "SYNTHETIC-REFUND", evidenceReference: "Synthetic refund evidence", evidenceStatus: "operator_recorded",
      occurredAt: at, reasonCode: "SYNTHETIC", balanceAfter: paymentBalance, recordedAt: at },
    cost_version_approve: { id: id(10), allocationId: id(20), versionNumber: 1, previousVersionId: null, status: "approved", checksum: hash,
      reviewedBy: id(40), createdAt: at, sourceCount: 1, shareCount: 2,
      preview: { baseRunId: id(30), baseInputChecksum: hash, allocationId: null, expectedVersion: null, dimension: "period", method: "equal",
        algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", reasonCode: "SYNTHETIC", basisDescription: "Real explicit allocation basis", previewChecksum: hash } },
    allocated_profit_calculate: { id: id(10), baseRunId: id(20), baseInputChecksum: hash, dimension: "period", versionPins: [{ id: id(30), allocationId: id(31), versionNumber: 1, checksum: hash }],
      algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", status: "incomplete", revenueMinor: null, costMinor: null,
      profitMinor: null, marginBps: null, diagnostics: { unallocatedContributionIds: [id(50)], checkedTargetCount: 0, missingByTarget: [] },
      breakdowns: [], inputChecksum: hash, createdAt: at },
  };
  const isVersion = kind === "metric_upsert" || kind === "cost_version_approve";
  const targetId = ["profit_calculate", "payment_allocate", "bill_adjustment_record", "payment_adjustment_record", "allocated_profit_calculate"].includes(kind)
    ? id(20) : kind === "allocation_release" ? id(70) : null;
  const balanceSnapshot = ["bill_record", "payment_record", "payment_allocate", "allocation_release"].includes(kind) ? "not_saved"
    : ["bill_adjustment_record", "payment_adjustment_record"].includes(kind) ? "saved_on_event" : undefined;
  return FinanceCommandRecordedResultSchema.parse({ commandId: id(1), kind, targetId,
    result: { kind, id: id(10), ...(isVersion ? { parentId: id(20), version: 1 } : ordinary) }, executedAt: at,
    recorded: { kind, record: records[kind], ...(balanceSnapshot ? { balanceSnapshot } : {}) },
    currentVerification: ["profit_calculate", "cost_version_approve", "allocated_profit_calculate"].includes(kind) ? verified : null,
    collections: financeCommandResultSections[kind].map(section => ({ section, total: section === "cost_shares" ? 2 : 1 })),
    contextAuthority: "synthetic-current-authority", consistency: "immutable_execution" });
}
function factPage() {
  return { commandId: id(1), result: sample("statement_record").result, section: "facts", items: [fact()], limit: 1,
    offset: 0, total: 2, hasMore: true, nextCursor: cursor(1, id(70)), contextAuthority: "synthetic-current-authority", consistency: "immutable_execution" };
}

describe("recorded finance results retain execution evidence independently from deleted originals", () => {
  it.each(kinds)("retains the actual immutable %s record with exactly its available collections", kind => {
    const result = sample(kind);
    expect(result.kind).toBe(kind); expect(result.recorded.record.id).toBe(result.result.id);
    expect(result.collections.map(row => row.section)).toEqual([...financeCommandResultSections[kind]]);
    expect(result).not.toHaveProperty("original"); expect(result).not.toHaveProperty("encryptedInput");
  });
  it("keeps active as an omitted view and explicitly permits recorded successful history", () => {
    expect(FinanceCommandQuerySchema.parse({})).not.toHaveProperty("view");
    expect(FinanceCommandQuerySchema.parse({ view: "recorded" })).toEqual({ view: "recorded" });
    for (const view of ["all", "cancelled", null, ["active", "recorded"]]) expect(FinanceCommandQuerySchema.safeParse({ view }).success).toBe(false);
  });
  it("rejects a different command kind, actual result ID or version proof", () => {
    const metric = sample("metric_upsert");
    for (const result of [{ ...metric.result, kind: "statement_record" }, { ...metric.result, id: id(99) },
      { ...metric.result, parentId: id(99) }, { ...metric.result, version: 2 }])
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...metric, result }).success).toBe(false);
  });
  it("binds existing targets and release nested allocation identity rather than trusting a display record", () => {
    for (const kind of kinds.filter(value => value !== "metric_upsert"))
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...sample(kind), targetId: id(99) }).success).toBe(false);
    const release = sample("allocation_release");
    if (release.recorded.kind !== "allocation_release") throw new Error("Synthetic release expected");
    expect(FinanceCommandRecordedResultSchema.safeParse({ ...release, recorded: { ...release.recorded, record: {
      ...release.recorded.record, allocation: { ...release.recorded.record.allocation, id: id(99) },
    } } }).success).toBe(false);
  });
  it("does not present a second metric version as a root creation or substitute the current name", () => {
    const metric = sample("metric_upsert"); if (metric.recorded.kind !== "metric_upsert") throw new Error("Synthetic metric expected");
    const update = { ...metric, targetId: id(20), result: { ...metric.result, version: 2 },
      recorded: { ...metric.recorded, record: { ...metric.recorded.record, versionNumber: 2, name: null } } };
    expect(FinanceCommandRecordedResultSchema.parse(update).recorded.record).toHaveProperty("name", null);
    expect(FinanceCommandRecordedResultSchema.safeParse({ ...update, targetId: null }).success).toBe(false);
  });
  it("requires cost append proof and original preview to describe the same prior version", () => {
    const value = sample("cost_version_approve"); if (value.recorded.kind !== "cost_version_approve") throw new Error("Synthetic approval expected");
    const record = value.recorded.record;
    for (const preview of [{ ...record.preview, allocationId: id(20) }, { ...record.preview, expectedVersion: 1 }])
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...value, recorded: { ...value.recorded, record: { ...record, preview } } }).success).toBe(false);
    const append = { ...value, targetId: id(20), result: { ...value.result, version: 2 }, recorded: { ...value.recorded,
      record: { ...record, versionNumber: 2, previousVersionId: id(99), preview: { ...record.preview, allocationId: id(20), expectedVersion: 1 } } } };
    expect(FinanceCommandRecordedResultSchema.safeParse(append).success).toBe(true);
  });
  it("keeps saved profit totals separate from failed current verification and never fabricates unsaved breakdowns", () => {
    const value = sample("profit_calculate");
    const stale = FinanceCommandRecordedResultSchema.parse({ ...value, currentVerification: { verified: false, checkedAt: at, problems: ["financial_evidence_unverified"] } });
    expect(stale.recorded.record).toMatchObject({ revenueMinor: 100, costMinor: 29, profitMinor: 71 });
    expect(stale.recorded.record).not.toHaveProperty("breakdowns");
    expect(FinanceCommandRecordedResultSchema.safeParse({ ...stale, recorded: { ...stale.recorded, record: { ...stale.recorded.record, breakdowns: [] } } }).success).toBe(false);
    expect(FinanceCommandRecordedResultSchema.safeParse({ ...stale, currentVerification: { verified: true, checkedAt: at, problems: ["source_changed"] } }).success).toBe(false);
  });
  it("requires a current-verification axis only for saved calculations and allocation approvals", () => {
    for (const kind of kinds) {
      const value = sample(kind);
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...value, currentVerification: value.currentVerification === null ? verified : null }).success).toBe(false);
    }
  });
  it("distinguishes a saved adjustment balance from original bills and payments whose execution balance was not saved", () => {
    const adjusted = sample("bill_adjustment_record"); expect(adjusted.recorded).toHaveProperty("balanceSnapshot", "saved_on_event");
    expect(adjusted.recorded.record).toHaveProperty("balanceAfter", billBalance);
    for (const kind of ["bill_record", "payment_record", "payment_allocate", "allocation_release"] as const) {
      const value = sample(kind); expect(value.recorded).toHaveProperty("balanceSnapshot", "not_saved");
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...value, recorded: { ...value.recorded, balanceSnapshot: "saved_on_event" } }).success).toBe(false);
    }
  });
  it("requires all and only the immutable sections and reconciles header collection totals", () => {
    const value = sample("cost_version_approve");
    for (const collections of [[], [value.collections[0]], [value.collections[0], value.collections[0]],
      [{ section: "facts", total: 1 }, value.collections[1]], [value.collections[0], { section: "cost_shares", total: 1 }]])
      expect(FinanceCommandRecordedResultSchema.safeParse({ ...value, collections }).success).toBe(false);
    const batch = sample("payment_allocate");
    expect(FinanceCommandRecordedResultSchema.safeParse({ ...batch, collections: [{ section: "allocations", total: 2 }] }).success).toBe(false);
  });
});

describe("immutable execution entry pages do not silently crop or lose original evidence", () => {
  it("defaults a strict page query to25 and rejects unknown, fractional, duplicate-shape and over-limit fields", () => {
    expect(FinanceCommandResultPageQuerySchema.parse({ section: "cost_shares" })).toEqual({ section: "cost_shares", limit: 25 });
    expect(FinanceCommandResultPageQuerySchema.parse({ section: "facts", limit: "100" }).limit).toBe(100);
    for (const raw of [{ section: "facts", limit: "01" }, { section: "facts", limit: 0 }, { section: "facts", limit: 101 },
      { section: "facts", limit: 1.5 }, { section: "facts", limit: ["1", "2"] }, { section: "facts", original: true }, { section: "balance" }])
      expect(FinanceCommandResultPageQuerySchema.safeParse(raw).success).toBe(false);
  });
  it("preserves exact zero shares, cross-currency source evidence and original floor/remainder integers", () => {
    const page = FinanceCommandResultPageSchema.parse({ ...factPage(), result: sample("cost_version_approve").result, section: "cost_shares",
      items: shares().map((share, shareIndex) => ({ sourceIndex: 0, shareIndex, source: source(), share })), limit: 25,
      total: 2, hasMore: false, nextCursor: null });
    if (page.section !== "cost_shares") throw new Error("Synthetic shares expected");
    expect(page.items.map(row => row.share.amountMinor)).toEqual([1, 0]);
    expect(page.items[1]).toMatchObject({ source: { sourceAmountMinor: 150, sourceCurrency: "JPY", reportingAmountMinor: 1, reportingCurrency: "USD", sourceEntryId: "synthetic:original:carrier" },
      share: { weight: "1", weightUnits: "1000000000", floorMinor: 0, amountMinor: 0, remainderNumerator: "1000000000", remainderDenominator: "2000000000", receivesRemainder: false } });
  });
  it("rejects a mismatched result section, foreign-parent fact or allocation and repeated entry", () => {
    const value = factPage(); expect(FinanceCommandResultPageSchema.safeParse(value).success).toBe(true);
    expect(FinanceCommandResultPageSchema.safeParse({ ...value, result: sample("fx_rate_record").result }).success).toBe(false);
    expect(FinanceCommandResultPageSchema.safeParse({ ...value, items: [{ ...fact(), statementId: id(99) }] }).success).toBe(false);
    expect(FinanceCommandResultPageSchema.safeParse({ ...value, items: [fact(), fact()], limit: 2 }).success).toBe(false);
    expect(FinanceCommandResultPageSchema.safeParse({ ...value, result: sample("payment_allocate").result, section: "allocations", items: [{ ...allocation(), batchId: id(99) }] }).success).toBe(false);
  });
  it("rejects truncated, false-complete, out-of-bounds and contradictory continuation metadata", () => {
    const value = factPage();
    for (const extra of [{ items: [] }, { hasMore: false, nextCursor: null }, { nextCursor: null }, { offset: 2 },
      { limit: 2 }, { total: 0 }, { hasMore: false }, { items: Array.from({ length: 101 }, (_, n) => fact(n + 100)), limit: 100, total: 101 }])
      expect(FinanceCommandResultPageSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    expect(FinanceCommandResultPageSchema.safeParse({ ...value, offset: 1, hasMore: false, nextCursor: null }).success).toBe(true);
  });
  it("keeps source headers separate from shares instead of hiding an unpaged expanded approval", () => {
    const page = FinanceCommandResultPageSchema.parse({ ...factPage(), result: sample("cost_version_approve").result, section: "cost_sources",
      items: [source()], total: 1, hasMore: false, nextCursor: null });
    expect(page.items[0]).not.toHaveProperty("shares");
    const duplicate = { ...page, items: [source(), source()], limit: 2, total: 2 };
    expect(FinanceCommandResultPageSchema.safeParse(duplicate).success).toBe(false);
  });
  it("parses only canonical UTF8/base64url positions and does not treat the cursor as authorization", () => {
    expect(readFinanceCommandResultCursorPosition(cursor())).toEqual({ v: 1, scope: hash, offset: 25, anchor: id(25) });
    const encode = (text: string) => Buffer.from(text).toString("base64url");
    for (const raw of [cursor() + "=", "!", encode(` {"v":1,"scope":"${hash}","offset":25,"anchor":"${id(25)}"}`),
      encode(`{"v":1,"scope":"${hash}","offset":24,"offset":25,"anchor":"${id(25)}"}`),
      encode(JSON.stringify({ scope: hash, v: 1, offset: 25, anchor: id(25) })), encode(JSON.stringify({ v: 1, scope: hash, offset: 0, anchor: id(25) })),
      Buffer.from([0xff, 0xfe]).toString("base64url")]) expect(readFinanceCommandResultCursorPosition(raw)).toBeNull();
  });
});
