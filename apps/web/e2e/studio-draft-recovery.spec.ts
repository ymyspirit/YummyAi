import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { STUDIO_IMAGE_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import { requireStudioDraftRecoveryEnvironment } from "../../../tools/testing/studio-draft-recovery-environment.mjs";
import type { StudioDraftRecoveryBrowserRequest } from "../../../tools/testing/studio-draft-recovery-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, originalDocument, originalScreenshot, originalSha } from "./studio-original-helpers.js";
import { observeTransfer, transferNetworkProof, verifyTransferNetwork } from "./studio-document-transfer-helpers.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.uuidv7();
const Draft = z.object({ version: z.literal(1), drafts: z.array(z.object({ id: z.string(), prompt: z.string(), references: z.array(z.unknown()), config: z.record(z.string(), z.string()) }).passthrough()), activeId: z.string() }).strict();
const Seed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), scope: Id, targetScope: Id, imagePrompt: z.string(), videoPrompt: z.string(), imageDraft: Draft }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), hash: Hash }).strict();
const Entry = z.object({ id: Id, scope: Id, namespace: z.string(), key: z.string(), revision: z.number().int().positive(), value: z.unknown(), assetId: Id.nullable(), deleted: z.boolean(), updatedAt: z.string() }).strict();
const Revision = z.object({ entryId: Id, revision: z.number().int().positive(), value: z.unknown(), assetId: Id.nullable(), createdAt: z.string() }).strict();
const Project = z.object({ id: Id, status: z.string(), archived: z.boolean() }).strict();
const Facts = z.object({
  effects: z.object({ role: z.literal("yummyai_app"), tables: z.record(z.string(), Table),
    counts: z.object({ storageReads: z.number(), storageWrites: z.number(), scans: z.number(), originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number() }).strict(),
    ownedObjectCount: z.number().int().nonnegative(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }).strict(),
  extra: z.record(z.string(), Table),
  documents: z.object({ role: z.literal("yummyai_app"), entries: z.array(Entry), revisions: z.array(Revision), projects: z.array(Project) }).strict(),
}).strict();
const CleanupPhases = z.array(z.enum(["authority", "documents", "archive", "verification", "base_close"])).max(5);
const Cleanup = z.object({ role: z.literal("yummyai_app"), scopeIds: z.array(Id).length(2),
  projectStates: z.array(z.object({ id: Id, status: z.literal("cancelled"), archived: z.literal(true) }).strict()).length(2),
  removedDocuments: z.number().int().nonnegative(), retainedRevisions: z.number().int().nonnegative(), originalHistoryExact: z.literal(true),
  remainingLiveDocuments: z.literal(0), remainingVisibleProjects: z.literal(0), retainedHistory: z.literal(true) }).strict();
type Fact = z.infer<typeof Facts>;
type Seen = Awaited<ReturnType<typeof observeTransfer>>;
const frameRoot = (page: Page) => page.locator("[data-studio-session] iframe[title]");
const frameFor = (page: Page) => page.frameLocator("[data-studio-session] iframe[title]");
const input = (page: Page) => frameFor(page).locator(".studio-workbench main textarea").first();
const saveBar = (page: Page) => page.locator(".studio-save-bar");
const editor = (page: Page) => page.locator(".studio-editor[data-studio-local-dirty]");
const invokePattern = "**/api/creative-studio/invoke";

function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-draft-recovery-browser.mts", import.meta.url)), "--studio-draft-recovery-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  let next = 0, exited = false;
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_draft_(?:browser|fixture)_[a-z_]+$/), cleanupPhases: CleanupPhases }).strict()]).safeParse(raw);
    if (!packet.success) { for (const pending of waiting.values()) pending.reject(new Error("studio_draft_browser_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result);
    else pending.reject(Object.assign(new Error(packet.data.errorCode), { cleanupPhases: packet.data.cleanupPhases }));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_draft_browser_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const pending of waiting.values()) pending.reject(new Error("studio_draft_browser_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext) {
    if (!child.connected || exited) throw new Error("studio_draft_browser_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: StudioDraftRecoveryBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.parse(context) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_draft_browser_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_draft_browser_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false, cleanup: z.infer<typeof Cleanup> | undefined, cleanupPhases: z.infer<typeof CleanupPhases> = [];
    try { const reply = z.object({ closed: z.literal(true), cleanup: Cleanup }).strict().parse(await rpc("close")); acknowledged = true; cleanup = reply.cleanup; }
    catch (error) { if (error && typeof error === "object" && "cleanupPhases" in error) { const parsed = CleanupPhases.safeParse(error.cleanupPhases); if (parsed.success) cleanupPhases = parsed.data; } }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!ended) { child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid ?? null, nonce, acknowledged, cleanup, cleanupPhases, exited, forced: !ended, code: ended?.code ?? null, failed: !acknowledged || !ended || ended.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
async function facts(child: Child) { return Facts.parse(await child.rpc("facts")); }
function imageEntry(value: Fact, scope: string) {
  const row = value.documents.entries.find(entry => entry.scope === scope && entry.namespace === "app_state" && entry.key === STUDIO_IMAGE_DRAFT_KEY && !entry.deleted);
  if (!row) throw new Error("studio_draft_browser_image_entry_missing"); return row;
}
function withPrompt(value: z.infer<typeof Draft>, prompt: string) {
  const result = structuredClone(value), active = result.drafts.find(item => item.id === result.activeId);
  if (!active) throw new Error("studio_draft_browser_active_input_missing"); active.prompt = prompt; return result;
}
function noExecution(seen: Seen) {
  expect(seen.rows.filter(row => ["generate", "generation.get", "result.submit", "result.submit.pinned", "asset.review", "document.prepare", "document.commit"].includes(row.operation ?? ""))).toEqual([]);
}
function preserved(before: Fact, after: Fact, entryId: string) {
  for (const [table, value] of Object.entries(before.effects.tables)) if (!["creative_studio_entries", "creative_studio_revisions"].includes(table)) expect(after.effects.tables[table]).toEqual(value);
  expect(after.effects.tables.creative_studio_entries?.count).toBe(before.effects.tables.creative_studio_entries?.count);
  expect(after.effects.tables.creative_studio_revisions?.count).toBe((before.effects.tables.creative_studio_revisions?.count ?? -1) + 2);
  expect(after.extra).toEqual(before.extra); expect(after.effects.ownedObjectCount).toBe(before.effects.ownedObjectCount);
  expect(after.effects.counts).toEqual(before.effects.counts);
  expect(after.documents.entries.filter(row => row.id !== entryId)).toEqual(before.documents.entries.filter(row => row.id !== entryId));
  expect(after.documents.projects).toEqual(before.documents.projects);
  expect(after.documents.revisions.filter(row => row.entryId !== entryId)).toEqual(before.documents.revisions.filter(row => row.entryId !== entryId));
  for (const old of before.documents.revisions) expect(after.documents.revisions.find(row => row.entryId === old.entryId && row.revision === old.revision)).toEqual(old);
}
async function openImage(page: Page, scope: string) {
  const pending = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/creative-studio/workspace" && url.searchParams.get("scope") === scope; });
  await page.goto(`/creative-designs/studio/image?brief=${scope}`);
  const response = await pending; expect(response.status()).toBe(200);
  const workspace = StudioWorkspaceSchema.parse(await response.json()); expect(workspace.generation).toEqual({ enabled: false, code: "operator_paused" });
  await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText("生图工作台");
  const drafts = frameFor(page).getByRole("region", { name: "输入草稿", exact: true });
  await expect(drafts.getByRole("combobox", { name: "选择输入草稿", exact: true })).toHaveValue("draft-image-original");
  await expect(drafts.getByText("输入自动保存", { exact: true })).toBeVisible();
  await expect(frameFor(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
  return workspace;
}
async function navigatePrompts(page: Page, seen: Seen) {
  await seen.settle();
  const navigation = page.locator(".erp-sidebar"), group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
  await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: "提示词库", exact: true }).click();
  await expect(page.getByRole("heading", { name: "提示词库", exact: true })).toBeVisible();
  await expect(frameFor(page).getByRole("textbox", { name: "提示词内容", exact: true })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await frameFor(page).locator("body").evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
}
async function finish(child: Child, seen: Seen, info: TestInfo, result: Record<string, unknown>, primary: unknown, allowed: Set<Request>) {
  let failure = primary;
  try { await seen.settle(false); verifyTransferNetwork(seen, allowed); } catch (error) { result.networkGateFailed = true; failure ??= error; }
  try { await transferNetworkProof(seen, result); } catch (error) { result.networkProofFailed = true; failure ??= error; }
  try { const closed = await child.close(); result.fixture = closed; if (closed.failed) failure ??= new Error("studio_draft_browser_fixture_cleanup_failed"); }
  catch (error) { result.fixtureCleanupFailed = true; failure ??= error; }
  try { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-draft-recovery-proof.json"), JSON.stringify(result, null, 2) + "\n"); } catch (error) { failure ??= error; }
  return failure;
}

test.beforeEach(async ({ browser }, info) => {
  const actualVersion = browser.version(); expect(actualVersion).toBe("157.0.8103.6");
  const pin = info.config.metadata.browserLock as { lockSha256?: string; executableSha256?: string; payloadReceiptSha256?: string } | undefined;
  expect(pin?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256);
  expect(pin?.executableSha256).toBe("c86303c78d1333c725f2f57cca3d89a3bbe1d6a0aa4f51c2a3e0ce6c8637322d");
  expect(pin?.payloadReceiptSha256).toBe("5485a838933494f27ca1b542870406e838a93d49ff1f359e42b5cf8017cc14dc");
  const cdp = await browser.newBrowserCDPSession();
  try { const { product, revision } = await cdp.send("Browser.getVersion"); expect(product).toBe("HeadlessChrome/157.0.8103.6"); expect(revision).toMatch(/^@[a-f0-9]{40}$/);
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ actualVersion, product, revision, ...pin }) });
  } finally { await cdp.detach(); }
});

test("f29c6a81_committed_A_lost_ACK_keeps_B_dirty_until_explicit_save_and_remote_reload_without_paid_execution", async ({ page }, info) => {
  const environment = requireStudioDraftRecoveryEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const allowed = new Set<Request>(), result: Record<string, unknown> = { nonce: environment.nonce, paidExecutionExercised: false, workerStarted: false };
  let primary: unknown, routeHandler: ((route: Route) => Promise<void>) | undefined;
  try {
    await loginErp(page, "operator", "/navigation");
    const sessionResponse = await page.request.get("/api/erp-auth/session"); expect(sessionResponse.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await sessionResponse.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
    const basis = Seed.parse(await child.rpc("seed", TenantContextSchema.parse(session))); expect(basis.nonce).toBe(environment.nonce);
    await seen.markPhase("draft.original"); const workspace = await openImage(page, basis.scope);
    expect(workspace.contextAuthority).toBe(erpSessionAuthority(session)); await expect(input(page)).toHaveValue(basis.imagePrompt); await seen.settle();
    const initial = await facts(child), source = imageEntry(initial, basis.scope), startRevision = source.revision;
    expect(Draft.parse(originalDocument(source.value))).toEqual(basis.imageDraft);
    const promptA = "Synthetic committed A f29c6a81", promptB = "Synthetic later B must persist f29c6a81";
    const expectedA = withPrompt(basis.imageDraft, promptA), expectedB = withPrompt(basis.imageDraft, promptB);
    const fence = await seen.clear.boundary(), hostBoundary = seen.rows.length;
    const dropped = deferred<{ request: Request; index: number; bodyHash: string; upstreamRevision: number }>();
    let intercepted = false;
    routeHandler = async route => {
      const request = route.request(); let body: unknown;
      try { body = request.postDataJSON(); } catch { await route.continue(); return; }
      const parsed = StudioPersonalInvokeSchema.safeParse(body);
      if (intercepted || !parsed.success || parsed.data.contextAuthority !== workspace.contextAuthority || parsed.data.request.operation !== "state.set"
        || parsed.data.request.scope !== basis.scope || parsed.data.request.namespace !== "app_state" || parsed.data.request.key !== STUDIO_IMAGE_DRAFT_KEY) { await route.continue(); return; }
      intercepted = true;
      try {
        expect(request.method()).toBe("POST"); expect(request.headers()["x-yummyai-context-authority"]).toBe(workspace.contextAuthority);
        // JSONB hydration may return object members in a different order. Keep
        // every field in the structural comparison; the exact body hash below
        // still identifies the actual browser attempt without rewriting it.
        expect(parsed.data.request).toEqual({ operation: "state.set", scope: basis.scope, namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: startRevision, value: expectedA });
        const upstream = await route.fetch();
        try {
          expect(upstream.status()).toBe(200); const reply = StudioPersonalReplySchema.parse(await upstream.json());
          expect(reply.operation).toBe("state.set"); expect(reply.scope).toBe(basis.scope); expect(reply.contextAuthority).toBe(workspace.contextAuthority);
          if (reply.operation !== "state.set") throw new Error("studio_draft_browser_original_reply_mismatch");
          expect(reply.data.revision).toBe(startRevision + 1);
          const committed = await facts(child); expect(imageEntry(committed, basis.scope).revision).toBe(startRevision + 1);
          expect(originalDocument(imageEntry(committed, basis.scope).value)).toEqual(expectedA);
          const observed = seen.rows.filter(row => row.request === request); expect(observed).toHaveLength(1); expect(observed[0]!.index).toBeGreaterThanOrEqual(hostBoundary);
          // Only this exact original browser Request is the injected failed ACK.
          await route.abort("failed"); allowed.add(request);
          dropped.resolve({ request, index: observed[0]!.index, bodyHash: originalSha(request.postData() ?? ""), upstreamRevision: reply.data.revision });
        } finally { await upstream.dispose(); }
      } catch (error) { try { await route.abort("failed"); } catch { /* Preserve the original injection failure. */ } dropped.reject(error instanceof Error ? error : new Error("studio_draft_browser_injection_failed")); }
    };
    await page.route(invokePattern, routeHandler);
    await seen.markPhase("draft.commit-A-drop-success-ack"); await input(page).fill(promptA);
    const original = await dropped.promise; await page.unroute(invokePattern, routeHandler); routeHandler = undefined;
    await expect(saveBar(page).getByRole("button", { name: "只读核对保存结果", exact: true })).toBeEnabled();
    await expect.poll(() => seen.rows[original.index]?.failed).toBe("net::ERR_FAILED"); await seen.settle(); await seen.clear.snapshot();
    const native = seen.clear.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.operation === "state.set"
      && row.bodyHash === original.bodyHash && row.authorityHash === originalSha(workspace.contextAuthority)) ?? [];
    expect(native).toHaveLength(1); expect(native[0]).toMatchObject({ bytes: 0, reads: 0, status: null, error: "TypeError" });
    result.originalAttempt = { document: native[0]!.document, nativeId: native[0]!.id, nativeStart: native[0]!.start, hostIndex: original.index,
      bodyHash: original.bodyHash, authorityHash: native[0]!.authorityHash, upstreamRevision: original.upstreamRevision, upstreamStatus: 200,
      originalRequestFailed: "net::ERR_FAILED", originalBytes: 0, originalReads: 0, upstreamFetchIsSeparateFromOriginalRead: true };

    await seen.markPhase("draft.continue-B"); await input(page).fill(promptB); await seen.settle();
    await expect.poll(async () => Number(await editor(page).getAttribute("data-studio-local-dirty"))).toBeGreaterThan(0);
    const beforeRead = seen.rows.length, beforeReadFacts = await facts(child);
    expect(imageEntry(beforeReadFacts, basis.scope).revision).toBe(startRevision + 1); expect(originalDocument(imageEntry(beforeReadFacts, basis.scope).value)).toEqual(expectedA);
    await seen.markPhase("draft.readonly-reconcile-A-keep-B");
    await saveBar(page).getByRole("button", { name: "只读核对保存结果", exact: true }).click();
    const explicitSave = saveBar(page).getByRole("button", { name: "再次保存当前内容", exact: true }); await expect(explicitSave).toBeEnabled(); await seen.settle();
    const duringRead = seen.rows.slice(beforeRead).filter(row => row.operation !== null);
    expect(duringRead.map(row => row.operation)).toEqual(["state.get"]); expect(duringRead[0]!.key).toBe(STUDIO_IMAGE_DRAFT_KEY);
    expect(await facts(child)).toEqual(beforeReadFacts); await expect(input(page)).toHaveValue(promptB);
    expect(Number(await editor(page).getAttribute("data-studio-local-dirty"))).toBeGreaterThan(0);
    await expect(saveBar(page).getByRole("status")).not.toHaveText("自动保存已开启");
    const images: string[] = []; await input(page).scrollIntoViewIfNeeded(); await noOverflow(page);
    images.push(await originalScreenshot(page, info, "draft-B-unsaved-after-readonly-1440"));

    await seen.markPhase("draft.explicit-save-B"); await explicitSave.click();
    await expect.poll(async () => imageEntry(await facts(child), basis.scope).revision).toBe(startRevision + 2);
    const saved = await facts(child); expect(originalDocument(imageEntry(saved, basis.scope).value)).toEqual(expectedB);
    await seen.settle(); await expect(editor(page)).toHaveAttribute("data-studio-local-dirty", "0");
    await expect(saveBar(page).getByRole("status")).toHaveText("自动保存已开启");
    const stateWrites = seen.rows.filter(row => row.operation === "state.set"); expect(stateWrites).toHaveLength(2);
    const second = StudioPersonalInvokeSchema.parse(stateWrites[1]!.body);
    expect(second.request).toEqual({ operation: "state.set", scope: basis.scope, namespace: "app_state", key: STUDIO_IMAGE_DRAFT_KEY, revision: startRevision + 1, value: expectedB });
    expect(stateWrites[0]!.bodyHash).toBe(original.bodyHash);

    const originalFrame = await frameRoot(page).elementHandle(); expect(originalFrame).not.toBeNull();
    await seen.markPhase("draft.leave-image-for-prompts"); await navigatePrompts(page, seen);
    expect(await frameRoot(page).evaluate((current, previous) => current === previous, originalFrame)).toBe(true); await originalFrame?.dispose();
    await page.getByRole("button", { name: "复制创作资料到项目", exact: true }).click();
    const transfer = page.getByRole("dialog", { name: "复制创作资料到项目", exact: true });
    await transfer.getByRole("textbox", { name: "目标项目链接或 UUID", exact: true }).fill(basis.targetScope);
    await seen.markPhase("draft.flush-unmounted-image-and-preview"); await transfer.getByRole("button", { name: "保存全部输入并预览", exact: true }).click();
    await expect(transfer.getByRole("button", { name: "固定本次复制清单", exact: true })).toBeEnabled(); await seen.settle();
    expect(seen.rows.filter(row => row.operation === "document.preview")).toHaveLength(1);
    expect(await facts(child)).toEqual(saved); await transfer.getByRole("button", { name: "关闭资料复制", exact: true }).click(); await expect(transfer).toBeHidden();

    await seen.beforeReload("draft.before-remote-reopen"); await page.setViewportSize({ width: 390, height: 844 });
    const beforeReloadReads = seen.rows.length;
    await seen.markPhase("draft.remote-reopen-image-390"); await openImage(page, basis.scope); await expect(input(page)).toHaveValue(promptB); await seen.settle();
    expect(seen.rows.slice(beforeReloadReads).filter(row => row.operation === "state.get" && row.key === STUDIO_IMAGE_DRAFT_KEY)).toHaveLength(1);
    await expect(editor(page)).toHaveAttribute("data-studio-local-dirty", "0"); await expect(saveBar(page).getByRole("status")).toHaveText("自动保存已开启");
    const beforeMobileScroll = await input(page).boundingBox();
    await input(page).evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await frameRoot(page).evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    let previousMobileBox = "", stableMobileBoxes = 0;
    await expect.poll(async () => {
      const measured = await input(page).boundingBox(), signature = JSON.stringify(measured);
      const inside = !!measured && measured.y >= 0 && measured.y + measured.height <= 844;
      stableMobileBoxes = inside ? signature === previousMobileBox ? stableMobileBoxes + 1 : 1 : 0;
      previousMobileBox = inside ? signature : "";
      result.mobileInputBounds = { viewport: page.viewportSize(), before: beforeMobileScroll, after: measured, stableMeasurements: stableMobileBoxes };
      return stableMobileBoxes;
    }, { intervals: [100, 200, 500] }).toBeGreaterThanOrEqual(2);
    const box = await input(page).boundingBox(); expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0); expect(box!.y + box!.height).toBeLessThanOrEqual(844); await noOverflow(page);
    images.push(await originalScreenshot(page, info, "draft-B-restored-from-server-390"));
    const final = await facts(child); expect(final).toEqual(saved); preserved(initial, final, source.id); noExecution(seen);
    const history = final.documents.revisions.filter(row => row.entryId === source.id);
    expect(history).toHaveLength(initial.documents.revisions.filter(row => row.entryId === source.id).length + 2);
    expect(originalDocument(history.find(row => row.revision === startRevision + 1)!.value)).toEqual(expectedA);
    expect(originalDocument(history.find(row => row.revision === startRevision + 2)!.value)).toEqual(expectedB);
    expect(seen.rows.filter(row => row.operation === "state.set")).toHaveLength(2);
    result.images = images; result.sameFrameDuringToolLeave = true; result.readonlyReconciliationWriteCount = 0; result.explicitSaveCount = 1;
    result.originalRevision = startRevision; result.committedARevision = startRevision + 1; result.savedBRevision = startRevision + 2;
    result.savedDraftSha256 = originalSha(JSON.stringify(expectedB)); result.historyPreserved = true; result.unmountedOwnerFlushPassed = true; result.remoteReloadReadB = true;
    await seen.beforeReload("draft.before-leaving-owned-project"); await page.goto("/navigation"); await expect(frameRoot(page)).toHaveCount(0); await seen.settle(false);
    verifyTransferNetwork(seen, allowed);
  } catch (error) {
    primary = error;
    try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5000 }); result.failureScreenshot = true; } catch { result.failureScreenshotFailed = true; }
  } finally {
    if (routeHandler) try { await page.unroute(invokePattern, routeHandler); } catch (error) { primary ??= error; }
    primary = await finish(child, seen, info, result, primary, allowed);
  }
  if (primary) throw primary;
});
