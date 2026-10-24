import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { STUDIO_PERSONAL_CLEAR_EVENT } from "@yummyai/contracts/pod/studio-personal";
import { StudioTransferReceiptSchema, StudioTransferRequestSchema } from "@yummyai/contracts/pod/studio-document-transfer";
import type { StudioDocumentTransferBrowserRequest } from "../../../tools/testing/studio-document-transfer-browser.mts";
import { deferred, observeOriginal, originalDocument, originalScreenshot, originalSha } from "./studio-original-helpers.js";

export { deferred, originalSha as transferSha, originalScreenshot as transferScreenshot };
export const TransferSeed = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), scope: z.uuidv7(), targetScope: z.uuidv7(), canvasId: z.string(),
  sourceTitle: z.string(), targetTitle: z.string(), literal: z.string(), imageDraftPrompt: z.string(), videoDraftPrompt: z.string(), intentKey: z.string(),
  viewport: z.object({ x: z.number(), y: z.number(), k: z.number() }).strict(), media: z.array(z.object({ key: z.string(), namespace: z.enum(["image_files", "media_files"]),
    assetId: z.uuidv7(), checksumSha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().positive(), mediaType: z.string() }).strict()).min(1) }).strict();
const Table = z.object({ count: z.number().int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Entry = z.object({ id: z.uuidv7(), namespace: z.string(), key: z.string(), revision: z.number().int().positive(), value: z.unknown(), assetId: z.uuidv7().nullable(), deletedAt: z.string().nullable() }).passthrough();
const Snapshot = z.object({ entries: z.array(Entry), revisions: z.array(z.unknown()), files: z.array(z.unknown()), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const TransferFacts = z.object({ paid: z.object({ role: z.string(), tables: z.record(z.string(), Table), counts: z.object({ storageReads: z.number(), storageWrites: z.number(), scans: z.number(),
  originalInvokes: z.number(), generationCalls: z.number(), dispatchAttempts: z.number() }).strict(), ownedObjectCount: z.number().int().nonnegative(), providerCalls: z.literal(0), workerProcesses: z.literal(0) }).strict(),
  source: Snapshot, target: Snapshot, originals: z.array(z.object({ key: z.string(), namespace: z.string(), assetId: z.uuidv7(), checksumSha256: z.string(), byteSize: z.number(), mediaType: z.string(),
    actualSha256: z.string(), actualByteSize: z.number() }).strict()), transfers: z.array(z.object({ id: z.uuidv7(), request: StudioTransferRequestSchema,
    receipt: StudioTransferReceiptSchema.nullable(), committedAt: z.string().nullable(), cancelledAt: z.string().nullable() }).passthrough()) }).strict();
export type TransferFacts = z.infer<typeof TransferFacts>;
export function transferPaidUnchanged(before: TransferFacts, after: TransferFacts) {
  expect(after.paid.role).toBe("yummyai_app");
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"])
    expect(after.paid.tables[table]).toEqual(before.paid.tables[table]);
  expect(after.paid.counts.generationCalls).toBe(0); expect(after.paid.counts.dispatchAttempts).toBe(0);
  expect(after.paid.providerCalls).toBe(0); expect(after.paid.workerProcesses).toBe(0);
}
export function transferObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("studio_transfer_browser_expected_object"); return value as Record<string, unknown>;
}
export function transferArray(value: unknown) {
  if (!Array.isArray(value)) throw new Error("studio_transfer_browser_expected_array"); return value.map(transferObject);
}
export function transferDocument(facts: TransferFacts, side: "source" | "target", key: string, namespace = "app_state") {
  const row = facts[side].entries.find(item => item.namespace === namespace && item.key === key && !item.deletedAt);
  if (!row) throw new Error("studio_transfer_browser_expected_document"); return originalDocument(row.value) as unknown;
}
export function transferCanvases(facts: TransferFacts, side: "source" | "target") {
  return transferArray(transferObject(transferObject(transferDocument(facts, side, "infinite-canvas:canvas_store")).state).projects);
}

export function transferOwnerChild(nonce: string) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    fileURLToPath(new URL("../../../tools/testing/studio-document-transfer-browser.mts", import.meta.url)), "--studio-document-transfer-browser-child"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)), env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1",
      TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../api/tsconfig.json", import.meta.url)) }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let next = 0, exited = false, closeAcknowledged = false;
  const exit = deferred<{ code: number | null; signal: string | null }>(), waiting = new Map<number, ReturnType<typeof deferred<unknown>>>();
  child.on("message", (raw: unknown) => {
    const packet = z.union([z.object({ id: z.number().int().positive(), ok: z.literal(true), result: z.unknown() }).strict(),
      z.object({ id: z.number().int().nonnegative(), ok: z.literal(false), errorCode: z.string().regex(/^studio_transfer_(?:browser|fixture)_[a-z_]+$/) }).strict()]).safeParse(raw);
    if (!packet.success) { for (const value of waiting.values()) value.reject(new Error("studio_transfer_browser_child_packet_invalid")); waiting.clear(); return; }
    const pending = waiting.get(packet.data.id); if (!pending) return; waiting.delete(packet.data.id);
    if (packet.data.ok) pending.resolve(packet.data.result); else pending.reject(new Error(packet.data.errorCode));
  });
  child.once("error", () => { for (const pending of waiting.values()) pending.reject(new Error("studio_transfer_browser_child_start_failed")); waiting.clear(); });
  child.once("exit", (code, signal) => { exited = true; exit.resolve({ code, signal }); for (const pending of waiting.values()) pending.reject(new Error("studio_transfer_browser_child_exited")); waiting.clear(); });
  async function rpc(operation: "seed" | "facts" | "close", context?: TenantContext, scenario: "complete" | "recovery" = "complete") {
    const id = ++next, pending = deferred<unknown>(); if (!child.connected || exited) throw new Error("studio_transfer_browser_child_channel_closed");
    const packet: StudioDocumentTransferBrowserRequest = operation === "seed" ? { id, nonce, operation, context: TenantContextSchema.parse(context), scenario } : { id, nonce, operation };
    waiting.set(id, pending); child.send(packet, error => { if (error) { waiting.delete(id); pending.reject(new Error("studio_transfer_browser_child_send_failed")); } });
    const timer = setTimeout(() => { waiting.delete(id); pending.reject(new Error("studio_transfer_browser_child_timeout")); }, 60_000);
    try { return await pending.promise; } finally { clearTimeout(timer); }
  }
  return { rpc, async close() {
    let failure = false; try { closeAcknowledged = z.object({ closed: z.literal(true) }).strict().parse(await rpc("close")).closed; } catch { failure = true; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([exit.promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10_000); })]);
    if (timer) clearTimeout(timer); let forced = false; if (!result) { forced = true; child.kill("SIGKILL"); await exit.promise; }
    return { pid: child.pid ?? null, nonce, closeAcknowledged, exited, forced, code: result?.code ?? null, signal: result?.signal ?? null,
      failed: failure || !closeAcknowledged || forced || result?.code !== 0 };
  } };
}

