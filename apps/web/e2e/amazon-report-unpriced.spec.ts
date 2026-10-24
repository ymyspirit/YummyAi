import { expect, test } from "@playwright/test";
import { createEntityId, type MarketplaceAccountView } from "@yummyai/contracts";
import { apiFetch } from "../src/server-api";
import { loginErp } from "./erp-identity-fixture";

test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page); });

test("manual report UI imports real unpriced reports and explains invalid columns", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  // This case uses the real parser/proxy/API/storage boundary. The isolated
  // runner destroys its database, bucket and Redis in finally, even on failure.
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw new Error("Disposable report acceptance resources required");
  const base = process.env.API_BASE_URL!.replace(/\/$/, ""), suffix = createEntityId().slice(-8);
  const created = await apiFetch(`${base}/v1/marketplace-accounts`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: "amazon", displayName: `Synthetic unpriced ${suffix}`, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] }) });
  expect(created.ok).toBe(true);
  const account = await created.json() as MarketplaceAccountView;
  const headers = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "quantity-shipped", "quantity-to-ship", "promise-date"];
  const rows = [1, 2].map(index => [`SYNTHETIC-UNPRICED-${suffix}-${index}`, `SYNTHETIC-ITEM-${suffix}-${index}`, "2026-09-19T10:00:00Z", "SYNTHETIC-SKU", "Synthetic ordinary product", "1", "0", "1", "2026-09-30T10:00:00Z"]);
  const report = [headers, ...rows].map(row => row.join("\t")).join("\r\n");
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/orders?view=reports");
    await page.getByLabel("订单所属店铺").selectOption(account.id);
    await page.locator("#ar-report-file").setInputFiles({ name: "synthetic-invalid.txt", mimeType: "text/plain", buffer: Buffer.from([headers, ...rows].map(row => row.filter((_, index) => index !== 1).join("\t")).join("\r\n")) });
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "缺少必要列" })).toContainText("order-item-id");
    await page.locator("#ar-report-file").setInputFiles({ name: "synthetic-unpriced.txt", mimeType: "text/plain", buffer: Buffer.from(report) });
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增 2" })).toBeVisible();
    await expect(page.locator(".ar-line")).toHaveCount(2);
    await expect(page.locator(".ar-line").filter({ hasText: "金额未知 · 币种未提供" })).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("unpriced-desktop.png"), fullPage: true });
    await page.reload();
    await page.getByLabel("订单所属店铺").selectOption(account.id);
    await expect(page.locator(".ar-line").filter({ hasText: "金额未知 · 币种未提供" })).toHaveCount(2);
    await page.locator("#ar-report-file").setInputFiles({ name: "synthetic-unpriced.txt", mimeType: "text/plain", buffer: Buffer.from(report) });
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增 0 · 重复 2" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".ar-line")).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("unpriced-mobile.png"), fullPage: true });
  } finally {
    const disabled = await apiFetch(`${base}/v1/marketplace-accounts/${account.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(disabled.ok).toBe(true);
  }
});
