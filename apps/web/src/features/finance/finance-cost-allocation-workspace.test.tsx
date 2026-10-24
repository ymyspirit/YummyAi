import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { FinanceCostAllocationBaseViewSchema, FinanceCostAllocationPreviewViewSchema, FinanceAllocatedProfitRunViewSchema,
  FinanceAllocatedProfitSliceSchema, FINANCE_COST_ALLOCATION_ALGORITHM, splitFinanceCostMinor } from "@yummyai/contracts/finance/cost-allocation";
import { buildFinanceCalculationBasis } from "@yummyai/contracts/finance/monetary";
import { ErpIdentityContext } from "../identity/erp-access";
import { FinanceCostAllocationWorkspace, BaseSummary, AllocationPreviewSummary, AllocatedProfitSummary, SliceSummary } from "./finance-cost-allocation-workspace";

const baseId = createEntityId(), runId = createEntityId(), rootId = createEntityId(), contributionId = createEntityId(), versionId = createEntityId(), metricId = createEntityId(), metricVersionId = createEntityId();
const at = "2026-07-03T00:00:00.000Z", hash = "a".repeat(64), keys = [createEntityId(), createEntityId(), createEntityId()].sort();
const target = (key = keys[0]!) => ({ dimension: "order" as const, key, label: `Synthetic actual target ${key}`, orderId: key, orderLineId: null, skuId: null, listingId: null,
  accountId: null, spuId: null, catalogLinkId: null, period: null, periodStart: null, periodEnd: null, basisChecksum: hash });
const base = () => FinanceCostAllocationBaseViewSchema.parse({ id: baseId, metricId, metricVersionId, metricVersion: 1, reportingCurrency: "USD", status: "complete",
  sourceIdentityVersion: 1, monetaryBasis: buildFinanceCalculationBasis(["USD"]), revenueMinor: 3000, costMinor: 101, profitMinor: 2899, marginBps: 9663,
  statementIds: [createEntityId()], fxRateIds: [], diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [],
    sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] }, monetary: { unknownCurrencies: [], ambiguousFxRateIds: [] },
    coverage: { dimension: "aggregate", checkedEntityCount: 1, missingByEntity: [], unattributedFactIds: [] } }, inputChecksum: hash, calculatedAt: at, breakdowns: [] });
const preview = (amount = 101) => FinanceCostAllocationPreviewViewSchema.parse({ baseRunId: baseId, baseInputChecksum: hash, allocationId: null, expectedVersion: null,
  dimension: "order", method: "equal", algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", reasonCode: "SYNTHETIC", basisDescription: "Actual operator-recorded synthetic weights",
  sources: [{ rootFactId: rootId, contributionId, factId: rootId, statementId: createEntityId(), statementChecksum: hash, sourceEntryId: "synthetic:original:cost", factType: "carrier_cost",
    effectSign: 1, sourceCurrency: "USD", sourceAmountMinor: amount, reportingCurrency: "USD", reportingAmountMinor: amount, fxRateId: null, sourceChainChecksum: hash,
    shares: splitFinanceCostMinor(amount, keys.map(key => ({ key, weight: "1" }))).map(({ key, ...share }) => ({ ...share, target: target(key) })) }], previewChecksum: hash });
const run = () => FinanceAllocatedProfitRunViewSchema.parse({ id: runId, baseRunId: baseId, baseInputChecksum: hash, dimension: "order", versionPins: [{ id: versionId, allocationId: createEntityId(), versionNumber: 1, checksum: hash }],
  algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", status: "complete", revenueMinor: 3000, costMinor: 101, profitMinor: 2899, marginBps: 9663,
  diagnostics: { unallocatedContributionIds: [], checkedTargetCount: 1, missingByTarget: [] }, breakdowns: [{ target: target(), revenueMinor: 3000, costMinor: 101, profitMinor: 2899, factCount: 2 }], inputChecksum: hash, createdAt: at, basisProblems: [] });
const slice = () => FinanceAllocatedProfitSliceSchema.parse({ id: createEntityId(), runId, baseContributionId: contributionId, sourceFactId: rootId, rootFactId: rootId,
  allocationVersionId: versionId, target: target(), amountMinor: 34, originalReportingAmountMinor: 101, bucket: "cost", effectSign: 1, factType: "carrier_cost", weight: "1",
  floorMinor: 33, remainderNumerator: "2000000000", remainderDenominator: "3000000000", receivesRemainder: true, createdAt: at });
function workspace(permissions: string[]) {
  const session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), permissions, dataScope: "tenant",
    displayName: "Synthetic attribution operator", organizationName: "Synthetic attribution organization" };
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}><FinanceCostAllocationWorkspace /></ErpIdentityContext.Provider>);
}

