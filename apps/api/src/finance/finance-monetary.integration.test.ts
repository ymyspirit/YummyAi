import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createEntityId } from "@yummyai/contracts";
import { isFinanceProfitVerified, type CalculateFinanceProfitInput } from "@yummyai/contracts/finance";
import { buildFinanceCalculationBasis, pinFinanceFxBasis } from "@yummyai/contracts/finance/monetary";
import { financeSourceScopeKey } from "@yummyai/contracts/finance/source-identity";
import { connectDatabase, migrateDatabase, withTenant, financeFacts, financeFxRates, financeProfitRuns, financeProfitContributions } from "@yummyai/database";
import { financeMonetaryFixture, requireFinanceMonetaryFixture, monetaryFact, monetaryRate, monetaryKey } from "./finance-monetary.fixtures.js";

requireFinanceMonetaryFixture();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "current") throw new Error("Current disposable monetary schema required before connection");

describe.sequential("actual minor-unit aware financial evidence", () => {
  const database = connectDatabase(), fixture = financeMonetaryFixture(database), { service, context } = fixture;
  beforeAll(async () => { await migrateDatabase(database); await fixture.initialize(); }, 60_000);
  afterAll(async () => { await database.client.end(); });
  async function input(currency: string, statementIds: string[], fxRateIds: string[] = []): Promise<CalculateFinanceProfitInput> {
    const metric = await fixture.metric(currency);
    return { metricId: metric.id, expectedMetricVersion: 1, statementIds, fxRateIds, coverageDimension: "aggregate", idempotencyKey: monetaryKey() };
  }
  async function conversion(source: string, target: string, amount: number, numerator: number, denominator: number, expected: number) {
    const revenue = await fixture.statement(target, [monetaryFact(target, 10000, { factType: "sale_revenue", direction: "credit" })]);
    const cost = await fixture.statement(source, [monetaryFact(source, amount)]);
    const rate = await service.recordFxRate(context, monetaryRate(source, target, numerator, denominator));
    const request = await input(target, [revenue.id, cost.id], [rate.id]), result = await service.calculateProfit(context, request);
    expect(result).toMatchObject({ status: "complete", revenueMinor: 10000, costMinor: expected, profitMinor: 10000 - expected,
      monetaryBasis: buildFinanceCalculationBasis([source, target]), diagnostics: { monetary: { unknownCurrencies: [], ambiguousFxRateIds: [] } } });
    expect(rate.monetaryBasis).toEqual(pinFinanceFxBasis(source, target));
    expect(result.contributions.find(row => row.factType === "production_cost")).toMatchObject({ sourceAmountMinor: amount,
      reportingAmountMinor: expected, sourceCurrency: source, reportingCurrency: target, fxRateId: rate.id });
    expect(isFinanceProfitVerified(result)).toBe(true);
    return { request, result, rate };
  }
  it.each([
    { source: "EUR", target: "JPY", amount: 2000, numerator: 160, denominator: 1, expected: 3200 },
    { source: "JPY", target: "USD", amount: 1234, numerator: 1, denominator: 150, expected: 823 },
    { source: "KWD", target: "USD", amount: 1234, numerator: 3, denominator: 1, expected: 370 },
    { source: "USD", target: "KWD", amount: 123, numerator: 1, denominator: 3, expected: 410 },
  ])("books an explicit $source to $target major rate using fixed actual minor units", async value => {
    const saved = await conversion(value.source, value.target, value.amount, value.numerator, value.denominator, value.expected);
    const before = await fixture.state();
    expect(await service.calculateProfit(context, saved.request)).toEqual(saved.result); expect(await fixture.state()).toEqual(before);
  });
  it("keeps a safe-integer ratio immediately below half a minor unit at zero", async () => {
    const saved = await conversion("USD", "EUR", 4503599627370495, 1, 9007199254740991, 0);
    expect(saved.result).toMatchObject({ revenueMinor: 10000, costMinor: 0, profitMinor: 10000 });
  });
  it("rounds each actual half-minor fact before totaling and reverses that same rounded contribution", async () => {
    const revenue = await fixture.statement("USD", [monetaryFact("USD", 100, { factType: "sale_revenue", direction: "credit" })]);
    const original = await fixture.statement("JPY", [monetaryFact("JPY", 1), monetaryFact("JPY", 1)]);
    const rate = await service.recordFxRate(context, monetaryRate("JPY", "USD", 1, 200));
    const request = await input("USD", [revenue.id, original.id], [rate.id]);
    const first = await service.calculateProfit(context, request); expect(first).toMatchObject({ costMinor: 2, profitMinor: 98 });
    expect(first.contributions.filter(row => row.factType === "production_cost").map(row => row.reportingAmountMinor)).toEqual([1, 1]);
    const reversed = await fixture.statement("JPY", [monetaryFact("JPY", 1, { correctionKind: "reversal", correctsFactId: original.lines[0]!.id })]);
    const replacement = await fixture.statement("JPY", [monetaryFact("JPY", 0, { correctionKind: "replacement", correctsFactId: original.lines[0]!.id })]);
    const after = await service.calculateProfit(context, { ...request, statementIds: [...request.statementIds, reversed.id, replacement.id], idempotencyKey: monetaryKey() });
    expect(after).toMatchObject({ status: "complete", costMinor: 1, profitMinor: 99 });
    expect(after.contributions.find(row => row.factId === reversed.lines[0]!.id)).toMatchObject({ effectSign: -1, reportingAmountMinor: 1 });
    expect((await service.getProfitRun(context, first.id)).costMinor).toBe(2);
  });
  it("keeps a safe boundary exact and rolls converted overflow back without a partial run", async () => {
    const evidence = await fixture.statement("USD", [monetaryFact("USD", Number.MAX_SAFE_INTEGER, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 0)]);
    const safe = await service.calculateProfit(context, await input("USD", [evidence.id])); expect(safe.profitMinor).toBe(Number.MAX_SAFE_INTEGER);
    const rate = await service.recordFxRate(context, monetaryRate("USD", "KWD", 1, 1));
    const request = await input("KWD", [evidence.id], [rate.id]), before = await fixture.state();
    await expect(service.calculateProfit(context, request)).rejects.toMatchObject({ status: 422 }); expect(await fixture.state()).toEqual(before);
  });
  it("normalizes negative revenue margins and refuses int4 overflow before saving any result", async () => {
    const negative = await fixture.statement("USD", [monetaryFact("USD", 100, { factType: "sale_revenue", direction: "debit" }), monetaryFact("USD", 10)]);
    expect(await service.calculateProfit(context, await input("USD", [negative.id]))).toMatchObject({ revenueMinor: -100, costMinor: 10, profitMinor: -110, marginBps: 11000 });
    const wide = await fixture.statement("USD", [monetaryFact("USD", 1, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 214750)]);
    const request = await input("USD", [wide.id]), before = await fixture.state();
    await expect(service.calculateProfit(context, request)).rejects.toMatchObject({ status: 422 }); expect(await fixture.state()).toEqual(before);
  });
  it("keeps an old omitted rate unit and original checksum compatible for equal currency precision", async () => {
    const { rateUnit: omitted, ...original } = monetaryRate("EUR", "USD", 11, 10); void omitted;
    const rate = await service.recordFxRate(context, original), before = await fixture.state(); expect(rate.monetaryBasis ?? null).toBeNull();
    expect(await service.recordFxRate(context, original)).toEqual(rate); expect(await fixture.state()).toEqual(before);
    await expect(service.recordFxRate(context, { ...original, rateUnit: "major_to_major" })).rejects.toMatchObject({ status: 409 });
    const revenue = await fixture.statement("USD", [monetaryFact("USD", 10000, { factType: "sale_revenue", direction: "credit" })]);
    const cost = await fixture.statement("EUR", [monetaryFact("EUR", 2000)]);
    expect(await service.calculateProfit(context, await input("USD", [revenue.id, cost.id], [rate.id]))).toMatchObject({ status: "complete", costMinor: 2200, profitMinor: 7800 });
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(financeFxRates).where(eq(financeFxRates.id, rate.id)));
    expect(stored!.monetaryBasis).toBeNull(); expect(stored!.checksum).toBe(rate.checksum);
  });
  it("does not reinterpret an unlabeled old cross-precision rate as an explicit major rate", async () => {
    const { rateUnit: omitted, ...original } = monetaryRate("EUR", "JPY", 160, 1); void omitted;
    const rate = await service.recordFxRate(context, original);
    const revenue = await fixture.statement("JPY", [monetaryFact("JPY", 10000, { factType: "sale_revenue", direction: "credit" })]);
    const cost = await fixture.statement("EUR", [monetaryFact("EUR", 2000)]);
    const result = await service.calculateProfit(context, await input("JPY", [revenue.id, cost.id], [rate.id]));
    expect(result).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null, marginBps: null,
      breakdowns: [], diagnostics: { monetary: { unknownCurrencies: [], ambiguousFxRateIds: [rate.id] } } });
    expect(isFinanceProfitVerified(result)).toBe(false);
    expect(result.contributions.find(row => row.factType === "production_cost")!.reportingAmountMinor).toBeNull();
  });
  it.each(["ZZZ", "XXX"])("retains %s facts without manufacturing precision or a zero total", async currency => {
    const statement = await fixture.statement(currency, [monetaryFact(currency, 1234, { factType: "sale_revenue", direction: "credit" }), monetaryFact(currency, 0)]);
    const result = await service.calculateProfit(context, await input(currency, [statement.id]));
    expect(result).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null,
      diagnostics: { monetary: { unknownCurrencies: [currency], ambiguousFxRateIds: [] } } });
    expect(result.contributions.every(row => row.reportingAmountMinor === null)).toBe(true); expect(isFinanceProfitVerified(result)).toBe(false);
  });
  it("keeps missing FX separate from ambiguous units", async () => {
    const revenue = await fixture.statement("USD", [monetaryFact("USD", 10000, { factType: "sale_revenue", direction: "credit" })]);
    const cost = await fixture.statement("JPY", [monetaryFact("JPY", 1234)]);
    expect(await service.calculateProfit(context, await input("USD", [revenue.id, cost.id]))).toMatchObject({ status: "incomplete", profitMinor: null,
      diagnostics: { missingFxPairs: ["JPY/USD"], monetary: { unknownCurrencies: [], ambiguousFxRateIds: [] } } });
  });
  it("selects equal-time rates by immutable ascending ID independently of supplied array order", async () => {
    const a = await service.recordFxRate(context, monetaryRate("EUR", "JPY", 160, 1, { source: "SYNTHETIC.TIE_A" }));
    const b = await service.recordFxRate(context, monetaryRate("EUR", "JPY", 170, 1, { source: "SYNTHETIC.TIE_B" }));
    const revenue = await fixture.statement("JPY", [monetaryFact("JPY", 10000, { factType: "sale_revenue", direction: "credit" })]);
    const cost = await fixture.statement("EUR", [monetaryFact("EUR", 100)]), request = await input("JPY", [revenue.id, cost.id], [b.id, a.id]);
    const expected = a.id < b.id ? a : b;
    for (const ids of [[b.id, a.id], [a.id, b.id]]) {
      const result = await service.calculateProfit(context, { ...request, fxRateIds: ids, idempotencyKey: monetaryKey() });
      expect(result.costMinor).toBe(expected.rateNumerator); expect(result.contributions.find(row => row.factType === "production_cost")!.fxRateId).toBe(expected.id);
    }
  });
  it.each([{ currency: "JPY", minorDigits: 2 }, { currency: "KWD", minorDigits: 2 }])("physically rejects a forged $currency rate precision", async value => {
    const basis = { ...pinFinanceFxBasis("EUR", value.currency), quoteMinorDigits: value.minorDigits }, before = await fixture.state();
    await expect(withTenant(database.db, context, async tx => {
      const id = createEntityId(); await fixture.audit.recordInTransaction(tx, context, { action: "finance.fx_rate.record", resourceType: "finance_fx_rate", resourceId: id, result: "success" });
      await tx.insert(financeFxRates).values({ id, tenantId: context.tenantId,
      source: `SYNTHETIC.RAW-${createEntityId().toUpperCase()}`, baseCurrency: "EUR", quoteCurrency: value.currency, rateNumerator: 1, rateDenominator: 1,
      effectiveAt: new Date("2026-07-01T00:00:00Z"), retrievedAt: new Date("2026-07-02T00:00:00Z"), checksum: "a".repeat(64),
      idempotencyKey: monetaryKey(), recordedBy: context.userId, monetaryBasis: basis });
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_fx_monetary_basis_invalid"));
    expect(await fixture.state()).toEqual(before);
  });
  it.each(["missing_contributions", "wrong_conversion", "forged_basis", "unselected_rate"] as const)("physically rejects %s in an otherwise real financial run", async fault => {
    const valid = await conversion("EUR", "JPY", 2000, 160, 1, 3200);
    const unselected = fault === "unselected_rate" ? await service.recordFxRate(context, monetaryRate("EUR", "JPY", 160, 1)) : null;
    const before = await fixture.state();
    await expect(withTenant(database.db, context, async tx => {
      const [stored] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, valid.result.id));
      const children = await tx.select().from(financeProfitContributions).where(eq(financeProfitContributions.runId, stored!.id));
      const id = createEntityId(), monetaryBasis = fault === "forged_basis" ? { ...stored!.monetaryBasis!,
        currencies: stored!.monetaryBasis!.currencies.map(item => item.currency === "JPY" ? { ...item, minorDigits: 2 } : item) } : stored!.monetaryBasis;
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.profit.calculate", resourceType: "finance_profit_run", resourceId: id, result: "success" });
      await tx.insert(financeProfitRuns).values({ ...stored!, id, idempotencyKey: monetaryKey(), monetaryBasis,
        ...(fault === "wrong_conversion" ? { costMinor: 320000, profitMinor: -310000, marginBps: -310000 } : {}) });
      if (fault !== "missing_contributions") await tx.insert(financeProfitContributions).values(children.map(child => ({ ...child, id: createEntityId(), runId: id,
        ...(fault === "wrong_conversion" && child.sourceCurrency === "EUR" ? { reportingAmountMinor: 320000 } : {}),
        ...(unselected && child.sourceCurrency === "EUR" ? { fxRateId: unselected.id } : {}) })));
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes({ missing_contributions: "finance_contributions_incomplete",
      wrong_conversion: "finance_contribution_amount_mismatch", forged_basis: "finance_calculation_precision_invalid", unselected_rate: "finance_contribution_fx_mismatch" }[fault]));
    expect(await fixture.state()).toEqual(before);
  });
  it("rejects appending a new financial fact to an already committed statement", async () => {
    const statement = await fixture.statement("USD", [monetaryFact("USD", 100, { factType: "sale_revenue", direction: "credit" }), monetaryFact("USD", 0)]);
    const before = await fixture.state();
    await expect(withTenant(database.db, context, tx => tx.insert(financeFacts).values({ id: createEntityId(), tenantId: context.tenantId,
      statementId: statement.id, accountId: null, ...monetaryFact("USD", 1), sourceProvider: statement.provider,
      sourceScopeKey: financeSourceScopeKey({ ...statement, sourceIdentity: statement.sourceIdentity! }), occurredAt: new Date("2026-07-15T00:00:00.000Z") })))
      .rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_statement_is_sealed"));
    expect(await fixture.state()).toEqual(before);
  });
  it("rejects appending a contribution after its actual financial run has committed", async () => {
    const valid = await conversion("EUR", "JPY", 2000, 160, 1, 3200), before = await fixture.state();
    const [child] = await withTenant(database.db, context, tx => tx.select().from(financeProfitContributions).where(eq(financeProfitContributions.runId, valid.result.id)));
    await expect(withTenant(database.db, context, tx => tx.insert(financeProfitContributions).values({ ...child!, id: createEntityId() })))
      .rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_legacy_run_is_sealed"));
    expect(await fixture.state()).toEqual(before);
  });
  it("rejects a non-source zero fact after a valid raw run passes immediate deferred constraints", async () => {
    const valid = await conversion("EUR", "JPY", 2000, 160, 1, 3200), outside = await fixture.statement("JPY", [monetaryFact("JPY", 0)]);
    const before = await fixture.state(); let immediatePassed = false;
    await expect(withTenant(database.db, context, async tx => {
      const [stored] = await tx.select().from(financeProfitRuns).where(eq(financeProfitRuns.id, valid.result.id));
      const children = await tx.select().from(financeProfitContributions).where(eq(financeProfitContributions.runId, stored!.id));
      const id = createEntityId(); await tx.insert(financeProfitRuns).values({ ...stored!, id, idempotencyKey: monetaryKey() });
      await tx.insert(financeProfitContributions).values(children.map(child => ({ ...child, id: createEntityId(), runId: id })));
      await fixture.audit.recordInTransaction(tx, context, { action: "finance.profit.calculate", resourceType: "finance_profit_run", resourceId: id, result: "success" });
      await tx.execute(sql`set constraints all immediate`); immediatePassed = true;
      await tx.insert(financeProfitContributions).values({ id: createEntityId(), tenantId: context.tenantId, runId: id,
        factId: outside.lines[0]!.id, fxRateId: null, bucket: "cost", sourceAmountMinor: 0, sourceCurrency: "JPY", reportingAmountMinor: 0,
        reportingCurrency: "JPY", effectSign: 1 });
    })).rejects.toSatisfy((error: unknown) => pgCode(error) === "23514" && pgMessage(error).includes("finance_legacy_run_is_sealed"));
    expect(immediatePassed).toBe(true); expect(await fixture.state()).toEqual(before);
  });
  it("keeps foreign statements, rates and computed amounts outside tenant RLS", async () => {
    const saved = await conversion("JPY", "USD", 1234, 1, 150, 823);
    await expect(service.getProfitRun(fixture.outsider, saved.result.id)).rejects.toMatchObject({ status: 404 });
    expect(await withTenant(database.db, fixture.outsider, tx => tx.select().from(financeFxRates).where(eq(financeFxRates.id, saved.rate.id)))).toEqual([]);
  });
});
function pgCode(error: unknown): string | undefined {
  const value = error as { code?: string; cause?: { code?: string } }; return value.cause?.code ?? value.code;
}
function pgMessage(error: unknown): string {
  const value = error as { message?: string; cause?: { message?: string } }; return value.cause?.message ?? value.message ?? "";
}
