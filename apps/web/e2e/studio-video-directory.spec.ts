import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_PERSONAL_CLEAR_EVENT, StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { StudioVideoDirectorySchema } from "@yummyai/contracts/pod/studio-video-directory";
import { requireStudioVideoDirectoryEnvironment } from "../../../tools/testing/studio-video-directory-environment.mjs";
import type { StudioVideoBrowserRequest } from "../../../tools/testing/studio-video-directory-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { loginErp, actors } from "./erp-identity-fixture.js";
import { deferred, originalSha, originalScreenshot } from "./studio-original-helpers.js";
import { observeTransfer, transferNetworkProof, verifyTransferNetwork } from "./studio-document-transfer-helpers.js";

const SeedScope = z.object({ scope: z.string().uuid(), key: z.string(), prompt: z.string(), frozen: z.unknown() }).strict();
const Seed = z.object({ nonce: z.string(), safe: SeedScope, mixed: SeedScope }).strict();
const Fact = z.object({ effects: z.object({ role: z.string(), tables: z.record(z.string(), z.object({ count: z.number(), hash: z.string() })),
  counts: z.object({ storageReads: z.number(), storageWrites: z.number(), scans: z.number(), originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number() }),
  videoCalls: z.object({ get: z.number(), create: z.number(), bridge: z.number() }), ownedObjectCount: z.number(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }),
  logs: z.array(z.array(z.unknown())), documents: z.object({ role: z.literal("yummyai_app"), entries: z.array(z.unknown()) }).strict() }).strict();
const frameRoot = (page: Page) => page.locator("[data-studio-session] iframe[title]");
const frameFor = (page: Page) => page.frameLocator("[data-studio-session] iframe[title]");
const directoryFor = (page: Page) => page.getByRole("region", { name: "视频原生日志目录", exact: true });
type Seen = Awaited<ReturnType<typeof observeTransfer>>;
const routeError = (cause: unknown) => cause instanceof Error ? cause : new Error("studio_video_browser_route_failed");
function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-video-directory-browser.mts", import.meta.url)), "--studio-video-directory-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  let next = 0, exited = false;
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_video_(?:browser|fixture)_[a-z_]+$/) }).strict()]).safeParse(raw);
    if (!packet.success) { for (const pending of waiting.values()) pending.reject(new Error("studio_video_browser_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(new Error(packet.data.errorCode));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_video_browser_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const pending of waiting.values()) pending.reject(new Error("studio_video_browser_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext) {
    if (!child.connected || exited) throw new Error("studio_video_browser_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: StudioVideoBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.parse(context) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_video_browser_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_video_browser_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false; try { acknowledged = z.object({ closed: z.literal(true) }).strict().parse(await rpc("close")).closed; } catch { /* Separate cleanup failure below. */ }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!result) { child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid, nonce, acknowledged, exited, forced: !result, code: result?.code ?? null, failed: !acknowledged || !result || result.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
async function seed(page: Page, child: Child, nonce: string) {
  await loginErp(page, "operator", "/navigation"); const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  const value = Seed.parse(await child.rpc("seed", TenantContextSchema.parse(session))); expect(value.nonce).toBe(nonce);
  return { ...value, authorityHash: originalSha(erpSessionAuthority(session)) };
}
async function facts(child: Child) { return Fact.parse(await child.rpc("facts")); }
async function openVideo(page: Page, scope: string) {
  const workspace = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/creative-studio/workspace" && url.searchParams.get("scope") === scope; });
  await page.goto(`/creative-designs/studio/video?brief=${scope}`); const response = await workspace; expect(response.status()).toBe(200);
  expect(StudioWorkspaceSchema.parse(await response.json()).videoDirectoryVersion).toBe(1); await expect(directoryFor(page)).toBeVisible();
}
function unchanged(before: z.infer<typeof Fact>, after: z.infer<typeof Fact>) {
  expect(after.documents).toEqual(before.documents); expect(after.logs).toEqual(before.logs); expect(after.effects.tables).toEqual(before.effects.tables);
  expect(after.effects.videoCalls).toEqual({ get: 0, create: 0, bridge: 0 });
  for (const key of ["storageWrites", "generationCalls", "dispatchAttempts"] as const) expect(after.effects.counts[key]).toBe(before.effects.counts[key]);
  expect(after.effects.role).toBe("yummyai_app");
}
function noExecution(seen: Seen) {
  expect(seen.rows.filter(row => ["generate", "generation.get", "result.submit", "result.submit.pinned", "asset.review"].includes(row.operation ?? ""))).toEqual([]);
}
async function proof(info: TestInfo, value: Record<string, unknown>) { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-video-directory-proof.json"), JSON.stringify(value, null, 2) + "\n"); }
async function failedScreenshot(page: Page, info: TestInfo, value: Record<string, unknown>) {
  try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5000 }); value.failureScreenshot = true; } catch { value.failureScreenshotFailed = true; }
}
async function finish(child: Child, seen: Seen, info: TestInfo, result: Record<string, unknown>, primary: unknown) {
  let failure = primary;
  try { await transferNetworkProof(seen, result); } catch (error) { result.networkProofFailed = true; failure ??= error; }
  try { const closed = await child.close(); result.fixture = closed; if (closed.failed) failure ??= new Error("studio_video_browser_fixture_cleanup_failed"); }
  catch (error) { result.fixtureCleanupFailed = true; failure ??= error; }
  try { await proof(info, result); } catch (error) { failure ??= error; }
  return failure;
}
async function navigate(page: Page, tool: string, label: string, seen: Seen, width: number) {
  await seen.settle(); let navigation = page.locator(".erp-sidebar");
  if (width === 390) { await page.getByRole("button", { name: "打开全部导航", exact: true }).click(); navigation = page.getByRole("dialog", { name: "全部导航", exact: true }); }
  const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
  await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  if (tool === "image") { await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText(label); await expect(frameFor(page).getByRole("combobox", { name: "选择输入草稿", exact: true })).toBeEnabled(); }
}
test.beforeEach(async ({ browser }, info) => {
  const actualVersion = browser.version(); expect(actualVersion).toBe("157.0.8103.6");
  expect(info.config.metadata.browserLock?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256);
  const cdp = await browser.newBrowserCDPSession();
  try { const { product, revision } = await cdp.send("Browser.getVersion"); expect(product).toBe("HeadlessChrome/157.0.8103.6");
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ actualVersion, product, revision, ...info.config.metadata.browserLock }) });
  } finally { await cdp.detach(); }
});

