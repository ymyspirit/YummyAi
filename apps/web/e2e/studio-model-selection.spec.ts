import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ConfigurationRpcSchema, ConfigurationSnapshotSchema } from "@yummyai/contracts/ai/model-configuration";
import { STUDIO_PERSONAL_CLEAR_EVENT, StudioModelSchema, StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema, type StudioModel } from "@yummyai/contracts/pod/studio-personal";
import { requireStudioModelSelectionEnvironment } from "../../../tools/testing/studio-model-selection-environment.mjs";
import type { StudioModelBrowserRequest } from "../../../tools/testing/studio-model-selection-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, originalDocument, originalScreenshot, originalSha } from "./studio-original-helpers.js";
import { observeTransfer, transferNetworkProof, verifyTransferNetwork } from "./studio-document-transfer-helpers.js";

const Mutation = z.enum(["disable", "change_capability", "empty"]);
const CleanupPhases = z.array(z.enum(["authority", "documents", "archive", "channels", "verification", "base_close"])).max(6);
const Seed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), scope: z.uuidv7(), channelId: z.uuidv7(), duplicateChannelId: z.uuidv7(),
  image: StudioModelSchema, video: StudioModelSchema, text: StudioModelSchema, duplicate: StudioModelSchema,
  imagePrompt: z.string(), videoPrompt: z.string(), canvasTitle: z.string() }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Entry = z.object({ id: z.uuidv7(), namespace: z.string(), key: z.string(), scope: z.string(), revision: z.number().int(), value: z.unknown() }).passthrough();
