import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page, type Request, type Response as PlaywrightResponse, type Route, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpContextAuthoritySchema, ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { CreativeResponseAdoptionCancelSchema, CreativeResponseAdoptionCommandSchema,
  CreativeResponseAdoptionRequestViewSchema, CreativeResponseAdoptionWorkspaceSchema } from "@yummyai/contracts/harness/creative-response-adoption";
import { CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX } from "../src/features/execution/creative-response-adoption-intent";
import { requireCreativeResponseAdoptionEnvironment } from "../../../tools/testing/creative-response-adoption-environment.mjs";
import type { CreativeResponseAdoptionBrowserRequest } from "../../../tools/testing/creative-response-adoption-browser.mjs";
import { STUDIO_DOCUMENT_TRANSFER_BROWSER_LOCK_SHA256 } from "../../../tools/testing/require-studio-document-transfer-browser-lock.mjs";
import { P2_CI_BROWSER_REGISTRY_SHA256, requireP2BrowserLock } from "../../../tools/testing/require-p2-browser-lock.mjs";
import { actors, loginErp } from "./erp-identity-fixture.js";
import { deferred, originalScreenshot, originalSha } from "./studio-original-helpers.js";

const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Seed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), executionId: Id, candidateId: Id, batchId: Id, basis: Hash,
  identityStamp: Hash, responseChecksum: Hash, artifactChecksum: Hash, imageBytes: z.number().int().positive(), width: z.literal(240), height: z.literal(160),
  originalPhase: z.enum(["failed", "uncertain"]), authorityHash: Hash }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), hash: Hash }).strict();
const Facts = z.object({ role: z.literal("yummyai_app"), execution: z.object({ id: Id, phase: z.string(), sha256: Hash, inputFingerprint: Hash,
  responseChecksum: Hash.nullable(), encryptedChecksum: Hash.nullable(), originalCostUsd: z.string().nullable() }).strict(),
  archive: z.object({ sha256: Hash, objectKeySha256: Hash, byteSize: z.number().int().positive() }).strict(),
  budget: z.object({ count: z.number().int().nonnegative(), sha256: Hash }).strict(),
  batch: z.object({ id: Id, status: z.string(), archived: z.boolean() }).strict(),
  candidates: z.array(z.object({ id: Id, status: z.string(), assetId: Id.nullable(), assetVersion: z.number().nullable(), checksumSha256: Hash.nullable(),
    modelKey: z.string().nullable(), modelVersion: z.string().nullable() }).strict()),
  versions: z.object({ count: z.number().int().nonnegative(), sha256: Hash }).strict(), requests: z.array(CreativeResponseAdoptionRequestViewSchema),
  assets: z.array(z.object({ id: Id, checksumSha256: Hash.nullable(), actualSha256: Hash, byteSize: z.number().int().positive(), actualByteSize: z.number().int().positive(),
    mediaType: z.string(), rightsStatus: z.string(), aiGenerated: z.boolean(), version: z.number().int().positive() }).strict()),
  tables: z.record(z.string(), Table), originalDispatches: z.number().int().nonnegative(), forbiddenDispatches: z.literal(0) }).strict();
type Fact = z.infer<typeof Facts>;
type Basis = z.infer<typeof Seed>;
const CleanupPhases = z.array(z.enum(["authority", "owner_cleanup", "verification", "database_close"])).max(4);
const Cleanup = z.object({ role: z.literal("yummyai_app"), batchId: Id, status: z.literal("cancelled"), archived: z.literal(true), originalExecutionExact: z.literal(true),
  originalBudgetExact: z.literal(true), originalArchiveVerifiedBeforeOwnerClose: Facts.shape.archive, retainedOriginalExecutions: z.literal(1),
  retainedAdoptionHistory: z.number().int().nonnegative(), remainingPreparedOrProcessing: z.literal(0), registeredAssetsRetainedUntilOuterNonceDeletion: z.number().int().nonnegative(),
  forbiddenDispatches: z.literal(0) }).strict();
const adoptionPattern = /^\/api\/creative-executions\/[0-9a-f-]+\/response-adoption(?:s(?:\/by-request\/[0-9a-f-]+|\/[0-9a-f-]+\/cancel)?|\/preview)?$/;

function childFor(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/creative-response-adoption-browser.mts", import.meta.url)), "--creative-response-adoption-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let next = 0, exited = false;
  const waiting = new Map<number, ReturnType<typeof deferred<unknown>>>(), exit = deferred<{ code: number | null; signal: string | null }>();
  child.on("message", (raw: unknown) => {
    const parsed = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^creative_adoption_(?:browser|fixture)_[a-z_]+$/), cleanupPhases: CleanupPhases }).strict()]).safeParse(raw);
    if (!parsed.success) { for (const pending of waiting.values()) pending.reject(new Error("creative_adoption_child_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(parsed.data.id); if (!pending) return; waiting.delete(parsed.data.id);
    if (parsed.data.ok) pending.resolve(parsed.data.result); else pending.reject(Object.assign(new Error(parsed.data.errorCode), { cleanupPhases: parsed.data.cleanupPhases }));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("creative_adoption_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const pending of waiting.values()) pending.reject(new Error("creative_adoption_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "cancel-parent" | "close", context?: TenantContext, scenario: "adopt" | "clear" = "adopt") {
    if (!child.connected || exited) throw new Error("creative_adoption_child_closed");
    const id = ++next, pending = deferred<unknown>(); waiting.set(id, pending);
    const packet: CreativeResponseAdoptionBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.parse(context), scenario } : { id, nonce, operation };
    child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("creative_adoption_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("creative_adoption_child_timeout")); }, 90_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let acknowledged = false, cleanup: z.infer<typeof Cleanup> | undefined, cleanupPhases: z.infer<typeof CleanupPhases> = [];
    try { const reply = z.object({ closed: z.literal(true), cleanup: Cleanup }).strict().parse(await rpc("close")); acknowledged = true; cleanup = reply.cleanup; }
    catch (error) { if (error && typeof error === "object" && "cleanupPhases" in error) { const parsed = CleanupPhases.safeParse(error.cleanupPhases); if (parsed.success) cleanupPhases = parsed.data; } }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminal = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); if (!terminal) { child.kill("SIGKILL"); await exit.promise; }
    return { nonce, pid: child.pid ?? null, acknowledged, cleanup, cleanupPhases, exited, code: terminal?.code ?? null, forced: !terminal,
      failed: !acknowledged || !terminal || terminal.code !== 0 };
  } };
}
type Child = ReturnType<typeof childFor>;
async function facts(child: Child) { return Facts.parse(await child.rpc("facts")); }
const panelFor = (page: Page, basis: Basis) => page.getByRole("region", { name: "原响应安全采用", exact: true }).and(page.locator(`[data-execution-id="${basis.executionId}"]`));

