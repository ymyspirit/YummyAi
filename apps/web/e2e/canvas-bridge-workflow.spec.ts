import { expect, test } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import { CANVAS_BRIDGE, type CanvasBrief, type CanvasResultReceipt } from "@yummyai/contracts/pod/canvas-bridge";
import { apiFetch } from "../src/server-api";
import { syntheticProductionPng } from "./production-editor-fixture";

async function api<T>(path: string, input?: unknown): Promise<T> {
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/${path}`, input ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) } : undefined);
  expect(response.ok, `${path}: ${response.status}`).toBe(true);
  return response.json() as Promise<T>;
}
async function submit(briefId: string, name: string) {
  return api<CanvasResultReceipt>(`canvas-bridge/briefs/${briefId}/results`, { submissionId: crypto.randomUUID(), protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
    sourceNodeId: `synthetic-${createEntityId()}`, title: name, contentBase64: syntheticProductionPng().toString("base64"), rightsAttested: true, sourceKind: "owned", sourceReference: "Synthetic workflow acceptance fixture; no customer assets." });
}

test("template workflow reviews candidates, continues with approved images and opens a real production draft", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.goto("/creative-designs/canvas");
  const name = `E2E Workflow ${createEntityId().slice(-8)}`;
  await page.getByRole("button", { name: /备胎罩.*图案方向/ }).click();
  await page.getByRole("textbox", { name: "需求名称", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "创作说明", exact: true }).fill("Synthetic tire-cover artwork workflow. No AI generation.");
  await page.screenshot({ path: testInfo.outputPath("canvas-template-start.png"), fullPage: true });
  const created = page.waitForResponse((response) => response.url().endsWith("/api/canvas-bridge/briefs") && response.request().method() === "POST");
  await page.getByRole("button", { name: "保存创作需求", exact: true }).click();
  const first = await (await created).json() as CanvasBrief;
  expect(first.workflow?.template.key).toBe("tire_cover");
  const keep = await submit(first.id, "保留方案"), discard = await submit(first.id, "需调整方案");
  let failNextPreview = true;
  await page.route("**/api/canvas-bridge/**/preview", async (route) => {
    if (failNextPreview) { failNextPreview = false; await route.fulfill({ status: 503, body: "Synthetic temporary preview failure" }); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "选择方案 保留方案", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^重试预览 / }).click();
  await expect.poll(() => page.getByRole("img", { name: "保留方案", exact: true }).evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(512);
  await page.getByRole("button", { name: "放大 保留方案", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const advance = page.getByRole("button", { name: "用选中方案继续", exact: true });
  await expect(advance).toBeDisabled();
  await page.getByRole("checkbox", { name: "选择方案 保留方案", exact: true }).check();
  await page.getByRole("button", { name: "批准选中（1）", exact: true }).click();
  await expect(page.locator(".canvas-result").filter({ hasText: "保留方案" }).getByText("已通过", { exact: true })).toBeVisible();
  await expect(advance).toBeDisabled();
  await page.getByRole("checkbox", { name: "选择方案 需调整方案", exact: true }).check();
  await page.getByRole("button", { name: "退回选中", exact: true }).click();
  await page.getByRole("textbox", { name: "退回原因", exact: true }).fill("构图需调整，保留另一方案继续。");
  await page.getByRole("button", { name: "确认退回", exact: true }).click();
  await expect(page.getByText("退回原因：构图需调整，保留另一方案继续。", { exact: true })).toBeVisible();
  await expect(advance).toBeEnabled();
  await page.getByRole("combobox", { name: "筛选方案状态", exact: true }).selectOption("rejected");
  await expect(page.locator(".canvas-result")).toHaveCount(1);
  await page.getByRole("combobox", { name: "筛选方案状态", exact: true }).selectOption("all");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath("canvas-review-desktop.png"), fullPage: true });
  const continued = page.waitForResponse((response) => response.url().endsWith(`/briefs/${first.id}/continue`) && response.request().method() === "POST");
  await advance.click();
  const next = await (await continued).json() as CanvasBrief;
  expect(next.workflow?.sourceVersionIds).toEqual([keep.versionId]);
  expect(next.referenceAssets.map((asset) => asset.id)).toEqual([keep.assetId]);
  expect(next.referenceAssets.some((asset) => asset.id === discard.assetId)).toBe(false);
  await expect(page).toHaveURL(new RegExp(`brief=${next.id}`));
  await page.reload();
  await expect(page.getByRole("heading", { name: `${name} · 构图定稿`, exact: true })).toBeVisible();
  await expect(page.locator(".canvas-step-rail [aria-current=step]")).toContainText("构图定稿");
  await expect(page.locator(".canvas-project-list > button").filter({ hasText: name })).toHaveCount(1);
  await submit(next.id, "最终生产图案");
  const template = await api<ProductionEditorDetailView>("production-editor/projects", { name: `${name} 工艺底稿`, document: {
    schemaVersion: 1, name: "Synthetic geometry", productType: "tire_cover", spec: { diameterMm: 100, dpi: 150, safeInsetMm: 5, opening: null }, contour: [], layers: [],
    confirmations: { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true },
  } });
  await api(`production-editor/projects/${template.project.id}/review`, { expectedVersionId: template.version.id });
  await page.getByRole("button", { name: "刷新任务", exact: true }).click();
  await page.getByRole("checkbox", { name: "选择方案 最终生产图案", exact: true }).check();
  await page.getByRole("button", { name: "批准选中（1）", exact: true }).click();
  await expect(page.locator(".canvas-result .canvas-badge")).toHaveText("已通过");
  await page.getByRole("combobox", { name: "产品工艺底稿", exact: true }).selectOption(template.version.id);
  const handoffResponse = page.waitForResponse((response) => response.url().endsWith(`/briefs/${next.id}/production`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "生成生产草稿（1）", exact: true }).click();
  const handoff = await handoffResponse; expect(handoff.ok()).toBe(true);
  const { projectId } = await handoff.json() as { projectId: string };
  await expect(page.getByRole("button", { name: new RegExp(`打开生产稿.*${name}`) })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: new RegExp(`打开生产稿.*${name}`) })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("canvas-production-linked.png"), fullPage: true });
  for (const width of [768, 390, 375]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.getByRole("heading", { name: "创意工作台", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "切换创作项目", exact: true })).toBeVisible();
    await expect(page.locator(".canvas-projects")).not.toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.screenshot({ path: testInfo.outputPath("canvas-workflow-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await page.getByRole("checkbox", { name: "选择方案 最终生产图案", exact: true }).check();
  await page.getByRole("combobox", { name: "筛选方案状态", exact: true }).selectOption("approved");
  const sourceUrl = page.url();
  const openDraft = page.getByRole("button", { name: new RegExp(`打开生产稿.*${name}`) });
  await openDraft.click();
  await expect(page).toHaveURL(sourceUrl);
  const session = page.getByRole("region", { name: "当前任务生产作图" });
  await expect(session.getByRole("heading", { name: "最终生产图案", exact: true })).toBeVisible();
  await expect(session.getByRole("combobox", { name: "打开生产项目" })).toHaveValue(projectId);
  await expect(session.getByRole("combobox", { name: "打开生产项目" }).locator("option")).toHaveCount(2);
  const documentName = session.getByRole("textbox", { name: "图稿名称", exact: true });
  await documentName.fill("Edited in creative workspace");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await session.getByRole("button", { name: "返回当前创意项目" }).click();
  await expect(documentName).toHaveValue("Edited in creative workspace");
  await expect(session).toBeVisible();
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("navigation", { name: "常用任务快捷入口" }).getByRole("link", { name: "导入订单报告" }).click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(session).toBeVisible();
  await session.getByRole("button", { name: "保存新版本", exact: true }).click();
  await expect(session.getByRole("status")).toContainText("已保存版本");
  await page.screenshot({ path: testInfo.outputPath("creative-inline-production-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("creative-inline-production-mobile.png"), fullPage: true });
  await session.getByRole("button", { name: "返回当前创意项目" }).click();
  await expect(page.getByRole("heading", { name: `${name} · 构图定稿`, exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "筛选方案状态", exact: true })).toHaveValue("approved");
  await expect(page.getByRole("checkbox", { name: "选择方案 最终生产图案", exact: true })).toBeChecked();
  await openDraft.click();
  await expect(documentName).toHaveValue("Edited in creative workspace");
  await documentName.fill("Unsaved browser back check");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.goBack();
  await expect(documentName).toHaveValue("Unsaved browser back check");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.goBack();
  await expect(page.getByRole("checkbox", { name: "选择方案 最终生产图案", exact: true })).toBeChecked();
  const draft = await api<ProductionEditorDetailView>(`production-editor/projects/${projectId}`);
  expect(draft.version.document.spec).toEqual(template.version.document.spec);
  expect(draft.version.document.layers).toHaveLength(1); expect(draft.images).toHaveLength(1);
  expect(draft.version.document.confirmations.physicalSize).toBe(false); expect(draft.version.reviewed).toBe(false);
  expect((await api<ProductionEditorDetailView>(`production-editor/projects/${template.project.id}`)).version.document.layers).toEqual([]);
  expect(errors).toEqual([]);
});
