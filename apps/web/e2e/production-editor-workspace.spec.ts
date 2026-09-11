import { expect, test, type Page } from "@playwright/test";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import { apiFetch } from "../src/server-api";
import { pngResolution, startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";

let worker: ChildProcess;
test.beforeAll(async () => { worker = await startProductionEditorWorker(); });
test.afterAll(() => { worker?.kill(); });

test("cutout lasso and brushes preserve original pixels and editable source after reopening", async ({ page }) => {
  test.setTimeout(120_000);
  let projectId = "";
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/pod-workbench/production-editor?kind=shaped_pillow");
    await page.getByLabel("新项目名称").fill(`E2E Synthetic Cutout ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((r) => r.url().endsWith("/api/production-editor/projects") && r.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    projectId = ((await (await created).json()) as ProductionEditorDetailView).project.id;
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "synthetic-cutout-source.png", mimeType: "image/png", buffer: syntheticProductionPng() });
    await expect(page.getByRole("button", { name: "抠图与修边", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "抠图与修边", exact: true }).click();
    const editor = page.getByRole("region", { name: "抠图与修边", exact: true });
    const preview = editor.locator("canvas");
    const alpha = (x: number, y: number) => preview.evaluate((node, [x, y]) => [...(node as HTMLCanvasElement).getContext("2d")!.getImageData(x, y, 1, 1).data], [x, y]);
    await expect.poll(() => alpha(256, 256)).toEqual([25, 90, 205, 255]);
    async function clickPoint(x: number, y: number) {
      const region = editor.getByRole("img", { name: "抠图选区操作区域" });
      await region.scrollIntoViewIfNeeded(); const box = (await region.boundingBox())!;
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    }
    await editor.getByRole("button", { name: "套索保留", exact: true }).click();
    for (const [x, y] of [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]) await clickPoint(x, y);
    await editor.getByRole("button", { name: /完成套索/ }).click();
    await expect.poll(async () => (await alpha(10, 10))[3]).toBe(0);
    await editor.getByRole("button", { name: "擦除", exact: true }).click(); await clickPoint(0.5, 0.5);
    await expect.poll(async () => (await alpha(256, 256))[3]).toBe(0);
    await editor.getByRole("button", { name: "恢复", exact: true }).click(); await clickPoint(0.5, 0.5);
    await expect.poll(() => alpha(256, 256)).toEqual([25, 90, 205, 255]);
    await editor.getByRole("button", { name: "撤销抠图步骤" }).click();
    await expect.poll(async () => (await alpha(256, 256))[3]).toBe(0);
    await editor.getByRole("button", { name: "重做抠图步骤" }).click();
    await expect.poll(async () => (await alpha(256, 256))[3]).toBe(255);
    await page.screenshot({ path: "test-results/cutout-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/cutout-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const applied = page.waitForResponse((r) => r.url().endsWith("/cutout") && r.request().method() === "POST");
    await editor.getByRole("button", { name: "应用抠图并返回画布" }).click();
    expect(await (await applied).json()).toMatchObject({ width: 512, height: 512, actualAlpha: true });
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await page.getByRole("button", { name: "抠图与修边", exact: true }).click();
    await expect.poll(async () => (await alpha(10, 10))[3]).toBe(0);
    await editor.getByRole("button", { name: "恢复", exact: true }).click(); await clickPoint(0.1, 0.1);
    await expect.poll(() => alpha(51, 51)).toEqual([225, 90, 80, 255]);
    await editor.getByRole("button", { name: "应用抠图并返回画布" }).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { if (projectId) await eraseProject(projectId); }
});

test("real tire-cover editor uploads, drags, saves, reviews and downloads production artwork", async ({ page }) => {
  test.setTimeout(150_000);
  let projectId = "";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("http://127.0.0.1:3100/pod-workbench/production-editor?kind=tire_cover");
    await expect(page.getByRole("heading", { name: "生产文件与底稿", exact: true })).toBeVisible();
    await page.getByLabel("新项目名称").fill(`E2E Synthetic Tire ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/production-editor/projects") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    const result = await created; expect(result.ok()).toBe(true);
    projectId = ((await result.json()) as ProductionEditorDetailView).project.id;
    await number(page, "圆形直径（mm）", "100");
    await number(page, "输出 DPI", "72");
    await number(page, "安全区内缩（mm）", "5");
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "synthetic-colour-art.png", mimeType: "image/png", buffer: syntheticProductionPng() });
    await expect(page.getByRole("button", { name: "添加 synthetic-colour-art.png 到画布" })).toBeVisible();
    await expect(page.getByLabel("位置 X（mm）", { exact: true })).toBeVisible();
    const before = Number(await page.getByLabel("位置 X（mm）", { exact: true }).inputValue());
    const canvas = page.locator("canvas.upper-canvas");
    await expect(canvas).toBeVisible();
    // The inspector appears before Fabric finishes loading and painting the image.
    // Wait for visible fixture pixels, so a busy parallel run cannot drag an empty canvas.
    await expect.poll(() => page.locator("canvas.lower-canvas").evaluate((element) => {
      const surface = element as HTMLCanvasElement;
      return Array.from(surface.getContext("2d")!.getImageData(Math.floor(surface.width / 2) - 20, Math.floor(surface.height / 2), 1, 1).data);
    })).toEqual([225, 90, 80, 255]);
    await canvas.scrollIntoViewIfNeeded();
    const bounds = await canvas.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width / 2 + 30, bounds!.y + bounds!.height / 2 + 12, { steps: 8 }); await page.mouse.up();
    await expect.poll(async () => Number(await page.getByLabel("位置 X（mm）", { exact: true }).inputValue())).toBeGreaterThan(before);
    await number(page, "位置 X（mm）", "0"); await number(page, "位置 Y（mm）", "0");
    await number(page, "图片宽（mm）", "100"); await number(page, "图片高（mm）", "100");
    await page.getByRole("button", { name: "弧形文字", exact: true }).click();
    await page.getByLabel("文字内容").fill("E2E PRODUCTION");
    await number(page, "字号（mm）", "5");
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    await page.getByRole("button", { name: "生成后台校对预览", exact: true }).click();
    const preview = page.getByRole("img", { name: "当前图稿的后台裁剪轮廓校对预览" });
    await expect(preview).toBeVisible({ timeout: 45_000 });
    await expect.poll(() => preview.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await page.getByRole("tab", { name: "预检确认", exact: true }).click();
    await page.getByLabel("实际尺寸与尺寸口径已由工厂确认").check();
    await page.getByLabel("已查看当前图稿的后台校对预览").check();
    await page.getByRole("button", { name: "检查生产参数", exact: true }).click();
    await expect(page.getByRole("button", { name: "确认当前版本", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "确认当前版本", exact: true }).click();
    await expect(page.getByRole("button", { name: "生成生产文件", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "生成生产文件", exact: true }).click();
    const downloadButton = page.getByRole("button", { name: /^production-.*\.png$/ });
    await expect(downloadButton).toBeVisible({ timeout: 45_000 });
    const downloaded = page.waitForEvent("download"); await downloadButton.click();
    const file = await downloaded; const bytes = await readFile((await file.path())!);
    expect(pngResolution(bytes)).toMatchObject({ width: 283, height: 283 });
    expect(pngResolution(bytes).density).toBeCloseTo(72, 1);
    const alpha = await page.evaluate(async (base64) => {
      const raw = Uint8Array.from(atob(base64), (letter) => letter.charCodeAt(0));
      const picture = await createImageBitmap(new Blob([raw], { type: "image/png" }));
      const target = new OffscreenCanvas(picture.width, picture.height), context = target.getContext("2d")!;
      context.drawImage(picture, 0, 0); return [context.getImageData(0, 0, 1, 1).data[3], context.getImageData(Math.floor(picture.width / 2), Math.floor(picture.height / 2), 1, 1).data[3]];
    }, bytes.toString("base64"));
    expect(alpha).toEqual([0, 255]);
    await page.screenshot({ path: "test-results/production-editor-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("button", { name: "保存新版本", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/production-editor-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { if (projectId) await eraseProject(projectId); }
});

test("pillow editor keeps its contour and missing manufacturing confirmations separate", async ({ page }) => {
  test.setTimeout(90_000);
  let projectId = "";
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/pod-workbench/production-editor?kind=shaped_pillow");
    await page.getByLabel("新项目名称").fill(`E2E Synthetic Pillow ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/production-editor/projects") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    projectId = ((await (await created).json()) as ProductionEditorDetailView).project.id;
    await expect(page.getByLabel("条码框宽（mm）")).toHaveValue("");
    await expect(page.getByLabel("圆形直径（mm）")).toHaveCount(0);
    await page.getByRole("button", { name: "编辑轮廓", exact: true }).click();
    await number(page, "节点 X（mm）", "10");
    await page.getByRole("button", { name: "选择图层工具", exact: true }).click();
    await page.getByRole("button", { name: "添加文字", exact: true }).click();
    await page.getByLabel("文字内容").fill("PILLOW TEST");
    await page.getByRole("button", { name: "检查生产参数", exact: true }).click();
    await expect(page.locator(".pe-preflight li").filter({ hasText: "请填写工厂要求的底部条码矩形宽高。" })).toBeVisible();
    await expect(page.getByRole("button", { name: "生成生产文件", exact: true })).toBeDisabled();
    const stored = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`);
    expect(stored.ok).toBe(true);
    const document = ((await stored.json()) as ProductionEditorDetailView).version.document;
    expect(document.productType).toBe("shaped_pillow"); expect(document.contour[0]!.xMm).toBe(10);
    await page.screenshot({ path: "test-results/production-editor-pillow.png", fullPage: true });
  } finally { if (projectId) await eraseProject(projectId); }
});

async function number(page: Page, label: string, value: string) { await page.getByLabel(label, { exact: true }).fill(value); await page.getByLabel(label, { exact: true }).press("Tab"); }
async function eraseProject(id: string) { const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${id}`, { method: "DELETE" }); expect(response.ok).toBe(true); }

test("pillow cutout uses eight sizes, bottom barcode, live paired view, measurement and real 150-PPI output", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(20_000);
  let projectId = "";
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto("/pod-workbench/production-editor?kind=shaped_pillow");
    await page.getByLabel("新项目名称").fill(`E2E Pillow Cutout ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/production-editor/projects") && response.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    projectId = ((await (await created).json()) as ProductionEditorDetailView).project.id;
    const sizes = page.getByRole("group", { name: "抱枕订单规格", exact: true });
    await expect(sizes.getByRole("button")).toHaveCount(8);
    for (const inches of [10, 12, 14, 16, 18, 20, 22, 24]) {
      const button = sizes.getByRole("button", { name: new RegExp(`^${inches}\\s*in$`) });
      await button.click(); await expect(button).toHaveAttribute("aria-pressed", "true");
    }
    await sizes.getByRole("button", { name: /^10\s*in$/ }).click();
    await expect(page.getByRole("button", { name: "按规格生成抱枕轮廓", exact: true })).toBeDisabled();
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "synthetic-transparent-pillow.png", mimeType: "image/png", buffer: syntheticProductionPng(2400, true) });
    await expect(page.getByRole("button", { name: "按规格生成抱枕轮廓", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "按规格生成抱枕轮廓", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "个节点的抱枕轮廓" })).toBeVisible();
    await page.getByRole("tab", { name: "工艺", exact: true }).click();
    expect(Number(await page.getByLabel("单片轮廓高（mm）", { exact: true }).inputValue())).toBeGreaterThan(320);
    await number(page, "条码框宽（mm）", "35"); await number(page, "条码框高（mm）", "15");
    await page.getByRole("button", { name: "条码移到主体最下方", exact: true }).click();
    await page.getByLabel("最细部位计量口径", { exact: true }).selectOption("cut_contour");
    await page.getByRole("button", { name: "添加文字", exact: true }).click();
    await page.getByLabel("文字内容").fill("READ ME");
    await page.getByLabel("印刷方式", { exact: true }).selectOption("double");
    await page.getByRole("button", { name: "正反片排版", exact: true }).click();
    await expect(page.getByRole("img", { name: "抱枕正反片实时排版预览", exact: true })).toBeVisible();
    await expect(page.locator(".pe-pillow-sheet image")).toHaveCount(2);
    const textPaths = page.locator('.pe-pillow-sheet [data-preview-layer="text"]');
    await expect(textPaths).toHaveCount(2);
    await expect.poll(() => textPaths.first().locator("path").count()).toBeGreaterThan(0);
    expect(await textPaths.first().locator("path").first().getAttribute("d")).toEqual(await textPaths.last().locator("path").first().getAttribute("d"));
    await page.getByRole("group", { name: "界面主题", exact: true }).getByRole("button", { name: "深色", exact: true }).click();
    await page.screenshot({ path: "test-results/pillow-workbench-dark.png", fullPage: true });
    await page.getByRole("group", { name: "界面主题", exact: true }).getByRole("button", { name: "浅色", exact: true }).click();
    await page.getByLabel("印刷方式", { exact: true }).selectOption("single");
    await expect(page.locator(".pe-pillow-sheet image")).toHaveCount(1);
    await page.getByRole("button", { name: "正面编辑", exact: true }).click();
    await page.getByRole("button", { name: "测量细窄处", exact: true }).click();
    const canvas = page.locator("canvas.upper-canvas"); await canvas.scrollIntoViewIfNeeded();
    await expect(page.locator(".pe-measurement")).toContainText("依次点击");
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect(page.locator(".pe-measurement")).toContainText("已选起点");
    await canvas.click({ position: { x: box.width / 2 + 8, y: box.height / 2 } });
    await expect(page.locator(".pe-measurement")).toContainText("低于 5 cm");
    await page.getByRole("button", { name: "放大画布", exact: true }).click();
    await page.getByRole("button", { name: "平移画布", exact: true }).click();
    await canvas.scrollIntoViewIfNeeded();
    const panBox = (await canvas.boundingBox())!;
    await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2); await page.mouse.down();
    await page.mouse.move(panBox.x + panBox.width / 2 + 40, panBox.y + panBox.height / 2 + 15, { steps: 5 }); await page.mouse.up();
    await page.getByRole("button", { name: "适应画布", exact: true }).click();
    await expect(page.locator(".pe-zoom-value")).toHaveText("100%");
    await page.getByRole("button", { name: "生成后台校对预览", exact: true }).click();
    const preview = page.getByRole("img", { name: "当前图稿的后台裁剪轮廓校对预览", exact: true });
    await expect(preview).toBeVisible({ timeout: 45_000 });
    await page.getByRole("tab", { name: "预检确认", exact: true }).click();
    for (const label of ["实际尺寸与尺寸口径已由工厂确认", "白边与黑裁线规则已确认", "已按工厂口径人工检查最细部位", "条码框宽、高、位置已确认", "背片工艺与文字阅读方向已确认", "已查看当前图稿的后台校对预览"]) await page.getByLabel(label, { exact: true }).check();
    await page.getByRole("button", { name: "检查生产参数", exact: true }).click();
    await expect(page.locator(".pe-preflight.ready")).toBeVisible();
    await page.getByRole("button", { name: "确认当前版本", exact: true }).click();
    await page.getByRole("button", { name: "生成生产文件", exact: true }).click();
    const download = page.getByRole("button", { name: /^production-.*\.png$/ }); await expect(download).toBeVisible({ timeout: 45_000 });
    const downloaded = page.waitForEvent("download"); await download.click();
    const bytes = await readFile((await (await downloaded).path())!);
    expect(pngResolution(bytes).density).toBeCloseTo(150, 1);
    expect(pngResolution(bytes).width).toBeGreaterThan(3000);
    const stored = ((await (await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`)).json()) as ProductionEditorDetailView);
    expect(stored.version.document).toMatchObject({ spec: { dpi: 150, declaredLongestMm: 254, whiteBorderMm: 200 * 25.4 / 150, barcodeTab: { widthMm: 35, heightMm: 15 } } });
    expect(stored.version.document.contour.length).toBeGreaterThan(8);
    await page.getByRole("button", { name: "正反片排版", exact: true }).click();
    await page.screenshot({ path: "test-results/pillow-workbench-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 375, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/pillow-workbench-mobile.png", fullPage: true });
    await page.reload();
    await page.getByLabel("打开生产项目", { exact: true }).selectOption(projectId);
    await expect(sizes.getByRole("button", { name: /^10\s*in$/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("条码框宽（mm）", { exact: true })).toHaveValue("35");
    expect(errors).toEqual([]);
  } finally { if (projectId) await eraseProject(projectId); }
});
