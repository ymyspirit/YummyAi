import { expect, test, type FrameLocator, type Page, type Request, type TestInfo } from "@playwright/test";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_PERSONAL_CLEAR_EVENT, StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { STUDIO_TRANSFER_INTENT_PREFIX, StudioTransferLookupSchema, type StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { requireStudioDocumentTransferEnvironment } from "../../../tools/testing/require-studio-document-transfer-environment.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, observeTransfer, transferArray, transferCanvases, transferDocument, transferNetworkProof, transferObject,
  transferOwnerChild, transferPaidUnchanged, transferProof, transferScreenshot, transferSha, TransferFacts, TransferSeed, verifyTransferNetwork } from "./studio-document-transfer-helpers.js";

test.setTimeout(300_000);
test.beforeEach(async ({ browser }, info) => {
  const actualVersion = browser.version();
  expect(actualVersion).toBe("157.0.8103.6");
  const pin = info.config.metadata.browserLock as { lockSha256?: unknown; executableSha256?: unknown; payloadReceiptSha256?: unknown } | undefined;
  expect(pin?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256);
  expect(pin?.executableSha256).toBe("c86303c78d1333c725f2f57cca3d89a3bbe1d6a0aa4f51c2a3e0ce6c8637322d");
  expect(pin?.payloadReceiptSha256).toBe("5485a838933494f27ca1b542870406e838a93d49ff1f359e42b5cf8017cc14dc");
  const session = await browser.newBrowserCDPSession();
  try {
    const { product, revision } = await session.send("Browser.getVersion");
    expect(product).toBe("HeadlessChrome/157.0.8103.6");
    expect(revision).toMatch(/^@[a-f0-9]{40}$/);
    await info.attach("studio-transfer-actual-browser.json", { contentType: "application/json", body: JSON.stringify({
      actualVersion, product, revision, lockSHA: pin?.lockSha256, exeSHA: pin?.executableSha256, payloadReceiptSHA: pin?.payloadReceiptSha256,
    }) });
  } finally { await session.detach(); }
});
const imageDraftKey = "infinite-canvas:image_draft", videoDraftKey = "infinite-canvas:video_draft";
const tools = [["canvas", "我的画布"], ["image", "生图工作台"], ["video", "视频创作台"], ["prompts", "提示词库"], ["assets", "我的资产"]] as const;
type Child = ReturnType<typeof transferOwnerChild>;
type Seen = Awaited<ReturnType<typeof observeTransfer>>;
const frameFor = (page: Page) => page.frameLocator("[data-studio-session] iframe[title]");
const panelFor = (page: Page) => page.getByRole("dialog", { name: "复制创作资料到项目", exact: true });
async function seed(page: Page, child: Child, nonce: string, scenario: "complete" | "recovery") {
  await loginErp(page, "operator", "/navigation");
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  const value = TransferSeed.parse(await child.rpc("seed", TenantContextSchema.parse(session), scenario)); expect(value.nonce).toBe(nonce);
  return { ...value, authorityHash: transferSha(erpSessionAuthority(session)) };
}
async function facts(child: Child) { return TransferFacts.parse(await child.rpc("facts")); }
async function open(page: Page, scope: string, tool: string = "canvas") {
  const pending = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/creative-studio/workspace" && url.searchParams.get("scope") === scope; });
  await page.goto(`/creative-designs/studio/${tool}?brief=${scope}`);
  const response = await pending; expect(response.status()).toBe(200); const workspace = StudioWorkspaceSchema.parse(await response.json());
  expect(workspace.documentTransferVersion).toBe(1); expect(workspace.generation).toEqual({ enabled: false, code: "operator_paused" });
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); return frameFor(page);
}
async function navigate(page: Page, tool: typeof tools[number][0], seen: Seen, width = 1440) {
  await seen.settle();
  const label = tools.find(item => item[0] === tool)![1]; let navigation = page.locator(".erp-sidebar");
  if (width === 390) { await page.getByRole("button", { name: "打开全部导航", exact: true }).click(); navigation = page.getByRole("dialog", { name: "全部导航", exact: true }); }
  const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
  await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  const frame = frameFor(page);
  if (tool === "image" || tool === "video") {
    // The host title changes before the iframe accepts its new tool. The old
    // tool has the same draft region and must never satisfy this readiness gate.
    // ERP deliberately hides the native main title. Its attached exact text is
    // still the real tool identity; visibility belongs to the draft controls.
    await expect(frame.locator(".studio-workbench main h1")).toHaveText(label);
    await draftReady(frame); await expect(frame.getByRole("combobox", { name: "选择输入草稿", exact: true })).toBeEnabled();
  }
  return frame;
}
async function openPanel(page: Page, targetScope?: string) {
  await page.getByRole("button", { name: "复制创作资料到项目", exact: true }).click(); const panel = panelFor(page); await expect(panel).toBeVisible();
  if (targetScope) await panel.getByRole("textbox", { name: "目标项目链接或 UUID", exact: true }).fill(targetScope); return panel;
}
async function preview(page: Page, targetScope: string) {
  const panel = await openPanel(page, targetScope); await panel.getByRole("button", { name: "保存全部输入并预览", exact: true }).click();
  await expect(panel.getByRole("button", { name: "固定本次复制清单", exact: true })).toBeVisible(); return panel;
}
async function draftReady(frame: FrameLocator) { await expect(frame.getByRole("region", { name: "输入草稿", exact: true })).toContainText("输入自动保存"); }
function exactOriginals(value: TransferFacts) { for (const item of value.originals) { expect(item.actualSha256).toBe(item.checksumSha256); expect(item.actualByteSize).toBe(item.byteSize); } }
async function noOverflow(page: Page, frame: FrameLocator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await frame.locator("body").evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
}
async function viewport(frame: FrameLocator) {
  return frame.locator(".absolute.origin-top-left").first().evaluate(element => { const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: matrix.e, y: matrix.f, k: matrix.a }; });
}
function sameViewport(actual: { x: number; y: number; k: number }, expected: typeof actual) { for (const key of ["x", "y", "k"] as const) expect(actual[key]).toBeCloseTo(expected[key], 3); }
async function selectCopiedDraft(frame: FrameLocator, prompt: string, expectedId: string, seen: Seen) {
  await draftReady(frame); const select = frame.getByRole("combobox", { name: "选择输入草稿", exact: true });
  await expect(select).toBeEnabled(); const imported = select.locator(`option[value="${expectedId}"]`);
  await expect(imported).toHaveCount(1); await expect(imported).toContainText(prompt.slice(0, 40));
  // An explicit new selection cancels the old draft's reference effect. Drain
  // that real body first so the strict unknown-abort gate remains meaningful.
  await seen.settle(); await select.selectOption(expectedId);
  await expect(frame.locator(".studio-workbench main textarea").first()).toHaveValue(prompt); return expectedId;
}
async function historyFrozen(frame: FrameLocator, scope: string, width: number) {
  if (width === 390) await frame.getByRole("button", { name: "生成记录", exact: true }).click();
  await expect(frame.locator('[role="status"]:visible').filter({ hasText: scope }).filter({ hasText: "原任务已冻结 不会自动恢复" }).first()).toBeVisible();
  if (width === 390) await frame.getByRole("dialog", { name: "生成记录", exact: true }).locator(".ant-drawer-close").click();
}
function documentRequests(seen: Seen, start = 0) { return seen.rows.slice(start).filter(row => row.operation?.startsWith("document.")); }
async function failureScreenshot(page: Page, info: TestInfo, proof: Record<string, unknown>) {
  try {
    const path = info.outputPath("transfer-primary-failure.png");
    await page.screenshot({ path, fullPage: false, timeout: 5000 }); proof.failureScreenshot = path;
  } catch { proof.failureScreenshotFailed = true; }
}
function originalInput(request: Request): StudioTransferRequest {
  const packet = StudioPersonalInvokeSchema.parse(request.postDataJSON());
  if (!["document.prepare", "document.commit", "document.lookup", "document.cancel"].includes(packet.request.operation) || !("requestId" in packet.request) || !("manifestHash" in packet.request) || !("targetScope" in packet.request)) throw new Error("studio_transfer_browser_original_input_missing");
  return { scope: packet.request.scope, targetScope: packet.request.targetScope, requestId: packet.request.requestId, manifestHash: packet.request.manifestHash };
}