test("b6e9a3f2_complete_directory_blocks_first_iframe_then_explicit_paused_open_preserves_same_scope_five_tools_drafts_and_frozen_history_at_1440_390", async ({ page }, info) => {
  const environment = requireStudioVideoDirectoryEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const result: Record<string, unknown> = { family: "studio_video_directory_b6e9a3f2", nonce: environment.nonce, paidExecution: false }, allowed = new Set<Request>(); let failure: unknown;
  const runtimeRequests: string[] = []; page.on("request", request => { const url = new URL(request.url()); if (url.origin === "http://127.0.0.1:4316") runtimeRequests.push(url.pathname); });
  try {
    const basis = await seed(page, child, environment.nonce), before = await facts(child); await seen.markPhase("directory.blocked-first-entry");
    await openVideo(page, basis.mixed.scope); const directory = directoryFor(page);
    await expect(directory.getByRole("status")).toHaveText("已完整读取 65 条原生日志"); await seen.settle(false);
    await expect(directory.locator(".studio-video-counts > span").nth(3)).toHaveText("1需核对");
    await expect(directory.locator("[data-video-entry-id]")).toHaveCount(50);
    await expect(directory.locator("[data-video-entry-id]").filter({ hasText: "video-last-unsafe" })).toHaveCount(0);
    await directory.getByRole("button", { name: "显示更多记录 当前显示 50／65", exact: true }).click();
    await expect(directory.locator("[data-video-entry-id]")).toHaveCount(65);
    await expect(directory.locator("[data-video-entry-id]").last()).toContainText("video-last-unsafe");
    await expect(frameRoot(page)).toHaveCount(0); expect(runtimeRequests).toEqual([]);
    expect(seen.rows.filter(row => row.operation === "video.preflight")).toHaveLength(0);
    await directory.getByRole("button", { name: "核对并打开视频工作台", exact: true }).click();
    await expect(directory.getByRole("status")).toHaveText("目录已读完 部分记录需核对 视频工具未打开");
    await expect(directory.locator('[data-blocked="true"]')).toHaveCount(1);
    await expect(directory.locator('[data-blocked="true"]')).toContainText("video-last-unsafe"); await expect(frameRoot(page)).toHaveCount(0);
    await page.getByRole("combobox", { name: "创作归属", exact: true }).selectOption(basis.safe.scope);
    await expect(directoryFor(page).getByRole("status")).toHaveText("已完整读取 1 条原生日志"); await expect(frameRoot(page)).toHaveCount(0);
    await directoryFor(page).getByRole("button", { name: "核对并打开视频工作台", exact: true }).click();
    await expect(frameRoot(page)).toHaveCount(1); await expect(frameFor(page).locator('[data-studio-video-admitted="true"]')).toBeVisible();
    await expect(frameFor(page).getByRole("region", { name: "输入草稿", exact: true })).toContainText("输入自动保存");
    await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(basis.safe.prompt);
    const originalFrame = await frameRoot(page).elementHandle(); expect(originalFrame).not.toBeNull();
    const images: string[] = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      for (const [tool, label] of [["canvas", "我的画布"], ["image", "生图工作台"], ["prompts", "提示词库"], ["assets", "我的资产"], ["video", "视频创作台"]]) {
        await seen.markPhase(`directory.${width}.${tool}`); await navigate(page, tool!, label!, seen, width);
        await expect(frameRoot(page)).toHaveCount(1); expect(await frameRoot(page).evaluate((current, original) => current === original, originalFrame)).toBe(true);
        if (tool === "canvas") {
          await expect(frameFor(page).getByRole("heading", { name: "Synthetic retained canvas", exact: true })).toBeVisible();
        } else if (tool === "image") {
          await expect(frameFor(page).getByRole("region", { name: "输入草稿", exact: true })).toContainText("输入自动保存");
          await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue("Synthetic unsent image draft b6e9a3f2");
          await expect(frameFor(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
        } else if (tool === "prompts") {
          await expect(frameFor(page).getByRole("textbox", { name: "提示词内容", exact: true })).toBeVisible();
          await expect(frameFor(page).getByText("保存常用提示词，生图和画布中都可调用", { exact: true })).toBeVisible();
        } else if (tool === "assets") {
          await expect(frameFor(page).getByText("没有找到资产", { exact: true })).toBeVisible();
        } else if (tool === "video") {
          await expect(directoryFor(page).getByRole("status")).toHaveText("已完整读取 1 条原生日志");
          await directoryFor(page).getByRole("button", { name: "核对并打开视频工作台", exact: true }).click();
          await expect(frameFor(page).locator('[data-studio-video-admitted="true"]')).toBeVisible();
          await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(basis.safe.prompt);
          await expect(frameFor(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
          if (width === 390) await frameFor(page).getByRole("button", { name: "生成记录", exact: true }).click();
          await expect(frameFor(page).locator('[role="status"]:visible').filter({ hasText: "原任务已冻结 不会自动恢复" }).first()).toBeVisible();
          if (width === 390) {
            const historyDialog = frameFor(page).getByRole("dialog", { name: "生成记录", exact: true });
            await historyDialog.locator(".ant-drawer-close").click(); await expect(historyDialog).toBeHidden();
          }
        }
        await seen.settle(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        expect(await frameFor(page).locator("body").evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
      }
      images.push(await originalScreenshot(page, info, `video-directory-open-${width}`));
    }
    await seen.settle(); noExecution(seen); unchanged(before, await facts(child)); verifyTransferNetwork(seen, allowed);
    result.images = images; result.relatedTableHashes = before.effects.tables; result.sameFrameRetained = true;
  } catch (error) { failure = error; result.primaryFailure = true; await failedScreenshot(page, info, result); }
  finally { failure = await finish(child, seen, info, result, failure); }
  if (failure) throw failure;
});

test("b6e9a3f2_real_logout_CLEAR_discards_the_exact_late_directory_body_without_mount_poll_or_private_state_restore", async ({ page }, info) => {
  const environment = requireStudioVideoDirectoryEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const result: Record<string, unknown> = { family: "studio_video_directory_b6e9a3f2_clear", nonce: environment.nonce, paidExecution: false };
  const allowed = new Set<Request>(), held = deferred<void>(), release = deferred<void>(), drained = deferred<void>();
  const workspaceHeld = deferred<void>(), releaseWorkspace = deferred<void>();
  let failure: unknown, heldRequest: Request | undefined, actualStatus = 0, heldBodyHash = "", heldIndex = -1, terminal = false;
  try {
    const basis = await seed(page, child, environment.nonce), before = await facts(child); await seen.settle();
    await seen.markPhase("directory.before-held-first-read"); const hostBoundary = seen.rows.length;
    await page.route("**/api/creative-studio/workspace?*", async route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("scope") !== basis.safe.scope) { await route.fallback(); return; }
      try {
        const response = await route.fetch(); expect(response.status()).toBe(200);
        expect(StudioWorkspaceSchema.parse(await response.json()).videoDirectoryVersion).toBe(1);
        workspaceHeld.resolve(); await releaseWorkspace.promise; await route.fulfill({ response });
      } catch (error) { workspaceHeld.reject(routeError(error)); throw error; }
    });
    await page.route("**/api/creative-studio/invoke", async route => {
      const packet = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (!packet.success || packet.data.request.operation !== "video.directory" || packet.data.request.scope !== basis.safe.scope || heldRequest) { await route.fallback(); return; }
      heldRequest = route.request(); heldBodyHash = originalSha(heldRequest.postData() ?? ""); allowed.add(heldRequest);
      try {
        heldIndex = seen.rows.findIndex(row => row.request === heldRequest); const response = await route.fetch(); actualStatus = response.status(); expect(actualStatus).toBe(200);
        const reply = StudioPersonalReplySchema.parse(await response.json()); expect(reply.operation).toBe("video.directory");
        expect(StudioVideoDirectorySchema.parse(reply.data).total).toBe(1); held.resolve(); await release.promise;
        try { await route.fulfill({ response }); } catch (error) { if (!terminal) throw error; }
      } catch (error) { held.reject(routeError(error)); throw error; } finally { drained.resolve(); }
    });
    const opening = openVideo(page, basis.safe.scope); void opening.catch(error => workspaceHeld.reject(error));
    await workspaceHeld.promise;
    // The real workspace response gates directory mounting. Capture this new
    // document's native-read fence before releasing it, never a prior page's.
    const fence = await seen.clear.boundary(); releaseWorkspace.resolve(); await opening;
    await held.promise; await expect(frameRoot(page)).toHaveCount(0);
    const candidates = () => seen.clear.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.operation === "video.directory") ?? [];
    await expect.poll(async () => { await seen.clear.snapshot(); const reads = candidates();
      return { count: reads.length, bodyHash: reads[0]?.bodyHash, authorityHash: reads[0]?.authorityHash };
    }).toEqual({ count: 1, bodyHash: heldBodyHash, authorityHash: basis.authorityHash });
    const native = candidates()[0]!, identity = { document: native.document, id: native.id, start: native.start, bodyHash: native.bodyHash };
    const sameDirectoryRequests = seen.rows.slice(hostBoundary).filter(row => row.operation === "video.directory");
    expect(sameDirectoryRequests).toHaveLength(1); expect(sameDirectoryRequests[0]!.request).toBe(heldRequest);
    expect(heldIndex).toBeGreaterThanOrEqual(hostBoundary); expect(seen.rows[heldIndex]!.request).toBe(heldRequest);
    expect(sameDirectoryRequests[0]).toMatchObject({ index: heldIndex, method: "POST", path: "/api/creative-studio/invoke",
      scopeHash: originalSha(basis.safe.scope), bodyHash: heldBodyHash, valid: true });
    expect(heldRequest!.frame()).toBe(page.mainFrame()); expect(heldRequest!.method()).toBe("POST");
    const heldPacket = StudioPersonalInvokeSchema.parse(heldRequest!.postDataJSON());
    expect(originalSha(heldPacket.contextAuthority)).toBe(basis.authorityHash);
    expect(originalSha(heldRequest!.headers()["x-yummyai-context-authority"] ?? "")).toBe(basis.authorityHash);
    expect(native).toMatchObject({ document: fence.document, bodyHash: heldBodyHash, authorityHash: basis.authorityHash, bytes: 0, reads: 0, eof: false, jsonDone: false });
    // Playwright reports startTime=0 while this routed request is held. Its
    // native fetch start and id are fenced in this document before workspace
    // release; the unique actual Request supplies the independent host identity.
    const playwrightTimingStart = heldRequest!.timing().startTime;
    result.actualHeldStatus = actualStatus; result.heldIdentity = { ...identity, authorityHash: native.authorityHash,
      hostIndex: heldIndex, hostBoundary, fence, playwrightTimingStart, playwrightTimingAvailable: playwrightTimingStart > 0 };
    const logoutAt = await page.evaluate(() => performance.timeOrigin + performance.now()); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); await expect(frameRoot(page)).toHaveCount(0);
    terminal = true; release.resolve(); await drained.promise; await seen.settle();
    const exact = (row: { document: number; id: number; start: number; bodyHash: string }) => Object.entries(identity).every(([key, value]) => row[key as keyof typeof row] === value);
    await expect.poll(() => seen.clear.documents.get(identity.document)?.rows.some(row => exact(row) && (row.error === "AbortError" || row.readerError === "AbortError"))).toBe(true);
    const document = seen.clear.documents.get(identity.document)!, rows = document.rows.filter(exact);
    expect(document.events.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutAt)).toBe(true);
    const clearAt = Math.min(...document.events.filter(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutAt).map(event => event.at));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ authorityHash: basis.authorityHash, bytes: 0, reads: 0, eof: false, jsonDone: false });
    expect(rows[0]!.signalAbort).toBeGreaterThanOrEqual(clearAt); expect(document.rows.filter(row => row.start >= clearAt)).toEqual([]);
    expect(seen.rows[heldIndex]!.failed).toBe("net::ERR_ABORTED"); expect(seen.rows.filter(row => row.operation === "video.preflight")).toEqual([]);
    noExecution(seen); unchanged(before, await facts(child)); verifyTransferNetwork(seen, allowed);
    result.clear = rows;
    const images: string[] = []; for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); images.push(await originalScreenshot(page, info, `video-directory-cleared-${width}`)); } result.images = images;
  } catch (error) { failure = error; result.primaryFailure = true; await failedScreenshot(page, info, result); }
  finally { releaseWorkspace.resolve(); release.resolve(); failure = await finish(child, seen, info, result, failure); }
  if (failure) throw failure;
});
