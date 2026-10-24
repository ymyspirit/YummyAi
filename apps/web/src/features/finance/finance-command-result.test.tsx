import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import type { FinanceCommandKind } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandRecordedResultSchema, FinanceCommandResultPageSchema } from "@yummyai/contracts/finance/finance-command-result";
import { FINANCE_COST_ALLOCATION_ALGORITHM, splitFinanceCostMinor } from "@yummyai/contracts/finance/cost-allocation";
import { buildFinanceCalculationBasis } from "@yummyai/contracts/finance/monetary";
import { ErpIdentityContext } from "../identity/erp-access";
import { FinanceCommandRecordedHeader, FinanceCommandResultEntries, FinanceCommandResultReader } from "./finance-command-result";

const commandId = createEntityId(), actualId = createEntityId(), targetId = createEntityId(), supplierId = createEntityId(), contributionId = createEntityId();
const at = "2026-07-03T00:00:00.100Z", hash = "a".repeat(64);
function header(kind: FinanceCommandKind, record: unknown, collections: Array<{ section: string; total: number }> = []) {
  const versioned = kind === "cost_version_approve";
  return FinanceCommandRecordedResultSchema.parse({ commandId, kind, targetId: ["payment_adjustment_record", "bill_adjustment_record", "profit_calculate"].includes(kind) ? targetId : null,
    result: { kind, id: actualId, parentId: versioned ? targetId : null, version: versioned ? 1 : null }, executedAt: at,
    recorded: { kind, record, ...(["bill_record", "payment_record"].includes(kind) ? { balanceSnapshot: "not_saved" }
      : ["payment_adjustment_record", "bill_adjustment_record"].includes(kind) ? { balanceSnapshot: "saved_on_event" } : {}) },
    currentVerification: ["profit_calculate", "cost_version_approve"].includes(kind) ? { verified: false, checkedAt: at,
      problems: [kind === "cost_version_approve" ? "rule_superseded" : "financial_evidence_unverified"] } : null,
    collections, contextAuthority: "synthetic-history-authority", consistency: "immutable_execution" });
}
const refund = () => header("payment_adjustment_record", { id: actualId, paymentId: targetId, supplierId, currency: "USD", kind: "refund", amountMinor: 20,
  externalDocumentId: "SYNTHETIC-OLD-REFUND", evidenceReference: "SYNTHETIC-REFUND-EVIDENCE", occurredAt: at, reasonCode: "SYNTHETIC",
  evidenceStatus: "operator_recorded", recordedAt: at, balanceAfter: { amountMinor: 100, refundedMinor: 20, voidedMinor: 0,
    netAmountMinor: 80, allocatedMinor: 0, unallocatedMinor: 80, lifecycle: "active" } });
const source = () => ({ rootFactId: targetId, contributionId, factId: targetId, statementId: supplierId, statementChecksum: hash,
  sourceEntryId: "SYNTHETIC-ORIGINAL-CARRIER-COMPONENT", factType: "carrier_cost", effectSign: 1, sourceCurrency: "JPY", sourceAmountMinor: 150,
  reportingCurrency: "USD", reportingAmountMinor: 1, fxRateId: commandId, sourceChainChecksum: hash });
const period = (index: number) => {
  const key = `${2018 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`;
  return { dimension: "period", key, label: `Original period ${key}`, orderId: null, orderLineId: null, skuId: null, listingId: null,
    accountId: null, spuId: null, catalogLinkId: null, period: key, periodStart: `${key}-01T00:00:00.000Z`,
    periodEnd: new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1)).toISOString(), basisChecksum: hash };
};
function sharesPage() {
  const targets = Array.from({ length: 101 }, (_, index) => period(index)), original = splitFinanceCostMinor(1, targets.map(row => ({ key: row.key, weight: "1" })));
  const items = original.slice(0, 100).map(({ key, ...share }, shareIndex) => ({ sourceIndex: 0, shareIndex, source: source(), share: { ...share, target: targets.find(row => row.key === key)! } }));
  return FinanceCommandResultPageSchema.parse({ commandId, result: { kind: "cost_version_approve", id: actualId, parentId: targetId, version: 1 }, section: "cost_shares",
    items, limit: 100, offset: 0, total: 101, hasMore: true, nextCursor: Buffer.from(JSON.stringify({ v: 1, scope: hash, offset: 100,
      anchor: `share:0:99:${contributionId}:${targets[99]!.key}` })).toString("base64url"), contextAuthority: "synthetic-history-authority", consistency: "immutable_execution" });
}
function rootPage(section: string, kind: FinanceCommandKind, items: unknown[]) {
  return FinanceCommandResultPageSchema.parse({ commandId, result: { kind, id: actualId, parentId: null, version: null }, section,
    items, limit: 25, offset: 0, total: items.length, hasMore: false, nextCursor: null, contextAuthority: "synthetic-history-authority", consistency: "immutable_execution" });
}