type NativeRead = { id: number; document: number; start: number; phase: string; path: string; method: string; bodyHash: string; authorityHash: string;
  status: number | null; signalAbort: number | null; bytes: number; reads: number; eof: boolean; jsonDone: boolean; error: string | null; readerError: string | null };
type Audit = { document: number; pendingHashes: number; phase: string; rows: NativeRead[]; events: Array<{ name: string; at: number; completedAt: number | null }> };
type AuditWindow = Window & { __creativeAdoptionAudit?: Audit };
async function observe(page: Page) {
  let phase = "boot", pinnedAuthorityHash: string | undefined;
  const documents = new Map<number, Audit>(), phases: Array<{ phase: string; hostIndex: number }> = [], barriers: unknown[] = [];
  await page.exposeBinding("__creativeAdoptionCapture", ({ frame }, state: Audit) => { if (frame === page.mainFrame()) documents.set(state.document, state); });
  await page.addInitScript(({ names }) => {
    if (window !== window.top) return;
    const audit: Audit = { document: performance.timeOrigin, pendingHashes: 0, phase: "document-start", rows: [], events: [] };
    (window as AuditWindow).__creativeAdoptionAudit = audit;
    const now = () => performance.timeOrigin + performance.now();
    const capture = () => { const emit = (window as unknown as { __creativeAdoptionCapture?: (value: Audit) => Promise<void> }).__creativeAdoptionCapture;
      if (emit) void emit({ ...audit, rows: audit.rows.map(row => ({ ...row })), events: audit.events.map(row => ({ ...row })) }).then(() => {}, () => {}); };
    const error = (value: unknown) => value && typeof value === "object" && "name" in value ? String(value.name) : "UnknownError";
    const hash = (row: NativeRead, field: "bodyHash" | "authorityHash", value: string) => { audit.pendingHashes++;
      void crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(result => { row[field] = Array.from(new Uint8Array(result), part => part.toString(16).padStart(2, "0")).join("");
        audit.pendingHashes--; capture(); }, () => { row.error = "HashError"; audit.pendingHashes--; capture(); }); };
    for (const name of names) window.addEventListener(name, () => {
      const event: Audit["events"][number] = { name, at: now(), completedAt: null }; audit.events.push(event); capture();
      // The first microtask after the synchronous event listeners gives an
      // observed completion fence, rather than assuming CLEAR must start first.
      queueMicrotask(() => { event.completedAt = now(); capture(); });
    });
    const responses = new WeakMap<Response, NativeRead>(), streams = new WeakMap<ReadableStream, NativeRead>(), readers = new WeakMap<object, NativeRead>();
    const fetchOriginal = window.fetch, jsonOriginal = Response.prototype.json;
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || !/^\/api\/creative-executions\/[0-9a-f-]+\/response-adoption(?:s(?:\/by-request\/[0-9a-f-]+|\/[0-9a-f-]+\/cancel)?|\/preview)?$/.test(url.pathname)) return fetchOriginal.call(this, input, init);
      const row: NativeRead = { id: audit.rows.length + 1, document: audit.document, start: now(), phase: audit.phase, path: url.pathname,
        method: init?.method ?? (input instanceof Request ? input.method : "GET"), bodyHash: "", authorityHash: "", status: null, signalAbort: null,
        bytes: 0, reads: 0, eof: false, jsonDone: false, error: null, readerError: null };
      audit.rows.push(row); hash(row, "bodyHash", typeof init?.body === "string" ? init.body : "");
      hash(row, "authorityHash", new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-yummyai-context-authority") ?? "");
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (signal?.aborted) row.signalAbort = now(); else signal?.addEventListener("abort", () => { row.signalAbort = now(); capture(); }, { once: true });
      const pending = fetchOriginal.call(this, input, init);
      void pending.then(response => { row.status = response.status; responses.set(response, row); if (response.body) streams.set(response.body, row); capture(); }, cause => { row.error = error(cause); capture(); });
      return pending;
    };
    Response.prototype.json = function() { const row = responses.get(this), pending = jsonOriginal.call(this);
      if (row) void pending.then(() => { row.jsonDone = true; capture(); }, cause => { row.readerError = error(cause); capture(); }); return pending; };
    const getReaderOriginal = ReadableStream.prototype.getReader;
    function reader(this: ReadableStream, options: { mode: "byob" }): ReadableStreamBYOBReader;
    function reader(this: ReadableStream): ReadableStreamDefaultReader<unknown>;
    function reader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown>;
    function reader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown> {
      const result = getReaderOriginal.call(this, options), row = streams.get(this); if (row) readers.set(result, row); return result;
    }
    ReadableStream.prototype.getReader = reader;
    const readOriginal = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function() { const row = readers.get(this), pending = readOriginal.call(this);
      if (row) void pending.then(part => { row.reads++; if (part.done) row.eof = true; else if (part.value instanceof Uint8Array) row.bytes += part.value.byteLength; capture(); },
        cause => { row.readerError = error(cause); capture(); }); return pending; };
  }, { names: [ASSIST_INTENT_CLEAR_EVENT, STUDIO_PERSONAL_CLEAR_EVENT] });
  const rows: Array<{ request: Request; index: number; phase: string; method: string; path: string; bodyHash: string; authorityHash: string; authorityValid: boolean | null; valid: boolean;
    status: number | null; startedObservedAt: number; playwrightStartedAt: number; finishedAt: number | null; failedAt: number | null; finished: boolean; failed: string | null }> = [];
  const errors: Array<{ kind: string; hash: string }> = [], consoles: Array<{ path: string; exactLoadFailure: boolean; hash: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return;
    const method = request.method(); let valid = method === "GET";
    let body: unknown;
    try { if (method === "POST" && adoptionPattern.test(url.pathname)) body = request.postDataJSON(); } catch { /* Malformed commands fail the strict row gate. */ }
    if (method === "POST" && /\/response-adoptions$/.test(url.pathname)) valid = adoptionPattern.test(url.pathname) && CreativeResponseAdoptionCommandSchema.safeParse(body).success && !url.search;
    else if (method === "POST" && /\/response-adoptions\/[0-9a-f-]+\/cancel$/.test(url.pathname)) valid = adoptionPattern.test(url.pathname) && CreativeResponseAdoptionCancelSchema.safeParse(body).success && !url.search;
    else if (method === "POST" && url.pathname === "/api/erp-auth/logout") valid = !url.search;
    const authority = request.headers()["x-yummyai-context-authority"], authorityHash = originalSha(authority ?? ""); let authorityValid: boolean | null = null;
    if (adoptionPattern.test(url.pathname)) {
      authorityValid = ErpContextAuthoritySchema.safeParse(authority).success;
      valid &&= authorityValid && pinnedAuthorityHash !== undefined && authorityHash === pinnedAuthorityHash;
    }
    rows.push({ request, index: rows.length, phase, method, path: url.pathname, bodyHash: originalSha(request.postData() ?? ""),
      authorityHash, authorityValid, valid, status: null, startedObservedAt: Date.now(),
      playwrightStartedAt: request.timing().startTime, finishedAt: null, failedAt: null, finished: false, failed: null });
  });
  page.on("requestfinished", request => { const row = rows.find(row => row.request === request); if (row) { row.finished = true; row.finishedAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(row => row.request === request); if (row) { row.failed = request.failure()?.errorText ?? "unknown"; row.failedAt = Date.now(); } });
  page.on("response", response => { const row = rows.find(row => row.request === response.request()); if (row) row.status = response.status();
    if (response.status() >= 400) errors.push({ kind: "http_" + response.status(), hash: originalSha(new URL(response.url()).pathname) }); });
  page.on("pageerror", cause => errors.push({ kind: "pageerror_" + cause.name, hash: originalSha(cause.message) }));
  page.on("console", message => { if (message.type() !== "error") return; let path = "";
    try { path = new URL(message.location().url).pathname; } catch { /* Keep diagnostics free of full URLs. */ }
    consoles.push({ path, exactLoadFailure: /^Failed to load resource: net::ERR_(?:ABORTED|FAILED)$/.test(message.text()), hash: originalSha(message.text()) }); });
  const snapshot = async () => { const state = await page.evaluate(() => (window as AuditWindow).__creativeAdoptionAudit); if (state) documents.set(state.document, state); return state; };
  const boundary = async () => page.evaluate(() => { const state = (window as AuditWindow).__creativeAdoptionAudit;
    if (!state) throw new Error("creative_adoption_native_audit_missing"); return { document: state.document, lastId: state.rows.at(-1)?.id ?? 0, at: performance.timeOrigin + performance.now() }; });
  const mark = async (next: string) => { phase = next; phases.push({ phase, hostIndex: rows.length });
    await page.evaluate(next => { const state = (window as AuditWindow).__creativeAdoptionAudit; if (state) state.phase = next; }, next); await snapshot(); };
  const settle = async () => { let previous = "", stable = 0;
    await expect.poll(async () => { await snapshot();
      const consumed = [...documents.values()].every(document => !document.pendingHashes && document.rows.every(row => row.error || row.readerError || row.eof || row.jsonDone));
      if (!consumed || !rows.every(row => row.finished || row.failed)) { previous = ""; stable = 0; return false; }
      const signature = JSON.stringify({ host: rows.map(row => [row.index, row.status, row.finished, row.failed]), native: [...documents.values()] });
      stable = signature === previous ? stable + 1 : 1; previous = signature; return stable >= 2;
    }, { timeout: 25_000, intervals: [100, 200, 500] }).toBe(true);
  };
  const beforeReload = async (next: string) => { await mark(next); await settle(); barriers.push({ phase, hostCount: rows.length,
    documents: [...documents.values()].map(document => ({ document: document.document, rows: document.rows.map(row => ({ id: row.id, path: row.path, status: row.status, eof: row.eof,
      jsonDone: row.jsonDone, error: row.error, readerError: row.readerError, bytes: row.bytes })) })) }); };
  const pinAuthority = (expectedHash: string) => {
    const checked = Hash.parse(expectedHash);
    if (pinnedAuthorityHash !== undefined || rows.some(row => adoptionPattern.test(row.path))) throw new Error("creative_adoption_authority_pin_must_precede_original_reads");
    pinnedAuthorityHash = checked;
  };
  return { rows, documents, phases, barriers, errors, consoles, snapshot, boundary, mark, settle, beforeReload, pinAuthority,
    get authorityHash() { return pinnedAuthorityHash; } };
}
type Seen = Awaited<ReturnType<typeof observe>>;
function verifyNetwork(seen: Seen, allowed: Set<Request>) {
  expect(seen.rows.every(row => row.valid)).toBe(true); expect(seen.errors).toEqual([]);
  expect(seen.authorityHash).toMatch(/^[a-f0-9]{64}$/);
  expect(seen.rows.filter(row => adoptionPattern.test(row.path)).every(row => row.authorityValid === true && row.authorityHash === seen.authorityHash)).toBe(true);
  expect([...seen.documents.values()].every(document => document.pendingHashes === 0 && document.rows.every(row => row.authorityHash === seen.authorityHash))).toBe(true);
  expect(seen.rows.filter(row => row.failed && !allowed.has(row.request))).toEqual([]);
  const permitted = seen.rows.filter(row => row.failed && allowed.has(row.request));
  const exactConsoles = seen.consoles.filter(row => row.exactLoadFailure && permitted.some(request => request.path === row.path));
  expect(exactConsoles.length).toBeLessThanOrEqual(permitted.length); expect(seen.consoles.filter(row => !exactConsoles.includes(row))).toEqual([]);
}
function unchangedOriginal(before: Fact, after: Fact) {
  expect(after.role).toBe("yummyai_app"); expect(after.execution).toEqual(before.execution); expect(after.archive).toEqual(before.archive); expect(after.budget).toEqual(before.budget);
  expect(after.versions).toEqual(before.versions); expect(after.originalDispatches).toBe(before.originalDispatches); expect(after.forbiddenDispatches).toBe(0);
  for (const table of ["creative_studio_entries", "creative_studio_revisions", "creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"])
    expect(after.tables[table]).toEqual(before.tables[table]);
}
async function seed(page: Page, child: Child, nonce: string, scenario: "adopt" | "clear") {
  await loginErp(page, "operator", "/navigation"); const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const session = ErpSessionViewSchema.parse(await response.json()); expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId);
  const basis = Seed.parse(await child.rpc("seed", TenantContextSchema.parse(session), scenario)); expect(basis.nonce).toBe(nonce); expect(basis.authorityHash).toBe(originalSha(erpSessionAuthority(session))); return basis;
}
async function openPanel(page: Page, basis: Basis, proof?: Record<string, unknown>) {
  await page.goto(`/creative-designs?batch=${basis.batchId}`);
  const history = page.getByRole("region", { name: "创作执行依据与恢复", exact: true });
  await history.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
  const panel = panelFor(page, basis), path = `/api/creative-executions/${basis.executionId}/response-adoption`;
  const [response] = await Promise.all([
    page.waitForResponse(value => new URL(value.url()).pathname === path && value.request().method() === "GET"
      && value.request().frame() === page.mainFrame() && originalSha(value.request().headers()["x-yummyai-context-authority"] ?? "") === basis.authorityHash),
    panel.getByRole("button", { name: "查看原归档响应", exact: true }).click(),
  ]);
  const completion = await response.finished(), responseAuthorityHash = originalSha(response.headers()["x-yummyai-context-authority"] ?? "");
  const transport: Record<string, unknown> = { status: response.status(), resourceType: response.request().resourceType(),
    requestAuthorityHash: basis.authorityHash, responseAuthorityHash, finished: completion === null, completionError: completion?.name ?? null };
  if (proof) proof.originalWorkspaceTransport = transport;
  expect(response.status()).toBe(200); expect(responseAuthorityHash).toBe(basis.authorityHash); expect(completion).toBeNull();
  expect(response.headers()["content-type"]?.split(";")[0]?.trim()).toBe("application/json");
  const body = await response.body(); transport.bodyBytes = body.byteLength; transport.bodySha256 = originalSha(body);
  const workspace = CreativeResponseAdoptionWorkspaceSchema.parse(JSON.parse(body.toString("utf8")));
  expect(workspace).toMatchObject({ executionId: basis.executionId, batchId: basis.batchId, candidateId: basis.candidateId,
    identityStamp: basis.identityStamp, originalPhase: basis.originalPhase, basis: basis.basis, canAdopt: true, canInspectOriginal: true,
    source: { responseChecksum: basis.responseChecksum }, requests: [] });
  // Text can be painted before Chromium reports the transport complete. Require
  // the original GET's successful body before starting a preview or later action.
  await expect(panel).not.toHaveAttribute("data-state", "loading"); await expect(panel.getByText("原服务报告费用", { exact: true })).toBeVisible(); return panel;
}
async function preview(page: Page, basis: Basis) {
  const panel = panelFor(page, basis); await panel.getByRole("button", { name: "读取原图预览", exact: true }).click();
  const image = panel.getByRole("img", { name: "原任务归档响应预览", exact: true }); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => ({ complete: element.complete, width: element.naturalWidth, height: element.naturalHeight })))
    .toEqual({ complete: true, width: basis.width, height: basis.height });
  await expect(panel.locator(".creative-response-preview figcaption")).toContainText("原图已显示 请核对内容后再选择采用");
  await expect(panel.getByRole("checkbox", { name: "我已核对这份原图 仅采用为待审核候选 权利尚未核对 仍需业务审核", exact: true })).toBeEnabled();
}
async function stableVisible(page: Page, element: ReturnType<typeof panelFor>, proof: Record<string, unknown>, key: string) {
  const before = await element.boundingBox(); await element.evaluate(node => node.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  let previous = "", stable = 0;
  await expect.poll(async () => { const box = await element.boundingBox(), viewport = page.viewportSize();
    const inside = !!box && !!viewport && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
    const signature = JSON.stringify(box); stable = inside ? previous === signature ? stable + 1 : 1 : 0; previous = inside ? signature : "";
    proof[key] = { viewport, before, after: box, stableMeasurements: stable }; return stable;
  }, { intervals: [100, 200, 500] }).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function failureScreenshot(page: Page, info: TestInfo, proof: Record<string, unknown>) {
  try { await page.screenshot({ path: info.outputPath("primary-failure.png"), timeout: 5000 }); proof.failureScreenshot = true; } catch { proof.failureScreenshotFailed = true; }
}
async function finish(page: Page, child: Child, seen: Seen, info: TestInfo, proof: Record<string, unknown>, primary: unknown, allowed: Set<Request>) {
  let failure = primary;
  try { await seen.settle(); verifyNetwork(seen, allowed); } catch (cause) { proof.networkGateFailed = true; failure ??= cause; }
  try { await seen.snapshot(); } catch { proof.nativeSnapshotIncomplete = true; }
  proof.phases = seen.phases; proof.reloadBarriers = seen.barriers; proof.native = [...seen.documents.values()]; proof.errors = seen.errors; proof.consoles = seen.consoles;
  proof.network = seen.rows.map(({ request: _request, ...row }) => { void _request; return row; });
  try { const closed = await child.close(); proof.fixture = closed; if (closed.failed) failure ??= new Error("creative_adoption_fixture_cleanup_failed"); }
  catch (cause) { proof.fixtureCleanupFailed = true; failure ??= cause; }
  if (failure && !primary) await failureScreenshot(page, info, proof);
  try { await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("creative-response-adoption-proof.json"), JSON.stringify(proof, null, 2) + "\n"); }
  catch (cause) { failure ??= cause; }
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
    await info.attach("actual-browser.json", { contentType: "application/json", body: JSON.stringify({ actualVersion, product, revision, ...pin }) }); }
  finally { await cdp.detach(); }
});

