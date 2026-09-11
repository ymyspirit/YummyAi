import { expect, test } from "@playwright/test";

import { FUNCTION_DESTINATIONS, NAVIGATION_GROUPS, PRIMARY_DESTINATIONS, QUICK_DESTINATION_IDS } from "../src/features/navigation/navigation-registry";

test("all primary pages share stable destinations and current-page navigation", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/navigation");
  for (const item of PRIMARY_DESTINATIONS) {
    const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(navigation.getByRole("link", { includeHidden: true })).toHaveCount(PRIMARY_DESTINATIONS.length);
    if (item.groupId !== "overview") {
      const toggle = navigation.getByRole("button", { name: item.groupLabel, exact: true });
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
    }
    await navigation.getByRole("link", { name: item.label, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === item.href);
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(item.label);
    await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText(item.label);
    await expect(page.locator(".erp-sidebar")).toHaveCount(1);
    await expect(navigation.getByRole("link", { name: "刊登控制台", exact: true, includeHidden: true })).toHaveAttribute("href", "/listings");
  }
  expect(errors).toEqual([]);
});

test("opening an import link before the shared breadcrumb hydrates stays consistent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/orders/import");
  await expect(page).toHaveURL(/\/orders\?view=reports$/);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/orders", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "导入亚马逊报告", exact: true }).click();
    await expect(page.getByRole("heading", { name: "订单工作台", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("导入与定制");
  }
  expect(errors).toEqual([]);
});

test("search finds ZIP imports and supports keyboard selection and return paths", async ({ page }) => {
  await page.goto("/navigation");
  await expect(page).toHaveTitle("全部功能 · YummyAI");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "找功能", exact: true });
  const input = dialog.getByRole("textbox", { name: "搜索页面或功能" });
  await expect(input).toBeFocused();
  await input.fill("ZIP");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("link", { name: /导入与定制/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/orders\?view=reports$/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "订单工作台", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "当前位置" }).getByRole("link", { name: "订单工作台" }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole("heading", { name: "订单工作台", level: 1 })).toBeVisible();
});

test("directory exposes every function and narrows production products by task name", async ({ page }) => {
  await page.goto("/navigation");
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.filter((item) => item.groupId === "commerce").length);
  await page.getByRole("group", { name: "业务分类" }).getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.length);
  await expect(page.getByRole("region", { name: "常用任务" }).getByRole("link")).toHaveCount(QUICK_DESTINATION_IDS.length);
  const filter = page.getByRole("textbox", { name: "筛选全部功能" });
  await filter.fill("猫咪");
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(1);
  await page.locator(".erp-directory-groups").getByRole("link", { name: /异形抱枕生产图/ }).click();
  await expect(page).toHaveURL(/kind=shaped_pillow/);
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("异形抱枕生产图");
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "找功能", exact: true });
  await dialog.getByRole("textbox").fill("轮胎罩");
  await dialog.getByRole("link", { name: /定制备胎罩生产图/ }).click();
  await expect(page).toHaveURL(/kind=tire_cover/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("定制备胎罩生产图");
});

test("search empty states, Escape and Tab keep keyboard focus usable", async ({ page }) => {
  await page.goto("/navigation");
  const trigger = page.getByRole("button", { name: "找功能 Ctrl K", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "找功能", exact: true });
  await dialog.getByRole("textbox").fill("没有这个功能xyz");
  await expect(dialog.getByText("没有找到对应功能")).toBeVisible();
  await dialog.getByRole("button", { name: "清空搜索" }).click();
  await expect(dialog.getByText("常用任务", { exact: true })).toBeVisible();
  const footerLink = dialog.getByRole("link", { name: "浏览全部功能" });
  await footerLink.focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭功能搜索" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.getByRole("textbox", { name: "筛选全部功能" }).fill("没有这个功能xyz");
  await expect(page.getByRole("heading", { name: "没有找到对应功能" })).toBeVisible();
  await page.getByRole("button", { name: "查看全部功能" }).click();
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.length);
});

