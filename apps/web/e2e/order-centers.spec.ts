import { fillQualityAssessment } from "./quality-assessment-form";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  createEntityId,
  type AmazonReportBatchView,
  type AmazonReportWorkspaceView,
  type MarketplaceAccountView,
} from "@yummyai/contracts";
import { OrderWorkSelectionInputSchema, type OrderWorkDetail, type OrderOperationsView } from "@yummyai/contracts/order/workspace";
import { FulfillmentCommandListSchema } from "@yummyai/contracts/order/fulfillment-command";
import { OrderExceptionOperationsViewSchema } from "@yummyai/contracts/order/exception-operations";
import type { ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import type { ArtworkView, DevelopmentOptions, SpecificationView } from "@yummyai/contracts/catalog/development";
import { apiFetch } from "../src/server-api";
import { centerApi, createCenterProfile } from "./order-centers-fixture";
import { startProductionEditorWorker, stopProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";
import { seedOperatingMetricEvidence } from "./operating-metric-evidence-fixture";
import { createFactoryFixture } from "./factory-directory-fixture";
import { createCapacityFixture, fillProductionCapacity } from "./factory-capacity-fixture";
import { syntheticSupplierProfile } from "../../../tools/testing/factory-fixtures";
import { loginErp } from "./erp-identity-fixture";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";

test.beforeEach(async ({ page }) => { if (process.env.WEB_AUTH_MODE === "personal") await loginErp(page); });

test("six centers show real filtered order, product-row and unit totals without production or model actions", async ({ page }, testInfo) => {
  test.skip(process.env.E2E_ISOLATED_DAILY !== "1", "This acceptance leaf owns disposable resources only");
  requireDisposableIntegrationEnvironment();
  test.setTimeout(90_000);
  const prefix = `SYNTHETIC-DAILY-COUNTS-${createEntityId()}`;
  const forbidden: string[] = [], errors: string[] = [];
  let readOnlySummaryPosts = 0;
  const forbid = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/order-centers/summaries"
      && OrderWorkSelectionInputSchema.safeParse(request.postDataJSON()).success) { readOnlySummaryPosts++; return; }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && path.startsWith("/api/")) forbidden.push(path);
  };
  page.on("request", forbid); page.on("pageerror", error => errors.push(error.message));
  const account = await centerApi<MarketplaceAccountView>("marketplace-accounts", {
    platform: "amazon", displayName: prefix, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [],
  });
  let batchId: string | null = null;
  try {
    const now = new Date().toISOString();
    const content = ["order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price",
      `${prefix}-A\tA0\t${now}\t${prefix}-A0\tSynthetic three-unit product row\t3\tUSD\t30.00`,
      `${prefix}-A\tA1\t${now}\t${prefix}-A1\tSynthetic one-unit sibling\t1\tUSD\t10.00`,
      `${prefix}-B\tB0\t${now}\t${prefix}-B0\tSynthetic two-unit second order\t2\tUSD\t20.00`].join("\n");
    const batch = await centerApi<AmazonReportBatchView>("orders/reports/import", {
      accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-operations-counts.tsv", content,
    });
    batchId = batch.id;
    const scope = new URLSearchParams({ accountId: account.id, q: prefix });
    const real = await centerApi<{ total: number; groupTotal: number; matchingQuantity: number }>(`order-centers/workspace?${scope}&module=orders&grouping=orders&pageSize=1`);
    expect(real).toMatchObject({ total: 3, groupTotal: 2, matchingQuantity: 6 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/orders?${scope}`);
    const statistics = page.getByLabel("当前订单列表统计", { exact: true });
    await expect(statistics).toContainText("筛选结果 2 单 · 3 商品行 · 6 件");
    await expect(page.locator(".oc-order-group")).toHaveCount(2);
    await expect(page.locator("article.oc-product-row").getByText("平台交期待核对", { exact: true })).toHaveCount(3);
    await expect(page.locator("article.oc-product-row").getByText("定制内容可读取", { exact: true })).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath("operations-counts-desktop.png"), fullPage: true });
    const priority = page.getByRole("group", { name: "优先处理筛选", exact: true }).getByRole("button", { name: "平台交期待核对", exact: true });
    await priority.click(); await expect(priority).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => { const url = new URL(page.url()); return { accountId: url.searchParams.get("accountId"), q: url.searchParams.get("q"), attention: url.searchParams.get("attention") }; }).toEqual({ accountId: account.id, q: prefix, attention: "platform_deadline_missing" });
    await expect(statistics).toContainText("筛选结果 2 单 · 3 商品行 · 6 件");
    await priority.click(); await expect(priority).toHaveAttribute("aria-pressed", "false");
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    await page.getByRole("textbox", { name: "商品 SKU", exact: true }).fill(`${prefix}-A0`);
    await page.getByRole("button", { name: "查询", exact: true }).click();
    await expect(statistics).toContainText("筛选结果 1 单 · 1 商品行 · 3 件");
    await expect(page.locator("article.oc-product-row")).toHaveCount(1);
    await expect(page.getByText("整单 2 商品行 · 4 件", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("operations-counts-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: prefix + "-A", exact: true }).click();
    const whole = page.getByRole("region", { name: "整单详情", exact: true });
    const recovery = whole.getByRole("region", { name: "本单原履约提交恢复", exact: true });
    const exceptions = whole.getByRole("region", { name: "订单异常处理", exact: true });
    const recoveryHistory = whole.locator("details.oc-recovery-history");
    const exceptionHistory = whole.locator("details.order-exception-history");
    // Empty recovery and exception directories are real authenticated API reads.
    await expect(recoveryHistory).toHaveCount(1); await expect(recoveryHistory).not.toHaveAttribute("open");
    await expect(exceptionHistory).toHaveCount(1); await expect(exceptionHistory).not.toHaveAttribute("open");
    await recoveryHistory.locator("summary").click(); await exceptionHistory.locator("summary").click();
    await expect(recovery).toContainText("本次读取没有未核对的原履约提交");
    await expect(exceptions).toContainText("待解决 0");
    const recoveryRoute = "**/api/order-centers/fulfillment-commands?**";
    const exceptionRoute = "**/api/order-exceptions/*?**";
    // Read-only UI fault fixtures; no command/exception is persisted or executed.
    const commandId = createEntityId(), exceptionId = createEntityId();
    await page.route(recoveryRoute, async route => {
      const request = route.request(); if (request.method() !== "GET") return route.continue();
      const orderId = new URL(request.url()).searchParams.get("orderId")!;
      const body = FulfillmentCommandListSchema.parse({ items: [{
        id: commandId, requestId: createEntityId(), requestChecksum: "a".repeat(64), kind: "production_milestone",
        targetId: createEntityId(), orderId, lineIds: [createEntityId()], status: "prepared", createdAt: now,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), leaseExpiresAt: null, acknowledged: false,
        canExecute: false, canCancel: false, summary: null, receipt: null, errorCode: null,
      }], truncated: false });
      await route.fulfill({ status: 200, headers: { "x-yummyai-context-authority": request.headers()["x-yummyai-context-authority"]! }, json: body });
    });
    await page.route(exceptionRoute, async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch(); expect(response.status()).toBe(200);
      const realEmpty = OrderExceptionOperationsViewSchema.parse(await response.json());
      expect(realEmpty.items).toEqual([]);
      const body = OrderExceptionOperationsViewSchema.parse({ ...realEmpty, total: 1, summary: { open: 1, resolved: 0, missingEvent: 0 }, items: [{
        exception: { id: exceptionId, orderId: realEmpty.orderId, category: "customization_missing", code: "SYNTHETIC-READ-ONLY-VISIBILITY",
          message: "Synthetic unresolved exception remains visible", status: "open", resolution: null, openedAt: now, resolvedAt: null },
        sequence: 1, sourceChecksum: "b".repeat(64), canResolve: false, eventMissing: false,
      }] });
      await route.fulfill({ response, json: body });
    });
    await recovery.getByRole("button", { name: "只读核对本单原提交", exact: true }).click();
    await exceptions.getByRole("button", { name: "重新读取异常记录", exact: true }).click();
    await expect(recovery.locator('article:not([hidden])')).toHaveCount(1);
    await expect(recovery).toContainText("原提交已保存 等待执行");
    await expect(exceptions.locator('[data-exception-id="' + exceptionId + '"]')).toBeVisible();
    await expect(exceptions).toContainText("待解决 1");
    await expect(recovery.locator('xpath=ancestor::details[not(@open)]')).toHaveCount(0);
    await expect(exceptions.locator('xpath=ancestor::details[not(@open)]')).toHaveCount(0);
    await expect(whole.locator("details.oc-whole-advanced")).not.toHaveAttribute("open");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(recovery).toBeVisible(); await expect(exceptions).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("operations-attention-mobile.png"), fullPage: true });
    await page.unroute(recoveryRoute);
    await page.route(recoveryRoute, route => route.fulfill({ status: 503, json: { message: "Synthetic read-only recovery outage" } }));
    await recovery.getByRole("button", { name: "只读核对本单原提交", exact: true }).click();
    await expect(recovery.getByRole("alert")).toContainText("本次响应尚未核对");
    await expect(recovery.locator('xpath=ancestor::details[not(@open)]')).toHaveCount(0);
    await page.unroute(recoveryRoute); await page.unroute(exceptionRoute);
    await page.goto(`/orders?${scope}&sku=SYNTHETIC-NOT-MATCHED`);
    await expect(statistics).toContainText("筛选结果 0 单 · 0 商品行 · 0 件");
    await page.route("**/api/order-centers/workspace?**", route => route.fulfill({ status: 503, json: { message: "Synthetic list outage" } }));
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(statistics).toContainText("订单与件数暂不可用");
    await expect(statistics).not.toContainText("0 商品行");
    expect(readOnlySummaryPosts).toBeGreaterThan(0); expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  } finally {
    page.off("request", forbid);
    await testInfo.attach("operations-counts-owned-fixtures", { contentType: "application/json", body: Buffer.from(JSON.stringify({
      syntheticFixtureOnly: true, accountId: account.id, batchId, queryPrefix: prefix, forbiddenBrowserWrites: forbidden, readOnlySummaryPosts,
      cleanupOwner: "disposable acceptance runner database/bucket/Redis finally", productionReleased: false, modelGenerationRequested: false,
      realApiEvidence: ["authenticated report import", "filtered paged counts", "empty recovery and exception reads"],
      readOnlyUiFaults: ["prepared command GET", "open exception GET", "recovery 503", "workspace 503"],
    })) });
  }
});

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
  const currentLocalMinute = (offsetMs = 0) => page.evaluate(offset => {
    const now = new Date(Date.now() + offset), pad = (value: number) => String(value).padStart(2, "0");
    return [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-")
      + "T" + [pad(now.getHours()), pad(now.getMinutes())].join(":");
  }, offsetMs);
  const acknowledgeFulfillment = async (operation: string) => {
    const recovery = page.getByRole("region", { name: "本单原履约提交恢复", exact: true });
    const original = recovery.locator("article:not([hidden])");
    await expect(original).toHaveCount(1);
    await expect(original).toContainText(operation + " · 已有原业务回执");
    await original.getByRole("button", { name: "已核对本次履约结果", exact: true }).click();
    await expect(original).toHaveCount(0);
    await expect(recovery).toContainText("本次读取没有未核对的原履约提交");
  };
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
    const source = profile.manufacturingSource;
    if (!source) throw new Error("Synthetic reviewed specification is required for manufacturing");
    const stock = await centerApi<{ id: string }>("inventory/stock-items", {
      skuId: null, code: `CENTERS-FABRIC-${suffix}`.toUpperCase(), name: "Synthetic centers fabric", baseUnit: "meter",
    });
    const { data: manufacturing } = await centerApi<{ data: ManufacturingRecipeVersionView }>("manufacturing-recipes", {
      spuId: source.spuId, specificationId: source.specificationId, code: `CENTERS-BOM-${suffix}`, idempotencyKey: createEntityId(),
      content: { specificationVersionId: source.specificationVersionId, name: "Synthetic reviewed centers BOM", outputQuantity: 1, outputUnit: "each",
        notes: "Synthetic physical specification and manufacturing source",
        materials: [{ code: "FABRIC", name: "Synthetic centers fabric", stockItemId: stock.id, quantityNumerator: 1, quantityDenominator: 2,
          unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: "merchant", operationCode: "MAKE" }],
        operations: [{ code: "MAKE", name: "Synthetic manufacture", processCode: "make", responsibility: "factory", expectedSecondsPerOutput: null }] },
    });
    await centerApi(`manufacturing-recipes/${manufacturing.recipeId}/reviews`, {
      expectedVersion: manufacturing.versionNumber, versionId: manufacturing.versionId, decision: "approved",
      note: "Synthetic operator reviewed the exact material and process", idempotencyKey: createEntityId(),
    });
    const supplier = await centerApi<{ id: string }>("sourcing/suppliers", {
      name: `E2E Centers Factory ${suffix}`,
      profile: syntheticSupplierProfile,
      kind: "manual",
      regionCode: "CN",
      settlementCurrency: "USD",
    });
    const factory = await createFactoryFixture(supplier.id, "tire_cover", `E2E Centers Site ${suffix}`);
    const capacity = await createCapacityFixture(factory.factory, [factory.capability], 10);
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
    await page.locator("details.oc-platform-editor > summary").click();
    await page.getByLabel("平台最晚发货时间").fill(await currentLocalMinute(2 * 86_400_000));
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
    const production = page.getByRole("region", { name: "整单生产", exact: true });
    const productionForm = production.getByRole("form", { name: "安排整单生产", exact: true });
    const manufacturingChoice = productionForm.getByRole("group", { name: "本次制造依据", exact: true });
    await expect(manufacturingChoice).toHaveCount(1);
    await manufacturingChoice.getByLabel("制造版本", { exact: true }).selectOption(manufacturing.versionId);
    await manufacturingChoice.getByRole("checkbox").check();
    await productionForm.getByLabel("承接工厂").selectOption(factory.factory.id);
    await productionForm.getByLabel("整单工厂当地计划完工", { exact: true }).fill(capacity.dueLocal);
    await fillProductionCapacity(productionForm, capacity);
    await productionForm.getByRole("button", { name: "安排整单生产（2 件）", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "整单生产已安排" })).toBeVisible();
    const productionReceipt = page.getByRole("region", { name: "待确认生产提交", exact: true });
    await expect(productionReceipt).toContainText("已建立 1 个生产安排");
    await productionReceipt.getByRole("button", { name: "已核对本次结果", exact: true }).click();
    await expect(productionReceipt.locator("article:not([hidden])")).toHaveCount(0);
    for (const [index, name] of [
      "记录整单已发送工厂",
      "记录工厂已接整单",
      "记录整单开始生产",
      "记录整单生产完工",
    ].entries()) {
      await page.getByLabel("整单工厂凭证").fill(`SYNTHETIC_${index}`);
      await page.getByLabel("整单进度发生时间", { exact: true }).fill(await currentLocalMinute());
      await page.getByRole("form", { name: "登记整单生产进度", exact: true }).getByRole("button", { name, exact: true }).click();
      await expect(page.getByRole("form", { name: "登记整单生产进度", exact: true }).getByRole("button", { name, exact: true })).toHaveCount(0);
      await acknowledgeFulfillment("登记整单生产进度");
    }
    await fillQualityAssessment(page.getByRole("region", { name: "整单生产", exact: true }), standard.id, [{ label: "Synthetic print check", score: "100", outcome: "passed" }]);
    await page.getByLabel("整单质检时间").fill(await currentLocalMinute());
    await page.getByRole("checkbox", { name: "已逐项核对本单全部商品 均符合所选标准" }).check();
    await page.getByRole("button", { name: "登记整单质检通过" }).click();
    await expect(page.getByText("全部商品已生产并通过质检。", { exact: false })).toBeVisible();
    await acknowledgeFulfillment("登记整单质检");
    await page.goto(`/shipments?q=${externalId}`);
    await page.getByRole("button", { name: externalId, exact: true }).click();
    await page.getByLabel("物流单号", { exact: true }).fill(`SYNTHETIC-${suffix}`);
    await page.getByLabel("承运商代码").fill("USPS");
    await page.getByLabel("承运商名称").fill("USPS");
    await page.getByLabel("物流服务").fill("Synthetic service");
    await page.getByLabel("发货国家").selectOption("US");
    await page.getByLabel("计划发货时间", { exact: true }).fill(await currentLocalMinute());
    await expect(page.getByLabel("物流单号", { exact: true })).toHaveValue(`SYNTHETIC-${suffix}`);
    await expect(page.getByLabel("承运商代码", { exact: true })).toHaveValue("USPS");
    await expect(page.getByLabel("承运商名称", { exact: true })).toHaveValue("USPS");
    await expect(page.getByLabel("物流服务", { exact: true })).toHaveValue("Synthetic service");
    await page.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true }).check();
    await page.getByRole("button", { name: "保存整单包裹（2 件）" }).click();
    await acknowledgeFulfillment("建立整单包裹");
    await page.getByLabel("核对说明").fill("Synthetic package checked");
    await page.getByRole("button", { name: "审核通过", exact: true }).click();
    await acknowledgeFulfillment("审核原包裹版本");
    await page.getByLabel("实际交运时间").fill(await currentLocalMinute());
    await page.getByLabel("交运凭证 / 说明").fill("Synthetic pickup receipt");
    await page.getByRole("button", { name: "确认整单已出库" }).click();
    await acknowledgeFulfillment("登记实际出库");
    await expect(page.getByText("质检通过 2/2 件 · 已出库 2 件", { exact: true })).toBeVisible();
    const operations = await centerApi<OrderOperationsView>(`order-centers/lines/${id}/operations`);
    expect(operations.shipments[0]!.writebacks).toHaveLength(0);
    await page.getByLabel("整单下一步").getByRole("button", { name: "登记平台确认", exact: true }).click();
    await expect(page.getByLabel("平台确认时间")).toBeVisible();
    await page.getByLabel("平台确认时间").fill(await currentLocalMinute());
    await page.getByLabel("平台发货确认凭证").fill("Synthetic Seller Central accepted tracking receipt");
    await page.getByRole("button", { name: "记录已在平台确认发货" }).click();
    await expect(page.getByText(/已人工核对平台发货确认/)).toBeVisible();
    await acknowledgeFulfillment("登记人工平台确认");
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
    await page.getByLabel("完成时间", { exact: true }).fill(await currentLocalMinute());
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
      if (["production", "shipments", "after-sales"].includes(route)) {
        const caption = page.locator(".oc-fulfillment-list > caption");
        await expect(caption).toHaveCount(1);
        await expect(caption).toBeVisible();
        await expect.poll(() => caption.evaluate(element => {
          const bounds = element.getBoundingClientRect(), table = element.closest("table")!.getBoundingClientRect();
          return { spansTable: table.width > 0 && Math.abs(bounds.width - table.width) <= 2,
            compactHeight: bounds.height > 0 && bounds.height <= 72 };
        })).toEqual({ spansTable: true, compactHeight: true });
      }
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

test("six centers automatically match shaped-pillow intake while keeping original sources and manual changes", async ({ page }, testInfo) => {
  if (process.env.E2E_ISOLATED_DAILY !== "1") throw new Error("Disposable shaped-pillow acceptance resources required");
  requireDisposableIntegrationEnvironment();
  test.setTimeout(120_000);
  const { default: JSZip } = await import("jszip");
  const { createHash } = await import("node:crypto");
  const { AmazonReportDetailViewSchema } = await import("@yummyai/contracts/order/report");
  const { OrderWorkDetailViewSchema } = await import("@yummyai/contracts/order/workspace");
  const suffix = createEntityId(), externalId = `SYNTHETIC-AUTO-PILLOW-${suffix}`, externalLineId = `ITEM-${suffix}`;
  const fixtureIds: Record<string, string | null> = { accountId: null, batchId: null, reportLineId: null, orderLineId: null,
    spuId: null, specificationId: null, specificationVersionId: null, artworkId: null, artworkVersionId: null, sourceVersionId: null };
  const reusedCatalog = { spu: false, specification: false, artwork: false };
  const evidence = { assertionsCompleted: false, originalSourcePreserved: false, originalBytesCheckedBeforeAndAfter: false, reportReviewedAfter: null as boolean | null };
  const apiTraffic: Array<{ method: string; path: string }> = [], forbidden: string[] = [], errors: string[] = [];
  let summaryReads = 0, draftWrites = 0, draftSourceVersion: string | null = null;
  const api = async <T,>(path: string, input?: unknown) => {
    apiTraffic.push({ method: input === undefined ? "GET" : "POST", path });
    return centerApi<T>(path, input);
  };
  const observe = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) || !path.startsWith("/api/")) return;
    if (request.method() === "POST" && path === "/api/order-centers/summaries"
      && OrderWorkSelectionInputSchema.safeParse(request.postDataJSON()).success) { summaryReads++; return; }
    if (request.method() === "POST" && fixtureIds.orderLineId && path === `/api/order-centers/lines/${fixtureIds.orderLineId}/draft`) {
      const body = request.postDataJSON();
      if (body.status === "pending_review" && body.expectedSourceVersionId === draftSourceVersion
        && body.draft.specificationVersionId === null && body.draft.printProfileVersionId === null
        && body.draft.artworkVersionId === fixtureIds.artworkVersionId && body.draft.dueAt === null) { draftWrites++; return; }
    }
    forbidden.push(`${request.method()} ${path}`);
  };
  const onError = (error: Error) => errors.push(error.message);
  page.on("request", observe); page.on("pageerror", onError);
  try {
    const initial = await api<DevelopmentOptions>("product-development/options");
    const canonical = initial.spus.filter(spu => spu.code === "CUSTOM-SHAPED-PILLOW");
    expect(canonical.length, "Canonical SPU must be unique before this independent leaf").toBeLessThanOrEqual(1);
    reusedCatalog.spu = !!canonical[0];
    const spu = canonical[0] ?? (await api<{ spu: DevelopmentOptions["spus"][number] }>("product-development/spus", {
      code: "CUSTOM-SHAPED-PILLOW", name: "Synthetic custom shaped pillow", idempotencyKey: createEntityId(),
    })).spu;
    fixtureIds.spuId = spu.id;
    const existingSpecifications = initial.specifications.filter(specification => specification.spuId === spu.id && specification.code === "SIZE-14IN");
    expect(existingSpecifications.length).toBeLessThanOrEqual(1);
    reusedCatalog.specification = !!existingSpecifications[0];
    const specification = existingSpecifications[0] ?? (await api<{ specification: SpecificationView }>("product-development/specifications", {
      spuId: spu.id, code: "SIZE-14IN", name: "Synthetic 14 inch pillow pending production facts", attributes: { size: "14 inch" },
      facts: { formatVersion: 2, material: "", structure: "", dimensions: "", physicalDimensions: null,
        packageContents: "", packageQuantity: null, weightGrams: null, packagedWeightGrams: null, packageMeasurements: null,
        factsConfirmed: false, productionConfirmed: false, verificationReference: "Synthetic unconfirmed acceptance fixture" },
      processProfileVersionId: null, expectedVersion: 0, idempotencyKey: createEntityId(),
    })).specification;
    fixtureIds.specificationId = specification.id; fixtureIds.specificationVersionId = specification.versionId;
    expect(specification.processProfileVersionId).toBeNull(); expect(specification.facts.factsConfirmed).toBe(false);
    expect(specification.facts.productionConfirmed ?? false).toBe(false); expect(specification.facts.weightGrams).toBeNull();
    const commonArt = initial.artworks.filter(artwork => artwork.code === "ART-CUSTOM-SHAPED-PILLOW" && !artwork.archived);
    const latestArt = commonArt.filter(artwork => artwork.version === Math.max(0, ...commonArt.map(value => value.version)));
    expect(latestArt.length).toBeLessThanOrEqual(1);
    reusedCatalog.artwork = !!latestArt[0];
    const artwork = latestArt[0] ?? (await api<{ artwork: ArtworkView }>("product-development/artworks", {
      code: "ART-CUSTOM-SHAPED-PILLOW", name: "Synthetic common customer-photo pillow", mode: "customer_image",
      customization: { version: 1, fields: [{ key: "photo", label: "Customer image", type: "image", required: true,
        validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 1_000_000 } }] },
      instructions: "Synthetic customer-photo scheme only Preserve the original image and customer-selected size",
      expectedVersion: 0, idempotencyKey: createEntityId(),
    })).artwork;
    fixtureIds.artworkId = artwork.id; fixtureIds.artworkVersionId = artwork.versionId;
    expect(artwork.mode).toBe("customer_image"); expect(artwork.materials.every(material => material.role === "reference")).toBe(true);
    const account = await api<MarketplaceAccountView>("marketplace-accounts", {
      platform: "amazon", displayName: externalId, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [],
    });
    fixtureIds.accountId = account.id;
    const promiseDate = new Date(Date.now() + 72 * 3_600_000 + 9 * 3_600_000).toISOString().replace("Z", "+09:00");
    const expectedDeadline = new Date(promiseDate).toISOString();
    const txt = [
      ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "quantity-shipped", "quantity-to-ship", "promise-date"],
      [externalId, externalLineId, new Date(Date.now() - 3_600_000).toISOString(), `SYNTHETIC-PILLOW-${suffix}`,
        "Synthetic custom shaped photo pillow with customer-selected size", "1", "0", "1", promiseDate],
    ].map(row => row.join("\t")).join("\r\n");
    const batch = await api<AmazonReportBatchView>("orders/reports/import", {
      accountId: account.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-unshipped-pillow.txt", content: txt,
    });
    fixtureIds.batchId = batch.id;
    expect(batch).toMatchObject({ rowCount: 1, newOrderCount: 1, failedOrderCount: 0 });
    const workspace = await api<AmazonReportWorkspaceView>(`orders/reports/workspace?accountId=${account.id}`);
    expect(workspace.lines).toHaveLength(1);
    const line = workspace.lines[0]!;
    fixtureIds.reportLineId = line.id; fixtureIds.orderLineId = line.orderLineId;
    const beforeUpload = AmazonReportDetailViewSchema.parse(await api(`orders/reports/lines/${line.id}`));
    const buyerBytes = syntheticProductionPng(), buyerSha = createHash("sha256").update(buyerBytes).digest("hex");
    const zip = new JSZip();
    zip.file("order.json", JSON.stringify({ orderId: externalId, orderItemId: externalLineId,
      customizationData: { type: "PageContainerCustomization", snapshot: { imageName: "preview.png" }, children: [
        { type: "ImageCustomization", label: "Customer image", image: { imageName: "buyer.png", buyerFilename: "synthetic-buyer.png" } },
        ...[["Size (12/16/18/24 inch)", "14 inch - Cute Home Décor"], ["Pillow Shape", "Only Face"], ["Style", "Single-sided Printing"]]
          .map(([label, name]) => ({ type: "OptionCustomization", label, optionSelection: { name } })),
      ] } }));
    zip.file("preview.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOd8AAAAASUVORK5CYII=", "base64"));
    zip.file("buyer.png", buyerBytes);
    const source = AmazonReportDetailViewSchema.parse(await api(`orders/reports/lines/${line.id}/upload`, {
      expectedVersionId: beforeUpload.versionId, fileName: "synthetic-pillow-original.zip", contentBase64: await zip.generateAsync({ type: "base64" }),
    }));
    expect(source.versionId).not.toBeNull(); expect(source.line.reviewed).toBe(false);
    fixtureIds.sourceVersionId = source.versionId; draftSourceVersion = source.versionId;
    const immutableSource = { versionId: source.versionId, surfaces: source.surfaces, files: source.files };
    const original = source.files.find(file => file.role === "buyer_image");
    expect(original, "Real archive processing must retain an original buyer image").toBeTruthy();
    const originalKey = original!.originalFileKey ?? original!.key;
    const originalPath = `orders/reports/lines/${line.id}/files/${encodeURIComponent(originalKey)}?versionId=${source.versionId}`;
    const originalHash = async () => {
      apiTraffic.push({ method: "GET", path: originalPath });
      const response = await apiFetch(`${process.env.API_BASE_URL}/v1/${originalPath}`);
      expect(response.status).toBe(200);
      return createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex");
    };
    expect(await originalHash()).toBe(buyerSha);
    const detail = OrderWorkDetailViewSchema.parse(await api(`order-centers/lines/${line.orderLineId}`));
    expect(detail.draft).toMatchObject({ specificationVersionId: specification.versionId, artworkVersionId: artwork.versionId, printProfileVersionId: null, dueAt: null });
    expect(detail.catalog?.automatic).toMatchObject({ status: "partial", applied: true, sizeInches: 14, specificationVersionId: specification.versionId, artworkVersionId: artwork.versionId });
    expect(detail.shippingTime?.platform).toMatchObject({ at: expectedDeadline, source: "report_import", verifiedAt: null });
    expect(detail.shippingTime?.platform.sourceVersionId).toBeTruthy();
    const deadlineSource = detail.shippingTime!.platform.sourceVersionId;
    const scope = new URLSearchParams({ accountId: account.id, q: externalId, line: line.orderLineId });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/orders?${scope}`);
    const whole = page.getByRole("region", { name: "整单详情", exact: true });
    const basis = whole.getByRole("region", { name: "本单制作依据匹配", exact: true });
    const platform = whole.getByRole("region", { name: "本单平台发货截止", exact: true });
    const manual = whole.locator("details.oc-basis-manual"), internal = whole.locator("details.oc-optional-internal-plan");
    await expect(basis).toContainText(specification.name); await expect(basis).toContainText(artwork.name);
    await expect(basis).toContainText("通用工艺底稿待审核绑定");
    await expect(basis.getByLabel("制作依据待办", { exact: true })).toContainText("底稿");
    await expect(manual).not.toHaveAttribute("open"); await expect(internal).not.toHaveAttribute("open");
    await expect(internal.locator("summary")).toContainText("可不填"); await expect(internal.locator("input")).toHaveValue("");
    await expect(platform).toContainText("原始未发货报告"); await expect(platform).toContainText("距平台截止");
    await expect(platform.locator("time")).toHaveAttribute("datetime", expectedDeadline);
    await expect(whole.getByRole("button", { name: "确认本件审单", exact: true })).toBeDisabled();
    await expect(whole.locator(".oc-review-body")).toHaveCount(1);
    for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await basis.scrollIntoViewIfNeeded(); await expect(basis).toBeVisible(); await noOverflow(page);
      await expect.poll(() => whole.locator(".oc-review-body").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth + 1))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`pillow-auto-basis-${name}.png`) });
      await platform.scrollIntoViewIfNeeded(); await expect(platform).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`pillow-platform-deadline-${name}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await manual.locator("summary").click();
    const specificationControl = whole.getByRole("combobox", { name: "本单产品规格", exact: true });
    await expect(specificationControl).toHaveValue(specification.versionId);
    await expect(whole.getByRole("combobox", { name: "本单印花版本", exact: true })).toHaveValue(artwork.versionId);
    await specificationControl.selectOption("");
    await whole.getByRole("textbox", { name: "制作说明", exact: true }).fill("Synthetic manual intake override Preserved pending information");
    await expect(basis).toContainText("本单制作依据已调整 保存后生效");
    await expect(whole.getByRole("button", { name: "刷新状态", exact: true })).toBeDisabled();
    await expect(whole.getByRole("button", { name: "刷新整单", exact: true })).toBeDisabled();
    const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/order-centers/lines/${line.orderLineId}/draft` && response.request().method() === "POST");
    await whole.getByRole("button", { name: "保存草稿", exact: true }).click();
    const saved = OrderWorkDetailViewSchema.parse(await (await savedResponse).json());
    expect(saved.draft).toMatchObject({ specificationVersionId: null, artworkVersionId: artwork.versionId, printProfileVersionId: null,
      instructions: "Synthetic manual intake override Preserved pending information", dueAt: null });
    expect(saved.catalog?.automatic?.status).toBe("preserved");
    await expect(whole.getByRole("button", { name: "刷新状态", exact: true })).toBeEnabled();
    const reread = page.waitForResponse(response => new URL(response.url()).pathname === `/api/order-centers/lines/${line.orderLineId}` && response.request().method() === "GET");
    await whole.getByRole("button", { name: "刷新状态", exact: true }).click();
    const refreshed = OrderWorkDetailViewSchema.parse(await (await reread).json());
    expect(refreshed.draft.specificationVersionId).toBeNull();
    await expect(specificationControl).toHaveValue(""); await expect(basis).toContainText("沿用本单固定制作版本");
    const current = OrderWorkDetailViewSchema.parse(await api(`order-centers/lines/${line.orderLineId}`));
    expect(current.line).toMatchObject({ preparation: "pending_review", artwork: "not_pushed", production: "not_released", editorProjectId: null, shippedQuantity: 0 });
    expect(current.shippingTime?.platform).toEqual({ ...detail.shippingTime!.platform, sourceVersionId: deadlineSource });
    const sourceAfter = AmazonReportDetailViewSchema.parse(await api(`orders/reports/lines/${line.id}`));
    expect({ versionId: sourceAfter.versionId, surfaces: sourceAfter.surfaces, files: sourceAfter.files }).toEqual(immutableSource);
    evidence.originalSourcePreserved = true; evidence.reportReviewedAfter = sourceAfter.line.reviewed;
    expect(sourceAfter.line.reviewed).toBe(false); expect(await originalHash()).toBe(buyerSha);
    evidence.originalBytesCheckedBeforeAndAfter = true;
    expect(forbidden).toEqual([]); expect(errors).toEqual([]); expect(draftWrites).toBe(1); expect(summaryReads).toBeGreaterThan(0);
    expect(apiTraffic.filter(item => item.method !== "GET" && /(?:review|render|generation|production|\/actions)/.test(item.path))).toEqual([]);
    evidence.assertionsCompleted = true;
  } finally {
    page.off("request", observe); page.off("pageerror", onError);
    await testInfo.attach("pillow-auto-basis-owned-fixtures", { contentType: "application/json", body: Buffer.from(JSON.stringify({
      syntheticFixtureOnly: true, fixtureIds, reusedCatalog, apiTraffic, forbiddenBrowserWrites: forbidden, draftWrites, summaryReads, evidence,
      cleanupOwner: "disposable acceptance runner database/bucket/Redis finally", noReviewRenderOrModelCallsInFixture: true,
    })) });
  }
});