test("d8b42e71_real_five_tool_drafts_media_chat_viewport_append_nonempty_target_and_remain_independent_at_1440_390", async ({ page }, info) => {
  const environment = requireStudioDocumentTransferEnvironment(process.env, true), child = transferOwnerChild(environment.nonce), seen = await observeTransfer(page);
  const proof: Record<string, unknown> = { family: "studio_transfer_d8b42e71", nonce: environment.nonce, paidExecution: false, cleanupFailed: false };
  const allowedFailures = new Set<Request>(); let failure: unknown;
  try {
    await seen.markPhase("complete.seed"); const basis = await seed(page, child, environment.nonce, "complete"), before = await facts(child); exactOriginals(before);
    await seen.markPhase("complete.source-canvas"); let frame = await open(page, basis.scope); await frame.getByRole("heading", { name: basis.sourceTitle, exact: true }).click();
    await expect(frame.locator(`[data-studio-canvas-id="${basis.canvasId}"]`)).toHaveAttribute("data-studio-canvas-restored", "true"); await expect(frame.locator("[data-node-id]")).toHaveCount(6);
    sameViewport(await viewport(frame), basis.viewport);
    await expect.poll(() => frame.locator('[data-node-id="node-image"] img').first().evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth === 640)).toBe(true);
    await expect.poll(() => frame.locator('[data-node-id="node-video"] video').evaluate(video => video instanceof HTMLVideoElement && video.readyState >= 1 && video.videoWidth > 0)).toBe(true);
    await expect.poll(() => frame.locator('[data-node-id="node-audio"] audio').evaluate(audio => audio instanceof HTMLAudioElement && audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0)).toBe(true);
    const sourceText = "Synthetic A text edited through the real native canvas before transfer";
    await frame.locator('[data-node-id="node-text"]').dblclick(); await frame.locator('[data-node-id="node-text"] textarea').fill(sourceText); await frame.locator('[data-node-id="node-text"] textarea').press("Escape");
    await seen.settle();
    const imagePrompt = "Synthetic UI image draft A before copy image:transfer-main", videoPrompt = "Synthetic UI video draft A before copy canvas-collision";
    await seen.markPhase("complete.source-image-input"); frame = await navigate(page, "image", seen); await draftReady(frame);
    await expect(frame.locator(".studio-workbench main textarea").first()).toHaveValue(basis.imageDraftPrompt);
    await frame.locator(".studio-workbench main textarea").first().fill(imagePrompt); await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
    await seen.markPhase("complete.source-video-input"); frame = await navigate(page, "video", seen); await draftReady(frame);
    await expect(frame.locator(".studio-workbench main textarea").first()).toHaveValue(basis.videoDraftPrompt);
    await frame.locator(".studio-workbench main textarea").first().fill(videoPrompt); await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled(); await seen.settle();
    await seen.markPhase("complete.source-prompt"); frame = await navigate(page, "prompts", seen);
    const promptTitle = "Synthetic browser prompt A", promptText = "Browser owned prompt keeps ordinary node-image image:transfer-main text";
    await frame.getByRole("button", { name: "新建提示词", exact: true }).click(); await frame.getByLabel("名称", { exact: true }).fill(promptTitle);
    await frame.getByRole("textbox", { name: "提示词内容", exact: true }).fill(promptText); await frame.getByRole("button", { name: "保存提示词", exact: true }).click();
    await expect(frame.locator(".prompt-list button").filter({ hasText: promptTitle })).toBeVisible(); await seen.settle();
    await seen.markPhase("complete.source-assets"); frame = await navigate(page, "assets", seen);
    const primaryFacts = frame.locator(`[data-studio-original-key="${basis.media[0]!.key}"]`); await primaryFacts.scrollIntoViewIfNeeded();
    await expect(primaryFacts).toContainText("640×360 px"); await expect.poll(() => frame.getByRole("img", { name: "source asset", exact: true }).evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true); await seen.settle();
    await seen.markPhase("complete.preview-saved-all"); const panel = await preview(page, basis.targetScope); await seen.settle();
    const beforeCopy = await facts(child), sourceImage = transferObject(transferDocument(beforeCopy, "source", imageDraftKey)), sourceVideo = transferObject(transferDocument(beforeCopy, "source", videoDraftKey));
    expect(transferArray(sourceImage.drafts)[0]!.prompt).toBe(imagePrompt); expect(transferArray(sourceVideo.drafts)[0]!.prompt).toBe(videoPrompt);
    expect(transferObject(transferArray(transferCanvases(beforeCopy, "source")[0]!.nodes).find(node => node.id === "node-text")!.metadata).content).toBe(sourceText);
    expect(beforeCopy.target).toEqual(before.target); await panel.getByRole("button", { name: "固定本次复制清单", exact: true }).click();
    await expect(panel).toContainText("清单已固定 尚未追加"); await panel.getByRole("button", { name: "确认追加副本", exact: true }).click();
    await expect(panel.getByRole("link", { name: "打开目标项目副本", exact: true })).toBeVisible(); await seen.settle();
    const committed = await facts(child); expect(committed.source).toEqual(beforeCopy.source); expect(committed.originals).toEqual(beforeCopy.originals);
    expect(committed.transfers).toHaveLength(1); const receipt = committed.transfers[0]!.receipt; if (!receipt) throw new Error("studio_transfer_browser_committed_receipt_missing");
    expect(receipt.counts).toMatchObject({ canvases: 1, prompts: 2, imageDrafts: 1, videoDrafts: 1, history: 2, media: 7 });
    expect(committed.target.entries.some(row => row.key === basis.intentKey)).toBe(false);
    expect(transferCanvases(committed, "target")).toHaveLength(2); expect(transferCanvases(committed, "target")[0]).toEqual(transferCanvases(before, "target")[0]);
    const imported = transferCanvases(committed, "target").find(canvas => canvas.title === basis.sourceTitle)!;
    expect(imported.id).not.toBe(basis.canvasId); expect(imported.viewport).toEqual(transferCanvases(beforeCopy, "source")[0]!.viewport);
    expect(transferArray(imported.chatSessions)[0]!.messages).not.toEqual([]);
    expect(JSON.stringify(transferArray(transferArray(imported.chatSessions)[0]!.messages)[0]!.references)).toContain("data:image/png;base64,");
    expect(transferObject(imported._yummyaiOrigin)).toMatchObject({ sourceScope: basis.scope, requestId: receipt.requestId, executionFrozen: true });
    for (const key of [imageDraftKey, videoDraftKey]) expect(transferObject(transferDocument(committed, "target", key)).activeId).toBe(transferObject(transferDocument(before, "target", key)).activeId);
    await seen.markPhase("complete.open-target"); await panel.getByRole("link", { name: "打开目标项目副本", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(basis.targetScope); frame = frameFor(page);
    await frame.getByRole("heading", { name: basis.sourceTitle, exact: true }).click(); await expect(frame.locator(`[data-studio-canvas-id="${imported.id}"]`)).toHaveAttribute("data-studio-canvas-restored", "true");
    await expect(frame.locator("[data-node-id]")).toHaveCount(6); sameViewport(await viewport(frame), transferObject(imported.viewport) as { x: number; y: number; k: number }); await seen.settle();
    const sourceAfterLeaving = await facts(child);
    await seen.beforeReload("complete.before-target-reload"); await page.reload(); await seen.markPhase("complete.after-target-reload");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); frame = frameFor(page);
    await frame.getByRole("heading", { name: basis.sourceTitle, exact: true }).click(); await expect(frame.locator(`[data-studio-canvas-id="${imported.id}"]`)).toHaveAttribute("data-studio-canvas-restored", "true");
    const copiedText = transferArray(imported.nodes).find(node => node.title === "source text")!, bText = "Synthetic target B edit must never change source A";
    await frame.locator(`[data-node-id="${copiedText.id}"]`).dblclick(); await frame.locator(`[data-node-id="${copiedText.id}"] textarea`).fill(bText); await frame.locator(`[data-node-id="${copiedText.id}"] textarea`).press("Escape");
    const images: string[] = [], chosenDrafts: Record<string, string> = {};
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      for (const [tool] of tools) {
        await seen.markPhase(`complete.target-${width}.${tool}`); frame = await navigate(page, tool, seen, width);
        await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(basis.targetScope);
        if (tool === "canvas") {
          await expect(frame.locator(`[data-studio-canvas-id="${imported.id}"]`)).toHaveAttribute("data-studio-canvas-restored", "true"); await expect(frame.locator(`[data-node-id="${copiedText.id}"]`)).toContainText(bText);
          await expect(frame.locator('[role="status"]:visible').filter({ hasText: basis.scope })).toContainText("原任务已冻结 不会自动恢复");
          if (width === 390) await frame.getByRole("button", { name: "显示全部", exact: true }).click();
        } else if (tool === "image" || tool === "video") {
          const expectedPrompt = tool === "image" ? imagePrompt : videoPrompt;
          const importedDraft = transferArray(transferObject(transferDocument(committed, "target", tool === "image" ? imageDraftKey : videoDraftKey)).drafts)
            .find(draft => draft.prompt === expectedPrompt && transferObject(draft._yummyaiOrigin).requestId === receipt.requestId);
          if (!importedDraft || typeof importedDraft.id !== "string") throw new Error("studio_transfer_browser_committed_draft_missing");
          chosenDrafts[`${tool}-${width}`] = await selectCopiedDraft(frame, expectedPrompt, importedDraft.id, seen);
          await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled(); await historyFrozen(frame, basis.scope, width);
        } else if (tool === "prompts") {
          await frame.locator(".prompt-list button").filter({ hasText: promptTitle }).click(); await expect(frame.getByLabel("名称", { exact: true })).toHaveValue(promptTitle);
          await expect(frame.getByRole("textbox", { name: "提示词内容", exact: true })).toHaveValue(promptText);
        } else {
          await expect(frame.getByText(promptTitle, { exact: true }).first()).toBeVisible(); const importedKey = receipt.entries.find(entry => entry.sourceEntryIds.includes(beforeCopy.source.entries.find(entry => entry.key === basis.media[0]!.key && entry.namespace === "image_files")!.id))!.key;
          const original = frame.locator(`[data-studio-original-key="${importedKey}"]`); await original.scrollIntoViewIfNeeded(); await expect(original).toContainText("640×360 px");
          await expect.poll(() => frame.getByRole("img", { name: "source asset", exact: true }).evaluate(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)).toBe(true);
        }
        await seen.settle(); await noOverflow(page, frame); images.push(await transferScreenshot(page, info, `transfer-${tool}-${width}`));
      }
    }
    await seen.markPhase("complete.verify"); await seen.settle(); const after = await facts(child); exactOriginals(after);
    expect(after.source).toEqual(sourceAfterLeaving.source); expect(after.originals).toEqual(beforeCopy.originals);
    expect(JSON.stringify(transferCanvases(after, "target").find(canvas => canvas.id === imported.id))).toContain(bText);
    expect(JSON.stringify(transferCanvases(after, "source"))).not.toContain(bText);
    expect(seen.rows.filter(row => ["generate", "generation.get", "result.submit", "result.submit.pinned"].includes(row.operation ?? ""))).toEqual([]);
    transferPaidUnchanged(before, after); verifyTransferNetwork(seen, allowedFailures); await transferNetworkProof(seen, proof);
    proof.result = { receipt, sourceBeforeCopyHash: beforeCopy.source.sha256, sourceAfterLeavingHash: sourceAfterLeaving.source.sha256, sourceAfterBEditHash: after.source.sha256,
      originalHashes: after.originals.map(({ assetId: _assetId, ...item }) => { void _assetId; return item; }), chosenDrafts, images, paidTablesUnchanged: true };
  } catch (error) { failure = error; proof.primaryFailure = true; await failureScreenshot(page, info, proof); await transferNetworkProof(seen, proof); }
  finally { const cleanup = await child.close(); proof.fixture = cleanup; proof.cleanupFailed = cleanup.failed; await transferProof(info, proof); if (cleanup.failed && !failure) failure = new Error("studio_transfer_browser_fixture_cleanup_failed"); }
  if (failure) throw failure;
});

