import { fillQualityAssessment } from "./quality-assessment-form";
import { expect, test, type Page } from "@playwright/test";
import {
  createEntityId,
  type AmazonReportBatchView,
  type AmazonReportWorkspaceView,
  type MarketplaceAccountView,
} from "@yummyai/contracts";
import type { OrderWorkDetail, OrderOperationsView } from "@yummyai/contracts/order/workspace";
import { apiFetch } from "../src/server-api";
import { centerApi, createCenterProfile } from "./order-centers-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";
import { seedOperatingMetricEvidence } from "./operating-metric-evidence-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";
import { loginErp } from "./erp-identity-fixture";

test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page); });

test("six centers preserve an operator-edited order through artwork, whole production, shipping and after-sales", async ({
  page,
}, testInfo) => {
  test.setTimeout(360_000);
  page.setDefaultTimeout(20_000);
  const worker = await startProductionEditorWorker();
  const suffix = createEntityId().slice(-8),
    externalId = `E2E-CENTERS-${suffix}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon",
    displayName: `E2E Centers ${suffix}`,
    region: "NA",
    marketplaceIds: ["ATVPDKIKX0DER"],
    authorizationMode: "amazon_private",
    requestedScopes: [],
  });
  try {
    const profile = await createCenterProfile("tire_cover", suffix);
    const supplier = await centerApi<{ id: string }>("sourcing/suppliers", {
      name: `E2E Centers Factory ${suffix}`,
      profile: syntheticSupplierProfile,
      kind: "manual",
      regionCode: "CN",
      settlementCurrency: "USD",
    });
    const factory = await createFactoryFixture(supplier.id, "tire_cover", `E2E Centers Site ${suffix}`);
    const standard = await centerApi<{ id: string }>("order-centers/quality-standards", {
      name: `E2E Centers QC ${suffix}`,
      minimumScoreBps: 9000,
      criteria: [
        { code: "PRINT", label: "Synthetic print check", weightBps: 10000, blocking: true },
      ],
    });
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
      accountId: account.id,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-centers.txt",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${externalId}\tITEM-${suffix}\t${new Date().toISOString()}\tCENTER-SKU-${suffix}\tSynthetic custom order\t2\tUSD\t40.00`,
    });
    const workspace = await centerApi<AmazonReportWorkspaceView>(
      `orders/reports/workspace?batchId=${batch.id}`,
    );
    const id = workspace.lines[0]!.orderLineId;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/orders?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByText("平台发货截止：待核对", { exact: true }).click();
    await page.getByLabel("平台最晚发货时间").fill("2026-10-01T18:00");
    await page.getByLabel("平台交期核对依据").fill("Synthetic Seller Central ship-by verification");
    await page.getByRole("button", { name: "保存平台交期核对" }).click();
    await expect(page.getByRole("status").filter({ hasText: "平台交期核对已记录" })).toBeVisible();
    await page.getByLabel("销售 SKU 制作版本").selectOption(profile.recipeId);
    await page.getByRole("dialog").getByLabel("设计执行方式").selectOption("human");
    await page.getByRole("checkbox", { name: "需要客户确认校样" }).check();
    await page
      .getByLabel("制作说明", { exact: true })
      .fill("Use the operator-selected original. Keep the complete subject.");
    await page.getByRole("button", { name: "添加定制字段" }).click();
    await page.getByLabel("字段名称").last().fill("Customer name");
    await page.getByLabel("定制内容", { exact: true }).last().fill("Synthetic Alice");
    await page.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
    await page
      .getByLabel("上传订单定制图片")
      .setInputFiles({
        name: "operator-original.png",
        mimeType: "image/png",
        buffer: syntheticProductionPng(),
      });
    await expect(page.getByRole("status").filter({ hasText: "图片已上传" })).toBeVisible();
    await page.getByRole("checkbox", { name: "operator-original.png" }).check();
    await page.getByRole("button", { name: "确认本件审单" }).click();
    await expect(page.getByRole("dialog", { name: "整单详情", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
    const before = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
    expect(before.line).toMatchObject({ artwork: "not_pushed", editorProjectId: null });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("orders-reviewed-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "推送本件设计", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "推送制图已记录" })).toBeVisible();
    await page.getByRole("button", { name: "返回订单中心", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`)).line.preparation).toBe("pushed");
    await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue(externalId);
    await page.goto(`/order-artwork?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByText("处理与交接", { exact: true }).click();
    await page.getByRole("button", { name: "领取并开始制作" }).click();
    const editor = page.getByRole("region", { name: "当前任务生产作图" });
    await expect(editor.locator("canvas.upper-canvas")).toBeVisible({ timeout: 45_000 });
    const enhancedImage = editor.getByRole("button", { name: /添加 .*保真美化.*operator-original.*到画布/ });
    await expect(enhancedImage).toBeEnabled({ timeout: 45_000 });
    await enhancedImage.click();
    await editor.getByRole("button", { name: "生成后台校对预览" }).click();
    await editor.getByRole("tab", { name: "预检确认", exact: true }).click();
    await editor.getByRole("checkbox", { name: "实际尺寸与尺寸口径已由工厂确认" }).check();
    await expect(
      editor.getByRole("checkbox", { name: "已查看当前图稿的后台校对预览" }),
    ).toBeEnabled({ timeout: 45_000 });
    await editor.getByRole("checkbox", { name: "已查看当前图稿的后台校对预览" }).check();
    await editor.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(editor.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await editor.getByRole("button", { name: "返回制图任务" }).click();
    await page.getByRole("button", { name: "生成当前预览", exact: true }).click();
    await expect(page.getByRole("button", { name: "提交文件审核" })).toBeEnabled({ timeout: 45_000 });
    await page.getByRole("button", { name: "提交文件审核" }).click();
    await expect(page.getByRole("button", { name: "通过审核", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "通过审核", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "审核已通过，系统会自动准备生产文件" })).toBeVisible();
    if (!await page.getByLabel("操作原因 / 客户确认依据").isVisible()) await page.getByText("处理与交接", { exact: true }).click();
    await page.getByLabel("操作原因 / 客户确认依据").fill("Synthetic customer approved this exact artwork version");
    await page.getByRole("button", { name: "记录客户已确认", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "记录客户确认已记录" })).toBeVisible();
    await expect.poll(async () => (await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`)).line.proofVersionCurrent).toBe(true);
    await expect.poll(async () => (await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`)).line.artwork).toBe("approved");
    await expect(page.getByText("正式生产文件 · 显示完整排版，可切换原尺寸检查细节。", { exact: true })).toBeVisible({ timeout: 45_000 });
    await page.getByText(/文件历史与生成记录（/).click();
    await expect(page.getByText("正式文件 · 已生成", { exact: false })).toBeVisible({
      timeout: 45_000,
    });
    await page.goto(`/production?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByLabel("承接工厂").selectOption(factory.factory.id);
    await page.getByLabel("整单计划完工").fill("2026-09-14T10:00");
    await page.getByRole("button", { name: "安排整单生产（2 件）", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "整单生产已安排" })).toBeVisible();
    for (const [index, name] of [
      "记录整单已发送工厂",
      "记录工厂已接整单",
      "记录整单开始生产",
      "记录整单生产完工",
    ].entries()) {
      await page.getByLabel("整单工厂凭证").fill(`SYNTHETIC_${index}`);
      await page.getByLabel("整单进度发生时间", { exact: true }).fill(`2026-09-13T0${index + 1}:00`);
      await page.getByRole("form", { name: "登记整单生产进度", exact: true }).getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("form", { name: "登记整单生产进度", exact: true }).getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await fillQualityAssessment(page.getByRole("region", { name: "整单生产", exact: true }), standard.id, [{ label: "Synthetic print check", score: "100", outcome: "passed" }]);
    await page.getByLabel("整单质检时间").fill("2026-09-13T05:00");
    await page.getByRole("checkbox", { name: "已逐项核对本单全部商品 均符合所选标准" }).check();
    await page.getByRole("button", { name: "登记整单质检通过" }).click();
    await expect(page.getByText("全部商品已生产并通过质检。", { exact: false })).toBeVisible();
    await page.goto(`/shipments?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByLabel("物流单号", { exact: true }).fill(`SYNTHETIC-${suffix}`);
    await page.getByLabel("承运商代码").fill("USPS");
    await page.getByLabel("承运商名称").fill("USPS");
    await page.getByLabel("物流服务").fill("Synthetic service");
    await page.getByLabel("发货国家").selectOption("US");
    await page.getByLabel("计划发货时间", { exact: true }).fill("2026-09-13T06:00");
    await expect(page.getByLabel("物流单号", { exact: true })).toHaveValue(`SYNTHETIC-${suffix}`);
    await expect(page.getByLabel("承运商代码", { exact: true })).toHaveValue("USPS");
    await expect(page.getByLabel("承运商名称", { exact: true })).toHaveValue("USPS");
    await expect(page.getByLabel("物流服务", { exact: true })).toHaveValue("Synthetic service");
    await page.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true }).check();
    await page.getByRole("button", { name: "保存整单包裹（2 件）" }).click();
    await page.getByLabel("核对说明").fill("Synthetic package checked");
    await page.getByRole("button", { name: "审核通过", exact: true }).click();
    await page.getByLabel("实际交运时间").fill("2026-09-13T06:00");
    await page.getByLabel("交运凭证 / 说明").fill("Synthetic pickup receipt");
    await page.getByRole("button", { name: "确认整单已出库" }).click();
    await expect(page.getByText("质检通过 2/2 件 · 已出库 2 件", { exact: true })).toBeVisible();
    const operations = await centerApi<OrderOperationsView>(`order-centers/lines/${id}/operations`);
    expect(operations.shipments[0]!.writebacks).toHaveLength(0);
    await page.getByLabel("整单下一步").getByRole("button", { name: "登记平台确认", exact: true }).click();
    await expect(page.getByLabel("平台确认时间")).toBeVisible();
    await page.getByLabel("平台确认时间").fill("2026-09-13T06:30");
    await page.getByLabel("平台发货确认凭证").fill("Synthetic Seller Central accepted tracking receipt");
    await page.getByRole("button", { name: "记录已在平台确认发货" }).click();
    await expect(page.getByText(/已人工核对平台发货确认/)).toBeVisible();
    expect((await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`)).line.platformConfirmationPending).toBe(false);
    await page.getByRole("navigation", { name: "本单操作" }).getByRole("button", { name: "售后", exact: true }).click();
    await page.getByLabel("问题类型").selectOption("customer_contact");
    await page.getByLabel("原因分类").fill("SYNTHETIC_QUESTION");
    await page.getByLabel("问题说明").fill("Synthetic customer question");
    await page.getByRole("button", { name: "登记售后", exact: true }).click();
    await expect(page.getByText("Synthetic customer question", { exact: true })).toBeVisible();
    await page.getByText("记录处理方案", { exact: true }).click();
    await page.getByRole("combobox", { name: "处理方案", exact: true }).selectOption("no_action");
    await page.getByLabel("处理依据").fill("Synthetic answer was confirmed");
    await page.getByRole("button", { name: "保存处理方案" }).click();
    await page.getByText("登记实际处理完成", { exact: true }).click();
    await page.getByLabel("执行凭证编号").fill(`ANSWER-${suffix}`);
    await page.getByLabel("完成时间", { exact: true }).fill("2026-09-13T07:00");
    await page.getByLabel("处理结果").fill("Synthetic issue handled");
    await page.getByRole("button", { name: "记录完成并结案" }).click();
    const afterSalesDrawer = page.getByRole("dialog", { name: "整单详情", exact: true });
    await expect(afterSalesDrawer.getByRole("status").filter({ hasText: "执行依据已保存，售后已结案。" })).toBeVisible();
    await afterSalesDrawer.getByRole("button", { name: "查看已结案记录（1）", exact: true }).click();
    await expect(afterSalesDrawer.locator(".oc-record-history").getByText("Synthetic issue handled", { exact: false })).toBeVisible();
    await expect(afterSalesDrawer.getByRole("button", { name: "记录完成并结案" })).toHaveCount(0);
    // The operations history can update before the parent detail finishes its read.
    await expect(afterSalesDrawer.locator(".oc-review-detail")).toHaveAttribute("aria-busy", "false");
    await page.goto(`/after-sales?q=${externalId}`);
    await expect(page.getByRole("button", { name: externalId, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看全部售后订单", exact: true }).click();
    await expect(page.getByRole("button", { name: externalId, exact: true })).toBeVisible();
    await expect(page.getByText("售后已结案，保留历史", { exact: true })).toBeVisible();
    await page.goto(`/shipments?q=${externalId}`);
    await page.getByRole("combobox", { name: "订单状态", exact: true }).selectOption("shipped");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("button", { name: externalId, exact: true })).toBeVisible();
    await page.getByText("我的视图", { exact: true }).click();
    await page.getByLabel("视图名称").fill("Synthetic whole shipments");
    await page.getByRole("button", { name: "保存当前筛选" }).click();
    await page.getByText("我的视图", { exact: true }).click();
    await page.getByRole("combobox", { name: "订单状态", exact: true }).selectOption("produced");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("button", { name: externalId, exact: true })).toHaveCount(0);
    await page.getByText("我的视图", { exact: true }).click();
    await page.getByRole("combobox", { name: "保存的视图", exact: true }).selectOption({ label: "Synthetic whole shipments" });
    await expect(page.getByRole("button", { name: externalId, exact: true })).toBeVisible();
    for (const route of [
      "orders",
      "order-artwork",
      "production",
      "shipments",
      "after-sales",
      "process-library",
    ]) {
      await page.goto(`/${route}${route === "process-library" ? "" : `?q=${externalId}`}`);
      await expect(page.locator(".oc-page")).toBeVisible();
      await expect(page.locator(".oc-page")).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`${route}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`${route}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(errors).toEqual([]);
  } finally {
    await stopProductionEditorWorker(worker);
    await apiFetch(`${process.env.API_BASE_URL}/v1/marketplace-accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
  }
});

async function noOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
}

test("finance and advertising show real empty workspace states at desktop and mobile widths", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const [route, heading] of [["finance", "财务与利润"], ["customer-intelligence", "广告与 VOC"]]) {
    await page.goto(`/${route}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.locator(".finance-load-state, .customer-intelligence-load-state")).toHaveCount(0);
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({width, height});
      await noOverflow(page);
      await page.screenshot({path: testInfo.outputPath(`${route}-${name}.png`), fullPage: true});
    }
  }
  expect(errors).toEqual([]);
});

test("finance and advertising keep mixed attribution and incomplete costs explicit", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await seedOperatingMetricEvidence();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/customer-intelligence");
  await page.getByRole("button", { name: "VOC", exact: true }).click();
  await expect(page.getByRole("button", { name: "VOC", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page).toHaveURL(/\btab=voc\b/);
  await expect(page.getByText(/期间重叠.*停止合计/)).toBeVisible();
  for (const title of ["人工导入 · 广告活动 · USD · 7 天归因", "人工导入 · 搜索词 · USD · 7 天归因", "人工导入 · 广告活动 · EUR · 7 天归因"])
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  for (const route of ["customer-intelligence", "finance"]) {
    await page.goto(route === "customer-intelligence" ? "/customer-intelligence?tab=voc" : `/${route}`);
    if (route === "finance") {
      await expect(page.getByText("等待完整证据", { exact: true })).toBeVisible();
      await expect(page.getByText(/未归属/).first()).toBeVisible();
      await expect(page.getByText(/生产成本/).first()).toBeVisible();
      await expect(page.getByText("缺失", { exact: true }).first()).toBeVisible();
    }
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({width, height});
      await noOverflow(page);
      await page.screenshot({path: testInfo.outputPath(`${route}-evidence-${name}.png`), fullPage: true});
    }
  }
  expect(errors).toEqual([]);
});
