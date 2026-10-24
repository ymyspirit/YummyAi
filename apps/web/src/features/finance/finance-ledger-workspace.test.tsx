import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import { FinanceLedgerDetailViewSchema, FinanceLedgerKindSchema, FinanceLedgerSummarySchema } from "@yummyai/contracts/finance/ledger";
import { buildFinanceCalculationBasis } from "@yummyai/contracts/finance/monetary";
import { ErpIdentityContext } from "../identity/erp-access";
import { FinanceLedgerWorkspace, LedgerRecord, SummaryMoney } from "./finance-ledger-workspace";

const tenantId = createEntityId(), userId = createEntityId();
const id = createEntityId(), parentId = createEntityId(), supplierId = createEntityId(), at = "2026-07-03T00:00:00.000Z";
const due = () => ({ id, supplierId, kind: "factory_invoice", externalBillId: "SYNTHETIC-LEDGER-ORIGINAL", currency: "USD", amountMinor: 100,
  creditMinor: 20, debitMinor: 5, voidedMinor: 0, netAmountMinor: 85, allocatedMinor: 0, outstandingMinor: 85, lifecycle: "active",
  issuedAt: at, dueAt: null, procurementInvoiceId: null, procurementProofId: null, sourceStatus: "current", status: "unallocated", recordedAt: at });
function record(value: unknown) { return renderToStaticMarkup(<LedgerRecord detail={FinanceLedgerDetailViewSchema.parse(value)} onOpen={() => {}} blocked={false} />); }
function render(permissions: string[] = [Permission.FinanceRead]) {
  const session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId, userId, permissions, dataScope: "tenant",
    displayName: "Synthetic ledger reader", organizationName: "Synthetic ledger organization" };
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}><FinanceLedgerWorkspace /></ErpIdentityContext.Provider>);
}

