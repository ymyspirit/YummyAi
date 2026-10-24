import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { FinanceFactViewSchema, RecordFinanceStatementInputSchema, UpsertFinanceProfitMetricInputSchema, isFinanceProfitVerified } from "./finance.js";
import { FinanceSourceEntryIdSchema, FinanceSourceIdentitySchema, financeSourceScopeKey, hasFinanceSourceIdentityEvidence } from "./source-identity.js";
import { buildFinanceCalculationBasis } from "./monetary.js";

const supplierId = createEntityId(), accountId = "019f0000-abcd-7000-8000-000000000001", at = "2026-07-15T00:00:00.000Z";
const fact = () => ({ sourceEntryId: "synthetic-event:commission:001", lineKey: "csv-row-1", factType: "marketplace_commission" as const, direction: "debit" as const,
  amountMinor: 100, currency: "USD", occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
  correctionKind: "original" as const, correctsFactId: null });
const statement = () => ({ sourceIdentity: { schemaVersion: 2 as const, kind: "named_source" as const, sourceName: "SYNTHETIC-LEDGER" },
  accountId: null, provider: "manual" as const, statementKind: "operational_cost" as const, externalStatementId: "SYNTHETIC-DOCUMENT-001", sourceCurrency: "USD",
  periodStart: at, periodEnd: at, observedAt: at, idempotencyKey: "synthetic-source-original", lines: [fact()] });

