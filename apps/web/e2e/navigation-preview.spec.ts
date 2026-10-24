import { expect, test } from "@playwright/test";

test("module positions stay fixed while browsing and page selection follows browser history", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/navigation-preview");
  const modules = page.getByRole("navigation", { name: "业务模块", exact: true });
  const supply = modules.getByRole("button", { name: "供应链", exact: true });
  const initialBox = await supply.boundingBox();
  const main = page.getByRole("main");
  for (const name of ["创作工具", "研究与经营", "商品与上架", "供应链"]) {
    await modules.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("complementary", { name: "模块页面" }).getByRole("heading")).toHaveText(name);
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("订单工作台");
    expect(await supply.boundingBox()).toEqual(initialBox);
  }
  await modules.getByRole("button", { name: "创作工具", exact: true }).hover();
  await expect(supply).toHaveAttribute("aria-pressed", "true");
  await modules.getByRole("button", { name: "创作工具", exact: true }).click();
  await page.getByRole("navigation", { name: "创作工具页面" }).getByRole("link", { name: "生产文件与底稿", exact: true }).click();
  await expect(page).toHaveURL(/page=production-editor$/);
  await expect(page).toHaveTitle("生产文件与底稿 · 导航预览 · YummyAI");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("生产文件与底稿");
  await page.screenshot({ path: testInfo.outputPath("split-navigation-desktop.png"), fullPage: true });
  await supply.click();
  await page.getByRole("navigation", { name: "供应链页面" }).getByRole("link", { name: "供应商档案", exact: true }).click();
  await expect(page).toHaveURL(/page=suppliers$/);
  await expect(main.getByRole("link", { name: "打开实际页面" })).toHaveAttribute("href", "/suppliers");
  await expect(main.getByRole("link", { name: "打开实际页面" })).toHaveAttribute("target", "_blank");
  await page.goBack();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("生产文件与底稿");
  await expect(modules.getByRole("button", { name: "创作工具", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("供应商档案");
});

test("favorites and collapse survive reload while search reaches pages with the panel closed", async ({ page }) => {
  await page.goto("/navigation-preview");
  const modules = page.getByRole("navigation", { name: "业务模块", exact: true });
  await modules.getByRole("button", { name: "创作工具", exact: true }).click();
  await page.getByRole("button", { name: "收藏生图工作台", exact: true }).click();
  await modules.getByRole("button", { name: "常用", exact: true }).click();
  await page.getByRole("navigation", { name: "常用页面", exact: true }).getByRole("link", { name: "生图工作台", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("生图工作台");
  await page.reload();
  await modules.getByRole("button", { name: "常用", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "常用页面", exact: true }).getByRole("link", { name: "生图工作台", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消收藏生图工作台", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "常用页面", exact: true }).getByRole("link", { name: "生图工作台", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "收起页面栏", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "展开页面栏", exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "模块页面" })).toBeHidden();
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "找功能", exact: true });
  await expect(search.getByRole("textbox")).toBeFocused();
  await search.getByRole("textbox").fill("提示词库");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(/page=studio-prompts$/);
  await expect(page.getByRole("complementary", { name: "模块页面" })).toBeHidden();
  await modules.getByRole("button", { name: "供应链", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "模块页面" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("提示词库");
});

test.describe("touch navigation", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("mobile drawer supports touch, remains in bounds and restores focus", async ({ page }, testInfo) => {
    await page.goto("/navigation-preview");
    await page.getByRole("button", { name: "打开导航", exact: true }).tap();
    const menu = page.getByRole("dialog", { name: "全部导航", exact: true });
    await menu.getByRole("button", { name: "创作工具", exact: true }).tap();
    await expect(menu.getByRole("navigation", { name: "创作工具页面" }).getByRole("link")).toHaveCount(8);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("split-navigation-mobile.png") });
    await menu.getByRole("navigation", { name: "创作工具页面" }).getByRole("link", { name: "生产文件与底稿", exact: true }).tap();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("生产文件与底稿");
    await page.getByRole("button", { name: "打开导航", exact: true }).tap();
    await menu.getByRole("button", { name: "供应链", exact: true }).tap();
    await menu.getByRole("link", { name: "供应商档案", exact: true }).tap();
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("供应商档案");
    await page.getByRole("button", { name: "打开导航", exact: true }).tap();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开导航", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});

test("keyboard navigation and in-memory preferences work without browser storage", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Storage unavailable"); };
    Storage.prototype.setItem = () => { throw new Error("Storage unavailable"); };
  });
  await page.goto("/navigation-preview?page=unknown");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("订单工作台");
  const creative = page.getByRole("navigation", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  await creative.focus();
  await page.keyboard.press("Enter");
  await expect(creative).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "收藏我的画布", exact: true }).click();
  await expect(page.getByRole("button", { name: "取消收藏我的画布", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog", { name: "找功能", exact: true });
  await search.getByRole("textbox").fill("没有这个页面 xyz");
  await expect(search.getByText("没有找到对应页面，换个关键词试试。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});
