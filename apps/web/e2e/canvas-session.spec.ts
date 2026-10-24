import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import type { CanvasBrief } from "@yummyai/contracts/pod/canvas-bridge";
import { Permission } from "../../../packages/authz/src/index";
import { centerApi } from "./order-centers-fixture";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { syntheticProductionPng } from "./production-editor-fixture";

test.setTimeout(180_000);
async function seed() {
  const brief = await centerApi<CanvasBrief>("canvas-bridge/briefs", {
    requestId: randomUUID(), name: "Synthetic private access canvas", prompt: "Synthetic access acceptance only", referenceAssetIds: [],
  });
  const key = `image:access-${randomUUID()}`, privateText = `Synthetic private canvas ${randomUUID()}`;
  const rpc = (input: Record<string, unknown>) => centerApi<Record<string, unknown>>("creative-studio/rpc", { ...input, scope: brief.id });
  await rpc({ operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: syntheticProductionPng().toString("base64"), mediaType: "image/png" } });
  const now = new Date().toISOString();
  const document = { state: { projects: [{
    id: "access-canvas", title: "Synthetic access canvas", createdAt: now, updatedAt: now,
    nodes: [
      { id: "access-text", type: "text", title: "Synthetic private note", position: { x: 320, y: 120 }, width: 280, height: 200, metadata: { content: privateText, status: "success" } },
      { id: "access-image", type: "image", title: "Synthetic private image", position: { x: 660, y: 120 }, width: 256, height: 256, metadata: { storageKey: key, content: "blob:previous-session", status: "success", naturalWidth: 512, naturalHeight: 512, mimeType: "image/png" } },
    ],
    connections: [{ id: "access-reference", fromNodeId: "access-text", toNodeId: "access-image" }],
    chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
  }], deletedProjects: [] }, version: 0 };
  await rpc({ operation: "state.set", namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0, value: JSON.stringify(document) });
  return { brief, key, privateText, rpc };
}
async function open(page: Page, brief: CanvasBrief) {
  await page.goto(`/creative-designs/studio/canvas?brief=${brief.id}`);
  await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启", { timeout: 30_000 });
  const frame = page.frameLocator("iframe[title]");
  await frame.getByRole("heading", { name: "Synthetic access canvas", exact: true }).click();
  await expect(frame.locator("[data-node-id]")).toHaveCount(2);
  return frame;
}
const focus = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event("focus")));
async function denied(page: Page) {
  await expect(page.locator(".studio-access-denied")).toContainText("当前创作资料已不可访问");
  await expect(page.locator("iframe[title]")).toHaveCount(0);
  await expect(page.locator(".studio-records")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "创作归属" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "创作归属" })).toContainText("当前创作资料不可访问");
  await expect(page.getByRole("button", { name: "素材与审核", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "生成任务", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem("yummyai.studio.scope"))).toBeNull();
}

test("canvas direct links retain an authorized project omitted from the latest-project projection", async ({ page }) => {
  const input = await seed(), scopes: string[] = [];
  await page.route("**/api/canvas-bridge/projects", async route => {
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const list = await response.json() as Array<{ id: string }>;
    expect(list.some(row => row.id === input.brief.id)).toBe(true);
    // Only the bounded-list omission is controlled. Project/asset reads use real authorization.
    await route.fulfill({ response, json: list.filter(row => row.id !== input.brief.id) });
  });
  page.on("request", request => { if (request.url().endsWith("/api/creative-studio/rpc") && request.method() === "POST") scopes.push(request.postDataJSON().scope); });
  const frame = await open(page, input.brief);
  await expect(page.getByRole("combobox", { name: "创作归属" })).toHaveValue(input.brief.id);
  await expect(frame.locator('[data-node-id="access-text"]')).toContainText(input.privateText);
  expect(scopes.length).toBeGreaterThan(0);
  expect(scopes.every(scope => scope === input.brief.id)).toBe(true);
});

