import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request as BrowserRequest, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { STUDIO_PERSONAL_CLEAR_EVENT, StudioPersonalInvokeSchema, StudioPersonalReplySchema } from "@yummyai/contracts/pod/studio-personal";
import { requireStudioPersonalEnvironment } from "../../../tools/testing/require-studio-personal-environment.mjs";
import type { StudioPersonalBrowserRequest } from "../../../tools/testing/studio-personal-browser.mts";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { syntheticProductionPng } from "./production-editor-fixture.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const Table = z.object({ count: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Facts = z.object({ role: z.string(), tables: z.record(z.string(), Table),
  counts: z.object({ storageReads: z.number(), storageWrites: z.number(), scans: z.number(), originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number() }).strict(),
  ownedObjectCount: z.number().int().nonnegative(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }).strict();
type Facts = z.infer<typeof Facts>;
type NativeRead = { id: number; document: string; start: number; method: string; path: string; urlHash: string; bodyHash: string;
  authorityHash: string; operation: string | null; scope: string | null; namespace: string | null; key: string | null;
  status: number | null; error: string | null; signalAbort: number | null; bytes: number; reads: number; eof: boolean; jsonDone: boolean;
  readerError: string | null; end: number | null; echoHash: string; hashFailed: boolean };
type ClearEvent = { document: string; name: string; at: number; sequence: number };
type ConsumerAudit = { document: string; rows: NativeRead[]; clearEvents: ClearEvent[]; pendingHashes: number };
type AuditWindow = Window & { __studioPersonalAudit?: ConsumerAudit };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function ownerChild(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-personal-browser.mts", import.meta.url)), "--studio-personal-browser-child"], {
    cwd: workspace, env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let next = 0, exited = false, forced = false, closeAcknowledged = false;
  const exit = deferred<{ code: number | null; signal: string | null }>(), waiting = new Map<number, ReturnType<typeof deferred<unknown>>>();
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^(?:studio_personal_(?:browser|fixture)_[a-z_]+|[A-Z0-9]{5})$/) }).strict()]).safeParse(raw);
    if (!packet.success) { for (const value of waiting.values()) value.reject(new Error("studio_personal_child_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return;
    waiting.delete(packet.data.id); if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(new Error(packet.data.errorCode));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_personal_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal });
    for (const pending of waiting.values()) pending.reject(new Error("studio_personal_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext) {
    const id = ++next, pending = deferred<unknown>();
    if (!child.connected || exited) throw new Error("studio_personal_child_channel_closed"); waiting.set(id, pending);
    const packet: StudioPersonalBrowserRequest = operation === "seed"
      ? { id, nonce, operation, context: TenantContextSchema.parse(context) } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_personal_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_personal_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let failure: unknown;
    try { const result = z.object({ closed: z.literal(true) }).strict().parse(await rpc("close")); closeAcknowledged = result.closed; }
    catch (error) { failure = error; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer);
    if (!outcome) { forced = true; child.kill("SIGKILL"); await exit.promise; }
    const proof = { pid: child.pid ?? null, nonce, closeAcknowledged, exited, forced, code: outcome?.code ?? null, signal: outcome?.signal ?? null };
    if (failure || !closeAcknowledged || forced || outcome?.code !== 0) return { ...proof, failed: true };
    return { ...proof, failed: false };
  } };
}

async function current(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json()), operator = actors().operator;
  expect(session.userId).toBe(operator.userId); expect(session.tenantId).toBe(operator.tenantId);
  return { context: TenantContextSchema.parse(session), authority: erpSessionAuthority(session) };
}

