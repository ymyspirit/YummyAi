import { expect, test } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import { writeFile } from "node:fs/promises";
import { apiFetch } from "../src/server-api";
import { syntheticProductionPng } from "./production-editor-fixture";
import { createProductionDocument } from "../src/features/production-editor/production-editor-model";

test("contour preview preserves source and version until applied, supports undo, persists geometry and cleans its fixture", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  let projectId = "";
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const fixtureName = `E2E Contour ${createEntityId().slice(-8)}`;
  async function detail() { const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`); expect(response.ok).toBeTruthy(); return await response.json() as ProductionEditorDetailView; }
  try {
    await writeFile(testInfo.outputPath("fixture.json"), JSON.stringify({ fixtureName, deleted: false }));
    const created = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: fixtureName, document: createProductionDocument("shaped_pillow") }), signal: AbortSignal.timeout(20_000) });
    expect(created.ok).toBeTruthy();
    projectId = (await created.json() as ProductionEditorDetailView).project.id;
    await writeFile(testInfo.outputPath("fixture.json"), JSON.stringify({ projectId, fixtureName, deleted: false }));
    await page.setViewportSize({ width: 1600, height: 1050 });
    await page.goto(`/pod-workbench/production-editor?projectId=${projectId}`);
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "synthetic-contour.png", mimeType: "image/png", buffer: syntheticProductionPng(512, true) });
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.locator(".pe-save-state")).not.toHaveClass(/dirty/);
    const original = await detail();
    const image = original.version.document.layers[0]!;
    if (image.kind !== "image") throw new Error("image fixture missing");
    const readSource = async () => { const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}/images/${image.assetId}?kind=original`); expect(response.ok).toBeTruthy(); return Buffer.from(await response.arrayBuffer()); };
    const source = await readSource();
    await page.getByRole("button", { name: "优化工艺轮廓", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "工艺轮廓预览" });
    await expect(dialog.getByRole("button", { name: "应用新刀线" })).toBeDisabled();
    await dialog.getByRole("button", { name: "预览优化效果" }).click();
    await expect(dialog.getByRole("img", { name: "原刀线与优化刀线叠加对比" })).toBeVisible({ timeout: 30_000 });
    expect((await detail()).version.id).toBe(original.version.id);
    await dialog.getByLabel("圆滑余量（px）").fill("30"); await dialog.getByLabel("圆滑余量（px）").blur();
    await expect(dialog.getByRole("button", { name: "应用新刀线" })).toBeDisabled();
    await dialog.getByRole("button", { name: "恢复默认参数" }).click();
    await dialog.getByRole("button", { name: "预览优化效果" }).click();
    await expect(dialog.getByRole("button", { name: "应用新刀线" })).toBeEnabled({ timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("contour-desktop.png") });
    await dialog.getByRole("button", { name: "正反片排版效果" }).click();
    await expect(dialog.getByRole("img", { name: "抱枕正反片实时排版预览" })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await dialog.getByRole("img", { name: "抱枕正反片实时排版预览" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("contour-mobile.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect((await detail()).version.document).toEqual(original.version.document);
    await page.setViewportSize({ width: 1600, height: 1050 });
    await page.getByRole("button", { name: "优化工艺轮廓", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "工艺轮廓预览" });
    await dialog.getByRole("button", { name: "预览优化效果" }).click();
    await expect(dialog.getByRole("button", { name: "应用新刀线" })).toBeEnabled({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "应用新刀线" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".pe-save-state")).toHaveClass(/dirty/);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await expect(page.locator(".pe-save-state")).not.toHaveClass(/dirty/);
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.locator(".pe-save-state")).not.toHaveClass(/dirty/);
    const saved = await detail();
    expect(saved.version.id).not.toBe(original.version.id);
    expect(saved.version.document.contour).not.toEqual(original.version.document.contour);
    expect(saved.version.document.layers[0]).toMatchObject({ assetId: image.assetId, assetVersion: image.assetVersion, widthMm: image.widthMm, heightMm: image.heightMm, rotationDeg: image.rotationDeg, opacity: image.opacity, flipX: image.flipX, flipY: image.flipY });
    expect(saved.version.document).toMatchObject({ spec: { artworkClipMode: "none", panelGapMm: 100 * 25.4 / 150, sheetMarginMm: 50 * 25.4 / 150 }, confirmations: { visualReview: false } });
    expect(saved.images).toEqual(original.images);
    expect(await readSource()).toEqual(source);
    await page.getByRole("button", { name: "优化工艺轮廓", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "工艺轮廓预览" });
    await expect(dialog.getByRole("combobox", { name: "优化方式", exact: true })).toHaveValue("current");
    await dialog.getByRole("button", { name: "预览优化效果" }).click();
    await expect(dialog.getByRole("button", { name: "应用新刀线" })).toBeEnabled({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "应用新刀线" }).press("Control+z");
    await expect(dialog).toBeVisible();
    await dialog.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".pe-save-state")).not.toHaveClass(/dirty/);
    await page.reload();
    await expect(page.getByRole("button", { name: "正反片排版", exact: true })).toBeVisible();
    expect((await detail()).version.document).toEqual(saved.version.document);
    expect(errors).toEqual([]);
  } finally {
    if (!projectId) {
      const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects`, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) projectId = (await response.json() as { projects: { id: string; name: string }[] }).projects.find(project => project.name === fixtureName)?.id ?? "";
    }
    if (projectId) {
      const response = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`, { method: "DELETE" });
      expect(response.ok).toBeTruthy();
      const listed = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects`);
      expect(listed.ok).toBeTruthy();
      expect((await listed.json() as { projects: { id: string }[] }).projects.some(project => project.id === projectId)).toBe(false);
      await writeFile(testInfo.outputPath("fixture.json"), JSON.stringify({ projectId, fixtureName, deleted: true }));
    }
  }
});
