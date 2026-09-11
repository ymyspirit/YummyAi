import { expect, test } from "@playwright/test";
import { createEntityId, type ProductionEditorDetailView } from "@yummyai/contracts";
import { apiFetch } from "../src/server-api";
import { syntheticProductionPng } from "./production-editor-fixture";

test("hair refinement preserves pending work on failure, uses the offline engine, and survives save/reopen", async ({ page }) => {
  test.setTimeout(180_000);
  let projectId = "";
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/pod-workbench/production-editor?kind=shaped_pillow");
    await page.getByLabel("新项目名称").fill(`E2E Hair Refinement ${createEntityId().slice(-8)}`);
    const created = page.waitForResponse((r) => r.url().endsWith("/api/production-editor/projects") && r.request().method() === "POST");
    await page.getByRole("button", { name: "创建生产草稿", exact: true }).click();
    projectId = ((await (await created).json()) as ProductionEditorDetailView).project.id;
    await page.getByLabel("上传生产图片", { exact: true }).setInputFiles({ name: "synthetic-hair-source.png", mimeType: "image/png", buffer: syntheticProductionPng() });
    await page.getByRole("button", { name: "抠图与修边", exact: true }).click();
    const editor = page.getByRole("region", { name: "抠图与修边", exact: true });
    const preview = editor.locator("canvas");
    const alpha = (x: number, y: number) => preview.evaluate((node, [x, y]) => [...(node as HTMLCanvasElement).getContext("2d")!.getImageData(x, y, 1, 1).data], [x, y]);
    await expect.poll(() => alpha(256, 256)).toEqual([25, 90, 205, 255]);
    // A missing model has an explicit UI boundary, never fake inference.
    const unavailable = await editor.getByText("毛发细化服务尚未安装。", { exact: false }).isVisible();
    await expect(editor.getByRole("button", { name: "细化整圈边缘", exact: true })).toBeDisabled(); // no selection yet
    await editor.getByRole("button", { name: "套索保留", exact: true }).click();
    const region = editor.getByRole("img", { name: "抠图选区操作区域" });
    async function clickPoint(x: number, y: number) {
      await region.scrollIntoViewIfNeeded(); const box = (await region.boundingBox())!;
      await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
    }
    for (const [x, y] of [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]) await clickPoint(x, y);
    await editor.getByRole("button", { name: /完成套索/ }).click();
    if (unavailable) {
      await expect(editor.getByRole("button", { name: "毛发修复", exact: true })).toBeDisabled();
      await expect(editor.getByRole("button", { name: "应用抠图并返回画布" })).toBeEnabled();
      return;
    }
    await editor.getByRole("button", { name: "毛发修复", exact: true }).click();
    await clickPoint(0.8, 0.5);
    await expect(editor.getByRole("button", { name: "查看抠图结果", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByRole("button", { name: "应用抠图并返回画布" })).toBeDisabled();
    // Own only this one transport fault; the retry below runs the real API/model.
    await page.route("**/api/production-editor/projects/*/images/*/refine", (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }), { times: 1 });
    await editor.getByRole("button", { name: "细化涂抹区域（1）", exact: true }).click();
    await expect(editor.getByRole("alert")).toContainText("当前修改仍保留");
    await expect(editor.getByRole("button", { name: "细化涂抹区域（1）", exact: true })).toBeEnabled();
    const refined = page.waitForResponse((r) => r.url().endsWith("/refine"), { timeout: 100_000 });
    await editor.getByRole("button", { name: "细化涂抹区域（1）", exact: true }).click();
    const response = await refined; expect(response.ok()).toBe(true);
    expect(await response.json()).toMatchObject({ engine: "vitmatte-small", width: 512, height: 512 });
    await expect(editor.getByRole("status")).toContainText("毛发细化完成");
    await expect.poll(() => alpha(256, 256)).toEqual([25, 90, 205, 255]);
    await expect.poll(async () => (await alpha(10, 10))[3]).toBe(0);
    await editor.getByRole("button", { name: "清理半透明残影", exact: true }).click();
    await page.screenshot({ path: "test-results/hair-refinement-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: "test-results/hair-refinement-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const applied = page.waitForResponse((r) => r.url().endsWith("/cutout") && r.request().method() === "POST");
    await editor.getByRole("button", { name: "应用抠图并返回画布" }).click();
    const copy = await (await applied).json();
    await expect(editor).toHaveCount(0);
    await page.getByRole("button", { name: "保存新版本", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "已保存版本" })).toBeVisible();
    const reopened = page.waitForResponse((r) => r.url().endsWith(`/images/${copy.id}/cutout`) && r.request().method() === "GET");
    await page.getByRole("button", { name: "抠图与修边", exact: true }).click();
    const data = await (await reopened).json();
    expect(data.source.id).not.toBe(copy.id);
    expect(data.recipe.maskPngBase64).toBeTruthy();
    expect(data.recipe.operations).toEqual([{ kind: "clean-alpha", threshold: 0.1 }]);
    await expect.poll(() => alpha(256, 256)).toEqual([25, 90, 205, 255]);
    await editor.getByRole("button", { name: "恢复", exact: true }).click(); await clickPoint(0.1, 0.1);
    await expect.poll(() => alpha(51, 51)).toEqual([225, 90, 80, 255]);
    expect(errors).toEqual([]);
  } finally {
    if (projectId) { const removed = await apiFetch(`${process.env.API_BASE_URL}/v1/production-editor/projects/${projectId}`, { method: "DELETE" }); expect(removed.ok).toBe(true); }
  }
});
