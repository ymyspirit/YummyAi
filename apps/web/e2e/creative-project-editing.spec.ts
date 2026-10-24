import { expect, test } from "@playwright/test";
import { CANVAS_BRIDGE, type CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";
import { writeFile } from "node:fs/promises";

test("operators edit requirements and customization, keep history and recover failed saves at desktop and narrow widths", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const name = `E2E Creative edit ${crypto.randomUUID().slice(0, 8)}`;
  const source = await centerApi<CanvasBrief>("canvas-bridge/briefs", {
    requestId: crypto.randomUUID(), name, prompt: "Original checked creative direction",
    requirements: CreativeRequirementsSchema.parse({ mode: "fixed", audience: "Original audience" }),
  });
  const document = JSON.stringify({ projects: [{ id: "existing-canvas", nodes: [{ id: "existing-node", text: "Keep this artwork" }] }] });
  const ids = new Set([source.id]);
  try {
    await centerApi("creative-studio/rpc", { operation: "state.set", scope: source.id, namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0, value: document });
    const result = await centerApi<{ versionId: string }>(`canvas-bridge/briefs/${source.id}/results`, {
      submissionId: crypto.randomUUID(), protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: "fixture", title: "Original approved design", contentBase64: syntheticProductionPng(64).toString("base64"),
      rightsAttested: true, sourceKind: "owned", sourceReference: "Isolated synthetic fixture",
    });
    await centerApi(`canvas-bridge/briefs/${source.id}/review`, { versionIds: [result.versionId], decision: "approve" });
    await page.goto(`/creative-designs/canvas?brief=${source.id}`);
    await expect(page.getByLabel("项目名称", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "编辑项目", exact: true }).click();
    await expect(page.getByLabel("项目名称", { exact: true })).toBeEnabled();
    await page.getByLabel("项目名称", { exact: true }).fill(`${name} revised`);
    await page.getByLabel("创意方向与制作要求", { exact: true }).fill("Manual correction: preserve layout, add customer lettering");
    await page.getByLabel("目标人群", { exact: true }).fill("Operations confirmed audience");
    await page.getByLabel("定制类型", { exact: true }).selectOption("personalized_text");
    await page.getByRole("button", { name: "定制配置", exact: true }).click();
    await page.getByRole("button", { name: "添加文字字段", exact: true }).click();
    await page.getByLabel("字段名称", { exact: true }).fill("顾客姓名");
    await page.getByLabel("顾客姓名 最多字符", { exact: true }).fill("32");
    await page.getByRole("button", { name: "需求单", exact: true }).click();
    await expect(page.getByLabel("目标人群", { exact: true })).toHaveValue("Operations confirmed audience");
    await page.getByLabel("修改说明（可选）", { exact: true }).fill("运营与设计共同确认文字区域");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(`project-edit-${width}.png`), fullPage: true });
    }
    // A failed request must preserve the unsaved draft and its retry identity.
    await page.route(`**/api/canvas-bridge/briefs/${source.id}/revisions`, route => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "合成测试：连接暂时中断" }) }), { times: 1 });
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator(".canvas-notice[role=alert]")).toContainText("连接暂时中断");
    await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(`${name} revised`);
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator(".canvas-notice[role=status]")).toContainText("需求 V2 已保存");
    const revisedId = new URL(page.url()).searchParams.get("brief")!; ids.add(revisedId);
    expect(revisedId).not.toBe(source.id);
    await page.reload();
    await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(`${name} revised`);
    await expect(page.getByLabel("创意方向与制作要求", { exact: true })).toHaveValue(/Manual correction/);
    await page.getByRole("button", { name: "定制配置", exact: true }).click();
    await expect(page.getByLabel("字段名称", { exact: true })).toHaveValue("顾客姓名");
    await expect(page.getByLabel("顾客姓名 最多字符", { exact: true })).toHaveValue("32");
    const copied = await centerApi<{ value: unknown }>("creative-studio/rpc", { operation: "state.get", scope: revisedId, namespace: "app_state", key: "infinite-canvas:canvas_store" });
    expect(copied.value).toBe(document);
    await page.getByText("历史版本 · 2", { exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`V1 · ${name}`) }).click();
    await expect(page.getByLabel("创意方向与制作要求", { exact: true })).toHaveValue(source.prompt);
    await page.getByRole("button", { name: "审核与交付", exact: true }).click();
    await expect(page.locator(".canvas-result")).toContainText("已通过");
    await page.getByRole("button", { name: "打开最新需求", exact: true }).click();
    await page.getByRole("button", { name: "编辑项目", exact: true }).click();
    await page.getByLabel("项目名称", { exact: true }).fill("Discard this name");
    page.once("dialog", dialog => dialog.dismiss());
    await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
    await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue("Discard this name");
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "取消编辑", exact: true }).click();
    await expect(page.getByLabel("项目名称", { exact: true })).toHaveValue(`${name} revised`);
    await page.getByRole("button", { name: "返回项目列表", exact: true }).click();
    await page.getByLabel("搜索项目", { exact: true }).fill(name);
    await expect(page.locator(".art-project-row")).toHaveCount(1);
    await expect(page.locator(".art-project-row")).toContainText(`${name} revised`);
    await page.goto(`/content-projects?project=${source.id}`);
    await expect(page.getByRole("heading", { name: `${name} revised`, exact: true })).toBeVisible();
    await page.getByRole("link", { name: "编辑项目需求", exact: true }).first().click();
    await expect(page.getByLabel("项目名称", { exact: true })).toBeEnabled();
  } finally {
    const current = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${source.id}`);
    for (const revision of current.revisions) ids.add(revision.id);
    for (const id of ids) {
      const brief = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${id}`);
      if (["running", "queued"].includes(brief.status)) await centerApi(`pod/design-batches/${id}/cancel`, {});
      await centerApi(`pod/design-batches/${id}/archive`, { archived: true, reason: "Isolated creative editing acceptance teardown" });
    }
    const remaining = await centerApi<Array<{ id: string }>>("canvas-bridge/briefs");
    expect(remaining.filter(row => ids.has(row.id))).toEqual([]);
    await writeFile(testInfo.outputPath("fixture-cleanup.json"), JSON.stringify({ ids: [...ids], archived: true, disposableResources: true }));
  }
});

