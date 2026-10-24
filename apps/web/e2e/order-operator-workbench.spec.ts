import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./order-review-fixture";

const statuses = ["全部", "处理中", "待审核", "已审核", "已生产", "已出库", "已作废"];
const removedFilters = ["当前环节", "审单状态", "制图状态", "客户确认", "生产状态", "发货状态", "售后状态", "物流面单", "需要关注"];
async function expectUnifiedFilters(page: Page) {
  const status = page.getByRole("combobox", { name: "订单状态", exact: true });
  await expect(status).toBeVisible();
  await expect(status.locator("option")).toHaveText(statuses);
  for (const name of removedFilters) await expect(page.getByRole("combobox", { name, exact: true })).toHaveCount(0);
}

test("whole-order lifecycle stays authoritative under item and status filters across fulfillment centers", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const state = await fixture(page, 8);
  const future = new Date(Date.now() + 72 * 3_600_000).toISOString();
  for (const record of state.records) Object.assign(record.line, { platformShipByAt: future, platformDeadlineVerifiedAt: new Date().toISOString() });
  const first = state.records[0]!.line;
  for (const record of state.records.slice(1, 3)) Object.assign(record.line, { orderId: first.orderId, externalOrderId: first.externalOrderId });
  Object.assign(first, { preparation: "pushed", artwork: "approved" });
  Object.assign(state.records[1]!.line, { preparation: "pushed", artwork: "in_review" });
  Object.assign(state.records[2]!.line, { preparation: "pushed", artwork: "in_progress", designExecutor: "agent" });
  Object.assign(state.records[3]!.line, { preparation: "pushed", artwork: "in_review" });
  Object.assign(state.records[4]!.line, { preparation: "pushed", artwork: "approved" });
  Object.assign(state.records[5]!.line, { preparation: "pushed", artwork: "approved", readyQuantity: 1, labelStatus: "ready" });
  Object.assign(state.records[6]!.line, { preparation: "pushed", artwork: "approved", readyQuantity: 1, shippedQuantity: 1 });
  Object.assign(state.records[7]!.line, { sideState: "cancelled" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/orders");
  await expectUnifiedFilters(page);
  await expect(page.locator("article.oc-product-row")).toHaveCount(8);
  await expect(page.locator(".oc-order-group")).toHaveCount(6);
  const summary = page.locator('[aria-label="整单状态统计"]');
  await expect(summary.locator(":scope > span")).toHaveText(statuses.slice(1).map(label => label + " 1"));
  const group = page.locator(".oc-order-group").filter({ has: page.locator('[data-order-status="processing"]') });
  await expect(group.locator("article.oc-product-row")).toHaveCount(3);
  await expect(group.getByText("整单 3 件", { exact: true })).toBeVisible();
  await expect(group.getByText("等待整单图稿审核", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("order-lifecycle-desktop.png"), fullPage: true });

  await page.getByRole("combobox", { name: "订单状态", exact: true }).selectOption("reviewed");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page).toHaveURL(/orderStatus=reviewed/);
  await expect(page.locator("article.oc-product-row")).toHaveCount(1);
  await expect(page.locator(".oc-order-heading [data-order-status]")).toHaveText("已审核");
  await expect(summary.locator(":scope > span")).toHaveText(statuses.slice(1).map(label => label + " 1"));

  await page.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page.locator("article.oc-product-row")).toHaveCount(8);
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await expectUnifiedFilters(page);
  await page.getByRole("textbox", { name: "商品 SKU", exact: true }).fill(first.skuCode!);
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.locator("article.oc-product-row")).toHaveCount(1);
  await expect(page.locator(".oc-order-heading [data-order-status]")).toHaveText("处理中");
  await expect(page.getByText("整单 3 件", { exact: true })).toBeVisible();

  await page.goto("/orders?stage=in_review");
  await expect(page.getByRole("status").filter({ hasText: "旧版环节筛选" })).toBeVisible();
  await page.getByRole("button", { name: "清除旧版筛选", exact: true }).click();
  await expect(page).not.toHaveURL(/stage=/);
  await expect(page.locator("article.oc-product-row")).toHaveCount(8);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("order-lifecycle-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("link", { name: "查看待发货", exact: true }).click();
  await expect(page).toHaveURL(/shipments\?orderStatus=produced/);
  await expect(page.getByRole("status").filter({ hasText: "旧版环节筛选" })).toHaveCount(0);
  await expect(page.locator("td [data-order-status]")).toHaveText("已生产");
  for (const route of ["/order-artwork", "/production", "/shipments", "/after-sales"]) {
    await page.goto(route);
    await expectUnifiedFilters(page);
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();
    await expectUnifiedFilters(page);
    await expect(page.locator("td [data-order-status]").first()).toBeVisible();
  }
  expect(state.saves).toEqual([]);
  expect(state.unexpectedWrites).toEqual([]);
});

test("whole-order filtering distinguishes empty results from unavailable reads", async ({ page }) => {
  const state = await fixture(page, 1);
  Object.assign(state.records[0]!.line, { preparation: "pushed", artwork: "approved" });
  await page.goto("/orders?orderStatus=voided");
  await expect(page.getByText("没有符合条件的订单。", { exact: true })).toBeVisible();
  await expect(page.locator('[aria-label="整单状态统计"]')).toContainText("已审核 1");
  await page.route("**/api/order-centers/workspace?**", route => route.fulfill({ status: 503, json: { message: "Synthetic temporary outage" } }));
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "订单列表读取失败" })).toBeVisible();
  await expect(page.getByText("订单数量暂不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("没有符合条件的订单。", { exact: true })).toHaveCount(0);
  await expect(page.locator('[aria-label="整单状态统计"] b')).toHaveText(Array(6).fill("—"));
  expect(state.unexpectedWrites).toEqual([]);
});
