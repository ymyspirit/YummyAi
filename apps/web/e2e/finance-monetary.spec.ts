import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { Permission } from "@yummyai/authz";
import { FinanceFxRateViewSchema, FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceStatementViewSchema,
  type FinanceFactInput, type FinanceProfitRunView } from "@yummyai/contracts/finance";
import { connectDatabase, withTenant, roles } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_FINANCE_MONETARY_ISOLATED !== "1" || process.env.WEB_AUTH_MODE !== "personal"
  || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Personal disposable finance monetary browser fixture required");
const base = process.env.API_BASE_URL!.replace(/\/$/, ""), key = () => `synthetic-money-${randomUUID()}`;
test.describe.configure({ mode: "serial" });
async function api(path: string, body: unknown) {
  const response = await fetch(`${base}/v1/finance/${path}`, { method: "POST", headers: {
    authorization: `Bearer ${process.env.API_ACCESS_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof failure?.code === "string" && /^[a-z_]{1,100}$/.test(failure.code) ? failure.code : "unavailable";
    throw new Error(`Synthetic finance fixture API failed ${response.status} ${path} ${code}`);
  }
  return response.json();
}
function fact(currency: string, amountMinor: number, revenue = false): FinanceFactInput {
  return { sourceEntryId: key(), lineKey: key(), factType: revenue ? "sale_revenue" : "production_cost", direction: revenue ? "credit" : "debit", amountMinor, currency,
    occurredAt: "2026-07-15T00:00:00.000Z", externalReference: null, orderId: null, orderLineId: null, skuId: null, listingId: null,
    supplierId: null, correctionKind: "original", correctsFactId: null };
}
async function statement(currency: string, lines: FinanceFactInput[]) {
  return FinanceStatementViewSchema.parse(await api("statements", { sourceIdentity: { schemaVersion: 2, kind: "named_source", sourceName: "SYNTHETIC-MONETARY-BROWSER" },
    accountId: null, provider: "manual", statementKind: "operational_cost", externalStatementId: key(),
    periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-07-31T23:59:59.000Z", sourceCurrency: currency,
    observedAt: "2026-08-01T00:00:00.000Z", idempotencyKey: key(), lines }));
}
async function rate(source: string, baseCurrency: string, quoteCurrency: string, rateNumerator: number, rateDenominator: number, explicit = true) {
  return FinanceFxRateViewSchema.parse(await api("fx-rates", { source, baseCurrency, quoteCurrency, rateNumerator, rateDenominator,
    effectiveAt: "2026-07-01T00:00:00.000Z", retrievedAt: "2026-07-02T00:00:00.000Z", idempotencyKey: key(), ...(explicit ? { rateUnit: "major_to_major" } : {}) }));
}
async function calculate(currency: string, statementIds: string[], fxRateIds: string[] = []) {
  const metric = FinanceProfitMetricViewSchema.parse(await api("profit-metrics", { metricId: null, name: key(), reportingCurrency: currency,
    revenueFactTypes: ["sale_revenue"], costFactTypes: ["production_cost"], requiredFactTypes: ["sale_revenue", "production_cost"], reasonCode: "SYNTHETIC", idempotencyKey: key() }));
  return FinanceProfitRunViewSchema.parse(await api("profit-runs", { metricId: metric.id, expectedMetricVersion: 1, statementIds, fxRateIds,
    coverageDimension: "aggregate", idempotencyKey: key() }));
}
async function sameCurrency(currency: string, revenue: number) {
  const evidence = await statement(currency, [fact(currency, revenue, true), fact(currency, 0)]); return calculate(currency, [evidence.id]);
}
async function savedRights() {
  const account = actors().readonly, connection = connectDatabase();
  try {
    const [row] = await withTenant(connection.db, { tenantId: account.tenantId, userId: account.userId, permissions: [], dataScope: "tenant" },
      tx => tx.select({ permissions: roles.permissions }).from(roles).where(eq(roles.id, account.roleId)));
    if (!row) throw new Error("Synthetic monetary read role missing"); return [...row.permissions];
  } finally { await connection.client.end(); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  for (const amount of await page.locator(".finance-money").all())
    expect(await amount.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}
async function visibleRun(page: Page, value: FinanceProfitRunView, amount: string) {
  const row = page.locator(".finance-run-table tbody > tr").filter({ hasText: amount }); await expect(row).toHaveCount(1);
  await expect(row).toContainText("完整"); await expect(row.getByRole("cell").nth(4)).toHaveText(amount);
  expect(value.status).toBe("complete"); return row;
}

test("a personal finance reader sees exact JPY, KWD and large amounts with pinned major FX at desktop and mobile widths", async ({ page }, info) => {
  const yen = await sameCurrency("JPY", 1234), dinar = await sameCurrency("KWD", 1234), large = await sameCurrency("USD", 9007199254740990);
  const prefix = `MONEY.${randomUUID().slice(0, 8).toUpperCase()}`, conversion = await rate(`${prefix}_EURJPY`, "EUR", "JPY", 160, 1);
  const revenue = await statement("JPY", [fact("JPY", 10000, true)]), cost = await statement("EUR", [fact("EUR", 2000)]);
  const converted = await calculate("JPY", [revenue.id, cost.id], [conversion.id]); expect(converted).toMatchObject({ costMinor: 3200, profitMinor: 6800 });
  const fractional = await rate(`${prefix}_JPYUSD`, "JPY", "USD", 1, 150);
  const usdSale = await statement("USD", [fact("USD", 10000, true)]), yenCost = await statement("JPY", [fact("JPY", 1234)]);
  expect(await calculate("USD", [usdSale.id, yenCost.id], [fractional.id])).toMatchObject({ costMinor: 823, profitMinor: 9177 });
  const originalRights = await savedRights(), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await changeErpRights("readonly", [Permission.FinanceRead]); await page.setViewportSize({ width: 1440, height: 1000 });
    await loginErp(page, "readonly", "/finance"); await expect(page.getByRole("heading", { name: "财务与利润", exact: true })).toBeVisible();
    await visibleRun(page, yen, "JPY 1234"); await visibleRun(page, dinar, "KWD 1.234"); await visibleRun(page, large, "USD 90071992547409.90");
    await expect(page.locator(".finance-run-table tbody > tr").filter({ hasText: "JPY 6800" })).toContainText("JPY 3200");
    await expect(page.locator(".finance-run-table tbody > tr").filter({ hasText: "USD 91.77" })).toContainText("USD 8.23");
    const fx = page.locator(".finance-fx-grid article").filter({ hasText: `${prefix}_JPYUSD` });
    await expect(fx.getByLabel("原始汇率分子与分母", { exact: true })).toHaveText("1 / 150");
    await expect(fx).toContainText("1 JPY 主货币单位 = 1 / 150 USD 主货币单位");
    await expect(page.getByRole("note", { name: "最新计算货币与舍入依据", exact: true })).toContainText("iso4217-2026-09-17-v1");
    await fx.scrollIntoViewIfNeeded(); await expect(fx).toBeInViewport(); await expect(fx).toHaveCSS("opacity", "1");
    await fx.screenshot({ path: info.outputPath("finance-monetary-fx.png"), animations: "disabled" });
    await noOverflow(page); await page.screenshot({ path: info.outputPath("finance-monetary-desktop.png"), fullPage: true, animations: "disabled" });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page);
    await expect(page.locator(".finance-run-table")).toContainText("USD 90071992547409.90");
    await page.screenshot({ path: info.outputPath("finance-monetary-mobile.png"), fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
  } finally { await changeErpRights("readonly", originalRights); }
});

test("unknown precision and an unlabeled cross-precision rate stay incomplete and current FinanceRead controls personal visibility", async ({ page }) => {
  // Current API accepts the old omitted-unit transport, but cannot infer its rate unit.
  // Genuine stored wrong 151 totals are covered separately by the real upgrade test.
  const legacy = await rate(`MONEY.OLD_${randomUUID().slice(0, 8).toUpperCase()}`, "EUR", "JPY", 160, 1, false);
  expect(legacy.monetaryBasis ?? null).toBeNull();
  const revenue = await statement("JPY", [fact("JPY", 10000, true)]), cost = await statement("EUR", [fact("EUR", 2000)]);
  const ambiguous = await calculate("JPY", [revenue.id, cost.id], [legacy.id]), unknown = await sameCurrency("ZZZ", 1234);
  expect(ambiguous).toMatchObject({ status: "incomplete", profitMinor: null, diagnostics: { monetary: { ambiguousFxRateIds: [legacy.id] } } });
  expect(unknown).toMatchObject({ status: "incomplete", profitMinor: null, diagnostics: { monetary: { unknownCurrencies: ["ZZZ"] } } });
  const originalRights = await savedRights();
  try {
    await changeErpRights("readonly", [Permission.FinanceRead]); await loginErp(page, "readonly", "/finance");
    await expect(page.getByRole("region", { name: "最新利润证据等式", exact: true })).toContainText("等待完整证据");
    await expect(page.getByRole("region", { name: "最新利润证据等式", exact: true })).not.toContainText("ZZZ 12.34");
    const diagnostics = page.getByRole("region", { name: "完整性诊断", exact: true });
    await expect(diagnostics).toContainText("币种精度待核对 ZZZ"); await expect(diagnostics).toContainText("汇率单位待核对");
    await expect(page.locator(".finance-fx-grid article").filter({ hasText: legacy.source })).toContainText("单位待核对");
    // Removing every ERP capability denies the whole session before the finance page.
    await changeErpRights("readonly", originalRights.filter(permission => permission !== Permission.FinanceRead));
    await loginErp(page, "readonly", "/finance");
    const denied = page.getByRole("alert").filter({ hasText: "缺少财务读取权限" });
    await expect(denied).toHaveCount(1); await expect(denied).toBeVisible(); await expect(denied).toContainText("缺少财务读取权限");
    await expect(page.locator(".finance-run-table")).toHaveCount(0);
  } finally { await changeErpRights("readonly", originalRights); }
});
