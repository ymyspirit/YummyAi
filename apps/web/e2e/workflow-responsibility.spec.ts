import { expect, test } from "@playwright/test";
import type { NotificationInbox } from "@yummyai/contracts/operations/notification";
import type { WorkflowResponsibilityView } from "@yummyai/contracts/workflow/responsibility";
import { Permission } from "../../../packages/authz/src/index";
import { workflowApi, workflowOperatorFixture } from "./workflow-operator-fixture";

test("saves a real assignment, retains a selected member across searches and persists read state", async ({
  page,
}, testInfo) => {
  const fixture = await workflowOperatorFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const run = await fixture.run(),
      nodeRunId = run.nodes.find((node) => node.nodeId === "execute")!.id;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/workflows/runs/${run.id}?node=execute`);
    await page.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const form = page.getByRole("dialog", { name: "调整任务责任与时限", exact: true });
    await form.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await form.getByLabel("查找成员", { exact: true }).fill("no-such-synthetic-member");
    await form.getByRole("button", { name: "查找", exact: true }).click();
    await expect(form.getByLabel("负责人", { exact: true })).toHaveValue(fixture.context.userId);
    await expect(
      form.getByLabel("负责人", { exact: true }).locator("option:checked"),
    ).toContainText("Synthetic operator");
    await form
      .getByLabel("内部截止时间 · 浏览器本地时间", { exact: true })
      .fill("2000-01-01T00:00");
    await form.getByLabel("调整原因", { exact: true }).fill("隔离验收的内部任务安排");
    await page.screenshot({
      path: testInfo.outputPath("responsibility-desktop.png"),
      fullPage: true,
    });
    await form.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(form).not.toBeVisible();
    const saved = await workflowApi<WorkflowResponsibilityView>(
      `workflow-runs/${run.id}/nodes/execute/responsibility`,
    );
    expect(saved.assignedUserId).toBe(fixture.context.userId);
    expect(saved.assignmentRevision).toBe(1);
    expect((await fixture.attention()).notices).toBeGreaterThan(0);
    // A task operator need not have access to the business dashboard.
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.DashboardRead),
    );
    await page.reload();
    await page.getByRole("button", { name: /^通知/ }).click();
    const inbox = page.getByRole("dialog", { name: "通知中心", exact: true });
    const item = inbox
      .getByRole("listitem")
      .filter({ has: page.locator(`a[href="/workflows/runs/${run.id}?task=${nodeRunId}"]`) });
    await expect(item.getByText("任务已到内部截止时间", { exact: true })).toBeVisible();
    await item.getByRole("button", { name: /^标为已读/ }).click();
    await expect(item.getByText("已读", { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: /^通知/ }).click();
    await expect(item.getByText("已读", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.screenshot({ path: testInfo.outputPath("inbox-tablet-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
    expect(await inbox.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath("inbox-phone.png"), fullPage: true });
    await item.getByRole("link", { name: "查看任务", exact: true }).click();
    await expect(page.getByRole("heading", { name: "整理商品事实", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get("task")).toBe(nodeRunId);
    expect(errors).toEqual([]);
    await testInfo.attach("responsibility-proof", {
      body: JSON.stringify({
        runId: run.id,
        nodeRunId,
        assignmentRevision: saved.assignmentRevision,
        externalNotifications: 0,
      }),
      contentType: "application/json",
    });
  } finally {
    await fixture.close();
  }
});

test("preserves stale responsibility drafts and rechecks current assignment permission", async ({
  page,
}) => {
  const fixture = await workflowOperatorFixture();
  try {
    const run = await fixture.run();
    await page.goto(`/workflows/runs/${run.id}?node=execute`);
    await page.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const form = page.getByRole("dialog", { name: "调整任务责任与时限", exact: true });
    await form.getByLabel("调整原因", { exact: true }).fill("保留尚未保存的安排说明");
    await workflowApi(`workflow-runs/${run.id}/nodes/execute/responsibility`, {
      expectedRevision: run.revision,
      assignedUserId: fixture.context.userId,
      dueAt: null,
      escalationUserId: null,
      escalationDelayMinutes: null,
      reason: "Synthetic concurrent operator",
    });
    await form.getByRole("button", { name: "查找", exact: true }).click();
    await expect(
      form.getByText("任务已变化 当前填写保留 请核对最新安排", { exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel("调整原因", { exact: true })).toHaveValue(
      "保留尚未保存的安排说明",
    );
    await expect(form.getByRole("button", { name: "保存安排", exact: true })).toBeDisabled();
    await form.getByRole("button", { name: "放弃填写并载入最新安排", exact: true }).click();
    await form.getByLabel("调整原因", { exact: true }).fill("刷新后可以继续编辑");
    await expect(form.getByRole("button", { name: "保存安排", exact: true })).toBeEnabled();
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.WorkflowAssign),
    );
    await form.getByRole("button", { name: "查找", exact: true }).click();
    await expect(form.getByText("当前没有修改责任安排的权限", { exact: true })).toBeVisible();
    await expect(form.getByRole("button", { name: "保存安排", exact: true })).toBeDisabled();
    await expect(form.getByLabel("调整原因", { exact: true })).toHaveValue("刷新后可以继续编辑");
  } finally {
    await fixture.close();
  }
});

test("pages the real inbox and refuses read writes after permission revocation", async ({
  page,
}) => {
  const fixture = await workflowOperatorFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await fixture.notices(33);
    const initial = await workflowApi<NotificationInbox>("notifications/inbox?limit=1");
    await page.goto("/");
    await page.getByRole("button", { name: /^通知/ }).click();
    const inbox = page.getByRole("dialog", { name: "通知中心", exact: true });
    await expect(inbox.getByText(`已显示 30 / ${initial.total}`, { exact: true })).toBeVisible();
    await inbox.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(
      inbox.getByText(`已显示 ${initial.total} / ${initial.total}`, { exact: true }),
    ).toBeVisible();
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.NotificationRead),
    );
    await inbox.getByRole("button", { name: "全部已读", exact: true }).click();
    await expect(inbox.getByRole("alert")).toContainText("当前成员没有查看通知的权限");
    await expect(inbox.getByRole("listitem")).toHaveCount(0);
    await fixture.permissions();
    expect((await workflowApi<NotificationInbox>("notifications/inbox?limit=1")).unread).toBe(
      initial.unread,
    );
    await inbox.getByRole("button", { name: "刷新通知", exact: true }).click();
    await expect(inbox.getByRole("button", { name: "全部已读", exact: true })).toBeEnabled();
    await inbox.getByRole("button", { name: "全部已读", exact: true }).click();
    await expect(inbox.getByText("0 条未读", { exact: true })).toBeVisible();
    await inbox.getByLabel("只看未读", { exact: true }).check();
    await expect(inbox.getByText("当前没有未读通知", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inbox).not.toBeVisible();
    await expect(page.getByRole("button", { name: /^通知/ })).toBeFocused();
    expect((await workflowApi<NotificationInbox>("notifications/inbox?limit=1")).unread).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
