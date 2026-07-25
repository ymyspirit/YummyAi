import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import { ExportManifestSchema, createEntityId } from "@yummyai/contracts";
import JSZip from "jszip";

test("capture to reviewed export", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
  await expect(page.getByText("研究抓取", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /研究抓取：38，打开明细/ })).toHaveAttribute("href", /dateFrom=2026-07-01/);
  await expect(page.getByRole("link", { name: "查看机会研究产品" })).toHaveAttribute("href", "/products?status=researching");
  await expect(page.locator("#ai-ledger")).toContainText("本期模型账本");
  await expect(page.getByText("销售额", { exact: true })).toHaveCount(0);

  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "研究资料库" })).toBeVisible();
  await expect(page.getByText(/Amazon 或 Etsy 商品页/).first()).toBeVisible();

  const reportId = createEntityId();
  await page.goto(`/analysis/${reportId}`);
  await expect(page.getByText(/分析报告|POSITIONING|证据/i).first()).toBeVisible();

  await page.goto("/products");
  await expect(page.getByText("轻定制旅行礼品杯", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "打开 轻定制旅行礼品杯" }).click();
  await expect(page.getByText("TRAVEL-MUG-GIFT", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "关联工作" })).toBeVisible();
  await expect(page.getByRole("link", { name: /旅行礼品杯 · 激光刻字与礼盒校样/ })).toHaveAttribute("href", /\/design\?task=/);
  await expect(page.getByRole("link", { name: /Amazon · en-US/ })).toHaveAttribute("href", /\/listings\//);

  await page.goto("/design?status=overdue");
  await expect(page.getByRole("heading", { name: "设计任务队列" })).toBeVisible();
  await expect(page.getByText("1 TASKS · 已逾期")).toBeVisible();
  await page.getByRole("button", { name: /VERSION 02.*已审批/ }).click();
  await expect(page.getByText("审批版本已锁定", { exact: true })).toBeVisible();
  await expect(page.getByText("授权域", { exact: true }).first()).toBeVisible();

  await page.goto("/stores");
  await expect(page.getByRole("heading", { name: "店铺运营" })).toBeVisible();

  const listingId = createEntityId();
  await page.goto(`/listings/${listingId}`);
  await expect(page.getByRole("heading", { name: "TRAVEL-MUG-GIFT" })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("heading", { name: "发布控制" })).toBeVisible();
  await expect(page.getByText("当前 Listing 版本尚未审批。")).toBeVisible();
  await page.getByRole("button", { name: "Channels" }).click();
  await expect(page.getByRole("heading", { name: "站点与在线 Listing 编排" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "多站点复制" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "在线 Listing 同步" })).toBeVisible();
  await expect(page.getByLabel("动作").first()).toContainText("读取完整内容");
  await expect(page.getByRole("heading", { name: "自动化规则" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建站点草稿" })).toBeDisabled();
  await page.getByRole("button", { name: "查看审核" }).click();
  await expect(page.getByRole("heading", { name: /审核凭证/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "批准此版本" })).toBeDisabled();
  await expect(page.getByText("AUTHORIZED", { exact: true }).first()).toBeVisible();

  expect(await buildAndVerifyExport()).toBe(true);
});

test("P0 pages expose headings and keyboard focus", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
  expect(await page.locator("h1").count()).toBe(1);
});

test("primary navigation stays complete across ERP pages", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const labels = ["运营总览", "研究资料库", "竞争店铺", "产品目录", "设计校样", "刊登控制台", "店铺运营", "订单履约", "库存台账", "采购补货", "供应商绩效", "渠道库存", "财务利润", "广告与 VOC", "数据与集成"];

  for (const label of labels.slice(1)) {
    await expect(navigation.getByRole("link")).toHaveCount(labels.length);
    await navigation.getByRole("link", { name: label }).click();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(
      labels.length,
    );
  }
});

test("P2 order inbox uses the real public projection", async ({ page }) => {
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "订单履约" })).toBeVisible();
  await expect(page.getByText("订单流水线")).toBeVisible();
  await expect(page.getByText(/买家姓名|详细地址|电子邮箱/)).toHaveCount(0);
});

