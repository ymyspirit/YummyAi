import { expect, test, type Page } from "@playwright/test";
import { id } from "./order-review-fixture";

async function developmentFixture(page: Page, missingSpecs = false) {
  const artwork = {
    id: id(810),
    versionId: id(811),
    code: "SYNTHETIC-ART",
    name: "Synthetic artwork",
    version: 1,
    mode: "fixed",
    tags: [],
    researchItemIds: [],
    materials: [],
    customization: {},
    instructions: "",
  };
  const specification = {
    id: id(812),
    versionId: id(813),
    spuId: id(814),
    spuCode: "SYNTHETIC-SPU",
    spuName: "Synthetic product",
    code: "SMALL",
    name: "Small",
    version: 1,
    attributes: { Size: "Small" },
    processName: "Synthetic process",
    facts: {
      material: "Synthetic",
      dimensions: "10 cm",
      packageContents: "One synthetic item",
      packageQuantity: 1,
      factsConfirmed: false,
    },
    canvasPrintSpecVersionId: id(815),
  };
  const records = [1, 2].map((n) => {
    const recipe = {
      id: id(820 + n),
      skuId: id(800 + n),
      skuCode: `SYNTHETIC-SKU-${n}`,
      artwork,
      specification,
      version: 1,
      status: "approved",
      editorProjectId: null,
      designVersionId: id(830 + n),
      createdAt: "2026-09-14T00:00:00Z",
    };
    return {
      item: {
        skuId: recipe.skuId,
        skuCode: recipe.skuCode,
        spuId: specification.spuId,
        spuCode: specification.spuCode,
        spuName: specification.spuName,
        attributes: {},
        recipe,
        packageCount: 0,
        updatedAt: recipe.createdAt,
      },
      recipes: [recipe],
      relatedRecipes: [],
      packages: [],
      channelBindings: [],
      listings: [
        {
          id: id(840 + n),
          versionId: id(850 + n),
          title: "Synthetic listing",
          platform: "etsy",
          locale: "en-US",
          status: "draft",
          assetIds: [],
        },
      ],
      events: [],
    };
  });
  await page.route("**/api/product-development/**", (route) => {
    if (route.request().method() !== "GET")
      return route.fulfill({ status: 409, json: { message: "Unexpected synthetic write" } });
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/options"))
      return route.fulfill({
        json: {
          artworks: [artwork],
          specifications: missingSpecs ? [] : [specification],
          spus: [
            { id: specification.spuId, code: specification.spuCode, name: specification.spuName },
          ],
          creativeVersions: [],
          researchItems: [],
          processes: [],
          canvasPrintSpecs: [],
          stockItems: [],
          accounts: [],
          materialAssets: [],
          preferenceScope: "synthetic-navigation",
        },
      });
    if (path.endsWith("/workspace"))
      return route.fulfill({
        json: { items: records.map((record) => record.item), total: 2, page: 1, pageSize: 25 },
      });
    return route.fulfill({ json: records.find((record) => path.endsWith(record.item.skuId)) });
  });
  return records;
}

test("SKU queue guards unsaved forms and keeps the original search", async ({ page }) => {
  await developmentFixture(page);
  let listReads = 0;
  page.on("request", request => { if (/\/api\/product-development\/(options|workspace)(\?|$)/.test(request.url())) listReads++; });
  await page.goto("/product-development?q=SYNTHETIC&status=approved");
  await page.getByRole("button", { name: "连续处理 SKU", exact: true }).click();
  const table = await page.locator('[data-development-list] table').elementHandle();
  const readsOnEntry = listReads;
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-1", exact: true })).toBeVisible();
  await page.getByLabel("审核 / 变更说明", { exact: true }).fill("Unsaved approval explanation");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "下一个 SKU", exact: true }).click();
  await expect(page.getByLabel("审核 / 变更说明", { exact: true })).toHaveValue(
    "Unsaved approval explanation",
  );
  await page.getByLabel("审核 / 变更说明", { exact: true }).fill("");
  await page.getByText("创建渠道 Listing 草稿", { exact: true }).click();
  await page.getByLabel("站点编号", { exact: true }).fill("SYNTHETIC-US");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "下一个 SKU", exact: true }).click();
  await expect(page.getByLabel("站点编号", { exact: true })).toHaveValue("SYNTHETIC-US");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "下一个 SKU", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-2", exact: true })).toBeVisible();
  await expect(page.getByText("本页 2 / 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回产品开发", exact: true }).click();
  await expect(page).toHaveURL(/q=SYNTHETIC&status=approved$/);
  expect(await table!.evaluate(element => element.isConnected)).toBe(true);
  expect(listReads).toBe(readsOnEntry);
});

