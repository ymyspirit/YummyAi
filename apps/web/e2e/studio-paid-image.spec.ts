import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ASSIST_INTENT_PREFIX } from "@yummyai/contracts/ai/assist-recovery";
import { ConfigurationRpcSchema, ConfigurationSnapshotSchema } from "@yummyai/contracts/ai/model-configuration";
import { StudioPersonalInvokeSchema, StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { StudioPaidImageInputSchema, StudioPaidImageRequestSchema, StudioImagePricingSchema } from "@yummyai/contracts/pod/studio-paid-image";
import { StudioImageBudgetWorkspaceSchema } from "@yummyai/contracts/pod/studio-image-budget";
import { STUDIO_IMAGE_DRAFT_KEY } from "@yummyai/contracts/pod/studio-document-transfer";
import { requireStudioPaidImageEnvironment } from "../../../tools/testing/studio-paid-image-environment.mjs";
import type { StudioPaidImageBrowserRequest } from "../../../tools/testing/studio-paid-image-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { P2_CI_BROWSER_REGISTRY_SHA256, requireP2BrowserLock } from "../../../tools/testing/require-p2-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, originalScreenshot, originalSha } from "./studio-original-helpers.js";
import { observeTransfer, transferNetworkProof, verifyTransferNetwork } from "./studio-document-transfer-helpers.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.uuidv7(), Uuid = z.uuid();
const Seed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), scope: Id, draft: z.unknown(), prompt: z.string(), modelId: Id, providerId: Id,
  model: z.string(), selectionRevision: Hash, pricing: StudioImagePricingSchema, authorityHash: Hash,
  reference: z.object({ key: z.string(), assetId: Id, checksumSha256: Hash, byteSize: z.number().int().positive() }).strict(),
  output: z.object({ width: z.literal(1024), height: z.literal(1024), checksumSha256: Hash, byteSize: z.number().int().positive() }).strict() }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), sha256: Hash }).strict();
const Gateway = z.object({ method: z.literal("POST"), path: z.enum(["/v1/images/generations", "/v1/images/edits"]), model: z.string(), n: z.literal(1),
  size: z.string(), quality: z.string(), background: z.string().nullable(), referenceChecksums: z.array(Hash) }).strict();
const Facts = z.object({ role: z.literal("yummyai_app"), tables: z.record(z.string(), Table), requests: z.array(StudioPaidImageRequestSchema),
  originals: z.array(z.object({ assetId: Id, checksumSha256: Hash, byteSize: z.number().int().positive(), mediaType: z.string(), actualSha256: Hash, actualBytes: z.number().int().positive() }).strict()),
  draft: z.object({ id: Id, scope: Id, key: z.literal(STUDIO_IMAGE_DRAFT_KEY), revision: z.number().int().positive(), value: z.unknown(), updatedAt: z.string() }).strict(),
  generations: z.array(z.object({ id: Id, requestId: Uuid, scope: Id, status: z.string(), input: StudioPaidImageInputSchema,
    modelSnapshot: z.object({ providerConfigId: Id, model: z.string(), capability: z.literal("image"), routeId: Id, providerFingerprint: Hash,
      paidImage: z.object({ imageRequestId: Id, quoteHash: Hash, reservationUsd: z.string(), estimatedUsd: z.string() }).strict() }).strict(), assetId: Id.nullable() }).strict()),
  executions: z.array(z.object({ id: Id, generationId: Id.nullable(), phase: z.string(), responseChecksum: Hash.nullable(), hasArchive: z.boolean(), costUsd: z.string().nullable() }).strict()),
  budget: z.array(z.object({ id: Id, requestId: Id, state: z.enum(["reserved", "committed", "released"]), amountUsd: z.string() }).strict()),
  gatewayCalls: z.array(Gateway), scans: z.number().int().nonnegative() }).strict();
const CleanupPhases = z.array(z.enum(["authority", "requests", "documents_and_project", "channels", "policy_restore", "verification", "base_close"])).max(7);
const Cleanup = z.object({ role: z.literal("yummyai_app"), cancelledPreparations: z.number().int().nonnegative(), stoppedUnsubmittedExecutions: z.number().int().nonnegative(),
  removedDocuments: z.number().int().nonnegative(), projectStates: z.array(z.object({ id: Id, status: z.literal("cancelled"), archived: z.literal(true) }).strict()).length(1),
  remainingActiveChannels: z.literal(0), remainingPreparedRequests: z.literal(0), remainingLiveDocuments: z.literal(0), remainingQueuedOrRunning: z.literal(0),
  retainedHistory: z.literal(true), retainedAssetIds: z.array(Id), budgetPolicies: z.array(z.object({ tenantId: Id,
    disposition: z.enum(["restored_original", "retained_fixture_until_disposable_removal"]), sha256: Hash }).strict()),
  retainedUntilDisposableRemoval: z.literal("immutable requests executions budgets revisions private originals and fixture-created budget policies") }).strict();
