import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { createEntityId } from "@yummyai/contracts";
import type { ErpSessionView } from "@yummyai/contracts/auth/session";
import type { PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { ErpIdentityContext } from "../identity/erp-access";
import { FinanceCommandWorkbench, financeCommandPermission } from "./finance-command-workbench";
import { FinanceCommandOriginalSummary, FinanceCommandResultSummary, OriginalRows, financeCommandNames } from "./finance-command-summary";
import { parseFinanceStatementTable } from "./finance-command-forms";

const at = "2026-07-15T00:00:00.000Z", key = "synthetic-finance-original", tenantId = createEntityId(), userId = createEntityId();
const statement = (): Extract<PrepareFinanceCommand, { kind: "statement_record" }> => ({ kind: "statement_record", targetId: null, input: {
  accountId: null, provider: "manual", sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-APPROVED-SOURCE" },
  statementKind: "operational_cost", externalStatementId: "合成原报表-001", periodStart: at, periodEnd: at, observedAt: at, sourceCurrency: "JPY", idempotencyKey: key,
  lines: [{ sourceEntryId: "SYNTHETIC-ORIGINAL-COMPONENT", lineKey: "LINE-1", factType: "production_cost", direction: "debit", amountMinor: Number.MAX_SAFE_INTEGER,
    currency: "JPY", occurredAt: at, externalReference: "原始引用", orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
    correctionKind: "original", correctsFactId: null }],
} });
function workbench(permissions: string[] | null) {
  const session: ErpSessionView | null = permissions === null ? null : { authenticated: true, canUseErp: true, tenantId, userId, permissions,
    dataScope: "tenant", displayName: "Synthetic Finance operator", organizationName: "Synthetic Finance organization" };
  return renderToStaticMarkup(<ErpIdentityContext.Provider value={{ session, localDevelopment: false, logout() {} }}><FinanceCommandWorkbench /></ErpIdentityContext.Provider>);
}
const tableColumns = ["lineKey", "sourceEntryId", "factType", "direction", "amountMinor", "currency", "occurredAt", "externalReference", "orderId", "orderLineId", "skuId", "listingId", "supplierId", "correctionKind", "correctsFactId"];
const tableRow = (line = "one", amount = "9007199254740991") => [line, `synthetic-${line}`, "production_cost", "debit", amount, "JPY", at, "合成原始引用", "", "", "", "", "", "original", ""].join("\t");

describe("finance original views preserve intent, immutable receipts and operation-only authority", () => {
  it("maps only four registration kinds to Write and the other eight actual decisions to Review", () => {
    const write = ["statement_record", "fx_rate_record", "bill_record", "payment_record"];
    expect(Object.keys(financeCommandNames)).toHaveLength(12);
    for (const kind of Object.keys(financeCommandNames) as Array<keyof typeof financeCommandNames>)
      expect(financeCommandPermission(kind)).toBe(write.includes(kind) ? Permission.FinanceWrite : Permission.FinanceReview);
  });
  it("keeps the personal recovery region available to Read-only users while withholding new write and review entries", () => {
    const html = workbench([Permission.FinanceRead]); expect(html).toContain('aria-label="本人财务原提交"');
    expect(html).toContain('aria-label="筛选本人财务原提交"'); expect(html).toContain("列表只载入摘要");
    expect(html).not.toMatch(/<button[^>]*>[\s\S]*?<\/svg>登记财务证据单<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>[\s\S]*?建立利润口径版本<\/button>/);
    expect(html).not.toContain("SYNTHETIC-ORIGINAL-COMPONENT");
  });
  it("offers statement and FX preparation with Write only without demanding FinanceRead", () => {
    const html = workbench([Permission.FinanceWrite]);
    expect(html).toContain('aria-label="新增财务原填写"'); expect(html).toMatch(/<button[^>]*>[\s\S]*?登记财务证据单<\/button>/);
    expect(html).toMatch(/<button[^>]*>[\s\S]*?登记历史汇率<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>[\s\S]*?建立利润口径版本<\/button>/); expect(html).not.toContain("当前没有读取本人财务原提交的权限");
  });
  it("offers metric and calculation preparation with Review only and clears private UI when all relevant authority is absent", () => {
    const html = workbench([Permission.FinanceReview]);
    expect(html).toMatch(/<button[^>]*>[\s\S]*?建立利润口径版本<\/button>/); expect(html).toMatch(/<button[^>]*>[\s\S]*?固定证据计算利润<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>[\s\S]*?登记财务证据单<\/button>/);
    for (const permissions of [[], null]) {
      const denied = workbench(permissions); expect(denied).toContain("私有填写与记录已清除"); expect(denied).not.toContain('aria-label="筛选本人财务原提交"');
      expect(denied).not.toContain('aria-label="新增财务原填写"');
    }
  });
  it("shows the retained source identity, component and exact JPY integer without a fabricated decimal or current-workspace substitution", () => {
    const html = renderToStaticMarkup(<FinanceCommandOriginalSummary original={statement()} />);
    expect(html).toContain("合成原报表-001"); expect(html).toContain("SYNTHETIC-APPROVED-SOURCE"); expect(html).toContain("SYNTHETIC-ORIGINAL-COMPONENT");
    expect(html).toContain("JPY 9007199254740991"); expect(html).not.toContain("9007199254740991.00");
    expect(html).toContain("不由当前业务列表回填或替换版本"); expect(html).toContain(key);
  });
  it("displays an original exact FX fraction and explicitly unknown omitted rate units without defaulting them", () => {
    const original: PrepareFinanceCommand = { kind: "fx_rate_record", targetId: null, input: { source: "SYNTHETIC.FX", baseCurrency: "JPY", quoteCurrency: "USD",
      rateNumerator: 1, rateDenominator: 150, effectiveAt: at, retrievedAt: at, idempotencyKey: key } };
    const html = renderToStaticMarkup(<FinanceCommandOriginalSummary original={original} />);
    expect(html).toContain("1 JPY = 1 / 150 USD"); expect(html).toContain("原请求未填写汇率单位"); expect(html).not.toContain("0.006666");
  });
  it("keeps fixed calculation IDs and version visible without silently choosing aggregate or the newest metric", () => {
    const metricId = createEntityId(), statementId = createEntityId(), rateId = createEntityId();
    const html = renderToStaticMarkup(<FinanceCommandOriginalSummary original={{ kind: "profit_calculate", targetId: metricId,
      input: { metricId, expectedMetricVersion: 3, statementIds: [statementId], fxRateIds: [rateId], idempotencyKey: key } }} />);
    for (const id of [metricId, statementId, rateId]) expect(html).toContain(id);
    expect(html).toContain("v3"); expect(html).toContain("不改为汇总"); expect(html).not.toContain("最新口径");
  });
  it("keeps a genuine procurement sync bound to its original adjustment and review IDs without inventing financial amounts", () => {
    const billId = createEntityId(), adjustmentId = createEntityId(), reviewId = createEntityId();
    const html = renderToStaticMarkup(<FinanceCommandOriginalSummary original={{ kind: "bill_adjustment_record", targetId: billId,
      input: { kind: "procurement_sync", expectedNetAmountMinor: 100, procurementAdjustmentId: adjustmentId, procurementReviewId: reviewId, idempotencyKey: key } }} />);
    for (const id of [adjustmentId, reviewId]) expect(html).toContain(id);
    expect(html).not.toContain("USD 1.00"); expect(html).not.toContain("已付款");
  });
  it("renders only an immutable version receipt and explicitly distinguishes it from current balances or bank outcomes", () => {
    const id = createEntityId(), parentId = createEntityId();
    const html = renderToStaticMarkup(<FinanceCommandResultSummary result={{ kind: "metric_upsert", id, parentId, version: 2 }} />);
    expect(html).toContain(id); expect(html).toContain(parentId); expect(html).toContain("v2"); expect(html).toContain('aria-label="实际不可变财务凭据"');
    expect(html).toContain("不表示银行转账、退款成功或当前完整余额"); expect(html).not.toContain('aria-label="当前实际余额"');
  });
  it("renders at most fifty original rows while preserving the honest complete count and an available next-page control", () => {
    const rows = Array.from({ length: 51 }, (_, index) => `SYNTHETIC-ROW-${String(index).padStart(3, "0")}`);
    const html = renderToStaticMarkup(<OriginalRows title="合成原始分录" rows={rows} render={row => <code>{row}</code>} />);
    expect(html).toContain("原文共 51 笔"); expect(html).toContain(rows[49]!); expect(html).not.toContain(rows[50]!);
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    const next = buttons.find(item => item[2]!.includes("下页原文")), previous = buttons.find(item => item[2]!.includes("上页原文"));
    expect(next).toBeDefined(); expect(next![1]).not.toContain("disabled"); expect(previous![1]).toContain("disabled");
    expect(html).toContain("原传输与保存正文完整");
  });
});

describe("exact retained statement TSV import", () => {
  it("parses BOM and CRLF while preserving every stable component ID, original date and maximum safe minor amount", () => {
    const rows = parseFinanceStatementTable(`\uFEFF${tableColumns.join("\t")}\r\n${tableRow()}\r\n${tableRow("zero", "0")}\r\n`);
    expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ sourceEntryId: "synthetic-one", lineKey: "one", amountMinor: Number.MAX_SAFE_INTEGER,
      currency: "JPY", occurredAt: at, orderId: null, correctionKind: "original", externalReference: "合成原始引用" });
    expect(rows[1]!.amountMinor).toBe(0);
  });
  it.each(["0.29", "01", "-1", "9007199254740992"])("rejects an invalid original minor amount %s instead of floating or rounding it", amount => {
    expect(() => parseFinanceStatementTable(`${tableColumns.join("\t")}\n${tableRow("bad", amount)}`)).toThrow("未导入任何分录");
  });
  it("rejects incomplete tables and a bad later row without returning a valid prefix or manufacturing source IDs", () => {
    expect(() => parseFinanceStatementTable(`${tableColumns.join(",")}\n${tableRow()}`)).toThrow("表头");
    expect(() => parseFinanceStatementTable(`${tableColumns.join("\t")}\n${tableRow()}\ninvalid\tpartial`)).toThrow("未导入任何分录");
    const cells = tableRow().split("\t"); cells[1] = "";
    expect(() => parseFinanceStatementTable(`${tableColumns.join("\t")}\n${cells.join("\t")}`)).toThrow("未导入任何分录");
    expect(() => parseFinanceStatementTable(`${tableColumns.join("\t")}\n${Array.from({ length: 20_001 }, (_, index) => tableRow(String(index), "1")).join("\n")}`)).toThrow("未裁剪行");
  });
});
