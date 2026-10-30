import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { apiFetch } from "../src/server-api";
import type { CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import { syntheticProductionPng } from "./production-editor-fixture";

async function project() {
  const response = await apiFetch(`${process.env.API_BASE_URL}/v1/canvas-bridge/briefs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: randomUUID(), name: `E2E Studio ${randomUUID().slice(0, 8)}`, prompt: "Synthetic integration fixture, no provider calls", referenceAssetIds: [] }) });
  expect(response.ok).toBe(true); return await response.json() as CanvasBrief;
}
async function open(page: Page, tool: string, brief: CanvasBrief) {
  await page.goto(`/creative-designs/studio/${tool}?brief=${brief.id}`);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible({ timeout: 30_000 });
  return page.frameLocator("iframe[title]");
}
async function navigateModule(page: Page, group: string, title: string) {
  const sidebar = page.locator(".erp-sidebar");
  const toggle = sidebar.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: group, exact: true });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await sidebar.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: title, exact: true }).click();
}
test("ERP reuses the editor across tools and restores the open canvas", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  let modelReads = 0, frameLoads = 0;
  page.on("request", request => { if (request.url().endsWith("/api/creative-studio/rpc") && request.postDataJSON()?.operation === "models") modelReads++; });
  page.on("framenavigated", frame => { if (frame.parentFrame() === page.mainFrame()) frameLoads++; });
  const brief = await project(), frame = await open(page, "canvas", brief), errors: string[] = [];
  const editor = await page.locator("iframe[title]").elementHandle(), source = await page.locator("iframe[title]").getAttribute("src");
  page.on("pageerror", error => errors.push(error.message));
  await expect(page.locator(".erp-sidebar")).toHaveCount(1);
  await expect(frame.getByRole("button", { name: "节点插件", exact: true })).toHaveCount(0);
  const persisted = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && response.request().postDataJSON()?.key === "infinite-canvas:canvas_store");
  await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
  expect((await persisted).ok()).toBe(true);
  await expect(frame.getByRole("button", { name: "上传资产", exact: true })).toBeVisible();
  await expect(frame.getByRole("button", { name: "节点插件", exact: true })).toHaveCount(0);
  await expect(frame.getByRole("button", { name: "Agent", exact: true })).toHaveCount(0);
  const textSaved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && String(response.request().postDataJSON()?.value).includes("ERP roundtrip fixture"));
  await frame.getByRole("button", { name: "文本", exact: true }).click();
  await frame.locator("[data-node-id]").dblclick();
  await frame.locator("[data-node-id] textarea").fill("ERP roundtrip fixture");
  expect((await textSaved).ok()).toBe(true);
  const chooser = page.waitForEvent("filechooser");
  await frame.getByRole("button", { name: "上传资产", exact: true }).click();
  const imageSaved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && String(response.request().postDataJSON()?.value).includes("studio-fixture.png"));
  await (await chooser).setFiles({ name: "studio-fixture.png", mimeType: "image/png", buffer: syntheticProductionPng() });
  expect((await imageSaved).ok()).toBe(true);
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  for (const [tool, title] of [["image", "生图工作台"], ["video", "视频创作台"], ["prompts", "提示词库"], ["assets", "我的资产"], ["canvas", "我的画布"]]) {
    await nav.getByRole("link", { name: title, exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
    if (tool === "image" || tool === "video") {
      await expect(frame.locator(".studio-workbench main textarea").first()).toBeVisible();
    } else {
      await expect(frame.locator(".studio-workbench")).toHaveCount(0);
      if (tool === "prompts") await expect(frame.getByLabel("名称", { exact: true })).toBeVisible();
      if (tool === "assets") await expect.poll(() => frame.getByRole("img", { name: /\.png$/ }).first().evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(240);
    }
  }
  await expect(frame.locator("[data-node-id]").getByText("ERP roundtrip fixture", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "我的资产", exact: true })).toBeVisible();
  await expect(frame.getByRole("img", { name: /\.png$/ }).first()).toBeVisible();
  await page.goForward();
  await expect(frame.locator("[data-node-id]").getByText("ERP roundtrip fixture", { exact: true })).toBeVisible();
  expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
  expect(frameLoads).toBe(1);
  expect(modelReads).toBe(1);
  for (const [group, title, path] of [["订单与履约", "订单中心", "/orders"], ["供应链", "库存台账", "/inventory"], ["研究与经营", "研究资料库", "/research"]]) {
    await navigateModule(page, group, title);
    await expect(page).toHaveURL(url => url.pathname === path);
    await expect(page.locator("[data-studio-session]")).toBeHidden();
    expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
    await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText(title);
    await navigateModule(page, "创作工具", "我的画布");
    await expect(frame.locator("[data-node-id]").getByText("ERP roundtrip fixture", { exact: true })).toBeVisible();
    await expect.poll(() => frame.locator("[data-node-id]").getByRole("img", { name: "studio-fixture.png", exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(512);
    await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
    await expect(page.getByRole("combobox", { name: "创作归属" })).toHaveValue(brief.id);
  }
  expect(frameLoads).toBe(1);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("studio-canvas-after-tool-switch.png") });
  await page.reload();
  await expect(frame.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await expect(frame.getByText("还没有画布", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "创作归属" })).toHaveValue(brief.id);
  await frame.getByRole("heading", { name: "无限画布 1", exact: true }).click();
  await expect(frame.locator("[data-node-id]").getByText("ERP roundtrip fixture", { exact: true })).toBeVisible();
  await expect.poll(() => frame.locator("[data-node-id]").getByRole("img", { name: "studio-fixture.png", exact: true }).evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(512);
  await expect(frame.locator("[data-node-id]")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("studio-canvas-desktop.png") });
  expect(errors).toEqual([]);
});

test("leaving for other modules retains unsaved editor input and refreshes model choices", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "订单中心", level: 1 })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  let refreshed = false;
  await page.route("**/api/creative-studio/rpc", async route => {
    if (route.request().postDataJSON()?.operation === "models") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(refreshed ? [{ id: "00000000-0000-4000-8000-000000000001", label: "QA Refreshed Image", model: "qa-image", capability: "image" }] : []) });
    } else await route.continue();
  });
  const brief = await project(), frame = await open(page, "image", brief);
  const source = await page.locator("iframe[title]").getAttribute("src"), draft = "Unsaved original image prompt retained across ERP modules.";
  await frame.locator("textarea").first().fill(draft);
  await navigateModule(page, "系统配置", "AI 模型配置");
  await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
  await expect(page.locator("[data-studio-session]")).toBeHidden();
  const runtime = await (await page.locator("[data-studio-session] iframe[title]").elementHandle())!.contentFrame();
  // Late editor messages must neither navigate the ERP nor block other modules.
  await runtime!.evaluate(() => {
    const params = new URLSearchParams(location.search), channel = params.get("channel"), origin = params.get("parentOrigin")!;
    parent.postMessage({ type: "studio.route", tool: "video", fromTool: "image", channel }, origin);
    parent.postMessage({ type: "studio.storage", pending: 1, channel }, origin);
  });
  await expect(page.locator(".studio-save-bar [role=status]")).toContainText("正在保存");
  refreshed = true;
  await navigateModule(page, "供应链", "库存台账");
  await expect(page.getByRole("heading", { name: "库存台账", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "生图工作台", exact: true })).toHaveCount(0);
  await runtime!.evaluate(() => { const params = new URLSearchParams(location.search); parent.postMessage({ type: "studio.storage", pending: 0, channel: params.get("channel") }, params.get("parentOrigin")!); });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("studio-hidden-inventory-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  await navigateModule(page, "创作工具", "生图工作台");
  await expect(frame.locator("textarea").first()).toHaveValue(draft);
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
  await frame.getByRole("button", { name: "参数", exact: true }).click();
  await expect(frame.getByText("qa-image（QA Refreshed Image）", { exact: true }).first()).toBeVisible();
  await expect(frame.locator("textarea").first()).toHaveValue(draft);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("studio-restored-draft-desktop.png") });
});

test("tool navigation waits for saving and project changes start an isolated editor", async ({ page }) => {
  test.setTimeout(120_000);
  const brief = await project(), otherBrief = await project(), frame = await open(page, "prompts", brief);
  const source = await page.locator("iframe[title]").getAttribute("src"), name = `Navigation save ${randomUUID().slice(0, 6)}`;
  let releaseSave: () => void = () => {}, heldWrites = 0;
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route("**/api/creative-studio/rpc", async route => {
    const request = route.request().postDataJSON();
    if (request.operation === "state.set" && String(request.value).includes(name)) { heldWrites++; await gate; }
    await route.continue();
  });
  await frame.getByLabel("名称", { exact: true }).fill(name);
  await frame.getByLabel("提示词内容", { exact: true }).fill("Synthetic saved prompt for navigation isolation.");
  await frame.getByRole("button", { name: "保存提示词", exact: true }).click();
  try {
    await expect.poll(() => heldWrites).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: "正在保存" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "创作归属" })).toBeDisabled();
    await page.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "我的资产", exact: true }).click();
    await expect(page.getByRole("heading", { name: "提示词库", exact: true })).toBeVisible();
    await expect(page.locator(".studio-editor .studio-alert")).toContainText("请等待保存完成");
  } finally { releaseSave(); }
  await expect(page.getByRole("heading", { name: "我的资产", exact: true })).toBeVisible();
  await expect(frame.getByText(name, { exact: true }).first()).toBeVisible();
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  await page.getByRole("combobox", { name: "创作归属" }).selectOption(otherBrief.id);
  await expect(page.locator("iframe[title]")).not.toHaveAttribute("src", source!);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  await expect(frame.locator("main")).toBeVisible();
  await expect(frame.getByText(name, { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "创作归属" }).selectOption(brief.id);
  await expect(frame.getByText(name, { exact: true }).first()).toBeVisible();
});
test("saved prompts follow the project across ERP tools and refresh", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const brief = await project(), frame = await open(page, "prompts", brief), name = `Synthetic prompt ${randomUUID().slice(0, 6)}`;
  await frame.getByLabel("名称", { exact: true }).fill(name);
  await frame.getByLabel("提示词内容", { exact: true }).fill("A blue square on a white background; original QA fixture.");
  const saved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && response.request().postDataJSON()?.key === "infinite-canvas:asset_store");
  await frame.getByRole("button", { name: "保存提示词", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(frame.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  const nav = page.getByRole("navigation", { name: "主导航", exact: true });
  await nav.getByRole("link", { name: "我的资产", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "创作归属" })).toHaveValue(brief.id);
  await expect(page.frameLocator("iframe[title]").getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "我的资产", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("studio-assets-mobile.png") });
});
test("temporary project and model outages recover automatically without reloading the editor", async ({ page }, testInfo) => {
  const brief = await project(); let projectsOffline = true, modelsOffline = true, projectReads = 0, modelReads = 0, frameLoads = 0;
  page.on("framenavigated", frame => { if (frame.parentFrame() === page.mainFrame()) frameLoads++; });
  await page.route("**/api/canvas-bridge/projects", async route => {
    projectReads++;
    if (projectsOffline) await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "Synthetic API restart" }) });
    else await route.continue();
  });
  await page.route("**/api/creative-studio/rpc", async route => {
    if (route.request().postDataJSON()?.operation === "models") {
      modelReads++;
      if (modelsOffline) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic model read outage" }) }); return; }
    }
    await route.continue();
  });
  await page.goto(`/creative-designs/studio/image?brief=${brief.id}`);
  await expect(page.getByRole("status").filter({ hasText: "项目暂时无法读取，正在自动恢复" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("studio-read-recovery-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  projectsOffline = false;
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("正在恢复数据读取…");
  // Model recovery is independent from the editable workbench.
  const workbench = page.frameLocator("iframe[title]");
  await workbench.locator("main textarea").first().fill("A draft survives model configuration recovery");
  await expect(workbench.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
  const source = await page.locator("iframe[title]").getAttribute("src");
  modelsOffline = false;
  await expect(page.frameLocator("iframe[title]").locator("main textarea").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启");
  await expect(page.getByRole("combobox", { name: "创作归属" })).toHaveValue(brief.id);
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
  expect(frameLoads).toBe(1); expect(projectReads).toBeGreaterThan(1); expect(modelReads).toBeGreaterThan(1);
  await page.screenshot({ path: testInfo.outputPath("studio-recovered-desktop.png") });
});

test("canvas editing and saving do not wait for slow models and unused tools stay deferred", async ({ page }, testInfo) => {
  const brief = await project();
  let releaseModels!: () => void, modelReturned = false, generationSubmissions = 0;
  const modelsHeld = new Promise<void>(resolve => { releaseModels = resolve; });
  await page.route("**/api/creative-studio/rpc", async route => {
    const operation = route.request().postDataJSON()?.operation;
    if (operation === "generate") generationSubmissions++;
    if (operation !== "models") { await route.continue(); return; }
    await modelsHeld;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "019f7600-0000-7000-8000-000000000199", label: "QA Image Model", model: "qa-image", capability: "image" }]) });
    modelReturned = true;
  });
  try {
    const started = Date.now(), frame = await open(page, "canvas", brief);
    await expect(frame.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
    const libraryReadyMs = Date.now() - started;
    const runtime = await (await page.locator("iframe[title]").elementHandle())!.contentFrame();
    const resources = await runtime!.evaluate(() => performance.getEntriesByType("resource").map(entry => ({ name: new URL(entry.name).pathname, bytes: (entry as PerformanceResourceTiming).decodedBodySize })));
    expect(resources.some(resource => /\/project-[^/]+\.js$/.test(resource.name))).toBe(false);
    expect(resources.some(resource => /\/prompts-page-[^/]+\.js$/.test(resource.name))).toBe(false);
    const saved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && response.request().postDataJSON()?.key === "infinite-canvas:canvas_store");
    await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
    expect((await saved).ok()).toBe(true);
    await expect(frame.getByRole("button", { name: "上传资产", exact: true })).toBeVisible();
    expect(modelReturned).toBe(false);
    const editorReadyMs = Date.now() - started;
    const measurement = testInfo.outputPath("canvas-startup.json");
    await writeFile(measurement, JSON.stringify({ libraryReadyMs, editorReadyMs, modelsStillPending: true, initialRuntimeJsBytes: resources.filter(row => row.name.endsWith(".js")).reduce((sum, row) => sum + row.bytes, 0), resources }, null, 2));
    await testInfo.attach("canvas-startup.json", { path: measurement, contentType: "application/json" });
    await page.getByRole("link", { name: "生图工作台", exact: true }).click();
    await frame.locator("main textarea").first().fill("Editable prompt while model configuration is still pending");
    await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await runtime!.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("studio-model-loading-mobile.png") });
    releaseModels();
    await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeEnabled();
    await expect(frame.locator("main textarea").first()).toHaveValue("Editable prompt while model configuration is still pending");
    expect(generationSubmissions).toBe(0);
  } finally { releaseModels(); }
});

test("asset catalogues load thumbnails and fetch originals only when opened", async ({ page }, testInfo) => {
  const brief = await project(), key = `image:e2e-${randomUUID()}`, title = "Deferred original fixture", bytes = syntheticProductionPng();
  const invoke = async (input: Record<string, unknown>) => {
    const response = await apiFetch(`${process.env.API_BASE_URL}/v1/creative-studio/rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, scope: brief.id }) });
    expect(response.ok).toBe(true); return response.json();
  };
  const uploaded = await invoke({ operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: bytes.toString("base64"), mediaType: "image/png" } });
  const now = new Date().toISOString();
  await invoke({ operation: "state.set", namespace: "app_state", key: "infinite-canvas:asset_store", revision: 0, value: JSON.stringify({ state: { assets: [{ id: uploaded.assetId, kind: "image", title, coverUrl: "blob:old-session", tags: [], createdAt: now, updatedAt: now, data: { storageKey: key, dataUrl: "blob:old-session", width: 512, height: 512, bytes: bytes.length, mimeType: "image/png" } }] }, version: 0 }) });
  let originalReads = 0, previewReads = 0;
  page.on("request", request => {
    if (!request.url().endsWith("/api/creative-studio/rpc")) return;
    const input = request.postDataJSON();
    if (input?.operation === "state.get" && input.namespace === "image_files") originalReads++;
    if (input?.operation === "asset.preview") previewReads++;
  });
  const catalog = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "assets");
  const frame = await open(page, "canvas", brief);
  await catalog;
  await expect(frame.getByRole("button", { name: "新建画布", exact: true }).first()).toBeEnabled();
  expect(originalReads).toBe(0); expect(previewReads).toBe(0);
  await page.getByRole("link", { name: "我的资产", exact: true }).click();
  await expect.poll(() => frame.locator(".studio-asset-thumbnail img").first().evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
  expect(originalReads).toBe(0); expect(previewReads).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("studio-asset-thumbnails-desktop.png") });
  await frame.getByRole("button", { name: /^查\s*看$/ }).click();
  await expect.poll(() => frame.locator(".ant-drawer-body img").first().evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(512);
  expect(originalReads).toBe(1);
});

