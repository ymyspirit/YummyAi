import { syntheticSpecificationFacts } from "../../../tools/testing/specification-fixtures.js";
import { expect, test, type Page } from "@playwright/test";
import { id } from "./order-review-fixture";

async function catalogFixture(page: Page) {
  const spus = Array.from({ length: 30 }, (_, n) => ({
    id: id(900 + n),
    productPlanId: id(950 + n),
    code: `SYNTHETIC-SPU-${n + 1}`,
    name: `Synthetic product ${n + 1}`,
    description: "Synthetic description",
    revision: "a".repeat(64),
  }));
  const artwork = {
    id: id(990),
    versionId: id(991),
    code: "SYNTHETIC-ART",
    name: "Synthetic artwork",
    version: 1,
    mode: "customer_image",
    tags: [],
    researchItemIds: [],
    materials: [],
    customization: { version: 1, fields: [] },
    layout: [],
    instructions: "Synthetic production instructions",
    creativeVersionId: null,
    assetId: null,
  };
  const specification = {
    id: id(992),
    versionId: id(993),
    spuId: spus[0]!.id,
    spuCode: spus[0]!.code,
    spuName: spus[0]!.name,
    code: "SMALL",
    name: "Small",
    version: 1,
    attributes: { Size: "Small" },
    processName: "Synthetic process",
    facts: syntheticSpecificationFacts({
      material: "Synthetic",
      dimensions: "10 cm",
      packageContents: "One synthetic item",
      packageQuantity: 1,
      factsConfirmed: false,
    }),
    canvasPrintSpecVersionId: null,
    processProfileVersionId: null,
    stockItemId: null,
  };
  const options = {
    spus,
    artworks: [artwork],
    specifications: [specification],
    creativeVersions: [],
    researchItems: [],
    processes: [],
    canvasPrintSpecs: [],
    stockItems: [],
    accounts: [],
    materialAssets: [],
    preferenceScope: "synthetic-drawers",
  };
  const state = { reads: 0, writes: 0, reject: false, hold: null as Promise<void> | null, options };
  await page.route("**/api/product-development/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "GET" && path.endsWith("/options")) {
      state.reads++;
      return route.fulfill({ json: options });
    }
    if (
      route.request().method() === "POST" &&
      path === `/api/product-development/spus/${spus[0]!.id}`
    ) {
      state.writes++;
      await state.hold;
      if (state.reject)
        return route.fulfill({
          status: 409,
          json: { message: "Synthetic conflict; please retain this draft" },
        });
      const body = route.request().postDataJSON();
      Object.assign(spus[0]!, {
        code: body.code,
        name: body.name,
        description: body.description,
        revision: "b".repeat(64),
      });
      return route.fulfill({ json: { spu: spus[0] } });
    }
    return route.fulfill({
      status: 409,
      json: { message: `Unexpected synthetic request: ${path}` },
    });
  });
  return state;
}

test("browser traversal fallback also retains an unsaved form", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "navigation", { value: undefined, configurable: true }),
  );
  await catalogFixture(page);
  await page.goto("/product-specifications");
  await page.getByRole("button", { name: "查看产品与规格" }).first().click();
  await page.getByRole("button", { name: "编辑 SPU", exact: true }).click();
  await page.getByLabel("产品名称", { exact: true }).fill("Synthetic fallback draft");
  await expect(page.getByRole("dialog").getByText("有未保存的修改", { exact: true })).toBeVisible();
  const source = page.url();
  const decision = page.waitForEvent("dialog").then((dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await decision;
  await expect(page).toHaveURL(source);
  await expect(page.getByLabel("产品名称", { exact: true })).toHaveValue(
    "Synthetic fallback draft",
  );
  const leave = page.waitForEvent("dialog").then((dialog) => dialog.accept());
  await page.evaluate(() => history.back());
  await leave;
  await expect(page.getByLabel("产品名称", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "编辑 SPU", exact: true }),
  ).toBeVisible();
});

