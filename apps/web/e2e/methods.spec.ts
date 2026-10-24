import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { AgentMethodRow, AgentMethodWorkspace } from "@yummyai/contracts/harness/methods";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import type { AssistView } from "@yummyai/contracts/ai/assist";
import { PodExecutableToolKeySchema, type TenantContext } from "@yummyai/contracts";
import { Permission } from "../../../packages/authz/src/index";
import {
  connectDatabase,
  withTenant,
  roles,
  membershipRoles,
  memberships,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { getApiHeaders } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";

test.setTimeout(120_000);
const methodKey = (kind: string) => `yummyai.assist.${kind}.review`;
const catalogRows = 1 + 10 + 2 + 2 + PodExecutableToolKeySchema.options.length * 2;
async function snapshot(page: Page, options: Parameters<Page["screenshot"]>[0]) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      );
    }
  });
  // A fixed modal is a viewport. Full-document capture includes the inert list beneath it.
  return page.screenshot({ ...options, fullPage: (await page.getByRole("dialog").count()) === 0 });
}
async function method(kind: string) {
  const workspace = await centerApi<AgentMethodWorkspace>("agent-methods/workspace");
  return workspace.methods.find((row) => row.methodKey === methodKey(kind))!;
}
async function save(kind: string, notes: string) {
  const current = await method(kind);
  await centerApi("agent-methods/save", {
    methodKey: methodKey(kind),
    notes,
    expectedRevision: current?.revision ?? 0,
    knowledgeVersionIds: [],
    reason: "Synthetic controlled browser draft",
    requestId: randomUUID(),
  });
  return method(kind);
}
async function action(row: AgentMethodRow, operation: "submit" | "publish" | "disable") {
  return centerApi(`agent-methods/${row.id}/${operation}`, {
    expectedRevision: row.revision,
    version: operation === "disable" ? row.activeVersion : row.latestVersion,
    ...(operation === "publish" ? { reviewedChecksum: row.latest.checksum } : {}),
    reason: "Synthetic controlled browser review",
    requestId: randomUUID(),
  });
}
async function source(title: string) {
  const created = await centerApi<{ id: string }>("knowledge/create", {
    fields: {
      title,
      summary: "Synthetic method bibliography",
      body: "Keep operating guidance and business facts separate.",
      topic: "operations",
      platform: "all",
      market: "ALL",
      spuId: null,
      sourceType: "team",
      sourceLabel: "Synthetic reviewed team",
      sourceUrl: "",
      owner: "Synthetic operator",
      verifiedOn: "2026-01-01",
      reviewDueOn: "2099-12-31",
      tags: [],
    },
    expectedRevision: 0,
    reason: "Synthetic method source",
    requestId: randomUUID(),
  });
  for (const operation of ["submit", "publish"]) {
    const row = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
      (entry) => entry.id === created.id,
    )!;
    await centerApi(`knowledge/${row.id}/${operation}`, {
      expectedRevision: row.revision,
      version: row.latestVersion,
      reason: "Synthetic source review",
      requestId: randomUUID(),
    });
  }
  return created.id;
}
async function open(page: Page, kind: string, version?: number) {
  await page.goto(
    `/knowledge/methods?method=${methodKey(kind)}${version ? `&version=${version}` : ""}`,
  );
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible();
  return panel;
}
async function permissions() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error("Method browser permissions require the disposable runner");
  const database = connectDatabase();
  try {
    const headers = await getApiHeaders(),
      claims = JSON.parse(
        Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString(),
      );
    const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
      "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'",
      [claims.sub],
    );
    if (!identity) throw new Error("Synthetic method identity unavailable");
    const context: TenantContext = {
      tenantId: identity.tenant_id,
      userId: identity.user_id,
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    const grants = await withTenant(database.db, context, (tx) =>
      tx
        .select({ id: roles.id, permissions: roles.permissions })
        .from(roles)
        .innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
        .innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(eq(memberships.userId, context.userId)),
    );
    return {
      async set(allowed: string[]) {
        for (const grant of grants)
          await withTenant(database.db, context, (tx) =>
            tx
              .update(roles)
              .set({ permissions: grant.permissions.filter((value) => allowed.includes(value)) })
              .where(eq(roles.id, grant.id)),
          );
      },
      async close() {
        try {
          for (const grant of grants)
            await withTenant(database.db, context, (tx) =>
              tx
                .update(roles)
                .set({ permissions: grant.permissions })
                .where(eq(roles.id, grant.id)),
            );
        } finally {
          await database.client.end();
        }
      },
    };
  } catch (cause) {
    await database.client.end();
    throw cause;
  }
}

