import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { eq } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { FinanceStatementViewSchema, FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceWorkspaceViewSchema,
  type FinanceFactInput } from "@yummyai/contracts/finance";
import { FinanceLedgerDetailViewSchema, FinanceLedgerPageViewSchema, type FinanceLedgerKind } from "@yummyai/contracts/finance/ledger";
import { FinancePayableBillViewSchema, FinancePayablePaymentViewSchema, FinancePaymentAllocationBatchViewSchema,
  FinancePayablesWorkspaceViewSchema } from "@yummyai/contracts/finance/payables";
import { FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema } from "@yummyai/contracts/finance/payables-adjustments";
import { connectDatabase, roles, withTenant } from "@yummyai/database";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const target = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(target.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_LEDGER_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(target.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable complete ledger fixture required before connection");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), endpoint = "/api/finance/ledger", key = () => `synthetic-ledger-${randomUUID()}`;
const code = () => `LEDGER-${randomUUID().slice(0, 8).toUpperCase()}`, at = "2026-07-03T00:00:00.000Z";
test.describe.configure({ mode: "serial" });

async function api(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
    headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { code?: unknown } | null;
    const safe = typeof value?.code === "string" && /^[a-z_]{1,100}$/.test(value.code) ? value.code : "unavailable";
    throw new Error(`Synthetic ledger fixture failed ${response.status} ${path} ${safe}`);
  }
  return response.json();
}
async function savedRights() {
  const actor = actors().readonly, database = connectDatabase();
  try {
    const [role] = await withTenant(database.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!role) throw new Error("Synthetic ledger reader role missing"); return [...role.permissions];
  } finally { await database.client.end(); }
}
const readerRights = (original: string[]) => [...new Set([...original.filter(value => value !== Permission.FinanceWrite && value !== Permission.FinanceReview), Permission.FinanceRead])];
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const element of await page.locator("dialog[open], .finance-ledger-table, .finance-ledger-dialog").all())
    expect(await element.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
}
async function scope(page: Page, kind: FinanceLedgerKind, parentId?: string) {
  await page.getByLabel("台账记录类型", { exact: true }).selectOption(kind);
  if (parentId) {
    await page.getByLabel("所属记录 ID", { exact: true }).fill(parentId);
    const response = page.waitForResponse(reply => {
      const url = new URL(reply.url()); return url.pathname === `${endpoint}/${kind}` && url.searchParams.get("parentId") === parentId && !url.searchParams.has("cursor");
    });
    await page.getByRole("button", { name: "应用所属筛选", exact: true }).click(); const actual = await response;
    expect(actual.status()).toBe(200); const result = FinanceLedgerPageViewSchema.parse(await actual.json());
    await expect(page.locator(".finance-ledger-panel")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("table", { name: "财务台账记录", exact: true })).toBeVisible(); return result;
  }
  await expect(page.locator(".finance-ledger-panel")).toHaveAttribute("aria-busy", "false");
  const response = await page.request.get(`${endpoint}/${kind}?limit=25`); expect(response.status()).toBe(200); return FinanceLedgerPageViewSchema.parse(await response.json());
}
async function readId(page: Page, kind: FinanceLedgerKind, id: string) {
  await page.getByLabel("查询记录 ID", { exact: true }).fill(id);
  const read = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/${kind}/${id}`);
  await page.getByRole("button", { name: "按真实 ID 读取详情", exact: true }).click();
  const response = await read; expect(response.status()).toBe(200); const actual = FinanceLedgerDetailViewSchema.parse(await response.json());
  const dialog = page.getByRole("dialog", { name: "财务台账记录详情", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.locator(".finance-ledger-dialog")).toHaveAttribute("aria-busy", "false"); await expect(dialog).toContainText(id); return { actual, dialog };
}
async function closeDetail(page: Page) {
  await page.getByRole("dialog", { name: "财务台账记录详情", exact: true }).getByRole("button", { name: "返回财务台账", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "财务台账记录详情", exact: true })).toHaveCount(0);
}
async function supplier() {
  return await api("sourcing/suppliers", { name: `${code()} Synthetic ledger supplier`, kind: "manual", regionCode: "US", settlementCurrency: "USD" }) as { id: string };
}
async function bill(supplierId: string, amountMinor: number, currency = "USD") {
  return FinancePayableBillViewSchema.parse(await api("finance/payables/bills", { supplierId, kind: "factory_invoice", externalBillId: code(), currency, amountMinor,
    issuedAt: "2026-07-01T00:00:00.000Z", dueAt: null, procurementInvoiceId: null, idempotencyKey: key() }));
}
function fact(amountMinor: number, revenue = false, currency = "USD"): FinanceFactInput {
  return { sourceEntryId: key(), lineKey: key(), factType: revenue ? "sale_revenue" : "production_cost", direction: revenue ? "credit" : "debit", amountMinor, currency,
    occurredAt: "2026-07-15T00:00:00.000Z", externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
    correctionKind: "original", correctsFactId: null };
}
async function statement(lines: FinanceFactInput[], currency = "USD") {
  return FinanceStatementViewSchema.parse(await api("finance/statements", { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-LEDGER-BROWSER" },
    accountId: null, provider: "manual", statementKind: "operational_cost", externalStatementId: key(), sourceCurrency: currency,
    periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", observedAt: "2026-08-01T00:00:00.000Z", lines, idempotencyKey: key() }));
}

test("a personal read-only operator pages complete payable records and reads current net versus immutable earlier evidence at desktop and mobile widths", async ({ page }, info) => {
  const originalRights = await savedRights(), source = await supplier(), rows = [];
  for (let index = 0; index < 28; index++) rows.push(await bill(source.id, index ? 200 + index : 100));
  const original = rows[0]!, common = { expectedNetAmountMinor: 100, evidenceReference: "Synthetic actual supplier document", occurredAt: at, reasonCode: "SUPPLIER_CORRECTION" };
  const credit = FinanceBillAdjustmentViewSchema.parse(await api(`finance/payables/bills/${original.id}/adjustments`, { ...common, kind: "credit", amountMinor: 20, externalDocumentId: code(), idempotencyKey: key() }));
  await api(`finance/payables/bills/${original.id}/adjustments`, { ...common, expectedNetAmountMinor: 80, kind: "debit", amountMinor: 5, externalDocumentId: code(), idempotencyKey: key() });
  const paid = FinancePayablePaymentViewSchema.parse(await api("finance/payables/payments", { supplierId: source.id, externalPaymentId: code(), currency: "USD", amountMinor: 100,
    paidAt: "2026-07-02T00:00:00.000Z", method: "bank_transfer", evidenceReference: code(), idempotencyKey: key() }));
  const batch = FinancePaymentAllocationBatchViewSchema.parse(await api("finance/payables/allocations", { paymentId: paid.id, allocations: [{ billId: original.id, amountMinor: 85 }], idempotencyKey: key() }));
  const refund = FinancePaymentAdjustmentViewSchema.parse(await api(`finance/payables/payments/${paid.id}/adjustments`, { ...common, kind: "refund", amountMinor: 15,
    externalDocumentId: code(), idempotencyKey: key() }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await changeErpRights("readonly", readerRights(originalRights)); await page.setViewportSize({ width: 1440, height: 1000 }); await loginErp(page, "readonly", "/finance/ledger");
    await expect(page.getByRole("heading", { name: "完整财务台账查询", exact: true })).toBeVisible();
    const first = await scope(page, "bills", source.id); expect(first.items).toHaveLength(25); expect(first.hasMore).toBe(true);
    expect(first.items.map(row => row.id)).toEqual(rows.map(row => row.id).sort().reverse().slice(0, 25));
    await expect(page.getByRole("row", { name: `台账记录 ${original.externalBillId}`, exact: true })).toHaveCount(0);
    const next = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/bills` && new URL(reply.url()).searchParams.has("cursor"));
    await page.getByRole("button", { name: "读取下一页", exact: true }).click(); const nextResponse = await next; expect(nextResponse.status()).toBe(200);
    const second = FinanceLedgerPageViewSchema.parse(await nextResponse.json()); expect(second.items).toHaveLength(3); expect(second.upperBoundId).toBe(first.upperBoundId);
    expect([...first.items, ...second.items].map(row => row.id)).toEqual(rows.map(row => row.id).sort().reverse());
    await expect(page.getByRole("row", { name: `台账记录 ${original.externalBillId}`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回已读前页", exact: true }).click(); await expect(page.getByRole("row", { name: `台账记录 ${original.externalBillId}`, exact: true })).toHaveCount(0);
    const { actual, dialog } = await readId(page, "bills", original.id);
    expect(actual.record).toMatchObject({ amountMinor: 100, netAmountMinor: 85, creditMinor: 20, debitMinor: 5, allocatedMinor: 85, outstandingMinor: 0 });
    await expect(dialog).toContainText(original.externalBillId); await expect(dialog).toContainText("USD 0.85"); await expect(dialog).toContainText("USD 1.00");
    await expect(dialog.getByRole("button", { name: "读取应付更正凭据", exact: true })).toBeVisible(); await noOverflow(page);
    await expect(dialog.locator(".finance-ledger-dialog")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: info.outputPath("finance-ledger-desktop.png"), fullPage: false, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await expect(dialog.getByRole("heading", { name: "应付账单", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("finance-ledger-mobile.png"), fullPage: false, animations: "disabled" });
    await dialog.getByRole("button", { name: "读取应付更正凭据", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("台账记录类型", { exact: true })).toHaveValue("bill_adjustments");
    await expect(page.getByLabel("所属记录 ID", { exact: true })).toHaveValue(original.id);
    const old = await readId(page, "bill_adjustments", credit.id); expect(old.actual.record).toEqual(credit);
    await expect(old.dialog).toContainText("USD 0.80"); await expect(old.dialog).toContainText("该次执行"); await closeDetail(page);
    await scope(page, "payments", source.id); const actualPayment = await readId(page, "payments", paid.id);
    expect(actualPayment.actual.record).toMatchObject({ amountMinor: 100, refundedMinor: 15, netAmountMinor: 85, allocatedMinor: 85, unallocatedMinor: 0 });
    await closeDetail(page); await scope(page, "payment_adjustments", paid.id); expect((await readId(page, "payment_adjustments", refund.id)).actual.record).toEqual(refund); await closeDetail(page);
    const oldFinance = await page.request.get(`${base}/v1/finance/workspace`, { headers: { authorization: `Bearer ${process.env.API_ACCESS_TOKEN}` } });
    expect(oldFinance.status()).toBe(200); FinanceWorkspaceViewSchema.parse(await oldFinance.json());
    const oldPayables = await page.request.get("/api/finance/payables/workspace"); expect(oldPayables.status()).toBe(200);
    const saved = FinancePayablesWorkspaceViewSchema.parse(await oldPayables.json()); expect(saved.allocations.some(row => row.id === batch.allocations[0]!.id)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await changeErpRights("readonly", originalRights); }
});

test("statement facts and original profit contributions use their own child pages without implying that a profit summary is verified", async ({ page }) => {
  const originalRights = await savedRights(), selected = await statement([fact(10_000, true), ...Array.from({ length: 27 }, (_, index) => fact(index + 1))]);
  const metric = FinanceProfitMetricViewSchema.parse(await api("finance/profit-metrics", { metricId: null, name: key(), reportingCurrency: "USD",
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: key() }));
  const run = FinanceProfitRunViewSchema.parse(await api("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds: [selected.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: key() }));
  const ambiguousStatement = await statement([fact(1234, true, "JPY"), fact(100, false, "JPY")], "JPY");
  const incomplete = FinanceProfitRunViewSchema.parse(await api("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1,
    statementIds: [ambiguousStatement.id], fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: key() }));
  expect(incomplete).toMatchObject({ status: "incomplete", revenueMinor: null, costMinor: null, profitMinor: null });
  try {
    await changeErpRights("readonly", readerRights(originalRights)); await loginErp(page, "readonly", "/finance/ledger");
    const { actual, dialog } = await readId(page, "statements", selected.id); expect(actual.record).not.toHaveProperty("lines");
    await dialog.getByRole("button", { name: "读取财务事实行", exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("所属记录 ID", { exact: true })).toHaveValue(selected.id);
    const firstResponse = await page.request.get(`${endpoint}/facts?parentId=${selected.id}&limit=25`); expect(firstResponse.status()).toBe(200);
    const first = FinanceLedgerPageViewSchema.parse(await firstResponse.json()); expect(first.items).toHaveLength(25);
    await expect(page.getByRole("table", { name: "财务台账记录", exact: true }).locator("tbody tr")).toHaveCount(25);
    const next = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/facts` && new URL(reply.url()).searchParams.has("cursor"));
    await page.getByRole("button", { name: "读取下一页", exact: true }).click(); const response = await next; expect(response.status()).toBe(200);
    const second = FinanceLedgerPageViewSchema.parse(await response.json()); expect([...first.items, ...second.items].map(row => row.id)).toEqual(selected.lines.map(row => row.id).sort().reverse());
    await scope(page, "profit_runs", metric.id); await expect(page.getByRole("table", { name: "财务台账记录", exact: true })).toContainText("核对结果只在详情展示");
    const actualRun = await readId(page, "profit_runs", incomplete.id), { contributions, ...header } = incomplete;
    expect(actualRun.actual.record).toEqual(header); expect(actualRun.actual.record).not.toHaveProperty("contributions");
    await expect(actualRun.dialog).toContainText("待完整核对"); await expect(actualRun.dialog).toContainText("JPY/USD");
    await actualRun.dialog.getByRole("button", { name: "读取利润贡献行", exact: true }).click(); await expect(actualRun.dialog).toHaveCount(0);
    await expect(page.getByLabel("所属记录 ID", { exact: true })).toHaveValue(incomplete.id);
    const evidence = await readId(page, "contributions", contributions[0]!.id); expect(evidence.actual.record).toEqual({ ...contributions[0], runId: incomplete.id });
    await expect(evidence.dialog).toContainText("单行或当前页贡献不证明整个利润结果完整"); await closeDetail(page);
    await scope(page, "profit_runs", metric.id); const complete = await readId(page, "profit_runs", run.id);
    expect(complete.actual.record).toMatchObject({ profitMinor: run.profitMinor, status: "complete" });
    await page.reload(); await expect(page.getByRole("heading", { name: "完整财务台账查询", exact: true })).toBeVisible();
  } finally { await changeErpRights("readonly", originalRights); }
});

test("closing a pending modal and a real current permission denial clear personal ledger queries before a late authorized detail can return", async ({ page }) => {
  const originalRights = await savedRights(), source = await supplier(), due = await bill(source.id, 1234, "KWD");
  let release: (() => void) | undefined, interceptedResolve: (() => void) | undefined, completedResolve: (() => void) | undefined, routePattern: string | undefined;
  const intercepted = new Promise<void>(resolve => { interceptedResolve = resolve; }), delayed = new Promise<void>(resolve => { release = resolve; });
  const completed = new Promise<void>(resolve => { completedResolve = resolve; });
  try {
    await changeErpRights("readonly", readerRights(originalRights)); await loginErp(page, "readonly", "/finance/ledger"); await scope(page, "bills", source.id);
    routePattern = `**${endpoint}/bills/${due.id}*`;
    await page.route(routePattern, async (route: Route) => { const actual = await route.fetch(); expect(actual.status()).toBe(200); interceptedResolve!(); await delayed;
      try { await route.fulfill({ response: actual }); } catch { /* A revoked view may already have aborted this read. */ } finally { completedResolve!(); } });
    await page.getByLabel("查询记录 ID", { exact: true }).fill(due.id); await page.getByRole("button", { name: "按真实 ID 读取详情", exact: true }).click(); await intercepted;
    // The native modal blocks the page and its detail refresh is disabled while
    // reading. Close through the real enabled footer before revoking and reloading.
    await page.getByRole("dialog", { name: "财务台账记录详情", exact: true }).getByRole("button", { name: "返回财务台账", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "财务台账记录详情", exact: true })).toHaveCount(0);
    await changeErpRights("readonly", originalRights.filter(value => ![Permission.FinanceRead, Permission.FinanceWrite, Permission.FinanceReview].includes(value as Permission)));
    const rejection = page.waitForResponse(reply => new URL(reply.url()).pathname === `${endpoint}/bills` && reply.status() === 403);
    await page.getByRole("button", { name: "刷新首页", exact: true }).click(); await rejection;
    const denied = page.getByRole("alert").filter({ hasText: "当前本人财务读取权限不足" }); await expect(denied).toHaveCount(1); await expect(denied).toBeVisible();
    await expect(page.getByRole("dialog", { name: "财务台账记录详情", exact: true })).toHaveCount(0); release!(); await completed; await page.unroute(routePattern); routePattern = undefined;
    await expect(page.getByRole("table", { name: "财务台账记录", exact: true })).toHaveCount(0); await expect(page.getByLabel("查询记录 ID", { exact: true })).toHaveCount(0);
    await expect(page.locator(".finance-ledger-workspace")).not.toContainText(due.externalBillId); await expect(page.locator(".finance-ledger-workspace")).not.toContainText(due.id);
    const failed = await page.request.get(`${endpoint}/bills/${due.id}`); expect(failed.status()).toBe(403);
    await loginErp(page, "readonly", "/finance/ledger"); await expect(page.getByRole("table", { name: "财务台账记录", exact: true })).toHaveCount(0);
    const blocked = await page.request.get(`${endpoint}/bills/${due.id}`); expect(blocked.status()).toBe(403);
  } finally {
    release?.(); try { if (routePattern) await page.unroute(routePattern); }
    finally { await changeErpRights("readonly", originalRights); }
  }
});