test("SPU drawer keeps the list DOM, scroll, filter and focus; back and forward reopen the record", async ({
  page,
}) => {
  const state = await catalogFixture(page);
  await page.goto("/product-specifications?q=SYNTHETIC");
  const table = page.getByRole("table", { name: "SPU 列表" });
  await expect(table.getByRole("row")).toHaveCount(31);
  const handle = await table.elementHandle();
  const trigger = page.getByRole("button", { name: "查看产品与规格", exact: true }).nth(20);
  await trigger.scrollIntoViewIfNeeded();
  const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const original = page.url();
  const reads = state.reads;
  await trigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(original);
  await page.goForward();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "返回商品 SPU列表", exact: true }).click();
  await expect(trigger).toBeFocused();
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(position);
  expect(state.reads).toBe(reads);
  expect(state.writes).toBe(0);
  await page.getByRole("textbox", { name: "搜索编号或名称" }).fill("SPU-30");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(table.getByRole("row")).toHaveCount(2);
  expect(state.reads).toBe(reads);
});

test("unsaved close, Escape and browser back retain input; busy submission blocks navigation; only success updates the row", async ({
  page,
}, info) => {
  const state = await catalogFixture(page);
  await page.goto("/product-specifications?q=SYNTHETIC");
  const table = page.getByRole("table", { name: "SPU 列表" });
  const handle = await table.elementHandle();
  await page.getByRole("button", { name: "查看产品与规格" }).first().click();
  await page.getByRole("button", { name: "编辑 SPU", exact: true }).click();
  const source = page.url();
  const input = page.getByLabel("产品名称", { exact: true });
  await input.fill("Synthetic updated name");
  await expect(page.getByRole("dialog").getByText("有未保存的修改", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.keyboard.press("Escape");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(source);
  await expect(input).toHaveValue("Synthetic updated name");
  state.reject = true;
  await page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Synthetic conflict");
  await expect(input).toHaveValue("Synthetic updated name");
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  let release!: () => void;
  state.hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.reject = false;
  await page.getByRole("button", { name: "保存 SPU 基础信息", exact: true }).click();
  await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(source);
  release();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "SYNTHETIC-SPU-1 · Synthetic updated name", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByText(/SPU 基础信息已保存/)).toBeVisible();
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  expect(state.writes).toBe(2);
  await page.screenshot({ path: info.outputPath("spu-drawer-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(table.getByText("Synthetic updated name", { exact: true })).toBeVisible();
});

test("artwork details and combinations share one drawer; dynamic changes are guarded and mobile save stays visible", async ({
  page,
}, info) => {
  const state = await catalogFixture(page);
  await page.goto("/print-library?q=SYNTHETIC");
  const table = page.getByRole("table", { name: "印花列表" });
  const handle = await table.elementHandle();
  await page.getByRole("button", { name: "制作说明与素材（0）", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Synthetic production instructions"),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "组合商品", exact: true }).click();
  await expect(page).toHaveURL(/\/print-library\?/);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "选择独立印花", exact: true })).toHaveValue(
    id(991),
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "新版本", exact: true }).click();
  await page.getByRole("button", { name: "添加图片字段", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("有未保存的修改", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByLabel("字段名称", { exact: true })).toHaveValue("定制图片 1");
  await page.setViewportSize({ width: 390, height: 844 });
  const save = page.getByRole("dialog").getByRole("button", { name: "保存新版本", exact: true });
  await expect(save).toBeInViewport();
  await expect(page.getByRole("button", { name: "关闭", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const drawer = page.getByRole("dialog");
  expect(await drawer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("artwork-drawer-mobile.png"), fullPage: true });
  expect(await handle!.evaluate((element) => element.isConnected)).toBe(true);
  expect(state.reads).toBe(1);
  expect(state.writes).toBe(0);
});