test("a71c9e42_normal_success_updates_current_batch_and_selectable_candidate_without_page_reload_or_approval", async ({ page }, info) => {
  const environment = requireCreativeResponseAdoptionEnvironment(process.env, true), seen = await observe(page), child = childFor(environment.nonce), allowed = new Set<Request>();
  const proof: Record<string, unknown> = { family: "creative_response_adoption_a71c9e42_normal", nonce: environment.nonce, realPaidCall: false, ordinaryWorkerStarted: false };
  const imageResponses: PlaywrightResponse[] = [];
  const recordImage = (response: PlaywrightResponse) => { if (response.request().resourceType() === "image") imageResponses.push(response); };
  page.on("response", recordImage);
  let primary: unknown;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const basis = await seed(page, child, environment.nonce, "adopt"), before = await facts(child);
    seen.pinAuthority(basis.authorityHash);
    await seen.mark("adoption.normal-preview"); const panel = await openPanel(page, basis), detail = page.locator(".pod-design-batch-detail");
    const header = detail.locator(":scope > header");
    await expect(header.getByText("0 已生成", { exact: true })).toBeVisible(); await expect(header.getByText("1 失败款", { exact: true })).toBeVisible();
    const candidate = detail.locator(".pod-candidate-frame"); await expect(candidate).toHaveCount(1); await expect(candidate.getByRole("checkbox")).toBeDisabled();
    await preview(page, basis); await seen.settle(); expect(await facts(child)).toEqual(before);
    await panel.getByRole("checkbox", { name: "我已核对这份原图 仅采用为待审核候选 权利尚未核对 仍需业务审核", exact: true }).check();
    const documentBefore = await seen.boundary(), path = `/api/creative-executions/${basis.executionId}/response-adoptions`;
    const received = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "POST");
    await seen.mark("adoption.normal-submit-once"); await panel.getByRole("button", { name: "采用原归档响应", exact: true }).click();
    const response = await received; expect(response.status()).toBe(200);
    const committed = CreativeResponseAdoptionRequestViewSchema.parse(await response.json());
    expect(committed).toMatchObject({ executionId: basis.executionId, status: "committed", attempts: 1, receipt: { candidateId: basis.candidateId,
      originalPhase: "failed", disposition: "generated", rightsStatus: "unverified", approval: "review_required" } });
    await expect(panel).toHaveAttribute("data-state", "committed");
    await expect(panel.getByRole("region", { name: "原响应采用回执", exact: true }).getByText("候选已生成 · 权利未核对 · 仍需业务审核", { exact: true })).toBeVisible();
    // These are the original batch's server-projected controls, in the same
    // document after the actual success callback. No test reload repairs them.
    await expect(header.getByText("1 已生成", { exact: true })).toBeVisible(); await expect(header.getByText("0 失败款", { exact: true })).toBeVisible();
    await expect(candidate).toHaveClass(/\bgenerated\b/); await expect(candidate.getByRole("checkbox")).toBeEnabled(); await expect(candidate.getByRole("checkbox")).not.toBeChecked();
    const history = page.getByRole("region", { name: "创作执行依据与恢复", exact: true });
    await expect(history.getByRole("article", { name: "候选生成执行记录", exact: true }).locator("header").getByText("执行未完成", { exact: true })).toBeVisible();
    await seen.settle(); const documentAfter = await seen.boundary(); expect(documentAfter.document).toBe(documentBefore.document);
    const after = await facts(child); unchangedOriginal(before, after); expect(after.requests).toEqual([committed]); expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0]).toMatchObject({ id: basis.candidateId, status: "generated", assetId: committed.receipt!.artifact.assetId });
    expect(after.versions.count).toBe(0); expect(after.assets).toEqual([{ id: committed.receipt!.artifact.assetId, checksumSha256: basis.artifactChecksum, actualSha256: basis.artifactChecksum,
      byteSize: basis.imageBytes, actualByteSize: basis.imageBytes, mediaType: "image/png", rightsStatus: "unverified", aiGenerated: true, version: 1 }]);
    // Match the image rendered inside this exact candidate's own card to the
    // real browser response. A preview elsewhere or a DB asset alone is not a
    // successful candidate thumbnail. Signed URLs remain in memory only.
    await expect(candidate.getByRole("checkbox")).toHaveValue(basis.candidateId);
    const thumbnail = candidate.getByRole("img"); await expect(thumbnail).toHaveCount(1); await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image: HTMLImageElement) => ({ complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })))
      .toEqual({ complete: true, width: basis.width, height: basis.height });
    const signedUrl = await thumbnail.evaluate((image: HTMLImageElement) => image.currentSrc);
    expect(/^https?:$/.test(new URL(signedUrl).protocol)).toBe(true);
    await expect.poll(() => imageResponses.filter(response => response.url() === signedUrl).length).toBe(1);
    const imageResponse = imageResponses.find(response => response.url() === signedUrl);
    if (!imageResponse) throw new Error("creative_adoption_signed_card_image_response_missing");
    expect(imageResponse.request().frame()).toBe(page.mainFrame()); expect(imageResponse.status()).toBe(200);
    expect(imageResponse.headers()["content-type"]?.split(";")[0]?.trim()).toBe("image/png");
    expect(imageResponse.headers()["content-length"]).toBe(String(basis.imageBytes)); expect(await imageResponse.finished()).toBeNull();
    let imageBytes: Buffer;
    try { imageBytes = await imageResponse.body(); } catch { throw new Error("creative_adoption_signed_card_image_body_unavailable"); }
    expect(imageBytes.byteLength).toBe(basis.imageBytes); expect(originalSha(imageBytes)).toBe(basis.artifactChecksum);
    proof.currentCandidateThumbnail = { candidateId: basis.candidateId, assetId: committed.receipt!.artifact.assetId, exactSignedUrlSha256: originalSha(signedUrl),
      status: imageResponse.status(), complete: true, naturalWidth: basis.width, naturalHeight: basis.height, bytes: imageBytes.byteLength, sha256: originalSha(imageBytes) };
    const posts = seen.rows.filter(row => row.method === "POST"); expect(posts).toHaveLength(1); expect(posts[0]!.path).toBe(path); expect(posts[0]!.status).toBe(200);
    await history.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
    await expect(history.getByRole("button", { name: "执行依据与恢复", exact: true })).toHaveAttribute("aria-expanded", "false");
    await stableVisible(page, candidate, proof, "normalCandidateBounds1440");
    proof.images = [await originalScreenshot(page, info, "normal-adoption-current-selectable-candidate-1440")];
    proof.normalSuccess = { document: documentAfter.document, sameDocument: true, batchGenerated: 1, batchFailed: 0, selectable: true, selected: false,
      originalExecutionPhase: after.execution.phase, requestId: committed.requestId, candidateId: basis.candidateId, artifactSha256: basis.artifactChecksum,
      businessApproval: "review_required", rightsStatus: "unverified", createdDesignVersions: 0, adoptionPosts: 1 };
    await seen.beforeReload("adoption.normal-before-leaving-original"); await page.goto("/navigation"); await seen.settle(); verifyNetwork(seen, allowed);
  } catch (cause) { primary = cause; await failureScreenshot(page, info, proof); }
  finally { page.off("response", recordImage); primary = await finish(page, child, seen, info, proof, primary, allowed); }
  if (primary) throw primary;
});