test("mockup workbench returns to the source SKU and queue", async ({ page }) => {
  await developmentFixture(page);
  await page.goto("/product-development?q=SYNTHETIC&status=approved");
  await page.getByRole("button", { name: "连续处理 SKU", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-1", exact: true })).toBeVisible();
  const source = page.url();
  await page.getByRole("link", { name: "进入套图工作台", exact: true }).click();
  await expect(page.getByRole("heading", { name: "商品套图", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回来源 SKU", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "下一个 SKU", exact: true })).toBeEnabled();
});

test("Listing source link returns to the originating SKU even when the listing is unavailable", async ({
  page,
}) => {
  await developmentFixture(page);
  await page.goto("/product-development?q=SYNTHETIC");
  await page.getByRole("button", { name: "连续处理 SKU", exact: true }).click();
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-1", exact: true })).toBeVisible();
  const source = page.url();
  await page.getByRole("link", { name: "文案 / AI 助手 / 审核", exact: true }).click();
  await page.getByRole("link", { name: "返回来源页面继续处理", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByRole("heading", { name: "SYNTHETIC-SKU-1", exact: true })).toBeVisible();
});

test("registered artwork opens a combination with the exact version selected", async ({ page }) => {
  await developmentFixture(page);
  await page.goto(`/print-library?artwork=${id(810)}`);
  await page.getByRole("dialog").getByRole("button", { name: "组合商品", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "选择独立印花", exact: true })).toHaveValue(
    id(811),
  );
  await expect(page.getByRole("button", { name: "生成 0 个销售 SKU", exact: true })).toBeDisabled();
});

test("prerequisite pages return to the open combination without losing its selection", async ({
  page,
}) => {
  await developmentFixture(page, true);
  await page.goto("/product-development");
  await page.getByRole("button", { name: "组合生成 SKU", exact: true }).click();
  await page.getByRole("combobox", { name: "选择独立印花", exact: true }).selectOption(id(811));
  const source = page.url();
  await page.locator(".pd-combine").getByRole("link", { name: "SPU 与规格", exact: true }).click();
  await page.getByRole("link", { name: "返回原任务", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByRole("combobox", { name: "选择独立印花", exact: true })).toHaveValue(
    id(811),
  );
});

test("specification preparation returns through the editor and keeps batch fields", async ({
  page,
}) => {
  await developmentFixture(page, true);
  await page.goto(`/product-specifications?spu=${id(814)}&form=1`);
  const batch = page.locator(".pd-spec-batch");
  await expect(batch).toBeVisible();
  await batch.getByLabel("尺寸选项", { exact: true }).fill("10 cm, 20 cm");
  await expect(batch.getByLabel("尺寸选项", { exact: true })).toHaveValue("10 cm, 20 cm");
  await batch.getByRole("button", { name: "添加尺寸选项", exact: true }).click();
  await expect(batch.getByRole("button", { name: "移除尺寸 20 cm", exact: true })).toBeVisible();
  await batch.getByRole("button", { name: "预览规格组合", exact: true }).click();
  await batch
    .getByRole("textbox", { name: "共用材质", exact: true })
    .fill("Synthetic retained material");
  const source = page.url();
  const entry = batch.getByRole("link", { name: "工艺底稿库", exact: true });
  await expect(entry).toBeVisible();
  await entry.click();
  await page.getByRole("link", { name: "新建 / 编辑底稿", exact: true }).click();
  await page.getByRole("link", { name: "返回工艺登记 / 原任务", exact: true }).click();
  await page.getByRole("link", { name: "返回原任务", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(batch).toBeVisible();
  await expect(batch.getByRole("textbox", { name: "共用材质", exact: true })).toHaveValue(
    "Synthetic retained material",
  );
  await expect(batch.getByRole("button", { name: "移除尺寸 20 cm", exact: true })).toBeVisible();
});

test("single specification keeps its fields and confirmation when returning from process setup", async ({
  page,
}) => {
  await developmentFixture(page);
  await page.goto(
    `/product-specifications?spu=${id(814)}&form=1&specificationVersionId=${id(813)}`,
  );
  await page
    .getByRole("textbox", { name: "规格名称", exact: true })
    .fill("Synthetic changed specification");
  await page
    .getByRole("textbox", { name: "实际材质", exact: true })
    .fill("Synthetic preserved material");
  await page.getByLabel("属性名称 1", { exact: true }).fill("Shape");
  await page.getByLabel("属性选项 1", { exact: true }).fill("Square");
  await page.getByRole("checkbox", { name: "已核实材质、尺寸和包装内容", exact: true }).check();
  const source = page.url();
  await page.getByRole("link", { name: "登记工艺底稿", exact: true }).click();
  await page.getByRole("link", { name: "返回原任务", exact: true }).click();
  await expect(page).toHaveURL(source);
  await expect(page.getByRole("textbox", { name: "规格名称", exact: true })).toHaveValue(
    "Synthetic changed specification",
  );
  await expect(page.getByRole("textbox", { name: "实际材质", exact: true })).toHaveValue(
    "Synthetic preserved material",
  );
  await expect(page.getByLabel("属性选项 1", { exact: true })).toHaveValue("Square");
  await expect(
    page.getByRole("checkbox", { name: "已核实材质、尺寸和包装内容", exact: true }),
  ).toBeChecked();
});