test("d8b42e71_real_lost_prepare_commit_reply_reload_lookup_cancel_new_intent_and_logout_CLEAR_rejects_late_original_body", async ({ page }, info) => {
  const environment = requireStudioDocumentTransferEnvironment(process.env, true), child = transferOwnerChild(environment.nonce), seen = await observeTransfer(page);
  const proof: Record<string, unknown> = { family: "studio_transfer_d8b42e71_recovery", nonce: environment.nonce, paidExecution: false, cleanupFailed: false };
  const allowedFailures = new Set<Request>(), release = deferred<void>(), held = deferred<void>(), drained = deferred<void>(); let failure: unknown, terminal = false;
  const lostPrepare = deferred<void>(), lostCommit = deferred<void>(); let prepared: StudioTransferRequest | undefined, committed: StudioTransferRequest | undefined;
  let prepareLosses = 0, commitLosses = 0, holdLookup = false, heldBodyHash = "", heldActualStatus = 0;
  let heldRequest: Request | undefined, heldHostIndex = -1;
  try {
    await seen.markPhase("recovery.seed"); const basis = await seed(page, child, environment.nonce, "recovery"), before = await facts(child);
    await open(page, basis.scope, "image"); await draftReady(frameFor(page)); await seen.settle();
    await page.route("**/api/creative-studio/invoke", async route => {
      const packet = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (!packet.success || packet.data.request.scope !== basis.scope) { await route.continue(); return; }
      const operation = packet.data.request.operation;
      if (operation === "document.prepare" && prepareLosses === 0) {
        prepareLosses++; prepared = originalInput(route.request()); const actual = await route.fetch(); expect(actual.status()).toBe(200);
        const reply = StudioPersonalReplySchema.parse(await actual.json()); if (reply.operation !== "document.prepare") throw new Error("studio_transfer_browser_real_prepare_missing");
        expect(StudioTransferLookupSchema.parse(reply.data)).toEqual({ status: "prepared", request: prepared, receipt: null });
        proof.lostPrepare = { request: prepared, actualStatus: actual.status(), bodyHash: transferSha(route.request().postData() ?? "") };
        allowedFailures.add(route.request()); await route.abort("aborted"); lostPrepare.resolve(); return;
      }
      if (operation === "document.commit" && commitLosses === 0) {
        commitLosses++; committed = originalInput(route.request()); const actual = await route.fetch(); expect(actual.status()).toBe(200);
        const reply = StudioPersonalReplySchema.parse(await actual.json()); if (reply.operation !== "document.commit") throw new Error("studio_transfer_browser_real_commit_missing");
        const result = StudioTransferLookupSchema.parse(reply.data); expect(result.status).toBe("committed"); expect(result.request).toEqual(committed);
        proof.lostCommit = { request: committed, actualStatus: actual.status(), receipt: result.receipt, bodyHash: transferSha(route.request().postData() ?? "") };
        allowedFailures.add(route.request()); await route.abort("aborted"); lostCommit.resolve(); return;
      }
      if (operation === "document.lookup" && holdLookup && committed && "requestId" in packet.data.request && packet.data.request.requestId === committed.requestId) {
        holdLookup = false; heldRequest = route.request(); heldBodyHash = transferSha(heldRequest.postData() ?? ""); allowedFailures.add(heldRequest);
        const host = seen.rows.find(row => row.request === heldRequest); if (!host) throw new Error("studio_transfer_browser_held_host_request_missing"); heldHostIndex = host.index;
        const actual = await route.fetch(); heldActualStatus = actual.status(); expect(heldActualStatus).toBe(200);
        const reply = StudioPersonalReplySchema.parse(await actual.json()); if (reply.operation !== "document.lookup") throw new Error("studio_transfer_browser_real_lookup_missing");
        expect(StudioTransferLookupSchema.parse(reply.data).status).toBe("committed"); held.resolve(); await release.promise;
        try { await route.fulfill({ response: actual }); proof.heldDelivery = "original_response_released"; }
        catch { if (!terminal) throw new Error("studio_transfer_browser_late_release_failed"); proof.heldDelivery = "original_request_already_aborted_after_CLEAR"; }
        drained.resolve(); return;
      }
      await route.continue();
    });
    await seen.markPhase("recovery.lose-prepare"); let panel = await preview(page, basis.targetScope);
    await panel.getByRole("button", { name: "固定本次复制清单", exact: true }).click(); await lostPrepare.promise;
    await expect(panel).toContainText("原结果尚未核对"); await seen.settle(); expect(prepareLosses).toBe(1);
    expect(seen.rows.filter(row => row.operation === "document.prepare")).toHaveLength(1); expect(await facts(child).then(value => value.target)).toEqual(before.target);
    const firstReload = seen.rows.length; await seen.beforeReload("recovery.before-prepare-reload"); await page.reload(); await seen.markPhase("recovery.after-prepare-reload");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); panel = await openPanel(page); await expect(panel).toContainText("清单已固定 尚未追加"); await seen.settle();
    const prepareRecovery = documentRequests(seen, firstReload); expect(prepareRecovery.length).toBeGreaterThan(0);
    expect(prepareRecovery.every(row => ["document.requests", "document.lookup"].includes(row.operation ?? ""))).toBe(true);
    expect(prepareRecovery.some(row => row.operation === "document.lookup")).toBe(true);
    for (const row of prepareRecovery.filter(row => row.operation === "document.lookup")) expect(originalInput(row.request)).toEqual(prepared);
    await seen.markPhase("recovery.cancel-original"); await panel.getByRole("button", { name: "取消本次准备", exact: true }).click(); await expect(panel).toContainText("本次准备已取消 原记录保留");
    await expect(panel.getByRole("button", { name: "确认追加副本", exact: true })).toHaveCount(0); const afterCancel = await facts(child);
    expect(afterCancel.target).toEqual(before.target); expect(afterCancel.transfers).toHaveLength(1); expect(afterCancel.transfers[0]!.request).toEqual(prepared); expect(afterCancel.transfers[0]!.receipt).toBeNull(); expect(afterCancel.transfers[0]!.cancelledAt).not.toBeNull();
    await panel.getByRole("button", { name: "保留原记录并重新预览", exact: true }).click();
    await panel.getByRole("button", { name: "保存全部输入并预览", exact: true }).click(); await panel.getByRole("button", { name: "固定本次复制清单", exact: true }).click();
    await expect(panel).toContainText("清单已固定 尚未追加"); await seen.markPhase("recovery.lose-commit");
    await panel.getByRole("button", { name: "确认追加副本", exact: true }).click(); await lostCommit.promise; await expect(panel).toContainText("原结果尚未核对"); await seen.settle();
    expect(committed).toBeDefined(); expect(committed!.requestId).not.toBe(prepared!.requestId); expect(commitLosses).toBe(1);
    const beforeCommitReload = await facts(child); expect(beforeCommitReload.transfers).toHaveLength(2);
    const stored = beforeCommitReload.transfers.find(row => row.request.requestId === committed!.requestId)!; expect(stored.receipt).not.toBeNull(); expect(transferCanvases(beforeCommitReload, "target")).toHaveLength(2);
    const removedMarkers = await page.evaluate(prefix => {
      const keys = Object.keys(sessionStorage).filter(key => key.startsWith(prefix)); for (const key of keys) sessionStorage.removeItem(key);
      return { removed: keys.length, remaining: Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).length };
    }, STUDIO_TRANSFER_INTENT_PREFIX);
    expect(removedMarkers.removed).toBeGreaterThan(0); expect(removedMarkers.remaining).toBe(0); proof.closedTabMarkerLoss = removedMarkers;
    const secondReload = seen.rows.length; await seen.beforeReload("recovery.before-commit-reload"); await page.reload(); await seen.markPhase("recovery.after-commit-reload-without-local-marker");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); panel = await openPanel(page);
    await expect(panel.getByRole("link", { name: "打开目标项目副本", exact: true })).toBeVisible(); await seen.settle();
    const commitRecovery = documentRequests(seen, secondReload); expect(commitRecovery.length).toBeGreaterThan(0);
    expect(commitRecovery.every(row => ["document.requests", "document.lookup"].includes(row.operation ?? ""))).toBe(true);
    expect(commitRecovery.some(row => row.operation === "document.requests")).toBe(true); expect(commitRecovery.some(row => row.operation === "document.lookup")).toBe(true);
    for (const row of commitRecovery.filter(row => row.operation === "document.lookup")) expect(originalInput(row.request)).toEqual(committed);
    expect(prepareLosses).toBe(1); expect(commitLosses).toBe(1); const recovered = await facts(child);
    expect(recovered.target).toEqual(beforeCommitReload.target); expect(recovered.transfers).toEqual(beforeCommitReload.transfers);
    const prepareRows = seen.rows.filter(row => row.operation === "document.prepare"), commitRows = seen.rows.filter(row => row.operation === "document.commit"), cancelRows = seen.rows.filter(row => row.operation === "document.cancel");
    expect(prepareRows).toHaveLength(2); expect(commitRows).toHaveLength(1); expect(cancelRows).toHaveLength(1);
    expect(prepareRows.map(row => originalInput(row.request).requestId)).toEqual([prepared!.requestId, committed!.requestId]);
    expect(originalInput(commitRows[0]!.request)).toEqual(committed); expect(originalInput(cancelRows[0]!.request)).toEqual(prepared);
    const lostRows = [...seen.clear.documents.values()].flatMap(document => document.rows).filter(row => [prepared!.requestId, committed!.requestId].includes(row.requestId ?? "") && ["document.prepare", "document.commit"].includes(row.operation ?? "") && (row.error || row.readerError));
    expect(lostRows).toHaveLength(2); for (const row of lostRows) { expect(row.bytes).toBe(0); expect(row.reads).toBe(0); expect(row.eof).toBe(false); expect(row.jsonDone).toBe(false); }
    await seen.markPhase("recovery.before-CLEAR-held-lookup"); await seen.settle();
    const heldFence = await seen.clear.boundary(), heldHostBoundary = seen.rows.length; holdLookup = true;
    await panel.getByRole("button", { name: "只读核对原复制结果", exact: true }).click(); await held.promise;
    const heldCandidates = () => seen.clear.documents.get(heldFence.document)?.rows.filter(row => row.id > heldFence.lastId && row.start >= heldFence.at
      && row.operation === "document.lookup" && row.requestId === committed!.requestId && row.bodyHash === heldBodyHash) ?? [];
    await expect.poll(async () => { await seen.clear.snapshot(); return heldCandidates().length; }).toBe(1);
    const heldNative = heldCandidates()[0]!;
    const heldIdentity = { document: heldNative.document, id: heldNative.id, start: heldNative.start, bodyHash: heldNative.bodyHash, hostIndex: heldHostIndex };
    expect(heldHostIndex).toBeGreaterThanOrEqual(heldHostBoundary); expect(seen.rows[heldHostIndex]!.request).toBe(heldRequest);
    expect(heldNative).toMatchObject({ bytes: 0, reads: 0, eof: false, jsonDone: false });
    proof.heldOriginalIdentity = { ...heldIdentity, fence: heldFence, hostBoundary: heldHostBoundary };
    const writeBoundary = seen.rows.filter(row => ["state.set", "state.remove", "document.prepare", "document.commit", "document.cancel"].includes(row.operation ?? "")).length;
    const logoutStart = await page.evaluate(() => performance.timeOrigin + performance.now()); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.locator("[data-studio-session] iframe[title]")).toHaveCount(0); await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); terminal = true; release.resolve(); await drained.promise; await seen.settle();
    const exactHeld = (row: { document: number; id: number; start: number; bodyHash: string }) => row.document === heldIdentity.document && row.id === heldIdentity.id
      && row.start === heldIdentity.start && row.bodyHash === heldIdentity.bodyHash;
    await expect.poll(() => [...seen.clear.documents.values()].some(document => document.document === heldIdentity.document
      && document.events.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutStart)
      && document.rows.some(row => exactHeld(row) && (row.error === "AbortError" || row.readerError === "AbortError")))).toBe(true);
    const cleared = seen.clear.documents.get(heldIdentity.document)!;
    const clearAt = Math.min(...cleared.events.filter(event => event.at >= logoutStart).map(event => event.at)), native = cleared.rows.filter(exactHeld);
    expect(native).toHaveLength(1); expect(native[0]).toMatchObject({ operation: "document.lookup", requestId: committed!.requestId, authorityHash: basis.authorityHash, bytes: 0, reads: 0, eof: false, jsonDone: false });
    expect(native[0]!.start).toBeLessThan(clearAt); expect(native[0]!.signalAbort).toBeGreaterThanOrEqual(clearAt); expect(heldActualStatus).toBe(200);
    expect(seen.rows[heldHostIndex]!.request).toBe(heldRequest); expect(seen.rows[heldHostIndex]!.failed).toBe("net::ERR_ABORTED");
    expect(cleared.rows.filter(row => row.start >= clearAt)).toEqual([]);
    expect(seen.rows.filter(row => ["state.set", "state.remove", "document.prepare", "document.commit", "document.cancel"].includes(row.operation ?? "")).length).toBe(writeBoundary);
    expect(await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).length, STUDIO_TRANSFER_INTENT_PREFIX)).toBe(0);
    const after = await facts(child); expect(after.target).toEqual(recovered.target); expect(after.transfers).toEqual(recovered.transfers); transferPaidUnchanged(before, after); exactOriginals(after);
    verifyTransferNetwork(seen, allowedFailures); await transferNetworkProof(seen, proof);
    proof.result = { cancelledRequest: prepared, committedRequest: committed, receipt: stored.receipt, firstReloadReadCount: prepareRecovery.length, secondReloadReadCount: commitRecovery.length,
      actualHeldStatus: heldActualStatus, clearNative: native[0], clearEvents: cleared.events, originalPrepareLossCount: prepareLosses, originalCommitLossCount: commitLosses, paidTablesUnchanged: true };
    const images: string[] = []; for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); images.push(await transferScreenshot(page, info, `transfer-cleared-${width}`)); } proof.images = images;
  } catch (error) { failure = error; proof.primaryFailure = true; await failureScreenshot(page, info, proof); await transferNetworkProof(seen, proof); }
  finally { release.resolve(); const cleanup = await child.close(); proof.fixture = cleanup; proof.cleanupFailed = cleanup.failed; await transferProof(info, proof); if (cleanup.failed && !failure) failure = new Error("studio_transfer_browser_fixture_cleanup_failed"); }
  if (failure) throw failure;
});
