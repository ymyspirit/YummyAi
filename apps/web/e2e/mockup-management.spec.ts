import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { Permission } from "../../../packages/authz/src/index";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, connectDatabase, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates, creativeDesignVersions,
  creativeDesignSkuBindings, designTasks, designVersions, designVersionFiles, productPlans, spus, skus,
  mockupBatches, mockupBatchItems, mockupBatchOutputs, mockupTemplateSourceInspections, withTenant } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { JobEnvelopeSchema } from "../../../packages/jobs/src/index";
import { MockupTemplateCompileProcessor } from "../../worker/src/processors/pod-batch-workflow.processor";
import { eq } from "drizzle-orm";
import { syntheticProductionPng } from "./production-editor-fixture";
import { getApiHeaders } from "../src/server-api";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { centerApi } from "./order-centers-fixture";

test.setTimeout(180_000);

/** Historical output is synthetic and deliberately has no original completion.
 * Authentication, current membership, template compilation, API, RLS and files are real. */
async function fixture() {
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
    throw new Error("Mockup management browser fixtures require disposable resources");
  const actor = await knowledgeGovernanceFixture(`mockup-${randomUUID().slice(0, 8)}`), database = connectDatabase(), storage = createStorageFromEnvironment();
  try {
    const headers = await getApiHeaders(), claims = JSON.parse(Buffer.from(headers.authorization!.split(".")[1]!, "base64url").toString()) as { sub: string };
    const [identity] = await database.client.unsafe<{ tenant_id: string; user_id: string }[]>(
      "select m.tenant_id,m.user_id from memberships m join app_users u on u.id=m.user_id where u.oidc_subject=$1 and m.status='active'", [claims.sub]);
    if (!identity) throw new Error("Synthetic browser identity unavailable");
    const context: TenantContext = { tenantId: identity.tenant_id, userId: identity.user_id, permissions: Object.values(Permission), dataScope: "tenant" };
    const skuId = createEntityId(), spuId = createEntityId(), planId = createEntityId(), taskId = createEntityId(), designVersionId = createEntityId();
    const creativeBatch = createEntityId(), creativeItem = createEntityId(), candidate = createEntityId(), creativeVersion = createEntityId();
    const artwork = createEntityId(), source = createEntityId(), outputAsset = createEntityId();
    const png = syntheticProductionPng(32);
    const psd = await readFile(new URL("../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
    const files: Array<typeof assetFiles.$inferInsert> = [];
    for (const [id, name, body, mediaType] of [[artwork, "synthetic-production.png", png, "image/png"], [source, "synthetic-controlled.psd", psd, "image/vnd.adobe.photoshop"],
      [outputAsset, "synthetic-historical-output.png", png, "image/png"]] as const) {
      const fileName = `${id}-${name}`;
      const stored = await storage.putPrivate(context, { body, domain: "authorized", fileName, mediaType });
      files.push({ id, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey, checksumSha256: stored.checksumSha256,
        byteSize: body.byteLength, assetDomain: "authorized" as const, fileName, mediaType, rightsStatus: "approved" as const,
        rightsMetadata: { source: { kind: "owned", reference: "Synthetic isolated browser fixture" } } });
    }
    const spec = await centerApi<{ id: string }>("pod/print-specs", { name: "Synthetic browser print specification", aspectWidth: 1, aspectHeight: 1, targetDpi: 300,
      bleedMm: 0, safeZoneMm: 0, wrapMode: "none", physicalSizes: [{ key: "300x300", label: "Synthetic 300 mm", widthMm: 300, heightMm: 300 }] });
    await centerApi(`pod/print-specs/${spec.id}/review`, { decision: "approve" });
    const sha = files[0]!.checksumSha256;
    await withTenant(database.db, context, async tx => {
      await tx.insert(assetFiles).values(files);
      await tx.insert(productPlans).values({ id: planId, tenantId: context.tenantId, name: "Synthetic browser plan", status: "approved", createdBy: context.userId, customization: { version: 1, fields: [] } });
      await tx.insert(spus).values({ id: spuId, tenantId: context.tenantId, productPlanId: planId, code: `SYN-${spuId}`, name: "Synthetic browser product", customization: { version: 1, fields: [] } });
      await tx.insert(skus).values({ id: skuId, tenantId: context.tenantId, spuId, code: `SYN-${skuId}`, attributes: {} });
      await tx.insert(creativeDesignBatches).values({ id: creativeBatch, tenantId: context.tenantId, name: "Synthetic historical artwork", itemCount: 1, status: "completed", generatedCount: 1,
        approvedCount: 1, createdBy: context.userId, requestChecksum: createHash("sha256").update(creativeBatch).digest("hex") });
      await tx.insert(creativeDesignBatchItems).values({ id: creativeItem, tenantId: context.tenantId, batchId: creativeBatch, ordinal: 0, rowKey: "one", name: "Synthetic historical artwork",
        prompt: "Synthetic fixture only", candidateCount: 1, printSpecVersionIds: [spec.id], focalPoint: { xPermille: 500, yPermille: 500 }, status: "completed" });
      await tx.insert(creativeDesignCandidates).values({ id: candidate, tenantId: context.tenantId, itemId: creativeItem, ordinal: 0, status: "selected", assetId: artwork, assetVersion: 1,
        checksumSha256: sha, promptTemplateVersion: "synthetic-history", parameterSnapshot: {}, inputChecksum: sha, completedAt: new Date() });
      await tx.insert(creativeDesignVersions).values({ id: creativeVersion, tenantId: context.tenantId, familyId: createEntityId(), versionNumber: 1, sourceCandidateId: candidate,
        name: "Synthetic historical artwork", status: "approved", createdBy: context.userId });
      await tx.insert(designTasks).values({ id: taskId, tenantId: context.tenantId, skuId, title: "历史套图审核样本", brief: "Synthetic history fixture", status: "approved", createdBy: context.userId });
      await tx.insert(designVersions).values({ id: designVersionId, tenantId: context.tenantId, taskId, versionNumber: 1, status: "approved", createdBy: context.userId });
      await tx.insert(designVersionFiles).values({ id: createEntityId(), tenantId: context.tenantId, versionId: designVersionId, assetFileId: artwork, role: "production" });
      await tx.insert(creativeDesignSkuBindings).values({ id: createEntityId(), tenantId: context.tenantId, creativeDesignVersionId: creativeVersion, printSpecVersionId: spec.id,
        skuId, designTaskId: taskId, designVersionId, createdBy: context.userId });
    });
    const inspection = await centerApi<{ id: string }>("pod/mockup-template-inspections", { sourceAssetId: source, sourceAssetVersion: 1, checksumSha256: files[1]!.checksumSha256, slotKey: "main" });
    await new MockupTemplateCompileProcessor(database, storage).process(JobEnvelopeSchema.parse({ jobId: createEntityId(), tenantId: context.tenantId,
      requestedBy: context.userId, correlationId: inspection.id, idempotencyKey: createEntityId(), payload: { inspectionId: inspection.id } }));
    const compiled = await centerApi<{ reviewFingerprint: string; status: string }>(`pod/mockup-template-inspections/${inspection.id}`);
    expect(compiled.status).toBe("completed");
    await centerApi(`pod/mockup-template-inspections/${inspection.id}/confirm`, { expectedFingerprint: compiled.reviewFingerprint });
    const pack = await centerApi<{ id: string; slots: Array<{ id: string }> }>("pod/mockup-template-packs", { name: "Synthetic browser template pack", platform: "amazon", locale: "en-US", productCategory: "canvas_art",
      slots: [{ slotKey: "main", label: "主图", ordinal: 0, required: true, inspectionId: inspection.id, acceptedPrintSpecVersionIds: [spec.id] }] });
    await centerApi(`pod/mockup-template-packs/${pack.id}/review`, { decision: "approve" });
    const batchId = createEntityId(), itemId = createEntityId(), outputId = createEntityId(), legacyInspectionId = createEntityId();
    await withTenant(database.db, context, async tx => {
      const [original] = await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, inspection.id));
      await tx.insert(mockupTemplateSourceInspections).values({ ...original!, id: legacyInspectionId, slotKey: "legacy", confirmedAt: null, confirmedBy: null,
        compilation: { ...original!.compilation!, slotKey: "legacy" } });
      await tx.insert(mockupBatches).values({ id: batchId, tenantId: context.tenantId, name: "历史套图原交接核验", templatePackVersionId: pack.id, platform: "amazon", locale: "en-US",
        status: "awaiting_review", itemCount: 1, createdBy: context.userId, requestChecksum: createHash("sha256").update(batchId).digest("hex") });
      await tx.insert(mockupBatchItems).values({ id: itemId, tenantId: context.tenantId, batchId, ordinal: 0, designVersionId, skuId, status: "awaiting_review" });
      await tx.update(assetFiles).set({ rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned", reference: "Synthetic historical output" }, derivative: { kind: "controlled_mockup_render" },
        mockupOutputId: outputId, mockupBatchItemId: itemId, designVersionId, templatePackVersionId: pack.id, templateInspectionId: inspection.id } }).where(eq(assetFiles.id, outputAsset));
      await tx.insert(mockupBatchOutputs).values({ id: outputId, tenantId: context.tenantId, itemId, templateSlotId: pack.slots[0]!.id, slotKey: "main", attempt: 1, status: "succeeded",
        assetId: outputAsset, assetVersion: 1, checksumSha256: files[2]!.checksumSha256, width: 32, height: 32, completedAt: new Date(), qualitySnapshot: { syntheticHistoricalResult: true } });
    });
    return { batchId, legacyInspectionId, actor,
      async advance() { await withTenant(database.db, context, tx => tx.update(mockupBatchOutputs).set({ qualitySnapshot: { syntheticHistoricalResult: true, revision: 2 } }).where(eq(mockupBatchOutputs.id, outputId))); },
      async expireSource() { await withTenant(database.db, context, tx => tx.update(assetFiles).set({ rightsMetadata: { source: { kind: "licensed", reference: "Synthetic expired browser license", licenseExpiresAt: "2000-01-01T00:00:00Z" } } }).where(eq(assetFiles.id, source))); },
      async read() { return withTenant(database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, outputAsset))); },
      async close() { try { await actor.close(); } finally { await database.client.end(); } } };
  } catch (error) { await actor.close(); await database.client.end(); throw error; }
}