test("canvas access preserves open content on outages and missing media, then clears revoked views and restores saved originals", async ({ page }, info) => {
  const actor = await knowledgeGovernanceFixture(`canvas-access-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [], generations: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/api/creative-studio/rpc") && request.method() === "POST" && request.postDataJSON()?.operation === "generate") generations.push(request.url()); });
  try {
    const input = await seed();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const frame = await open(page, input.brief), source = await page.locator("iframe[title]").getAttribute("src");
    let outage = false, missingMedia = false;
    await page.route("**/api/creative-studio/rpc", async route => {
      const request = route.request().postDataJSON();
      if (outage && request.operation === "state.keys" && request.namespace === "app_state") { await route.fulfill({ status: 503, json: { error: "Synthetic access probe outage" } }); return; }
      if (missingMedia && request.operation === "state.get" && request.namespace === "image_files" && request.key === input.key) { await route.fulfill({ status: 404, json: { error: "Synthetic media unavailable" } }); return; }
      await route.continue();
    });
    outage = true; await focus(page);
    await expect(page.getByText("暂时无法核对创作访问权限", { exact: false })).toBeVisible();
    await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
    await expect(frame.locator('[data-node-id="access-text"]')).toContainText(input.privateText);
    outage = false; await focus(page);
    await expect(page.getByText("暂时无法核对创作访问权限", { exact: false })).toHaveCount(0);
    await page.getByRole("button", { name: "素材与审核", exact: true }).click();
    const records = page.getByRole("region", { name: "素材与审核", exact: true });
    missingMedia = true;
    await records.getByRole("button", { name: "预览", exact: true }).first().click();
    await expect(records.getByRole("alert")).toContainText("Synthetic media unavailable");
    await expect(page.locator("iframe[title]")).toHaveAttribute("src", source!);
    missingMedia = false;
    await records.getByRole("button", { name: "预览", exact: true }).first().click();
    const preview = records.locator(".studio-preview img");
    await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(512);
    const blob = (await preview.getAttribute("src"))!;
    await page.screenshot({ path: info.outputPath("canvas-current-access-desktop.png"), fullPage: true });
    await actor.setPermissions(Object.values(Permission).filter(permission => permission !== Permission.DesignRead));
    const rejected = page.waitForResponse(response => response.url().endsWith("/api/creative-studio/rpc") && response.request().postDataJSON()?.operation === "state.keys" && response.status() === 403);
    await focus(page); await rejected; await denied(page);
    expect(await page.evaluate(async url => { try { await fetch(url); return true; } catch { return false; } }, blob)).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("canvas-revoked-mobile.png"), fullPage: true, animations: "disabled" });
    await actor.setPermissions(Object.values(Permission));
    await page.getByRole("button", { name: "重新核对访问权限", exact: true }).click();
    await expect(page.locator(".studio-save-bar [role=status]")).toHaveText("自动保存已开启", { timeout: 30_000 });
    await page.frameLocator("iframe[title]").getByRole("heading", { name: "Synthetic access canvas", exact: true }).click();
    await expect(page.frameLocator("iframe[title]").locator('[data-node-id="access-text"]')).toContainText(input.privateText);
    expect((await input.rpc({ operation: "state.get", namespace: "app_state", key: "infinite-canvas:canvas_store" })).value).toContain(input.privateText);
    expect(generations).toEqual([]); expect(actor.modelCalls()).toBe(0); expect(errors).toEqual([]);
  } finally { await actor.close(); }
});

test("canvas access discards a real successful media response arriving after permission withdrawal", async ({ page }) => {
  const actor = await knowledgeGovernanceFixture(`canvas-late-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let release!: () => void, received!: () => void, delivered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), fetched = new Promise<void>(resolve => { received = resolve; }), drained = new Promise<void>(resolve => { delivered = resolve; });
  try {
    const input = await seed(); await open(page, input.brief);
    await page.getByRole("button", { name: "素材与审核", exact: true }).click();
    let armed = true;
    await page.route("**/api/creative-studio/rpc", async route => {
      const request = route.request().postDataJSON();
      if (!armed || request.operation !== "state.get" || request.namespace !== "image_files" || request.key !== input.key) { await route.continue(); return; }
      armed = false;
      const response = await route.fetch(); expect(response.ok()).toBe(true); received();
      await held;
      try { await route.fulfill({ response }); } finally { delivered(); }
    });
    await page.getByRole("region", { name: "素材与审核", exact: true }).getByRole("button", { name: "预览", exact: true }).first().click();
    await fetched;
    await actor.setPermissions(Object.values(Permission).filter(permission => permission !== Permission.AssetRead));
    await focus(page); await denied(page);
    release(); await drained;
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await expect(page.locator(".studio-preview")).toHaveCount(0);
    await denied(page);
    expect(errors).toEqual([]);
  } finally { release(); await actor.close(); }
});
