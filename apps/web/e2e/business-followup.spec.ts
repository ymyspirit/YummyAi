import { expect, test } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { businessFollowupFixture } from "./business-followup-fixture";
const names = {
  procurement_order: "采购跟进",
  after_sales_case: "售后跟进",
  order_exception: "订单异常",
};
for (const source of ["procurement_order", "after_sales_case", "order_exception"] as const)
  test(`${source} assigns the real object and preserves inbox criteria at desktop and mobile widths`, async ({
    page,
  }, testInfo) => {
    const fixture = await businessFollowupFixture(source),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      const before = await fixture.business();
      await page.goto(
        `/business-tasks?object=${source}&assignment=unassigned&status=open&timeZone=America%2FLos_Angeles`,
      );
      const row = page.locator(`[data-task-id="${fixture.id}"]`);
      await expect(row).toBeVisible();
      await row.getByRole("link", { name: "打开任务", exact: true }).click();
      const panel = page.getByRole("region", { name: names[source] + "责任与时限", exact: true });
      await expect(panel.getByText("未分配", { exact: true })).toBeVisible();
      await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "安排" + names[source], exact: true });
      await dialog.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
      await dialog
        .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
        .fill("2098-06-01T12:00");
      await dialog.getByLabel("调整原因", { exact: true }).selectOption("initial_assignment");
      await dialog.getByRole("button", { name: "保存安排", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect((await fixture.view()).responsibility).toMatchObject({
        revision: 1,
        assignedUserId: fixture.context.userId,
      });
      expect(await fixture.business()).toEqual(before);
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: 950 });
        await expect(panel).toBeVisible();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        if (width !== 1024)
          await page.screenshot({
            path: testInfo.outputPath(`${source}-${width}.png`),
            fullPage: true,
          });
      }
      await page.getByRole("link", { name: "返回业务待办", exact: true }).click();
      await expect(page).toHaveURL(/assignment=unassigned/);
      await expect(page).toHaveURL(/timeZone=America%2FLos_Angeles/);
      await expect(page.locator(`[data-task-id="${fixture.id}"]`)).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
test("a changed procurement source keeps the unsaved draft and current permission loss prevents saving", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await businessFollowupFixture("procurement_order");
  try {
    await page.goto(`/business-tasks?object=procurement_order&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "采购跟进责任与时限", exact: true });
    await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安排采购跟进", exact: true });
    await dialog.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await dialog
      .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
      .fill("2098-06-01T12:00");
    await dialog.getByLabel("调整原因", { exact: true }).selectOption("handoff");
    await fixture.change();
    await dialog.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(
      dialog.getByText("任务已变化 当前填写保留 请核对最新安排", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })).toHaveValue(
      "2098-06-01T12:00",
    );
    await dialog.getByRole("button", { name: "放弃填写并载入最新安排", exact: true }).click();
    await expect(dialog.getByLabel("负责人", { exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })).toHaveValue("");
    await fixture.permissions(
      Object.values(Permission).filter((permission) => permission !== Permission.ProcurementAssign),
    );
    expect((await fixture.view()).responsibility.canManage).toBe(false);
    await page.clock.fastForward(31000);
    await expect(dialog.getByRole("button", { name: "保存安排", exact: true })).toBeDisabled();
    await expect(dialog.getByText("当前没有修改责任安排的权限", { exact: true })).toBeVisible();
    expect((await fixture.view()).responsibility.revision).toBe(0);
  } finally {
    await fixture.close();
  }
});
test("a read-only operator follows the persisted procurement notification without dashboard access", async ({
  page,
}) => {
  const fixture = await businessFollowupFixture("procurement_order");
  try {
    const view = await fixture.view();
    await fixture.api(`business-followups/procurement_order/${fixture.id}/responsibility`, {
      expectedRevision: 0,
      expectedSourceChecksum: view.item.sourceChecksum,
      assignedUserId: fixture.context.userId,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "initial_assignment",
    });
    await fixture.dispatch();
    await fixture.permissions([Permission.ProcurementRead, Permission.NotificationRead]);
    await page.goto(`/business-tasks?object=procurement_order&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "采购跟进责任与时限", exact: true });
    await expect(panel.getByRole("button", { name: "调整责任与时限", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /^通知/ }).click();
    const dialog = page.getByRole("dialog", { name: "通知中心", exact: true });
    const item = dialog
      .getByRole("listitem")
      .filter({
        has: page.locator(
          `a[href="/business-tasks?object=procurement_order&target=${fixture.id}"]`,
        ),
      });
    await expect(item.getByText("业务跟进安排已更新", { exact: true })).toBeVisible();
    await item.getByRole("link", { name: "查看任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`target=${fixture.id}`));
  } finally {
    await fixture.close();
  }
});
test("after-sales opens the exact original case and keeps a return path to the task", async ({
  page,
}) => {
  const fixture = await businessFollowupFixture("after_sales_case");
  try {
    await page.goto(`/business-tasks?object=after_sales_case&target=${fixture.id}`);
    await page.getByRole("link", { name: "打开原业务继续处理", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`case=${fixture.id}`));
    await expect(page.locator(`#case-${fixture.id}`)).toBeVisible();
    await expect(page.locator(`#case-${fixture.id}`)).toHaveAttribute("data-focused", "true");
    await page.getByRole("link", { name: "返回业务任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`object=after_sales_case&target=${fixture.id}`));
  } finally {
    await fixture.close();
  }
});

test("expired exception evidence stops reminders until the operator reviews current evidence and resumes", async ({ page }) => {
  const fixture = await businessFollowupFixture("order_exception");
  try {
    const view = await fixture.view();
    await fixture.api(`business-followups/order_exception/${fixture.id}/responsibility`, { expectedRevision: 0, expectedSourceChecksum: view.item.sourceChecksum, assignedUserId: fixture.context.userId, dueAt: null, escalationUserId: null, escalationDelayMinutes: null, reason: "initial_assignment" });
    await fixture.expire(true); await fixture.dispatch();
    expect((await fixture.view()).responsibility).toMatchObject({ nextCheckAt: null, lastError: "SOURCE_UNAVAILABLE" });
    await fixture.expire(false);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    await page.getByRole("button", { name: "按当前依据重新启用提醒", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已按当前业务依据重新启用提醒" })).toBeVisible();
    expect((await fixture.view()).responsibility).toMatchObject({ revision: 2, canResume: false, lastError: null });
  } finally { await fixture.close(); }
});