test("POD module URLs and browser history retain useful breadcrumbs", async ({ page }) => {
  await page.goto("/pod-workbench?module=personalization");
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("来图定制");
  await page.getByRole("navigation", { name: "作图中心模块" }).getByRole("link", { name: /图案处理/ }).click();
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("图案处理");
  await page.goBack();
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("来图定制");
  await expect(page.getByRole("navigation", { name: "主导航", exact: true }).locator('[aria-current="page"]')).toHaveText("创意工作台");
});

test("mobile menu shows all groups, navigates and closes without horizontal overflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/navigation");
  await expect(page.locator(".erp-sidebar")).toBeHidden();
  await page.getByRole("button", { name: "打开全部导航" }).click();
  const menu = page.getByRole("dialog", { name: "全部导航", exact: true });
  await expect(menu.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { includeHidden: true })).toHaveCount(PRIMARY_DESTINATIONS.length);
  await expect(menu.getByRole("navigation", { name: "主导航", exact: true }).getByRole("button")).toHaveCount(NAVIGATION_GROUPS.length - 1);
  await page.screenshot({ path: testInfo.outputPath("navigation-mobile-menu.png") });
  await menu.getByRole("link", { name: "导入订单报告", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "订单工作台", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "打开全部导航" }).click();
  await menu.getByRole("button", { name: "创意设计", exact: true }).click();
  await menu.getByRole("link", { name: "生产文件与底稿", exact: true }).click();
  await expect(page.getByRole("heading", { name: "生产文件与底稿", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "打开全部导航" }).click();
  await menu.getByRole("link", { name: "全部功能", exact: true }).click();
  await expect(page).toHaveURL(/\/navigation$/);
  await expect(page.getByRole("heading", { name: "全部功能", level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("navigation-mobile-directory.png") });
  await page.getByRole("button", { name: "找功能", exact: true }).click();
  await page.getByRole("dialog", { name: "找功能", exact: true }).getByRole("textbox").fill("备胎罩");
  await page.screenshot({ path: testInfo.outputPath("navigation-mobile-search.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "找功能", exact: true })).toBeFocused();
});

test("desktop directory and search preserve the dense ERP layout", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/navigation");
  await expect(page).toHaveTitle("全部功能 · YummyAI");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("navigation-desktop.png") });
  await page.keyboard.press("Control+k");
  await page.getByRole("dialog", { name: "找功能", exact: true }).getByRole("textbox").fill("生产图");
  await page.screenshot({ path: testInfo.outputPath("navigation-desktop-search.png") });
});

test("detail pages keep their module return link even when the record is unavailable", async ({ page }) => {
  const id = "00000000-0000-7000-8000-000000000001";
  for (const [path, label, parent, href] of [
    [`/stores/${id}`, "店铺详情", "店铺运营", "/stores"],
    [`/listings/${id}`, "刊登编辑", "刊登控制台", "/listings"],
    [`/workflows/templates/${id}/edit`, "编辑流程模板", "工作流中心", "/workflows"],
    [`/workflows/runs/${id}`, "工作流执行", "工作流中心", "/workflows"],
    [`/analysis/${id}`, "分析报告", "研究资料库", "/research"],
  ]) {
    await page.goto(path!);
    const breadcrumbs = page.getByRole("navigation", { name: "当前位置" });
    await expect(breadcrumbs).toContainText(label!);
    await expect(breadcrumbs.getByRole("link", { name: parent, exact: true })).toHaveAttribute("href", href!);
    await expect(page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: parent, exact: true })).toHaveAttribute("href", href!);
  }
});

test("business modules disclose one group at a time and work without a mouse", async ({ page }) => {
  await page.goto("/navigation");
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(nav.getByRole("button")).toHaveCount(NAVIGATION_GROUPS.length - 1);
  await expect(nav.getByRole("link")).toHaveCount(3);
  await expect(nav.locator('button[aria-expanded="true"]')).toHaveCount(1);
  const creative = nav.getByRole("button", { name: "创意设计", exact: true });
  await creative.focus();
  await page.keyboard.press("Enter");
  await expect(creative).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "订单工作台", exact: true })).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(nav.getByRole("link", { name: "创意工作台", exact: true })).toBeFocused();
  await nav.getByRole("link", { name: "生产文件与底稿", exact: true }).click();
  await expect(creative).toHaveAttribute("data-active", "true");
  await expect(nav.locator('[aria-current="page"]')).toHaveText("生产文件与底稿");
  await page.getByRole("navigation", { name: "常用任务快捷入口" }).getByRole("link", { name: "导入订单报告", exact: true }).click();
  await expect(nav.getByRole("button", { name: "订单与履约", exact: true })).toHaveAttribute("aria-expanded", "true");
  await expect(creative).toHaveAttribute("aria-expanded", "false");
  await expect(nav.locator('[aria-current="page"]')).toHaveText("订单工作台");
});

