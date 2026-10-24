import { createHash, randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Locator, type Page, type Response as BrowserResponse, type Route } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceStatementViewSchema } from "@yummyai/contracts/finance";
import { FinanceCommandDetailSchema, type FinanceCommandDetail, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { FinanceCommandRecordedResultSchema, FinanceCommandResultPageSchema, type FinanceCommandRecordedResult,
  type FinanceCommandResultPage } from "@yummyai/contracts/finance/finance-command-result";
import { FinanceCostAllocationPreviewViewSchema, FinanceCostAllocationVersionViewSchema } from "@yummyai/contracts/finance/cost-allocation";
import { FinancePaymentAdjustmentViewSchema } from "@yummyai/contracts/finance/payables-adjustments";
import { FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { financeCommandEndpoint as endpoint, financeCommandReview } from "./finance-command-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COMMAND_ISOLATED !== "1" || process.env.E2E_FINANCE_COMMAND_RESULT_ISOLATED !== "1"
  || process.env.WEB_AUTH_MODE !== "personal" || !["postgres:", "postgresql:"].includes(databaseUrl.protocol)
  || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Recorded finance result browser requires its dedicated personal disposable runner before connection");
const apiBase = process.env.API_BASE_URL!.replace(/\/$/, ""), at = "2026-07-03T00:00:00.100Z";
const key = () => `SYNTHETIC-HISTORY-${randomUUID().toUpperCase()}`;
const financePermissions = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
const rights = (original: string[], ...granted: string[]) => [...new Set([...original.filter(value => !financePermissions.some(permission => permission === value)), ...granted])];
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown, status = body === undefined ? 200 : 201) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status !== status) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof value?.code === "string" && /^[a-z_]{1,110}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic historical finance fixture ${response.status} ${path} ${code}`);
  }
  return response.json() as Promise<unknown>;
}
async function savedRights(account: "operator" | "readonly" = "operator") {
  const actor = actors()[account], database = connectDatabase();
  try {
    const [row] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic historical finance role missing"); return [...row.permissions];
  } finally { await database.client.end(); }
}
async function complete(original: PrepareFinanceCommand) {
  const prepared = FinanceCommandDetailSchema.parse(await api("finance/commands", original));
  const done = FinanceCommandDetailSchema.parse(await api(`finance/commands/${prepared.id}/execute`, {}, 200));
  expect(done).toMatchObject({ status: "succeeded", kind: original.kind, targetId: original.targetId }); expect(done.result).not.toBeNull();
  const recorded = FinanceCommandRecordedResultSchema.parse(await api(`finance/commands/${done.id}/result`));
  const acknowledged = FinanceCommandDetailSchema.parse(await api(`finance/commands/${done.id}/acknowledge`, {}, 200));
  expect(acknowledged).toMatchObject({ acknowledged: true, originalRetained: false, result: done.result });
  return { done: acknowledged, recorded };
}
function execution(value: FinanceCommandRecordedResult) {
  const { currentVerification, contextAuthority, ...immutable } = value; void currentVerification; void contextAuthority; return immutable;
}
async function fresh(contexts: BrowserContext[], page: Page, width = 1440) {
  const browser = page.context().browser(); if (!browser) throw new Error("Synthetic personal browser missing");
  const context = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3130", viewport: { width, height: width === 390 ? 844 : 1000 } });
  contexts.push(context); return context.newPage();
}
async function closeContexts(contexts: BrowserContext[]) {
  const closed = await Promise.allSettled(contexts.map(context => context.close()));
  if (closed.some(result => result.status === "rejected")) throw new Error("Synthetic personal browser context did not close");
}
function observe(page: Page) {
  const writes: string[] = [], privateReads: string[] = [], recalculations: string[] = [], errors: string[] = [];
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/finance") && request.method() === "POST") writes.push(path);
    if (path.startsWith(endpoint) && path.endsWith("/original")) privateReads.push(path);
    if (path.startsWith("/api/finance") && /preview|profit-runs|cost-allocations/.test(path)) recalculations.push(path);
  });
  page.on("pageerror", error => errors.push(error.message)); return { writes, privateReads, recalculations, errors };
}
async function state() {
  const actor = actors().operator, database = connectDatabase();
  try {
    return await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, async tx => {
      const output: Record<string, { count: number; digest: string }> = {};
      for (const table of ["finance_commands", "finance_original_write_proofs", "finance_statements", "finance_statement_source_lines", "finance_facts",
        "finance_fx_rates", "finance_profit_metrics", "finance_profit_metric_versions", "finance_profit_runs", "finance_profit_contributions",
        "finance_payable_payments", "finance_payment_adjustments", "finance_cost_allocation_versions", "finance_allocated_profit_runs", "finance_allocated_profit_slices", "audit_events"]) {
        const rows = await tx.execute(sql`select to_jsonb(t) as value from ${sql.identifier(table)} t order by to_jsonb(t)::text`);
        output[table] = { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
      }
      return output;
    });
  } finally { await database.client.end(); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator("dialog[open], .finance-history-result, .finance-history-section, .finance-history-pairs").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function openCommand(page: Page, done: FinanceCommandDetail, historyList = false) {
  const workbench = page.getByRole("region", { name: "本人财务原提交", exact: true });
  if (historyList) {
    const list = page.waitForResponse(reply => { const url = new URL(reply.url()); return url.pathname === endpoint && url.searchParams.get("view") === "recorded"; });
    await workbench.getByRole("button", { name: "已登记结果", exact: true }).click(); expect((await list).status()).toBe(200);
    await expect(workbench.getByRole("button", { name: "已登记结果", exact: true })).toHaveAttribute("aria-pressed", "true");
    const row = workbench.locator(".finance-command-list > li").filter({ hasText: done.id }); await expect(row).toHaveCount(1);
    await expect(row).toContainText("原填写已确认清除 历史结果仍可核对"); await row.getByRole("button", { name: "核对历史结果", exact: true }).click();
  } else {
    const form = workbench.getByRole("form", { name: "按原提交 ID 读取", exact: true });
    await form.getByLabel("原提交 ID", { exact: true }).fill(done.id); await form.getByRole("button", { name: "按原提交 ID 读取", exact: true }).click();
  }
  await expect(financeCommandReview(page)).toContainText(done.id);
  await expect(financeCommandReview(page).getByRole("button", { name: "读取原填写并核对", exact: true })).toHaveCount(0);
  const history = page.getByRole("region", { name: "历史执行结果", exact: true });
  const read = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/${done.id}/result` && reply.request().method() === "GET");
  await history.getByRole("button", { name: "读取历史执行结果", exact: true }).click();
  const response = await read; expect(response.status()).toBe(200); const value = FinanceCommandRecordedResultSchema.parse(await response.json());
  await expect(history.getByRole("region", { name: "原保存结果", exact: true })).toContainText(done.result!.id);
  return { history, value };
}

