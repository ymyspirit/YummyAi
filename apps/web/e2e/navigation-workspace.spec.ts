import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { centerApi } from "./order-centers-fixture";
import { FUNCTION_DESTINATIONS, PRIMARY_DESTINATIONS, SIDEBAR_GROUPS } from "../src/features/navigation/navigation-registry";

async function expand(page: Page, label: string) {
  const button = page.locator(".erp-sidebar").getByRole("button", { name: label, exact: true });
  if (await button.getAttribute("aria-expanded") !== "true") await button.click();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("all primary pages share stable destinations and current-page navigation", async ({ page }) => {
  test.setTimeout(420_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/navigation");
  for (const item of PRIMARY_DESTINATIONS) {
    const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(navigation.getByRole("link", { includeHidden: true })).toHaveCount(PRIMARY_DESTINATIONS.length);
    if (item.groupId !== "overview") await expand(page, item.groupLabel);
    await navigation.getByRole("link", { name: item.label, exact: true }).click();
    await expect(page).toHaveURL((url) => url.pathname === item.href, { timeout: 30_000 });
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(item.label);
    await expect(page.getByRole("navigation", { name: "当前位置" }).getByRole("listitem")).toHaveText(
      item.href === "/" ? ["运营总览"] : ["运营总览", ...(item.groupId === "overview" ? [] : [item.groupLabel]), item.label],
    );
    await expect(page.locator(".erp-sidebar")).toHaveCount(1);
    await expect(navigation.getByRole("link", { name: "刊登管理", exact: true, includeHidden: true })).toHaveAttribute("href", "/listings");
  }
  expect(errors).toEqual([]);
});

test("SPU breadcrumbs show the record, return to the filtered list and open its business module", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const code = `QA-CRUMB-${randomUUID().slice(0, 8)}`;
  const name = `定制毛毯 · 多尺寸多形状 ${"PersonalizedBlanket".repeat(5)}`;
  const { spu } = await centerApi<{ spu: { id: string } }>("product-development/spus", {
    code, name, idempotencyKey: randomUUID(),
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const listPath = `/product-specifications?q=${code}&page=1`;
  await page.goto(listPath);
  const breadcrumbs = page.getByRole("navigation", { name: "当前位置" });
  await expect(breadcrumbs.getByRole("listitem")).toHaveText(["运营总览", "商品与上架", "商品库"]);
  await page.getByRole("row").filter({ hasText: code }).getByRole("button", { name: "查看产品与规格" }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("spu") === spu.id);
  await expect(breadcrumbs.getByRole("listitem")).toHaveText(["运营总览", "商品与上架", "商品库", `${code} · ${name}`]);
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page).toHaveTitle(`${code} · ${name} · YummyAI`);
  await expect(breadcrumbs.getByRole("link", { name: "商品库", exact: true })).toHaveAttribute("href", listPath);
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("breadcrumbs-spu-desktop.png") });
  await page.reload();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(`${code} · ${name}`);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(breadcrumbs.getByRole("link", { name: "商品库", exact: true })).toBeVisible();
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("breadcrumbs-spu-mobile.png") });
  await page.getByRole("button", { name: "返回商品库列表", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname + url.search === listPath);
  await expect(page.getByRole("button", { name: "查看产品与规格" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "搜索编号或名称" })).toHaveValue(code);
  await expect(breadcrumbs.getByRole("listitem")).toHaveCount(3);
  await page.getByRole("row").filter({ hasText: code }).getByRole("button", { name: "查看产品与规格" }).click();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(`${code} · ${name}`);
  await expect(page.getByRole("heading", { name: `${code} · ${name}`, exact: true })).toBeVisible();
  await page.goBack();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText("商品库");
  await page.goForward();
  await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText(`${code} · ${name}`);
  await page.getByRole("button", { name: "返回商品库列表", exact: true }).click();
  await breadcrumbs.getByRole("link", { name: "商品与上架", exact: true }).click();
  await expect(page).toHaveURL(/\/navigation\?group=catalog$/);
  await expect(page.getByRole("group", { name: "业务分类" }).getByRole("button", { name: "商品与上架", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.filter((item) => item.groupId === "catalog").length);
  expect(errors).toEqual([]);
});

test("search supports keyboard selection, empty states and focus restoration", async ({ page }) => {
  await page.goto("/navigation");
  const trigger = page.getByRole("button", { name: "找功能", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "找功能", exact: true });
  const input = dialog.getByRole("textbox", { name: "搜索页面或功能" });
  await expect(input).toBeFocused();
  await input.fill("没有这个功能xyz");
  await expect(dialog.getByText("没有找到对应功能")).toBeVisible();
  await dialog.getByRole("button", { name: "清空搜索" }).click();
  await dialog.getByRole("link", { name: "浏览全部功能" }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "关闭功能搜索" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await input.fill("ZIP");
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("link", { name: /导入与定制/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/orders\?view=reports$/);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "订单报告导入", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("导入与定制");
});

test("directory categories and search expose every function", async ({ page }, testInfo) => {
  await page.goto("/navigation");
  const categories = page.getByRole("group", { name: "业务分类" });
  for (const group of SIDEBAR_GROUPS.filter((item) => item.id !== "overview")) {
    await categories.getByRole("button", { name: group.label, exact: true }).click();
    await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.filter((item) => item.groupId === group.id).length);
  }
  await categories.getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(FUNCTION_DESTINATIONS.length);
  await page.getByRole("textbox", { name: "筛选全部功能" }).fill("猫咪");
  await expect(page.locator(".erp-directory-groups").getByRole("link")).toHaveCount(1);
  await page.locator(".erp-directory-groups").getByRole("link").click();
  await expect(page).toHaveURL(/kind=shaped_pillow/);
  await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText("异形抱枕生产图");
  await page.goto("/navigation?group=catalog");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await noOverflow(page);
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("directory-desktop.png"), fullPage: true });
});