const Facts = z.object({ effects: z.object({ role: z.string(), tables: z.record(z.string(), Table),
  counts: z.object({ storageReads: z.number(), storageWrites: z.number(), scans: z.number(), originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number() }),
  queueAttempts: z.array(z.object({ id: z.uuidv7(), tenantId: z.uuidv7(), userId: z.uuidv7() }).strict()),
  ownedObjectCount: z.number(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }).strict(),
  documents: z.object({ role: z.literal("yummyai_app"), entries: z.array(Entry) }).strict() }).strict();
const Cleanup = z.object({ role: z.literal("yummyai_app"), channelIds: z.array(z.uuidv7()), scopeIds: z.array(z.uuidv7()),
  projectStates: z.array(z.object({ id: z.uuidv7(), status: z.literal("cancelled"), archived: z.literal(true) }).strict()),
  removedDocuments: z.number().int().nonnegative(), retainedRevisions: z.number().int().nonnegative(),
  remainingActiveChannels: z.literal(0), remainingActiveRoutes: z.literal(0), remainingLiveDocuments: z.literal(0), remainingVisibleProjects: z.literal(0),
  remainingCatalogueModels: z.literal(0), credentialsCleared: z.literal(true), defaultsCleared: z.literal(true), retainedHistory: z.literal(true) }).strict();
type Fact = z.infer<typeof Facts>;
type Seen = Awaited<ReturnType<typeof observeTransfer>>;
const frameRoot = (page: Page) => page.locator("[data-studio-session] iframe[title]");
const frameFor = (page: Page) => page.frameLocator("[data-studio-session] iframe[title]");
const directoryFor = (page: Page) => page.getByRole("region", { name: "视频原生日志目录", exact: true });
const token = (model: StudioModel) => `${model.id}::${model.model}`;
const routeError = (cause: unknown) => cause instanceof Error ? cause : new Error("studio_model_browser_route_failed");

function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-model-selection-browser.mts", import.meta.url)), "--studio-model-selection-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  let next = 0, exited = false;
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_model_(?:browser|fixture)_[a-z_]+$/), cleanupPhases: CleanupPhases.optional() }).strict()]).safeParse(raw);
    if (!packet.success) { for (const pending of waiting.values()) pending.reject(new Error("studio_model_browser_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(Object.assign(new Error(packet.data.errorCode), { cleanupPhases: packet.data.cleanupPhases ?? [] }));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_model_browser_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const pending of waiting.values()) pending.reject(new Error("studio_model_browser_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close" | "mutate", argument?: TenantContext | z.infer<typeof Mutation>) {
    if (!child.connected || exited) throw new Error("studio_model_browser_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: StudioModelBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.parse(argument) }
      : operation === "mutate" ? { id, nonce, operation, mutation: Mutation.parse(argument) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_model_browser_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_model_browser_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false, cleanup: z.infer<typeof Cleanup> | undefined, cleanupPhases: z.infer<typeof CleanupPhases> = [];
    try { const reply = z.object({ closed: z.literal(true), cleanup: Cleanup }).strict().parse(await rpc("close")); acknowledged = reply.closed; cleanup = reply.cleanup; }
    catch (error) {
      if (error && typeof error === "object" && "cleanupPhases" in error) { const parsed = CleanupPhases.safeParse(error.cleanupPhases); if (parsed.success) cleanupPhases = parsed.data; }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!result) { child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid, nonce, acknowledged, cleanup, cleanupPhases, exited, forced: !result, code: result?.code ?? null, failed: !acknowledged || !result || result.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
async function seed(page: Page, child: Child, nonce: string) {
  await loginErp(page, "operator", "/navigation"); const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  const value = Seed.parse(await child.rpc("seed", TenantContextSchema.parse(session))); expect(value.nonce).toBe(nonce);
  return { ...value, authorityHash: originalSha(erpSessionAuthority(session)) };
}
async function facts(child: Child) { return Facts.parse(await child.rpc("facts")); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("studio_model_browser_expected_object"); return value as Record<string, unknown>; }
function draft(value: Fact, kind: "image" | "video") {
  const row = value.documents.entries.find(item => item.namespace === "app_state" && item.key === `infinite-canvas:${kind}_draft`);
  if (!row) throw new Error("studio_model_browser_draft_missing");
  const document = object(originalDocument(row.value)); if (!Array.isArray(document.drafts)) throw new Error("studio_model_browser_draft_invalid");
  const selected = document.drafts.map(object).find(item => item.id === document.activeId); if (!selected) throw new Error("studio_model_browser_draft_missing"); return selected;
}
async function savedChoice(page: Page, child: Child, seen: Seen, kind: "image" | "video", selected: StudioModel) {
  // Selecting an option precedes the native debounced write. A quiet network
  // alone cannot prove that pending input has reached the actual owner record.
  await expect.poll(async () => object(draft(await facts(child), kind).config)[`${kind}Model`]).toBe(token(selected));
  await seen.settle(); await expect(page.locator(".studio-save-bar").getByRole("status")).toHaveText("自动保存已开启");
  return facts(child);
}
function noPaid(before: Fact, after: Fact) {
  expect(after.effects.role).toBe("yummyai_app"); expect(after.effects.queueAttempts).toEqual([]);
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger"]) expect(after.effects.tables[table]).toEqual(before.effects.tables[table]);
  for (const key of ["storageReads", "storageWrites", "scans", "generationCalls", "dispatchAttempts"] as const) expect(after.effects.counts[key]).toBe(before.effects.counts[key]);
  expect(after.effects.providerCalls).toBe(0); expect(after.effects.workerProcesses).toBe(0);
}
function noExecution(seen: Seen) {
  expect(seen.rows.filter(row => ["generate", "generation.get", "result.submit", "result.submit.pinned", "asset.review"].includes(row.operation ?? ""))).toEqual([]);
}
async function open(page: Page, scope: string, tool: "image" | "video") {
  const pending = page.waitForResponse(response => { const url = new URL(response.url()); return url.pathname === "/api/creative-studio/workspace" && url.searchParams.get("scope") === scope; });
  await page.goto(`/creative-designs/studio/${tool}?brief=${scope}`); const response = await pending; expect(response.status()).toBe(200);
  expect(StudioWorkspaceSchema.parse(await response.json()).generation).toEqual({ enabled: false, code: "operator_paused" });
  if (tool === "video") await admitVideo(page); else {
    await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText("生图工作台"); await draftReady(page, "image");
  }
}
async function draftReady(page: Page, kind: "image" | "video") {
  const region = frameFor(page).getByRole("region", { name: "输入草稿", exact: true });
  await expect(region.getByRole("status")).toHaveText("输入自动保存");
  const control = region.getByRole("combobox", { name: "选择输入草稿", exact: true });
  await expect(control).toBeEnabled(); await expect(control).toHaveValue(`model-${kind}-original`);
}
async function admitVideo(page: Page) {
  await expect(directoryFor(page).getByRole("status")).toHaveText("已完整读取 0 条原生日志");
  await directoryFor(page).getByRole("button", { name: "核对并打开视频工作台", exact: true }).click();
  await expect(frameFor(page).locator('[data-studio-video-admitted="true"]')).toBeVisible();
  await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText("视频创作台");
  await draftReady(page, "video");
}
const picker = (page: Page, capability: "image" | "video") => frameFor(page).getByRole("combobox", { name: capability === "image" ? "图片模型" : "视频模型", exact: true });
async function openParameters(page: Page) {
  await frameFor(page).getByRole("button", { name: "参数", exact: true }).click();
  const panel = frameFor(page).getByRole("dialog", { name: "参数", exact: true }); await expect(panel).toBeVisible(); return panel;
}
async function closeParameters(panel: Locator) { await panel.locator(".ant-drawer-close").click(); await expect(panel).toBeHidden(); }
async function nativeLayoutSettled(page: Page) {
  let quiet = 0;
  await expect.poll(async () => {
    const settled = await frameFor(page).locator("body").evaluate(body => body.ownerDocument.getAnimations()
      .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)));
    quiet = settled ? quiet + 1 : 0; return quiet >= 2;
  }).toBe(true);
}
async function inspectMobilePicker(page: Page, capability: "image" | "video", choices: readonly StudioModel[], audit: Record<string, unknown>[]) {
  const control = picker(page, capability), viewport = page.viewportSize(); expect(viewport).not.toBeNull();
  const evidence: Record<string, unknown> = { capability, viewport, fullyVisible: false, candidatesOpened: false, candidatesClosed: false, drawerReopened: false }; audit.push(evidence);
  const visibleAndStable = async () => {
    evidence.fullyVisible = false;
    await nativeLayoutSettled(page); await control.scrollIntoViewIfNeeded(); let previous = "", stable = 0;
    await expect.poll(async () => {
      const box = await control.boundingBox(); evidence.lastBox = box;
      if (!box || !viewport || box.width <= 0 || box.height <= 0 || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) { previous = ""; stable = 0; return false; }
      const current = JSON.stringify(box); stable = previous === current ? stable + 1 : 1; previous = current; return stable >= 2;
    }).toBe(true);
    evidence.fullyVisible = true;
  };
  await visibleAndStable();
  if (!choices.length) {
    evidence.reason = "native_empty_picker_opens_configuration";
    await expect(control).toHaveAttribute("data-studio-model-option-count", "0"); await expect(control).toHaveAttribute("data-studio-model-state", "invalid");
    evidence.optionCount = Number(await control.getAttribute("data-studio-model-option-count"));
    const notice = frameFor(page).getByRole("dialog", { name: "参数", exact: true }).locator(".studio-model-selection-notice");
    await expect(notice).toContainText("当前没有可用的视频模型"); await notice.scrollIntoViewIfNeeded(); await nativeLayoutSettled(page);
    const configure = notice.getByRole("button", { name: "打开 ERP 模型配置", exact: true }); await expect(configure).toBeVisible(); await expect(configure).toBeEnabled();
    evidence.fullyVisible = false; let previous = "", stable = 0;
    await expect.poll(async () => {
      const [box, noticeBox] = await Promise.all([control.boundingBox(), notice.boundingBox()]); evidence.lastBox = box; evidence.noticeBox = noticeBox;
      if (!viewport || [box, noticeBox].some(value => !value || value.width <= 0 || value.height <= 0 || value.x < 0 || value.y < 0 || value.x + value.width > viewport.width || value.y + value.height > viewport.height)) { previous = ""; stable = 0; return false; }
      const current = JSON.stringify([box, noticeBox]); stable = previous === current ? stable + 1 : 1; previous = current; return stable >= 2;
    }).toBe(true);
    evidence.fullyVisible = true; return;
  }
  await control.click();
  const menu = frameFor(page).getByRole("listbox"); await expect(menu).toBeVisible(); evidence.candidatesOpened = true;
  const options = menu.locator('[role="option"][data-studio-model-id]');
  await expect.poll(() => options.evaluateAll(rows => rows.map(row => row.getAttribute("data-studio-model-id")).sort())).toEqual(choices.map(model => model.id).sort());
  evidence.candidateOptionCount = await options.count();
  await page.keyboard.press("Escape"); await expect(menu).toBeHidden(); evidence.candidatesClosed = true; await nativeLayoutSettled(page);
  const panel = frameFor(page).getByRole("dialog", { name: "参数", exact: true });
  evidence.drawerClosedAfterEscape = !await panel.isVisible();
  if (evidence.drawerClosedAfterEscape) { await openParameters(page); evidence.drawerReopened = true; }
  await visibleAndStable();
}
async function select(page: Page, capability: "image" | "video", selected: StudioModel, choices: readonly StudioModel[]) {
  const control = picker(page, capability); await expect(control).toHaveAttribute("data-studio-model-capability", capability);
  await expect(control).toHaveAttribute("data-studio-model-option-count", String(choices.length)); await expect(control).toBeEnabled(); await control.click();
  await expect.poll(() => frameFor(page).locator('[role="option"][data-studio-model-id]').evaluateAll(options => options.map(option => option.getAttribute("data-studio-model-id")).sort()))
    .toEqual(choices.map(model => model.id).sort());
  const option = frameFor(page).locator(`[role="option"][data-studio-model-id="${selected.id}"]`);
  await expect(option).toHaveCount(1); await expect(option).toHaveAttribute("data-studio-model-token", token(selected)); await expect(option).toContainText(selected.model); await option.click();
  await expect(control).toHaveAttribute("data-studio-model-state", "ready"); await expect(control).toContainText(selected.model);
}
async function navigate(page: Page, tool: string, label: string, seen: Seen, width: number) {
  await seen.settle(); let navigation = page.locator(".erp-sidebar");
  if (width === 390) { await page.getByRole("button", { name: "打开全部导航", exact: true }).click(); navigation = page.getByRole("dialog", { name: "全部导航", exact: true }); }
  const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
  await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  if (tool === "video") await admitVideo(page);
  if (tool === "image") { await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText(label); await draftReady(page, "image"); }
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await frameFor(page).locator("body").evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1)).toBe(true);
}
async function failedScreenshot(page: Page, info: TestInfo, result: Record<string, unknown>) { try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5000 }); result.failureScreenshot = true; } catch { result.failureScreenshotFailed = true; } }
async function finish(child: Child, seen: Seen, info: TestInfo, result: Record<string, unknown>, primary: unknown) {
  let failure = primary; try { await transferNetworkProof(seen, result); } catch (error) { result.networkProofFailed = true; failure ??= error; }
  try { const closed = await child.close(); result.fixture = closed; if (closed.failed) failure ??= new Error("studio_model_browser_fixture_cleanup_failed"); }
  catch (error) { result.fixtureCleanupFailed = true; failure ??= error; }
  try { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-model-selection-proof.json"), JSON.stringify(result, null, 2) + "\n"); } catch (error) { failure ??= error; }
  return failure;
}

test.beforeEach(async ({ browser }, info) => {
  const actualVersion = browser.version(); expect(actualVersion).toBe("157.0.8103.6");
  const pin = info.config.metadata.browserLock as { lockSha256?: string; executableSha256?: string; payloadReceiptSha256?: string } | undefined;
  expect(pin?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256); expect(pin?.executableSha256).toBe("c86303c78d1333c725f2f57cca3d89a3bbe1d6a0aa4f51c2a3e0ce6c8637322d");
  expect(pin?.payloadReceiptSha256).toBe("5485a838933494f27ca1b542870406e838a93d49ff1f359e42b5cf8017cc14dc");
  const cdp = await browser.newBrowserCDPSession();
  try { const { product, revision } = await cdp.send("Browser.getVersion"); expect(product).toBe("HeadlessChrome/157.0.8103.6"); expect(revision).toMatch(/^@[a-f0-9]{40}$/);
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ actualVersion, product, revision, ...pin }) });
  } finally { await cdp.detach(); }
});