test("a71c9e42_real_archived_original_adoption_lost_ACK_recovers_only_original_receipt_without_model_resubmission", async ({ page }, info) => {
  const environment = requireCreativeResponseAdoptionEnvironment(process.env, true), seen = await observe(page), child = childFor(environment.nonce), allowed = new Set<Request>();
  const proof: Record<string, unknown> = { family: "creative_response_adoption_a71c9e42", nonce: environment.nonce, realPaidCall: false, ordinaryWorkerStarted: false };
  let primary: unknown, handler: ((route: Route) => Promise<void>) | undefined, registeredPattern: string | undefined, intercepted = false;
  const drained = deferred<void>();
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const basis = await seed(page, child, environment.nonce, "adopt"), before = await facts(child);
    seen.pinAuthority(basis.authorityHash);
    await seen.mark("adoption.workspace-original"); await openPanel(page, basis, proof); await seen.settle(); verifyNetwork(seen, allowed);
    await seen.mark("adoption.preview-original"); await preview(page, basis); await seen.settle(); verifyNetwork(seen, allowed);
    expect(await facts(child)).toEqual(before); expect(seen.rows.filter(row => row.method === "POST")).toEqual([]);
    const panel = panelFor(page, basis); const images: string[] = [];
    await stableVisible(page, panel.getByRole("img", { name: "原任务归档响应预览", exact: true }), proof, "previewBounds1440");
    images.push(await originalScreenshot(page, info, "original-archived-preview-1440"));
    const checkbox = panel.getByRole("checkbox", { name: "我已核对这份原图 仅采用为待审核候选 权利尚未核对 仍需业务审核", exact: true }); await checkbox.check();
    const path = `/api/creative-executions/${basis.executionId}/response-adoptions`, dropped = deferred<{ request: Request; index: number; command: z.infer<typeof CreativeResponseAdoptionCommandSchema>; committed: z.infer<typeof CreativeResponseAdoptionRequestViewSchema> }>();
    const fence = await seen.boundary(), hostBoundary = seen.rows.length;
    handler = async route => {
      const request = route.request(); if (intercepted || new URL(request.url()).pathname !== path || request.method() !== "POST") { await route.fallback(); return; }
      intercepted = true;
      try {
        const command = CreativeResponseAdoptionCommandSchema.parse(request.postDataJSON()); expect(command.expectedBasis).toBe(basis.basis);
        expect(originalSha(request.headers()["x-yummyai-context-authority"] ?? "")).toBe(basis.authorityHash); expect(request.frame()).toBe(page.mainFrame());
        const upstream = await route.fetch();
        try {
          expect(upstream.status()).toBe(200); const committed = CreativeResponseAdoptionRequestViewSchema.parse(await upstream.json());
          expect(committed).toMatchObject({ executionId: basis.executionId, requestId: command.requestId, command, status: "committed", attempts: 1 });
          const actual = await facts(child); unchangedOriginal(before, actual); expect(actual.requests).toEqual([committed]); expect(actual.candidates).toHaveLength(1);
          expect(actual.candidates[0]).toMatchObject({ id: basis.candidateId, status: "generated", assetId: committed.receipt!.artifact.assetId });
          const rows = seen.rows.filter(row => row.request === request); expect(rows).toHaveLength(1); expect(rows[0]!.index).toBeGreaterThanOrEqual(hostBoundary);
          await route.abort("failed"); allowed.add(request); dropped.resolve({ request, index: rows[0]!.index, command, committed });
        } finally { await upstream.dispose(); }
      } catch (cause) { try { await route.abort("failed"); } catch { /* Preserve the primary injection error. */ } dropped.reject(cause instanceof Error ? cause : new Error("creative_adoption_drop_failed")); }
      finally { drained.resolve(); }
    };
    registeredPattern = "**" + path;
    await page.route(registeredPattern, handler); await seen.mark("adoption.commit-and-drop-ack"); await panel.getByRole("button", { name: "采用原归档响应", exact: true }).click();
    const original = await dropped.promise; await drained.promise; await page.unroute(registeredPattern, handler); handler = undefined;
    await expect(panel).toHaveAttribute("data-state", "unknown"); await expect.poll(() => seen.rows[original.index]?.failed).toBe("net::ERR_FAILED"); await seen.settle();
    const matches = seen.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.path === path && row.method === "POST"
      && row.bodyHash === originalSha(original.request.postData() ?? "") && row.authorityHash === basis.authorityHash) ?? [];
    expect(matches).toHaveLength(1); expect(matches[0]).toMatchObject({ bytes: 0, reads: 0, eof: false, jsonDone: false, status: null, error: "TypeError" });
    proof.originalAttempt = { hostIndex: original.index, native: matches[0], upstreamStatus: 200, originalCommand: original.command, upstreamIsSeparateRequest: true };
    const committedFacts = await facts(child); expect(committedFacts.requests).toEqual([original.committed]);
    const marker = await page.evaluate(({ prefix, executionId, identityStamp }) => {
      const key = prefix + identityStamp + ":" + executionId, value = sessionStorage.getItem(key); if (value === null) throw new Error("creative_adoption_original_marker_missing");
      const command = JSON.parse(value) as { executionId: string; identityStamp: string; command: unknown };
      sessionStorage.removeItem(key); if (sessionStorage.getItem(key) !== null) throw new Error("creative_adoption_marker_not_removed"); return command;
    }, { prefix: CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX, executionId: basis.executionId, identityStamp: basis.identityStamp });
    expect(marker).toEqual({ executionId: basis.executionId, identityStamp: basis.identityStamp, command: original.command });
    await seen.beforeReload("adoption.before-reload-without-local-pointer"); const boundary = seen.rows.length;
    await page.reload(); await seen.mark("adoption.server-index-readonly-recovery");
    const history = page.getByRole("region", { name: "创作执行依据与恢复", exact: true }); await history.getByRole("button", { name: "执行依据与恢复", exact: true }).click();
    await panel.getByRole("button", { name: "查看原归档响应", exact: true }).click();
    await expect(panel).toHaveAttribute("data-state", "committed"); const receipt = panel.getByRole("region", { name: "原响应采用回执", exact: true });
    await expect(receipt.getByText("候选已生成 · 权利未核对 · 仍需业务审核", { exact: true })).toBeVisible();
    await expect(panel.locator('[aria-label="原采用请求"]').getByText(original.command.requestId, { exact: true })).toBeVisible();
    await seen.settle(); expect(seen.rows.slice(boundary).every(row => row.method === "GET")).toBe(true);
    expect(seen.rows.slice(boundary).filter(row => row.path === `/api/creative-executions/${basis.executionId}/response-adoption`)).toHaveLength(1);
    expect(seen.rows.slice(boundary).filter(row => row.path === `/api/creative-executions/${basis.executionId}/response-adoptions/by-request/${original.command.requestId}`)).toHaveLength(1);
    const final = await facts(child); expect(final).toEqual(committedFacts); unchangedOriginal(before, final);
    expect(final.assets).toEqual([{ id: original.committed.receipt!.artifact.assetId, checksumSha256: basis.artifactChecksum, actualSha256: basis.artifactChecksum,
      byteSize: basis.imageBytes, actualByteSize: basis.imageBytes, mediaType: "image/png", rightsStatus: "unverified", aiGenerated: true, version: 1 }]);
    expect(final.versions.count).toBe(0); expect(seen.rows.filter(row => row.method === "POST")).toHaveLength(1);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
      const notice = receipt.getByText("候选已生成 · 权利未核对 · 仍需业务审核", { exact: true }); await stableVisible(page, notice, proof, "receiptBounds" + width);
      images.push(await originalScreenshot(page, info, "original-adoption-receipt-" + width)); }
    proof.images = images; proof.originalTerminalUnchanged = true; proof.originalCostAndArchiveExact = true; proof.generatedCandidateCount = 1;
    proof.designVersionsCreated = 0; proof.recoveryMutationCount = 0; proof.restoredOriginalCommand = original.command;
    await seen.beforeReload("adoption.before-leaving-original"); await page.goto("/navigation"); await seen.settle(); verifyNetwork(seen, allowed);
  } catch (cause) { primary = cause; await failureScreenshot(page, info, proof); }
  finally { if (handler && registeredPattern) try { await page.unroute(registeredPattern, handler); } catch (cause) { primary ??= cause; }
    if (intercepted) await drained.promise;
    primary = await finish(page, child, seen, info, proof, primary, allowed); }
  if (primary) throw primary;
});