type Fact = z.infer<typeof Facts>;
type Seen = Awaited<ReturnType<typeof observeTransfer>>;
const frameRoot = (page: Page) => page.locator("[data-studio-session] iframe[title]");
const frameFor = (page: Page) => page.frameLocator("[data-studio-session] iframe[title]");
const panel = (page: Page) => page.getByRole("region", { name: "单张生图与费用", exact: true });
const original = (page: Page, id: string) => panel(page).locator(`[data-studio-image-request="${id}"]`);
const invokePattern = "**/api/creative-studio/invoke";
const markerPrefix = `${ASSIST_INTENT_PREFIX}studio-paid-image:v1:`;
const mutating = new Set(["paid.image.budget.save", "paid.image.prepare", "paid.image.commit", "paid.image.cancel", "paid.image.abandon"]);
function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-paid-image-browser.mts", import.meta.url)), "--studio-paid-image-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  let next = 0, exited = false;
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_paid_image_(?:browser|fixture)_[a-z_]+$/), cleanupPhases: CleanupPhases }).strict()]).safeParse(raw);
    if (!packet.success) { for (const value of waiting.values()) value.reject(new Error("studio_paid_image_browser_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(Object.assign(new Error(packet.data.errorCode), { cleanupPhases: packet.data.cleanupPhases }));
  });
  child.once("error", () => { for (const value of waiting.values()) value.reject(new Error("studio_paid_image_browser_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const value of waiting.values()) value.reject(new Error("studio_paid_image_browser_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "process_original" | "close", context?: TenantContext) {
    if (!child.connected || exited) throw new Error("studio_paid_image_browser_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: StudioPaidImageBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.strict().parse(context) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_paid_image_browser_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_paid_image_browser_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false, cleanup: z.infer<typeof Cleanup> | undefined, phases: z.infer<typeof CleanupPhases> = [];
    try { const value = z.object({ closed: z.literal(true), cleanup: Cleanup }).strict().parse(await rpc("close")); cleanup = value.cleanup; acknowledged = true; }
    catch (error) { if (error && typeof error === "object" && "cleanupPhases" in error) { const parsed = CleanupPhases.safeParse(error.cleanupPhases); if (parsed.success) phases = parsed.data; } }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!ended) { child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid ?? null, nonce, acknowledged, cleanup, cleanupPhases: phases, code: ended?.code ?? null, signal: ended?.signal ?? null,
      exited, forced: !ended, failed: !acknowledged || !ended || ended.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
const facts = async (child: Child) => Facts.parse(await child.rpc("facts"));
function rpcRequest(request: Request) {
  try { return StudioPersonalInvokeSchema.safeParse(request.postDataJSON()); } catch { return { success: false as const }; }
}
function noOldGeneration(seen: Seen) {
  expect(seen.rows.filter(row => ["generate", "generation.get", "result.submit", "result.submit.pinned", "asset.review"].includes(row.operation ?? ""))).toEqual([]);
}
function sameDraft(before: Fact, after: Fact) { expect(after.draft).toEqual(before.draft); }
function originalRequest(f: Fact, id: string) {
  const value = f.requests.find(row => row.requestId === id); if (!value) throw new Error("studio_paid_image_browser_original_request_missing"); return value;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await frameFor(page).locator("body").evaluate(body => Math.max(body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth)).toBe(true);
}
async function visibleAndStable(page: Page, control: Locator) {
  await expect(control).toBeVisible(); const before = await control.boundingBox();
  await control.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  let previous = "", consecutive = 0;
  await expect.poll(async () => {
    const box = await control.boundingBox(), viewport = page.viewportSize();
    const inside = !!box && !!viewport && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
    const signature = JSON.stringify(box); consecutive = inside ? signature === previous ? consecutive + 1 : 1 : 0; previous = inside ? signature : "";
    return consecutive;
  }, { intervals: [100, 200, 500] }).toBeGreaterThanOrEqual(2);
  const after = await control.boundingBox(), viewport = page.viewportSize(); expect(after).not.toBeNull(); expect(viewport).not.toBeNull();
  expect(after!.x).toBeGreaterThanOrEqual(0); expect(after!.y).toBeGreaterThanOrEqual(0);
  expect(after!.x + after!.width).toBeLessThanOrEqual(viewport!.width); expect(after!.y + after!.height).toBeLessThanOrEqual(viewport!.height);
  return { before, after, viewport, stableMeasurements: consecutive };
}
async function openPanel(page: Page) {
  await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText("生图工作台");
  await expect(frameFor(page).getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
  const toggle = page.locator(".studio-paid-image-toggle"); await expect(toggle).toHaveCount(1);
  await expect(toggle.getByText("生图与费用", { exact: true })).toBeVisible(); await toggle.click();
  await expect(panel(page)).toBeVisible(); await expect(panel(page).getByRole("button", { name: "只读核对原生图请求", exact: true })).toBeEnabled();
  await expect(panel(page)).toHaveAttribute("aria-busy", "false");
}
async function readModelSettings(page: Page, seen: Seen, child: Child, seed: z.infer<typeof Seed>, authority: string) {
  await seen.settle(false); await seen.markPhase("paid-image.settings-read-201");
  const before = await facts(child), boundary = seen.rows.length, requests: Request[] = [];
  const record = (request: Request) => { requests.push(request); }; page.on("request", record);
  try {
    const reading = page.waitForResponse(response => new URL(response.url()).pathname === "/api/creative-studio/configuration");
    await page.goto("/settings/ai"); await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
    const response = await reading; expect(response.status()).toBe(201);
    expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
    const snapshot = ConfigurationSnapshotSchema.parse(await response.json()), channel = snapshot.channels.find(item => item.id === seed.providerId);
    expect(channel).toBeDefined(); if (!channel) throw new Error("studio_paid_image_browser_settings_channel_missing");
    const model = channel.models.find(item => item.id === seed.modelId);
    expect(model).toMatchObject({ id: seed.modelId, name: seed.model, capability: "image", imagePricing: seed.pricing });
    const settingsRoot = page.getByRole("region", { name: "渠道与默认模型配置", exact: true });
    const configurationFrame = settingsRoot.locator('iframe[title="无限画布模型配置"]'); await expect(configurationFrame).toBeVisible();
    const frame = configurationFrame.contentFrame(); await expect(frame.getByRole("tab", { name: "渠道管理", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(frame.locator(".settings-channel")).toHaveCount(snapshot.channels.length);
    const shownChannel = frame.getByRole("region", { name: channel.name, exact: true }); await expect(shownChannel).toBeVisible();
    await expect(shownChannel).toContainText("已启用"); await shownChannel.getByRole("button", { name: "查看模型", exact: true }).click();
    await expect(frame.getByRole("tab", { name: "模型管理", exact: true })).toHaveAttribute("aria-selected", "true");
    const shownModel = frame.locator(".settings-model-row").filter({ has: frame.getByText(seed.model, { exact: true }) });
    await expect(shownModel).toHaveCount(1); await expect(shownModel).toBeVisible(); await expect(shownModel).toContainText(channel.name); await expect(shownModel).toContainText("图片");
    await expect(frame.getByRole("alert")).toHaveCount(0); await expect(frame.getByText(/结果尚未核对|配置暂时无法读取|配置读取失败/)).toHaveCount(0);
    await expect(page.getByText(/配置结果尚未核对|配置界面读取未完成/)).toHaveCount(0);
    await seen.settle(false);
    const reads = seen.rows.slice(boundary).filter(row => row.path === "/api/creative-studio/configuration"); expect(reads.length).toBeGreaterThan(0);
    expect(reads.some(row => row.request === response.request())).toBe(true);
    const transport: Array<{ requestIndex: number; bodyHash: string; operation: "configuration.get"; status: 201; authorityHash: string; snapshotSha256: string; finished: true }> = [];
    for (const row of reads) {
      const url = new URL(row.request.url()); expect(url.origin).toBe(new URL(page.url()).origin); expect(url.search).toBe("");
      expect(row.method).toBe("POST"); expect(row.request.headers()["content-type"]).toMatch(/^application\/json(?:;|$)/);
      expect(row.request.headers()["x-yummyai-context-authority"]).toBe(authority);
      const command = ConfigurationRpcSchema.parse(row.request.postDataJSON()); expect(command).toEqual({ operation: "configuration.get" });
      expect(row.status).toBe(201); expect(row.finished).toBe(true); expect(row.failed).toBeNull();
      const actualResponse = await row.request.response(); expect(actualResponse).not.toBeNull();
      if (!actualResponse) throw new Error("studio_paid_image_browser_settings_response_missing");
      expect(actualResponse.status()).toBe(201); expect(actualResponse.headers()["x-yummyai-context-authority"]).toBe(authority);
      const actual = ConfigurationSnapshotSchema.parse(await actualResponse.json()); expect(actual).toEqual(snapshot);
      transport.push({ requestIndex: row.index, bodyHash: row.bodyHash, operation: "configuration.get", status: 201,
        authorityHash: originalSha(authority), snapshotSha256: originalSha(canonicalJson(actual)), finished: true });
      // The shared observer rejects non-Studio POSTs. Admit only this exact read
      // after its command, authority, real response and completion are proved.
      row.operation = "configuration.get"; row.valid = true;
    }
    const providerOrigin = new URL(channel.baseUrl).origin; expect(requests.filter(request => new URL(request.url()).origin === providerOrigin)).toEqual([]);
    const after = await facts(child); expect(after.tables).toEqual(before.tables); sameDraft(before, after);
    expect(after.gatewayCalls).toEqual([]); noOldGeneration(seen);
    return { path: "/settings/ai", transport, channels: snapshot.channels.length, modelRouteId: seed.modelId, providerConfigId: seed.providerId,
      seededModelVisible: true, unverifiedResultNoticeAbsent: true, configurationMutations: 0, providerRequests: 0, businessTablesUnchanged: true };
  } finally { page.off("request", record); }
}
async function navigate(page: Page, label: "生图工作台" | "提示词库", seen: Seen) {
  await seen.settle(); const navigation = page.locator(".erp-sidebar");
  const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
  if (await group.getAttribute("aria-expanded") !== "true") await group.click();
  await navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: label, exact: true })).toBeVisible();
  if (label === "生图工作台") await expect(frameFor(page).locator(".studio-workbench main h1")).toHaveText(label);
  else await expect(frameFor(page).getByRole("textbox", { name: "搜索提示词", exact: true })).toBeVisible();
}
async function finish(child: Child, seen: Seen, info: TestInfo, proof: Record<string, unknown>, primary: unknown, allowed: Set<Request>) {
  let failure = primary;
  try { await seen.settle(false); verifyTransferNetwork(seen, allowed); noOldGeneration(seen); } catch (error) { proof.networkGateFailed = true; failure ??= error; }
  try { await transferNetworkProof(seen, proof); } catch (error) { proof.networkProofFailed = true; failure ??= error; }
  try { const closed = await child.close(); proof.fixture = closed; if (closed.failed) failure ??= new Error("studio_paid_image_browser_fixture_cleanup_failed"); }
  catch (error) { proof.fixtureCleanupFailed = true; failure ??= error; }
  try { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-paid-image-proof.json"), JSON.stringify(proof, null, 2) + "\n"); } catch (error) { failure ??= error; }
  return failure;
}

test.beforeEach(async ({ browser }, info) => {
  const actualVersion = browser.version(), pin = info.config.metadata.browserLock as Record<string, unknown> | undefined;
  let expectedProduct: string;
  if (process.platform === "win32") {
    expect(actualVersion).toBe("157.0.8103.6");
    expect(pin?.lockSha256).toBe(STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256);
    expect(pin?.executableSha256).toBe("c86303c78d1333c725f2f57cca3d89a3bbe1d6a0aa4f51c2a3e0ce6c8637322d");
    expect(pin?.payloadReceiptSha256).toBe("5485a838933494f27ca1b542870406e838a93d49ff1f359e42b5cf8017cc14dc");
    expectedProduct = "HeadlessChrome/157.0.8103.6";
  } else {
    expect(process.platform).toBe("linux"); expect(process.env.CI).toBe("true");
    expect(pin?.family).toBe("p2_linux_ci_official_headless_shell_v1");
    expect(actualVersion).toBe("149.0.7827.55"); expect(pin?.browserVersion).toBe("149.0.7827.55");
    expect(pin?.driverVersion).toBe("1.61.1"); expect(pin?.sourcePackageVersion).toBe("1.61.1"); expect(pin?.revision).toBe("1228");
    expect(pin?.registrySha256).toBe(P2_CI_BROWSER_REGISTRY_SHA256);
    const observed = requireP2BrowserLock();
    expect(observed.metadata).toEqual(pin); expect(observed.executableSha256).toBe(pin?.executableSha256);
    expectedProduct = "HeadlessChrome/149.0.7827.55";
  }
  const cdp = await browser.newBrowserCDPSession();
  try { const { product, revision } = await cdp.send("Browser.getVersion"); expect(product).toBe(expectedProduct); expect(revision).toMatch(/^@[a-f0-9]{40}$/);
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ actualVersion, product, revision, ...pin }) });
  } finally { await cdp.detach(); }
});

test("73e2c9b1_actual_single_image_quote_lost_commit_receipt_recovers_same_key_and_original_bytes_with_synthetic_processing", async ({ page }, info) => {
  const environment = requireStudioPaidImageEnvironment(process.env, true), seen = await observeTransfer(page), child = childFor(environment.nonce);
  const allowed = new Set<Request>(), proof: Record<string, unknown> = { nonce: environment.nonce, realPaidCalls: 0, ordinaryWorkerStarted: false,
    gateway: "injected fetch only loopback 127.0.0.1:9 No real socket or provider" };
  let primary: unknown, handler: ((route: Route) => Promise<void>) | undefined;
  try {
    await loginErp(page, "operator", "/navigation");
    const sessionResponse = await page.request.get("/api/erp-auth/session"); expect(sessionResponse.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await sessionResponse.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
    const seed = Seed.parse(await child.rpc("seed", TenantContextSchema.strict().parse(TenantContextSchema.parse(session)))); expect(seed.nonce).toBe(environment.nonce);
    const authority = erpSessionAuthority(session); expect(seed.authorityHash).toBe(originalSha(authority));
    proof.modelSettings = await readModelSettings(page, seen, child, seed, authority);
    const workspaceResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/creative-studio/workspace"
      && new URL(response.url()).searchParams.get("scope") === seed.scope);
    await seen.markPhase("paid-image.open-original"); await page.goto(`/creative-designs/studio/image?brief=${seed.scope}`);
    const response = await workspaceResponse; expect(response.status()).toBe(200);
    const workspace = StudioWorkspaceSchema.parse(await response.json()); expect(workspace.contextAuthority).toBe(authority);
    expect(workspace.paidImageVersion).toBe(1); expect(workspace.generation).toEqual({ enabled: false, code: "operator_paused" });
    await expect(frameFor(page).locator(".studio-workbench main textarea").first()).toHaveValue(seed.prompt);
    proof.imagePanelMount = await page.locator(".studio-paid-image-toggle").evaluateAll(toggles => ({ count: toggles.length,
      mounts: toggles.map((toggle, index) => {
        const section = toggle.closest("section"), parents: Array<{ tag: string; className: string; hidden: boolean }> = [];
        let reachedStudioSession = false;
        for (let parent = toggle.parentElement; parent; parent = parent.parentElement) {
          parents.push({ tag: parent.tagName.toLowerCase(), className: parent.getAttribute("class") ?? "", hidden: parent.hasAttribute("hidden") });
          if (parent.matches("[data-studio-session]")) { reachedStudioSession = true; break; }
        }
        return { index, section: section ? { dataStudioPaidImage: section.getAttribute("data-studio-paid-image"),
          hidden: section.hasAttribute("hidden"), display: getComputedStyle(section).display } : null, parents, reachedStudioSession };
      }) }));
    await openPanel(page); await expect(panel(page).getByRole("button", { name: "载入当前输入草稿", exact: true })).toBeEnabled();
    await seen.settle(); const initial = await facts(child); expect(initial.requests).toEqual([]); expect(initial.generations).toEqual([]); expect(initial.budget).toEqual([]);
    expect(initial.gatewayCalls).toEqual([]); expect(initial.draft.value).toEqual({ studioDocument: true, data: seed.draft });
    const images: string[] = [];
    await seen.markPhase("paid-image.configure-budget-through-actual-ui");
    const readingBudget = page.waitForResponse(value => { const parsed = rpcRequest(value.request()); return parsed.success && parsed.data.request.operation === "paid.image.budget.get"; });
    await panel(page).getByRole("button", { name: "组织预算", exact: true }).click();
    const budgetResponse = await readingBudget; expect(budgetResponse.status()).toBe(200); const budgetEnvelope = StudioPersonalReplySchema.parse(await budgetResponse.json());
    if (budgetEnvelope.operation !== "paid.image.budget.get") throw new Error("studio_paid_image_browser_budget_read_reply_mismatch");
    const budgetBefore = StudioImageBudgetWorkspaceSchema.parse(budgetEnvelope.data);
    const budgetRegion = panel(page).getByRole("region", { name: "组织预算", exact: true });
    await expect(budgetRegion).toHaveAttribute("data-studio-image-budget-ready", "true");
    for (const label of ["组织月预算美元", "默认任务预留上限美元", "单张图片预留上限美元"]) await expect(budgetRegion.getByRole("textbox", { name: label, exact: true })).toHaveValue("");
    await budgetRegion.getByRole("textbox", { name: "组织月预算美元", exact: true }).fill("10.000000");
    await budgetRegion.getByRole("textbox", { name: "默认任务预留上限美元", exact: true }).fill("1.000000");
    await budgetRegion.getByRole("textbox", { name: "单张图片预留上限美元", exact: true }).fill("1.000000");
    const savingBudget = page.waitForResponse(value => { const parsed = rpcRequest(value.request()); return parsed.success && parsed.data.request.operation === "paid.image.budget.save"; });
    await budgetRegion.getByRole("button", { name: "保存组织预算", exact: true }).click();
    const budgetSavedResponse = await savingBudget; expect(budgetSavedResponse.status()).toBe(200);
    const budgetCommand = StudioPersonalInvokeSchema.parse(budgetSavedResponse.request().postDataJSON());
    expect(budgetCommand.contextAuthority).toBe(authority); expect(budgetCommand.request).toEqual({ operation: "paid.image.budget.save", scope: seed.scope,
      settings: { revision: budgetBefore.revision, monthlyCapUsd: "10.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: "1.000000" } });
    const budgetSavedEnvelope = StudioPersonalReplySchema.parse(await budgetSavedResponse.json());
    if (budgetSavedEnvelope.operation !== "paid.image.budget.save") throw new Error("studio_paid_image_browser_budget_save_reply_mismatch");
    expect(budgetSavedEnvelope.contextAuthority).toBe(authority);
    const budgetSaved = StudioImageBudgetWorkspaceSchema.parse(budgetSavedEnvelope.data);
    expect(budgetSaved).toMatchObject({ occupiedUsd: budgetBefore.occupiedUsd, policy: { monthlyCapUsd: "10.000000", defaultTaskCapUsd: "1.000000", imageTaskCapUsd: "1.000000", imageCapSource: "specific" } });
    expect(budgetSaved.revision).toMatch(/^[a-f0-9]{64}$/); await expect(panel(page)).toContainText("组织预算已保存 未自动准备报价 提交生成或更换原请求编号");
    await seen.settle(); const afterBudget = await facts(child); expect(afterBudget.tables).toEqual(initial.tables); sameDraft(initial, afterBudget);
    expect(afterBudget.requests).toEqual([]); expect(afterBudget.generations).toEqual([]); expect(afterBudget.gatewayCalls).toEqual([]);
    proof.budgetBounds = await visibleAndStable(page, budgetRegion); await noOverflow(page); images.push(await originalScreenshot(page, info, "single-image-organization-budget-1440"));
    proof.budgetSavedByVisibleUi = { revisionBefore: budgetBefore.revision, revisionAfter: budgetSaved.revision, occupiedUsd: budgetSaved.occupiedUsd, policy: budgetSaved.policy };
    await panel(page).getByRole("button", { name: "组织预算", exact: true }).click(); await expect(budgetRegion).toBeHidden();
    await seen.markPhase("paid-image.import-saved-native-draft");
    await panel(page).getByRole("button", { name: "载入当前输入草稿", exact: true }).click();
    await expect(panel(page).getByRole("textbox", { name: "单张图片提示词", exact: true })).toHaveValue(seed.prompt);
    await expect(panel(page).getByRole("textbox", { name: "单张图片尺寸", exact: true })).toHaveValue("1:1");
    await expect(panel(page).getByRole("combobox", { name: "单张图片质量", exact: true })).toHaveValue("high");
    const model = panel(page).getByRole("combobox", { name: "单张生图图片模型", exact: true }); await expect(model).toHaveValue("");
    await model.selectOption(seed.modelId); await panel(page).getByRole("combobox", { name: "单张图片背景", exact: true }).selectOption("opaque");
    await expect(panel(page).getByRole("listbox", { name: "单张图片参考图", exact: true })).toHaveValues([seed.reference.key]);
    const preparing = page.waitForResponse(value => { const parsed = rpcRequest(value.request()); return parsed.success && parsed.data.request.operation === "paid.image.prepare"; });
    await seen.markPhase("paid-image.prepare-real-wire-quote"); await panel(page).getByRole("button", { name: "核对单张图片费用", exact: true }).click();
    const prepareResponse = await preparing; expect(prepareResponse.status()).toBe(200); const prepareReply = StudioPersonalReplySchema.parse(await prepareResponse.json());
    if (prepareReply.operation !== "paid.image.prepare") throw new Error("studio_paid_image_browser_prepare_reply_mismatch");
    expect(prepareReply.contextAuthority).toBe(authority); expect(prepareReply.scope).toBe(seed.scope);
    expect(prepareResponse.headers()["x-yummyai-context-authority"]).toBe(authority);
    const prepared = StudioPaidImageRequestSchema.parse(prepareReply.data), requestId = prepared.requestId;
    expect(prepared.scope).toBe(seed.scope); expect(prepared.originalInput).toEqual(StudioPaidImageInputSchema.parse({ requestId, capability: "image",
      modelId: seed.modelId, selectionRevision: seed.selectionRevision, prompt: seed.prompt, size: "1:1", quality: "high", background: "opaque", referenceKeys: [seed.reference.key], seconds: 4 }));
    expect(prepared.input.size).toBe("1024x1024"); expect(prepared.input).not.toHaveProperty("count");
    expect(prepared.quote).toMatchObject({ modelId: seed.modelId, providerConfigId: seed.providerId, model: seed.model, contextAuthority: authority,
      unit: "image", count: 1, currency: "USD", size: "1024x1024", quality: "high", background: "opaque", pricing: seed.pricing,
      references: [{ assetId: seed.reference.assetId, version: expect.any(Number), checksum: seed.reference.checksumSha256 }] });
    const { quoteHash, ...fixedQuote } = prepared.quote; expect(quoteHash).toBe(originalSha(canonicalJson(fixedQuote)));
    expect(prepared.quote.inputFingerprint).toBe(originalSha(canonicalJson(prepared.input))); expect(Date.parse(fixedQuote.expiresAt) - Date.parse(fixedQuote.createdAt)).toBe(300_000);
    await expect(original(page, requestId)).toHaveAttribute("data-studio-image-status", "prepared"); await seen.settle();
    const preparedFacts = await facts(child); sameDraft(initial, preparedFacts); expect(preparedFacts.generations).toEqual([]); expect(preparedFacts.budget).toEqual([]); expect(preparedFacts.gatewayCalls).toEqual([]);
    proof.quoteBounds = await visibleAndStable(page, original(page, requestId).locator(".studio-paid-image-quote")); await noOverflow(page);
    images.push(await originalScreenshot(page, info, "single-image-fixed-quote-1440"));
    const fence = await seen.clear.boundary(), hostBoundary = seen.rows.length;
    const dropped = deferred<{ request: Request; index: number; bodyHash: string; generationId: string }>(); let intercepted = false;
    handler = async route => {
      const request = route.request(), parsed = rpcRequest(request);
      if (intercepted || !parsed.success || parsed.data.contextAuthority !== authority || parsed.data.request.operation !== "paid.image.commit"
          || parsed.data.request.scope !== seed.scope || parsed.data.request.requestId !== requestId) { await route.continue(); return; }
      intercepted = true;
      try {
        expect(request.method()).toBe("POST"); expect(request.headers()["x-yummyai-context-authority"]).toBe(authority);
        expect(parsed.data.request).toEqual({ operation: "paid.image.commit", scope: seed.scope, requestId, quoteHash, confirmed: true });
        const upstream = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 25_000 });
        try {
          expect(upstream.status()).toBe(200); const envelope = StudioPersonalReplySchema.parse(await upstream.json());
          if (envelope.operation !== "paid.image.commit") throw new Error("studio_paid_image_browser_commit_reply_mismatch");
          expect(envelope.contextAuthority).toBe(authority); expect(upstream.headers()["x-yummyai-context-authority"]).toBe(authority);
          const committed = StudioPaidImageRequestSchema.parse(envelope.data);
          expect(committed).toMatchObject({ requestId, scope: seed.scope, status: "queued", generationId: expect.any(String) }); expect(committed.quote).toEqual(prepared.quote);
          const durable = await facts(child); expect(durable.generations).toHaveLength(1); expect(durable.budget).toHaveLength(1); expect(durable.gatewayCalls).toEqual([]);
          expect(durable.generations[0]!.id).toBe(committed.generationId); expect(durable.budget[0]).toMatchObject({ requestId: committed.generationId, state: "reserved", amountUsd: seed.pricing.reservationUsd });
          const observed = seen.rows.filter(row => row.request === request); expect(observed).toHaveLength(1); expect(observed[0]!.index).toBeGreaterThanOrEqual(hostBoundary);
          allowed.add(request); await route.abort("failed");
          dropped.resolve({ request, index: observed[0]!.index, bodyHash: originalSha(request.postData() ?? ""), generationId: committed.generationId! });
        } finally { await upstream.dispose(); }
      } catch (error) { try { await route.abort("failed"); } catch { /* Keep the original injected-failure assertion. */ } dropped.reject(error instanceof Error ? error : new Error("studio_paid_image_browser_ack_injection_failed")); }
    };
    await page.route(invokePattern, handler); await seen.markPhase("paid-image.commit-once-drop-successful-ack");
    await original(page, requestId).getByRole("checkbox", { name: "我已核对本次单张图片的实际参数 预估费用和预算预留", exact: true }).check();
    await original(page, requestId).getByRole("button", { name: "确认本次报价并提交", exact: true }).click();
    const attempt = await dropped.promise; await page.unroute(invokePattern, handler); handler = undefined;
    await expect(original(page, requestId)).toHaveAttribute("data-studio-image-status", "unknown");
    await expect.poll(() => seen.rows[attempt.index]?.failed).toBe("net::ERR_FAILED"); await seen.settle(false); await seen.clear.snapshot();
    const native = seen.clear.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.operation === "paid.image.commit"
      && row.requestId === requestId && row.bodyHash === attempt.bodyHash && row.authorityHash === seed.authorityHash) ?? [];
    expect(native).toHaveLength(1); expect(native[0]).toMatchObject({ status: null, bytes: 0, reads: 0, error: "TypeError" });
    proof.originalAttempt = { requestId, generationId: attempt.generationId, document: native[0]!.document, nativeId: native[0]!.id, start: native[0]!.start,
      hostIndex: attempt.index, bodyHash: attempt.bodyHash, authorityHash: native[0]!.authorityHash, upstreamStatus: 200, originalStatus: null, bytes: 0, reads: 0,
      upstreamFetchIsSeparateFromOriginalRead: true };
    const queuedFacts = await facts(child); sameDraft(initial, queuedFacts);
    await seen.beforeReload("paid-image.before-cleared-marker-reload");
    const removed = await page.evaluate(prefix => {
      const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => !!key?.startsWith(prefix));
      for (const key of keys) sessionStorage.removeItem(key); return keys.length;
    }, markerPrefix); expect(removed).toBe(1);
    const recoveryStart = seen.rows.length; await page.reload(); await seen.markPhase("paid-image.after-reload-server-original-recovery"); await openPanel(page);
    await expect(original(page, requestId)).toHaveAttribute("data-studio-image-status", "queued"); await seen.settle();
    const recovery = seen.rows.slice(recoveryStart); expect(recovery.filter(row => row.operation === "paid.image.requests").length).toBeGreaterThan(0);
    expect(recovery.filter(row => row.operation === "paid.image.lookup").length).toBeGreaterThan(0); expect(recovery.filter(row => mutating.has(row.operation ?? ""))).toEqual([]);
    const recovered = await facts(child); expect(recovered.tables).toEqual(queuedFacts.tables); expect(recovered.generations).toEqual(queuedFacts.generations);
    expect(recovered.budget).toEqual(queuedFacts.budget); expect(recovered.gatewayCalls).toEqual([]); sameDraft(initial, recovered);
    const completed = Facts.parse(await child.rpc("process_original")); const result = originalRequest(completed, requestId);
    expect(result).toMatchObject({ generationId: attempt.generationId, status: "completed", execution: { phase: "completed", costUsd: "0.01234567", budgetState: "committed", budgetAmountUsd: "0.012346" },
      result: { namespace: "image_files", key: `image:${attempt.generationId}`, mediaType: "image/png", checksumSha256: seed.output.checksumSha256, byteSize: seed.output.byteSize, rightsStatus: "unverified" } });
    expect(result.originalInput).toEqual(prepared.originalInput); expect(result.input).toEqual(prepared.input); expect(result.quote).toEqual(prepared.quote);
    expect(completed.gatewayCalls).toEqual([{ method: "POST", path: "/v1/images/edits", model: seed.model, n: 1, size: "1024x1024", quality: "high", background: "opaque", referenceChecksums: [seed.reference.checksumSha256] }]);
    expect(completed.executions).toHaveLength(1); expect(completed.executions[0]).toMatchObject({ generationId: attempt.generationId, phase: "completed", hasArchive: true, responseChecksum: expect.any(String), costUsd: "0.01234567" });
    expect(completed.scans).toBeGreaterThan(0); expect(completed.tables.creative_design_candidates?.count).toBe(0); expect(completed.tables.creative_design_versions?.count).toBe(0);
    for (const file of completed.originals) { expect(file.actualSha256).toBe(file.checksumSha256); expect(file.actualBytes).toBe(file.byteSize); }
    sameDraft(initial, completed); expect(completed.originals.find(file => file.assetId === seed.reference.assetId)).toEqual(initial.originals.find(file => file.assetId === seed.reference.assetId));
    await seen.markPhase("paid-image.read-completed-original-not-legacy-get");
    await panel(page).getByRole("button", { name: "只读核对原生图请求", exact: true }).click(); await expect(original(page, requestId)).toHaveAttribute("data-studio-image-status", "completed");
    await expect(original(page, requestId)).toContainText("USD 0.01234567"); await expect(original(page, requestId)).toContainText("已记账"); await expect(original(page, requestId)).toContainText("权利未核验 仍需审核");
    const previewStart = seen.rows.length;
    const previewing = page.waitForResponse(value => { const request = rpcRequest(value.request()); return request.success && request.data.request.operation === "state.get"
      && request.data.request.scope === seed.scope && request.data.request.namespace === "image_files" && request.data.request.key === result.result!.key; });
    await panel(page).getByRole("button", { name: "查看本次原图", exact: true }).click(); const previewResponse = await previewing; expect(previewResponse.status()).toBe(200);
    const mediaReply = StudioPersonalReplySchema.parse(await previewResponse.json());
    if (mediaReply.operation !== "state.get" || !("media" in mediaReply.data)) throw new Error("studio_paid_image_browser_actual_media_reply_missing");
    expect(mediaReply.scope).toBe(seed.scope); expect(mediaReply.contextAuthority).toBe(authority); expect(previewResponse.headers()["x-yummyai-context-authority"]).toBe(authority);
    expect(mediaReply.data.assetId).toBe(result.result!.assetId); expect(mediaReply.data.media.mediaType).toBe("image/png");
    const previewBytes = Buffer.from(mediaReply.data.media.contentBase64, "base64"); expect(originalSha(previewBytes)).toBe(seed.output.checksumSha256); expect(previewBytes.byteLength).toBe(seed.output.byteSize);
    const image = panel(page).getByRole("img", { name: "本次单张生图原图", exact: true });
    await expect.poll(() => image.evaluate(element => { const node = element as HTMLImageElement; return { complete: node.complete, width: node.naturalWidth, height: node.naturalHeight }; }))
      .toEqual({ complete: true, width: 1024, height: 1024 });
    await seen.settle(); const previewRows = seen.rows.slice(previewStart).filter(row => row.operation === "state.get" && row.key === result.result!.key);
    expect(previewRows).toHaveLength(1); expect(previewRows[0]!.request).toBe(previewResponse.request());
    proof.preview = { assetId: result.result!.assetId, keyHash: originalSha(result.result!.key), requestIndex: previewRows[0]!.index,
      bodyHash: previewRows[0]!.bodyHash, actualSha256: originalSha(previewBytes), actualBytes: previewBytes.byteLength, naturalWidth: 1024, naturalHeight: 1024 };
    proof.desktopPreviewBounds = await visibleAndStable(page, image); await noOverflow(page); images.push(await originalScreenshot(page, info, "single-image-original-and-unapproved-boundary-1440"));
    const retainedFrame = await frameRoot(page).elementHandle(); expect(retainedFrame).not.toBeNull();
    await panel(page).getByRole("button", { name: "关闭生图与费用", exact: true }).click(); await expect(panel(page)).toBeHidden();
    await navigate(page, "提示词库", seen); expect(await frameRoot(page).evaluate((current, previous) => current === previous, retainedFrame)).toBe(true);
    await navigate(page, "生图工作台", seen); expect(await frameRoot(page).evaluate((current, previous) => current === previous, retainedFrame)).toBe(true); await retainedFrame?.dispose();
    await openPanel(page); await expect(original(page, requestId)).toHaveAttribute("data-studio-image-status", "completed"); await seen.settle();
    await page.setViewportSize({ width: 390, height: 844 }); await panel(page).getByRole("button", { name: "查看本次原图", exact: true }).click();
    await expect.poll(() => image.evaluate(element => { const node = element as HTMLImageElement; return { complete: node.complete, width: node.naturalWidth, height: node.naturalHeight }; }))
      .toEqual({ complete: true, width: 1024, height: 1024 });
    await seen.settle(); proof.mobilePreviewBounds = await visibleAndStable(page, image); await noOverflow(page);
    images.push(await originalScreenshot(page, info, "single-image-original-390"));
    const final = await facts(child); expect(final.tables).toEqual(completed.tables); expect(final.requests).toEqual(completed.requests); expect(final.gatewayCalls).toEqual(completed.gatewayCalls);
    sameDraft(initial, final); expect(final.requests).toHaveLength(1); noOldGeneration(seen);
    const mutations = seen.rows.filter(row => mutating.has(row.operation ?? "")); expect(mutations.map(row => row.operation)).toEqual(["paid.image.budget.save", "paid.image.prepare", "paid.image.commit"]);
    for (const row of mutations.filter(row => row.operation !== "paid.image.budget.save")) { const command = StudioPersonalInvokeSchema.parse(row.body).request; expect(command.scope).toBe(seed.scope);
      expect(command.operation === "paid.image.prepare" ? command.input.requestId : "requestId" in command ? command.requestId : null).toBe(requestId); }
    proof.images = images; proof.serverIndexRecoveryWithoutLocalMarker = true; proof.sameFrameOnSubsequentToolNavigation = true;
    proof.originalDraftExact = true; proof.originalRequestId = requestId; proof.quoteHash = quoteHash; proof.modelRouteId = seed.modelId;
    proof.nonOwnerDatabaseRole = final.role; proof.originalInputFingerprint = prepared.quote.inputFingerprint;
    proof.sourceDraft = { entryId: initial.draft.id, initialRevision: initial.draft.revision, finalRevision: final.draft.revision,
      initialSha256: originalSha(canonicalJson(initial.draft)), finalSha256: originalSha(canonicalJson(final.draft)) };
    proof.finalTables = final.tables; proof.originalReservationUsd = seed.pricing.reservationUsd; proof.finalBudget = final.budget;
    proof.syntheticGatewayCalls = final.gatewayCalls.length; proof.syntheticActualCostUsd = result.execution.costUsd; proof.actualImageRightsStatus = result.result!.rightsStatus;
    proof.candidatesCreated = final.tables.creative_design_candidates!.count; proof.approvedVersionsCreated = final.tables.creative_design_versions!.count;
    await seen.beforeReload("paid-image.before-logout-clear");
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); await expect(frameRoot(page)).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
    const remaining = await page.evaluate(prefix => Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter(key => key?.startsWith(prefix)).length, markerPrefix);
    expect(remaining).toBe(0); await seen.settle(false); proof.logoutPrivateUiCleared = true; proof.paidMarkersAfterLogout = remaining;
    verifyTransferNetwork(seen, allowed);
  } catch (error) {
    primary = error; try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5_000 }); proof.failureScreenshot = true; } catch { proof.failureScreenshotFailed = true; }
  } finally {
    if (handler) try { await page.unroute(invokePattern, handler); } catch (error) { primary ??= error; }
    primary = await finish(child, seen, info, proof, primary, allowed);
  }
  if (primary) throw primary;
});