test("a concurrent edit reports conflict and retains the second operator's draft", async ({ page }, testInfo) => {
  const source = await centerApi<CanvasBrief>("canvas-bridge/briefs", { requestId: crypto.randomUUID(), name: `E2E Concurrent ${crypto.randomUUID().slice(0, 8)}`, prompt: "Initial requirements" });
  try {
    await page.goto(`/creative-designs/canvas?brief=${source.id}&edit=1`);
    await page.getByLabel("创意方向与制作要求", { exact: true }).fill("Second operator's unsaved correction");
    await centerApi(`canvas-bridge/briefs/${source.id}/revisions`, { requestId: crypto.randomUUID(), name: source.name, prompt: "First operator saved this", expectedRevision: 1 });
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator(".canvas-notice[role=alert]")).toContainText("项目已有其他人保存的新版本");
    await expect(page.getByLabel("创意方向与制作要求", { exact: true })).toHaveValue("Second operator's unsaved correction");
    const current = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${source.id}`);
    expect(current.revisions).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath("edit-conflict-preserved.png"), fullPage: true });
    await page.getByRole("button", { name: "已核对，保留我的修改另存新版本", exact: true }).click();
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator(".canvas-notice[role=status]")).toContainText("需求 V3 已保存");
    await expect(page.getByLabel("创意方向与制作要求", { exact: true })).toHaveValue("Second operator's unsaved correction");
  } finally {
    const current = await centerApi<CanvasBrief>(`canvas-bridge/briefs/${source.id}`);
    for (const revision of current.revisions) {
      await centerApi(`pod/design-batches/${revision.id}/cancel`, {});
      await centerApi(`pod/design-batches/${revision.id}/archive`, { archived: true, reason: "Isolated conflict acceptance teardown" });
    }
  }
});