test("category browsing reduces choices while search still reaches every module", async ({ page }) => {
  await page.goto("/navigation");
  const categories = page.getByRole("group", { name: "业务分类" });
  for (const group of NAVIGATION_GROUPS.filter((item) => item.id !== "overview")) {
    await categories.getByRole("button", { name: group.label, exact: true }).click();
    await expect(categories.getByRole("button", { name: group.label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.filter((item) => item.groupId === group.id).length);
  }
  await page.getByRole("textbox", { name: "筛选全部功能" }).fill("猫咪");
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(1);
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toContainText("异形抱枕生产图");
  await expect(page.getByRole("status")).toContainText("搜索全部分类");
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`reduced-motion ${colorScheme} navigation fits small screens`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/navigation");
      await expect(page).toHaveTitle("全部功能 · YummyAI");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const card = page.locator(".rb-spotlight").first();
      await card.hover();
      expect(await card.evaluate((el) => getComputedStyle(el, "::before").backgroundImage)).toBe("none");
      if (width === 375) {
        await page.screenshot({ path: testInfo.outputPath(`directory-${colorScheme}-375.png`), fullPage: true });
        await page.getByRole("button", { name: "打开全部导航" }).click();
        const menu = page.getByRole("dialog", { name: "全部导航", exact: true });
        for (const control of await menu.locator("button:visible, a:visible").all()) {
          const box = await control.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
        await menu.getByRole("button", { name: "创意设计", exact: true }).click();
        await page.screenshot({ path: testInfo.outputPath(`menu-${colorScheme}-375.png`) });
        await menu.getByRole("button", { name: "关闭导航" }).click();
      }
    }
  });
}

test("React Bits task spotlight gives pointer feedback without blocking navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/navigation");
  const card = page.locator(".rb-spotlight").first();
  await card.hover();
  await expect.poll(() => card.evaluate((el) => el.getAttribute("style"))).toContain("--mouse-x:");
  await card.getByRole("link").click();
  await expect(page).toHaveURL(/\/orders\?view=reports$/);
  await expect(page.getByRole("heading", { name: "订单工作台", level: 1 })).toBeVisible();
});

test("appearance stays consistent across navigation, reloads, and system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const theme = page.getByRole("group", { name: "界面主题", exact: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".ops-metric").first()).toHaveCSS("background-color", "rgb(27, 27, 31)");
  await theme.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".ops-metric").first()).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "收起侧边栏", exact: true }).click();
  await expect(page.locator(".erp-sidebar")).toHaveCSS("width", "76px");
  await page.locator(".erp-sidebar").getByRole("button", { name: "创意设计", exact: true }).click();
  await page.locator(".erp-sidebar").getByRole("link", { name: "创意工作台", exact: true }).click();
  await expect(page).toHaveURL(/\/creative-designs\/canvas$/);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(theme.getByRole("button", { name: "浅色", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".erp-sidebar")).toHaveCSS("width", "76px");
  await page.getByRole("button", { name: "展开侧边栏", exact: true }).click();
  await theme.getByRole("button", { name: "跟随系统", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "打开全部导航" })).toBeVisible();
  for (const control of await theme.getByRole("button").all()) {
    const box = await control.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("appearance controls work without browser storage and workflow tabs fit mobile", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Disabled", "SecurityError"); } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/workflows");
  await page.getByRole("group", { name: "界面主题", exact: true }).getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const tab of await page.getByRole("navigation", { name: "工作流分类" }).getByRole("button").all()) await expect(tab).toBeInViewport();
  expect(errors).toEqual([]);
});