test("method workbench reviews exact v1/v2, pins actual tasks and shows withdrawn sources", async ({
  page,
}, testInfo) => {
  const fixture = await knowledgeGovernanceFixture("method-workbench"),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await source("Synthetic method source A");
    const sourceB = await source("Synthetic method source B");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/knowledge/methods");
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(catalogRows);
    await expect(page.getByRole("button", { name: "查看工作流 · 图案裁剪", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看POD 处理 · 图案裁剪", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "查看生产稿预检", exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "查看生产稿预检 · 看图审核", exact: true }),
    ).toBeVisible();
    await page.getByLabel("搜索方法", { exact: true }).fill("Synthetic no matching method");
    await expect(page.getByText("没有匹配的方法，请调整名称或状态")).toBeVisible();
    await page.getByLabel("搜索方法", { exact: true }).fill("");
    await page.getByLabel("查看方法状态", { exact: true }).selectOption("review");
    await expect(page.getByText("没有匹配的方法，请调整名称或状态")).toBeVisible();
    await page.getByLabel("查看方法状态", { exact: true }).selectOption("all");
    await expect(page.getByRole("table").getByRole("row")).toHaveCount(catalogRows);
    await snapshot(page, { path: testInfo.outputPath("method-list-desktop.png"), fullPage: true });
    let panel = await open(page, "knowledge_answer");
    await expect(panel).toContainText("当前沿用内置方法");
    await panel.getByRole("button", { name: "创建团队草稿" }).click();
    await panel.getByLabel("团队补充说明", { exact: true }).fill("Synthetic reviewed method v1");
    await panel
      .getByRole("checkbox", { name: "选择 Synthetic method source A v1", exact: true })
      .check();
    await panel.getByLabel("变更原因", { exact: true }).fill("Synthetic v1 change");
    await snapshot(page, { path: testInfo.outputPath("method-edit-desktop.png") });
    await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(panel.getByRole("region", { name: "方法差异复核" })).toContainText(
      "引用新增 1 项",
    );
    await panel.getByLabel("操作原因", { exact: true }).fill("Synthetic submit v1");
    await panel.getByRole("button", { name: "提交复核", exact: true }).click();
    await panel.getByLabel("操作原因", { exact: true }).fill("Synthetic publish v1");
    await expect(panel.getByRole("button", { name: "发布此版本" })).toBeDisabled();
    await panel.getByRole("checkbox", { name: "我已核对本版本说明和引用差异" }).check();
    await panel.getByRole("button", { name: "发布此版本" }).click();
    await expect.poll(async () => (await method("knowledge_answer")).activeVersion).toBe(1);
    const run = await centerApi<AssistView>("ai-assists/runs", {
      kind: "knowledge_answer",
      purpose: "dialogue",
      scopeId: randomUUID(),
      search: {
        query: "Keep operating guidance and business facts separate",
        topic: "all",
        platform: "amazon",
        market: "US",
        spuIds: [],
      },
      evidenceStoreId: null,
      previousRunId: null,
      modelId: fixture.modelId,
      requestId: randomUUID(),
    });
    await panel.getByRole("button", { name: "团队说明", exact: true }).click();
    await panel
      .getByLabel("团队补充说明", { exact: true })
      .fill("Synthetic reviewed method v2 " + "长说明".repeat(100) + "LongSegment".repeat(80));
    await panel.getByRole("button", { name: "移除来源 Synthetic method source A v1" }).click();
    await panel
      .getByRole("checkbox", { name: "选择 Synthetic method source B v1", exact: true })
      .check();
    await panel.getByLabel("变更原因", { exact: true }).fill("Synthetic v2 change");
    await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
    await expect(panel.getByRole("region", { name: "方法差异复核" })).toContainText(
      "引用新增 1 项 · 移除 1 项",
    );
    expect((await method("knowledge_answer")).activeVersion).toBe(1);
    await panel.getByLabel("操作原因", { exact: true }).fill("Synthetic submit v2");
    await panel.getByRole("button", { name: "提交复核", exact: true }).click();
    await panel.getByLabel("操作原因", { exact: true }).fill("Synthetic publish v2");
    await panel.getByRole("checkbox", { name: "我已核对本版本说明和引用差异" }).check();
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await snapshot(page, {
        path: testInfo.outputPath(`method-review-${width}.png`),
        fullPage: true,
      });
    }
    await panel.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "查看有引用的知识问答", exact: true }).click();
    await panel.getByRole("button", { name: "复核差异", exact: true }).click();
    await panel
      .getByLabel("操作原因", { exact: true })
      .fill("Synthetic publish v2 after fresh review");
    await panel.getByRole("checkbox", { name: "我已核对本版本说明和引用差异" }).check();
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await snapshot(page, {
      path: testInfo.outputPath("method-review-dark-mobile.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "发布此版本" }).click();
    await expect.poll(async () => (await method("knowledge_answer")).activeVersion).toBe(2);
    await fixture.answer(run.id);
    const oldRun = await centerApi<AssistView>("ai-assists/runs/" + run.id);
    expect(oldRun.status).toBe("completed");
    expect(oldRun.methodSelection?.mode).toBe("published");
    if (oldRun.methodSelection?.mode === "published")
      expect(oldRun.methodSelection.version).toBe(1);
    expect(fixture.modelCalls()).toBe(1);
    panel = await open(page, "knowledge_answer", 1);
    await expect(panel.getByRole("region", { name: "方法版本记录" })).toContainText(
      "Synthetic reviewed method v1",
    );
    const card = (await centerApi<KnowledgeWorkspace>("knowledge/workspace")).entries.find(
      (entry) => entry.id === sourceB,
    )!;
    await centerApi(`knowledge/${card.id}/disable`, {
      expectedRevision: card.revision,
      version: card.latestVersion,
      reason: "Synthetic withdrawn method source",
      requestId: randomUUID(),
    });
    await panel.getByRole("button", { name: "重新读取当前版本" }).click();
    await panel.getByRole("button", { name: "当前状态", exact: true }).click();
    await expect(panel).toContainText("来源待复核");
    await panel.getByRole("button", { name: "复核差异", exact: true }).click();
    await panel.getByLabel("操作原因", { exact: true }).fill("Synthetic method withdrawal");
    await panel.getByRole("button", { name: "停用当前方法" }).click();
    await panel.getByRole("button", { name: "当前状态", exact: true }).click();
    await expect(panel).toContainText("已停用");
    await snapshot(page, {
      path: testInfo.outputPath("method-withdrawn-mobile.png"),
      fullPage: true,
    });
    await panel.getByRole("button", { name: "关闭", exact: true }).click();
    await snapshot(page, {
      path: testInfo.outputPath("method-list-mobile-dark.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("method drafts survive concurrency and recover source read failures", async ({ page }) => {
  await save("creative", "Synthetic server v1");
  const panel = await open(page, "creative");
  await page.route("**/api/agent-methods/sources?*", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ message: "Synthetic source temporarily unavailable" }),
    }),
  );
  await panel.getByRole("button", { name: "团队说明", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Synthetic source temporarily unavailable");
  await expect(panel.getByText("没有匹配的已发布通用知识", { exact: false })).toHaveCount(0);
  await page.unroute("**/api/agent-methods/sources?*");
  await panel.getByLabel("搜索通用知识", { exact: true }).fill("Synthetic");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.getByLabel("团队补充说明", { exact: true }).fill("Synthetic unsent local draft");
  await panel.getByLabel("变更原因", { exact: true }).fill("Synthetic local change");
  await save("creative", "Synthetic concurrent server v2");
  await panel.getByRole("button", { name: "保存草稿", exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await expect(panel.getByLabel("团队补充说明", { exact: true })).toHaveValue(
    "Synthetic unsent local draft",
  );
  await panel.getByRole("button", { name: "重新读取当前版本" }).click();
  await expect(panel).toContainText("服务端已有新修订");
  await expect(panel.getByRole("button", { name: "保存草稿", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "放弃修改" }).click();
  await panel.getByRole("button", { name: "团队说明", exact: true }).click();
  await expect(panel.getByLabel("团队补充说明", { exact: true })).toHaveValue(
    "Synthetic concurrent server v2",
  );
  await panel.getByRole("button", { name: "放弃修改" }).click();
});

test("read-only method users cannot edit or publish through the real same-origin API", async ({
  page,
}) => {
  const row = await save("template_config", "Synthetic read-only method"),
    grant = await permissions();
  try {
    await grant.set([Permission.WorkflowRead]);
    const panel = await open(page, "template_config");
    await expect(panel.getByRole("button", { name: "团队说明", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "复核差异", exact: true }).click();
    await expect(panel.getByRole("button", { name: "提交复核", exact: true })).toHaveCount(0);
    const response = await page.request.post(`/api/agent-methods/${row.id}/publish`, {
      headers: { origin: "http://localhost:3130" },
      data: {
        expectedRevision: row.revision,
        version: row.latestVersion,
        reviewedChecksum: row.latest.checksum,
        reason: "Synthetic unauthorized attempt",
        requestId: randomUUID(),
      },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect((await method("template_config")).revision).toBe(row.revision);
  } finally {
    await grant.close();
  }
});

test("withdrawing method read access clears unsent drafts and rejects an older successful response", async ({
  page,
}, testInfo) => {
  await action(await save("business_review", "Synthetic restricted team method"), "submit");
  await action(await method("business_review"), "publish");
  const grant = await permissions();
  let releaseLate = () => {};
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const panel = await open(page, "business_review");
    await panel.getByRole("button", { name: "团队说明", exact: true }).click();
    await panel
      .getByLabel("团队补充说明", { exact: true })
      .fill("Synthetic confidential unsent notes");
    let markFetched = () => {};
    const fetched = new Promise<void>((resolve) => {
        markFetched = resolve;
      }),
      released = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
    let held = false;
    await page.route("**/api/agent-methods/workspace", async (route) => {
      const response = await route.fetch();
      if (!held && response.status() === 200) {
        held = true;
        markFetched();
        await released;
      }
      await route.fulfill({ response }).catch(() => {
        /* The client cancels an obsolete read. */
      });
    });
    await panel.getByRole("button", { name: "重新读取当前版本" }).click();
    await fetched;
    await grant.set([]);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator(".method-page").getByRole("alert")).toContainText(
      "当前账号没有方法操作权限",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByLabel("团队补充说明", { exact: true })).toHaveCount(0);
    releaseLate();
    await page.unroute("**/api/agent-methods/workspace");
    await expect(page.locator("body")).not.toContainText("Synthetic restricted team method");
    await expect(page.getByRole("table")).toHaveCount(0);
    await snapshot(page, {
      path: testInfo.outputPath("method-read-withdrawn.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  } finally {
    releaseLate();
    await grant.close();
  }
});
