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
import { startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";

test("six centers preserve an operator-edited order through artwork, partial production, shipping and after-sales", async ({
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
      kind: "manual",
      regionCode: "CN",
      settlementCurrency: "USD",
    });
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
    await page.getByLabel("销售 SKU 制作版本").selectOption(profile.recipeId);
    await page
      .getByLabel("制作说明", { exact: true })
      .fill("Use the operator-selected original. Keep the complete subject.");
    await page.getByRole("button", { name: "添加定制字段" }).click();
    await page.getByLabel("字段名称").last().fill("Customer name");
    await page.getByLabel("定制内容").last().fill("Synthetic Alice");
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
    await page.getByRole("button", { name: "确认审单并保存" }).click();
    await expect(page.getByRole("status").filter({ hasText: "审单已保存" })).toBeVisible();
    const before = await centerApi<OrderWorkDetail>(`order-centers/lines/${id}`);
    expect(before.line).toMatchObject({ artwork: "not_pushed", editorProjectId: null });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: testInfo.outputPath("orders-reviewed-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "确认并派发设计", exact: true }).click();
    await expect(page.getByRole("button", { name: "撤回并修改需求" })).toBeVisible();
    await expect(page.getByLabel("通用工艺底稿")).toBeDisabled();
    await page.getByRole("button", { name: "返回订单中心" }).click();
    await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue(externalId);
    await page.goto(`/order-artwork?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByRole("button", { name: "领取并开始制作" }).click();
    const editor = page.getByRole("region", { name: "当前任务生产作图" });
    await expect(editor.locator("canvas.upper-canvas")).toBeVisible();
    await editor.getByRole("button", { name: /添加 正面.*operator-original.*到画布/ }).click();
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
    await page.getByText("处理与交接", { exact: true }).click();
    await page.getByRole("button", { name: "生成正式生产文件" }).click();
    await page.getByText(/文件历史与生成记录（/).click();
    await expect(page.getByText("正式文件 · 已生成", { exact: false })).toBeVisible({
      timeout: 45_000,
    });
    await page.getByRole("link", { name: /生产：/ }).click();
    await page.getByLabel("生产工厂").selectOption(supplier.id);
    await page.getByLabel("下达数量").fill("1");
    await page.getByLabel("计划完工时间").fill("2026-09-14T10:00");
    await page.getByRole("button", { name: "下达生产", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "生产任务已下达" })).toBeVisible();
    for (const [index, name] of [
      "记录已发送工厂",
      "记录工厂已接单",
      "记录开始生产",
      "记录生产完工",
    ].entries()) {
      await page.getByLabel("凭证 / 工厂记录编号").fill(`SYNTHETIC_${index}`);
      await page.getByLabel("发生时间", { exact: true }).fill(`2026-09-13T0${index + 1}:00`);
      await page.getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await page.getByText("登记质检结果", { exact: true }).click();
    await page.getByLabel("检验标准").selectOption(standard.id);
    await page.getByLabel("检验分数").fill("100");
    await page.getByLabel("检验时间").fill("2026-09-13T05:00");
    await page.getByRole("button", { name: "保存质检结果" }).click();
    await expect(page.getByText("已完工 · 质检通过", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /发货：/ }).click();
    await page.getByLabel("包裹编号").fill(`PACK-${suffix}`);
    await page.getByLabel("物流单号", { exact: true }).fill(`SYNTHETIC-${suffix}`);
    await page.getByLabel("承运商代码").fill("USPS");
    await page.getByLabel("承运商名称").fill("USPS");
    await page.getByLabel("物流服务").fill("Synthetic service");
    await page.getByLabel("发货国家").selectOption("US");
    await page.getByLabel("计划发货时间", { exact: true }).fill("2026-09-13T06:00");
    await page.getByRole("button", { name: "保存包裹草稿" }).click();
    await page.getByLabel("核对说明").fill("Synthetic package checked");
    await page.getByRole("button", { name: "审核通过", exact: true }).click();
    await page.getByLabel("实际交运时间").fill("2026-09-13T06:00");
    await page.getByLabel("交运凭证 / 说明").fill("Synthetic pickup receipt");
    await page.getByRole("button", { name: "确认已交运" }).click();
    await expect(page.getByText("质检通过 1 件，已经发出 1 件。", { exact: true })).toBeVisible();
    const operations = await centerApi<OrderOperationsView>(`order-centers/lines/${id}/operations`);
    expect(operations.shipments[0]!.writebacks).toHaveLength(0);
    await page.getByRole("link", { name: /售后：/ }).click();
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
    await expect(page.getByText("Synthetic issue handled", { exact: false })).toBeVisible();
    await page.goto(`/shipments?q=${externalId}`);
    await page.getByRole("combobox", { name: "发货状态", exact: true }).selectOption("partial");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("button", { name: externalId, exact: true })).toBeVisible();
    await page.getByLabel("视图名称").fill("Synthetic partial shipments");
    await page.getByRole("button", { name: "保存当前筛选" }).click();
    await page.getByRole("combobox", { name: "发货状态", exact: true }).selectOption("shipped");
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(page.getByRole("button", { name: externalId, exact: true })).toHaveCount(0);
    await page.getByRole("combobox", { name: "保存的视图", exact: true }).selectOption({ label: "Synthetic partial shipments" });
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
      await page.setViewportSize({ width: 390, height: 844 });
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`${route}-mobile.png`), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    expect(errors).toEqual([]);
  } finally {
    worker.kill();
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
