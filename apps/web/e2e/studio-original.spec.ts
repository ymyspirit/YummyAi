import { expect, test, type Page } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { StudioOriginalInspectionSchema, StudioResultIntentSchema, studioResultIntentKey, type StudioPinnedResultRequest } from "@yummyai/contracts/pod/studio-original";
import { requireStudioOriginalEnvironment } from "../../../tools/testing/require-studio-original-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, observeOriginal, originalDocument, originalOwnerChild, originalPaidUnchanged, originalProof,
  originalScreenshot, originalSha, OriginalFacts, OriginalSeed } from "./studio-original-helpers.js";

test.setTimeout(240_000);
type Child = ReturnType<typeof originalOwnerChild>;
type Seen = Awaited<ReturnType<typeof observeOriginal>>;
async function current(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json());
  expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  return { context: TenantContextSchema.parse(session), authority: erpSessionAuthority(session) };
}
async function seed(page: Page, child: Child, nonce: string, scenario: "handoff" | "lifecycle") {
  await loginErp(page, "operator", "/navigation"); const identity = await current(page);
  const value = OriginalSeed.parse(await child.rpc("seed", identity.context, scenario)); expect(value.nonce).toBe(nonce); return value;
}
async function open(page: Page, scope: string, tool = "canvas") {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url()); return url.pathname === "/api/creative-studio/workspace" && url.searchParams.get("scope") === scope;
  });
  await page.goto(`/creative-designs/studio/${tool}?brief=${scope}`);
  const response = await pending; expect(response.status()).toBe(200); const workspace = StudioWorkspaceSchema.parse(await response.json());
  expect(workspace.originalHandoffVersion).toBe(1); expect(workspace.generation).toEqual({ enabled: false, code: "operator_paused" });
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  return { frame: page.frameLocator("[data-studio-session] iframe[title]"), workspace };
}
const Canvas = z.object({ id: z.string(), title: z.string(), nodes: z.array(z.object({ id: z.string() }).passthrough()),
  connections: z.array(z.unknown()), viewport: z.object({ x: z.number(), y: z.number(), k: z.number() }) }).passthrough();
function canvases(facts: z.infer<typeof OriginalFacts>) {
  const row = facts.documents.find(value => value.key === "infinite-canvas:canvas_store" && !value.deleted);
  if (!row) throw new Error("studio_original_canvas_document_missing");
  return z.object({ state: z.object({ projects: z.array(Canvas) }).passthrough() }).passthrough().parse(originalDocument(row.value)).state.projects;
}
async function viewport(page: Page) {
  return page.frameLocator("[data-studio-session] iframe[title]").locator(".absolute.origin-top-left").first().evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, k: matrix.a };
  });
}
function sameViewport(actual: { x: number; y: number; k: number }, expected: typeof actual) {
  expect(actual.x).toBeCloseTo(expected.x, 3); expect(actual.y).toBeCloseTo(expected.y, 3); expect(actual.k).toBeCloseTo(expected.k, 3);
}
function verifyNetwork(seen: Seen, allowedFailures: Set<unknown>) {
  expect(seen.rows.every(row => row.valid)).toBe(true); expect(seen.errors).toEqual([]);
  expect(seen.rows.filter(row => row.failed && !allowedFailures.has(row.request))).toEqual([]);
  const expectedAbortCount = seen.rows.filter(row => row.failed && allowedFailures.has(row.request)).length;
  const expectedConsole = seen.consoles.filter(row => row.expectedLoadAbort && row.path === "/api/creative-studio/invoke");
  expect(expectedConsole.length).toBeLessThanOrEqual(expectedAbortCount);
  expect(seen.consoles.filter(row => !expectedConsole.includes(row))).toEqual([]);
}
function safeNetwork(seen: Seen) { return seen.rows.map(({ request: _request, body, key, ...row }) => {
  void _request; return { ...row, keyHash: key ? originalSha(key) : null, submissionId: StudioPersonalInvokeSchema.safeParse(body).success
    && body && typeof body === "object" && "request" in body && body.request && typeof body.request === "object" && "submissionId" in body.request ? body.request.submissionId : null };
}); }
async function networkProof(seen: Seen, proof: Record<string, unknown>) {
  try { await seen.snapshot(); } catch { proof.nativeSnapshotIncomplete = true; }
  proof.phases = [...seen.phases]; proof.reloadBarriers = [...seen.reloadBarriers]; proof.network = safeNetwork(seen); proof.native = seen.nativeDiagnostics();
}