test("single sidebar follows the business sequence and supports keyboard collapse", async ({ page }) => {
  await page.goto("/ai-tasks");
  const sidebar = page.locator(".erp-sidebar");
  await expect(sidebar).toHaveCSS("width", "244px");
  await expect(sidebar.locator(".erp-navigation-group > button > span")).toHaveText(SIDEBAR_GROUPS.filter(group => group.id !== "overview").map(group => group.label));
  await expand(page, "商品与上架");
  await expect(sidebar.locator("#rail-items-catalog").getByRole("link")).toHaveText(["商品库", "印花库", "销售 SKU 组合", "商品套图", "上架工作台", "刊登管理"]);
  const commerce = sidebar.getByRole("button", { name: "订单与履约", exact: true });
  await commerce.focus();
  await page.keyboard.press("Enter");
  await expect(commerce).toHaveAttribute("aria-expanded", "true");
  await expect(sidebar.getByRole("link", { name: "商品库", exact: true })).toBeHidden();
  await sidebar.getByRole("link", { name: "物流下单", exact: true }).click();
  await expect(page).toHaveURL(/\/logistics$/);
  await expect(sidebar.locator('[aria-current="page"]')).toHaveText("物流下单");
  await commerce.focus();
  await page.keyboard.press("Enter");
  await expect(commerce).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("link", { name: "物流下单", exact: true })).toBeHidden();
});

test("task workspaces have direct routes, compatible links and responsive layouts", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/ai-tasks?tools=1");
  await expect(page.getByRole("heading", { name: "AI 任务工作台", exact: true })).toBeVisible();
  await expect(page.getByLabel("要完成的任务")).toBeVisible();
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "读取本次依据", exact: true })).toBeDisabled();
  await noOverflow(page);
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("ai-tasks-desktop.png"), fullPage: true });
  await page.getByRole("navigation", { name: "任务工作台" }).getByRole("link", { name: "业务任务", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/business-tasks");
  await expect(page.getByRole("heading", { name: "工作流待办", exact: true })).toBeVisible();
  await expect(page.getByLabel("业务对象", { exact: true })).toHaveValue("workflow");
  await expect(page.locator(".erp-sidebar").locator('[aria-current="page"]')).toHaveText("业务任务");
  await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("business-tasks-desktop.png"), fullPage: true });
  await page.goto("/ai-tasks?business=1&object=sales_plan&target=invalid-target");
  await expect(page).toHaveURL(/\/business-tasks\?object=sales_plan&target=invalid-target$/);
  await expect(page.getByRole("alert")).toContainText("业务对象编号无效");
  for (const path of ["/ai-tasks", "/business-tasks"]) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path === "/ai-tasks" ? "/ai-tasks?tools=1" : path);
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeEnabled();
    if (path === "/ai-tasks") {
      await expect(page.getByRole("button", { name: "展开任务历史", exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "任务类型", exact: true })).toBeHidden();
      await page.getByRole("button", { name: "展开任务历史", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "任务类型", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "收起任务历史", exact: true }).click();
    }
    await noOverflow(page);
    await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath(`${path.slice(1)}-mobile.png`), fullPage: true });
  }
});

