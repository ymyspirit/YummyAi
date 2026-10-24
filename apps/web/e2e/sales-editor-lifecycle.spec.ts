import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { ProductionEditorDetailView, ProductionEditorRenderView } from "@yummyai/contracts";
import type { SalesRecipeView, ArtworkView } from "@yummyai/contracts/catalog/development";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { roles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { actors, changeErpRights, loginErp } from "./erp-identity-fixture";
import { centerApi } from "./order-centers-fixture";
import { startProductionEditorWorker, syntheticProductionPng } from "./production-editor-fixture";
import { salesLaunchFixture } from "./sales-plan-launch-fixture";

async function editableFixture() {
  const f = await salesLaunchFixture();
  try {
    const source = await centerApi<{ id: string }>("canvas-bridge/briefs", {
      requestId: randomUUID(), name: "Synthetic fixed editor artwork", prompt: "Original synthetic acceptance image", referenceAssetIds: [],
    });
    const creative = await centerApi<{ versionId: string }>(`canvas-bridge/briefs/${source.id}/results`, {
      submissionId: randomUUID(), protocolVersion: CANVAS_BRIDGE.protocolVersion,
      pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: randomUUID(), title: "Synthetic fixed artwork", contentBase64: syntheticProductionPng().toString("base64"),
      rightsAttested: true, sourceKind: "owned", sourceReference: "Disposable native lifecycle fixture",
    });
    await centerApi(`canvas-bridge/briefs/${source.id}/review`, { versionIds: [creative.versionId], decision: "approve" });
    const { artwork } = await centerApi<{ artwork: ArtworkView }>("product-development/artworks", {
      code: `EDITOR-${randomUUID().slice(0, 8)}`, name: "Synthetic fixed lifecycle artwork", mode: "fixed",
      creativeVersionId: creative.versionId, expectedVersion: 0, idempotencyKey: randomUUID(),
    });
    const combined = await centerApi<{ recipes: SalesRecipeView[] }>("product-development/combinations", {
      artworkVersionId: artwork.versionId, items: [{ specificationVersionId: f.spec.versionId, skuCode: `EDITOR-${randomUUID().slice(0, 8)}` }], idempotencyKey: randomUUID(),
    });
    const started = await centerApi<{ recipe: SalesRecipeView }>(`product-development/recipes/${combined.recipes[0]!.id}/actions`, {
      action: "start_adaptation", reason: "Synthetic editable fixed artwork", idempotencyKey: randomUUID(),
    });
    const project = await centerApi<ProductionEditorDetailView>(`production-editor/projects/${started.recipe.editorProjectId}`);
    return { f, project };
  } catch (error) { await f.close(); throw error; }
}

test("catalog editor archival preserves unsaved work and original bytes while ignoring a delayed active response", async ({ page }, info) => {
  test.setTimeout(180000);
  const { f, project } = await editableFixture(), id = project.project.id;
  let worker: Awaited<ReturnType<typeof startProductionEditorWorker>> | undefined;
  let release: (() => void) | undefined;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    worker = await startProductionEditorWorker();
    await loginErp(page, "operator", `/pod-workbench/production-editor?projectId=${id}`);
    await expect(page).toHaveURL(new RegExp(`projectId=${id}`));
    const name = page.getByRole("textbox", { name: "图稿名称", exact: true });
    await expect(name).toHaveValue(project.version.document.name);
    const accepted = page.waitForResponse(r => r.url().endsWith(`/projects/${id}/renders`) && r.request().method() === "POST");
    await page.getByRole("button", { name: "生成后台校对预览", exact: true }).click();
    const render = await (await accepted).json() as ProductionEditorRenderView;
    await expect.poll(async () => (await centerApi<ProductionEditorRenderView>(`production-editor/projects/${id}/renders/${render.id}`)).status).toBe("completed");
    const file = `/api/production-editor/projects/${id}/renders/${render.id}/files/result`;
    const original = await page.request.get(file); expect(original.status()).toBe(200);
    const originalBytes = await original.body();
    await name.fill("Synthetic unsaved catalog artwork");
    let entered!: () => void, delivered!: () => void, onceOnly = true;
    const held = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve), returned = new Promise<void>(resolve => delivered = resolve);
    await page.route(`**/api/production-editor/projects/${id}`, async route => {
      if (!onceOnly) return route.continue();
      onceOnly = false; const response = await route.fetch(); entered(); await held;
      await route.fulfill({ response }).finally(delivered);
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await started;
    await centerApi(`products/plans/${f.spu.productPlanId}/transitions`, { status: "archived" });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const banner = page.getByRole("status").filter({ hasText: "当前制作来源已停止新操作" });
    await expect(banner).toBeVisible(); release(); await returned;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(name).toHaveValue("Synthetic unsaved catalog artwork");
    for (const label of ["保存新版本", "生成后台校对预览", "生成原尺寸待审稿", "生成生产文件"])
      await expect(page.getByRole("button", { name: label, exact: true })).toBeDisabled();
    for (const [path, body] of [
      ["versions", { expectedVersionId: project.version.id, document: project.version.document }],
      ["renders", { expectedVersionId: project.version.id, purpose: "preview", format: "png", background: "transparent" }],
      ["review", { expectedVersionId: project.version.id }],
    ] as const) {
      const denied = await page.request.post(`/api/production-editor/projects/${id}/${path}`, { data: body, headers: { origin: new URL(page.url()).origin } });
      expect(denied.status()).toBe(409); expect(await denied.text()).toContain("来源已变化");
    }
    const retained = await page.request.get(file); expect(retained.status()).toBe(200);
    expect(await retained.body()).toEqual(originalBytes);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 950 }); await banner.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`archived-editor-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    expect(errors).toEqual([]);
  } finally {
    release?.();
    if (worker && worker.exitCode === null) { const exit = once(worker, "exit"); worker.kill(); await exit; }
    await f.close();
  }
});

test("catalog editor read withdrawal clears private artwork and unsaved work before a delayed success returns", async ({ page }) => {
  test.setTimeout(180000);
  const { f, project } = await editableFixture(), id = project.project.id;
  const [role] = await withTenant(f.database.db, f.context, tx => tx.select().from(roles).where(eq(roles.id, actors().operator.roleId)));
  if (!role) { await f.close(); throw Error("Synthetic operator role absent"); }
  let release: (() => void) | undefined;
  try {
    await loginErp(page, "operator", `/pod-workbench/production-editor?projectId=${id}`);
    await expect(page).toHaveURL(new RegExp(`projectId=${id}`));
    const name = page.getByRole("textbox", { name: "图稿名称", exact: true });
    await expect(name).toHaveValue(project.version.document.name); await name.fill("Private unsaved catalog name");
    let entered!: () => void, delivered!: () => void, onceOnly = true;
    const held = new Promise<void>(resolve => release = resolve), started = new Promise<void>(resolve => entered = resolve), returned = new Promise<void>(resolve => delivered = resolve);
    await page.route(`**/api/production-editor/projects/${id}`, async route => {
      if (!onceOnly) return route.continue();
      onceOnly = false; const response = await route.fetch(); entered(); await held; await route.fulfill({ response }).finally(delivered);
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await started;
    await changeErpRights("operator", role.permissions.filter(p => p !== Permission.ProductRead));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("alert").filter({ hasText: /当前账号无法.*制作项目/ })).toBeVisible();
    release(); await returned;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await expect(name).toHaveCount(0);
    await expect(page.getByText("Private unsaved catalog name", { exact: true })).toHaveCount(0);
    await expect(page.locator("canvas")).toHaveCount(0);
    const denied = await page.request.get(`/api/production-editor/projects/${id}`); expect(denied.status()).toBe(404);
  } finally {
    release?.(); await changeErpRights("operator", role.permissions); await f.close();
  }
});