test("c14d7a62_personal_manual_original_dimensions_lost_committed_receipt_refreshes_by_readonly_lookup", async ({ page }, info) => {
  const environment = requireStudioOriginalEnvironment(process.env, true), child = originalOwnerChild(environment.nonce), seen = await observeOriginal(page);
  const proof: Record<string, unknown> = { nonce: environment.nonce, family: "studio_original_c14d7a62", paidExecution: false, cleanupFailed: false };
  let failure: unknown, committedRequest: StudioPinnedResultRequest | undefined, submitted = 0;
  const lost = deferred<void>(), allowedFailures = new Set<unknown>();
  try {
    await seen.markPhase("handoff.seed");
    const basis = await seed(page, child, environment.nonce, "handoff"), before = OriginalFacts.parse(await child.rpc("facts"));
    await seen.markPhase("handoff.open-image");
    const { workspace } = await open(page, basis.scope, "image");
    expect(workspace.capabilities.submit).toBe(true); expect(workspace.capabilities.review).toBe(false);
    await page.getByRole("button", { name: "素材与审核", exact: true }).click();
    const records = page.getByRole("region", { name: "素材与审核", exact: true });
    const originalFacts = records.locator(`[data-studio-original-key="${basis.key}"]`);
    await expect(originalFacts).toContainText("640×360 px"); await expect(originalFacts).toContainText("原图已完整解码");
    await expect(records.getByText(/原件未通过检查/)).toBeVisible(); await expect(records).not.toContainText("0×0");
    await expect(records.getByRole("button", { name: "审核参考素材", exact: true })).toHaveCount(0);
    await records.getByRole("button", { name: "提交项目方案", exact: true }).click();
    await records.getByRole("textbox", { name: "方案名称", exact: true }).fill("Synthetic original manual handoff");
    await records.getByRole("textbox", { name: "素材来源与使用依据", exact: true }).fill("Synthetic owned original fixture c14d7a62");
    await records.getByRole("checkbox", { name: "我已核对素材内容及使用权 可用于当前创作", exact: true }).check();
    await page.route("**/api/creative-studio/invoke", async route => {
      const input = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (!input.success || input.data.request.operation !== "result.submit.pinned" || input.data.request.scope !== basis.scope) { await route.continue(); return; }
      submitted++; expect(submitted).toBe(1); const originalInput = input.data.request; committedRequest = originalInput;
      expect(committedRequest.source).toMatchObject({ assetId: basis.assetId, revision: 1, checksumSha256: basis.checksumSha256,
        byteSize: basis.byteSize, mediaType: "image/png", sourceKind: "owned" });
      const persisted = OriginalFacts.parse(await child.rpc("facts"));
      const intentRow = persisted.documents.find(row => row.key === studioResultIntentKey(originalInput.source));
      expect(intentRow).toBeDefined(); expect(StudioResultIntentSchema.parse(originalDocument(intentRow!.value))).toEqual({ version: 1, status: "prepared", request: originalInput });
      const actual = await route.fetch(); expect(actual.status()).toBe(200); const reply = StudioPersonalReplySchema.parse(await actual.json());
      if (reply.operation !== "result.submit.pinned") throw new Error("studio_original_expected_real_receipt");
      expect(reply.scope).toBe(basis.scope); expect(reply.contextAuthority).toBe(input.data.contextAuthority);
      proof.originalCommit = { httpStatus: actual.status(), receipt: reply.data, bodyHash: originalSha(route.request().postData() ?? "") };
      allowedFailures.add(route.request()); await route.abort("aborted"); lost.resolve();
    });
    await seen.markPhase("handoff.submit-lost-receipt");
    await records.getByRole("button", { name: "保存意图并提交方案", exact: true }).click(); await lost.promise;
    await expect(page.getByText("原提交结果尚未核对", { exact: true })).toBeVisible(); await seen.settle();
    const beforeRefresh = await seen.snapshot();
    expect(beforeRefresh.filter(row => row.operation === "result.submit.pinned")).toHaveLength(1);
    expect(beforeRefresh.find(row => row.operation === "result.submit.pinned")).toMatchObject({ bytes: 0, eof: false, jsonDone: false });
    proof.lostConsumer = beforeRefresh.filter(row => row.operation === "result.submit.pinned").map(({ body: _body, ...row }) => { void _body; return row; });
    const reloadStart = seen.rows.length;
    await seen.beforeReload("handoff.before-reload");
    await page.reload(); await seen.markPhase("handoff.after-reload");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
    await seen.markPhase("handoff.readonly-recovery");
    await page.getByRole("button", { name: "素材与审核", exact: true }).click();
    const intents = page.getByRole("region", { name: "原项目方案送审记录", exact: true });
    await expect(intents.getByText("原方案已提交 审核状态以项目为准", { exact: true })).toBeVisible();
    await expect(intents.getByRole("link", { name: "查看原项目审核", exact: true })).toBeVisible(); await seen.settle();
    expect(submitted).toBe(1); expect(seen.rows.filter(row => row.operation === "result.submit.pinned")).toHaveLength(1);
    const reads = seen.rows.filter(row => row.operation === "result.lookup"); expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) { const input = StudioPersonalInvokeSchema.parse(read.body); expect(input.request).toEqual({ ...committedRequest!, operation: "result.lookup" }); }
    const after = OriginalFacts.parse(await child.rpc("facts")); originalPaidUnchanged(before, after);
    expect(after.candidates.candidates).toHaveLength(1); expect(after.candidates.versions).toHaveLength(1);
    expect(after.candidates.versions[0]!.status).toBe("pending_review");
    expect(after.candidates.assets[0]).toMatchObject({ checksumSha256: basis.checksumSha256, byteSize: basis.byteSize, mediaType: "image/png" });
    expect(after.source).toEqual(before.source);
    const intentKey = studioResultIntentKey(committedRequest!.source);
    expect(seen.rows.slice(reloadStart).filter(row => row.operation === "state.set" && row.key === intentKey)).toEqual([]);
    const recoveredIntent = after.documents.find(row => row.key === intentKey);
    expect(recoveredIntent).toBeDefined(); expect(StudioResultIntentSchema.parse(originalDocument(recoveredIntent!.value)).status).not.toBe("confirmed");
    await seen.markPhase("handoff.explicit-receipt-confirmation");
    await intents.getByRole("button", { name: "保存已找回的原回执", exact: true }).click();
    await expect.poll(async () => {
      const facts = OriginalFacts.parse(await child.rpc("facts")), row = facts.documents.find(value => value.key === intentKey);
      return row ? StudioResultIntentSchema.parse(originalDocument(row.value)).status : "missing";
    }).toBe("confirmed");
    const confirmed = OriginalFacts.parse(await child.rpc("facts")), confirmedRow = confirmed.documents.find(row => row.key === intentKey)!;
    const confirmedIntent = StudioResultIntentSchema.parse(originalDocument(confirmedRow.value));
    expect(confirmedIntent.request).toEqual(committedRequest!); expect(confirmed.candidates).toEqual(after.candidates);
    expect(confirmed.source).toEqual(after.source); expect(submitted).toBe(1);
    expect(seen.rows.filter(row => row.operation === "result.submit.pinned")).toHaveLength(1);
    await records.getByRole("button", { name: "提交项目方案", exact: true }).click();
    await expect(records.getByRole("checkbox", { name: "原方案已提交 以当前输入明确建立一次新送审 保留原记录", exact: true })).toBeVisible();
    await expect(records.getByRole("checkbox", { name: "原方案已提交 以当前输入明确建立一次新送审 保留原记录", exact: true })).not.toBeChecked();
    await records.getByRole("button", { name: "取消", exact: true }).click();
    originalPaidUnchanged(before, confirmed); await seen.settle();
    const images: string[] = [];
    for (const width of [1440, 390]) { await seen.markPhase(`handoff.screenshot-${width}`); await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      await expect(intents.getByText("原方案已提交 审核状态以项目为准", { exact: true })).toBeVisible(); images.push(await originalScreenshot(page, info, "original-handoff-recovered-" + width)); }
    await seen.markPhase("handoff.verify-network"); await seen.settle(); await networkProof(seen, proof);
    verifyNetwork(seen, allowedFailures);
    proof.images = images; proof.result = { source: confirmed.source, candidates: confirmed.candidates, originalSubmitCount: submitted,
      lookupCount: reads.length, explicitReceiptConfirmation: { key: intentKey, revision: confirmedRow.revision, status: confirmedIntent.status },
      explicitNewIntentAvailableWithoutSubmitting: true, paidTablesUnchanged: true };
  } catch (error) { failure = error; proof.primaryFailure = true; await networkProof(seen, proof); }
  finally {
    const cleanup = await child.close(); proof.fixture = cleanup; proof.cleanupFailed = cleanup.failed;
    await originalProof(info, proof); if (cleanup.failed && !failure) failure = new Error("studio_original_browser_fixture_cleanup_failed");
  }
  if (failure) throw failure;
});