type ClearRead = { id: number; document: number; start: number; bodyHash: string; authorityHash: string; operation: string | null; requestId: string | null;
  status: number | null; signalAbort: number | null; bytes: number; reads: number; eof: boolean; jsonDone: boolean; error: string | null; readerError: string | null };
type ClearAudit = { document: number; pendingHashes: number; rows: ClearRead[]; events: Array<{ name: string; at: number }> };
type ClearWindow = Window & { __studioTransferClear?: ClearAudit };
async function observeClear(page: Page) {
  const documents = new Map<number, ClearAudit>();
  await page.exposeBinding("__studioTransferClearCapture", (_source, raw: ClearAudit) => { documents.set(raw.document, raw); });
  await page.addInitScript(({ names }) => {
    if (window !== window.top) return;
    const state: ClearAudit = { document: performance.timeOrigin, pendingHashes: 0, rows: [], events: [] }; (window as ClearWindow).__studioTransferClear = state;
    const now = () => performance.timeOrigin + performance.now();
    const capture = () => { const emit = (window as unknown as { __studioTransferClearCapture?: (audit: ClearAudit) => Promise<void> }).__studioTransferClearCapture;
      if (emit) void emit({ ...state, rows: state.rows.map(row => ({ ...row })), events: state.events.map(event => ({ ...event })) }).then(() => {}, () => {}); };
    const error = (cause: unknown) => cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "UnknownError";
    const assignHash = (row: ClearRead, field: "bodyHash" | "authorityHash", value: string) => { state.pendingHashes++;
      void crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then(hash => { row[field] = Array.from(new Uint8Array(hash), part => part.toString(16).padStart(2, "0")).join(""); state.pendingHashes--; capture(); }, () => { state.pendingHashes--; row.error = "HashError"; capture(); }); };
    for (const name of names) window.addEventListener(name, () => { state.events.push({ name, at: now() }); capture(); });
    const responses = new WeakMap<Response, ClearRead>(), streams = new WeakMap<ReadableStream, ClearRead>(), readers = new WeakMap<object, ClearRead>();
    const originalFetch = window.fetch, originalJson = Response.prototype.json;
    window.fetch = function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== location.origin || url.pathname !== "/api/creative-studio/invoke") return originalFetch.call(this, input, init);
      const body = typeof init?.body === "string" ? init.body : ""; let coordinates: { request?: { operation?: string; requestId?: string }; contextAuthority?: string } = {};
      try { coordinates = JSON.parse(body); } catch { /* The shared host observer separately rejects malformed requests. */ }
      const row: ClearRead = { id: state.rows.length + 1, document: state.document, start: now(), bodyHash: "", authorityHash: "", operation: coordinates.request?.operation ?? null,
        requestId: coordinates.request?.requestId ?? null, status: null, signalAbort: null, bytes: 0, reads: 0, eof: false, jsonDone: false, error: null, readerError: null };
      state.rows.push(row); assignHash(row, "bodyHash", body); assignHash(row, "authorityHash", new Headers(init?.headers).get("x-yummyai-context-authority") ?? coordinates.contextAuthority ?? "");
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (signal?.aborted) row.signalAbort = now(); else signal?.addEventListener("abort", () => { row.signalAbort = now(); capture(); }, { once: true });
      const pending = originalFetch.call(this, input, init);
      void pending.then(response => { row.status = response.status; responses.set(response, row); if (response.body) streams.set(response.body, row); capture(); }, cause => { row.error = error(cause); capture(); }); return pending;
    };
    Response.prototype.json = function() { const row = responses.get(this), pending = originalJson.call(this);
      if (row) void pending.then(() => { row.jsonDone = true; capture(); }, cause => { row.readerError = error(cause); capture(); }); return pending; };
    const originalReader = ReadableStream.prototype.getReader;
    function trackedReader(this: ReadableStream, options: { mode: "byob" }): ReadableStreamBYOBReader;
    function trackedReader(this: ReadableStream): ReadableStreamDefaultReader<unknown>;
    function trackedReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown>;
    function trackedReader(this: ReadableStream, options?: ReadableStreamGetReaderOptions): ReadableStreamReader<unknown> {
      const reader = originalReader.call(this, options), row = streams.get(this); if (row) readers.set(reader, row); return reader;
    }
    ReadableStream.prototype.getReader = trackedReader;
    const originalRead = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function() { const row = readers.get(this), pending = originalRead.call(this);
      if (row) void pending.then(part => { row.reads++; if (part.done) row.eof = true; else if (part.value instanceof Uint8Array) row.bytes += part.value.byteLength; capture(); }, cause => { row.readerError = error(cause); capture(); }); return pending; };
  }, { names: [ASSIST_INTENT_CLEAR_EVENT, AGENT_LOOP_INTENT_CLEAR_EVENT, STUDIO_PERSONAL_CLEAR_EVENT] });
  const snapshot = async () => { const state = await page.evaluate(() => (window as ClearWindow).__studioTransferClear); if (state) documents.set(state.document, state); };
  const boundary = async () => page.evaluate(() => {
    const state = (window as ClearWindow).__studioTransferClear;
    if (!state) throw new Error("studio_transfer_browser_native_clear_audit_missing");
    return { document: state.document, lastId: state.rows.at(-1)?.id ?? 0, at: performance.timeOrigin + performance.now() };
  });
  return { documents, snapshot, boundary };
}
export async function observeTransfer(page: Page) { return { ...await observeOriginal(page), clear: await observeClear(page) }; }
export type TransferSeen = Awaited<ReturnType<typeof observeTransfer>>;
export function verifyTransferNetwork(seen: TransferSeen, allowedFailures: Set<Request>) {
  expect(seen.rows.every(row => row.valid)).toBe(true); expect(seen.errors).toEqual([]);
  expect(seen.rows.filter(row => row.failed && !allowedFailures.has(row.request))).toEqual([]);
  const expectedAbortCount = seen.rows.filter(row => row.failed && allowedFailures.has(row.request)).length;
  const expectedConsole = seen.consoles.filter(row => row.expectedLoadAbort && row.path === "/api/creative-studio/invoke");
  expect(expectedConsole.length).toBeLessThanOrEqual(expectedAbortCount); expect(seen.consoles.filter(row => !expectedConsole.includes(row))).toEqual([]);
}
export async function transferNetworkProof(seen: TransferSeen, proof: Record<string, unknown>) {
  try { await seen.snapshot(); await seen.clear.snapshot(); } catch { proof.nativeSnapshotIncomplete = true; }
  proof.phases = [...seen.phases]; proof.reloadBarriers = [...seen.reloadBarriers];
  proof.network = seen.rows.map(({ request: _request, body: _body, key, ...row }) => { void _request; void _body; return { ...row, keyHash: key ? originalSha(key) : null }; });
  proof.native = seen.nativeDiagnostics(); proof.clear = [...seen.clear.documents.values()]; proof.errors = [...seen.errors]; proof.consoles = [...seen.consoles];
}
export async function transferProof(info: TestInfo, proof: Record<string, unknown>) {
  await mkdir(info.outputDir, { recursive: true }); await writeFile(info.outputPath("studio-document-transfer-proof.json"), JSON.stringify(proof, null, 2) + "\n");
}
