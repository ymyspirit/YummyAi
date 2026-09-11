import { expect, test, type Page } from "@playwright/test";
import { createEntityId, type AmazonReportBatchView, type AmazonReportDetailView, type AmazonReportLineView, type MarketplaceAccountView, type ProductionEditorDetailView } from "@yummyai/contracts";
import JSZip from "jszip";

import { apiFetch } from "../src/server-api";
import { syntheticProductionPng } from "./production-editor-fixture";

// This test owns only the browser's report API fixture. Real parsing, RLS, scanning,
// persistence and duplicate reconciliation are covered by API integration tests.
// Shop creation uses the real authenticated API so SSR renders the ordinary page.
test("manual report UI imports, isolates ZIP failures, previews, reviews and deduplicates at desktop and mobile widths", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const base = process.env.API_BASE_URL?.replace(/\/$/, "");
  test.skip(!base, "API_BASE_URL is required for the authenticated shop fixture");
  const shopName = `E2E Report UI ${createEntityId().slice(-8)}`;
  const createResponse = await apiFetch(`${base}/v1/marketplace-accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "amazon", displayName: shopName, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] }) });
  expect(createResponse.ok).toBe(true);
  const account = await createResponse.json() as MarketplaceAccountView;
  const fixture = await installReportFixture(page, account.id);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/orders");
    await page.getByRole("link", { name: "导入亚马逊报告" }).click();
    await expect(page.getByRole("heading", { name: "订单工作台", exact: true })).toBeVisible();
    await page.getByLabel("订单所属店铺").selectOption(account.id);
    await expect(page.getByRole("heading", { name: "暂无导入订单" })).toBeVisible();
    await page.locator("#ar-report-file").setInputFiles({ name: "synthetic-orders.txt", mimeType: "text/plain", buffer: Buffer.from(fixture.report) });
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增 2" })).toBeVisible();
    const readyRow = page.locator(".ar-line").filter({ hasText: "E2E-REPORT-READY" });
    const failedRow = page.locator(".ar-line").filter({ hasText: "E2E-REPORT-FAILED" });
    await expect(readyRow).toContainText("可查看");
    await expect(failedRow).toContainText("需要处理");
    await readyRow.click();
    const detail = page.getByRole("region", { name: "定制订单详情" });
    await expect(detail).toContainText("E2E buyer text\nSecond line");
    await expect(detail.getByRole("img", { name: "正面的亚马逊定制预览", exact: true })).toBeVisible();
    await expect.poll(() => detail.getByRole("img", { name: "正面的亚马逊定制预览", exact: true }).evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(detail).toContainText("4800 × 6400 px（原图）");
    await detail.getByRole("button", { name: "放大亚马逊定制预览" }).click();
    await expect(page.getByRole("dialog", { name: "放大的定制预览" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const downloadEvent = page.waitForEvent("download");
    await detail.getByRole("link", { name: "下载原图", exact: true }).click();
    expect((await downloadEvent).suggestedFilename()).toBe("synthetic-original.png");
    await detail.getByRole("button", { name: "标记已核对" }).click();
    await expect(detail.getByRole("button", { name: "当前版本已核对" })).toBeDisabled();
    await expect(readyRow).toContainText("已核对");

    await page.getByLabel("搜索订单、SKU 或商品").fill("E2E-REPORT-READY");
    const sourceUrl = page.url();
    await detail.getByRole("button", { name: "制作生产图" }).click();
    const editor = page.getByRole("region", { name: "当前任务生产作图" });
    await expect(editor).toBeVisible();
    await expect(page).toHaveURL(sourceUrl);
    await expect(editor.getByRole("button", { name: "创建生产草稿" })).toBeEnabled();
    await expect(editor.getByRole("checkbox", { name: /使用当前订单买家原图/ })).toBeChecked();
    await expect(editor.getByRole("checkbox", { name: /使用当前订单买家原图/ })).toBeDisabled();
    await editor.getByText("查看当前订单的定制要求与原图", { exact: true }).click();
    await expect(editor).toContainText("E2E buyer text");
    await page.screenshot({ path: testInfo.outputPath("order-inline-production-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("order-inline-production-mobile.png"), fullPage: true });
    // This fixture owns only report UI: real source-pinned creation is covered in API integration.
    await page.goBack();
    await expect(detail).toContainText("E2E buyer text");
    await expect(page.getByLabel("搜索订单、SKU 或商品")).toHaveValue("E2E-REPORT-READY");
    await expect(readyRow).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("搜索订单、SKU 或商品").fill("");
    await page.setViewportSize({ width: 1440, height: 1000 });

    await failedRow.click();
    await expect(detail).toContainText("定制链接已失效或不可用");
    await expect(detail.getByRole("button", { name: "标记已核对" })).toBeDisabled();
    await page.getByLabel("补传定制 ZIP", { exact: true }).setInputFiles({ name: "synthetic-customization.zip", mimeType: "application/zip", buffer: fixture.zip });
    await expect(detail).toContainText("Recovered buyer text");
    await expect(failedRow).toContainText("可查看");

    await page.getByRole("button", { name: "关闭订单详情" }).click();
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增 0 · 重复 2" })).toBeVisible();
    await expect(page.locator(".ar-line")).toHaveCount(2);
    await expect(readyRow).toContainText("已核对");

    await readyRow.click();
    await expect(detail.getByRole("heading", { name: "买家定制要求" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(detail.getByRole("heading", { name: "买家定制要求" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "关闭订单详情" }).click();
    await page.getByLabel("搜索订单、SKU 或商品").fill("E2E-REPORT-FAILED");
    await expect(page.locator(".ar-line")).toHaveCount(1);
    await page.getByRole("button", { name: "刷新订单列表" }).click();
    await expect(page.getByRole("region", { name: "定制订单详情" })).toHaveCount(0);
    expect(fixture.originalDownloads()).toBe(1);
  } finally {
    // Use the supported account lifecycle; retain an identifiable, disabled fixture
    // instead of deleting or modifying any unrelated local tenant record.
    const disabled = await apiFetch(`${base}/v1/marketplace-accounts/${account.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(disabled.ok).toBe(true);
  }
});

