import { expect, test, type TestInfo } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { ProductionEditorDetailViewSchema } from "@yummyai/contracts/pod/production-editor-api";
import { SHAPED_PILLOW_FACTORY_STANDARD } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { apiFetch } from "../src/server-api";
import { loginErp } from "./erp-identity-fixture";

function disposableApi(info?: TestInfo) {
  const database = new URL(process.env.DATABASE_URL ?? "invalid:"),
    api = new URL(process.env.API_BASE_URL ?? "invalid:");
  const token = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(database.pathname)?.[1];
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !token || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${token}` ||
      api.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(api.hostname) || api.port !== "8130" || api.username || api.password)
    throw new Error("Disposable pillow size basis fixture required");
  if (info) {
    const browser = new URL(info.project.use.baseURL ?? "invalid:");
    if (browser.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(browser.hostname) || browser.port !== "3130")
      throw new Error("Isolated personal catalog browser required");
  }
  return api.origin;
}
async function readProject(id: string, versionId?: string) {
  const query = versionId ? "?" + new URLSearchParams({ versionId }) : "";
  const response = await apiFetch(`${disposableApi()}/v1/production-editor/projects/${id}${query}`);
  expect(response.status).toBe(200);
  return ProductionEditorDetailViewSchema.parse(await response.json());
}
async function cleanupProjects(ids: string[], info: TestInfo) {
  const results: Array<{ id: string; deleted: boolean; absent: boolean; error?: string }> = [];
  for (const id of ids) {
    const result = { id, deleted: false, absent: false, error: undefined as string | undefined };
    results.push(result);
    try {
      const response = await apiFetch(`${disposableApi()}/v1/production-editor/projects/${id}`, { method: "DELETE" });
      result.deleted = response.ok; await response.body?.cancel();
      const read = await apiFetch(`${disposableApi()}/v1/production-editor/projects/${id}`);
      result.absent = read.status === 404; await read.body?.cancel();
      if (!result.deleted || !result.absent) result.error = "Supported fixture deletion or detail absence check failed";
    } catch { result.error = "Fixture cleanup could not complete; disposable runner cleanup remains required"; }
  }
  let absentFromList = ids.length === 0;
  if (ids.length) {
    try {
      const response = await apiFetch(`${disposableApi()}/v1/production-editor/projects`);
      if (response.ok) {
        const list = await response.json() as { projects: Array<{ id: string }> };
        absentFromList = ids.every(id => !list.projects.some(project => project.id === id));
      } else await response.body?.cancel();
    } catch { /* Exact IDs remain in the attachment for the disposable runner's final cleanup. */ }
  }
  await info.attach("pillow-size-basis-fixture-cleanup", { contentType: "application/json", body: Buffer.from(JSON.stringify({
    results, absentFromList, immutableAuditHistoryRetainedUntilDisposableDatabaseCleanup: true,
    disposableRunnerFinalCleanupRequired: true,
  })) });
  expect(results.every(result => result.deleted && result.absent && !result.error)).toBe(true);
  expect(absentFromList).toBe(true);
}

// Personal login and real APIs only, inside the disposable catalog runner.
// Empty mechanical drafts need no Worker, uploads, rendering, model calls or approval.
for (const legacy of [false, true]) {
  test(`pillow size basis ${legacy ? "preserves a legacy unpinned cut-contour draft" : "keeps the pinned factory artwork basis after saving and reopening"}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const base = disposableApi(info), ids: string[] = [];
    const mutations: string[] = [];
    page.on("request", request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "POST" && path.startsWith("/api/production-editor/")) mutations.push(path);
    });
    try {
      const draft = createDefaultProductionDocument("shaped_pillow");
      if (draft.productType !== "shaped_pillow") throw new Error("Wrong synthetic product fixture");
      draft.name = `Synthetic pillow size basis ${legacy ? "legacy" : "factory"} ${randomUUID().slice(0, 8)}`;
      draft.spec.declaredLongestMm = 254;
      if (legacy) { draft.spec.factoryStandardId = undefined; draft.spec.sizeBasis = "cut_contour"; }
      const created = await apiFetch(`${base}/v1/production-editor/projects`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ name: draft.name, document: draft }) });
      expect(created.status).toBe(201);
      const original = ProductionEditorDetailViewSchema.parse(await created.json());
      ids.push(original.project.id);
      const id = original.project.id, expectedBasis = legacy ? "cut_contour" : "artwork";
      const path = "/pod-workbench/production-editor?" + new URLSearchParams({ projectId: id });
      expect(original.version.reviewed).toBe(false); expect(original.images).toHaveLength(0); expect(original.renders).toHaveLength(0);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await loginErp(page, "operator", path);
      await page.getByRole("tab", { name: "工艺", exact: true }).click();
      const basis = page.getByRole("combobox", { name: "尺寸口径", exact: true }), size = page.getByRole("spinbutton", { name: "订单标称最长边（mm）", exact: true });
      await expect(basis).toHaveValue(expectedBasis); await expect(size).toHaveValue("254");
      const preset = page.getByRole("group", { name: "抱枕订单规格", exact: true }).getByRole("button", { name: /^16\s*in$/ });
      await preset.click();
      await expect(preset).toHaveAttribute("aria-pressed", "true");
      await expect(size).toHaveValue("406.4"); await expect(basis).toHaveValue(expectedBasis);
      const savedResponse = page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/production-editor/projects/${id}/versions`);
      await page.getByRole("button", { name: "保存新版本", exact: true }).click();
      const response = await savedResponse; expect(response.ok()).toBe(true);
      const saved = ProductionEditorDetailViewSchema.parse(await response.json());
      await expect(page.locator(".pe-save-state")).toContainText("V2 草稿");
      expect(saved.version.versionNumber).toBe(2); expect(saved.version.reviewed).toBe(false);
      expect(saved.images).toHaveLength(0); expect(saved.renders).toHaveLength(0);
      expect(saved.version.document.productType).toBe("shaped_pillow");
      if (saved.version.document.productType !== "shaped_pillow") throw new Error("Wrong saved product fixture");
      expect(saved.version.document.spec).toMatchObject({ declaredLongestMm: 406.4, sizeBasis: expectedBasis });
      expect(saved.version.document.spec.factoryStandardId).toBe(legacy ? undefined : SHAPED_PILLOW_FACTORY_STANDARD.id);
      expect(saved.version.document.layers).toEqual(original.version.document.layers);
      expect(saved.version.document.contour).toEqual(original.version.document.contour);
      expect(Object.values(saved.version.document.confirmations).every(value => value === false)).toBe(true);
      const history = await readProject(id, original.version.id);
      expect(history.version.id).toBe(original.version.id); expect(history.version.document).toEqual(original.version.document);
      await page.reload();
      await page.getByRole("tab", { name: "工艺", exact: true }).click();
      await expect(size).toHaveValue("406.4"); await expect(basis).toHaveValue(expectedBasis);
      expect((await readProject(id)).version.id).toBe(saved.version.id);
      if (!legacy) {
        await page.getByRole("group", { name: "抱枕订单规格", exact: true }).scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("pillow-size-basis-desktop.jpg"), type: "jpeg", fullPage: false });
        await page.setViewportSize({ width: 390, height: 844 });
        await size.scrollIntoViewIfNeeded();
        await expect(size).toHaveValue("406.4"); await expect(basis).toHaveValue("artwork");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: info.outputPath("pillow-size-basis-mobile.jpg"), type: "jpeg", fullPage: false });
      }
      expect(mutations).toEqual([`/api/production-editor/projects/${id}/versions`]);
    } finally { await cleanupProjects(ids, info); }
  });
}
