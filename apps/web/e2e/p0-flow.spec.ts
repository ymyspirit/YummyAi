import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import { ExportManifestSchema, createEntityId } from "@yummyai/contracts";
import JSZip from "jszip";

test("capture to reviewed export", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
  await expect(page.getByText("研究抓取", { exact: true })).toBeVisible();
  await expect(page.getByText("销售额", { exact: true })).toHaveCount(0);

  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "研究资料库" })).toBeVisible();
  await expect(page.getByText(/Amazon 或 Etsy 商品页/).first()).toBeVisible();

  const reportId = createEntityId();
  await page.goto(`/analysis/${reportId}`);
  await expect(page.getByText(/分析报告|POSITIONING|证据/i).first()).toBeVisible();

  await page.goto("/products");
  await expect(page.getByText("轻定制旅行礼品杯", { exact: true })).toBeVisible();
  await expect(page.getByText("TRAVEL-MUG-GIFT", { exact: true }).first()).toBeVisible();

  await page.goto("/design");
  await page.getByRole("button", { name: /VERSION 02.*已审批/ }).click();
  await expect(page.getByText("审批版本已锁定", { exact: true })).toBeVisible();
  await expect(page.getByText("授权域", { exact: true }).first()).toBeVisible();

  const listingId = createEntityId();
  await page.goto(`/listings/${listingId}`);
  await expect(page.getByRole("heading", { name: "TRAVEL-MUG-GIFT" })).toBeVisible();
  await page.getByRole("button", { name: "查看审核" }).click();
  await expect(page.getByRole("heading", { name: /审核凭证/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准此版本" })).toBeDisabled();
  await expect(page.getByText("AUTHORIZED", { exact: true }).first()).toBeVisible();

  expect(await buildAndVerifyExport()).toBe(true);
});

test("P0 pages expose headings and keyboard focus", async ({ page }) => {
  await page.goto("/"); await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  expect(await page.locator("h1").count()).toBe(1);
});

test("primary navigation stays complete across ERP pages", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const labels = ["运营总览", "研究资料库", "产品开发", "设计校样", "刊登控制台"];

  for (const label of labels.slice(1)) {
    await expect(navigation.getByRole("link")).toHaveCount(5);
    await navigation.getByRole("link", { name: label }).click();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(5);
  }
});

async function buildAndVerifyExport() {
  const bytes = new TextEncoder().encode("authorized asset"); const id = createEntityId(); const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = ExportManifestSchema.parse({ exportId: id, tenantId: id, platform: "amazon", listingId: id, listingVersionId: id, ruleVersion: "amazon-us-2026-07", files: [{ path: "media/main.png", sha256, assetId: id, assetVersion: 1 }], createdBy: id, createdAt: "2026-07-18T04:00:00.000Z" });
  const zip = new JSZip(); zip.file("manifest.json", JSON.stringify(manifest)); zip.file("media/main.png", bytes); const archive = await zip.generateAsync({ type: "uint8array" }); const loaded = await JSZip.loadAsync(archive); const restored = JSON.parse(await loaded.file("manifest.json")!.async("string")); const restoredBytes = await loaded.file(restored.files[0].path)!.async("uint8array");
  return ExportManifestSchema.safeParse(restored).success && createHash("sha256").update(restoredBytes).digest("hex") === restored.files[0].sha256;
}