test("failed hydration resumes the original record without saving an empty replacement", async ({ page }) => {
  const brief = await project(), frame = await open(page, "prompts", brief), name = `Recovery ${randomUUID().slice(0, 6)}`;
  await frame.getByLabel("名称", { exact: true }).fill(name);
  await frame.getByLabel("提示词内容", { exact: true }).fill("Original document must survive a temporary read failure.");
  const saved = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.set" && String(response.request().postDataJSON()?.value).includes(name));
  await frame.getByRole("button", { name: "保存提示词", exact: true }).click();
  expect((await saved).ok()).toBe(true);
  let writes = 0, offline = true;
  await page.route("**/api/creative-studio/rpc", async route => {
    const request = route.request().postDataJSON();
    if (request.operation === "state.set") writes++;
    if (offline && request.operation === "state.get" && request.namespace === "app_state") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic storage outage" }) });
    else await route.continue();
  });
  await page.reload();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("正在恢复数据读取…", { timeout: 30_000 });
  await expect(frame.getByRole("button", { name: "保存提示词", exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  const source = await page.locator("iframe[title]").getAttribute("src");
  offline = false;
  await expect(frame.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启");
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
});

test("canvas autosave reports a rejected write without an uncaught error and retries only on request", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const brief = await project(), frame = await open(page, "canvas", brief);
  let failWrites = true, writes = 0;
  await page.route("**/api/creative-studio/rpc", async route => {
    const input = route.request().postDataJSON();
    if (input.operation === "state.set" && input.key === "infinite-canvas:canvas_store") {
      writes++;
      if (failWrites) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic canvas save outage" }) }); return; }
    }
    await route.continue();
  });
  await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("保存失败 · 当前更改尚未保存");
  await expect(frame.getByRole("button", { name: "文本", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "创作归属" })).toBeDisabled();
  expect(writes).toBe(1);
  expect(errors).toEqual([]);
  const source = await page.locator("iframe[title]").getAttribute("src");
  failWrites = false;
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启");
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
  expect(writes).toBe(2);
  await page.reload();
  await expect(frame.getByRole("heading", { name: "无限画布 1", exact: true })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("a failed save preserves the open draft and needs an explicit save retry", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const brief = await project(), frame = await open(page, "prompts", brief), name = `Unsaved ${randomUUID().slice(0, 6)}`;
  let failWrites = true, writes = 0;
  await page.route("**/api/creative-studio/rpc", async route => {
    const input = route.request().postDataJSON();
    if (input.operation === "state.set" && String(input.value).includes(name)) {
      writes++;
      if (failWrites) { await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Synthetic save outage" }) }); return; }
    }
    await route.continue();
  });
  await frame.getByLabel("名称", { exact: true }).fill(name);
  await frame.getByLabel("提示词内容", { exact: true }).fill("This draft stays in its original editor during a save outage.");
  const source = await page.locator("iframe[title]").getAttribute("src");
  await frame.getByRole("button", { name: "保存提示词", exact: true }).click();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("保存失败 · 当前更改尚未保存");
  await expect(frame.getByLabel("名称", { exact: true })).toHaveValue(name);
  await expect(page.getByRole("combobox", { name: "创作归属" })).toBeDisabled();
  expect(writes).toBe(1);
  failWrites = false;
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启");
  await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
  expect(writes).toBe(2);
  await page.reload();
  await expect(frame.getByRole("button", { name, exact: true })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
test("configuration is an ERP page and rejects cross-origin writes", async ({ page }) => {
  await page.goto("/settings/ai");
  await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
  const workbench = page.getByRole("region", { name: "统一模型配置", exact: true });
  await workbench.getByRole("button", { name: "高级兼容配置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "高级兼容配置工作区", exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="无限画布模型配置"]').getByRole("button", { name: "添加渠道", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".erp-sidebar")).toHaveCount(1);
  await expect(page.locator('iframe[title="无限画布模型配置"]')).toHaveCount(1);
  const response = await page.request.post("/api/creative-studio/rpc", { headers: { origin: "https://untrusted.example" }, data: { operation: "models" } });
  expect(response.status()).toBe(403);
  const configuration = await page.request.post("/api/creative-studio/configuration", { headers: { origin: "https://untrusted.example" }, data: { operation: "configuration.get" } });
  expect(configuration.status()).toBe(403);
});

for (const tool of ["image", "video"]) test(`${tool} workbench renders inside ERP at desktop and mobile widths`, async ({ page }, testInfo) => {
  const brief = await project(), frame = await open(page, tool, brief);
  await expect(frame.locator("main")).toBeVisible();
  await expect(frame.locator("textarea").first()).toBeVisible();
  await expect(frame.getByText("编辑器未能打开。", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath(`studio-${tool}-desktop.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await frame.locator("html").evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`studio-${tool}-mobile.png`) });
});
