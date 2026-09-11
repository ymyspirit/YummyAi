import { expect, test, type Page } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import type { ChildProcess } from "node:child_process";

import { apiFetch } from "../src/server-api";
import { startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";

let worker: ChildProcess;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(() => { worker?.kill(); });

test("designer tools preserve subject geometry, source identity, history and keyboard boundaries", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  let projectId = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto("/pod-workbench/production-editor?kind=tire_cover");
    await page.getByLabel("新项目名称").fill(`E2E Designer Tools ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((r) => r.url().endsWith("/api/production-editor/projects") && r.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    projectId = ((await (await created).json()) as ProductionEditorDetailView).project.id;
    await number(page, "圆形直径（mm）", "100"); await number(page, "输出 DPI", "72"); await number(page, "安全区内缩（mm）", "5");
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "offset-subject.png", mimeType: "image/png", buffer: syntheticProductionPng(512, true) });
    await expect(page.getByLabel("锁定宽高比例")).toBeChecked();
    await number(page, "图片宽（mm）", "40"); await expect(page.getByLabel("图片高（mm）", { exact: true })).toHaveValue("40");
    await number(page, "位置 X（mm）", "10"); await number(page, "位置 Y（mm）", "20");
    await page.getByRole("button", { name: "水平居中", exact: true }).click();
    await expect.poll(() => value(page, "位置 X（mm）")).toBeGreaterThan(31.8);
    expect(await value(page, "位置 X（mm）")).toBeLessThan(32.2);
    await page.getByRole("button", { name: "垂直居中", exact: true }).click();
    await expect.poll(() => value(page, "位置 Y（mm）")).toBeGreaterThan(29.8);
    const centeredX = await value(page, "位置 X（mm）"), centeredY = await value(page, "位置 Y（mm）");
    await expect(page.getByRole("button", { name: "铺满胎罩背景", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "右转 90°", exact: true }).click();
    await expect(page.getByLabel("旋转角度（°）", { exact: true })).toHaveValue("90");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect.poll(() => value(page, "位置 X（mm）")).toBe(centeredX);
    await expect.poll(() => value(page, "位置 Y（mm）")).toBe(centeredY);
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Control+d");
    await expect(page.locator(".pe-layer-list li")).toHaveCount(2);
    await expect.poll(() => value(page, "位置 X（mm）")).toBeCloseTo(centeredX + 5, 3);
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Shift+ArrowRight");
    await expect.poll(() => value(page, "位置 X（mm）")).toBeCloseTo(centeredX + 15, 3);
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Control+z");
    await expect.poll(() => value(page, "位置 X（mm）")).toBeCloseTo(centeredX + 5, 3);
    await page.getByLabel("图层名称", { exact: true }).press("Control+d");
    await expect(page.locator(".pe-layer-list li")).toHaveCount(2);
    await page.getByRole("button", { name: "锁定 offset-subject.png 副本", exact: true }).click();
    await expect(page.getByRole("button", { name: "删除选中图层", exact: true })).toBeDisabled();
    await expect(page.getByLabel("图片宽（mm）", { exact: true })).toBeDisabled();
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Delete");
    await expect(page.locator(".pe-layer-list li")).toHaveCount(2);
    await page.getByRole("button", { name: "解锁 offset-subject.png 副本", exact: true }).click();
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Delete");
    await expect(page.locator(".pe-layer-list li")).toHaveCount(1);
    await page.getByRole("button", { name: "offset-subject.png", exact: true }).click();
    await page.getByText("替换所选图片", { exact: true }).click();
    await page.getByLabel("上传并替换生产图片", { exact: true }).setInputFiles({ name: "replacement-background.png", mimeType: "image/png", buffer: syntheticProductionPng(512) });
    await expect(page.locator(".pe-layer-list li")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "replacement-background.png", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "铺满胎罩背景", exact: true }).click();
    await expect(page.getByLabel("图片宽（mm）", { exact: true })).toHaveValue("100");
    await expect(page.getByLabel("位置 X（mm）", { exact: true })).toHaveValue("0");
    await page.getByRole("button", { name: "添加文字", exact: true }).click();
    await page.getByLabel("文字内容", { exact: true }).fill("ADVENTURE BEFORE DEMENTIA");
    await page.getByRole("button", { name: "顶部弧形", exact: true }).click();
    await expect(page.getByLabel("弧形半径（mm）", { exact: true })).toBeVisible();
    await number(page, "字号（mm）", "20");
    await page.getByRole("button", { name: "字号适应弧长", exact: true }).click();
    await expect.poll(() => value(page, "字号（mm）")).toBeLessThan(6);
    await page.getByRole("button", { name: "直排文字", exact: true }).click();
    await expect(page.getByLabel("弧形半径（mm）", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "顶部弧形", exact: true }).click();
    await page.locator(".pe-layer-list .selected .pe-layer-name").press("Control+s");
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    const saved = await detail(projectId), sourceLayer = saved.version.document.layers[0]!;
    expect(saved.images).toHaveLength(2); expect(saved.version.document.layers).toHaveLength(2);
    expect(sourceLayer).toMatchObject({ kind: "image", widthMm: 100, heightMm: 100, xMm: 0, yMm: 0 });
    expect(saved.version.document.confirmations.visualReview).toBe(false);
    await page.getByRole("button", { name: "检查生产参数", exact: true }).click();
    await expect(page.locator(".pe-preflight")).toBeVisible();
    await expect(page.locator(".pe-preflight .error")).toHaveCount(0);
    await page.getByRole("button", { name: "生成后台校对预览", exact: true }).click();
    const preview = page.getByRole("img", { name: "当前图稿的后台裁剪轮廓校对预览", exact: true });
    await expect(preview).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "图层", exact: true }).click();
    await page.screenshot({ path: "test-results/designer-tools-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/designer-tools-mobile.png", fullPage: true });
    await page.reload(); await page.getByLabel("打开生产项目", { exact: true }).selectOption(projectId);
    await page.getByRole("button", { name: "replacement-background.png", exact: true }).click();
    await expect(page.getByLabel("图片宽（mm）", { exact: true })).toHaveValue("100");
    await expect(page.getByRole("button", { name: "生成生产文件", exact: true })).toBeDisabled();
    expect((await detail(projectId)).version.document).toEqual(saved.version.document);
    expect(errors).toEqual([]);
  } finally { if (projectId) expect((await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`, { method: "DELETE" })).ok).toBe(true); }
});

async function value(page: Page, label: string) { return Number(await page.getByLabel(label, { exact: true }).inputValue()); }
async function number(page: Page, label: string, n: string) { await page.getByLabel(label, { exact: true }).fill(n); await page.getByLabel(label, { exact: true }).press("Tab"); }
async function detail(projectId: string) { const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`); expect(response.ok).toBe(true); return await response.json() as ProductionEditorDetailView; }