test("c14d7a62_nondefault_viewport_and_delayed_A_cannot_write_new_B_across_five_tools_at_1440_and_390", async ({ page }, info) => {
  const environment = requireStudioOriginalEnvironment(process.env, true), child = originalOwnerChild(environment.nonce), seen = await observeOriginal(page);
  const proof: Record<string, unknown> = { nonce: environment.nonce, family: "studio_original_c14d7a62", paidExecution: false, cleanupFailed: false };
  const held = deferred<void>(), fetched = deferred<void>(), drained = deferred<void>(), allowedFailures = new Set<unknown>();
  let failure: unknown, heldOnce = false;
  try {
    await seen.markPhase("lifecycle.seed");
    const basis = await seed(page, child, environment.nonce, "lifecycle"), before = OriginalFacts.parse(await child.rpc("facts"));
    await seen.markPhase("lifecycle.open-A");
    let { frame } = await open(page, basis.scope);
    await frame.getByRole("heading", { name: basis.canvasTitle, exact: true }).click();
    const root = frame.locator(`[data-studio-canvas-id="${basis.canvasId}"]`);
    await expect(root).toHaveAttribute("data-studio-canvas-restored", "true"); sameViewport(await viewport(page), basis.viewport);
    const zoom = frame.getByRole("slider", { name: "放大/缩小画布", exact: true }); await expect(zoom).toHaveValue("65"); await zoom.focus();
    for (let step = 0; step < 4; step++) await zoom.press("ArrowLeft"); await expect(zoom).toHaveValue("61");
    const savedViewport = await viewport(page);
    await expect.poll(async () => {
      const stored = canvases(OriginalFacts.parse(await child.rpc("facts"))).find(canvas => canvas.id === basis.canvasId)?.viewport;
      return !!stored && Math.abs(stored.x - savedViewport.x) < 0.001 && Math.abs(stored.y - savedViewport.y) < 0.001 && Math.abs(stored.k - savedViewport.k) < 0.001;
    }).toBe(true);
    await seen.beforeReload("lifecycle.before-viewport-reload");
    await page.reload(); await seen.markPhase("lifecycle.after-viewport-reload");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
    await seen.markPhase("lifecycle.restored-viewport-A");
    frame = page.frameLocator("[data-studio-session] iframe[title]"); await frame.getByRole("heading", { name: basis.canvasTitle, exact: true }).click();
    await expect(frame.locator(`[data-studio-canvas-id="${basis.canvasId}"]`)).toHaveAttribute("data-studio-canvas-restored", "true");
    sameViewport(await viewport(page), savedViewport); const priorA = canvases(OriginalFacts.parse(await child.rpc("facts"))).find(canvas => canvas.id === basis.canvasId)!;
    await page.route("**/api/creative-studio/invoke", async route => {
      const input = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (heldOnce || !input.success || input.data.request.operation !== "state.get" || input.data.request.scope !== basis.scope
        || input.data.request.namespace !== "image_files" || input.data.request.key !== basis.key) { await route.continue(); return; }
      heldOnce = true; const actual = await route.fetch(); expect(actual.status()).toBe(200); fetched.resolve();
      await held.promise;
      try { await route.fulfill({ response: actual }); }
      catch (error) { if (!/Target page, context or browser has been closed|Route is already handled|net::ERR_ABORTED/.test(error instanceof Error ? error.message : "")) throw error; }
      finally { drained.resolve(); }
    });
    await seen.beforeReload("lifecycle.before-held-A-reload");
    await page.reload(); await seen.markPhase("lifecycle.after-held-A-reload");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
    await seen.markPhase("lifecycle.open-held-A");
    frame = page.frameLocator("[data-studio-session] iframe[title]"); await frame.getByRole("heading", { name: basis.canvasTitle, exact: true }).click(); await fetched.promise;
    const heldRead = [...seen.rows].reverse().find(row => row.operation === "state.get" && row.key === basis.key); expect(heldRead).toBeDefined(); allowedFailures.add(heldRead!.request);
    await seen.markPhase("lifecycle.before-new-B");
    await frame.getByRole("button", { name: "画布菜单", exact: true }).click(); await frame.getByRole("menuitem", { name: "新建画布", exact: true }).click();
    const newRoot = frame.locator("[data-studio-canvas-id]"); await expect(newRoot).toHaveAttribute("data-studio-canvas-restored", "true");
    const bId = await newRoot.getAttribute("data-studio-canvas-id"); expect(bId).not.toBe(basis.canvasId); expect(bId).not.toBeNull();
    await seen.markPhase("lifecycle.after-new-B");
    await expect(frame.locator("[data-node-id]")).toHaveCount(0);
    await frame.getByRole("button", { name: "文本", exact: true }).click(); await frame.locator("[data-node-id]").dblclick();
    const bText = "Synthetic fresh B must never contain A original"; await frame.locator("[data-node-id] textarea").fill(bText);
    await frame.locator("[data-node-id] textarea").press("Escape"); await seen.markPhase("lifecycle.release-late-A"); held.resolve(); await drained.promise; await seen.settle();
    await expect(frame.locator("[data-node-id]")).toHaveCount(1); await expect(frame.locator("[data-node-id]")).toContainText(bText);
    await expect.poll(async () => canvases(OriginalFacts.parse(await child.rpc("facts"))).find(canvas => canvas.id === bId)?.nodes.length).toBe(1);
    const afterSwitch = OriginalFacts.parse(await child.rpc("facts")), nextA = canvases(afterSwitch).find(canvas => canvas.id === basis.canvasId)!;
    expect(nextA.nodes).toEqual(priorA.nodes); expect(nextA.connections).toEqual(priorA.connections); expect(nextA.viewport).toEqual(priorA.viewport);
    const savedB = canvases(afterSwitch).find(canvas => canvas.id === bId)!; expect(JSON.stringify(savedB.nodes)).toContain(bText);
    expect(JSON.stringify(savedB)).not.toContain(basis.text); expect(JSON.stringify(savedB)).not.toContain(basis.key);
    const iframe = page.locator("[data-studio-session] iframe[title]"), original = await iframe.elementHandle(), source = await iframe.getAttribute("src");
    const images: string[] = [], catalogueInspections: Array<{ width: number; namespace: string; keyHash: string; byteSize: number; displayWidth: number; displayHeight: number }> = [];
    const tools = [["canvas", "我的画布"], ["image", "生图工作台"], ["video", "视频创作台"], ["prompts", "提示词库"], ["assets", "我的资产"]] as const;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      for (const [tool, label] of tools) {
        await seen.markPhase(`lifecycle.tools-${width}.${tool}`);
        let navigation = page.locator(".erp-sidebar");
        if (width === 390) { await page.getByRole("button", { name: "打开全部导航", exact: true }).click(); navigation = page.getByRole("dialog", { name: "全部导航", exact: true }); }
        const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
        if (await group.getAttribute("aria-expanded") !== "true") await group.click();
        const inspectionResponse = tool === "assets" ? page.waitForResponse(response => {
          if (new URL(response.url()).pathname !== "/api/creative-studio/invoke") return false;
          const input = StudioPersonalInvokeSchema.safeParse(response.request().postDataJSON());
          return input.success && input.data.request.operation === "asset.inspect" && input.data.request.scope === basis.scope
            && input.data.request.namespace === "image_files" && input.data.request.key === basis.key;
        }) : undefined;
        await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: label, exact: true }).click();
        await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible(); await expect(iframe).toHaveAttribute("src", source!);
        expect(await original!.evaluate(element => element.isConnected)).toBe(true);
        await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(basis.scope);
        await expect(frame.getByRole("status").filter({ hasText: "生成已暂停" })).toBeVisible();
        if (tool === "image" || tool === "video") {
          await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
          const bounds = await frame.locator(".studio-workbench main textarea").first().boundingBox(), outer = await iframe.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(outer!.x); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1);
        }
        if (tool === "canvas") { await expect(frame.locator(`[data-studio-canvas-id="${bId}"]`)).toHaveAttribute("data-studio-canvas-restored", "true");
          await expect(frame.locator("[data-node-id]")).toHaveCount(1); }
        if (tool === "assets") {
          const facts = frame.locator(`[data-studio-original-key="${basis.key}"]`); await facts.scrollIntoViewIfNeeded();
          const response = await inspectionResponse!; expect(response.status()).toBe(200);
          const reply = StudioPersonalReplySchema.parse(await response.json());
          if (reply.operation !== "asset.inspect") throw new Error("studio_original_expected_catalogue_inspection");
          const checked = StudioOriginalInspectionSchema.parse(reply.data);
          expect(checked.source).toMatchObject({ namespace: "image_files", assetId: basis.assetId, byteSize: basis.byteSize, checksumSha256: basis.checksumSha256, mediaType: "image/png" });
          expect(checked.technical).toMatchObject({ status: "verified", kind: "image", displayWidth: 640, displayHeight: 360, validation: "full_static_decode" });
          const size = basis.byteSize < 1024 ? `${basis.byteSize} B` : basis.byteSize < 1024 ** 2 ? `${(basis.byteSize / 1024).toFixed(1)} KiB` : `${(basis.byteSize / 1024 ** 2).toFixed(2)} MiB`;
          await expect(facts).toHaveText(`640×360 px · 原图已完整解码 · ${size}`);
          const preview = frame.locator(".studio-asset-thumbnail img"); await expect(preview).toHaveCount(1); await expect(preview).toBeVisible();
          await expect.poll(() => preview.evaluate(element => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
          await seen.settle(); await seen.markPhase(`lifecycle.tools-${width}.assets-ready`);
          catalogueInspections.push({ width, namespace: "image_files", keyHash: originalSha(basis.key), byteSize: checked.source.byteSize, displayWidth: 640, displayHeight: 360 });
        }
        expect(await frame.locator("body").evaluate(body => Math.max(document.documentElement.scrollWidth, body.scrollWidth) <= innerWidth + 1)).toBe(true);
        images.push(await originalScreenshot(page, info, `original-five-tools-${tool}-${width}`));
      }
    }
    await seen.markPhase("lifecycle.return-to-A-fit-all");
    await page.getByRole("button", { name: "打开全部导航", exact: true }).click();
    await page.getByRole("dialog", { name: "全部导航", exact: true }).getByRole("link", { name: "我的画布", exact: true }).click();
    await frame.getByRole("button", { name: "画布菜单", exact: true }).click(); await frame.getByRole("menuitem", { name: "画布列表", exact: true }).click();
    await frame.getByRole("heading", { name: basis.canvasTitle, exact: true }).click();
    await expect(frame.locator(`[data-studio-canvas-id="${basis.canvasId}"]`)).toHaveAttribute("data-studio-canvas-restored", "true");
    await frame.getByRole("button", { name: "显示全部", exact: true }).click();
    await expect.poll(() => frame.locator("[data-node-id]").evaluateAll(nodes => nodes.length === 2 && nodes.every(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
    }))).toBe(true); images.push(await originalScreenshot(page, info, "original-fit-all-mobile"));
    await seen.markPhase("lifecycle.verify-network"); await seen.settle(); await networkProof(seen, proof);
    const after = OriginalFacts.parse(await child.rpc("facts")); originalPaidUnchanged(before, after);
    expect(after.source).toEqual(before.source); expect(after.candidates.candidates).toHaveLength(0); verifyNetwork(seen, allowedFailures);
    proof.images = images; proof.result = { savedViewport, initialViewport: basis.viewport, heldActualOriginal200: heldOnce,
      sourceAId: basis.canvasId, freshBId: bId, bNodeCount: savedB.nodes.length, paidTablesUnchanged: true, catalogueInspections };
  } catch (error) { failure = error; proof.primaryFailure = true; await networkProof(seen, proof); }
  finally {
    held.resolve(); const cleanup = await child.close(); proof.fixture = cleanup; proof.cleanupFailed = cleanup.failed;
    await originalProof(info, proof); if (cleanup.failed && !failure) failure = new Error("studio_original_browser_fixture_cleanup_failed");
  }
  if (failure) throw failure;
});
