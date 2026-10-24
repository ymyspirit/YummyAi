import { createEntityId } from "@yummyai/contracts";
import type { FinanceWorkspaceView } from "@yummyai/contracts/finance";
import { buildFinanceCalculationBasis, pinFinanceFxBasis } from "@yummyai/contracts/finance/monetary";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FinanceWorkspace } from "./finance-workspace";

describe("FinanceWorkspace", () => {
  it("renders an explicit empty state without fabricated profit", () => {
    const html = renderToStaticMarkup(<FinanceWorkspace data={{
      statements: [],
      fxRates: [],
      metrics: [],
      runs: [],
    }} />);
    expect(html).toContain("还没有财务证据");
    expect(html).not.toContain("确认收入");
  });

  it("renders complete profit and incomplete diagnostics distinctly", () => {
    const metricId = createEntityId();
    const versionId = createEntityId();
    const statementId = createEntityId();
    const completeRun = run({
      metricId,
      metricVersionId: versionId,
      statementIds: [statementId],
      status: "complete",
      revenueMinor: 10_000,
      costMinor: 3_700,
      profitMinor: 6_300,
      marginBps: 6_300,
    });
    const incompleteRun = run({
      metricId,
      metricVersionId: versionId,
      statementIds: [statementId],
      status: "incomplete",
      revenueMinor: null,
      costMinor: null,
      profitMinor: null,
      marginBps: null,
      diagnostics: {
        missingFactTypes: ["production_cost"],
        missingFxPairs: ["EUR/USD"],
        unclassifiedFactTypes: [],
      },
    });
    const data: FinanceWorkspaceView = {
      statements: [{
        id: statementId,
        accountId: null,
        provider: "supplier",
        statementKind: "supplier_invoice",
        externalStatementId: "SUPPLIER-001",
        periodStart: "2026-07-01T00:00:00.000Z",
        periodEnd: "2026-07-31T23:59:59.000Z",
        sourceCurrency: "EUR",
        observedAt: "2026-08-01T00:00:00.000Z",
        recordedAt: "2026-08-01T00:00:01.000Z",
        checksum: "a".repeat(64),
        lines: [],
      }],
      fxRates: [],
      metrics: [{
        id: metricId,
        name: "Contribution margin",
        currentVersion: 1,
        status: "active",
        version: {
          id: versionId,
          metricId,
          versionNumber: 1,
          reportingCurrency: "USD",
          revenueFactTypes: ["sale_revenue"],
          costFactTypes: ["production_cost"],
          requiredFactTypes: ["sale_revenue", "production_cost"],
          reasonCode: "BASELINE",
          checksum: "b".repeat(64),
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }],
      runs: [completeRun, incompleteRun],
    };
    const html = renderToStaticMarkup(<FinanceWorkspace data={data} />);
    expect(html).toContain("USD 63.00");
    expect(html).toContain("63.00%");
    expect(html).toContain("缺事实 生产成本；缺汇率 EUR/USD");
    expect(html).toContain("缺失");
  });

  it("hides legacy profit and explains individual object gaps and unallocated facts", () => {
    const legacy = run({ profitMinor: 987654, diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] } });
    const incomplete = run({ diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: {
      dimension: "order", checkedEntityCount: 2, missingByEntity: [{ key: "order-b", missingFactTypes: ["production_cost"] }], unattributedFactIds: [createEntityId()],
    } } });
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [], fxRates: [], metrics: [], runs: [legacy, incomplete] }} />);
    expect(html).not.toContain("9,876.54");
    expect(html).toContain("旧计算未验证归属，请重算");
    expect(html).toContain("order-b 缺 生产成本");
    expect(html).toContain("1 条事实未归属逐订单");
  });

  it.each([
    { currency: "JPY", amount: 1234, display: "JPY 1234", wrong: "JPY 12" },
    { currency: "KWD", amount: 1234, display: "KWD 1.234", wrong: "KWD 12.340" },
    { currency: "USD", amount: 9007199254740990, display: "USD 90071992547409.90", wrong: "USD 90071992547409.91" },
  ])("renders $currency using fixed minor digits without floating point", ({ currency, amount, display, wrong }) => {
    const value = run({ reportingCurrency: currency, monetaryBasis: buildFinanceCalculationBasis([currency]), revenueMinor: amount, costMinor: 0, profitMinor: amount, marginBps: 10000 });
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [], fxRates: [], metrics: [], runs: [value] }} />);
    expect(html).toContain(display); if (currency !== "JPY") expect(html).not.toContain(wrong);
    expect(html).toContain("iso4217-2026-09-17-v1");
  });

  it("keeps a covered but ambiguous legacy cross-precision profit hidden", () => {
    const value = run({ reportingCurrency: "JPY", monetaryBasis: null, revenueMinor: 10000, costMinor: 320000, profitMinor: -310000,
      contributions: [{ id: createEntityId(), factId: createEntityId(), fxRateId: createEntityId(), bucket: "cost", effectSign: 1, factType: "production_cost",
        sourceAmountMinor: 2000, sourceCurrency: "EUR", reportingAmountMinor: 320000, reportingCurrency: "JPY", occurredAt: "2026-07-15T00:00:00Z",
        orderId: null, orderLineId: null, skuId: null, listingId: null, accountId: null, supplierId: null }],
      diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], coverage: { dimension: "aggregate", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] },
        monetary: { unknownCurrencies: [], ambiguousFxRateIds: [createEntityId()] } } });
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [], fxRates: [], metrics: [], runs: [value] }} />);
    expect(html).not.toContain("JPY -310000"); expect(html).toContain("汇率单位待核对"); expect(html).toContain("缺失");
  });

  it("shows raw FX fractions and explains explicit and historical rate units separately", () => {
    const rate = { id: createEntityId(), source: "SYNTHETIC", baseCurrency: "JPY", quoteCurrency: "USD", rateNumerator: 1, rateDenominator: 150,
      effectiveAt: "2026-07-01T00:00:00Z", retrievedAt: "2026-07-02T00:00:00Z", recordedAt: "2026-07-03T00:00:00Z", checksum: "a".repeat(64) };
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [], metrics: [], runs: [run({})],
      fxRates: [{ ...rate, monetaryBasis: pinFinanceFxBasis("JPY", "USD") }, { ...rate, id: createEntityId(), monetaryBasis: null }] }} />);
    expect(html).toContain("1 / 150"); expect(html).toContain("1 JPY 主货币单位"); expect(html).toContain("USD 主货币单位");
    expect(html).toContain("单位待核对"); expect(html).not.toContain("0.006667");
  });
  it("does not use today's identified statement to certify an old run with unknown economic-event identity", () => {
    const old = run({ revenueMinor: 10000, costMinor: 3700, profitMinor: 6300, marginBps: 6300, sourceIdentityVersion: null });
    const missing = old.contributions.map(row => row.factId); old.diagnostics.sourceIdentity = { schemaVersion: 1, unidentifiedFactIds: missing };
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [], fxRates: [], metrics: [], runs: [old] }} />);
    expect(html).not.toContain("USD 63.00"); expect(html).toContain("历史来源身份依据未知");
    expect(html).toContain("定位缺少来源身份的事实"); for (const id of missing) expect(html).toContain(id);
  });
  it("shows exact scope and complete component IDs without treating a missing entry as row zero", () => {
    const statementId = createEntityId(), identifiedId = createEntityId(), unknownId = createEntityId(), sourceEntryId = "SYNTHETIC-COMPONENT-001";
    const base = { accountId: null, lineKey: "row-1", factType: "production_cost" as const, direction: "debit" as const, amountMinor: 100, currency: "USD",
      occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-02T00:00:00.000Z", externalReference: null, orderId: null, orderLineId: null,
      skuId: null, listingId: null, supplierId: null, correctionKind: "original" as const, correctsFactId: null, statementId };
    const html = renderToStaticMarkup(<FinanceWorkspace data={{ statements: [{ id: statementId, accountId: null, provider: "manual", statementKind: "operational_cost",
      externalStatementId: "SYNTHETIC-SCOPE-DETAIL", sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-LEDGER" },
      periodStart: base.occurredAt, periodEnd: base.occurredAt, sourceCurrency: "USD", observedAt: base.recordedAt, recordedAt: base.recordedAt, checksum: "a".repeat(64),
      lines: [{ ...base, id: identifiedId, sourceEntryId }, { ...base, id: unknownId, lineKey: "row-2", sourceEntryId: null }] }], fxRates: [], metrics: [], runs: [] }} />);
    expect(html).toContain("命名来源"); expect(html).toContain("SYNTHETIC-LEDGER"); expect(html).toContain(sourceEntryId);
    expect(html).toContain(identifiedId); expect(html).toContain(unknownId); expect(html).toContain("未记录 源明细身份未知");
  });
});