describe("explicit allocation views preserve original money, unknown coverage and authority", () => {
  it("starts with an explicit original run ID and explains that attribution does not create a payment or new cost", () => {
    const html = workspace([Permission.FinanceRead]); expect(html).toContain("原汇总利润计算 ID"); expect(html).toContain("读取原利润计算");
    expect(html).toContain("原账面金额、汇率和单据保留"); expect(html).toContain("不进行付款核销或转账");
    expect(html).not.toContain("批准并登记分摊版本"); expect(html).not.toContain("计算并登记归属利润"); expect(html).not.toContain("USD 0.00");
  });
  it("clears original requests and private query controls without FinanceRead even when FinanceReview remains", () => {
    for (const rights of [[Permission.ProductRead], [Permission.FinanceReview]]) {
      const html = workspace(rights); expect(html).toContain("当前没有财务读取权限"); expect(html).toContain("原请求与填写已清除");
      expect(html).not.toContain('aria-label="读取原汇总利润"'); expect(html).not.toContain("人工分摊依据");
    }
  });
  it("retains the original base, metric version and reporting currency rather than recalculating FX from displayed shares", () => {
    const html = renderToStaticMarkup(<BaseSummary base={base()} />); expect(html).toContain(baseId); expect(html).toContain(metricVersionId);
    expect(html).toContain("USD 1.01"); expect(html).toContain(hash); expect(html).toContain("不逐份重新折算");
  });
  it("shows exact integer floors, remainder fractions and deterministic tail awards for every actual target", () => {
    const html = renderToStaticMarkup(<AllocationPreviewSummary preview={preview()} />);
    for (const key of keys) expect(html).toContain(key);
    expect(html).toContain("余数 2000000000 / 3000000000"); expect(html).toContain("USD 0.34"); expect(html).toContain("USD 0.33");
    expect(html).toContain("获得1个最小单位尾差"); expect(html).toContain("未获得额外尾差"); expect(html).toContain("原费用根事实"); expect(html).toContain(rootId);
  });
  it("keeps zero allocated shares visible and distinguishes them from unknown or missing money", () => {
    const html = renderToStaticMarkup(<AllocationPreviewSummary preview={preview(1)} />);
    expect(html).toContain("USD 0.01"); expect(html).toContain("USD 0.00"); for (const key of keys) expect(html).toContain(key);
    expect(html).not.toContain("金额待核对"); expect(html).toContain("3 个目标");
  });
  it("keeps reversal direction separate from nonnegative original amount and original share evidence", () => {
    const value = preview(); value.sources[0]!.effectSign = -1;
    const html = renderToStaticMarkup(<AllocationPreviewSummary preview={value} />); expect(html).toContain("冲回成本"); expect(html).toContain("USD 1.01"); expect(html).not.toContain("USD -1.01");
  });
  it("exposes a distinct projection ID and the original base while keeping original result totals authoritative", () => {
    const html = renderToStaticMarkup(<AllocatedProfitSummary run={run()} />); expect(html).toContain(runId); expect(html).toContain(baseId);
    expect(html).toContain("USD 28.99"); expect(html).toContain("归属完整"); expect(html).toContain("不把当前历史分页拼成总额");
  });
  it("withholds aggregate and target claims when actual contribution attribution or required target costs are incomplete", () => {
    const value = run(); value.status = "incomplete"; value.revenueMinor = value.costMinor = value.profitMinor = value.marginBps = null; value.breakdowns = [];
    value.diagnostics = { unallocatedContributionIds: [contributionId], checkedTargetCount: 1, missingByTarget: [{ key: keys[0]!, missingFactTypes: ["production_cost"] }] };
    const html = renderToStaticMarkup(<AllocatedProfitSummary run={value} />); expect(html).toContain(contributionId); expect(html).toContain(keys[0]!);
    expect(html).toContain("不提供确定利润或补零总额"); expect(html).not.toContain("USD 0.00"); expect(html).not.toContain('aria-label="归属利润目标汇总"');
  });
  it("preserves saved amounts but does not display current verified profit when source, target or rule version has changed", () => {
    for (const problem of ["source_changed", "target_changed", "rule_superseded", "base_unavailable"] as const) {
      const value = run(); value.basisProblems = [problem]; const html = renderToStaticMarkup(<AllocatedProfitSummary run={value} />);
      expect(value.profitMinor).toBe(2899); expect(html).toContain("本次读取依据待核对"); expect(html).not.toContain("USD 28.99"); expect(html).not.toContain('aria-label="归属利润目标汇总"');
    }
  });
  it("retains each original contribution, fact, root and approved version ID with its original tail receipt", () => {
    const html = renderToStaticMarkup(<SliceSummary slice={slice()} currency="USD" />);
    for (const id of [contributionId, rootId, versionId]) expect(html).toContain(id);
    expect(html).toContain("USD 0.34"); expect(html).toContain("USD 1.01"); expect(html).toContain("2000000000 / 3000000000");
  });
  it("keeps one unallocated full share explicitly unknown rather than calling it a direct or zero allocation", () => {
    const value = slice(); value.target = null; value.allocationVersionId = null; value.amountMinor = 101; value.weight = null;
    value.floorMinor = null; value.remainderNumerator = null; value.remainderDenominator = null; value.receivesRemainder = false;
    const html = renderToStaticMarkup(<SliceSummary slice={value} currency="USD" />); expect(html).toContain("此原贡献尚未归属实际目标");
    expect(html).toContain("USD 1.01"); expect(html).not.toContain("原事实直接归属"); expect(html).not.toContain("USD 0.00");
  });
});