test("Listing catalog keeps filters in the URL and mobile overflow inside the table", async ({ page }) => {
  await page.goto("/listings");
  await expect(page.getByRole("heading", { name: "Listing 目录" })).toBeVisible();
  await page.getByPlaceholder("标题、SPU、Listing ID").fill("travel");
  await page.getByPlaceholder("en-US").fill("en-US");
  await page.locator('select[name="completeness"]').selectOption("partial");
  await page.getByRole("button", { name: "应用" }).click();
  await expect(page).toHaveURL(/q=travel/);
  await expect(page).toHaveURL(/locale=en-US/);
  await expect(page).toHaveURL(/completeness=partial/);
  await expect(page.getByRole("heading", { name: "Listing 目录" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const scroll = page.locator(".listing-index-table-scroll");
  expect(await scroll.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
});

test("Product catalog keeps owner filters and dense table overflow contained", async ({ page }) => {
  await page.goto("/products");
  await expect(page.getByRole("heading", { name: "产品目录" }).first()).toBeVisible();
  await page.locator("details.product-create-panel > summary").click();
  await page.getByRole("textbox", { name: "产品名称 *" }).fill("校验测试产品");
  await page.getByRole("textbox", { name: /关联研究报告 ID/ }).fill("invalid-report-id");
  await page.getByRole("button", { name: "创建产品企划" }).click();
  await expect(page.getByText(/研究报告 ID 必须是有效的 UUIDv7/)).toBeVisible();
  await page.getByPlaceholder("搜索产品名称或描述…").fill("旅行");
  await page.getByLabel("产品状态").selectOption("developing");
  await page.getByLabel("负责人").selectOption({ label: "Lin Q." });
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/q=%E6%97%85%E8%A1%8C|q=旅行/);
  await expect(page).toHaveURL(/status=developing/);
  await expect(page).toHaveURL(/owner=0198fbef/);
  await expect(page.getByText("TRAVEL-MUG-GIFT", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "打开 轻定制旅行礼品杯" }).click();
  await expect(page.locator("#product-detail")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const scroll = page.locator(".product-catalog-table-scroll");
  expect(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
});

test("Store ledger drills into layered real-data operations without page overflow", async ({ page }) => {
  const storeName = `E2E Store ${createEntityId().slice(-8)}`;
  await page.goto("/stores");
  await expect(page.getByRole("heading", { name: "店铺运营" })).toBeVisible();
  const createPanel = page.locator("details.store-create-panel");
  if (!await createPanel.evaluate((element) => (element as HTMLDetailsElement).open)) {
    await page.getByText("新增店铺连接", { exact: true }).click();
  }
  await page.getByLabel("连接名称").fill(storeName);
  await page.getByRole("button", { name: "创建连接" }).click();
  await expect(page.getByText(storeName, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: `打开 ${storeName} 店铺详情` }).click();
  await expect(page.getByRole("heading", { name: storeName })).toBeVisible();
  for (const label of ["概览", "Listings", "订单", "健康与能力", "设置"]) {
    await expect(page.getByRole("heading", { name: label })).toBeVisible();
  }
  await expect(page.getByText("系统不会生成占位订单。", { exact: false })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.locator(".store-detail-nav").evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
});

test("Listing editor keeps one live draft and a local-only preview", async ({ page }) => {
  await page.goto(`/listings/${createEntityId()}`);
  const title = page.getByRole("textbox", { name: /商品标题/ });
  await title.fill("Updated travel mug title");
  await expect(page.getByText("● 未保存", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Updated travel mug title" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存为新版本" })).toBeEnabled();
  await expect(page.getByText(/不代表平台在线状态/)).toBeVisible();
  await page.getByRole("button", { name: "Media" }).click();
  await expect(page.getByRole("heading", { name: "媒体与 A+ 计划" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("P3 inventory workspace uses the real projection", async ({ page }) => {
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "库存台账" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("库存桶汇总").or(page.getByText("还没有库存事实", { exact: true })),
  ).toBeVisible();
});

test("P3 procurement workspace uses the real projection", async ({ page }) => {
  await page.goto("/procurement");
  await expect(page.getByRole("heading", { name: "采购与补货" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("采购运营摘要").or(page.getByText("还没有采购证据", { exact: true })),
  ).toBeVisible();
});

test("P3 supplier performance workspace keeps score gaps explicit", async ({ page }) => {
  await page.goto("/supplier-performance");
  await expect(page.getByRole("heading", { name: "供应商绩效" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("供应商绩效摘要").or(page.getByText("还没有供应商", { exact: true })),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "供应商绩效" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
});

test("P3 channel inventory workspace uses traceable real projections", async ({ page }) => {
  await page.goto("/channel-inventory");
  await expect(page.getByRole("heading", { name: "渠道库存" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("渠道库存运营摘要").or(page.getByText("还没有渠道库存证据", { exact: true })),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "渠道库存" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
});

test("P3 finance workspace keeps incomplete evidence explicit", async ({ page }) => {
  await page.goto("/finance");
  await expect(page.getByRole("heading", { name: "财务与利润" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("财务证据摘要").or(page.getByText("还没有财务证据", { exact: true })),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "财务与利润" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
});

test("P3 customer intelligence keeps consent and mutation boundaries explicit", async ({ page }) => {
  await page.goto("/customer-intelligence");
  await expect(page.getByRole("heading", { name: "广告与 VOC" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("广告与 VOC 摘要").or(page.getByText("还没有广告或客户信号证据", { exact: true }))).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "广告与 VOC" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("P3 operating cockpit keeps gaps and delivery evidence explicit", async ({ page }) => {
  await page.goto("/operating-cockpit");
  await expect(page.getByRole("heading", { name: "运营驾驶舱" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(15);
  await expect(page.getByLabel("运营驾驶舱摘要").or(page.getByText("运营信号暂不可用", { exact: true }))).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "运营驾驶舱" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

async function buildAndVerifyExport() {
  const bytes = new TextEncoder().encode("authorized asset");
  const id = createEntityId();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = ExportManifestSchema.parse({
    exportId: id,
    tenantId: id,
    platform: "amazon",
    listingId: id,
    listingVersionId: id,
    ruleVersion: "amazon-us-2026-07",
    files: [{ path: "media/main.png", sha256, assetId: id, assetVersion: 1 }],
    createdBy: id,
    createdAt: "2026-07-18T04:00:00.000Z",
  });
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("media/main.png", bytes);
  const archive = await zip.generateAsync({ type: "uint8array" });
  const loaded = await JSZip.loadAsync(archive);
  const restored = JSON.parse(await loaded.file("manifest.json")!.async("string"));
  const restoredBytes = await loaded.file(restored.files[0].path)!.async("uint8array");
  return (
    ExportManifestSchema.safeParse(restored).success &&
    createHash("sha256").update(restoredBytes).digest("hex") === restored.files[0].sha256
  );
}