async function observe(page: Page) {
  const documents: ConsumerAudit[] = [];
  const retain = (value: ConsumerAudit) => {
    const index = documents.findIndex(old => old.document === value.document); if (index < 0) documents.push(value); else documents[index] = value;
  };
  const Audit = z.object({ document: z.string().uuid(), pendingHashes: z.number().int().nonnegative(),
    clearEvents: z.array(z.object({ document: z.string().uuid(), name: z.enum([AGENT_LOOP_INTENT_CLEAR_EVENT, STUDIO_PERSONAL_CLEAR_EVENT, ASSIST_INTENT_CLEAR_EVENT]), at: z.number(), sequence: z.number().int().positive() }).strict()),
    rows: z.array(z.object({ id: z.number().int().positive(), document: z.string().uuid(), start: z.number(), method: z.string(), path: z.string().regex(/^\/api\//),
      urlHash: z.string(), bodyHash: z.string(), authorityHash: z.string(), echoHash: z.string(), operation: z.string().nullable(), scope: z.string().nullable(), namespace: z.string().nullable(), key: z.string().nullable(),
      status: z.number().nullable(), error: z.string().nullable(), signalAbort: z.number().nullable(), bytes: z.number().nonnegative(), reads: z.number().nonnegative(), eof: z.boolean(), jsonDone: z.boolean(),
      readerError: z.string().nullable(), end: z.number().nullable(), hashFailed: z.boolean() }).strict()),
  }).strict();
  await page.exposeBinding("__studioPersonalEvent", (_source, raw: unknown) => { retain(Audit.parse(raw)); });
  await page.addInitScript(({ clearNames }) => {
    if (window !== window.top) return;
    const state: ConsumerAudit = { document: crypto.randomUUID(), rows: [], clearEvents: [], pendingHashes: 0 };
    (window as AuditWindow).__studioPersonalAudit = state;
    function capture() {
      const binding = (window as unknown as { __studioPersonalEvent?: (value: ConsumerAudit) => Promise<void> }).__studioPersonalEvent;
      if (binding) void binding({ ...state, rows: state.rows.map(value => ({ ...value })), clearEvents: state.clearEvents.map(value => ({ ...value })) }).then(() => {}, () => {});
    }
    const now = () => performance.timeOrigin + performance.now();
    const errorName = (error: unknown) => error && typeof error === "object" && "name" in error
      && ["AbortError", "TypeError", "TimeoutError", "Error"].includes(String(error.name)) ? String(error.name) : "UnknownError";
    const hash = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(value => Array.from(new Uint8Array(value), v => v.toString(16).padStart(2, "0")).join(""));
    function assign(row: NativeRead, key: "urlHash" | "bodyHash" | "authorityHash" | "echoHash", value: string) {
      state.pendingHashes++; void hash(value).then(result => { row[key] = result; state.pendingHashes--; capture(); }, () => { row.hashFailed = true; state.pendingHashes--; capture(); });
    }
    for (const name of clearNames) window.addEventListener(name, () => { state.clearEvents.push({ name, document: state.document, at: now(), sequence: state.clearEvents.length + 1 }); capture(); });
    const responseRows = new WeakMap<Response, NativeRead>(), streams = new WeakMap<ReadableStream, NativeRead>(), readers = new WeakMap<object, NativeRead>();
    const originalFetch = window.fetch, originalJson = Response.prototype.json;
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return originalFetch.call(this, input, init);
      const body = typeof init?.body === "string" ? init.body : "", headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      let coordinates: { operation?: unknown; scope?: unknown; namespace?: unknown; key?: unknown } = {};
      let bodyAuthority = "";
      try { const value = JSON.parse(body) as { request?: typeof coordinates; contextAuthority?: unknown }; coordinates = value.request ?? {}; bodyAuthority = typeof value.contextAuthority === "string" ? value.contextAuthority : ""; } catch { /* No synthetic body is constructed for a GET. */ }
      const row: NativeRead = { id: state.rows.length + 1, document: state.document, start: now(), method: String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
        path: url.pathname, urlHash: "", bodyHash: "", authorityHash: "", operation: typeof coordinates.operation === "string" ? coordinates.operation : null,
        scope: typeof coordinates.scope === "string" ? coordinates.scope : null, namespace: typeof coordinates.namespace === "string" ? coordinates.namespace : null,
        key: typeof coordinates.key === "string" ? coordinates.key : null, status: null, error: null, signalAbort: null, bytes: 0, reads: 0, eof: false,
        jsonDone: false, readerError: null, end: null, echoHash: "", hashFailed: false };
      state.rows.push(row); assign(row, "urlHash", url.href); assign(row, "bodyHash", body); assign(row, "authorityHash", headers.get("x-yummyai-context-authority") ?? bodyAuthority);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (signal?.aborted) row.signalAbort = now(); else signal?.addEventListener("abort", () => { row.signalAbort = now(); capture(); }, { once: true });
      const pending = originalFetch.call(this, input, init);
      void pending.then(response => { row.status = response.status; responseRows.set(response, row);
        if (response.body) streams.set(response.body, row); assign(row, "echoHash", response.headers.get("x-yummyai-context-authority") ?? "");
        capture();
      }, error => { row.error = errorName(error); row.end = now(); capture(); });
      return pending;
    };
    Response.prototype.json = function() {
      const row = responseRows.get(this), pending = originalJson.call(this);
      if (row) void pending.then(() => { row.jsonDone = true; row.end = now(); capture(); }, error => { row.readerError = errorName(error); row.end = now(); capture(); });
      return pending;
    };
    const originalGetReader = ReadableStream.prototype.getReader;
    function trackedGetReader(this: ReadableStream, options: { mode: "byob" }): ReadableStreamBYOBReader;
    function trackedGetReader(this: ReadableStream): ReadableStreamDefaultReader<unknown>;
    function trackedGetReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown>;
    function trackedGetReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown> {
      const reader = originalGetReader.call(this, options), row = streams.get(this);
      if (row) readers.set(reader, row); return reader;
    }
    ReadableStream.prototype.getReader = trackedGetReader;
    const originalRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function() {
      const row = readers.get(this), pending = originalRead.call(this);
      if (row) void pending.then(part => { row.reads++; if (part.done) { row.eof = true; row.end = now(); }
        else if (part.value instanceof Uint8Array) row.bytes += part.value.byteLength; capture();
      }, error => { row.readerError = errorName(error); row.end = now(); capture(); });
      return pending;
    };
  }, { clearNames: [AGENT_LOOP_INTENT_CLEAR_EVENT, STUDIO_PERSONAL_CLEAR_EVENT, ASSIST_INTENT_CLEAR_EVENT] });
  const rows: Array<{ ordinal: number; request: BrowserRequest; method: string; path: string; urlHash: string; bodyHash: string; authorityHash: string;
    operation: string | null; scope: string | null; status: number | null; failed: string | null; valid: boolean }> = [];
  const errors: Array<{ kind: string; hash: string }> = [], consoleErrors: Array<{ at: number; hash: string; path: string; knownLoadAbort: boolean }> = [];
  const owned = (path: string) => path.startsWith("/api/creative-studio/") || path.startsWith("/api/canvas-bridge/");
  page.on("request", request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return;
    const body = request.postData() ?? "", headers = request.headers(), raw = request.postDataJSON.bind(request);
    let operation: string | null = null, scope: string | null = null, valid = true;
    if (url.pathname === "/api/creative-studio/invoke") {
      let value: unknown; try { value = raw(); } catch { valid = false; }
      const parsed = StudioPersonalInvokeSchema.safeParse(value); valid &&= parsed.success;
      if (parsed.success) { operation = parsed.data.request.operation; scope = parsed.data.request.scope;
        valid &&= ["state.get", "state.keys", "state.set", "state.remove", "models", "assets", "asset.preview", "generations", "pillow-runtime"].includes(operation);
        valid &&= parsed.data.contextAuthority === headers["x-yummyai-context-authority"];
      }
      valid &&= request.method() === "POST" && url.search === "";
    } else if (request.method() !== "GET" && url.pathname !== "/api/erp-auth/logout") valid = false;
    rows.push({ ordinal: rows.length + 1, request, method: request.method(), path: url.pathname, urlHash: sha(url.href), bodyHash: sha(body),
      authorityHash: sha(headers["x-yummyai-context-authority"] ?? ""), operation, scope, status: null, failed: null, valid });
  });
  page.on("response", response => {
    const row = rows.find(value => value.request === response.request()); if (row) row.status = response.status();
    if (response.status() >= 400) errors.push({ kind: "http_" + response.status(), hash: sha(new URL(response.url()).pathname) });
  });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request);
    if (row) { const failure = request.failure()?.errorText ?? "unknown"; row.failed = /ERR_ABORTED/.test(failure) ? "ERR_ABORTED" : /ERR_FAILED/.test(failure) ? "ERR_FAILED" : sha(failure); }
  });
  page.on("pageerror", error => errors.push({ kind: "pageerror_" + error.name, hash: sha(error.message) }));
  page.on("console", message => { if (message.type() === "error") {
    const text = message.text(); let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* No query or full URL is retained. */ }
    consoleErrors.push({ at: Date.now(), hash: sha(text), path, knownLoadAbort: /^Failed to load resource: net::ERR_(?:ABORTED|FAILED)$/.test(text) });
  } });
  const snapshot = async () => {
    const value = await page.evaluate(() => (window as AuditWindow).__studioPersonalAudit);
    if (!value) throw new Error("studio_personal_native_audit_missing");
    retain(value);
    return value;
  };
  const settle = async () => {
    await expect.poll(async () => { const value = await snapshot(); return value.pendingHashes === 0 && value.rows.filter(row => owned(row.path)).every(row =>
      row.error !== null || row.readerError !== null || row.eof || row.jsonDone); }, { timeout: 25_000 }).toBe(true);
  };
  return { rows, errors, consoleErrors, documents, snapshot, settle, owned };
}