describe("complete financial ledger starts with explicit read scope and no invented private facts", () => {
  it("offers all fifteen actual record types to a FinanceRead-only operator without payment or correction controls", () => {
    const html = render();
    for (const kind of FinanceLedgerKindSchema.options) expect(html).toContain(`value="${kind}"`);
    expect(html).toContain("台账记录类型"); expect(html).toContain("所属记录 ID"); expect(html).toContain("查询记录 ID");
    expect(html).toContain("按真实 ID 读取详情");
    for (const mutation of ["登记付款证据", "确认撤销本笔核销", "登记应付更正", "登记已发生退款证据"])
      expect(html).not.toContain(mutation);
  });
  it("states live ID ordering and never turns a current page into a full-ledger balance or historical snapshot", () => {
    const html = render(); expect(html).toContain("按登记编号倒序翻页"); expect(html).toContain("不是按发生时间排序");
    expect(html).toContain("不是财务快照"); expect(html).toContain("不用当前页求和或推断全量余额");
    expect(html).toContain("不受当前页或旧工作区条数限制"); expect(html).toContain("不发起付款、退款或任何更正");
  });
  it("distinguishes a not-yet-read page from a real empty result and keeps unready navigation disabled", () => {
    const html = render(); expect(html).toContain("尚未取得本页记录"); expect(html).toContain("等待有效查询");
    expect(html).not.toContain("本次查询范围没有可显示记录"); expect(html).not.toContain("本页已读取 0 笔");
    const nextButton = html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?读取下一页(?:(?!<\/button>)[\s\S])*?<\/button>/)?.[0];
    expect(nextButton).toBeDefined(); expect(nextButton).toMatch(/^<button\b[^>]*\bdisabled=""/);
    expect(html).not.toContain("USD 0.00"); expect(html).not.toContain("未经银行认证的付款已完成");
  });
  it("does not present a parent filter as applicable to statement headers and starts without a private query or record ID", () => {
    const html = render(); expect(html).toMatch(/<input[^>]*id="finance-ledger-parent"[^>]*disabled=""/);
    expect(html).toContain("当前类型不支持所属筛选"); expect(html).toMatch(/id="finance-ledger-record-id"[^>]*value=""/);
    expect(html).not.toContain("财务台账记录详情"); expect(html).not.toContain("本轮登记编号上界");
  });
  it("hides all private list, detail and query inputs when the session lacks FinanceRead even if it retains finance write or review", () => {
    for (const permissions of [[Permission.ProductRead], [Permission.FinanceWrite, Permission.FinanceReview]]) {
      const html = render(permissions); expect(html).toContain("当前没有财务读取权限"); expect(html).toContain("私有记录、所属筛选与输入已清除");
      expect(html).not.toContain('id="finance-ledger-kind"'); expect(html).not.toContain('id="finance-ledger-parent"');
      expect(html).not.toContain('id="finance-ledger-record-id"'); expect(html).not.toContain('aria-label="财务台账记录"');
    }
  });
  it("renders exact JPY, KWD and maximum safe original money without deriving totals from the current page", () => {
    const summary = FinanceLedgerSummarySchema.parse({ kind: "bills", id, parentId: supplierId, supplierId, reference: "SYNTHETIC", recordedAt: at,
      amountMinor: 9007199254740991, netAmountMinor: 9007199254740990, currency: "USD", status: "active" });
    const large = renderToStaticMarkup(<SummaryMoney row={summary} />); expect(large).toContain("USD 90071992547409.91"); expect(large).toContain("USD 90071992547409.90");
    expect(large).toContain("原登记金额"); expect(large).toContain("读取时净额");
    expect(renderToStaticMarkup(<SummaryMoney row={{ ...summary, amountMinor: 1234, netAmountMinor: 1233, currency: "JPY" }} />)).toContain("JPY 1233");
    expect(renderToStaticMarkup(<SummaryMoney row={{ ...summary, amountMinor: 1234, netAmountMinor: 1233, currency: "KWD" }} />)).toContain("KWD 1.233");
  });
  it("does not promote a profit summary into a verified total or turn absent summary money into zero", () => {
    const summary = FinanceLedgerSummarySchema.parse({ kind: "profit_runs", id, parentId, supplierId: null, reference: "SYNTHETIC", recordedAt: at,
      amountMinor: null, netAmountMinor: null, currency: "USD", status: null });
    const html = renderToStaticMarkup(<SummaryMoney row={summary} />); expect(html).toContain("利润摘要不提供核验金额"); expect(html).not.toContain("USD 0.00");
    const missing = renderToStaticMarkup(<SummaryMoney row={{ ...summary, kind: "statements" }} />); expect(missing).toContain("此摘要不提供单笔金额"); expect(missing).not.toContain("0.00");
  });
  it("keeps a current full-ledger bill balance separate from an immutable earlier adjustment execution balance", () => {
    const current = record({ kind: "bills", id, record: due(), children: [{ kind: "allocations", parentId: id }, { kind: "bill_adjustments", parentId: id }] });
    expect(current).toContain("本次读取的账面余额"); expect(current).toContain("USD 0.85"); expect(current).toContain("USD 1.00"); expect(current).toContain("不是按本页求和");
    const eventId = createEntityId(), earlier = record({ kind: "bill_adjustments", id: eventId, children: [], record: { id: eventId, billId: id, supplierId,
      currency: "USD", kind: "credit", amountMinor: 20, externalDocumentId: "SYNTHETIC-ACTUAL-CREDIT", evidenceReference: "Synthetic source evidence", occurredAt: at,
      reasonCode: "SUPPLIER_CORRECTION", procurementAdjustmentId: null, procurementReviewId: null, recordedAt: at,
      balanceAfter: { amountMinor: 100, creditMinor: 20, debitMinor: 0, voidedMinor: 0, netAmountMinor: 80, allocatedMinor: 0, outstandingMinor: 80, lifecycle: "active" } } });
    expect(earlier).toContain("该次执行时余额"); expect(earlier).toContain("不是当前余额"); expect(earlier).toContain("USD 0.80"); expect(earlier).not.toContain("USD 0.85");
  });
  it("keeps original contribution evidence visible without treating stored converted money as a complete profit result", () => {
    const html = record({ kind: "contributions", id, children: [], record: { id, runId: parentId, factId: createEntityId(), fxRateId: createEntityId(), bucket: "cost",
      sourceAmountMinor: 1234, sourceCurrency: "JPY", reportingAmountMinor: 823, reportingCurrency: "USD", effectSign: 1, factType: "production_cost", occurredAt: at,
      orderId: null, orderLineId: null, skuId: null, listingId: null, accountId: null, supplierId: null } });
    expect(html).toContain("JPY 1234"); expect(html).toContain("USD 8.23"); expect(html).toContain("原存储折算金额");
    expect(html).toContain("本页不重新计算"); expect(html).toContain("单行或当前页贡献不证明整个利润结果完整");
  });
  it("masks incomplete profit aggregates while retaining its actual missing FX diagnostics and fixed original source identifiers", () => {
    const html = record({ kind: "profit_runs", id, children: [{ kind: "contributions", parentId: id }], record: { id, metricId: parentId, metricVersionId: createEntityId(), metricVersion: 1,
      reportingCurrency: "USD", sourceIdentityVersion: 1, monetaryBasis: buildFinanceCalculationBasis(["JPY", "USD"]), status: "incomplete", revenueMinor: null, costMinor: null,
      profitMinor: null, marginBps: null, statementIds: [supplierId], fxRateIds: [], diagnostics: { missingFactTypes: [], missingFxPairs: ["JPY/USD"], unclassifiedFactTypes: [],
        sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] }, monetary: { unknownCurrencies: [], ambiguousFxRateIds: [] } }, inputChecksum: "a".repeat(64), calculatedAt: at, breakdowns: [] } });
    expect(html).toContain("该次计算仍待完整核对 不作为完整利润"); expect(html).toContain("JPY/USD"); expect(html).toContain(supplierId);
    expect(html).toContain("不拼接当前分页贡献重新验证或计算总额"); expect(html).not.toContain("USD 0.00"); expect(html).not.toContain("原完整计算服务已核对该次计算依据");
  });
  it("displays the exact original FX fraction and marks an absent historical unit basis explicitly", () => {
    const html = record({ kind: "fx_rates", id, children: [], record: { id, source: "SYNTHETIC-EXACT-FX", baseCurrency: "JPY", quoteCurrency: "USD",
      rateNumerator: 1, rateDenominator: 150, effectiveAt: at, retrievedAt: at, recordedAt: at, checksum: "a".repeat(64), monetaryBasis: null } });
    expect(html).toContain("1 / 150"); expect(html).toContain("历史汇率单位依据待核对"); expect(html).toContain("不推测主单位或最小单位");
    expect(html).not.toContain("0.006666");
  });
  it("retains unsupported actual procurement IDs and authorized bill currency without manufacturing a zero-money approved source", () => {
    const reviewId = createEntityId(), html = record({ kind: "procurement_adjustments", id, billCurrency: "KWD", children: [], record: {
      billId: parentId, procurementAdjustmentId: id, procurementReviewId: reviewId, code: "source_format_not_supported" } });
    expect(html).toContain(parentId); expect(html).toContain(id); expect(html).toContain(reviewId); expect(html).toContain("KWD");
    expect(html).toContain("来源格式无法精确同步"); expect(html).toContain("不捏造可同步金额"); expect(html).not.toContain("KWD 0.000");
  });
});
