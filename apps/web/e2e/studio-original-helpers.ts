import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { StudioPersonalInvokeSchema } from "@yummyai/contracts/pod/studio-personal";
import type { StudioOriginalBrowserRequest } from "../../../tools/testing/studio-original-browser.mts";

export const originalSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export const OriginalSeed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), scope: z.uuidv7(), key: z.string(), assetId: z.uuidv7(), canvasId: z.string(),
  canvasTitle: z.string(), imageTitle: z.string(), text: z.string(), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(), viewport: z.object({ x: z.number(), y: z.number(), k: z.number() }).strict() }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const OriginalFacts = z.object({ paid: z.object({ role: z.string(), tables: z.record(z.string(), Table), counts: z.object({
  storageReads: z.number(), storageWrites: z.number(), scans: z.number(), originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number(),
}).strict(), ownedObjectCount: z.number().int().nonnegative(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }).strict(),
candidates: z.object({ candidates: z.array(z.object({ id: z.uuidv7(), assetId: z.uuidv7().nullable(), submissionId: z.unknown(), inputChecksum: z.string() }).strict()),
  versions: z.array(z.object({ id: z.uuidv7(), sourceCandidateId: z.uuidv7(), status: z.string() }).strict()),
  assets: z.array(z.object({ id: z.uuidv7(), version: z.number(), checksumSha256: z.string().nullable(), byteSize: z.number(), mediaType: z.string(), rightsStatus: z.string() }).strict()) }).strict(),
documents: z.array(z.object({ key: z.string(), revision: z.number(), value: z.unknown(), deleted: z.boolean() }).strict()),
source: z.object({ id: z.uuidv7(), version: z.number(), checksumSha256: z.string().nullable(), byteSize: z.number(), rightsStatus: z.string() }).strict() }).strict();
export type OriginalFacts = z.infer<typeof OriginalFacts>;
export function originalDocument(value: unknown): unknown {
  if (value && typeof value === "object" && "studioDocument" in value && "data" in value) value = value.data;
  return typeof value === "string" ? JSON.parse(value) : value;
}
export function originalPaidUnchanged(before: OriginalFacts, after: OriginalFacts) {
  expect(after.paid.role).toBe("yummyai_app");
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"])
    expect(after.paid.tables[table]).toEqual(before.paid.tables[table]);
  expect(after.paid.counts.generationCalls).toBe(0); expect(after.paid.counts.dispatchAttempts).toBe(0);
  expect(after.paid.providerCalls).toBe(0); expect(after.paid.workerProcesses).toBe(0);
}

export function originalOwnerChild(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-original-browser.mts", import.meta.url)), "--studio-original-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) },
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let next = 0, exited = false, closeAcknowledged = false;
  const exit = deferred<{ code: number | null; signal: string | null }>(), waiting = new Map<number, ReturnType<typeof deferred<unknown>>>();
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_original_(?:browser|fixture)_[a-z_]+$/) }).strict()]).safeParse(raw);
    if (!packet.success) { for (const entry of waiting.values()) entry.reject(new Error("studio_original_child_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(new Error(packet.data.errorCode));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_original_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal });
    for (const pending of waiting.values()) pending.reject(new Error("studio_original_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext, scenario: "handoff" | "lifecycle" = "handoff") {
    const id = ++next, pending = deferred<unknown>(); if (!child.connected || exited) throw new Error("studio_original_child_channel_closed");
    const packet: StudioOriginalBrowserRequest = operation === "seed"
      ? { id, nonce, operation, context: TenantContextSchema.parse(context), scenario } : { id, nonce, operation };
    waiting.set(id, pending); child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_original_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_original_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let failure = false; try { closeAcknowledged = z.object({ closed: z.literal(true) }).strict().parse(await rpc("close")).closed; } catch { failure = true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); let forced = false;
    if (!result) { forced = true; child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid ?? null, nonce, closeAcknowledged, exited, forced, code: result?.code ?? null,
      signal: result?.signal ?? null, failed: failure || !closeAcknowledged || forced || result?.code !== 0 };
  } };
}

type NativeRead = { id: number; documentStartedAt: number; phase: string; operation: string | null; namespace: string | null; key: string | null;
  status: number | null; eof: boolean; jsonDone: boolean; bytes: number; error: string | null; readerError: string | null; body: string };
type AuditWindow = Window & { __studioOriginalReads?: NativeRead[]; __studioOriginalPhase?: string };
export async function observeOriginal(page: Page) {
  let phase = "boot";
  const phases: Array<{ phase: string; requestIndex: number }> = [];
  const allNative: NativeRead[][] = [];
  await page.exposeBinding("__studioOriginalCapture", (_source, value: NativeRead[]) => { allNative.push(value); });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const rows: NativeRead[] = []; (window as AuditWindow).__studioOriginalReads = rows;
    const capture = () => { const fn = (window as unknown as { __studioOriginalCapture?: (value: NativeRead[]) => Promise<void> }).__studioOriginalCapture;
      if (fn) void fn(rows.map(row => ({ ...row }))).then(() => {}, () => {}); };
    const responses = new WeakMap<Response, NativeRead>(), streams = new WeakMap<ReadableStream, NativeRead>(), readers = new WeakMap<object, NativeRead>();
    const fetchOriginal = window.fetch, jsonOriginal = Response.prototype.json;
    const error = (value: unknown) => value && typeof value === "object" && "name" in value ? String(value.name) : "UnknownError";
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || url.pathname !== "/api/creative-studio/invoke") return fetchOriginal.call(this, input, init);
      const body = typeof init?.body === "string" ? init.body : ""; let coordinates: { operation?: string; namespace?: string; key?: string } = {};
      try { coordinates = JSON.parse(body).request ?? {}; } catch { /* Actual malformed requests remain visible in outer validation. */ }
      const row: NativeRead = { id: rows.length + 1, documentStartedAt: performance.timeOrigin, phase: (window as AuditWindow).__studioOriginalPhase ?? "document-start",
        operation: coordinates.operation ?? null, namespace: coordinates.namespace ?? null, key: coordinates.key ?? null,
        status: null, eof: false, jsonDone: false, bytes: 0, error: null, readerError: null, body }; rows.push(row);
      const pending = fetchOriginal.call(this, input, init);
      void pending.then(response => { row.status = response.status; responses.set(response, row); if (response.body) streams.set(response.body, row); capture(); },
        cause => { row.error = error(cause); capture(); }); return pending;
    };
    Response.prototype.json = function() { const row = responses.get(this), pending = jsonOriginal.call(this);
      if (row) void pending.then(() => { row.jsonDone = true; capture(); }, cause => { row.readerError = error(cause); capture(); }); return pending; };
    const getReaderOriginal = ReadableStream.prototype.getReader;
    function getReader(this: ReadableStream, options: { mode: "byob" }): ReadableStreamBYOBReader;
    function getReader(this: ReadableStream): ReadableStreamDefaultReader<unknown>;
    function getReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown>;
    function getReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown> {
      const reader = getReaderOriginal.call(this, options), row = streams.get(this); if (row) readers.set(reader, row); return reader;
    }
    ReadableStream.prototype.getReader = getReader;
    const readOriginal = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function() { const row = readers.get(this), pending = readOriginal.call(this);
      if (row) void pending.then(part => { if (part.done) row.eof = true; else if (part.value instanceof Uint8Array) row.bytes += part.value.byteLength; capture(); },
        cause => { row.readerError = error(cause); capture(); }); return pending; };
  });
  const rows: Array<{ request: Request; index: number; phase: string; finishedPhase: string | null; failedPhase: string | null;
    method: string; path: string; requestStartedAt: number; finishedAt: number | null; failedAt: number | null;
    operation: string | null; key: string | null; namespace: string | null; scopeHash: string | null;
    status: number | null; finished: boolean; bodyHash: string; body: unknown; valid: boolean; failed: string | null }> = [];
  const errors: Array<{ kind: string; hash: string }> = [], consoles: Array<{ path: string; expectedLoadAbort: boolean; hash: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url()); if (!url.pathname.startsWith("/api/")) return;
    let operation: string | null = null, key: string | null = null, namespace: string | null = null, scopeHash: string | null = null, body: unknown = null, valid = true;
    if (url.pathname === "/api/creative-studio/invoke") {
      try { body = request.postDataJSON(); } catch { valid = false; }
      const parsed = StudioPersonalInvokeSchema.safeParse(body); valid &&= parsed.success;
      if (parsed.success) { operation = parsed.data.request.operation; key = "key" in parsed.data.request ? parsed.data.request.key : null;
        namespace = "namespace" in parsed.data.request ? parsed.data.request.namespace : null; scopeHash = originalSha(parsed.data.request.scope);
        valid &&= !["generate", "generation.get", "asset.review", "result.submit"].includes(operation)
          && parsed.data.contextAuthority === request.headers()["x-yummyai-context-authority"]; }
      valid &&= request.method() === "POST" && !url.search;
    } else valid &&= request.method() === "GET" || url.pathname === "/api/erp-auth/logout";
    rows.push({ request, index: rows.length, phase, finishedPhase: null, failedPhase: null,
      method: request.method(), path: url.pathname, requestStartedAt: request.timing().startTime, finishedAt: null, failedAt: null,
      operation, key, namespace, scopeHash,
      status: null, finished: false, bodyHash: originalSha(request.postData() ?? ""), body, valid, failed: null });
  });
  // The start uses the browser's epoch timestamp. Terminal timestamps record
  // receipt of the real Playwright event; no status or completion is inferred.
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) { row.failed = request.failure()?.errorText ?? "unknown"; row.failedPhase = phase; row.failedAt = Date.now(); } });
  page.on("requestfinished", request => { const row = rows.find(value => value.request === request); if (row) { row.finished = true; row.finishedPhase = phase; row.finishedAt = Date.now(); } });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) row.status = response.status();
    if (response.status() >= 400) errors.push({ kind: "http_" + response.status(), hash: originalSha(new URL(response.url()).pathname) }); });
  page.on("pageerror", error => errors.push({ kind: "pageerror_" + error.name, hash: originalSha(error.message) }));
  page.on("console", message => { if (message.type() !== "error") return; let path = "";
    try { path = new URL(message.location().url).pathname; } catch { /* Never retain full diagnostic URLs. */ }
    consoles.push({ path, expectedLoadAbort: /^Failed to load resource: net::ERR_(?:ABORTED|FAILED)$/.test(message.text()), hash: originalSha(message.text()) });
  });
  const snapshot = async () => { const value = await page.evaluate(() => (window as AuditWindow).__studioOriginalReads ?? []); allNative.push(value); return value; };
  const currentModels = (native: NativeRead[]) => {
    const consumed = native.findLast(row => row.operation === "models");
    if (!consumed) return;
    const bodyHash = originalSha(consumed.body);
    const host = rows.findLast(row => row.operation === "models" && row.bodyHash === bodyHash && row.request.timing().startTime >= consumed.documentStartedAt);
    return host ? { host, consumed } : undefined;
  };
  const settle = async (requireCurrentModels = false) => {
    let stable = "", consecutive = 0, models: ReturnType<typeof currentModels>;
    await expect.poll(async () => {
      const native = await snapshot(); models = currentModels(native);
      const consumed = native.every(row => row.error || row.readerError || row.eof || row.jsonDone);
      const finished = rows.every(row => row.finished || row.failed);
      const modelComplete = !requireCurrentModels || !!models && models.host.finished && !models.host.failed && models.host.status === 200
        && models.consumed.status === 200 && !models.consumed.error && !models.consumed.readerError && (models.consumed.eof || models.consumed.jsonDone);
      if (!consumed || !finished || !modelComplete) { stable = ""; consecutive = 0; return false; }
      const next = JSON.stringify({ host: rows.map(row => [row.index, row.status, row.finished, row.failed]),
        native: native.map(row => [row.documentStartedAt, row.id, row.status, row.eof, row.jsonDone, row.bytes, row.error, row.readerError]) });
      consecutive = next === stable ? consecutive + 1 : 1; stable = next;
      return consecutive >= 2;
    }, { timeout: 25_000, intervals: [100, 200, 500] }).toBe(true);
    return models;
  };
  const markPhase = async (next: string) => { phase = next; phases.push({ phase, requestIndex: rows.length });
    await page.evaluate(value => { (window as AuditWindow).__studioOriginalPhase = value; }, next); await snapshot(); };
  const reloadBarriers: Array<{ phase: string; requestIndex: number; documentStartedAt: number; nativeId: number; status: number;
    hostFinished: true; nativeBytes: number; nativeEof: boolean; nativeJsonDone: boolean }> = [];
  const beforeReload = async (nextPhase: string) => {
    // Recording the phase precedes the drain: audit evaluation and late startup
    // reads must not enter a gap between the barrier and the actual reload.
    await markPhase(nextPhase); const models = await settle(true);
    if (!models || !models.host.finished || models.host.failed) throw new Error("studio_original_current_models_not_finished_before_reload");
    reloadBarriers.push({ phase, requestIndex: models.host.index, documentStartedAt: models.consumed.documentStartedAt,
      nativeId: models.consumed.id, status: models.host.status!, hostFinished: true, nativeBytes: models.consumed.bytes,
      nativeEof: models.consumed.eof, nativeJsonDone: models.consumed.jsonDone });
  };
  const nativeDiagnostics = () => {
    const latest = new Map<string, NativeRead>();
    for (const batch of allNative) for (const row of batch) latest.set(`${row.documentStartedAt}/${row.id}`, row);
    return [...latest.values()].map(({ body: _body, key, ...row }) => { void _body; return { ...row, keyHash: key ? originalSha(key) : null }; });
  };
  return { rows, errors, consoles, allNative, snapshot, settle, phases, markPhase, beforeReload, reloadBarriers, nativeDiagnostics };
}
export async function originalScreenshot(page: Page, info: TestInfo, name: string) {
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .every(animation => !animation.pending && !["running", "paused"].includes(animation.playState)))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); return path;
}
export async function originalProof(info: TestInfo, value: Record<string, unknown>) {
  await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-original-proof.json"), JSON.stringify(value, null, 2) + "\n");
}