describe("historical execution result presentation keeps saved and current evidence separate", () => {
  it("shows the original refund balance, full event identity and exact time without presenting it as current or bank verified", () => {
    const html = renderToStaticMarkup(<FinanceCommandRecordedHeader value={refund()} />);
    for (const text of [commandId, actualId, targetId, "SYNTHETIC-OLD-REFUND", "USD 0.20", "USD 0.80", at]) expect(html).toContain(text);
    expect(html).toContain('aria-label="该次执行时余额"'); expect(html).toContain("不是当前余额 不是银行余额");
    expect(html).toContain("人工登记 未经银行认证"); expect(html).toContain('aria-label="当前依据核验"');
    expect(html).not.toContain("USD 0.70");
  });
  it("marks unsaved execution balances as unknown instead of inventing zero or borrowing the current payment ledger", () => {
    const payment = header("payment_record", { id: actualId, supplierId, externalPaymentId: "SYNTHETIC-OLD-PAYMENT", currency: "KWD", amountMinor: 1001,
      paidAt: at, method: "bank_transfer", evidenceReference: "SYNTHETIC-PAYMENT-REFERENCE", evidenceStatus: "operator_recorded", recordedAt: at });
    const html = renderToStaticMarkup(<FinanceCommandRecordedHeader value={payment} />);
    expect(html).toContain("KWD 1.001"); expect(html).toContain("原服务没有保存这次执行时余额 不补零 不以当前余额替代");
    expect(html).not.toContain('aria-label="该次执行时余额"'); expect(html).not.toContain("KWD 0.000");
  });
  it("retains the saved profit totals while visibly withdrawing today's verification and preserves unknown historical diagnostics", () => {
    const value = header("profit_calculate", { id: actualId, metricId: targetId, metricVersionId: supplierId, metricVersion: 1, reportingCurrency: "USD", status: "complete",
      revenueMinor: 1000, costMinor: 29, profitMinor: 971, marginBps: 9710, statementIds: [commandId], fxRateIds: [],
      diagnostics: { missingFactTypes: [], missingFxPairs: [], unclassifiedFactTypes: [] }, inputChecksum: hash, calculatedAt: at,
      monetaryBasis: buildFinanceCalculationBasis(["USD"]), sourceIdentityVersion: 1 }, [{ section: "contributions", total: 2 }]);
    const html = renderToStaticMarkup(<FinanceCommandRecordedHeader value={value} />);
    for (const text of ["原保存为完整", "USD 10.00", "USD 0.29", "USD 9.71", "当前依据待核对 原保存结果仍保留", "原财务证据当前未通过完整核验", "历史来源身份诊断未知 不当作零缺口"])
      expect(html).toContain(text);
    expect(html).not.toContain("原保存目标汇总"); expect(html).not.toContain("本次读取的依据核验通过");
  });
  it("keeps the complete original allocation approval pins and counters after a newer version without calling it current", () => {
    const value = header("cost_version_approve", { id: actualId, allocationId: targetId, versionNumber: 1, previousVersionId: null, status: "approved",
      checksum: hash, reviewedBy: supplierId, createdAt: at, sourceCount: 1, shareCount: 101,
      preview: { baseRunId: commandId, baseInputChecksum: hash, allocationId: null, expectedVersion: null, dimension: "period", method: "equal",
        algorithm: FINANCE_COST_ALLOCATION_ALGORITHM, reportingCurrency: "USD", reasonCode: "SYNTHETIC", basisDescription: "Original explicit101 periods", previewChecksum: hash } },
    [{ section: "cost_sources", total: 1 }, { section: "cost_shares", total: 101 }]);
    const html = renderToStaticMarkup(<FinanceCommandRecordedHeader value={value} />);
    for (const text of [actualId, targetId, hash, "Original explicit101 periods", "原批准展开份额数", "101", "原规则已有后续版本", "原批准预览校验值"])
      expect(html).toContain(text);
    expect(html).not.toContain("本次读取的依据核验通过");
  });
  it("renders every one of100 returned shares with original period snapshots, zero shares and exact tail integers", () => {
    const page = sharesPage(), html = renderToStaticMarkup(<FinanceCommandResultEntries page={page} />);
    expect(html.match(/aria-label="原批准份额 0:/g)).toHaveLength(100);
    for (const text of ["2018-01", "2026-04", "真实零份额 保留原权重与尾差依据", "1000000000", "101000000000", "获得1个最小单位尾差", "未获得额外尾差", "USD 0.00", "USD 0.01", hash])
      expect(html).toContain(text);
    expect(html).not.toContain("Original period 2026-05");
  });
  it("shows original source and reporting currencies separately with the exact source identity and FX pin", () => {
    const page = FinanceCommandResultPageSchema.parse({ ...sharesPage(), section: "cost_sources", items: [source()], limit: 25, total: 1, hasMore: false, nextCursor: null });
    const html = renderToStaticMarkup(<FinanceCommandResultEntries page={page} />);
    for (const text of ["JPY 150", "USD 0.01", "SYNTHETIC-ORIGINAL-CARRIER-COMPONENT", contributionId, commandId, hash]) expect(html).toContain(text);
    expect(html).not.toContain("JPY 1.50"); expect(html).not.toContain("原批准份额");
  });
  it("keeps maximum-safe JPY facts and unknown source-entry identity explicit instead of rounding or asserting deduplication", () => {
    const page = rootPage("facts", "statement_record", [{ id: targetId, statementId: actualId, accountId: null, lineKey: "SYNTHETIC-OLD-LINE", sourceEntryId: null,
      factType: "production_cost", direction: "debit", amountMinor: Number.MAX_SAFE_INTEGER, currency: "JPY", occurredAt: at,
      externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null, recordedAt: at }]);
    const html = renderToStaticMarkup(<FinanceCommandResultEntries page={page} />);
    expect(html).toContain("JPY 9007199254740991"); expect(html).toContain("历史来源条目标识未知 不冒称已去重");
    expect(html).toContain(targetId); expect(html).not.toContain("9007199254740991.00");
  });
  it("does not add today's released flag or make a bank refund claim to an original allocation entry", () => {
    const page = rootPage("allocations", "payment_allocate", [{ id: targetId, batchId: actualId, paymentId: commandId, billId: supplierId,
      supplierId, currency: "USD", amountMinor: 29, recordedAt: at }]);
    const html = renderToStaticMarkup(<FinanceCommandResultEntries page={page} />);
    expect(html).toContain("USD 0.29"); expect(html).toContain("不展示后来读取时的撤销状态");
    for (const value of [targetId, actualId, commandId, supplierId]) expect(html).toContain(value);
    expect(html).not.toContain("已退款"); expect(html).not.toContain("已撤销");
  });
  it("withholds the unit of a saved allocation slice until the original reporting currency is available", () => {
    const page = rootPage("slices", "allocated_profit_calculate", [{ id: targetId, runId: actualId, baseContributionId: contributionId, sourceFactId: supplierId,
      rootFactId: supplierId, allocationVersionId: null, target: null, amountMinor: 29, originalReportingAmountMinor: 29, bucket: "unclassified", effectSign: -1,
      factType: "carrier_cost", weight: null, floorMinor: null, remainderNumerator: null, remainderDenominator: null, receivesRemainder: false, createdAt: at }]);
    const unknown = renderToStaticMarkup(<FinanceCommandResultEntries page={page} />), known = renderToStaticMarkup(<FinanceCommandResultEntries page={page} reportingCurrency="KWD" />);
    expect(unknown).toContain("原报告币种未载入 不推测金额单位"); expect(unknown).not.toContain("USD 0.29");
    expect(known).toContain("KWD 0.029"); expect(known).toContain("尚未归属 未使用分摊版本"); expect(known).toContain("未分类");
    expect(known).not.toContain("原事实直接归属");
  });
  it.each([Permission.FinanceRead, Permission.FinanceReview])("offers own refund receipt read with %s and no preparation or execution controls", permission => {
    const value = refund(), session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: supplierId, userId: targetId,
      permissions: [permission], dataScope: "tenant", displayName: "Synthetic result reader", organizationName: "Synthetic isolated organization" };
    const html = renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}>
      <FinanceCommandResultReader commandId={commandId} kind={value.kind} targetId={value.targetId} result={value.result} executedAt={at} />
    </ErpIdentityContext.Provider>);
    expect(html).toContain('aria-label="历史执行结果"'); expect(html).toContain("读取历史执行结果");
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?读取历史执行结果<\/button>/);
    expect(html).not.toContain("确认执行原提交"); expect(html).not.toContain("保存原填写并核对"); expect(html).not.toContain("SYNTHETIC-OLD-REFUND");
  });
  it("clears the historical content and disables reading when the current kind authority is unavailable", () => {
    const value = refund(), session: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: supplierId, userId: targetId,
      permissions: [Permission.FinanceWrite], dataScope: "tenant", displayName: "Synthetic writer", organizationName: "Synthetic isolated organization" };
    const html = renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}>
      <FinanceCommandResultReader commandId={commandId} kind={value.kind} targetId={value.targetId} result={value.result} executedAt={at} />
    </ErpIdentityContext.Provider>);
    expect(html).toContain("当前没有核对这类本人历史结果的权限 已清除结果内容");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?读取历史执行结果<\/button>/);
    expect(html).not.toContain('aria-label="原保存结果"'); expect(html).not.toContain("USD 0.80");
  });
});