describe("financial economic-event identities", () => {
  it("binds a real marketplace account independently of a document title or CSV row number", () => {
    const sourceIdentity = { schemaVersion: 2 as const, kind: "marketplace_account" as const };
    expect(financeSourceScopeKey({ provider: "etsy", accountId, sourceIdentity })).toBe(`account:${accountId}`);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...statement(), provider: "etsy", accountId, sourceIdentity }).success).toBe(true);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...statement(), provider: "etsy", sourceIdentity }).success).toBe(false);
  });
  it("normalizes UUID case aliases before deriving one marketplace economic-event scope", () => {
    expect(financeSourceScopeKey({ provider: "etsy", accountId: accountId.toUpperCase(), sourceIdentity: { schemaVersion: 2, kind: "marketplace_account" } })).toBe(`account:${accountId}`);
  });
  it("keeps two actual suppliers separate while requiring every invoice component to retain its supplier", () => {
    const sourceIdentity = { schemaVersion: 2 as const, kind: "supplier" as const, supplierId };
    const input = { ...statement(), provider: "supplier", sourceIdentity, lines: [{ ...fact(), supplierId }] };
    expect(RecordFinanceStatementInputSchema.safeParse(input).success).toBe(true);
    expect(financeSourceScopeKey({ provider: "supplier", accountId: null, sourceIdentity })).toBe(`supplier:${supplierId}`);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...input, lines: [{ ...fact(), supplierId: createEntityId() }] }).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...input, accountId }).success).toBe(false);
  });
  it.each(["amazon", "etsy", "supplier"])("does not disguise the %s provider as a named source", provider => {
    expect(RecordFinanceStatementInputSchema.safeParse({ ...statement(), provider }).success).toBe(false);
  });
  it("requires a stable component ID for each v2 fact and rejects duplicate IDs despite different rows or amounts", () => {
    const original = statement(), { sourceEntryId: omitted, ...legacyLine } = fact(); void omitted;
    expect(RecordFinanceStatementInputSchema.safeParse({ ...original, lines: [legacyLine] }).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...original, lines: [fact(), { ...fact(), lineKey: "csv-row-99", amountMinor: 101 }] }).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...original, lines: [fact(), { ...fact(), lineKey: "csv-row-99", sourceEntryId: "synthetic-event:commission:002" }] }).success).toBe(true);
  });
  it("retains omitted legacy identity only for the owner to verify an actual historical replay", () => {
    const { sourceIdentity: omittedSource, ...legacy } = statement(), { sourceEntryId: omittedEntry, ...line } = fact(); void omittedSource; void omittedEntry;
    expect(RecordFinanceStatementInputSchema.safeParse({ ...legacy, lines: [line] }).success).toBe(true);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...legacy, lines: [fact()] }).success).toBe(false);
    expect(FinanceFactViewSchema.safeParse({ ...line, sourceEntryId: null, id: createEntityId(), statementId: createEntityId(), accountId: null, recordedAt: at }).success).toBe(true);
  });
  it.each(["", "\u0000component", "component\nrow", "component\u007f"])("rejects an absent or control-bearing source entry %j", value => {
    expect(FinanceSourceEntryIdSchema.safeParse(value).success).toBe(false);
  });
  it("keeps source identity strict and cannot accept caller-selected authority or a presumed schema version", () => {
    expect(FinanceSourceIdentitySchema.safeParse({ schemaVersion: 1, kind: "named_source", sourceName: "SYNTHETIC" }).success).toBe(false);
    expect(FinanceSourceIdentitySchema.safeParse({ ...statement().sourceIdentity, tenantId: createEntityId() }).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse({ ...statement(), tenantId: createEntityId() }).success).toBe(false);
  });
  it("retains exact v2 millisecond dates with extra zero digits and rejects submillisecond evidence or calendar year zero", () => {
    const input = statement();
    const withDate = (value: string) => ({ ...input, periodStart: value, periodEnd: value, observedAt: value, lines: [{ ...fact(), occurredAt: value }] });
    expect(RecordFinanceStatementInputSchema.safeParse(withDate("2026-07-15T00:00:00.100000Z")).success).toBe(true);
    expect(RecordFinanceStatementInputSchema.safeParse(withDate("2026-07-15T00:00:00.0001Z")).success).toBe(false);
    expect(RecordFinanceStatementInputSchema.safeParse(withDate("0000-07-15T00:00:00.000Z")).success).toBe(false);
  });
  it("requires the pinned identity check and an explicit empty list of unidentified facts", () => {
    expect(hasFinanceSourceIdentityEvidence({})).toBe(false); expect(hasFinanceSourceIdentityEvidence({ sourceIdentityVersion: 1 })).toBe(false);
    expect(hasFinanceSourceIdentityEvidence({ sourceIdentityVersion: 1, diagnostics: { sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [createEntityId()] } } })).toBe(false);
    expect(hasFinanceSourceIdentityEvidence({ sourceIdentityVersion: 1, diagnostics: { sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] } } })).toBe(true);
  });
  it("does not call complete same-currency money verified when its economic-event identity is unknown", () => {
    const value = { status: "complete" as const, reportingCurrency: "USD", monetaryBasis: buildFinanceCalculationBasis(["USD"]),
      contributions: [{ id: createEntityId(), factId: createEntityId(), fxRateId: null, bucket: "cost" as const, effectSign: 1 as const,
        factType: "production_cost" as const, sourceAmountMinor: 100, sourceCurrency: "USD", reportingAmountMinor: 100, reportingCurrency: "USD",
        occurredAt: at, orderId: null, orderLineId: null, skuId: null, listingId: null, accountId: null, supplierId: null }],
      diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: { dimension: "aggregate" as const, checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] } } };
    expect(isFinanceProfitVerified(value)).toBe(false);
    expect(isFinanceProfitVerified({ ...value, sourceIdentityVersion: 1, diagnostics: { ...value.diagnostics, sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] } } })).toBe(true);
  });
  it("rejects unusable optimistic metric versions while retaining omitted legacy replay transport", () => {
    const metric = { metricId: createEntityId(), name: "Synthetic margin", reportingCurrency: "USD", revenueFactTypes: ["sale_revenue"],
      costFactTypes: ["production_cost"], requiredFactTypes: [], reasonCode: "SYNTHETIC", idempotencyKey: "synthetic-metric-original" };
    expect(UpsertFinanceProfitMetricInputSchema.safeParse(metric).success).toBe(true);
    expect(UpsertFinanceProfitMetricInputSchema.safeParse({ ...metric, expectedVersion: 1 }).success).toBe(true);
    for (const expectedVersion of [0, -1, 1.5]) expect(UpsertFinanceProfitMetricInputSchema.safeParse({ ...metric, expectedVersion }).success).toBe(false);
  });
});