test("mobile drawer navigates, restores focus and preserves desktop compact mode", async ({ page }, testInfo) => {
  await page.goto("/ai-tasks");
  await page.getByRole("button", { name: "收起页面栏", exact: true }).click();
  await expect(page.locator(".erp-sidebar")).toHaveCSS("width", "68px");
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", { name: "打开全部导航" });
  await trigger.click();
  const menu = page.getByRole("dialog", { name: "全部导航", exact: true });
  await expect(menu.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { includeHidden: true })).toHaveCount(PRIMARY_DESTINATIONS.length);
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("sidebar-mobile.png") });
  await menu.getByRole("button", { name: "订单与履约", exact: true }).click();
  await menu.getByRole("link", { name: "物流下单", exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/logistics$/);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await noOverflow(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.locator(".erp-sidebar")).toHaveCSS("width", "68px");
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("sidebar-compact.png") });
  await page.locator(".erp-sidebar").getByRole("button", { name: "订单与履约", exact: true }).click();
  await expect(page.locator(".erp-sidebar")).toHaveCSS("width", "244px");
  await expect(page.locator(".erp-sidebar").getByRole("link", { name: "物流下单", exact: true })).toBeVisible();
});

test("favorites validate saved IDs, persist edits and open real pages", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("nav-fixture-initialized")) {
      localStorage.setItem("yummyai.ui.favorite-pages", JSON.stringify(["suppliers", "unknown-page", "suppliers", 3]));
      localStorage.setItem("nav-fixture-initialized", "true");
    }
  });
  await page.goto("/navigation");
  const sidebar = page.locator(".erp-sidebar");
  await sidebar.getByRole("button", { name: "常用页面", exact: true }).click();
  const favorites = sidebar.getByRole("navigation", { name: "常用页面", exact: true });
  await expect(favorites.getByRole("link")).toHaveCount(1);
  await favorites.getByRole("link").hover();
  await favorites.getByRole("button", { name: "取消收藏供应商档案", exact: true }).click();
  await expect(favorites.getByText("点击页面旁的星标，收藏常用入口")).toBeVisible();
  await expand(page, "系统配置");
  const stores = sidebar.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "店铺运营", exact: true });
  await stores.hover();
  await sidebar.getByRole("button", { name: "收藏店铺运营", exact: true }).click();
  await favorites.getByRole("link", { name: "店铺运营", exact: true }).click();
  await expect(page).toHaveURL(/\/stores$/);
  await page.reload();
  await sidebar.getByRole("button", { name: "常用页面", exact: true }).click();
  await expect(favorites.getByRole("link")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("yummyai.ui.favorite-pages")!))).toEqual(["stores"]);
});

test("theme choices persist while the default stays light", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/ai-tasks");
  const theme = page.getByRole("group", { name: "界面主题", exact: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ caret: "initial", animations: "disabled", path: testInfo.outputPath("ai-tasks-dark.png"), fullPage: true });
  await theme.getByRole("button", { name: "跟随系统", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(page);
  }
});

test("navigation and theme remain usable when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, "localStorage", { get: () => { throw new DOMException("Disabled", "SecurityError"); } }); });
  await page.setViewportSize({ width: 375, height: 844 });
  await page.goto("/business-tasks");
  await page.getByRole("group", { name: "界面主题" }).getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "打开全部导航" }).click();
  const menu = page.getByRole("dialog", { name: "全部导航", exact: true });
  await menu.getByRole("button", { name: "系统配置", exact: true }).click();
  await menu.getByRole("button", { name: "收藏店铺运营", exact: true }).click();
  await menu.getByRole("button", { name: "常用页面", exact: true }).click();
  await expect(menu.getByRole("navigation", { name: "常用页面", exact: true }).getByRole("link", { name: "店铺运营", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await noOverflow(page);
});
