import { expect, test } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { exceptionOperationsFixture, exceptionRoles } from "./order-exception-operations-fixture";

test("mixed order write scope leaves reviewed exception commands unavailable until that permission is widened", async ({
  page,
}) => {
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.mixedOrderScope(Permission.OrderWrite, "self");
    const before = await fixture.operations(fixture.id);
    expect(before.canCreate).toBe(false);
    expect(before.items[0]?.canResolve).toBe(false);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    const record = panel.locator(`[data-exception-id="${fixture.id}"]`);
    await expect(record).toBeVisible();
    await expect(panel.getByRole("button", { name: "登记异常", exact: true })).toBeDisabled();
    await expect(record.getByRole("button", { name: "记录已解决", exact: true })).toBeDisabled();
    await expect(fixture.create()).rejects.toThrow("orders returned 403");
    expect((await fixture.operations(fixture.id)).items[0]?.exception.status).toBe(
      before.items[0]?.exception.status,
    );
    await fixture.permissions(exceptionRoles.handling);
    await page.reload();
    await expect(record.getByRole("button", { name: "记录已解决", exact: true })).toBeEnabled();
  } finally {
    await fixture.close();
  }
});

test("limited private-order scope also blocks the parent task before protected exception messages render", async ({
  page,
}) => {
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.mixedOrderScope(Permission.OrderPiiRead, "team");
    await expect(fixture.view()).rejects.toThrow("business-followups returned 403");
    await expect(fixture.operations(fixture.id)).rejects.toThrow("orders returned 403");
    const denied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.includes(
          `/business-followups/order_exception/${fixture.id}`,
        ) && response.request().method() === "GET",
    );
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    expect((await denied).status()).toBe(403);
    await expect(page.getByText("Synthetic fixture exception", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "记录已解决", exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
test("a real minimum handling role resolves a focused exception and the task follows the original event", async ({
  page,
}, info) => {
  const fixture = await exceptionOperationsFixture(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await fixture.permissions(exceptionRoles.handling);
    const before = await fixture.api<{ workflowState: string; sideState: string | null }>(
      `orders/${fixture.orderId}`,
    );
    await page.goto(
      `/business-tasks?object=order_exception&target=${fixture.id}&assignment=visible`,
    );
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true }),
      record = panel.locator(`[data-exception-id="${fixture.id}"]`);
    await record.getByRole("button", { name: "记录已解决", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记异常实际处理结果", exact: true });
    await dialog
      .getByLabel("实际处理依据", { exact: true })
      .fill("Synthetic actual handling evidence checked");
    await expect(page.getByLabel("业务对象", { exact: true })).toBeDisabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 950 });
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(Math.abs(bounds!.y)).toBeLessThan(1);
      expect(bounds!.height).toBeLessThanOrEqual(951);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`exception-editor-${width}.png`),
        fullPage: false,
      });
    }
    await dialog.getByRole("button", { name: "保存处理结果", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      record.getByText("Synthetic actual handling evidence checked", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "订单异常已解决", exact: true })).toBeVisible();
    const after = await fixture.api<{ workflowState: string; sideState: string | null }>(
      `orders/${fixture.orderId}`,
    );
    expect(after.workflowState).toBe(before.workflowState);
    expect(after.sideState).toBe(before.sideState);
    expect((await fixture.operations(fixture.id)).items[0]!.exception.status).toBe("resolved");
    await page.goto("/business-tasks?object=order_exception&assignment=visible&status=closed");
    await expect(page.locator(`[data-task-id="${fixture.id}"]`)).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});