function run(overrides: Partial<FinanceWorkspaceView["runs"][number]>): FinanceWorkspaceView["runs"][number] {
  const value: FinanceWorkspaceView["runs"][number] = {
    id: createEntityId(),
    metricId: createEntityId(),
    metricVersionId: createEntityId(),
    metricVersion: 1,
    reportingCurrency: "USD",
    sourceIdentityVersion: 1,
    monetaryBasis: buildFinanceCalculationBasis(["USD"]),
    status: "complete",
    revenueMinor: 0,
    costMinor: 0,
    profitMinor: 0,
    marginBps: null,
    statementIds: [],
    fxRateIds: [],
    diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [], sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] },
      coverage: { dimension: "order", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] } },
    inputChecksum: "c".repeat(64),
    calculatedAt: "2026-08-01T00:00:00.000Z",
    contributions: [],
    breakdowns: [],
    ...overrides,
  };
  if (!Object.hasOwn(overrides, "contributions")) value.contributions = (["revenue", "cost"] as const).map<FinanceWorkspaceView["runs"][number]["contributions"][number]>(bucket => {
    const amount = bucket === "revenue" ? value.revenueMinor ?? 0 : value.costMinor ?? 0;
    return { id: createEntityId(), factId: createEntityId(), fxRateId: null, bucket, sourceAmountMinor: Math.abs(amount), sourceCurrency: value.reportingCurrency,
      reportingAmountMinor: Math.abs(amount), reportingCurrency: value.reportingCurrency, effectSign: amount < 0 ? -1 : 1,
      factType: bucket === "revenue" ? "sale_revenue" : "production_cost", occurredAt: "2026-07-15T00:00:00Z", orderId: null,
      orderLineId: null, skuId: null, listingId: null, accountId: null, supplierId: null };
  });
  return value;
}
