import { expect, test } from "@playwright/test";
import type {
  AmazonReportBatchView,
  AmazonReportWorkspaceView,
  MarketplaceAccountView,
  ProductionEditorDetailView,
} from "@yummyai/contracts";
import type { ArtworkView } from "@yummyai/contracts/catalog/development";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { centerApi, createCenterProfile, createCenterSpu } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

function sourcePsd() {
  const file = Buffer.alloc(52);
  file.write("8BPS");
  file.writeUInt16BE(1, 4);
  file.writeUInt16BE(3, 12);
  file.writeUInt32BE(2, 14);
  file.writeUInt32BE(2, 18);
  file.writeUInt16BE(8, 22);
  file.writeUInt16BE(3, 24);
  file.fill(128, 40);
  return file;
}

test("structured creative template and PSD source follow the order's print and SPU into a private design draft", async ({
  page,
}, testInfo) => {
  test.setTimeout(240000);
  page.setDefaultTimeout(20000);
  const suffix = crypto.randomUUID().slice(0, 8),
    name = `QA Creative Order ${suffix}`,
    code = `QA-TEMPLATE-${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const profile = await createCenterProfile("tire_cover", suffix, false);
  const spu = await createCenterSpu(`QA-CUSTOM-SPU-${suffix}`);
  const { specification } = await centerApi<{ specification: { versionId: string } }>(
    "product-development/specifications",
    {
      spuId: spu.id,
      code: "ROUND-50",
      name: "圆形 50mm",
      attributes: { 尺寸: "50mm", 形状: "圆形" },
      facts: {
        material: "Synthetic fabric",
        dimensions: "50 mm",
        packageContents: "One item",
        packageQuantity: 1,
        factsConfirmed: true,
      },
      processProfileVersionId: profile.versionId,
      expectedVersion: 0,
      idempotencyKey: crypto.randomUUID(),
    },
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/creative-designs/canvas");
  await page.getByRole("button", { name: "新建创意项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill(name);
  await page.getByLabel("定制类型", { exact: true }).selectOption("mixed");
  await page
    .getByLabel("创意方向与制作要求")
    .fill("Synthetic reusable pet template. Use private order photos only after dispatch.");
  await page.getByLabel("目标人群").fill("Pet owners");
  await page.getByLabel("交付与验收要求").fill("Keep the complete border and exact buyer name.");
  await page.getByRole("button", { name: "定制配置", exact: true }).click();
  await page.getByRole("button", { name: "添加文字字段", exact: true }).click();
  await page.getByLabel("字段名称", { exact: true }).first().fill("Pet name");
  await page.getByRole("button", { name: "添加图片字段", exact: true }).click();
  await page.getByLabel("字段名称", { exact: true }).last().fill("Pet photo");
  await page.screenshot({
    path: testInfo.outputPath("creative-customization-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("creative-customization-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "审核与交付", exact: true }).click();
  await page.getByRole("button", { name: "保存需求并开始设计", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("需求已保存");
  const briefId = new URL(page.url()).searchParams.get("brief")!;
  await page.reload();
  await expect(page.getByLabel("目标人群")).toHaveValue("Pet owners");
  await page.getByRole("button", { name: "设计与素材", exact: true }).click();
  await page.getByLabel("来源说明", { exact: true }).fill("Synthetic local QA artwork");
  await page.getByLabel("上传设计方案文件").setInputFiles({
    name: "reusable-master.png",
    mimeType: "image/png",
    buffer: syntheticProductionPng(),
  });
  await expect(page.getByRole("status")).toContainText("设计方案已上传");
  await page.getByRole("checkbox", { name: "选择方案 reusable-master.png", exact: true }).check();
  await page.getByRole("button", { name: "批准选中方案", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登记印花与素材包", exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "交付方案", exact: true })
    .selectOption({ label: "reusable-master.png" });
  const form = page.locator(".pd-form");
  await form.getByLabel("印花 SKU", { exact: true }).fill(code);
  await form.getByLabel("印花名称", { exact: true }).fill(`Pet template ${suffix}`);
  await form.getByText("上传授权素材", { exact: true }).click();
  await form.getByLabel("来源说明", { exact: true }).fill("Self-created synthetic PSD fixture");
  await form.getByLabel("上传印花素材文件").setInputFiles({
    name: `source-${suffix}.psd`,
    mimeType: "image/vnd.adobe.photoshop",
    buffer: sourcePsd(),
  });
  await expect(form.locator(".art-material-row")).toContainText(`source-${suffix}.psd`);
  const registered = page.waitForResponse(
    (r) => r.url().endsWith("/api/product-development/artworks") && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: "登记印花", exact: true }).click();
  const saved = await registered;
  expect(saved.ok()).toBe(true);
  const art = (await saved.json()).artwork as ArtworkView;
  expect(art.mode).toBe("mixed");
  expect(art.materials).toHaveLength(2);
  expect(art.layout).toHaveLength(2);
  await expect(page.getByRole("status")).toContainText("素材包已登记");
  await page.goto(`/creative-designs/canvas?brief=${briefId}`);
  await page.getByRole("button", { name: "审核与交付", exact: true }).click();
  await expect(page.getByText(`已登记：${code}`, { exact: false })).toBeVisible();

  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon",
    displayName: `QA Direct ${suffix}`,
    region: "NA",
    marketplaceIds: ["ATVPDKIKX0DER"],
    authorizationMode: "amazon_private",
    requestedScopes: [],
  });
  const external = `QA-DIRECT-${suffix}`;
  const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
    accountId: account.id,
    marketplaceId: "ATVPDKIKX0DER",
    fileName: "synthetic-direct.tsv",
    content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tITEM-1\t${new Date().toISOString()}\tUNMAPPED-${suffix}\tSynthetic custom product\t1\tUSD\t20.00`,
  });
  const report = await centerApi<AmazonReportWorkspaceView>(
      `orders/reports/workspace?batchId=${batch.id}`,
    ),
    id = report.lines[0]!.orderLineId;
  await page.goto(`/orders?q=${external}`);
  await page.getByRole("button", { name: external, exact: true }).click();
  await page.getByLabel("本单印花版本").selectOption(art.versionId);
  await page.getByLabel("本单产品 SPU").selectOption(spu.id);
  await page.getByLabel("本单产品规格").selectOption(specification.versionId);
  await page.getByLabel("设计执行方式").selectOption("agent");
  await page.getByLabel("定制内容", { exact: true }).fill("Luna");
  await page.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("草稿已保存");
  await page.getByLabel("上传订单定制图片").setInputFiles({
    name: "buyer-photo.png",
    mimeType: "image/png",
    buffer: syntheticProductionPng(),
  });
  await expect(page.getByRole("status")).toContainText("图片已上传");
  await page.getByRole("checkbox", { name: "buyer-photo.png", exact: true }).check();
  await page.locator('input[list="order-image-usages"]').fill("Pet photo");
  await page.getByRole("button", { name: "确认审单并保存", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("审单已保存");
  const before = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
  expect(before.line.editorProjectId).toBeNull();
  expect(before.draft.salesRecipeVersionId ?? null).toBeNull();
  // The private file endpoint is visible in the material list and returns the pinned source.
  const href = await page
    .locator('.art-order-materials a[href*="artwork-materials"]')
    .last()
    .getAttribute("href");
  expect(href).toContain(art.materials[1]!.assetId);
  const download = await page.request.get(href!);
  expect(download.ok()).toBe(true);
  expect(await download.body()).toEqual(sourcePsd());
  await page.getByRole("button", { name: "确认并派发设计", exact: true }).click();
  await expect(page.getByRole("button", { name: "撤回并修改需求", exact: true })).toBeVisible();
  const pushed = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
  expect(pushed.line.artwork).toBe("in_progress");
  const project = await centerApi<ProductionEditorDetailView>(
    `production-editor/projects/${pushed.line.editorProjectId}`,
  );
  expect(project.project.workSource?.workItemId).toBe(id);
  expect(project.version.document.layers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "catalog_artwork", name: code }),
      expect.objectContaining({ id: "custom_text_1", text: "Luna" }),
      expect.objectContaining({ id: "custom_photo_2", kind: "image" }),
    ]),
  );
  expect(project.version.document.confirmations.visualReview).toBe(false);
  await page.goto(`/order-artwork?q=${external}`);
  await page.getByRole("button", { name: external, exact: true }).click();
  await page.getByRole("button", { name: "打开生产文件", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "当前任务生产作图" }).locator("canvas.upper-canvas"),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("order-template-private-editor.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
