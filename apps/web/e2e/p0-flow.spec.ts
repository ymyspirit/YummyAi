import { createHash } from "node:crypto";

import { expect, test } from "@playwright/test";
import {
  ExportManifestSchema,
  createEntityId,
  type TenantContext,
} from "@yummyai/contracts";
import {
  connectDatabase,
  researchItems,
  withTenant,
} from "@yummyai/database";
import JSZip from "jszip";

const PRIMARY_NAVIGATION_LABELS = [
  "运营总览", "研究资料库", "竞争店铺", "画图设计", "POD 作图中心", "设计校样", "批量套图",
  "产品目录", "工作流中心", "刊登控制台", "店铺运营", "订单履约", "库存台账", "采购补货",
  "供应商绩效", "渠道库存", "财务利润", "广告与 VOC", "数据与集成",
] as const;

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

test("research library keeps unified product-type filters through paging and bulk updates", async ({
  page,
}) => {
  test.setTimeout(90_000);
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for the research filter case");
  const database = connectDatabase();
  const suffix = createEntityId().slice(-8);
  const productTypeName = `E2E Unified Mugs ${suffix}`;
  const productTypeKey = productTypeName.toLowerCase();
  const itemIds = Array.from({ length: 27 }, () => createEntityId());
  const context: TenantContext = {
    tenantId: "019f7600-0000-7000-8000-000000000001",
    userId: "019f7600-0000-7000-8000-000000000002",
    permissions: [],
    dataScope: "tenant",
  };

  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await withTenant(database.db, context, (tx) =>
      tx.insert(researchItems).values(
        itemIds.map((id, index) => ({
          id,
          tenantId: context.tenantId,
          platform: index % 2 === 0 ? "amazon" : "etsy",
          marketplace: index % 2 === 0 ? "www.amazon.com" : "www.etsy.com",
          normalizedUrl: `https://example.test/e2e/${suffix}/${index}`,
          latestTitle:
            index === 24
              ? `E2E same type ${suffix} ${"long personalized mug title ".repeat(8)}`
              : index === 26
                ? `E2E other product ${suffix}`
                : `E2E same type ${suffix} ${index}`,
          latestStatus: "complete",
          productTypeName: index === 26 ? `E2E Pillow ${suffix}` : productTypeName,
          productTypeKey:
            index === 26 ? `e2e pillow ${suffix}`.toLowerCase() : productTypeKey,
          classificationStatus: "confirmed",
          classificationSource: "manual",
          classificationUpdatedAt: new Date(),
          firstCapturedAt: new Date(Date.now() + index * 1_000),
          lastCapturedAt: new Date(Date.now() + index * 1_000),
        })),
      ),
    );

    await page.goto("/research");
    await page.getByLabel("搜索标题").fill(`E2E same type ${suffix}`);
    await page
      .locator('select[name="productType"]')
      .selectOption({ label: `${productTypeName} (26)` });
    await page.locator('select[name="classificationStatus"]').selectOption("confirmed");
    await page.getByRole("button", { name: "应用筛选" }).click();
    await expect(page).toHaveURL(/q=E2E(\+|%20)same(\+|%20)type/);
    expect(new URL(page.url()).searchParams.get("productType")).toBe(productTypeKey);
    await expect(page).toHaveURL(/classificationStatus=confirmed/);
    await expect(page.locator(".research-summary-row")).toHaveCount(25);
    await expect(page.getByText(`E2E other product ${suffix}`)).toHaveCount(0);
    await expect(page.locator(".platform-amazon").first()).toBeVisible();
    await expect(page.locator(".platform-etsy").first()).toBeVisible();

    await page.getByLabel("选择当前页全部研究资料").check();
    await expect(page.locator(".research-selection-count")).toContainText("25");
    await page.getByLabel("选择当前页全部研究资料").uncheck();
    await page.getByRole("link", { name: "下一页" }).click();
    expect(new URL(page.url()).searchParams.get("productType")).toBe(productTypeKey);
    await expect(page).toHaveURL(/classificationStatus=confirmed/);
    await expect(page).toHaveURL(/cursor=/);
    await expect(page.locator(".research-summary-row")).toHaveCount(1);
    await page.reload();
    await expect(page.locator('select[name="productType"]')).toHaveValue(productTypeKey);
    await expect(page.locator('select[name="classificationStatus"]')).toHaveValue("confirmed");

    const firstPage = new URL(page.url());
    firstPage.searchParams.delete("cursor");
    await page.goto(firstPage.toString());
    await page.getByLabel(new RegExp(`^选择 E2E same type ${suffix}`)).first().check();
    await page.getByLabel("统一产品类型").fill(`E2E Drinkware ${suffix}`);
    await page.getByRole("button", { name: "批量归类" }).click();
    await expect(page.getByText("已更新 1 条研究资料。")).toBeVisible();

    await page.route("**/v1/research-items/product-type", (route) =>
      route.fulfill({
        body: JSON.stringify({ message: "Synthetic assignment failure" }),
        contentType: "application/json",
        status: 500,
      }),
    );
    await page.getByLabel(new RegExp(`^选择 E2E same type ${suffix}`)).first().check();
    await page.getByLabel("统一产品类型").fill(`E2E Failed Type ${suffix}`);
    await page.getByRole("button", { name: "批量归类" }).click();
    await expect(page.getByText("Synthetic assignment failure")).toBeVisible();
    await page.unroute("**/v1/research-items/product-type");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator(".research-summary-row")).toHaveCount(25);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const tableScrollMetrics = await page
      .locator(".research-table-scroll:visible")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        tableWidth: element.querySelector("table")?.getBoundingClientRect().width ?? 0,
      }));
    expect(tableScrollMetrics.scrollWidth).toBeGreaterThan(tableScrollMetrics.clientWidth);
    expect(
      await page
        .locator(".item-title:visible")
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
  } finally {
    await database.client.begin(async (tx) => {
      await tx.unsafe(
        `delete from audit_events where tenant_id = $1 and entity_id = any($2::uuid[])`,
        [context.tenantId, itemIds],
      );
      await tx.unsafe(
        `delete from research_items where tenant_id = $1 and id = any($2::uuid[])`,
        [context.tenantId, itemIds],
      );
    });
    await database.client.end();
  }
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

  for (const label of PRIMARY_NAVIGATION_LABELS.slice(1)) {
    await expect(navigation.getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
    await navigation.getByRole("link", { name: label }).click();
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(
      PRIMARY_NAVIGATION_LABELS.length,
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

test(
  "Store ledger drills into layered real-data operations without page overflow",
  async ({ page }) => {
    const storeName = `E2E Store ${createEntityId().slice(-8)}`;
    const tenantId = "019f7600-0000-7000-8000-000000000001";
    const database = connectDatabase();
    try {
      await page.goto("/stores");
      await expect(page.getByRole("heading", { name: "店铺运营" })).toBeVisible();
      const createPanel = page.locator("details.store-create-panel");
      if (!(await createPanel.evaluate((element) => (element as HTMLDetailsElement).open))) {
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
      await expect(
        page.getByText("系统不会生成占位订单。", { exact: false }),
      ).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      expect(
        await page
          .locator(".store-detail-nav")
          .evaluate((element) => element.scrollWidth >= element.clientWidth),
      ).toBe(true);
    } finally {
      await database.client.begin(async (tx) => {
        await tx.unsafe(
          `delete from audit_events
            where tenant_id = $1
              and entity_id in (
                select id from marketplace_accounts
                where tenant_id = $1 and display_name = $2
              )`,
          [tenantId, storeName],
        );
        await tx.unsafe(
          `delete from marketplace_accounts where tenant_id = $1 and display_name = $2`,
          [tenantId, storeName],
        );
      });
      await database.client.end();
    }
  },
);

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
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("库存桶汇总").or(page.getByText("还没有库存事实", { exact: true })),
  ).toBeVisible();
});

test("P3 procurement workspace uses the real projection", async ({ page }) => {
  await page.goto("/procurement");
  await expect(page.getByRole("heading", { name: "采购与补货" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("采购运营摘要").or(page.getByText("还没有采购证据", { exact: true })),
  ).toBeVisible();
});

test("P3 supplier performance workspace keeps score gaps explicit", async ({ page }) => {
  await page.goto("/supplier-performance");
  await expect(page.getByRole("heading", { name: "供应商绩效" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
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
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("渠道库存运营摘要").or(page.getByText("还没有渠道库存证据", { exact: true })),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("heading", { name: "渠道库存" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )).toBeLessThanOrEqual(1);
});

test("P3 finance workspace keeps incomplete evidence explicit", async ({ page }) => {
  await page.goto("/finance");
  await expect(page.getByRole("heading", { name: "财务与利润" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
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
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
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
  await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("link")).toHaveCount(PRIMARY_NAVIGATION_LABELS.length);
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