test("a71c9e42_parent_cancel_blocks_adoption_and_real_logout_CLEAR_discards_exact_late_private_body", async ({ page }, info) => {
  const environment = requireCreativeResponseAdoptionEnvironment(process.env, true), seen = await observe(page), child = childFor(environment.nonce), allowed = new Set<Request>();
  const proof: Record<string, unknown> = { family: "creative_response_adoption_a71c9e42_clear", nonce: environment.nonce, realPaidCall: false, ordinaryWorkerStarted: false };
  const held = deferred<void>(), release = deferred<void>(), drained = deferred<void>();
  let primary: unknown, handler: ((route: Route) => Promise<void>) | undefined, registeredPattern: string | undefined, request: Request | undefined, terminal = false, heldIndex = -1;
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    const basis = await seed(page, child, environment.nonce, "clear"), before = await facts(child); expect(before.execution.originalCostUsd).toBeNull();
    seen.pinAuthority(basis.authorityHash);
    await openPanel(page, basis); await preview(page, basis); await seen.settle(); const panel = panelFor(page, basis);
    await expect(panel.getByText("费用未知 不能按零处理", { exact: true })).toBeVisible();
    const cancelled = Facts.parse(await child.rpc("cancel-parent")); unchangedOriginal(before, cancelled); expect(cancelled.batch.status).toBe("cancelled");
    await seen.mark("adoption.parent-cancel-readonly"); await panel.getByRole("button", { name: "只读核对原归档", exact: true }).click();
    await expect(panel.getByRole("button", { name: "读取原图预览", exact: true })).toBeDisabled();
    await expect(panel.getByRole("img", { name: "原任务归档响应预览", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "采用原归档响应", exact: true })).toHaveCount(0); await seen.settle();
    expect(seen.rows.filter(row => row.method === "POST")).toEqual([]); expect(await facts(child)).toEqual(cancelled);
    const path = `/api/creative-executions/${basis.executionId}/response-adoption`, fence = await seen.boundary(), hostBoundary = seen.rows.length;
    handler = async route => {
      if (request || route.request().method() !== "GET" || new URL(route.request().url()).pathname !== path) { await route.fallback(); return; }
      request = route.request(); heldIndex = seen.rows.findIndex(row => row.request === request);
      let upstream: Awaited<ReturnType<Route["fetch"]>> | undefined;
      try {
        upstream = await route.fetch(); expect(upstream.status()).toBe(200);
        const workspace = CreativeResponseAdoptionWorkspaceSchema.parse(await upstream.json()); expect(workspace).toMatchObject({ executionId: basis.executionId,
          originalPhase: "uncertain", basis: null, canAdopt: false, canInspectOriginal: false, requests: [] });
        held.resolve(); await release.promise; try { await route.fulfill({ response: upstream }); } catch (cause) { if (!terminal) throw cause; }
      } catch (cause) { held.reject(cause instanceof Error ? cause : new Error("creative_adoption_held_read_failed")); throw cause; }
      finally { await upstream?.dispose(); drained.resolve(); }
    };
    registeredPattern = "**" + path;
    await page.route(registeredPattern, handler); await seen.mark("adoption.held-private-read-before-clear");
    await panel.getByRole("button", { name: "只读核对原归档", exact: true }).click(); await held.promise;
    const candidates = () => seen.documents.get(fence.document)?.rows.filter(row => row.id > fence.lastId && row.start >= fence.at && row.path === path && row.method === "GET") ?? [];
    await expect.poll(async () => { await seen.snapshot(); return candidates().map(row => ({ bodyHash: row.bodyHash, authorityHash: row.authorityHash })); })
      .toEqual([{ bodyHash: originalSha(""), authorityHash: basis.authorityHash }]);
    const native = candidates()[0]!, identity = { document: native.document, id: native.id, start: native.start, path: native.path, method: native.method, bodyHash: native.bodyHash, authorityHash: native.authorityHash };
    const same = seen.rows.slice(hostBoundary).filter(row => row.path === path && row.method === "GET"); expect(same).toHaveLength(1); expect(same[0]!.request).toBe(request);
    expect(heldIndex).toBeGreaterThanOrEqual(hostBoundary); expect(request!.frame()).toBe(page.mainFrame()); expect(same[0]!.authorityHash).toBe(basis.authorityHash);
    expect(native).toMatchObject({ bytes: 0, reads: 0, eof: false, jsonDone: false, status: null }); allowed.add(request!);
    proof.heldIdentity = { ...identity, hostIndex: heldIndex, hostBoundary, fence, playwrightTimingStart: request!.timing().startTime,
      upstreamStatus: 200, upstreamIsSeparateRequest: true };
    const logoutAt = await page.evaluate(() => performance.timeOrigin + performance.now()); await page.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "登录运营工作台", exact: true })).toBeVisible(); terminal = true; release.resolve(); await drained.promise;
    await page.unroute(registeredPattern, handler); handler = undefined; await seen.settle();
    const exact = () => seen.documents.get(identity.document)?.rows.filter(row => Object.entries(identity).every(([key, value]) => row[key as keyof NativeRead] === value)) ?? [];
    await expect.poll(() => exact().some(row => row.error === "AbortError" || row.readerError === "AbortError")).toBe(true);
    const document = seen.documents.get(identity.document)!;
    const logoutClears = document.events.filter(row => (row.name === ASSIST_INTENT_CLEAR_EVENT || row.name === STUDIO_PERSONAL_CLEAR_EVENT) && row.at >= logoutAt);
    for (const name of [ASSIST_INTENT_CLEAR_EVENT, STUDIO_PERSONAL_CLEAR_EVENT]) expect(logoutClears.some(row => row.name === name)).toBe(true);
    expect(logoutClears.every(row => row.completedAt !== null && Number.isFinite(row.completedAt) && row.completedAt >= row.at)).toBe(true);
    const clearAt = Math.min(...logoutClears.map(row => row.at)), clearCompletedAt = Math.max(...logoutClears.map(row => row.completedAt!));
    expect(exact()).toHaveLength(1); expect(exact()[0]).toMatchObject({ bytes: 0, reads: 0, eof: false, jsonDone: false });
    expect(exact()[0]!.signalAbort).not.toBeNull(); expect(exact()[0]!.signalAbort).toBeGreaterThanOrEqual(logoutAt); expect(exact()[0]!.signalAbort).toBeLessThanOrEqual(clearCompletedAt);
    expect(document.rows.filter(row => row.start >= clearAt)).toEqual([]); expect(seen.rows[heldIndex]!.failed).toBe("net::ERR_ABORTED");
    proof.logoutFence = { logoutAt, firstClearAt: clearAt, clearCompletedAt, exactRequestAbortAt: exact()[0]!.signalAbort };
    await expect(page.getByRole("region", { name: "原响应安全采用", exact: true })).toHaveCount(0);
    expect(await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)), CREATIVE_RESPONSE_ADOPTION_INTENT_PREFIX)).toEqual([]);
    expect(await facts(child)).toEqual(cancelled); unchangedOriginal(before, await facts(child));
    expect(seen.rows.filter(row => row.method === "POST").map(row => row.path)).toEqual(["/api/erp-auth/logout"]);
    const images: string[] = []; for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); images.push(await originalScreenshot(page, info, "original-adoption-cleared-" + width)); }
    proof.images = images; proof.parentCancelBlocked = true; proof.privateLateBody = exact(); proof.adoptionPostCount = 0; verifyNetwork(seen, allowed);
  } catch (cause) { primary = cause; await failureScreenshot(page, info, proof); }
  finally { terminal = true; release.resolve(); if (handler && registeredPattern) try { await page.unroute(registeredPattern, handler); } catch (cause) { primary ??= cause; }
    if (request) await drained.promise;
    primary = await finish(page, child, seen, info, proof, primary, allowed); }
  if (primary) throw primary;
});