async function screenshots(page: Page, testInfo: TestInfo, label: string, proof: Record<string, unknown>) {
  const images: Array<{ width: number; height: number; path: string }> = [];
  for (const [width, height] of [[1440, 960], [390, 844]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
      .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)))).toBe(true);
    const editor = page.frameLocator("[data-studio-session] iframe[title]");
    if (await page.locator("[data-studio-session] iframe[title]").count()) {
      await expect.poll(() => editor.locator("body").evaluate(body => body.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)))).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const path = testInfo.outputPath(`${label}-${width}.png`); await page.screenshot({ path, fullPage: false }); images.push({ width: width!, height: height!, path });
  }
  proof[label + "Images"] = images;
}
async function openCanvas(page: Page, scope: string) {
  await page.goto(`/creative-designs/studio/canvas?brief=${scope}`);
  await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(scope);
  await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "真实付费生成暂未启用 可继续读取与保存画布 提示词和已有素材 新图片与视频生成保持关闭" })).toBeVisible();
  const frame = page.frameLocator("[data-studio-session] iframe[title]");
  await expect(frame.getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible(); return frame;
}
function savedValue(page: Page, scope: string, text: string) {
  return page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== "/api/creative-studio/invoke") return false;
    const value = StudioPersonalInvokeSchema.safeParse(response.request().postDataJSON());
    return value.success && value.data.request.operation === "state.set" && value.data.request.scope === scope
      && value.data.request.namespace === "app_state" && JSON.stringify(value.data.request.value).includes(text);
  });
}
async function seed(page: Page, child: ReturnType<typeof ownerChild>, nonce: string) {
  await loginErp(page, "operator", "/navigation");
  const identity = await current(page), packet = z.object({ scope: z.uuidv7(), nonce: z.literal(nonce) }).strict().parse(await child.rpc("seed", identity.context));
  return { ...packet, ...identity };
}
function unchangedPaid(before: Facts, after: Facts) {
  expect(after.role).toBe("yummyai_app");
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"]) expect(after.tables[table]).toEqual(before.tables[table]);
  expect(after.counts.generationCalls).toBe(0); expect(after.counts.dispatchAttempts).toBe(0);
  expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0);
}
function safeNetwork(seen: Awaited<ReturnType<typeof observe>>) { return seen.rows.map(({ request: _request, ...row }) => { void _request; return row; }); }
async function persist(testInfo: TestInfo, proof: Record<string, unknown>) {
  await mkdir(testInfo.outputDir, { recursive: true }); await writeFile(testInfo.outputPath("studio-personal-proof.json"), JSON.stringify(proof, null, 2) + "\n");
}

