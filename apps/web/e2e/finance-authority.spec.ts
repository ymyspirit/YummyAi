import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceStatementViewSchema, FinanceWorkspaceViewSchema,
  type FinanceFactInput, type RecordFinanceStatementInput } from "@yummyai/contracts/finance";
import { FulfillmentSupplierViewSchema } from "@yummyai/contracts/order/routing";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, identityControl, loginErp } from "./erp-identity-fixture";

const database = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_AUTHORITY_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !["postgres:", "postgresql:"].includes(database.protocol) || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Personal disposable finance authority browser fixture required before connection");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), key = () => `synthetic-authority-${randomUUID()}`, at = "2026-07-15T00:00:00.000Z";
test.describe.configure({ mode: "serial" });
function request(path: string, body?: unknown, token = process.env.API_ACCESS_TOKEN!) {
  return fetch(`${base}/v1/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function api(path: string, body?: unknown, token?: string) {
  const response = await request(path, body, token);
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof failure?.code === "string" && /^[a-z_]{1,100}$/.test(failure.code) ? failure.code : "unavailable";
    throw new Error(`Synthetic financial authority fixture failed ${response.status} ${path} ${code}`);
  }
  return response.json();
}
function fact(amountMinor: number, sourceEntryId = key(), revenue = false): FinanceFactInput {
  return { sourceEntryId, lineKey: key(), factType: revenue ? "sale_revenue" : "production_cost", direction: revenue ? "credit" : "debit", amountMinor,
    currency: "USD", occurredAt: at, externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null, supplierId: null,
    correctionKind: "original", correctsFactId: null };
}
function statement(lines: FinanceFactInput[], overrides: Partial<RecordFinanceStatementInput> = {}): RecordFinanceStatementInput {
  return { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-AUTHORITY-BROWSER" }, accountId: null, provider: "manual",
    statementKind: "operational_cost", externalStatementId: key(), periodStart: at, periodEnd: at, sourceCurrency: "USD", observedAt: at, idempotencyKey: key(), lines, ...overrides };
}
async function savedRights() {
  const actor = actors().readonly, connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: actor.tenantId, userId: actor.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, actor.roleId)));
    if (!row) throw new Error("Synthetic financial read role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const code of await page.locator(".finance-source-detail-body code").all())
    expect(await code.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

test("personal finance reader can inspect two suppliers with the same document number and complete stable component IDs at 1440 and 390 widths", async ({ page }, info) => {
  const original = await savedRights(), code = `AUTH-${randomUUID().slice(0, 8).toUpperCase()}`, errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    const suppliers = [];
    for (const suffix of ["A", "B"]) suppliers.push(FulfillmentSupplierViewSchema.parse(await api("sourcing/suppliers", { name: `${code} Synthetic supplier ${suffix}`,
      kind: "manual", regionCode: "US", settlementCurrency: "USD" })));
    const sourceStatements = [];
    for (const supplier of suppliers) sourceStatements.push(FinanceStatementViewSchema.parse(await api("finance/statements", statement([
      { ...fact(1000, `${code}:supplier-component`), supplierId: supplier.id }], { provider: "supplier", statementKind: "supplier_invoice",
      externalStatementId: `${code}-SAME-INVOICE`, sourceIdentity: { schemaVersion: 2, kind: "supplier", supplierId: supplier.id } }))));
    expect(sourceStatements[0]!.id).not.toBe(sourceStatements[1]!.id);
    const longEntry = `${code}:${"stable-component-".repeat(10)}sale`, evidence = FinanceStatementViewSchema.parse(await api("finance/statements", statement([
      fact(10000, longEntry, true), fact(2000, `${code}:production-component`)], { externalStatementId: `${code}-NAMED-LEDGER` })));
    const metric = FinanceProfitMetricViewSchema.parse(await api("finance/profit-metrics", { metricId: null, name: key(), reportingCurrency: "USD",
      revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: key() }));
    const run = FinanceProfitRunViewSchema.parse(await api("finance/profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds: [evidence.id],
      fxRateIds: [], coverageDimension: "aggregate", idempotencyKey: key() }));
    expect(run).toMatchObject({ sourceIdentityVersion: 1, profitMinor: 8000, diagnostics: { sourceIdentity: { schemaVersion: 1, unidentifiedFactIds: [] } } });
    await changeErpRights("readonly", [...new Set([...original, Permission.FinanceRead])]); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", "/finance"); await expect(page.getByRole("heading", { name: "财务与利润", exact: true })).toBeVisible();
    const ledger = page.getByRole("region", { name: "财务证据台账", exact: true });
    for (const item of [...sourceStatements, evidence]) {
      const details = ledger.getByLabel(`来源与明细标识 ${item.externalStatementId} ${item.id}`, { exact: true });
      await details.locator("summary").click(); await expect(details).toHaveAttribute("open", ""); await expect(details).toContainText(item.id);
      for (const line of item.lines) { await expect(details).toContainText(line.id); await expect(details).toContainText(line.sourceEntryId!); }
      if (item.sourceIdentity!.kind === "supplier") await expect(details).toContainText(`供应商作用域 ${item.sourceIdentity!.supplierId}`);
      else await expect(details).toContainText("命名来源 SYNTHETIC-AUTHORITY-BROWSER");
    }
    await expect(ledger).toContainText("源标识 2/2");
    await expect(page.getByRole("region", { name: "利润计算记录", exact: true })).toContainText("本次计算所选事实的来源身份记录覆盖完整");
    await expect(page.locator(".finance-run-table tbody > tr").filter({ hasText: "USD 80.00" })).toContainText("完整");
    await ledger.scrollIntoViewIfNeeded(); await expect(ledger).toHaveCSS("opacity", "1"); await noOverflow(page);
    await page.screenshot({ path: info.outputPath("finance-authority-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 }); await ledger.scrollIntoViewIfNeeded(); await noOverflow(page);
    await expect(ledger).toContainText(longEntry); await page.screenshot({ path: info.outputPath("finance-authority-mobile.png"), fullPage: true, animations: "disabled" }); expect(errors).toEqual([]);
  } finally { await changeErpRights("readonly", original); }
});

test("an old personal token cannot keep writing or reading after the current financial permissions are removed", async ({ page }) => {
  const original = await savedRights();
  try {
    const canWrite = [...new Set([...original, Permission.FinanceRead, Permission.FinanceWrite])]; await changeErpRights("readonly", canWrite);
    const { access_token: token } = await identityControl("token", { account: "readonly" }), input = statement([fact(29)]);
    const created = FinanceStatementViewSchema.parse(await api("finance/statements", input, token));
    await loginErp(page, "readonly", "/finance"); const recordedRow = page.locator(".finance-statement-table tbody > tr:not(.finance-source-row)").filter({ hasText: created.externalStatementId });
    await expect(recordedRow).toHaveCount(1); await expect(recordedRow).toBeVisible();
    await changeErpRights("readonly", canWrite.filter(permission => permission !== Permission.FinanceWrite));
    expect((await request("finance/statements", { ...input, externalStatementId: key(), idempotencyKey: key(), lines: [fact(30)] }, token)).status).toBe(403);
    const remaining = FinanceWorkspaceViewSchema.parse(await api("finance/workspace", undefined, token));
    expect(remaining.statements.filter(item => item.id === created.id)).toHaveLength(1); await page.reload(); await expect(recordedRow).toBeVisible();
    // Preserve nonfinance ERP capabilities so the denial is specific to finance.
    await changeErpRights("readonly", original.filter(permission => permission !== Permission.FinanceRead && permission !== Permission.FinanceWrite && permission !== Permission.FinanceReview));
    expect((await request("finance/workspace", undefined, token)).status).toBe(403); expect((await request(`finance/statements/${created.id}`, undefined, token)).status).toBe(403);
    await loginErp(page, "readonly", "/finance"); const denied = page.getByRole("alert").filter({ hasText: "缺少财务读取权限" });
    await expect(denied).toHaveCount(1); await expect(denied).toBeVisible(); await expect(page.locator(".finance-statement-table")).toHaveCount(0);
    await expect(page.getByText(created.externalStatementId, { exact: true })).toHaveCount(0);
  } finally { await changeErpRights("readonly", original); }
});