test("c5a8f4d1_exact_purpose_choices_repair_an_invalid_legacy_draft_and_survive_five_tools_at_1440_390_without_paid_execution", async ({ page }, info) => {
  const environment = requireStudioModelSelectionEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const result: Record<string, unknown> = { family: "studio_model_selection_c5a8f4d1", nonce: environment.nonce, paidExecution: false }, allowed = new Set<Request>(); let failure: unknown;
  const viewportProof: Record<string, unknown>[] = []; result.mobilePickers = viewportProof;
  try {
    const basis = await seed(page, child, environment.nonce), initial = await facts(child); await seen.markPhase("models.image-original"); await open(page, basis.scope, "image");
    await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(basis.imagePrompt); await select(page, "image", basis.image, [basis.image]); await seen.settle();
    await navigate(page, "video", "视频创作台", seen, 1440); await expect(picker(page, "video")).toHaveAttribute("data-studio-model-state", "invalid");
    await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(basis.videoPrompt);
    const invalid = await facts(child); expect(object(draft(invalid, "video").config).videoModel).toBe(token(basis.image));
    await select(page, "video", basis.video, [basis.video, basis.duplicate]); const chosen = await savedChoice(page, child, seen, "video", basis.video);
    expect(object(draft(chosen, "video").config).videoModel).toBe(token(basis.video)); expect(object(draft(chosen, "image").config).imageModel).toBe(token(basis.image));
    const originalFrame = await frameRoot(page).elementHandle(); expect(originalFrame).not.toBeNull(); const images: string[] = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      for (const [tool, label] of [["canvas", "我的画布"], ["image", "生图工作台"], ["prompts", "提示词库"], ["assets", "我的资产"], ["video", "视频创作台"]]) {
        await seen.markPhase(`models.${width}.${tool}`); await navigate(page, tool!, label!, seen, width);
        expect(await frameRoot(page).evaluate((current, original) => current === original, originalFrame)).toBe(true);
        if (tool === "image" || tool === "video") {
          const kind = tool as "image" | "video", selected = kind === "image" ? basis.image : basis.video;
          const parameters = width === 390 ? await openParameters(page) : undefined;
          await expect(picker(page, kind)).toHaveAttribute("data-studio-model-state", "ready"); await expect(picker(page, kind)).toContainText(selected.model);
          if (parameters) await inspectMobilePicker(page, kind, kind === "image" ? [basis.image] : [basis.video, basis.duplicate], viewportProof);
          if (tool === "video") {
            await picker(page, kind).scrollIntoViewIfNeeded(); await noOverflow(page);
            images.push(await originalScreenshot(page, info, `model-selection-video-${width}`));
          }
          if (parameters) { await noOverflow(page); await closeParameters(parameters); }
          await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(kind === "image" ? basis.imagePrompt : basis.videoPrompt);
          await expect(frameFor(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
        } else if (tool === "canvas") await expect(frameFor(page).getByRole("heading", { name: basis.canvasTitle, exact: true })).toBeVisible();
        else if (tool === "prompts") await expect(frameFor(page).getByRole("textbox", { name: "提示词内容", exact: true })).toBeVisible();
        else await expect(frameFor(page).getByText("没有找到资产", { exact: true })).toBeVisible();
        await seen.settle(); await noOverflow(page);
      }
    }
    const final = await facts(child); expect(final.documents).toEqual(chosen.documents); noPaid(initial, final); noExecution(seen); verifyTransferNetwork(seen, allowed);
    result.images = images; result.chosenDocumentHash = originalSha(JSON.stringify(chosen.documents)); result.sameFrameRetained = true;
  } catch (error) { failure = error; result.primaryFailure = true; await failedScreenshot(page, info, result); }
  finally { failure = await finish(child, seen, info, result, failure); }
  if (failure) throw failure;
});

test("6db3a742_settings_reads_real_configuration_201_with_personal_authority_and_preserves_originals_at_1440_390", async ({ page }, info) => {
  const environment = requireStudioModelSelectionEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const result: Record<string, unknown> = { family: "studio_model_selection_c5a8f4d1_configuration_201", operation: "6db3a742", nonce: environment.nonce,
    schema: 188, paidExecution: false, configurationMutations: 0 }, observed: Request[] = [];
  const allowed = new Set<Request>(), requestStarts = new Map<Request, number>();
  const record = (request: Request) => { requestStarts.set(request, Date.now()); observed.push(request); }; page.on("request", record);
  let failure: unknown;
  try {
    const basis = await seed(page, child, environment.nonce), before = await facts(child);
    const identityResponse = await page.request.get("/api/erp-auth/session"); expect(identityResponse.status()).toBe(200);
    const identity = ErpSessionViewSchema.parse(await identityResponse.json()), authority = erpSessionAuthority(identity);
    expect(identity.userId).toBe(actors().operator.userId); expect(identity.tenantId).toBe(actors().operator.tenantId);
    expect(originalSha(authority)).toBe(basis.authorityHash);
    await seen.settle(false); await seen.markPhase("configuration-201.open-personal-settings");
    const firstRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/creative-studio/configuration");
    await page.goto("/settings/ai"); await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
    const firstResponse = await firstRead; expect(firstResponse.status()).toBe(201);
    expect(firstResponse.headers()["x-yummyai-context-authority"]).toBe(authority);
    const configuration = ConfigurationSnapshotSchema.parse(await firstResponse.json());
    expect(configuration.channels.map(channel => channel.id).sort()).toEqual([basis.channelId, basis.duplicateChannelId].sort());
    const expected = [basis.image, basis.video, basis.text, basis.duplicate];
    expect(configuration.channels.flatMap(channel => channel.models.map(model => model.id)).sort()).toEqual(expected.map(model => model.id).sort());
    for (const model of expected) {
      const channelId = model.id === basis.duplicate.id ? basis.duplicateChannelId : basis.channelId;
      expect(configuration.channels.find(channel => channel.id === channelId)?.models.find(item => item.id === model.id))
        .toMatchObject({ id: model.id, name: model.model, capability: model.capability });
    }
    const root = page.getByRole("region", { name: "渠道与默认模型配置", exact: true });
    const embedded = root.locator('iframe[title="无限画布模型配置"]'); await expect(embedded).toHaveCount(1); await expect(embedded).toBeVisible();
    const frame = embedded.contentFrame(), images: string[] = [], viewports: Array<Record<string, unknown>> = [], readRequests = [firstResponse.request()];
    const capabilityLabel = { image: "图片", video: "视频", text: "文字 / 业务分析" };
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await seen.markPhase("configuration-201.width-" + width);
      if (width === 390) {
        await seen.settle(false);
        const rereading = page.waitForResponse(response => new URL(response.url()).pathname === "/api/creative-studio/configuration");
        await frame.getByRole("button", { name: "刷新配置", exact: true }).click();
        const refreshed = await rereading; expect(refreshed.status()).toBe(201); expect(refreshed.headers()["x-yummyai-context-authority"]).toBe(authority);
        expect(ConfigurationSnapshotSchema.parse(await refreshed.json())).toEqual(configuration); readRequests.push(refreshed.request());
      }
      await frame.getByRole("tab", { name: "渠道管理", exact: true }).click();
      await expect(frame.getByRole("tab", { name: "渠道管理", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator(".settings-channel")).toHaveCount(configuration.channels.length);
      for (const channel of configuration.channels) {
        const shown = frame.getByRole("region", { name: channel.name, exact: true }); await expect(shown).toBeVisible(); await expect(shown).toContainText("已启用");
      }
      await frame.getByRole("tab", { name: "模型管理", exact: true }).click();
      await expect(frame.getByRole("tab", { name: "模型管理", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(frame.locator(".settings-model-row")).toHaveCount(configuration.channels.reduce((count, channel) => count + channel.models.length + channel.analysisModels.length, 0));
      for (const model of expected) {
        const channel = configuration.channels.find(item => item.id === (model.id === basis.duplicate.id ? basis.duplicateChannelId : basis.channelId));
        if (!channel) throw new Error("studio_model_browser_configuration_channel_missing");
        const row = frame.locator(".settings-model-row").filter({ has: frame.getByText(model.model, { exact: true }) }).filter({ hasText: channel.name });
        await expect(row).toHaveCount(1); await expect(row).toBeVisible(); await expect(row).toContainText(capabilityLabel[model.capability]);
      }
      await expect(frame.getByRole("alert")).toHaveCount(0);
      await expect(frame.getByText(/结果尚未核对|配置暂时无法读取|配置读取失败/)).toHaveCount(0);
      await expect(page.getByText(/配置结果尚未核对|配置界面读取未完成/)).toHaveCount(0);
      await root.evaluate(element => element.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" }));
      await frame.getByRole("tab", { name: "模型管理", exact: true }).scrollIntoViewIfNeeded(); await seen.settle(false);
      const outer = await page.evaluate(() => ({ viewportWidth: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      const inner = await frame.locator("body").evaluate(body => ({ viewportWidth: innerWidth, scrollWidth: Math.max(body.scrollWidth, document.documentElement.scrollWidth) }));
      expect(outer.scrollWidth).toBeLessThanOrEqual(outer.viewportWidth); expect(inner.scrollWidth).toBeLessThanOrEqual(inner.viewportWidth);
      viewports.push({ width, outer, inner, channelCount: configuration.channels.length, originalRouteIds: expected.map(model => model.id) });
      images.push(await originalScreenshot(page, info, "configuration-read-201-" + width));
    }
    await seen.settle(false);
    const reads = seen.rows.filter(row => row.path === "/api/creative-studio/configuration"); expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const request of readRequests) expect(reads.filter(row => row.request === request)).toHaveLength(1);
    const transport: Array<Record<string, unknown>> = [];
    for (const row of reads) {
      const url = new URL(row.request.url()); expect(url.origin).toBe(new URL(page.url()).origin); expect(url.search).toBe("");
      expect(row.method).toBe("POST"); expect(row.request.frame()).toBe(page.mainFrame());
      expect(row.request.headers()["content-type"]).toMatch(/^application\/json(?:;|$)/);
      expect(row.request.headers()["x-yummyai-context-authority"]).toBe(authority);
      expect(ConfigurationRpcSchema.parse(row.request.postDataJSON())).toEqual({ operation: "configuration.get" });
      expect(row.status).toBe(201); expect(row.finished).toBe(true); expect(row.failed).toBeNull();
      const response = await row.request.response(); expect(response).not.toBeNull();
      if (!response) throw new Error("studio_model_browser_configuration_response_missing");
      expect(response.status()).toBe(201); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
      const actual = ConfigurationSnapshotSchema.parse(await response.json()); expect(actual).toEqual(configuration);
      transport.push({ requestIndex: row.index, method: row.method, path: row.path, operation: "configuration.get", status: 201,
        bodyHash: row.bodyHash, authorityHash: basis.authorityHash, snapshotSha256: originalSha(JSON.stringify(actual)), finished: row.finished });
      // Keep the shared POST gate closed. This leaf admits only the exact read
      // whose strict command, identity, real 201 body and completion were proved.
      row.operation = "configuration.get"; row.valid = true;
    }
    expect(seen.rows.filter(row => row.method !== "GET" && row.path !== "/api/creative-studio/configuration")).toEqual([]);
    const providerOrigins = new Set(configuration.channels.map(channel => new URL(channel.baseUrl).origin));
    expect(observed.filter(request => providerOrigins.has(new URL(request.url()).origin))).toEqual([]);
    const after = await facts(child); expect(after.effects.tables).toEqual(before.effects.tables); expect(after.documents).toEqual(before.documents); noPaid(before, after); noExecution(seen);
    result.images = images; result.viewports = viewports; result.configurationReads = transport; result.authorityHash = basis.authorityHash;
    result.configurationSnapshotHash = originalSha(JSON.stringify(configuration)); result.originalDocumentsHash = originalSha(JSON.stringify(before.documents));
    result.businessTablesUnchanged = true; result.originalDraftsAndRevisionsUnchanged = true; result.providerRequests = 0;
    const logoutButton = page.getByRole("button", { name: "退出登录", exact: true }), logoutPhase = "configuration-201.logout-private-settings";
    await page.bringToFront(); await logoutButton.focus();
    await seen.markPhase(logoutPhase); const clearBoundary = await seen.clear.boundary();
    await seen.settle(false); verifyTransferNetwork(seen, allowed);
    const logoutOrigin = new URL(page.url()).origin, logoutStartIndex = seen.rows.length, logoutStartedAt = Date.now();
    const logoutResponse = page.waitForResponse(response => {
      const url = new URL(response.url()), request = response.request();
      return url.origin === logoutOrigin && url.pathname === "/api/erp-auth/logout" && !url.search
        && request.method() === "POST" && request.frame() === page.mainFrame();
    });
    await logoutButton.click();
    const acknowledgement = await logoutResponse;
    expect(acknowledgement.status()).toBe(200); expect(await acknowledgement.json()).toEqual({ signedOut: true });
    expect(await acknowledgement.finished()).toBeNull();
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); await expect(embedded).toHaveCount(0);
    expect(new URL(page.url()).origin).toBe(logoutOrigin); expect(new URL(page.url()).pathname).toBe("/login");
    await expect(page.locator('iframe[title="无限画布模型配置"]')).toHaveCount(0);
    const clearAfter = await seen.clear.boundary();
    await expect.poll(() => seen.clear.documents.get(clearBoundary.document)?.events.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT
      && event.at >= clearBoundary.at && event.at <= clearAfter.at) ?? false).toBe(true);
    const signedOutSession = await page.request.get(new URL("/api/erp-auth/session", logoutOrigin).href, { headers: { "cache-control": "no-store" } });
    expect(signedOutSession.status()).toBe(401); await signedOutSession.dispose();
    await seen.settle(false); const logoutFinishedAt = Date.now();
    const acknowledgements = seen.rows.filter(row => row.index >= logoutStartIndex && row.path === "/api/erp-auth/logout");
    expect(acknowledgements).toHaveLength(1);
    const acknowledged = acknowledgements[0];
    if (!acknowledged) throw new Error("studio_model_browser_logout_acknowledgement_missing");
    expect(acknowledged.request).toBe(acknowledgement.request()); expect(acknowledged.phase).toBe(logoutPhase);
    expect(acknowledged.method).toBe("POST"); expect(acknowledged.status).toBe(200); expect(acknowledged.finished).toBe(true); expect(acknowledged.failed).toBeNull();
    const cancellations = seen.rows.filter(row => row.failed);
    expect(cancellations.length).toBeLessThanOrEqual(1);
    const cancelled = cancellations[0];
    if (cancelled) {
      const url = new URL(cancelled.request.url()), startedAt = requestStarts.get(cancelled.request);
      if (startedAt === undefined || cancelled.failedAt === null) throw new Error("studio_model_browser_logout_session_time_missing");
      expect(cancelled.index).toBeGreaterThanOrEqual(logoutStartIndex);
      expect(url.origin).toBe(logoutOrigin); expect(url.pathname).toBe("/api/erp-auth/session"); expect(url.search).toBe("");
      expect(cancelled.path).toBe("/api/erp-auth/session"); expect(cancelled.method).toBe("GET"); expect(cancelled.request.method()).toBe("GET");
      expect(cancelled.request.frame()).toBe(page.mainFrame()); expect(cancelled.request.resourceType()).toBe("fetch");
      expect(cancelled.request.isNavigationRequest()).toBe(false); expect(cancelled.request.postData()).toBeNull();
      expect(cancelled.phase).toBe(logoutPhase); expect(cancelled.failedPhase).toBe(logoutPhase);
      expect(cancelled.status).toBeNull(); expect(cancelled.finished).toBe(false); expect(cancelled.finishedAt).toBeNull(); expect(cancelled.finishedPhase).toBeNull();
      expect(cancelled.failed).toBe("net::ERR_ABORTED");
      expect(startedAt).toBeGreaterThanOrEqual(logoutStartedAt); expect(startedAt).toBeLessThanOrEqual(logoutFinishedAt);
      expect(cancelled.failedAt).toBeGreaterThanOrEqual(startedAt); expect(cancelled.failedAt).toBeLessThanOrEqual(logoutFinishedAt);
      expect(observed.filter(request => request === cancelled.request)).toHaveLength(1);
      expect(seen.rows.filter(row => row.request === cancelled.request)).toHaveLength(1);
      // Only this original request can be admitted, after real logout, CLEAR,
      // private-frame removal and the subsequent unauthenticated read are proved.
      allowed.add(cancelled.request);
      result.logoutSessionCancellation = { requestIndex: cancelled.index, method: "GET", path: cancelled.path, mainFrame: true,
        resourceType: "fetch", phase: logoutPhase, failedPhase: cancelled.failedPhase, startedAt, failedAt: cancelled.failedAt,
        windowStartedAt: logoutStartedAt, windowFinishedAt: logoutFinishedAt, status: null, finished: false, failure: cancelled.failed };
    }
    expect(seen.consoles).toEqual([]); verifyTransferNetwork(seen, allowed);
    result.logoutPrivateSettingsCleared = true; result.logoutSessionStatus = 401; result.logoutAcknowledgementFinished = true;
  } catch (error) { failure = error; result.primaryFailure = true; await failedScreenshot(page, info, result); }
  finally {
    page.off("request", record);
    try { await seen.settle(false); noExecution(seen); expect(seen.consoles).toEqual([]); verifyTransferNetwork(seen, allowed); }
    catch (error) { result.networkGateFailed = true; failure ??= error; }
    failure = await finish(child, seen, info, result, failure);
  }
  if (failure) throw failure;
});

test("c5a8f4d1_disable_repurpose_and_empty_catalogues_preserve_old_drafts_then_logout_CLEAR_discards_the_exact_held_models_body", async ({ page }, info) => {
  const environment = requireStudioModelSelectionEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const result: Record<string, unknown> = { family: "studio_model_selection_c5a8f4d1_refresh", nonce: environment.nonce, paidExecution: false }, allowed = new Set<Request>();
  const viewportProof: Record<string, unknown>[] = []; result.mobilePickers = viewportProof;
  const held = deferred<void>(), release = deferred<void>(), drained = deferred<void>(); let failure: unknown, heldRequest: Request | undefined, heldBodyHash = "", heldIndex = -1, actualStatus = 0, terminal = false;
  try {
    const basis = await seed(page, child, environment.nonce); await open(page, basis.scope, "video"); await select(page, "video", basis.video, [basis.video, basis.duplicate]);
    const chosen = await savedChoice(page, child, seen, "video", basis.video), images: string[] = [];
    for (const mutation of ["disable", "change_capability", "empty"] as const) {
      await seen.markPhase("models.before-" + mutation);
      const changed = z.object({ mutation: Mutation, catalogue: StudioModelSchema.array() }).strict().parse(await child.rpc("mutate", mutation)); expect(changed.mutation).toBe(mutation);
      if (mutation === "disable") expect(changed.catalogue.some(model => model.id === basis.video.id)).toBe(false);
      if (mutation === "change_capability") expect(changed.catalogue.find(model => model.id === basis.video.id)?.capability).toBe("image");
      if (mutation === "empty") expect(changed.catalogue).toEqual([]);
      await seen.beforeReload("models.reload-" + mutation); await page.reload(); await admitVideo(page);
      await expect(picker(page, "video")).toHaveAttribute("data-studio-model-state", "invalid");
      if (mutation === "empty") {
        await expect(picker(page, "video")).toHaveAttribute("data-studio-model-option-count", "0");
        const notice = frameFor(page).locator('.studio-model-selection-notice[data-studio-model-state="invalid"]');
        await expect(notice).toContainText("当前没有可用的视频模型");
        const configure = notice.getByRole("button", { name: "打开 ERP 模型配置", exact: true });
        await expect(configure).toBeVisible(); await expect(configure).toBeEnabled();
      }
      await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(basis.videoPrompt); await seen.settle();
      expect((await facts(child)).documents).toEqual(chosen.documents); noExecution(seen);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      const parameters = width === 390 ? await openParameters(page) : undefined;
      await expect(picker(page, "video")).toHaveAttribute("data-studio-model-state", "invalid"); await expect(picker(page, "video")).toHaveAttribute("data-studio-model-option-count", "0");
      if (parameters) await inspectMobilePicker(page, "video", [], viewportProof);
      const notice = parameters ? parameters.locator(".studio-model-selection-notice") : frameFor(page).locator(".studio-model-selection-notice:visible");
      await expect(notice).toContainText("当前没有可用的视频模型"); await notice.scrollIntoViewIfNeeded();
      const configure = notice.getByRole("button", { name: "打开 ERP 模型配置", exact: true }); await expect(configure).toBeVisible(); await expect(configure).toBeEnabled();
      await noOverflow(page); images.push(await originalScreenshot(page, info, `model-selection-empty-${width}`));
      if (parameters) await closeParameters(parameters);
    }
    await page.route("**/api/creative-studio/invoke", async route => {
      const packet = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (!packet.success || packet.data.request.operation !== "models" || packet.data.request.scope !== basis.scope || heldRequest) { await route.fallback(); return; }
      heldRequest = route.request(); heldBodyHash = originalSha(heldRequest.postData() ?? ""); allowed.add(heldRequest);
      try {
        heldIndex = seen.rows.findIndex(row => row.request === heldRequest); const response = await route.fetch(); actualStatus = response.status(); expect(actualStatus).toBe(200);
        const reply = StudioPersonalReplySchema.parse(await response.json()); expect(reply.operation).toBe("models"); expect(StudioModelSchema.array().parse(reply.data)).toEqual([]);
        held.resolve(); await release.promise; try { await route.fulfill({ response }); } catch (error) { if (!terminal) throw error; }
      } catch (error) { held.reject(routeError(error)); throw error; } finally { drained.resolve(); }
    });
    await seen.beforeReload("models.before-held-reload"); await page.reload();
    await expect(directoryFor(page).getByRole("status")).toHaveText("已完整读取 0 条原生日志"); await seen.settle(false); await expect(frameRoot(page)).toHaveCount(0);
    const fence = await seen.clear.boundary(), hostBoundary = seen.rows.length, beforeClear = await facts(child);
    await directoryFor(page).getByRole("button", { name: "核对并打开视频工作台", exact: true }).click(); await held.promise;
    const candidates = () => seen.clear.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.operation === "models") ?? [];
    await expect.poll(async () => { await seen.clear.snapshot(); const rows = candidates(); return { count: rows.length, bodyHash: rows[0]?.bodyHash, authorityHash: rows[0]?.authorityHash }; })
      .toEqual({ count: 1, bodyHash: heldBodyHash, authorityHash: basis.authorityHash });
    const native = candidates()[0]!, identity = { document: native.document, id: native.id, start: native.start, bodyHash: native.bodyHash };
    const hosts = seen.rows.slice(hostBoundary).filter(row => row.operation === "models"); expect(hosts).toHaveLength(1); expect(hosts[0]!.request).toBe(heldRequest);
    expect(hosts[0]).toMatchObject({ index: heldIndex, method: "POST", path: "/api/creative-studio/invoke", scopeHash: originalSha(basis.scope), bodyHash: heldBodyHash, valid: true });
    expect(heldRequest!.frame()).toBe(page.mainFrame()); expect(originalSha(heldRequest!.headers()["x-yummyai-context-authority"] ?? "")).toBe(basis.authorityHash);
    expect(native).toMatchObject({ bytes: 0, reads: 0, eof: false, jsonDone: false });
    // Drain every other real request and native consumer while keeping only the
    // one exact controlled response unresolved. This grants no network exception.
    let stable = "", observations = 0;
    await expect.poll(async () => {
      await seen.clear.snapshot(); const reads = seen.clear.documents.get(identity.document)?.rows ?? [];
      const others = reads.filter(row => row.id !== identity.id), hosts = seen.rows.filter(row => row.request !== heldRequest);
      if (!hosts.every(row => row.finished || row.failed) || !others.every(row => row.error || row.readerError || row.eof || row.jsonDone)) { stable = ""; observations = 0; return false; }
      const next = JSON.stringify({ host: hosts.map(row => [row.index, row.finished, row.failed]), native: others.map(row => [row.id, row.bytes, row.eof, row.jsonDone, row.error, row.readerError]) });
      observations = next === stable ? observations + 1 : 1; stable = next; return observations >= 2;
    }).toBe(true);
    const logoutAt = await page.evaluate(() => performance.timeOrigin + performance.now()); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); await expect(frameRoot(page)).toHaveCount(0);
    terminal = true; release.resolve(); await drained.promise; await seen.settle();
    const exact = (row: { document: number; id: number; start: number; bodyHash: string }) => Object.entries(identity).every(([key, value]) => row[key as keyof typeof row] === value);
    await expect.poll(() => seen.clear.documents.get(identity.document)?.rows.some(row => exact(row) && (row.error === "AbortError" || row.readerError === "AbortError"))).toBe(true);
    const document = seen.clear.documents.get(identity.document)!, rows = document.rows.filter(exact);
    expect(document.events.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutAt)).toBe(true);
    const clearAt = Math.min(...document.events.filter(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutAt).map(event => event.at));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ authorityHash: basis.authorityHash, bytes: 0, reads: 0, eof: false, jsonDone: false });
    expect(rows[0]!.signalAbort).toBeGreaterThanOrEqual(clearAt); expect(document.rows.filter(row => row.start >= clearAt)).toEqual([]); expect(seen.rows[heldIndex]!.failed).toBe("net::ERR_ABORTED");
    const final = await facts(child); expect(final.documents).toEqual(chosen.documents); noPaid(beforeClear, final); noExecution(seen); verifyTransferNetwork(seen, allowed);
    result.images = images; result.actualHeldStatus = actualStatus; result.heldIdentity = { ...identity, hostIndex: heldIndex, hostBoundary, fence,
      playwrightTimingStart: heldRequest!.timing().startTime }; result.documentHash = originalSha(JSON.stringify(chosen.documents));
  } catch (error) { failure = error; result.primaryFailure = true; await failedScreenshot(page, info, result); }
  finally { release.resolve(); failure = await finish(child, seen, info, result, failure); }
  if (failure) throw failure;
});
