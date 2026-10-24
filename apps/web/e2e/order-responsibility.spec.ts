import { expect, test } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { orderResponsibilityFixture } from "./order-responsibility-fixture";
test("order follow-up saves real responsibility without changing business versions and remains usable at three widths", async ({
  page,
}, testInfo) => {
  const fixture = await orderResponsibilityFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const before = await fixture.view();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/business-tasks?object=order&target=${fixture.lineId}`);
    await page.getByText("本件履约跟进安排", { exact: true }).click();
    const panel = page.getByRole("region", { name: "本件责任与时限", exact: true });
    await expect(panel.getByText("未分配", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安排本件履约跟进", exact: true });
    await dialog.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await dialog
      .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
      .fill("2099-01-01T12:00");
    await dialog.getByLabel("调整原因", { exact: true }).selectOption("initial_assignment");
    await dialog.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(panel.getByText("Synthetic operator", { exact: true })).toBeVisible();
    const saved = await fixture.view();
    expect(saved.businessRevision).toBe(before.businessRevision);
    expect(saved.businessProjectionVersion).toBe(before.businessProjectionVersion);
    expect(saved.assignedUserId).toBe(fixture.context.userId);
    await page.screenshot({
      path: testInfo.outputPath("order-responsibility-desktop.png"),
      fullPage: true,
    });
    await page.reload();
    await page.getByText("本件履约跟进安排", { exact: true }).click();
    await expect(panel.getByText("Synthetic operator", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("order-responsibility-tablet-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    await expect(dialog.getByLabel("负责人", { exact: true })).toHaveValue(fixture.context.userId);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("order-responsibility-phone.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
test("order responsibility preserves conflict edits and refuses current assignment permission loss", async ({
  page,
}) => {
  const fixture = await orderResponsibilityFixture();
  try {
    await page.clock.install();
    await page.goto(`/business-tasks?object=order&target=${fixture.lineId}`);
    await page.getByText("本件履约跟进安排", { exact: true }).click();
    const panel = page.getByRole("region", { name: "本件责任与时限", exact: true });
    await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安排本件履约跟进", exact: true });
    await dialog.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await dialog
      .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
      .fill("2098-06-01T12:00");
    await dialog.getByLabel("调整原因", { exact: true }).selectOption("handoff");
    await fixture.exception();
    await dialog.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(
      dialog.getByText("任务已变化 当前填写保留 请核对最新安排", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })).toHaveValue(
      "2098-06-01T12:00",
    );
    await dialog.getByRole("button", { name: "放弃填写并载入最新安排", exact: true }).click();
    await expect(dialog.getByLabel("负责人", { exact: true })).toHaveValue("");
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.OrderAssign),
    );
    await page.clock.fastForward(31000);
    await expect(dialog.getByRole("button", { name: "保存安排", exact: true })).toBeDisabled();
    await expect(dialog.getByText("当前没有修改责任安排的权限", { exact: true })).toBeVisible();
    expect((await fixture.view()).revision).toBe(0);
  } finally {
    await fixture.close();
  }
});
test("read-only order operators can follow an authorized persisted notification without dashboard access", async ({
  page,
}) => {
  const fixture = await orderResponsibilityFixture();
  try {
    const view = await fixture.view();
    await fixture.api(`order-centers/lines/${fixture.lineId}/responsibility`, {
      expectedRevision: view.revision,
      expectedSourceChecksum: view.sourceChecksum,
      assignedUserId: fixture.context.userId,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "initial_assignment",
    });
    await fixture.dispatch();
    await fixture.permissions([
      Permission.OrderRead,
      Permission.OrderPiiRead,
      Permission.NotificationRead,
    ]);
    await page.goto(`/business-tasks?object=order&target=${fixture.lineId}`);
    await page.getByText("本件履约跟进安排", { exact: true }).click();
    const panel = page.getByRole("region", { name: "本件责任与时限", exact: true });
    await expect(panel.getByText("Synthetic operator", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "调整责任与时限", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /^通知/ }).click();
    const inbox = page.getByRole("dialog", { name: "通知中心", exact: true });
    const item = inbox.getByRole("listitem").filter({
      has: page.locator(`a[href="/business-tasks?object=order&target=${fixture.lineId}"]`),
    });
    await expect(item.getByText("订单跟进安排已更新", { exact: true })).toBeVisible();
    await item.getByRole("link", { name: "查看任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`target=${fixture.lineId}`));
  } finally {
    await fixture.close();
  }
});

test("order inbox preserves filters and page after a real assignment and follows actual archival at three widths", async ({
  page,
}, testInfo) => {
  const prefix = "Order inbox " + crypto.randomUUID().slice(0, 8),
    fixtures: Awaited<ReturnType<typeof orderResponsibilityFixture>>[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    for (let index = 0; index < 3; index++) fixtures.push(await orderResponsibilityFixture(prefix));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(
      `/business-tasks?${new URLSearchParams({ object: "order", assignment: "visible", q: prefix, pageSize: "1", page: "2", timeZone: "UTC" })}`,
    );
    const inbox = page.getByRole("region", { name: "订单履约任务收件箱", exact: true });
    await expect(inbox.getByText("筛选结果 3 项", { exact: true })).toBeVisible();
    await expect(inbox.getByText("未分配 3", { exact: true })).toBeVisible();
    await expect(inbox.locator("tbody tr")).toHaveCount(1);
    const selected = await inbox.locator("tbody tr").getAttribute("data-task-id"),
      fixture = fixtures.find((value) => value.lineId === selected)!;
    expect(fixture).toBeDefined();
    await page.screenshot({ path: testInfo.outputPath("order-inbox-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("order-inbox-tablet-dark.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("order-inbox-phone.png"), fullPage: true });
    await inbox.getByRole("link", { name: "打开任务", exact: true }).click();
    await page.getByText("本件履约跟进安排", { exact: true }).click();
    const panel = page.getByRole("region", { name: "本件责任与时限", exact: true });
    await panel.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "安排本件履约跟进", exact: true });
    await dialog.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await dialog
      .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
      .fill("2000-01-01T12:00");
    await dialog.getByLabel("调整原因", { exact: true }).selectOption("initial_assignment");
    await dialog.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const back = page.getByRole("link", { name: "返回订单待办", exact: true });
    await expect(back).toHaveAttribute("aria-disabled", "false");
    await back.click();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("page") === "2" && url.searchParams.get("q") === prefix,
    );
    await expect(inbox.getByText("筛选结果 3 项", { exact: true })).toBeVisible();
    await expect(inbox.getByText("逾期 1", { exact: true })).toBeVisible();
    await expect(inbox.getByText("未分配 2", { exact: true })).toBeVisible();
    await inbox.getByLabel("责任范围", { exact: true }).selectOption("mine");
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await expect(inbox.locator("tbody tr")).toHaveAttribute("data-task-id", fixture.lineId);
    const view = await fixture.view();
    await fixture.api(`order-centers/lines/${fixture.lineId}/archive`, {
      expectedProjectionVersion: view.businessProjectionVersion,
      archived: true,
      reason: "Synthetic browser archival",
      idempotencyKey: crypto.randomUUID(),
    });
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(inbox.getByText("筛选结果 0 项", { exact: true })).toBeVisible();
    await inbox.getByLabel("任务状态", { exact: true }).selectOption("closed");
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await expect(inbox.getByText("本件已归档", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    const failures: unknown[] = [];
    for (const fixture of fixtures.reverse())
      try {
        await fixture.close();
      } catch (error) {
        failures.push(error);
      }
    expect(failures, "Synthetic order fixture cleanup failed").toEqual([]);
  }
});

test("order inbox clears cached rows when current PII permission is revoked and recovers after restoration", async ({
  page,
}) => {
  const prefix = "Order inbox permission " + crypto.randomUUID().slice(0, 8),
    fixture = await orderResponsibilityFixture(prefix);
  try {
    await page.clock.install();
    await page.goto(
      `/business-tasks?${new URLSearchParams({ object: "order", assignment: "visible", q: prefix, timeZone: "UTC" })}`,
    );
    const inbox = page.getByRole("region", { name: "订单履约任务收件箱", exact: true });
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await fixture.permissions([Permission.OrderRead, Permission.NotificationRead]);
    await page.clock.fastForward(31000);
    await expect(inbox.getByRole("alert")).toContainText("当前账号没有此操作权限");
    await expect(inbox.locator("tbody tr")).toHaveCount(0);
    expect((await page.request.get("/api/order-centers/tasks?assignment=visible")).status()).toBe(
      403,
    );
    await fixture.permissions();
    await inbox.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});