test("new personal Write-only and Review-only sessions inspect original payment and refund balances after ack and a later refund without new writes", async ({ page }, info) => {
  const original = await savedRights(), readerRights = await savedRights("readonly"), contexts: BrowserContext[] = [];
  try {
    await changeErpRights("operator", rights(original, ...financePermissions));
    const supplier = FulfillmentSupplierViewSchema.parse(await api("sourcing/suppliers", { name: key(), kind: "manual", regionCode: "US", settlementCurrency: "USD" }));
    const payment = await complete({ kind: "payment_record", targetId: null, input: { supplierId: supplier.id, externalPaymentId: key(), currency: "USD", amountMinor: 100,
      paidAt: "2026-07-02T00:00:00.000Z", method: "bank_transfer", evidenceReference: key(), idempotencyKey: key() } });
    const refund = await complete({ kind: "payment_adjustment_record", targetId: payment.done.result!.id, input: { kind: "refund", expectedNetAmountMinor: 100, amountMinor: 20,
      externalDocumentId: key(), evidenceReference: key(), occurredAt: at, reasonCode: "SYNTHETIC", idempotencyKey: key() } });
    const later = FinancePaymentAdjustmentViewSchema.parse(await api(`finance/payables/payments/${payment.done.result!.id}/adjustments`, { kind: "refund", expectedNetAmountMinor: 80,
      amountMinor: 10, externalDocumentId: key(), evidenceReference: key(), occurredAt: "2026-07-04T00:00:00.000Z", reasonCode: "SYNTHETIC", idempotencyKey: key() }));
    expect(later.balanceAfter).toMatchObject({ refundedMinor: 30, netAmountMinor: 70 });
    const before = await state();
    await changeErpRights("operator", rights(original, Permission.FinanceWrite));
    const writer = await fresh(contexts, page), writerTraffic = observe(writer); await loginErp(writer, "operator", "/finance/originals");
    const written = await openCommand(writer, payment.done, true);
    expect(execution(written.value)).toEqual(execution(payment.recorded));
    await expect(written.history).toContainText("USD 1.00"); await expect(written.history).toContainText("原服务没有保存这次执行时余额 不补零 不以当前余额替代");
    await expect(written.history.getByRole("region", { name: "该次执行时余额", exact: true })).toHaveCount(0);
    expect(writerTraffic).toEqual({ writes: [], privateReads: [], recalculations: [], errors: [] });

    await changeErpRights("operator", rights(original, Permission.FinanceReview));
    const reviewer = await fresh(contexts, page), reviewerTraffic = observe(reviewer); await loginErp(reviewer, "operator", "/finance/originals");
    const historical = await openCommand(reviewer, refund.done);
    expect(execution(historical.value)).toEqual(execution(refund.recorded));
    const balance = historical.history.getByRole("region", { name: "该次执行时余额", exact: true });
    await expect(balance).toContainText("USD 0.20"); await expect(balance).toContainText("USD 0.80"); await expect(balance).not.toContainText("USD 0.70");
    await expect(balance).toContainText("不是当前余额 不是银行余额");
    await expect(historical.history).toContainText("本结果没有分页明细 结果头已读取");
    await balance.scrollIntoViewIfNeeded(); await expect(balance).toBeInViewport(); await noOverflow(reviewer);
    await reviewer.screenshot({ path: info.outputPath("finance-historical-balance-desktop.png"), fullPage: false, animations: "disabled" });
    await reviewer.setViewportSize({ width: 390, height: 844 }); await balance.scrollIntoViewIfNeeded(); await expect(balance).toBeInViewport(); await noOverflow(reviewer);
    await reviewer.screenshot({ path: info.outputPath("finance-historical-balance-mobile.png"), fullPage: false, animations: "disabled" });
    await reviewer.reload(); const refreshed = await openCommand(reviewer, refund.done, true); expect(execution(refreshed.value)).toEqual(execution(refund.recorded));
    expect(reviewerTraffic).toEqual({ writes: [], privateReads: [], recalculations: [], errors: [] });

    await changeErpRights("readonly", rights(readerRights, Permission.FinanceRead)); const other = await fresh(contexts, page); await loginErp(other, "readonly", "/finance/originals");
    const foreign = await other.request.get(`${endpoint}/${refund.done.id}/result`); expect(foreign.status()).toBe(404); expect(await foreign.text()).not.toContain("SYNTHETIC-REFUND");
    // Keep ERP's original nonfinance rights while withdrawing this operation.
    await changeErpRights("operator", rights(original, Permission.FinanceWrite));
    const forbidden = reviewer.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/${refund.done.id}/result` && reply.status() === 403);
    await refreshed.history.getByRole("button", { name: "重新读取历史执行结果", exact: true }).click(); await forbidden;
    await expect(reviewer.getByRole("region", { name: "原保存结果", exact: true })).toHaveCount(0);
    await expect(reviewer.getByRole("region", { name: "该次执行时余额", exact: true })).toHaveCount(0);
    expect(reviewerTraffic.writes).toEqual([]); expect(reviewerTraffic.privateReads).toEqual([]);
    expect(await state()).toEqual(before);
  } finally {
    try { await closeContexts(contexts); }
    finally { try { await changeErpRights("operator", original); } finally { await changeErpRights("readonly", readerRights); } }
  }
});

async function largeApproval() {
  const fact = (factType: "sale_revenue" | "production_cost" | "carrier_cost", amountMinor: number) => ({ lineKey: key(), sourceEntryId: key(), factType,
    direction: factType === "sale_revenue" ? "credit" as const : "debit" as const, amountMinor, currency: "USD", occurredAt: at, externalReference: null,
    orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original" as const, correctsFactId: null });
  const statement = FinanceStatementViewSchema.parse(await api("finance/statements", { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-HISTORICAL-COST" },
    accountId: null, provider: "manual", statementKind: "operational_cost", externalStatementId: key(), periodStart: at, periodEnd: at, observedAt: at,
    sourceCurrency: "USD", lines: [fact("sale_revenue", 1000), fact("production_cost", 100), fact("carrier_cost", 1)], idempotencyKey: key() }));
  const root = statement.lines.find(line => line.factType === "carrier_cost")!;
  const metric = FinanceProfitMetricViewSchema.parse(await api("finance/profit-metrics", { metricId: null, name: key(), reportingCurrency: "USD",
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost", "carrier_cost"], requiredFactTypes: ["sale_revenue", "production_cost", "carrier_cost"],
    reasonCode: "SYNTHETIC", idempotencyKey: key() }));
  const base = FinanceProfitRunViewSchema.parse(await api("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [],
    coverageDimension: "aggregate", idempotencyKey: key() })); expect(base.status).toBe("complete");
  const keys = Array.from({ length: 101 }, (_, index) => `${2018 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, "0")}`);
  const input = { baseRunId: base.id, baseInputChecksum: base.inputChecksum, allocationId: null, expectedVersion: null, dimension: "period" as const, method: "equal" as const,
    sources: [{ rootFactId: root.id, targets: keys.map(value => ({ key: value, weight: "1" })) }], reasonCode: "SYNTHETIC", basisDescription: "Original explicit101 real UTC periods Equal weights One reporting minor retained with100 zero shares" };
  const preview = FinanceCostAllocationPreviewViewSchema.parse(await api("finance/cost-allocations/preview", input, 200));
  const first = await complete({ kind: "cost_version_approve", targetId: null, input: { ...input, previewChecksum: preview.previewChecksum, idempotencyKey: key() } });
  const nextInput = { ...input, allocationId: first.done.result!.parentId!, expectedVersion: 1,
    sources: [{ rootFactId: root.id, targets: [{ key: "2026-07", weight: "1" }] }], basisDescription: "A later explicit approved version Do not replace the prior101 shares" };
  const nextPreview = FinanceCostAllocationPreviewViewSchema.parse(await api("finance/cost-allocations/preview", nextInput, 200));
  const second = await complete({ kind: "cost_version_approve", targetId: first.done.result!.parentId!, input: { ...nextInput, previewChecksum: nextPreview.previewChecksum, idempotencyKey: key() } });
  const actual = FinanceCostAllocationVersionViewSchema.parse(await api(`finance/cost-allocations/versions/${first.done.result!.id}`));
  expect(actual.preview).toEqual(preview); expect(actual.versionNumber).toBe(1); expect(second.done.result!.version).toBe(2);
  return { ...first, preview, keys };
}
const isSharePage = (reply: { url(): string }, id: string, limit: number, cursor?: string) => {
  const url = new URL(reply.url()); return url.pathname === `${endpoint}/${id}/result/entries` && url.searchParams.get("section") === "cost_shares"
    && url.searchParams.get("limit") === String(limit) && url.searchParams.get("cursor") === (cursor ?? null);
};
async function readyResultControl(section: Locator, control: Locator) {
  await expect(section).toHaveAttribute("aria-busy", "false");
  await expect(control).toBeEnabled();
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport();
}
async function readFromResultControl(page: Page, section: Locator, control: Locator,
  matches: (response: BrowserResponse) => boolean, action: () => Promise<unknown> = () => control.click()) {
  await readyResultControl(section, control);
  const captured: { response?: BrowserResponse } = {};
  const receive = (response: BrowserResponse) => { if (!captured.response && matches(response)) captured.response = response; };
  page.on("response", receive);
  try {
    // Capture during the genuine action without starting a response timeout
    // before tracing, scrolling or actionability work has finished. There is
    // no orphaned promise; the same15s response bound begins after the action.
    await action();
    await expect.poll(() => Boolean(captured.response), { timeout: 15_000 }).toBe(true);
    if (!captured.response) throw new Error("Synthetic historical result response missing");
    return captured.response;
  } finally { page.off("response", receive); }
}

test("a new Review-only personal session reads all101 original approved shares after a newer version and treats a lost collection page as incomplete", async ({ page }, info) => {
  const original = await savedRights(), contexts: BrowserContext[] = []; let registered: { page: Page; pattern: string } | undefined;
  const drop = async (route: Route) => { await route.abort("connectionreset"); };
  try {
    await changeErpRights("operator", rights(original, ...financePermissions)); const large = await largeApproval(), before = await state();
    await changeErpRights("operator", rights(original, Permission.FinanceReview));
    const reader = await fresh(contexts, page), traffic = observe(reader); await loginErp(reader, "operator", "/finance/originals");
    const initialShares = reader.waitForResponse(reply => isSharePage(reply, large.done.id, 25));
    const initialSources = reader.waitForResponse(reply => { const url = new URL(reply.url()); return url.pathname === `${endpoint}/${large.done.id}/result/entries` && url.searchParams.get("section") === "cost_sources"; });
    const { history, value } = await openCommand(reader, large.done);
    expect(execution(value)).toEqual(execution(large.recorded)); expect(value.currentVerification).toMatchObject({ verified: false, problems: expect.arrayContaining(["rule_superseded"]) });
    await expect(history.getByRole("region", { name: "当前依据核验", exact: true })).toContainText("原规则已有后续版本");
    const sourceResponse = await initialSources; expect(sourceResponse.status()).toBe(200); const sourcePage = FinanceCommandResultPageSchema.parse(await sourceResponse.json());
    expect(sourcePage.items).toHaveLength(1); expect(sourcePage.items[0]).not.toHaveProperty("shares");
    const firstResponse = await initialShares; expect(firstResponse.status()).toBe(200); let current = FinanceCommandResultPageSchema.parse(await firstResponse.json());
    const pages: FinanceCommandResultPage[] = [current], section = history.getByRole("region", { name: "批准份额与尾差", exact: true });
    for (let step = 0; current.hasMore && step < 5; step++) {
      await expect(section).toContainText(`已读 ${current.offset + current.items.length}/101 条`);
      const cursor = current.nextCursor!, next = section.getByRole("button", { name: "批准份额与尾差读取下一页", exact: true });
      const response = await readFromResultControl(reader, section, next, reply => isSharePage(reply, large.done.id, 25, cursor));
      expect(response.status()).toBe(200); current = FinanceCommandResultPageSchema.parse(await response.json()); pages.push(current);
    }
    expect(pages.map(item => item.items.length)).toEqual([25, 25, 25, 25, 1]);
    const items = pages.flatMap(item => item.section === "cost_shares" ? item.items : []);
    expect(items).toEqual(large.preview.sources.flatMap((source, sourceIndex) => {
      const { shares, ...header } = source; return shares.map((share, shareIndex) => ({ sourceIndex, shareIndex, source: header, share }));
    }));
    expect(items.filter(item => item.share.amountMinor === 0)).toHaveLength(100);
    expect(items.reduce((sum, item) => sum + BigInt(item.share.amountMinor), 0n)).toBe(1n);
    await expect(section).toContainText("已读 101/101 条 · 本节全部读取完成"); await expect(history).toContainText("全部明细读取完成");
    await expect(section.getByRole("listitem", { name: "原批准份额 0:100", exact: true })).toContainText("2026-05");
    const saved = history.getByRole("region", { name: "原保存结果", exact: true }); await expect(saved).toContainText(large.preview.previewChecksum);
    await saved.scrollIntoViewIfNeeded(); await noOverflow(reader);
    await reader.screenshot({ path: info.outputPath("finance-historical-shares-desktop.png"), fullPage: false, animations: "disabled" });

    const limit = section.getByRole("combobox", { name: "批准份额与尾差每页条数", exact: true });
    const hundredResponse = await readFromResultControl(reader, section, limit, reply => isSharePage(reply, large.done.id, 100), () => limit.selectOption("100"));
    expect(hundredResponse.status()).toBe(200); const hundredPage = FinanceCommandResultPageSchema.parse(await hundredResponse.json());
    expect(hundredPage.items).toHaveLength(100); await expect(section).toContainText("已读 100/101 条");
    const path = `**${endpoint}/${large.done.id}/result/entries?*`, finalCursor = hundredPage.nextCursor!;
    const lostPage = section.getByRole("button", { name: "批准份额与尾差读取下一页", exact: true });
    await readyResultControl(section, lostPage);
    await reader.route(path, drop); registered = { page: reader, pattern: path };
    await lostPage.click();
    await expect(section).toContainText("本节读取失败 未完成"); await expect(section).not.toContainText("本节全部读取完成");
    await expect(history).not.toContainText("全部明细读取完成"); await expect(saved).toContainText(large.preview.previewChecksum);
    await reader.unroute(path, drop); registered = undefined;
    const retry = section.getByRole("button", { name: "批准份额与尾差重试未完成页", exact: true });
    const retryResponse = await readFromResultControl(reader, section, retry, reply => isSharePage(reply, large.done.id, 100, finalCursor));
    expect(retryResponse.status()).toBe(200); const final = FinanceCommandResultPageSchema.parse(await retryResponse.json());
    expect(final).toMatchObject({ offset: 100, total: 101, hasMore: false, nextCursor: null }); expect(final.items).toHaveLength(1);
    expect([...hundredPage.items, ...final.items]).toEqual(items);
    await expect(section).toContainText("已读 101/101 条 · 本节全部读取完成"); await expect(history).toContainText("全部明细读取完成");
    await reader.setViewportSize({ width: 390, height: 844 });
    const last = section.getByRole("listitem", { name: "原批准份额 0:100", exact: true }); await last.scrollIntoViewIfNeeded(); await expect(last).toBeInViewport();
    await expect(last).toContainText("真实零份额"); await expect(last).toContainText("USD 0.00");
    const approvedDetails = last.locator("details"), originalTarget = large.preview.sources[0]!.shares[100]!.target;
    await expect(approvedDetails).not.toHaveAttribute("open");
    await last.getByText("查看完整原批准依据", { exact: true }).click();
    await expect(approvedDetails).toHaveAttribute("open", "");
    const snapshot = approvedDetails.getByRole("region", { name: "原批准目标快照", exact: true });
    await expect(snapshot).toBeVisible(); expect(originalTarget.period).toBe("2026-05");
    await expect(snapshot.getByText("原 UTC 期间", { exact: true }).locator("..").locator("dd")).toHaveText("2026-05");
    await expect(snapshot.getByText("原目标依据校验值", { exact: true }).locator("..").locator("dd")).toHaveText(originalTarget.basisChecksum);
    await snapshot.scrollIntoViewIfNeeded(); await expect(snapshot).toBeInViewport(); await noOverflow(reader);
    await reader.screenshot({ path: info.outputPath("finance-historical-shares-mobile.png"), fullPage: false, animations: "disabled" });
    expect(traffic).toEqual({ writes: [], privateReads: [], recalculations: [], errors: [] }); expect(await state()).toEqual(before);
  } finally {
    try { if (registered) await registered.page.unroute(registered.pattern, drop); }
    finally { try { await closeContexts(contexts); } finally { await changeErpRights("operator", original); } }
  }
});
