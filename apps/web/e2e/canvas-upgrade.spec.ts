import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { centerApi } from "./order-centers-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

test("v0.18 documents retain original images connections and prompts after editing and export", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const brief = await centerApi<{ id: string }>("canvas-bridge/briefs", {
    requestId: crypto.randomUUID(), name: "QA v0.18 compatibility", prompt: "Synthetic legacy canvas, no provider calls", referenceAssetIds: [],
  });
  const invoke = (input: Record<string, unknown>) => centerApi<Record<string, unknown>>("creative-studio/rpc", { ...input, scope: brief.id });
  const key = `image:legacy-${crypto.randomUUID()}`, original = syntheticProductionPng(2048), now = "2026-09-14T08:00:00.000Z";
  await invoke({ operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: original.toString("base64"), mediaType: "image/png" } });
  // v0.18 persisted shape: document version 0 and export protocol 3. Deliberately
  // has no v0.20 preferences or previews; the original storage key is immutable.
  const legacy = { state: { projects: [{
    id: "legacy-v018", title: "v0.18 historical canvas", createdAt: now, updatedAt: now,
    nodes: [
      { id: "legacy-text", type: "text", title: "Original instruction", position: { x: 350, y: 140 }, width: 280, height: 200, metadata: { content: "Legacy original prompt", prompt: "Preserve this prompt", status: "success" } },
      { id: "legacy-image", type: "image", title: "Original artwork", position: { x: 700, y: 140 }, width: 256, height: 256, metadata: { storageKey: key, content: "blob:previous-session", status: "success", naturalWidth: 2048, naturalHeight: 2048, bytes: original.length, mimeType: "image/png", prompt: "Original generation prompt" } },
    ],
    connections: [{ id: "legacy-reference", fromNodeId: "legacy-text", toNodeId: "legacy-image" }],
    chatSessions: [{ id: "legacy-chat", title: "Generation history", createdAt: now, updatedAt: now, messages: [{ id: "legacy-message", role: "assistant", text: "Original generation history", references: [] }] }],
    activeChatId: "legacy-chat", backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
  }], deletedProjects: [] }, version: 0 };
  await invoke({ operation: "state.set", namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0, value: JSON.stringify(legacy) });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/creative-designs/studio/canvas?brief=${brief.id}`);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator("iframe[title]");
  await frame.getByText("v0.18 historical canvas", { exact: true }).click();
  await expect(frame.locator("[data-node-id]")).toHaveCount(2);
  await expect(frame.getByRole("button", { name: "居中聚焦", exact: true })).toBeVisible();
  const text = frame.locator('[data-node-id="legacy-text"]');
  await text.click();
  await expect(frame.getByRole("button", { name: "居中聚焦", exact: true })).toBeEnabled();
  await frame.getByRole("button", { name: "居中聚焦", exact: true }).click();
  await text.dblclick();
  const saved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && String(response.request().postDataJSON()?.value).includes("Legacy edited safely"));
  await text.locator("textarea").fill("Legacy edited safely");
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await frame.getByRole("heading", { name: "v0.18 historical canvas", exact: true }).click();
  await expect(frame.locator('[data-node-id="legacy-text"]')).toContainText("Legacy edited safely");
  await expect(frame.locator("[data-node-id]")).toHaveCount(2);
  await frame.getByRole("button", { name: "画布菜单", exact: true }).click();
  const downloading = page.waitForEvent("download");
  await frame.getByRole("menuitem", { name: "导出当前画布", exact: true }).click();
  const download = await downloading;
  const zip = await JSZip.loadAsync(await readFile((await download.path())!));
  const exported = JSON.parse(await zip.file("projects.json")!.async("string"));
  expect(exported.version).toBe(3);
  const project = exported.projects[0];
  expect(project.project.nodes).toHaveLength(2);
  expect(project.project.connections).toEqual(legacy.state.projects[0]!.connections);
  expect(project.project.chatSessions).toEqual(legacy.state.projects[0]!.chatSessions);
  expect(project.project.nodes.find((node: { id: string }) => node.id === "legacy-image").metadata.prompt).toBe("Original generation prompt");
  expect(Buffer.from(await zip.file(project.files[0].path)!.async("uint8array"))).toEqual(original);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 390) {
      await expect(frame.getByRole("button", { name: "展开画布面板", exact: true })).toBeVisible();
      await expect(frame.locator(".studio-canvas-side-panel")).toHaveCount(0);
      await frame.getByRole("button", { name: "展开画布面板", exact: true }).click();
      await expect(frame.locator(".studio-canvas-side-panel")).toBeVisible();
      const viewport = await frame.locator(".studio-canvas-project > section").boundingBox();
      const runtime = await page.locator("iframe[title]").boundingBox();
      expect(viewport!.width).toBeGreaterThan(runtime!.width - 5);
      await frame.getByRole("button", { name: "收起画布面板", exact: true }).click();
      await expect(frame.locator(".studio-canvas-side-panel")).toHaveCount(0);
      const toolbar = frame.locator("[data-canvas-bottom-toolbar]");
      const bounds = await toolbar.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(runtime!.x);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(runtime!.x + runtime!.width);
      // Hidden toolbar actions remain reachable by scrolling their own strip.
      await frame.getByRole("button", { name: "上传资产", exact: true }).scrollIntoViewIfNeeded();
      await expect(frame.getByRole("button", { name: "上传资产", exact: true })).toBeInViewport();
    }
    await page.screenshot({ path: testInfo.outputPath(`legacy-canvas-${width}.png`), caret: "initial", animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(frame.getByRole("button", { name: "收起画布面板", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