for (const width of [1365, 390]) test(`mockup review retains the selected basis and blocks historical approval at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const input = await fixture(), errors: string[] = [];
  const scripts = /\/_next\/static\/.*\.js(?:\?.*)?$/;
  let releaseScripts = () => {};
  const gate = new Promise<void>(resolve => { releaseScripts = resolve; });
  if (width === 390) await page.route(scripts, async route => { await gate; await route.continue(); });
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(`/pod-workbench/mockup-batches?batch=${input.batchId}`, { waitUntil: width === 390 ? "commit" : "load" });
    if (width === 390) {
      await expect(page.locator(".pod-batch-workbench")).toHaveAttribute("inert", "");
      await expect(page.locator(".pod-template-console > summary").click({ timeout: 250 })).rejects.toThrow();
      releaseScripts();
    }
    await expect(page.locator(".pod-batch-workbench")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("heading", { name: "历史套图原交接核验" })).toBeVisible();
    const row = page.locator(".pod-matrix-row"), selected = row.locator('input[type="checkbox"]');
    await expect(row.locator("img")).toBeVisible();
    await page.locator(".pod-template-console > summary").click();
    const legacy = page.locator(".pod-template-review").filter({ has: page.locator(`input[name="inspectionId"][value="${input.legacyInspectionId}"]`) });
    await expect(legacy).toContainText("历史编译资料 待核对来源");
    await expect(legacy.locator(".pod-golden-preview")).toBeVisible();
    const preview = legacy.locator(".pod-golden-preview"), confirm = legacy.getByRole("button", { name: "确认编译结果", exact: true });
    await expect.poll(() => preview.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(confirm).toBeEnabled();
    const originalPreview = await preview.getAttribute("src");
    await preview.evaluate(image => { (image as HTMLImageElement).src = "data:image/png;base64,bm90LWEtcG5n"; });
    await expect(confirm).toBeDisabled(); await expect(legacy).toContainText("黄金图读取失败 请刷新后核对");
    await preview.evaluate((image, source) => { (image as HTMLImageElement).src = source!; }, originalPreview);
    await expect(confirm).toBeEnabled();
    await expect(legacy).not.toContainText("黄金图读取失败 请刷新后核对");
    const reason = row.getByPlaceholder("整款驳回原因");
    await reason.fill("Synthetic unsaved rejection reason");
    await selected.check();
    await input.advance();
    await page.getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(page.getByText("所选结果已变化 请取消勾选并重新查看后再批准", { exact: true })).toBeVisible();
    await expect(selected).toBeChecked();
    await expect(reason).toHaveValue("Synthetic unsaved rejection reason");
    await expect(row.getByText("结果已变化 驳回原因已保留")).toBeVisible();
    const approve = page.getByRole("button", { name: "批准所选款式", exact: true });
    await expect(approve).toBeDisabled();
    await selected.uncheck(); await selected.check(); await expect(approve).toBeEnabled(); await approve.click();
    await expect(page.getByText("缺少当前原执行的完整交接证据 请驳回旧结果后重新渲染", { exact: true })).toBeVisible();
    expect((await input.read())[0]!.rightsStatus).toBe("unverified");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: info.outputPath(`mockup-review-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    await input.expireSource();
    await page.getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(page.getByText("原模板当前不可用于新操作 仍可查看有权读取的历史结果")).toBeVisible();
    await expect(row.locator(".pod-mockup-cell img")).toBeVisible();
    await expect(approve).toBeDisabled();
    await input.actor.setPermissions(Object.values(Permission).filter(permission => permission !== Permission.DesignRead));
    await page.getByRole("button", { name: "刷新结果", exact: true }).click();
    await expect(page.getByText(/批量套图控制台读取失败/)).toBeVisible();
    await expect(page.locator(".pod-matrix-row img")).toHaveCount(0);
  } finally { releaseScripts(); await page.unroute(scripts); await input.close(); }
});

test("research and competitor pages retain authenticated loading after route export repair", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/research");
  await expect(page.getByRole("heading", { name: "研究资料库", exact: true })).toBeVisible();
  await expect(page.locator(".empty-library[role=alert]")).toHaveCount(0);
  await page.goto("/competitors");
  await expect(page.getByRole("heading", { name: "竞争店铺雷达", exact: true })).toBeVisible();
  await expect(page.locator(".competitor-error")).toHaveCount(0);
  expect(errors).toEqual([]);
});
