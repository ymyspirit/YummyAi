import { test, expect } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView, type ProductionEditorImageView } from "@yummyai/contracts";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { apiFetch } from "../src/server-api";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

test("production delivery preserves separate front/back prints in the editor, sheet and saved versions", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const document = createDefaultProductionDocument("shaped_pillow");
  if (document.productType !== "shaped_pillow") throw new Error("Expected pillow fixture");
  document.name = `Synthetic two-face editor ${createEntityId().slice(-8)}`;
  document.spec = { ...document.spec, widthMm: 200, heightMm: 200, sideMode: "double", artworkClipMode: "none", barcodeTab: { widthMm: null, heightMm: null, centerXMm: 100 } };
  document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 200, yMm: 0, smooth: false }, { xMm: 200, yMm: 200, smooth: false }, { xMm: 0, yMm: 200, smooth: false }];
  let projectId = "";
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    let project = await centerApi<ProductionEditorDetailView>("production-editor/projects", { name: document.name, document });
    projectId = project.project.id;
    const front = await centerApi<ProductionEditorImageView>(`production-editor/projects/${projectId}/images`, { name: "Synthetic front.png", contentBase64: syntheticProductionPng(64).toString("base64") });
    const back = await centerApi<ProductionEditorImageView>(`production-editor/projects/${projectId}/images`, { name: "Synthetic back.png", contentBase64: syntheticProductionPng(128).toString("base64") });
    document.layers = [front, back].map((asset, index) => ({ id: index ? "back-print" : "front-print", kind: "image", name: index ? "Synthetic back" : "Synthetic front", surface: index ? "back" : "front", assetId: asset.id, assetVersion: 1, widthMm: 200, heightMm: 200, xMm: 0, yMm: 0, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: !!index, flipY: false }));
    project = await centerApi(`production-editor/projects/${projectId}/versions`, { expectedVersionId: project.version.id, document });
    const originalVersionId = project.version.id;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/pod-workbench/production-editor?projectId=${projectId}`);
    const canvas = page.locator(".pe-canvas-host canvas.lower-canvas");
    const leftPixel = () => canvas.evaluate(node => {
      const c = node as HTMLCanvasElement, scale = Math.min((c.width - 48) / 200, (c.height - 48) / 200);
      return [...c.getContext("2d")!.getImageData(Math.round((c.width - 200 * scale) / 2 + 50 * scale), Math.round(c.height / 2), 1, 1).data];
    });
    await expect(page.getByRole("button", { name: "正面编辑", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(leftPixel).toEqual([225, 90, 80, 255]);
    await page.getByRole("button", { name: "独立背面编辑", exact: true }).click();
    await expect.poll(leftPixel).toEqual([25, 90, 205, 255]);
    await expect(page.getByRole("button", { name: "编辑轮廓", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "正反片排版", exact: true }).click();
    const sheet = page.getByRole("img", { name: "抱枕正反片实时排版预览", exact: true });
    await expect(sheet.locator('[data-preview-surface="front"] image')).toHaveCount(1);
    await expect(sheet.locator('[data-preview-surface="front"] image')).toHaveAttribute("href", new RegExp(front.id));
    await expect(sheet.locator('[data-preview-surface="back"] image')).toHaveCount(1);
    await expect(sheet.locator('[data-preview-surface="back"] image')).toHaveAttribute("href", new RegExp(back.id));
    await expect(sheet.locator('[data-layer-id="back-print"]')).not.toHaveAttribute("transform", /scale\(-1/);
    await page.screenshot({ path: testInfo.outputPath("two-face-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("two-face-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".pe-layer-name").filter({ hasText: "Synthetic back" }).click();
    await expect(page.getByRole("button", { name: "独立背面编辑", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("图层制作面", { exact: true })).toHaveValue("back");
    await page.getByLabel("位置 X（mm）", { exact: true }).fill("10"); await page.getByLabel("位置 X（mm）", { exact: true }).blur();
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.locator(".pe-save-state")).toContainText("草稿");
    await page.reload(); await page.locator(".pe-layer-name").filter({ hasText: "Synthetic back" }).click();
    await expect(page.getByLabel("位置 X（mm）", { exact: true })).toHaveValue("10");
    const saved = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${projectId}`);
    expect(saved.version.document.layers.map(layer => [layer.surface, layer.xMm])).toEqual([["front", 0], ["back", 10]]);
    const original = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${projectId}?versionId=${originalVersionId}`);
    expect(original.version.document.layers[1]!.xMm).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    if (projectId) { const erased = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`, { method: "DELETE" }); expect(erased.ok).toBe(true); }
  }
});
