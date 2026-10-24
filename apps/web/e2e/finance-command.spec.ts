import { randomUUID } from "node:crypto";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { FinanceStatementViewSchema, type FinanceFactInput } from "@yummyai/contracts/finance";
import { FinanceCommandDetailSchema, FinanceCommandListSchema, FinanceCommandOriginalSchema, PrepareFinanceCommandSchema,
  type FinanceCommandDetail, type PrepareFinanceCommand } from "@yummyai/contracts/finance/finance-command";
import { FinancePayablePaymentViewSchema, FinancePayablesWorkspaceViewSchema } from "@yummyai/contracts/finance/payables";
import { FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { acknowledgeFinanceCommand, executeFinanceCommand, financeCommandConfirmation, financeCommandEndpoint as endpoint,
  financeCommandReview, prepareFinanceCommand, readFinanceCommandOriginal, readFinancePayableResult } from "./finance-command-fixture";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_COMMAND_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable finance original browser fixture required before connection");
const apiBase = process.env.API_BASE_URL!.replace(/\/$/, ""), key = () => `synthetic-finance-browser-${randomUUID()}`, at = "2026-07-15T00:00:00.100Z";
const allFinance = [Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview];
const rights = (original: string[], ...financial: string[]) => [...new Set([...original.filter(value => !allFinance.some(permission => permission === value)), ...financial])];
test.describe.configure({ mode: "serial" });

async function savedRights(account: "operator" | "readonly" = "operator") {
  const actor = actors()[account], connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic finance original role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}
async function api(path: string, body?: unknown) {
  const response = await fetch(`${apiBase}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof error?.code === "string" && /^[a-z_]{1,100}$/.test(error.code) ? error.code : "unavailable";
    throw new Error(`Synthetic finance original fixture failed ${response.status} ${path} ${code}`);
  }
  return response.json();
}
async function localTime(page: Page, iso: string) {
  return page.evaluate(value => { const date = new Date(value), pad = (part: number, width = 2) => String(part).padStart(width, "0");
    const formatted = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
    // Playwright compares the browser's normalized value verbatim, including fractional trailing zeros.
    const input = document.createElement("input"); input.type = "datetime-local"; input.step = "0.001"; input.value = formatted;
    if (!input.value) throw new Error("Synthetic local datetime cannot be represented");
    return input.value;
  }, iso);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator("dialog[open], .finance-command-review, .finance-command-original, .finance-command-result").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function state(command: FinanceCommandDetail) {
  const actor = actors().operator, connection = connectDatabase();
  try {
    return await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, async tx => ({
      proofs: await tx.execute(sql`select kind,result_id,command_id,request_key,actor_id,target_id,parent_id,version,creation_transaction_id::text from finance_original_write_proofs where command_id=${command.id}::uuid order by result_id`),
      facts: await tx.execute(sql`select id,statement_id,line_key,source_entry_id,amount_minor::text,currency,occurred_at::text from finance_facts where statement_id=(select result_id from finance_commands where id=${command.id}::uuid) order by id`),
      audits: await tx.execute(sql`select id,action,entity_id from audit_events where entity_type='finance_command' and entity_id=${command.id}::uuid order by id`),
    }));
  } finally { await connection.client.end(); }
}
async function recover(page: Page, detail: FinanceCommandDetail) {
  const workbench = page.getByRole("region", { name: "本人财务原提交", exact: true });
  await workbench.getByLabel("原提交类型", { exact: true }).selectOption(detail.kind);
  await expect(workbench.getByRole("button", { name: "重新读取原提交", exact: true })).toBeEnabled();
  await workbench.getByLabel("固定业务目标筛选", { exact: true }).fill(detail.targetId ?? "root");
  const read = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === endpoint && response.request().method() === "GET"
    && url.searchParams.get("kind") === detail.kind && url.searchParams.get("targetId") === (detail.targetId ?? "root"); });
  await workbench.getByRole("button", { name: "读取此范围", exact: true }).click(); expect((await read).status()).toBe(200);
  const rows = workbench.locator(".finance-command-list > li"); await expect(rows).toHaveCount(1);
  await rows.getByRole("button", { name: "恢复原提交", exact: true }).click(); await expect(financeCommandReview(page)).toContainText(detail.id);
  const response = await page.request.get(`${endpoint}/${detail.id}`); expect(response.status()).toBe(200);
  return FinanceCommandDetailSchema.parse(await response.json());
}
function fact(amountMinor: number, revenue = false): FinanceFactInput {
  return { lineKey: key(), sourceEntryId: key(), factType: revenue ? "sale_revenue" : "production_cost", direction: revenue ? "credit" : "debit", amountMinor,
    currency: "USD", occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null, correctionKind: "original", correctsFactId: null };
}
async function fresh(contexts: BrowserContext[], page: Page, width = 1440) {
  const browser = page.context().browser(); if (!browser) throw new Error("Personal finance browser missing");
  const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width, height: width === 390 ? 844 : 1000 } });
  contexts.push(context); return context.newPage();
}

test("lost statement prepare and execute receipts recover exact originals in new personal sessions and a read-only user acknowledges the one immutable result", async ({ page }, info) => {
  const originalRights = await savedRights(), contexts: BrowserContext[] = [], errors: string[] = [], document = key(), component = key();
  const captured: { original?: PrepareFinanceCommand; prepared?: FinanceCommandDetail; completed?: FinanceCommandDetail } = {};
  const intercepts = { prepareStarted: false, prepareFinished: false, executeStarted: false, executeFinished: false };
  page.on("pageerror", error => errors.push(error.message));
  const losePrepare = async (route: Route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    intercepts.prepareStarted = true;
    try {
      captured.original = PrepareFinanceCommandSchema.parse(route.request().postDataJSON()); const response = await route.fetch({ timeout: 30_000 }); expect(response.status()).toBe(201);
      captured.prepared = FinanceCommandDetailSchema.parse(await response.json());
    } finally { try { await route.abort("connectionreset"); } finally { intercepts.prepareFinished = true; } }
  };
  try {
    await changeErpRights("operator", rights(originalRights, Permission.FinanceWrite)); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "operator", "/finance/originals"); await page.getByRole("button", { name: "登记历史汇率", exact: true }).click();
    const fxForm = page.getByRole("form", { name: "登记历史汇率", exact: true });
    await fxForm.getByLabel("汇率来源代码", { exact: true }).fill(`SYNTHETIC-COMMAND-${randomUUID().toUpperCase()}`);
    await fxForm.getByLabel("原始基准币种", { exact: true }).fill("USD"); await fxForm.getByLabel("原始报价币种", { exact: true }).fill("CNY");
    await fxForm.getByLabel("精确汇率分子", { exact: true }).fill("7"); await fxForm.getByLabel("精确汇率分母", { exact: true }).fill("1");
    const fxTime = await localTime(page, at); await fxForm.getByLabel("汇率实际生效时间", { exact: true }).fill(fxTime); await fxForm.getByLabel("汇率实际取得时间", { exact: true }).fill(fxTime);
    const fixedFx = await prepareFinanceCommand(page, fxForm); expect(fixedFx.original).toMatchObject({ kind: "fx_rate_record", targetId: null,
      input: { baseCurrency: "USD", quoteCurrency: "CNY", rateUnit: "major_to_major", rateNumerator: 7, rateDenominator: 1, effectiveAt: at, retrievedAt: at } });
    expect(await readFinanceCommandOriginal(page, fixedFx.detail)).toEqual(fixedFx.original); const recordedFx = await executeFinanceCommand(page, fixedFx.detail);
    expect((await state(recordedFx)).proofs).toHaveLength(1); await acknowledgeFinanceCommand(page, recordedFx);
    await page.getByRole("button", { name: "登记财务证据单", exact: true }).click();
    const form = page.getByRole("form", { name: "登记财务证据单", exact: true });
    await form.getByLabel("原外部单据编号", { exact: true }).fill(document); await form.getByLabel("单据来源币种", { exact: true }).fill("USD");
    const local = await localTime(page, at); for (const label of ["原期间开始", "原期间结束", "实际观察时间"]) await form.getByLabel(label, { exact: true }).fill(local);
    await form.getByLabel("真实来源名称", { exact: true }).fill("SYNTHETIC-COMMAND-APPROVED-SOURCE");
    const dirty = page.waitForEvent("dialog"), leaving = form.getByRole("button", { name: "返回实际记录", exact: true }).click();
    const confirmation = await dirty; expect(confirmation.type()).toBe("confirm"); await confirmation.dismiss(); await leaving;
    await expect(form).toBeVisible(); await expect(form.getByLabel("原外部单据编号", { exact: true })).toHaveValue(document);
    const columns = ["lineKey", "sourceEntryId", "factType", "direction", "amountMinor", "currency", "occurredAt", "externalReference", "orderId", "orderLineId", "skuId", "listingId", "supplierId", "correctionKind", "correctsFactId"];
    const rows = [29, 0].map((amount, index) => [`original-${index}`, `${component}-${index}`, "production_cost", "debit", String(amount), "USD", at, "", "", "", "", "", "", "original", ""].join("\t"));
    await form.getByText("从原表格完整导入分录", { exact: true }).click();
    await form.getByLabel("导入原分录表格 TSV", { exact: true }).setInputFiles({ name: "synthetic-approved-original.tsv", mimeType: "text/tab-separated-values", buffer: Buffer.from([columns.join("\t"), ...rows].join("\n")) });
    await expect(form.getByRole("region", { name: "原财务分录填写", exact: true })).toContainText("共 2 笔");
    await page.route(`**${endpoint}`, losePrepare);
    try {
      await form.getByRole("button", { name: "保存原填写并核对", exact: true }).click();
      await expect.poll(() => captured.prepared?.status, { timeout: 35_000 }).toBe("prepared");
      await expect.poll(() => intercepts.prepareFinished, { timeout: 35_000 }).toBe(true);
      await expect(form.getByRole("button", { name: "重试保存同一笔原提交", exact: true })).toBeEnabled();
      await expect(form).toContainText("准备响应尚未确认 原正文与原键已固定");
      await expect(form.locator("fieldset.record-fields")).toHaveAttribute("inert", "");
    } finally {
      try { if (intercepts.prepareStarted) await expect.poll(() => intercepts.prepareFinished, { timeout: 35_000 }).toBe(true); }
      finally { await page.unroute(`**${endpoint}`, losePrepare); }
    }
    const prepared = captured.prepared!; expect(prepared).toMatchObject({ kind: "statement_record", status: "prepared", result: null });
    if (captured.original?.kind !== "statement_record") throw new Error("Actual statement original missing");
    expect(captured.original.input.lines.map(line => [line.sourceEntryId, line.amountMinor, line.occurredAt])).toEqual([[`${component}-0`, 29, at], [`${component}-1`, 0, at]]);
    expect((await state(prepared)).proofs).toEqual([]);
    const resumed = await fresh(contexts, page); resumed.on("pageerror", error => errors.push(error.message));
    await loginErp(resumed, "operator", "/finance/originals"); await recover(resumed, prepared);
    expect(await readFinanceCommandOriginal(resumed, prepared)).toEqual(captured.original); await expect(financeCommandReview(resumed)).toContainText("USD 0.00");
    const loseExecute = async (route: Route) => {
      intercepts.executeStarted = true;
      try { const response = await route.fetch({ timeout: 30_000 }); expect(response.status()).toBe(200);
        captured.completed = FinanceCommandDetailSchema.parse(await response.json()); }
      finally { try { await route.abort("connectionreset"); } finally { intercepts.executeFinished = true; } }
    };
    await resumed.route(`**${endpoint}/${prepared.id}/execute`, loseExecute);
    try {
      await financeCommandReview(resumed).getByLabel(financeCommandConfirmation, { exact: true }).check();
      await financeCommandReview(resumed).getByRole("button", { name: "确认执行原提交", exact: true }).click();
      await expect.poll(() => captured.completed?.status, { timeout: 35_000 }).toBe("succeeded");
      await expect.poll(() => intercepts.executeFinished, { timeout: 35_000 }).toBe(true);
      await expect(financeCommandReview(resumed)).toContainText("本次处理结果未知");
      await expect(financeCommandReview(resumed)).toHaveAttribute("aria-busy", "false");
      await expect(financeCommandReview(resumed).getByRole("button", { name: "确认执行原提交", exact: true })).toBeDisabled();
    } finally {
      try { if (intercepts.executeStarted) await expect.poll(() => intercepts.executeFinished, { timeout: 35_000 }).toBe(true); }
      finally { await resumed.unroute(`**${endpoint}/${prepared.id}/execute`, loseExecute); }
    }
    const completed = captured.completed!, before = await state(completed); expect(before.proofs).toHaveLength(1); expect(before.facts).toHaveLength(2);
    expect(before.proofs[0]).toMatchObject({ command_id: prepared.id, request_key: prepared.requestKey, actor_id: actors().operator.userId, result_id: completed.result!.id });
    await changeErpRights("operator", rights(originalRights, Permission.FinanceRead)); const finalPage = await fresh(contexts, resumed);
    finalPage.on("pageerror", error => errors.push(error.message)); await loginErp(finalPage, "operator", "/finance/originals");
    const terminal = await recover(finalPage, prepared); expect(terminal).toMatchObject({ status: "succeeded", result: completed.result, canExecute: false });
    expect(await readFinanceCommandOriginal(finalPage, terminal)).toEqual(captured.original);
    const replay = await finalPage.request.post(`${endpoint}/${prepared.id}/execute`, { data: {}, headers: { origin: new URL(finalPage.url()).origin } });
    expect(replay.status()).toBe(200); expect(FinanceCommandDetailSchema.parse(await replay.json()).result).toEqual(completed.result);
    expect(await state(completed)).toEqual(before); await expect(financeCommandReview(finalPage).getByRole("button", { name: "确认执行原提交", exact: true })).toHaveCount(0);
    const result = financeCommandReview(finalPage).getByRole("region", { name: "实际不可变财务凭据", exact: true }); await expect(result).toContainText(completed.result!.id);
    await result.scrollIntoViewIfNeeded(); await noOverflow(finalPage); await finalPage.screenshot({ path: info.outputPath("finance-command-desktop.png"), fullPage: true, animations: "disabled" });
    await finalPage.setViewportSize({ width: 390, height: 844 }); await result.scrollIntoViewIfNeeded(); await noOverflow(finalPage);
    await finalPage.screenshot({ path: info.outputPath("finance-command-mobile.png"), fullPage: true, animations: "disabled" });
    await acknowledgeFinanceCommand(finalPage, terminal);
    const cleared = await finalPage.request.get(`${endpoint}/${prepared.id}/original`); expect(cleared.status()).toBe(200);
    expect(FinanceCommandOriginalSchema.parse(await cleared.json()).original).toBeNull();
    expect((await state(completed)).facts).toEqual(before.facts); expect((await state(completed)).proofs).toEqual(before.proofs); expect(errors).toEqual([]);
  } finally { try { await Promise.all(contexts.map(context => context.close())); } finally { await changeErpRights("operator", originalRights); } }
});

test("a Review-only personal user creates an actual immutable metric version and a fixed-evidence profit command without FinanceRead or FinanceWrite", async ({ page }) => {
  const originalRights = await savedRights();
  try {
    await changeErpRights("operator", rights(originalRights, Permission.FinanceWrite));
    const statement = FinanceStatementViewSchema.parse(await api("finance/statements", { accountId: null, provider: "manual", statementKind: "operational_cost",
      sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-FIXED-PROFIT-SOURCE" }, externalStatementId: key(), sourceCurrency: "USD",
      periodStart: at, periodEnd: at, observedAt: at, idempotencyKey: key(), lines: [fact(10000, true), fact(2900)] }));
    await changeErpRights("operator", rights(originalRights, Permission.FinanceReview)); await loginErp(page, "operator", "/finance/originals");
    await expect(page.getByRole("button", { name: "登记财务证据单", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "建立利润口径版本", exact: true }).click();
    await page.getByRole("form", { name: "选择利润口径原提交范围", exact: true }).getByRole("button", { name: "选择并读取口径原提交", exact: true }).click();
    const metricForm = page.getByRole("form", { name: "建立利润口径版本", exact: true });
    await metricForm.getByLabel("利润口径名称", { exact: true }).fill(key()); await metricForm.getByLabel("口径报告币种", { exact: true }).fill("USD");
    await metricForm.getByLabel("版本变更原因代码", { exact: true }).fill("SYNTHETIC-APPROVED-RULE");
    await metricForm.getByRole("group", { name: "收入事实类别", exact: true }).getByLabel("销售收入", { exact: true }).check();
    await metricForm.getByRole("group", { name: "成本事实类别", exact: true }).getByLabel("生产成本", { exact: true }).check();
    await metricForm.getByRole("group", { name: "必需事实类别", exact: true }).getByLabel("销售收入", { exact: true }).check();
    await metricForm.getByRole("group", { name: "必需事实类别", exact: true }).getByLabel("生产成本", { exact: true }).check();
    const metricPrepared = await prepareFinanceCommand(page, metricForm); expect(await readFinanceCommandOriginal(page, metricPrepared.detail)).toEqual(metricPrepared.original);
    const metric = await executeFinanceCommand(page, metricPrepared.detail); expect(metric.result).toMatchObject({ kind: "metric_upsert", version: 1 });
    expect(metric.result!.parentId).not.toBeNull(); expect(metric.result!.id).not.toBe(metric.result!.parentId); await acknowledgeFinanceCommand(page, metric);
    await page.getByRole("button", { name: "固定证据计算利润", exact: true }).click();
    const scope = page.getByRole("form", { name: "选择利润计算原提交范围", exact: true });
    await scope.getByLabel("真实利润口径 ID", { exact: true }).fill(metric.result!.parentId!); await scope.getByRole("button", { name: "选择并读取计算原提交", exact: true }).click();
    const profitForm = page.getByRole("form", { name: "固定证据计算利润", exact: true });
    await profitForm.getByLabel("固定利润口径版本", { exact: true }).fill("1"); await profitForm.getByLabel("利润覆盖维度", { exact: true }).selectOption("aggregate");
    await profitForm.getByLabel("固定财务证据单 ID", { exact: true }).fill(statement.id);
    const calculation = await prepareFinanceCommand(page, profitForm); expect(calculation.original).toMatchObject({ kind: "profit_calculate", targetId: metric.result!.parentId,
      input: { expectedMetricVersion: 1, statementIds: [statement.id], fxRateIds: [], coverageDimension: "aggregate" } });
    expect(await readFinanceCommandOriginal(page, calculation.detail)).toEqual(calculation.original); const completed = await executeFinanceCommand(page, calculation.detail);
    const before = await state(completed); expect(before.proofs).toHaveLength(1); expect(before.proofs[0]).toMatchObject({ result_id: completed.result!.id, command_id: completed.id, target_id: metric.result!.parentId });
    const connection = connectDatabase(), actor = actors().operator;
    try {
      const [actual] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" }, tx => tx.execute(sql`
        select status,revenue_minor::text,cost_minor::text,profit_minor::text,metric_version_id from finance_profit_runs where id=${completed.result!.id}::uuid`));
      expect(actual).toMatchObject({ status: "complete", revenue_minor: "10000", cost_minor: "2900", profit_minor: "7100", metric_version_id: metric.result!.id });
    } finally { await connection.client.end(); }
    await acknowledgeFinanceCommand(page, completed); expect((await state(completed)).proofs).toEqual(before.proofs);
  } finally { await changeErpRights("operator", originalRights); }
});

test("an existing payment form records through the original command and live reviewer withdrawal and a different actor cannot execute or read its private refund", async ({ page }) => {
  const originalRights = await savedRights(), readerRights = await savedRights("readonly"), contexts: BrowserContext[] = [], prefix = `FC-${randomUUID().slice(0, 8).toUpperCase()}`;
  try {
    await changeErpRights("operator", rights(originalRights, ...allFinance));
    const supplier = FulfillmentSupplierViewSchema.parse(await api("sourcing/suppliers", { name: `${prefix} Synthetic command supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }));
    await loginErp(page, "operator", "/finance/payables"); await page.getByRole("button", { name: "登记付款证据", exact: true }).click();
    const form = page.getByRole("form", { name: "登记付款证据", exact: true }); await form.getByLabel("供应商", { exact: true }).selectOption(supplier.id);
    await form.getByLabel("付款记录编号", { exact: true }).fill(`${prefix}-PAYMENT`); await form.getByLabel("付款币种", { exact: true }).selectOption("USD");
    await form.getByLabel("付款金额（主货币单位）", { exact: true }).fill("1.00"); await form.getByLabel("实际付款时间", { exact: true }).fill("2026-07-02T10:00");
    await form.getByLabel("付款证据流水标识", { exact: true }).fill(`${prefix}-EVIDENCE`);
    const prepared = await prepareFinanceCommand(page, form); expect(prepared.original.kind).toBe("payment_record");
    expect(await readFinanceCommandOriginal(page, prepared.detail)).toEqual(prepared.original); const completed = await executeFinanceCommand(page, prepared.detail);
    const actual = await readFinancePayableResult(page, completed, FinancePayablePaymentViewSchema); expect(actual).toMatchObject({ amountMinor: 100, refundedMinor: 0, netAmountMinor: 100, evidenceStatus: "operator_recorded" });
    await acknowledgeFinanceCommand(page, completed); const row = page.getByRole("row", { name: `付款证据 ${actual.externalPaymentId}`, exact: true });
    await row.getByRole("button", { name: "更正付款记录", exact: true }).click(); const refundForm = page.getByRole("form", { name: "登记付款更正", exact: true });
    await expect(refundForm.locator("fieldset.record-fields")).not.toHaveAttribute("inert");
    await expect(refundForm.locator("fieldset.record-fields")).toHaveAttribute("aria-disabled", "false");
    await expect(refundForm.getByRole("button", { name: "保存原填写并核对", exact: true })).toBeEnabled();
    await refundForm.getByLabel("已发生退款金额（主货币单位）", { exact: true }).fill("0.20");
    await refundForm.getByLabel("外部更正单据编号", { exact: true }).fill(`${prefix}-REFUND`); await refundForm.getByLabel("证据流水标识", { exact: true }).fill(`${prefix}-REFUND-EVIDENCE`);
    await refundForm.getByLabel("实际发生时间", { exact: true }).fill("2026-07-03T10:00"); await refundForm.getByLabel("原因代码", { exact: true }).fill("SYNTHETIC-REFUND");
    await expect(refundForm.getByLabel("已发生退款金额（主货币单位）", { exact: true })).toHaveValue("0.20");
    await expect(refundForm.getByLabel("外部更正单据编号", { exact: true })).toHaveValue(`${prefix}-REFUND`);
    await expect(refundForm.getByLabel("证据流水标识", { exact: true })).toHaveValue(`${prefix}-REFUND-EVIDENCE`);
    await expect(refundForm.getByLabel("实际发生时间", { exact: true })).toHaveValue("2026-07-03T10:00");
    await expect(refundForm.getByLabel("原因代码", { exact: true })).toHaveValue("SYNTHETIC-REFUND");
    const refund = await prepareFinanceCommand(page, refundForm); expect(refund.original).toMatchObject({ kind: "payment_adjustment_record", targetId: actual.id, input: { kind: "refund", amountMinor: 20, expectedNetAmountMinor: 100 } });
    expect(await readFinanceCommandOriginal(page, refund.detail)).toEqual(refund.original); const before = await state(refund.detail);
    await changeErpRights("operator", rights(originalRights, Permission.FinanceRead, Permission.FinanceWrite));
    await financeCommandReview(page).getByLabel(financeCommandConfirmation, { exact: true }).check();
    const denied = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${refund.detail.id}/execute` && response.request().method() === "POST");
    await financeCommandReview(page).getByRole("button", { name: "确认执行原提交", exact: true }).click(); expect((await denied).status()).toBe(403);
    await expect(financeCommandReview(page)).toHaveCount(0); await expect(page.getByText(`${prefix}-REFUND-EVIDENCE`, { exact: true })).toHaveCount(0);
    expect(await state(refund.detail)).toEqual(before);
    const workspaceReply = await page.request.get("/api/finance/payables/workspace"); expect(workspaceReply.status()).toBe(200);
    const workspace = FinancePayablesWorkspaceViewSchema.parse(await workspaceReply.json());
    expect(workspace.payments.find(item => item.id === actual.id)).toMatchObject({ amountMinor: 100, refundedMinor: 0, netAmountMinor: 100 }); expect(workspace.paymentAdjustments.filter(item => item.paymentId === actual.id)).toEqual([]);
    await changeErpRights("readonly", rights(readerRights, Permission.FinanceRead)); const other = await fresh(contexts, page); await loginErp(other, "readonly", "/finance/originals");
    for (const suffix of ["", "/original"]) { const response = await other.request.get(`${endpoint}/${refund.detail.id}${suffix}`); expect(response.status()).toBe(404); expect(await response.text()).not.toContain(`${prefix}-REFUND`); }
    const otherList = await other.request.get(`${endpoint}?kind=payment_adjustment_record&targetId=${actual.id}`); expect(otherList.status()).toBe(200); expect(FinanceCommandListSchema.parse(await otherList.json()).items).toEqual([]);
    await changeErpRights("operator", rights(originalRights, Permission.FinanceRead)); const reader = await fresh(contexts, page); await loginErp(reader, "operator", "/finance/originals");
    const retained = await recover(reader, refund.detail); expect(retained).toMatchObject({ status: "prepared", canExecute: false, canCancel: true });
    expect(await readFinanceCommandOriginal(reader, retained)).toEqual(refund.original);
    await expect(financeCommandReview(reader).getByRole("button", { name: "确认执行原提交", exact: true })).toHaveCount(0);
    const cancelled = reader.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${retained.id}/cancel` && response.request().method() === "POST");
    await financeCommandReview(reader).getByRole("button", { name: "取消这笔准备", exact: true }).click(); const response = await cancelled; expect(response.status()).toBe(200);
    const terminal = FinanceCommandDetailSchema.parse(await response.json()); expect(terminal).toMatchObject({ status: "cancelled", result: null, originalRetained: false });
    await acknowledgeFinanceCommand(reader, terminal); expect((await state(refund.detail)).proofs).toEqual([]);
  } finally { try { await Promise.all(contexts.map(context => context.close())); }
    finally { try { await changeErpRights("operator", originalRights); } finally { await changeErpRights("readonly", readerRights); } } }
});
