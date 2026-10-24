import { expect, test } from "@playwright/test";
import type { WorkflowRunDetail } from "@yummyai/contracts/workflow";
import { Permission } from "../../../packages/authz/src/index";
import { workflowApi, workflowOperatorFixture } from "./workflow-operator-fixture";

async function assigned(
  fixture: Awaited<ReturnType<typeof workflowOperatorFixture>>,
  title: string,
  dueAt: string | null = null,
) {
  const run = await fixture.run(undefined, {}, undefined, false, {
    title,
    human: true,
    nodeTitle: "核对定制商品规格与来源并保持版本依据完整 ".repeat(4).trim(),
  });
  await workflowApi(`workflow-runs/${run.id}/nodes/execute/responsibility`, {
    expectedRevision: run.revision,
    assignedUserId: fixture.context.userId,
    dueAt,
    escalationUserId: null,
    escalationDelayMinutes: null,
    reason: "Synthetic task inbox acceptance",
  });
  return run;
}
test("unified business tasks keep server counts, filters and location while real node completion updates the inbox", async ({
  page,
}, testInfo) => {
  const fixture = await workflowOperatorFixture(),
    prefix = `Synthetic Inbox ${crypto.randomUUID().slice(0, 8)}`,
    errors: string[] = [],
    writes: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/api/workflow-runs") &&
      request.method() !== "GET"
    )
      writes.push(request.method());
  });
  try {
    const records: WorkflowRunDetail[] = [];
    for (let index = 0; index < 3; index++)
      records.push(
        await assigned(
          fixture,
          `${prefix} ${index} 商品名称与制作来源需要完整保留`,
          index === 0 ? "2000-01-01T00:00:00Z" : null,
        ),
      );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(
      `/business-tasks?${new URLSearchParams({ object: "workflow", q: prefix, pageSize: "2", timeZone: "UTC" })}`,
    );
    const inbox = page.getByRole("region", { name: "工作流任务收件箱", exact: true });
    await expect(inbox.getByText("筛选结果 3 项", { exact: true })).toBeVisible();
    await expect(inbox.getByText("逾期 1", { exact: true })).toBeVisible();
    await expect(inbox.locator("tbody tr")).toHaveCount(2);
    await expect(inbox.getByLabel("业务对象", { exact: true })).toHaveValue("workflow");
    await page.screenshot({ path: testInfo.outputPath("inbox-desktop.png"), fullPage: true });
    await inbox.getByLabel("责任范围", { exact: true }).selectOption("unassigned");
    await expect(inbox.getByText("未分配 3", { exact: true })).toBeVisible();
    await expect(inbox.getByText("待上游 3", { exact: true })).toBeVisible();
    await inbox.getByLabel("责任范围", { exact: true }).selectOption("mine");
    await inbox.getByLabel("内部截止", { exact: true }).selectOption("overdue");
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await page.reload();
    await expect(inbox.getByLabel("内部截止", { exact: true })).toHaveValue("overdue");
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await inbox.getByLabel("内部截止", { exact: true }).selectOption("any");
    await expect(inbox.getByText("筛选结果 3 项", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("inbox-tablet-dark.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("inbox-phone.png"), fullPage: true });
    expect(writes).toEqual([]);
    for (const run of records)
      expect(
        (await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).nodes.find(
          (node) => node.nodeId === "execute",
        )!.status,
      ).toBe("in_progress");
    await inbox.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(inbox.locator("tbody tr")).toHaveCount(1);
    const row = inbox.locator("tbody tr"),
      taskId = await row.getAttribute("data-task-id");
    const target = records.find((run) => run.nodes.some((node) => node.id === taskId))!;
    await row.getByRole("link", { name: "打开任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/runs/${target.id}\\?task=${taskId}`), {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "完成并推进", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await workflowApi<WorkflowRunDetail>(`workflow-runs/${target.id}`)).nodes.find(
            (node) => node.id === taskId,
          )!.status,
      )
      .toBe("completed");
    await page.goBack();
    await expect(page).toHaveURL(/page=2/);
    await expect(inbox.getByText("筛选结果 2 项", { exact: true })).toBeVisible();
    await inbox.getByRole("button", { name: "返回第一页", exact: true }).click();
    await expect(inbox.locator("tbody tr")).toHaveCount(2);
    await inbox.getByLabel("任务状态", { exact: true }).selectOption("closed");
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await expect(inbox.getByText("已完成", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await testInfo.attach("task-inbox-proof", {
      body: JSON.stringify({
        records: records.map((run) => run.id),
        completedTaskId: taskId,
        readRequestsDispatchedActions: false,
        workerStarted: false,
      }),
      contentType: "application/json",
    });
  } finally {
    await fixture.close();
  }
});

test("an assigned read-only member sees tasks without order or dashboard permissions and cannot execute them", async ({
  page,
}) => {
  const fixture = await workflowOperatorFixture(),
    prefix = `Read-only inbox ${crypto.randomUUID().slice(0, 8)}`,
    requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  try {
    const run = await assigned(fixture, prefix);
    await fixture.permissions([
      Permission.WorkflowRead,
      Permission.ProductRead,
      Permission.NotificationRead,
    ]);
    await page.goto(`/business-tasks?q=${encodeURIComponent(prefix)}&timeZone=UTC`);
    const inbox = page.getByRole("region", { name: "工作流任务收件箱", exact: true });
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    expect(
      requested.some(
        (path) => path.startsWith("/api/order-centers") || path.startsWith("/api/sales-plan"),
      ),
    ).toBe(false);
    await inbox.getByRole("link", { name: "打开任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/runs/${run.id}`), { timeout: 30_000 });
    await expect(page.getByText("当前成员可查看记录 暂无操作权限", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "完成并推进", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "调整责任与时限", exact: true })).toBeDisabled();
    const current = await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`);
    await expect(
      workflowApi(`workflow-runs/${run.id}/nodes/execute/commands`, {
        type: "complete",
        expectedRevision: current.revision,
      }),
    ).rejects.toThrow("returned 403");
    expect(
      (await workflowApi<WorkflowRunDetail>(`workflow-runs/${run.id}`)).nodes.find(
        (node) => node.nodeId === "execute",
      )!.status,
    ).toBe("in_progress");
  } finally {
    await fixture.close();
  }
});

test("current permission loss clears task rows and the existing order and sales entry paths remain usable", async ({
  page,
}) => {
  const fixture = await workflowOperatorFixture(),
    prefix = `Permission inbox ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await assigned(fixture, prefix);
    await page.clock.install();
    await page.goto(`/business-tasks?object=workflow&q=${encodeURIComponent(prefix)}&timeZone=UTC`);
    const inbox = page.getByRole("region", { name: "工作流任务收件箱", exact: true });
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await fixture.permissions(
      Object.values(Permission).filter((value) => value !== Permission.ProductRead),
    );
    await page.clock.fastForward(31_000);
    await expect(inbox.getByRole("alert")).toContainText("当前成员没有查看或操作该任务的权限");
    await expect(inbox.locator("tbody tr")).toHaveCount(0);
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).not.toBeVisible();
    await fixture.permissions();
    await inbox.getByRole("button", { name: "重新读取", exact: true }).click();
    await expect(inbox.getByText("筛选结果 1 项", { exact: true })).toBeVisible();
    await inbox.getByLabel("业务对象", { exact: true }).selectOption("order");
    await expect(page.getByRole("heading", { name: "订单履约待办", exact: true })).toBeVisible();
    await expect(page.getByLabel("业务对象", { exact: true })).toHaveValue("order");
    await page.getByLabel("业务对象", { exact: true }).selectOption("sales_plan");
    await expect(page.getByLabel("业务对象", { exact: true })).toHaveValue("sales_plan");
    await page.goto("/business-tasks?target=not-a-uuid");
    await expect(page.getByLabel("业务对象", { exact: true })).toHaveValue("order");
    await expect(page.getByText("业务对象编号无效", { exact: true })).toBeVisible();
  } finally {
    await fixture.close();
  }
});