test("the original order exposes the same operation UI and registers an actual exception with the minimum role", async ({
  page,
}) => {
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.permissions(exceptionRoles.handling);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    await page.getByRole("link", { name: "打开原订单处理异常", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`exception=${fixture.id}`));
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    await expect(panel.locator(`[data-exception-id="${fixture.id}"]`)).toBeVisible();
    await panel.getByRole("button", { name: "登记异常", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记本单异常", exact: true });
    await dialog.getByLabel("异常类型", { exact: true }).selectOption("quality");
    await dialog
      .getByLabel("问题说明", { exact: true })
      .fill("Synthetic manual quality issue with actual evidence");
    await dialog.getByRole("button", { name: "保存异常记录", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      panel.getByText("Synthetic manual quality issue with actual evidence", { exact: true }),
    ).toBeVisible();
    expect(
      (await fixture.operations()).items.filter(
        (item) => item.exception.message === "Synthetic manual quality issue with actual evidence",
      ),
    ).toHaveLength(1);
    await page.getByRole("link", { name: "返回业务任务", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`target=${fixture.id}`));
  } finally {
    await fixture.close();
  }
});
test("stale evidence preserves the draft and current write permission loss disables the action", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.permissions(exceptionRoles.handling);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    await panel.getByRole("button", { name: "记录已解决", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记异常实际处理结果", exact: true });
    await dialog.getByLabel("实际处理依据", { exact: true }).fill("Unsaved actual handling draft");
    await fixture.create();
    await dialog.getByRole("button", { name: "保存处理结果", exact: true }).click();
    await expect(
      dialog.getByText("订单或异常已变化 当前填写保留 请核对最新记录", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel("实际处理依据", { exact: true })).toHaveValue(
      "Unsaved actual handling draft",
    );
    await dialog.getByRole("button", { name: "放弃填写并载入最新记录", exact: true }).click();
    await panel.getByRole("button", { name: "记录已解决", exact: true }).click();
    await dialog.getByLabel("实际处理依据", { exact: true }).fill("Retained role-change draft");
    await fixture.permissions(exceptionRoles.reader);
    await page.clock.fastForward(31000);
    await expect(dialog.getByRole("button", { name: "保存处理结果", exact: true })).toBeDisabled();
    await expect(dialog.getByText("当前没有处理权限或异常已经解决", { exact: true })).toBeVisible();
    await fixture.permissions([Permission.OrderRead, Permission.NotificationRead]);
    await page.clock.fastForward(31000);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Synthetic fixture exception", { exact: true })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
test("assignment-only readers cannot close an exception or gain processing rights by assigning", async ({
  page,
}) => {
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.permissions(exceptionRoles.assigner);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    await expect(panel.getByRole("button", { name: "登记异常", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "记录已解决", exact: true })).toBeDisabled();
    const basis = (await fixture.view()).responsibility;
    await expect(
      fixture.api(`business-followups/order_exception/${fixture.id}/responsibility`, {
        expectedRevision: basis.revision,
        expectedSourceChecksum: basis.sourceChecksum,
        assignedUserId: fixture.context.userId,
        dueAt: null,
        escalationUserId: null,
        escalationDelayMinutes: null,
        reason: "initial_assignment",
      }),
    ).rejects.toThrow("business-followups returned 400");
    expect((await fixture.view()).responsibility.revision).toBe(basis.revision);
    await fixture.permissions([...exceptionRoles.handling, Permission.OrderAssign]);
    await page.reload();
    const responsibility = page.getByRole("region", { name: "订单异常责任与时限", exact: true });
    await expect(
      responsibility.getByRole("button", { name: "调整责任与时限", exact: true }),
    ).toBeEnabled();
    await responsibility.getByRole("button", { name: "调整责任与时限", exact: true }).click();
    const assignment = page.getByRole("dialog", { name: "安排订单异常", exact: true });
    await assignment.getByLabel("负责人", { exact: true }).selectOption(fixture.context.userId);
    await assignment.getByLabel("调整原因", { exact: true }).selectOption("initial_assignment");
    await assignment.getByRole("button", { name: "保存安排", exact: true }).click();
    await expect(assignment).not.toBeVisible();
    expect((await fixture.view()).responsibility.assignedUserId).toBe(fixture.context.userId);
    await fixture.permissions(exceptionRoles.assigner);
    await page.reload();
    await expect(panel.getByRole("button", { name: "登记异常", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "记录已解决", exact: true })).toBeDisabled();
    expect((await fixture.operations(fixture.id)).items[0]!.canResolve).toBe(false);
  } finally {
    await fixture.close();
  }
});
test("a lost successful response can be retried with the original key without another resolution", async ({
  page,
}) => {
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.permissions(exceptionRoles.handling);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    await panel.getByRole("button", { name: "记录已解决", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记异常实际处理结果", exact: true });
    await dialog
      .getByLabel("实际处理依据", { exact: true })
      .fill("Synthetic response-loss evidence");
    const target = `**/api/order-exceptions/${fixture.orderId}/${fixture.id}/resolve`;
    await page.route(
      target,
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            message: "Synthetic response unavailable Please inspect the record before retry",
          }),
        });
      },
      { times: 1 },
    );
    await dialog.getByRole("button", { name: "保存处理结果", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Synthetic response unavailable");
    await dialog.getByRole("button", { name: "保存处理结果", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect((await fixture.operations(fixture.id)).items[0]).toMatchObject({
      sequence: 2,
      exception: { status: "resolved", resolution: "Synthetic response-loss evidence" },
    });
  } finally {
    await fixture.close();
  }
});
test("expiry while editing clears protected messages and cannot resolve the exception", async ({
  page,
}) => {
  await page.clock.install();
  const fixture = await exceptionOperationsFixture();
  try {
    await fixture.permissions(exceptionRoles.handling);
    await page.goto(`/business-tasks?object=order_exception&target=${fixture.id}`);
    const panel = page.getByRole("region", { name: "订单异常处理", exact: true });
    await panel.getByRole("button", { name: "记录已解决", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "登记异常实际处理结果", exact: true });
    await dialog.getByLabel("实际处理依据", { exact: true }).fill("Unsaved expiry test");
    await fixture.expire(true);
    await page.clock.fastForward(31000);
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Synthetic fixture exception", { exact: true })).toHaveCount(0);
    await fixture.expire(false);
    expect((await fixture.operations(fixture.id)).items[0]!.exception.status).toBe("open");
  } finally {
    await fixture.close();
  }
});