test("personal_original_canvas_media_lost_save_read_recovery_at_1440_and_390", async ({ page }, testInfo) => {
  const environment = requireStudioPersonalEnvironment(process.env, true), child = ownerChild(environment.nonce), seen = await observe(page);
  const proof: Record<string, unknown> = { nonce: environment.nonce, scope: "real_personal_OIDC_original_owners_sealed_iframe_no_paid_start", primaryFailure: false, cleanupFailed: false };
  let failure: unknown, lostRequest: BrowserRequest | undefined, lostHash = "", committedRevision = 0, lostCount = 0, lostStart = 0, lostSettled = 0;
  const lostCommitted = deferred<void>(), text = "Synthetic personal Studio original text", lostText = "Synthetic personal Studio committed unknown save";
  try {
    const basis = await seed(page, child, environment.nonce), before = Facts.parse(await child.rpc("facts")); proof.source = { scope: basis.scope, authorityHash: sha(basis.authority) }; proof.before = before;
    const frame = await openCanvas(page, basis.scope);
    await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await frame.getByRole("button", { name: "文本", exact: true }).click();
    await frame.locator("[data-node-id]").first().dblclick(); const textSaved = savedValue(page, basis.scope, text);
    await frame.locator("[data-node-id] textarea").fill(text); expect((await textSaved).status()).toBe(200); await seen.settle();
    // Tiny valid original PNG only. This is an upload fixture, not production artwork.
    const png = syntheticProductionPng(240);
    const chooser = page.waitForEvent("filechooser"), imageSaved = savedValue(page, basis.scope, "personal-studio-synthetic.png");
    await frame.getByRole("button", { name: "上传资产", exact: true }).click();
    await (await chooser).setFiles({ name: "personal-studio-synthetic.png", mimeType: "image/png", buffer: png });
    await expect(frame.locator("[data-node-id]").getByRole("img", { name: "personal-studio-synthetic.png", exact: true })).toBeVisible();
    expect((await imageSaved).status()).toBe(200); await seen.settle();
    await page.route("**/api/creative-studio/invoke", async route => {
      const parsed = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (!parsed.success || parsed.data.request.operation !== "state.set" || parsed.data.request.scope !== basis.scope
        || parsed.data.request.namespace !== "app_state" || parsed.data.request.key !== "infinite-canvas:canvas_store"
        || !JSON.stringify(parsed.data.request.value).includes(lostText)) { await route.continue(); return; }
      lostCount++; if (lostCount !== 1) { await route.continue(); return; }
      lostStart = Date.now(); lostRequest = route.request(); lostHash = sha(route.request().postData() ?? "");
      const actual = await route.fetch(); expect(actual.status()).toBe(200);
      const packet = StudioPersonalReplySchema.parse(await actual.json());
      if (packet.operation !== "state.set") throw new Error("studio_personal_save_reply_wrong_operation");
      expect(packet.scope).toBe(basis.scope); expect(packet.contextAuthority).toBe(basis.authority); committedRevision = packet.data.revision;
      await route.abort("aborted"); lostCommitted.resolve();
    });
    // Select the original text through the real layer list before editing beneath the newly selected image.
    await frame.getByRole("complementary").getByRole("button", { name: `文本 ${text}`, exact: true }).click();
    await frame.locator("[data-node-id]").filter({ hasText: text }).dblclick();
    await frame.locator("[data-node-id] textarea").fill(lostText); await lostCommitted.promise;
    await expect(page.getByRole("status").filter({ hasText: "保存结果尚未核对" })).toBeVisible(); lostSettled = Date.now();
    const callCount = seen.rows.filter(row => row.operation === "state.set" && row.bodyHash === lostHash).length;
    await page.getByRole("button", { name: "只读核对保存结果", exact: true }).click();
    await expect(page.getByText("已只读核对原保存结果 未重复写入", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); await seen.settle();
    expect(seen.rows.filter(row => row.operation === "state.set" && row.bodyHash === lostHash).length).toBe(callCount);
    expect(lostCount).toBe(1); expect(committedRevision).toBeGreaterThan(0);
    const prior = await seen.snapshot(); proof.preReloadConsumer = prior;
    await page.reload(); await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
    const restored = page.frameLocator("[data-studio-session] iframe[title]");
    await restored.getByRole("heading", { name: "无限画布 1", exact: true }).click();
    await expect(restored.locator("[data-node-id]").getByText(lostText, { exact: true })).toBeVisible();
    await expect(restored.locator("[data-node-id]").getByRole("img", { name: "personal-studio-synthetic.png", exact: true })).toBeVisible(); await seen.settle();
    await screenshots(page, testInfo, "original-restored-canvas", proof);
    const after = Facts.parse(await child.rpc("facts")); unchangedPaid(before, after); proof.after = after;
    await seen.settle(); const audit = await seen.snapshot();
    const nativeLost = seen.documents.flatMap(value => value.rows).filter(row => row.bodyHash === lostHash);
    expect(nativeLost.length).toBe(1); expect(nativeLost[0]!.bytes).toBe(0); expect(nativeLost[0]!.eof).toBe(false);
    expect(nativeLost[0]!.jsonDone).toBe(false); expect(nativeLost[0]!.error === null).toBe(false);
    const recovered = [...prior.rows, ...audit.rows].filter(row => row.operation === "state.get" && row.scope === basis.scope && row.key === "infinite-canvas:canvas_store"
      && row.start >= lostStart && row.status === 200 && (row.eof || row.jsonDone));
    expect(recovered.length).toBeGreaterThan(0); expect(lostRequest !== undefined).toBe(true);
    proof.lostSave = { bodyHash: lostHash, committedRevision, originalWriteCount: lostCount, originalConsumer: nativeLost[0], recoveryReads: recovered.map(row => ({ id: row.id, document: row.document, eof: row.eof, jsonDone: row.jsonDone })) };
    const unknown = seen.documents.flatMap(value => value.rows).filter(row => seen.owned(row.path) && (row.error || row.readerError) && row.bodyHash !== lostHash);
    expect(unknown.length).toBe(0); expect(seen.rows.every(row => row.valid)).toBe(true); expect(seen.errors).toEqual([]);
    const expectedConsole = seen.consoleErrors.filter(value => value.knownLoadAbort && value.path === "/api/creative-studio/invoke"
      && value.at >= lostStart && value.at <= lostSettled && lostCount === 1
      && seen.rows.filter(row => row.failed && seen.owned(row.path)).every(row => row.request === lostRequest));
    expect(expectedConsole.length).toBeLessThanOrEqual(1); proof.expectedControlledTransportConsole = expectedConsole;
    const unknownConsole = seen.consoleErrors.filter(value => !expectedConsole.includes(value));
    expect(unknownConsole).toEqual([]);
  } catch (error) { failure = error; proof.primaryFailure = true; }
  finally {
    proof.requests = safeNetwork(seen); proof.errors = seen.errors; proof.consoleErrors = seen.consoleErrors; proof.consumer = seen.documents;
    const closed = await child.close(); proof.child = closed; proof.cleanupFailed = closed.failed;
    await persist(testInfo, proof); if (!failure && closed.failed) failure = new Error("studio_personal_child_cleanup_failed");
  }
  if (failure) throw failure;
});

test("personal_logout_CLEAR_rejects_a_held_original_200_and_clears_the_iframe_at_1440_and_390", async ({ page }, testInfo) => {
  const environment = requireStudioPersonalEnvironment(process.env, true), child = ownerChild(environment.nonce), seen = await observe(page);
  const proof: Record<string, unknown> = { nonce: environment.nonce, primaryFailure: false, cleanupFailed: false, scope: "real_original_200_held_then_original_logout_CLEAR" };
  let failure: unknown, release = () => {}, heldRequest: BrowserRequest | undefined, heldHash = "", actualStatus = 0;
  const held = deferred<void>(), released = deferred<void>(); release = () => released.resolve();
  let heldOnce = false, terminal = false, logoutControlStart = 0;
  try {
    const basis = await seed(page, child, environment.nonce), before = Facts.parse(await child.rpc("facts")); proof.before = before;
    const frame = await openCanvas(page, basis.scope); await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await frame.getByRole("button", { name: "文本", exact: true }).click(); await frame.locator("[data-node-id]").first().dblclick();
    const sentinel = "Synthetic private Studio content cleared by original logout";
    const textSaved = savedValue(page, basis.scope, sentinel);
    await frame.locator("[data-node-id] textarea").fill(sentinel); expect((await textSaved).status()).toBe(200); await seen.settle();
    await screenshots(page, testInfo, "private-canvas-before-clear", proof); await seen.settle(); await seen.snapshot();
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.route("**/api/creative-studio/invoke", async route => {
      const input = StudioPersonalInvokeSchema.safeParse(route.request().postDataJSON());
      if (heldOnce || !input.success || input.data.request.operation !== "state.get" || input.data.request.scope !== basis.scope
        || input.data.request.namespace !== "app_state" || input.data.request.key !== "infinite-canvas:canvas_store") { await route.continue(); return; }
      heldOnce = true; heldRequest = route.request(); heldHash = sha(route.request().postData() ?? "");
      const actual = await route.fetch(); actualStatus = actual.status(); expect(actualStatus).toBe(200);
      const packet = StudioPersonalReplySchema.parse(await actual.json()); expect(packet.operation).toBe("state.get"); expect(packet.scope).toBe(basis.scope);
      expect(packet.contextAuthority).toBe(basis.authority); held.resolve(); await released.promise;
      try { await route.fulfill({ response: actual }); proof.heldDelivery = "original_response_released"; }
      catch { if (!terminal) throw new Error("studio_personal_held_response_release_failed"); proof.heldDelivery = "original_route_already_cancelled_after_CLEAR"; }
    });
    await page.reload({ waitUntil: "domcontentloaded" }); await held.promise;
    const auditBefore = await seen.snapshot(); const writeBoundary = seen.rows.filter(row => ["state.set", "state.remove"].includes(row.operation ?? "")).length;
    logoutControlStart = await page.evaluate(() => performance.timeOrigin + performance.now());
    await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.locator("[data-studio-session] iframe[title]")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible();
    terminal = true; release(); await seen.settle();
    await expect.poll(() => seen.documents.some(value => value.clearEvents.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutControlStart)
      && value.rows.some(row => row.bodyHash === heldHash && (row.error === "AbortError" || row.readerError === "AbortError")))).toBe(true);
    const cleared = seen.documents.find(value => value.clearEvents.some(event => event.name === STUDIO_PERSONAL_CLEAR_EVENT && event.at >= logoutControlStart) && value.rows.some(row => row.bodyHash === heldHash));
    if (!cleared) throw new Error("studio_personal_original_CLEAR_document_missing");
    const events = cleared.clearEvents.filter(value => value.name === STUDIO_PERSONAL_CLEAR_EVENT && value.at >= logoutControlStart);
    expect(events.length).toBeGreaterThan(0); expect(await page.evaluate(() => sessionStorage.getItem("yummyai.studio.scope"))).toBeNull();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("yummyai.studio.scope:")).length)).toBe(0);
    const row = cleared.rows.filter(value => value.bodyHash === heldHash && value.document === cleared.document);
    expect(row.length).toBe(1); const original = row[0]!;
    expect(original.method).toBe("POST"); expect(original.operation).toBe("state.get"); expect(original.scope).toBe(basis.scope);
    expect(original.authorityHash).toBe(sha(basis.authority)); expect(original.error === "AbortError" || original.readerError === "AbortError").toBe(true);
    expect(original.signalAbort === null).toBe(false); expect(original.bytes).toBe(0); expect(original.reads).toBe(0);
    expect(original.eof).toBe(false); expect(original.jsonDone).toBe(false); expect(actualStatus).toBe(200); expect(heldRequest !== undefined).toBe(true);
    const firstClear = Math.min(...cleared.clearEvents.filter(value => value.at >= logoutControlStart).map(value => value.at));
    expect(cleared.rows.filter(value => value.path.startsWith("/api/") && !value.path.startsWith("/api/erp-auth/") && value.start >= firstClear).length).toBe(0);
    const origin = new URL(page.url()).origin, emptyBody = sha("");
    const exactClearRead = (value: NativeRead) => value.method === "POST" && value.path === "/api/creative-studio/invoke" && value.scope === basis.scope
      && ["state.get", "state.keys", "models", "assets", "asset.preview", "generations", "pillow-runtime"].includes(value.operation ?? "")
      || value.method === "GET" && value.bodyHash === emptyBody && (
        value.urlHash === sha(new URL(`/api/creative-studio/workspace?scope=${basis.scope}`, origin).href)
        || value.urlHash === sha(new URL("/api/canvas-bridge/projects", origin).href)
        || value.urlHash === sha(new URL(`/api/canvas-bridge/briefs/${basis.scope}`, origin).href));
    const terminalPairs = cleared.rows.filter(value => seen.owned(value.path) && (value.error || value.readerError)).map(value => ({
      row: value, matches: exactClearRead(value) && value.document === cleared.document && value.start < firstClear && value.authorityHash === sha(basis.authority)
        && value.signalAbort !== null && value.signalAbort >= firstClear && (value.error === "AbortError" || value.readerError === "AbortError")
        && value.bytes === 0 && value.reads === 0 && !value.eof && !value.jsonDone,
    }));
    expect(terminalPairs.every(value => value.matches)).toBe(true);
    expect(seen.rows.filter(value => ["state.set", "state.remove"].includes(value.operation ?? "")).length).toBe(writeBoundary);
    expect(await page.locator("iframe[title]").count()).toBe(0); expect(await page.getByText(sentinel, { exact: true }).count()).toBe(0);
    proof.terminalClearPairs = terminalPairs; proof.clearEvents = cleared.clearEvents;
    proof.businessReadBegins = cleared.rows.map(value => ({ document: value.document, id: value.id, path: value.path, start: value.start }));
    proof.originalReadBeforeClear = auditBefore.rows.find(value => value.bodyHash === heldHash);
    const after = Facts.parse(await child.rpc("facts")); unchangedPaid(before, after); proof.after = after;
    await screenshots(page, testInfo, "cleared-original-session", proof);
    expect(seen.rows.every(value => value.valid)).toBe(true); expect(seen.errors).toEqual([]); expect(seen.consoleErrors).toEqual([]);
  } catch (error) { failure = error; proof.primaryFailure = true; }
  finally {
    release(); proof.requests = safeNetwork(seen); proof.consumer = seen.documents; proof.errors = seen.errors; proof.consoleErrors = seen.consoleErrors;
    const closed = await child.close(); proof.child = closed; proof.cleanupFailed = closed.failed;
    await persist(testInfo, proof); if (!failure && closed.failed) failure = new Error("studio_personal_child_cleanup_failed");
  }
  if (failure) throw failure;
});

