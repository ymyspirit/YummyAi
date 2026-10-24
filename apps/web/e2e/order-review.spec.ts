import { expect, test } from "@playwright/test";
import { fixture, id } from "./order-review-fixture";

test("store deep link keeps its selected account after delayed options and a new query", async ({
  page,
}) => {
  const state = await fixture(page);
  let releaseOptions!: () => void;
  const pendingOptions = new Promise<void>((resolve) => {
    releaseOptions = resolve;
  });
  await page.route("**/api/order-centers/options", async (route) => {
    await pendingOptions;
    await route.fulfill({
      json: {
        profiles: [],
        stores: [
          { id: id(99), displayName: "Synthetic source store", platform: "amazon" },
          { id: id(98), displayName: "Synthetic second store", platform: "amazon" },
        ],
        suppliers: [],
        standards: [],
        preferenceScope: "synthetic-store-return",
      },
    });
  });
  await page.goto(`/orders?platform=amazon&accountId=${id(99)}`);
  const store = page.getByLabel("店铺", { exact: true });
  try {
    await expect(store).toBeDisabled();
    await expect(store).toHaveValue(id(99));
    await expect(page.getByRole("button", { name: "查询", exact: true })).toBeDisabled();
  } finally {
    releaseOptions();
  }
  await expect(store).toBeEnabled();
  await expect(store.locator("option:checked")).toHaveText("Synthetic source store");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`accountId=${id(99)}`));
  await store.selectOption(id(98));
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`accountId=${id(98)}`));
  await expect(store.locator("option:checked")).toHaveText("Synthetic second store");
  expect(state.unexpectedWrites).toEqual([]);
});

test("review stays over the same list and protects unsaved changes when switching or closing", async ({
  page,
}) => {
  const state = await fixture(page, 6);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/orders?preparation=pending_review&q=SYNTHETIC");
  const trigger = page.getByRole("button", { name: "SYNTHETIC-REVIEW-3", exact: true });
  await trigger.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  const table = await page.locator(".oc-order-list").elementHandle();
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3" })).toBeVisible();
  await drawer.getByLabel("制作说明", { exact: true }).fill("Unsaved operator instructions");
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Unsaved operator instructions",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await drawer.getByRole("button", { name: "返回订单中心" }).click();
  await expect(drawer).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-4" })).toBeVisible();
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Original instructions 3",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(page.getByLabel("搜索订单", { exact: true })).toHaveValue("SYNTHETIC");
  await expect(page).toHaveURL(/preparation=pending_review&q=SYNTHETIC$/);
  expect(
    await table?.evaluate((element) => element === document.querySelector(".oc-order-list")),
  ).toBe(true);
  expect(Math.abs((await page.evaluate(() => window.scrollY)) - scroll)).toBeLessThan(2);
  expect(state.workspaceReads()).toBe(1);
  expect(state.saves).toEqual([]);
});

test("successful saves keep the order open and manual navigation preserves a stable queue", async ({
  page,
}, testInfo) => {
  const state = await fixture(page);
  await page.goto("/orders?preparation=pending_review&q=SYNTHETIC");
  await page.getByRole("button", { name: "开始处理订单", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await drawer.getByLabel("制作说明", { exact: true }).fill("Confirmed first-order instructions");
  state.failNextSave();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("alert")).toContainText("Synthetic save conflict");
  await expect(drawer.getByLabel("制作说明", { exact: true })).toHaveValue(
    "Confirmed first-order instructions",
  );
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  await expect(drawer.getByText("本页第 2 单 / 共 3 单", { exact: true })).toBeVisible();
  expect(state.saves[0].idempotencyKey).toBe(state.saves[1].idempotencyKey);
  await expect(page.locator(".oc-product-row")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("continuous-review-desktop.png") });
  await drawer.getByRole("button", { name: "记录待补资料", exact: true }).click();
  await expect(drawer.getByRole("status").filter({ hasText: "草稿已保存" })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3" })).toBeVisible();
  await expect(drawer.getByText("本页第 3 单 / 共 3 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "返回订单中心", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByText("没有符合条件的订单。", { exact: true })).toBeVisible();
  expect(state.records.map((record) => record.line.preparation)).toEqual([
    "ready_to_push",
    "needs_information",
    "ready_to_push",
  ]);
  expect(state.saves.map((save) => save.lineId)).toEqual([id(1), id(1), id(2), id(3)]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("saving locks navigation and preserves the existing save-without-advance action", async ({
  page,
}) => {
  const state = await fixture(page);
  await page.goto("/orders");
  await page.getByRole("button", { name: "开始处理订单", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  state.holdSave();
  try {
    await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "下一单", exact: true })).toBeDisabled();
    await expect(drawer.getByRole("button", { name: "返回订单中心" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeVisible();
  } finally {
    state.releaseSave();
  }
  await expect(drawer.getByRole("status").filter({ hasText: "审单已保存" })).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  expect(state.saves).toHaveLength(1);
  expect(state.unexpectedWrites).toEqual([]);
});

test("a direct order link opens a mobile drawer with visible controls and clean boundaries", async ({
  page,
}, testInfo) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/orders?line=${id(2)}`);
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-2" })).toBeVisible();
  await expect(drawer.getByText("本页第 2 单 / 共 3 单", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "下一单", exact: true })).toBeInViewport();
  expect(
    await drawer.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  expect(
    await drawer
      .locator(".oc-review-body")
      .evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("continuous-review-mobile.png") });
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "上一单", exact: true })).toBeDisabled();
  await drawer.getByRole("button", { name: "返回订单中心" }).click();
  await expect(drawer).toHaveCount(0);
  expect(await page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("whole order navigation skips siblings and survives a saved order leaving the filter", async ({ page }) => {
  const state = await fixture(page, 4);
  for (const [sibling, anchor] of [[1, 0], [3, 2]] as const) {
    state.records[sibling]!.line.orderId = state.records[anchor]!.line.orderId;
    state.records[sibling]!.line.externalOrderId = state.records[anchor]!.line.externalOrderId;
    state.records[sibling]!.line.externalLineId = "2";
  }
  await page.goto("/orders?preparation=pending_review");
  await page.getByRole("button", { name: "SYNTHETIC-REVIEW-1", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "整单详情", exact: true });
  const items = drawer.getByRole("region", { name: "本单全部商品与审核稿", exact: true });
  await expect(items.locator("article")).toHaveCount(2);
  await items.getByRole("button", { name: /^商品 2 ·/ }).click();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await items.getByRole("button", { name: /^商品 1 ·/ }).click();
  await drawer.getByRole("button", { name: "确认本件审单", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "推送本件设计", exact: true })).toBeVisible();
  await expect(page.locator(".oc-order-list").getByRole("button", { name: "SYNTHETIC-REVIEW-1", exact: true })).toHaveCount(0);
  await items.getByRole("button", { name: /^商品 2 ·/ }).click();
  await expect(drawer.getByText("本页第 1 单 / 共 2 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "下一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-3", exact: true })).toBeVisible();
  await expect(items.locator("article")).toHaveCount(2);
  await expect(drawer.getByText("本页第 2 单 / 共 2 单", { exact: true })).toBeVisible();
  await drawer.getByRole("button", { name: "上一单", exact: true }).click();
  await expect(drawer.getByRole("heading", { name: "SYNTHETIC-REVIEW-1", exact: true })).toBeVisible();
  expect(state.unexpectedWrites).toEqual([]);
});