for (const productType of ["tire_cover", "shaped_pillow"] as const) {
test(`real report ZIP and ${productType} source-pinned draft stay in one order and resume without duplication`, async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const api = process.env.API_BASE_URL;
  const suffix = createEntityId().slice(-8), orderId = `E2E-INLINE-${suffix}`, itemId = `ITEM-${suffix}`;
  const response = await apiFetch(`${api}/v1/marketplace-accounts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "amazon", displayName: `E2E Inline ${suffix}`, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] }) });
  expect(response.ok).toBe(true);
  const account = await response.json() as MarketplaceAccountView;
  let projectId: string | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("http://127.0.0.1:3100/orders?view=reports");
    await page.getByLabel("订单所属店铺").selectOption(account.id);
    await expect(page.getByRole("heading", { name: "暂无导入订单" })).toBeVisible();
    // Unsupported domain is rejected before network access. Recover through a real scanned ZIP upload.
    const content = "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n"
      + `${orderId}\t${itemId}\t2026-09-01T12:00:00Z\tE2E-INLINE\tSynthetic inline tire cover\t1\tUSD\t20.00\thttps://example.invalid/synthetic.zip`;
    await page.locator("#ar-report-file").setInputFiles({ name: "synthetic-inline.txt", mimeType: "text/plain", buffer: Buffer.from(content) });
    await page.getByRole("button", { name: "导入报告", exact: true }).click();
    const row = page.locator(".ar-line").filter({ hasText: orderId });
    await expect(row).toContainText("需要处理");
    await row.click();
    const zip = new JSZip();
    zip.file("order.json", JSON.stringify({ orderId, orderItemId: itemId, customizationData: { type: "PageContainerCustomization", snapshot: { imageName: "preview.png" }, children: [
      { type: "ImageCustomization", image: { imageName: "buyer.png", buyerFilename: "synthetic-buyer.png" } },
      ...(productType === "shaped_pillow" ? [["Printing Style", "Only Face"], ["Size (12/16/18/24 inch)", "10 inch-Very Small"], ["Style", "Single-sided Printing"]].map(([label, name]) => ({ type: "OptionCustomization", label, optionSelection: { name } })) : []),
    ] } }));
    zip.file("preview.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOd8AAAAASUVORK5CYII=", "base64"));
    zip.file("buyer.png", syntheticProductionPng());
    await page.getByLabel("补传定制 ZIP", { exact: true }).setInputFiles({ name: "synthetic-inline.zip", mimeType: "application/zip", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
    await expect(row).toContainText("可查看");
    const reviewResponse = page.waitForResponse((result) => result.url().endsWith("/review") && result.request().method() === "POST");
    await page.getByRole("button", { name: "标记已核对", exact: true }).click();
    const source = await (await reviewResponse).json() as AmazonReportDetailView;
    await expect(page.getByRole("button", { name: "当前版本已核对" })).toBeDisabled();
    await page.getByLabel("搜索订单、SKU 或商品").fill(orderId);
    await page.getByRole("button", { name: "制作生产图", exact: true }).click();
    const editor = page.getByRole("region", { name: "当前任务生产作图" });
    await editor.getByRole("combobox", { name: "产品类型", exact: true }).selectOption(productType);
    await editor.getByLabel("新项目名称").fill(`E2E Inline draft ${suffix}`);
    const created = page.waitForResponse((result) => result.url().endsWith("/api/production-editor/projects") && result.request().method() === "POST");
    await editor.getByRole("button", { name: "创建生产草稿" }).click();
    const createdResponse = await created; expect(createdResponse.ok()).toBe(true);
    const project = await createdResponse.json() as ProductionEditorDetailView;
    projectId = project.project.id;
    expect(project.project.source).toEqual({ reportLineId: source.line.id, reportVersionId: source.versionId });
    expect(project.images).toHaveLength(1);
    expect(project.images[0]!.width).toBe(512); // Buyer original, not the one-pixel Amazon preview.
    if (productType === "tire_cover") await expect(editor.getByLabel("圆形直径（mm）")).toBeVisible();
    else {
      expect(project.version.document.spec).toMatchObject({ declaredLongestMm: 254, sideMode: "single", barcodeTab: { widthMm: null, heightMm: null } });
      await expect(editor.getByRole("region", { name: "顾客制作要求" })).toContainText("仅保留完整头部");
      await expect(editor.getByRole("region", { name: "顾客制作要求" })).toContainText("10 英寸");
    }
    await expect(editor.locator("canvas.upper-canvas")).toBeVisible();
    await editor.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(editor.getByRole("status")).toContainText("已保存版本");
    await page.screenshot({ path: testInfo.outputPath("real-order-inline-draft.png"), fullPage: true });
    await editor.getByRole("button", { name: "返回当前订单" }).click();
    await expect(page.getByLabel("搜索订单、SKU 或商品")).toHaveValue(orderId);
    await expect(row).toHaveAttribute("aria-pressed", "true");
    let extraCreates = 0;
    page.on("request", (request) => { if (request.url().endsWith("/api/production-editor/projects") && request.method() === "POST") extraCreates += 1; });
    await page.getByRole("button", { name: "制作生产图", exact: true }).click();
    await expect(editor.getByRole("combobox", { name: "打开生产项目" })).toHaveValue(projectId);
    await expect(editor.getByRole("textbox", { name: "图稿名称" })).toHaveValue(`E2E Inline draft ${suffix}`);
    await expect(editor.getByRole("button", { name: "创建生产草稿" })).toHaveCount(0);
    expect(extraCreates).toBe(0);
    if (productType === "shaped_pillow") {
      await expect(editor.getByRole("region", { name: "顾客制作要求" })).toContainText("仅保留完整头部");
      await page.goto(`/pod-workbench/production-editor?projectId=${projectId}`);
      // The standalone route must retain requirements even without a reportLineId prop.
      await expect(page.getByRole("region", { name: "顾客制作要求" })).toContainText("仅保留完整头部");
      return;
    }
    await editor.getByRole("button", { name: "返回当前订单" }).click();
  } finally {
    if (projectId) expect((await apiFetch(`${api}/v1/production-editor/projects/${projectId}`, { method: "DELETE" })).ok).toBe(true);
    expect((await apiFetch(`${api}/v1/marketplace-accounts/${account.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).ok).toBe(true);
  }
});
}

async function installReportFixture(page: Page, accountId: string) {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOd8AAAAASUVORK5CYII=", "base64");
  const initial = [line("E2E-REPORT-READY"), line("E2E-REPORT-FAILED")];
  const details = new Map(initial.map((item) => [item.id, emptyDetail(item)]));
  const batches: AmazonReportBatchView[] = [];
  let imports = 0;
  let downloaded = 0;
  const report = "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\tcustomized-url\n" + initial.map((item) => `${item.externalOrderId}\t${item.externalLineId}\t2026-09-01T12:00:00Z\t${item.skuCode}\t${item.title}\t1\tUSD\t24.99\thttps://example.invalid/e2e.zip`).join("\n");
  const archive = new JSZip();
  archive.file("order.json", JSON.stringify({ orderId: initial[1]!.externalOrderId, orderItemId: initial[1]!.externalLineId, text: "Recovered buyer text" }));
  archive.file("synthetic-original.png", png);
  const zip = await archive.generateAsync({ type: "nodebuffer" });
  await page.route("**/api/orders/reports/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const parts = url.pathname.split("/api/orders/reports/")[1]!.split("/");
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(value) });
    if (parts[0] === "workspace") {
      if (url.searchParams.get("accountId") !== accountId) return route.fallback();
      return json({ batches, lines: imports ? [...details.values()].map((item) => item.line) : [] });
    }
    if (parts[0] === "import") {
      const input = request.postDataJSON() as { accountId: string; content: string };
      expect(input.accountId).toBe(accountId); expect(input.content).toBe(report);
      imports += 1;
      const batch: AmazonReportBatchView = { id: createEntityId(), accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-orders.txt", rowCount: 2, orderCount: 2, newOrderCount: imports === 1 ? 2 : 0, duplicateOrderCount: imports === 1 ? 0 : 2, failedOrderCount: 0, status: "completed", createdAt: new Date().toISOString() };
      batches.unshift(batch);
      return json(batch);
    }
    const detail = details.get(parts[1] ?? "");
    if (!detail) return route.fallback();
    if (parts[2] === "files") {
      if (url.searchParams.get("versionId") !== detail.versionId) return json({ message: "Version changed" }, 409);
      if (parts[3] === "original-1") downloaded += 1;
      return route.fulfill({ contentType: "image/png", headers: { "cache-control": "private, no-store", "content-disposition": `${parts[3] === "original-1" ? "attachment" : "inline"}; filename="synthetic-original.png"` }, body: png });
    }
    if (request.method() === "GET") return json(detail);
    const input = request.postDataJSON() as { expectedVersionId: string | null; fileName?: string; contentBase64?: string };
    if (input.expectedVersionId !== detail.versionId) return json({ message: "Version changed" }, 409);
    if (parts[2] === "process") {
      if (detail.line.externalOrderId === "E2E-REPORT-FAILED") { detail.line.state = "failed"; detail.line.lastErrorCode = "link_unavailable"; }
      else ready(detail, "E2E buyer text\nSecond line");
    } else if (parts[2] === "review") { detail.line.reviewed = true; }
    else if (parts[2] === "upload") {
      const uploaded = await JSZip.loadAsync(Buffer.from(input.contentBase64 ?? "", "base64"));
      const data = JSON.parse(await uploaded.file("order.json")!.async("string")) as { orderId: string; text: string };
      expect(data.orderId).toBe(detail.line.externalOrderId);
      expect(input.fileName).toBe("synthetic-customization.zip");
      ready(detail, data.text);
    } else return json({ message: "Unknown fixture operation" }, 400);
    return json(detail);
  });
  return { report, zip, originalDownloads: () => downloaded };
}

function line(externalOrderId: string): AmazonReportLineView {
  return { id: createEntityId(), orderId: createEntityId(), orderLineId: createEntityId(), externalOrderId, externalLineId: `ITEM-${externalOrderId}`, skuCode: "E2E-PHOTO", title: `Synthetic personalized photo product ${"long title ".repeat(7)}`, quantity: 1, currency: "USD", itemTotalMinor: 2499, state: "pending", versionNumber: 0, reviewed: false, lastErrorCode: null, updatedAt: new Date().toISOString(), hasPreview: false };
}
function emptyDetail(line: AmazonReportLineView): AmazonReportDetailView { return { line, versionId: null, surfaces: [], files: [], warnings: [] }; }
function ready(detail: AmazonReportDetailView, text: string) {
  detail.versionId = createEntityId(); detail.line.state = "ready"; detail.line.hasPreview = true; detail.line.versionNumber += 1; detail.line.lastErrorCode = null;
  detail.surfaces = [{ key: "front", label: "正面", fields: [{ key: "text", label: "客户文字", kind: "text", value: text }], previewFileKey: "preview-1", buyerFileKeys: ["buyer-1"] }];
  detail.files = [{ key: "preview-1", name: "preview.png", mediaType: "image/png", role: "preview", byteSize: 70 }, { key: "buyer-1", name: "buyer-preview.png", mediaType: "image/png", role: "buyer_image", byteSize: 70, originalFileKey: "original-1", width: 4800, height: 6400 }, { key: "original-1", name: "synthetic-original.png", mediaType: "image/png", role: "source", byteSize: 70 }];
}