test("personal_default_unassigned_and_five_native_tools_keep_the_original_iframe_at_1440_and_390", async ({ page }, testInfo) => {
  const environment = requireStudioPersonalEnvironment(process.env, true), child = ownerChild(environment.nonce), seen = await observe(page);
  const proof: Record<string, unknown> = { nonce: environment.nonce, primaryFailure: false, cleanupFailed: false,
    scope: "real_personal_default_workspace_and_natural_five_tool_navigation_no_paid_generation" };
  let failure: unknown;
  try {
    const { StudioWorkspaceSchema } = await import("@yummyai/contracts/pod/studio-personal");
    await page.setViewportSize({ width: 1440, height: 960 });
    const basis = await seed(page, child, environment.nonce), before = Facts.parse(await child.rpc("facts")); proof.before = before;
    proof.source = { scope: basis.scope, authorityHash: sha(basis.authority) };
    const workspaceRead = (selected: string) => page.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === "GET" && url.pathname === "/api/creative-studio/workspace" && url.search === `?scope=${selected}`;
    }).then(async response => {
      expect(response.status()).toBe(200);
      expect(response.headers()["x-yummyai-context-authority"]).toBe(basis.authority);
      const value = StudioWorkspaceSchema.parse(await response.json());
      expect(value.scope).toBe(selected); expect(value.contextAuthority).toBe(basis.authority);
      expect(value.capabilities.read).toBe(true); expect(value.generation).toEqual({ enabled: false, code: "operator_paused" });
      return value;
    });
    const initialWorkspace = workspaceRead("unassigned");
    await page.goto("/creative-designs/studio/canvas");
    const unassigned = await initialWorkspace;
    await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue("unassigned");
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); await seen.settle();
    await expect(page.frameLocator("[data-studio-session] iframe[title]").getByRole("button", { name: "新建画布", exact: true }).first()).toBeVisible();
    const initialFrameSource = await page.locator("[data-studio-session] iframe[title]").getAttribute("src");
    expect(initialFrameSource !== null).toBe(true);
    await expect.poll(() => seen.rows.some(row => row.operation === "state.get" && row.scope === "unassigned")).toBe(true); await seen.settle();
    proof.defaultWorkspace = { scope: unassigned.scope, authorityHash: sha(unassigned.contextAuthority), capabilities: unassigned.capabilities,
      generation: unassigned.generation, iframeSourceHash: sha(initialFrameSource!) };

    // Scope selection is a real new boundary. The subsequent five ordinary
    // navigation links deliberately omit brief; do not synthesize a query for them.
    const selectedWorkspace = workspaceRead(basis.scope);
    await page.getByRole("combobox", { name: "创作归属", exact: true }).selectOption(basis.scope);
    const selected = await selectedWorkspace;
    expect(selected.capabilities.save).toBe(true); expect(selected.capabilities.mediaWrite).toBe(true);
    await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(basis.scope);
    await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible(); await seen.settle();
    const iframe = page.locator("[data-studio-session] iframe[title]"), original = await iframe.elementHandle();
    if (!original) throw new Error("studio_personal_original_iframe_missing");
    const source = await iframe.getAttribute("src");
    expect(source !== initialFrameSource).toBe(true);
    let laterFrameNavigations = 0;
    page.on("framenavigated", frame => { if (frame.parentFrame() === page.mainFrame()) laterFrameNavigations++; });
    const frame = page.frameLocator("[data-studio-session] iframe[title]");
    const text = "Synthetic five-tool retained original canvas", fileName = "five-tools-original.png", promptTitle = "Synthetic five-tool original prompt";
    const promptContent = "Synthetic original operator prompt with no provider call";
    await frame.getByRole("button", { name: "新建画布", exact: true }).first().click();
    await frame.getByRole("button", { name: "文本", exact: true }).click(); await frame.locator("[data-node-id]").first().dblclick();
    const textSaved = savedValue(page, basis.scope, text);
    await frame.locator("[data-node-id] textarea").fill(text); expect((await textSaved).status()).toBe(200); await seen.settle();
    const png = syntheticProductionPng(240), chooser = page.waitForEvent("filechooser"), imageSaved = savedValue(page, basis.scope, fileName);
    const mediaSaved = page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== "/api/creative-studio/invoke") return false;
      const input = StudioPersonalInvokeSchema.safeParse(response.request().postDataJSON());
      return input.success && input.data.request.operation === "state.set"
        && input.data.request.scope === basis.scope && input.data.request.namespace === "image_files" && input.data.request.media?.mediaType === "image/png";
    }).then(async response => {
      expect(response.status()).toBe(200);
      const input = StudioPersonalInvokeSchema.parse(response.request().postDataJSON()), packet = StudioPersonalReplySchema.parse(await response.json());
      if (input.request.operation !== "state.set" || packet.operation !== "state.set" || !packet.data.assetId) throw new Error("studio_personal_original_upload_coordinates_invalid");
      expect(packet.scope).toBe(basis.scope); expect(packet.contextAuthority).toBe(basis.authority);
      return { assetId: packet.data.assetId, key: input.request.key };
    });
    await frame.getByRole("button", { name: "上传资产", exact: true }).click();
    await (await chooser).setFiles({ name: fileName, mimeType: "image/png", buffer: png });
    expect((await imageSaved).status()).toBe(200); const media = await mediaSaved;
    await expect.poll(() => frame.locator("[data-node-id]").getByRole("img", { name: fileName, exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
    await seen.settle(); proof.syntheticMediaSha256 = sha(png);
    await expect(page.locator(".studio-page-header").getByRole("link", { name: "AI 模型配置", exact: true })).toHaveCount(selected.capabilities.configure ? 1 : 0);
    const assetList = page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== "/api/creative-studio/invoke") return false;
      const input = StudioPersonalInvokeSchema.safeParse(response.request().postDataJSON());
      return input.success && input.data.request.operation === "assets" && input.data.request.scope === basis.scope;
    }).then(async response => {
      expect(response.status()).toBe(200);
      const packet = StudioPersonalReplySchema.parse(await response.json());
      if (packet.operation !== "assets") throw new Error("studio_personal_asset_projection_wrong_operation");
      expect(packet.scope).toBe(basis.scope); expect(packet.contextAuthority).toBe(basis.authority);
      return packet.data;
    });
    await page.getByRole("button", { name: "素材与审核", exact: true }).click();
    const records = page.getByRole("region", { name: "素材与审核", exact: true });
    const matching = (await assetList).filter(asset => asset.assetId === media.assetId && asset.key === media.key);
    expect(matching.length).toBe(1); const uploaded = matching[0]; if (!uploaded) throw new Error("studio_personal_original_upload_not_listed");
    await expect(records.getByText(uploaded.fileName, { exact: true })).toBeVisible(); await seen.settle();
    const assetRow = records.locator(".studio-record").filter({ hasText: uploaded.fileName });
    await expect(assetRow.getByRole("button", { name: "审核", exact: true })).toHaveCount(selected.capabilities.review ? 1 : 0);
    if (selected.capabilities.review) {
      await assetRow.getByRole("button", { name: "审核", exact: true }).click();
      await expect(records.getByRole("checkbox", { name: "我已核对素材内容及使用权，可用于当前创作。", exact: true })).not.toBeChecked();
      await expect(records.getByRole("button", { name: "批准作为参考素材", exact: true })).toBeDisabled();
      await records.getByRole("button", { name: "取消", exact: true }).click();
    }
    await records.getByRole("button", { name: "关闭记录面板", exact: true }).click(); await expect(records).toHaveCount(0); await seen.settle();
    proof.originalMedia = { assetId: media.assetId, key: media.key, fileNameHash: sha(uploaded.fileName) };
    const tools = [["image", "生图工作台"], ["video", "视频创作台"], ["canvas", "我的画布"], ["prompts", "提示词库"], ["assets", "我的资产"]] as const;
    const layouts: Array<Record<string, unknown>> = [];
    async function switchTool(tool: typeof tools[number][0], title: typeof tools[number][1], mobile: boolean) {
      await seen.settle();
      let navigation = page.locator(".erp-sidebar");
      if (mobile) {
        await page.getByRole("button", { name: "打开全部导航", exact: true }).click();
        navigation = page.getByRole("dialog", { name: "全部导航", exact: true });
        await expect(navigation).toBeVisible(); await seen.settle();
      }
      const group = navigation.getByRole("group", { name: "业务模块", exact: true }).getByRole("button", { name: "创作工具", exact: true });
      if (await group.getAttribute("aria-expanded") !== "true") await group.click();
      const link = navigation.getByRole("navigation", { name: "主导航", exact: true }).getByRole("link", { name: title, exact: true });
      await expect(link).toHaveAttribute("href", `/creative-designs/studio/${tool}`);
      await link.focus(); await expect(link).toBeFocused(); await seen.settle(); await link.click();
      await expect(page).toHaveURL(url => url.pathname === `/creative-designs/studio/${tool}` && !url.searchParams.has("brief"));
      if (mobile) await expect(page.getByRole("dialog", { name: "全部导航", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
      await expect(page.getByRole("combobox", { name: "创作归属", exact: true })).toHaveValue(basis.scope);
      await expect(iframe).toHaveAttribute("src", source!); expect(await original!.evaluate(element => element.isConnected)).toBe(true);
      await expect(page.getByRole("status").filter({ hasText: "自动保存已开启" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "真实付费生成暂未启用 可继续读取与保存画布 提示词和已有素材 新图片与视频生成保持关闭" })).toBeVisible();
      await expect(frame.getByRole("status").filter({ hasText: "生成已暂停 你可以继续编辑 保存和管理素材" })).toBeVisible();
      if (tool === "image" || tool === "video") {
        await frame.locator(".studio-workbench main textarea").first().fill(`Synthetic ${tool} draft without paid execution`);
        await expect(frame.getByRole("button", { name: "开始生成", exact: true })).toBeDisabled();
      } else if (tool === "canvas") {
        await expect(frame.locator("[data-node-id]").getByText(text, { exact: true })).toBeVisible();
        await expect.poll(() => frame.locator("[data-node-id]").getByRole("img", { name: fileName, exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(240);
        if (mobile) {
          // Reset means center at 100%, not fit. Use the original zoom slider to view the desktop document on a phone.
          await frame.getByRole("button", { name: "重置视图", exact: true }).click();
          const zoom = frame.getByRole("slider", { name: "放大/缩小画布", exact: true });
          await expect(zoom).toHaveValue("100"); await zoom.focus(); await zoom.press("Home");
          for (let step = 0; step < 20; step++) await zoom.press("ArrowRight");
          await expect(zoom).toHaveValue("25");
          await expect.poll(() => frame.locator("[data-node-id]").evaluateAll(nodes => nodes.length === 2 && nodes.every(node => {
            const rect = node.getBoundingClientRect();
            return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
          }))).toBe(true);
        }
      } else if (tool === "prompts") {
        await expect(frame.getByLabel("名称", { exact: true })).toBeVisible();
        if (!mobile) {
          await frame.getByLabel("名称", { exact: true }).fill(promptTitle);
          await frame.getByRole("textbox", { name: "提示词内容", exact: true }).fill(promptContent);
          const saved = savedValue(page, basis.scope, promptTitle);
          await frame.getByRole("button", { name: "保存提示词", exact: true }).click(); expect((await saved).status()).toBe(200);
        }
        const savedPrompt = frame.getByRole("button", { name: promptTitle, exact: true });
        await expect(savedPrompt).toBeVisible(); await savedPrompt.click();
        await expect(frame.getByLabel("名称", { exact: true })).toHaveValue(promptTitle);
        await expect(frame.getByRole("textbox", { name: "提示词内容", exact: true })).toHaveValue(promptContent);
      } else {
        await expect(frame.getByText(promptTitle, { exact: true }).first()).toBeVisible();
        const image = frame.getByRole("img", { name: fileName, exact: true }).or(frame.getByRole("img", { name: uploaded.fileName, exact: true })).first();
        await expect.poll(() => image.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      }
      await seen.settle();
    }
    async function captureLayout(tool: typeof tools[number][0], width: number, height: number) {
      await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)))).toBe(true);
      await expect.poll(() => frame.locator("body").evaluate(body => body.getAnimations({ subtree: true }).filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)))).toBe(true);
      await iframe.scrollIntoViewIfNeeded(); await seen.settle();
      const outer = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
      const inner = await frame.locator("body").evaluate(body => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: body.scrollWidth }));
      expect(outer.width).toBe(width); expect(outer.height).toBe(height); expect(outer.scrollWidth).toBeLessThanOrEqual(width + 1);
      expect(inner.width).toBeGreaterThan(0); expect(inner.scrollWidth).toBeLessThanOrEqual(inner.width + 1); expect(inner.bodyScrollWidth).toBeLessThanOrEqual(inner.width + 1);
      const controls = width === 390 && (tool === "image" || tool === "video")
        ? await frame.locator(".studio-workbench main > section > div").first().locator("textarea, button").evaluateAll(elements => elements
          .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden")
          .map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; })) : [];
      if (width === 390 && (tool === "image" || tool === "video")) {
        expect(controls.length).toBeGreaterThan(1);
        expect(controls.every(control => control.width > 0 && control.left >= 0 && control.right <= inner.width + 1)).toBe(true);
      }
      const screenshot = testInfo.outputPath(`five-tools-${tool}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: false }); layouts.push({ tool, width, height, outer, inner, controls, screenshot });
    }
    for (const [tool, title] of tools) { await switchTool(tool, title, false); await captureLayout(tool, 1440, 960); }
    await page.setViewportSize({ width: 390, height: 844 }); await seen.settle();
    for (const [tool, title] of tools) { await switchTool(tool, title, true); await captureLayout(tool, 390, 844); }
    await switchTool("canvas", "我的画布", true); await seen.settle();
    expect(laterFrameNavigations).toBe(0); expect(await original.evaluate(element => element.isConnected)).toBe(true);
    expect(seen.rows.some(row => ["generate", "generation.get", "asset.review", "result.submit"].includes(row.operation ?? ""))).toBe(false);
    const audit = await seen.snapshot();
    expect(seen.documents.flatMap(document => document.rows).filter(row => seen.owned(row.path) && (row.error || row.readerError))).toEqual([]);
    expect(seen.rows.every(row => row.valid && row.failed === null)).toBe(true); expect(seen.errors).toEqual([]); expect(seen.consoleErrors).toEqual([]);
    const after = Facts.parse(await child.rpc("facts")); unchangedPaid(before, after); proof.after = after;
    proof.layouts = layouts; proof.selectedCapabilities = selected.capabilities; proof.laterFrameNavigations = laterFrameNavigations;
    proof.originalIframeSourceHash = sha(source!); proof.consumerAtFinish = audit;
  } catch (error) { failure = error; proof.primaryFailure = true; }
  finally {
    proof.requests = safeNetwork(seen); proof.consumer = seen.documents; proof.errors = seen.errors; proof.consoleErrors = seen.consoleErrors;
    const closed = await child.close(); proof.child = closed; proof.cleanupFailed = closed.failed;
    await persist(testInfo, proof); if (!failure && closed.failed) failure = new Error("studio_personal_child_cleanup_failed");
  }
  if (failure) throw failure;
});
