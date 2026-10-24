import { expect, test, type Locator, type Page, type Request as PlaywrightRequest, type Route, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EntityIdSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_NATIVE_V4_VERSION, AGENT_NATIVE_V4_CLEAR_EVENT, AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX,
  AgentNativeV4ItemReceiptSchema, PrepareAgentNativeV4ItemSchema, AgentNativeV4PreparationIntentSchema } from "@yummyai/contracts/ai/agent-native-v4";
import { AgentFulfillmentOperatorCheckSchema } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, AgentFulfillmentCommandGetQuerySchema, AgentFulfillmentCommandViewSchema, ConfirmAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { FulfillmentCommandReceiptSchema } from "@yummyai/contracts/order/fulfillment-command";
import { AGENT_RESOURCES_VERSION, AgentResourceDefinitionRequestSchema, AgentResourceDefinitionSchema, agentResourceDefinitionPayload,
  AgentResourceCandidatesQuerySchema, AgentResourceCandidatesSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema, AgentToolDefinitionSchema, agentToolDefinitionPayload } from "@yummyai/contracts/ai/agent-tools";
import { requireAgentNativeV4Environment } from "../../../tools/testing/require-agent-native-v4-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentNativeV4Environment(process.env, "current", true), root = fileURLToPath(new URL("../../../", import.meta.url));
const Id = EntityIdSchema, Hash = z.string().regex(/^[a-f0-9]{64}$/), hash = (text: string) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => hash(canonicalJson(value));
const Counters = z.object({ modelCalls: z.int().nonnegative(), responses: z.int().nonnegative(), paidProviderCalls: z.literal(0),
  workerProcesses: z.literal(0), providerFailures: z.int().nonnegative() }).strict();
const Seed = z.object({ version: z.literal(AGENT_NATIVE_V4_VERSION), runId: Id,
  parentRequest: z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict(),
  proposal: z.object({ itemId: Id, position: z.int().min(0).max(7), proposalChecksum: Hash, originalProtocol: z.literal(AGENT_FULFILLMENT_COMMAND_VERSION),
    originalOrderId: Id, originalChecksum: z.null(), preparationRequestChecksum: z.null(), operatorChecks: z.array(AgentFulfillmentOperatorCheckSchema) }).strict(),
  order: z.object({ orderId: Id, lineId: Id, productionOrderId: Id, sequence: z.int().nonnegative() }).strict(),
  delivery: z.object({ packageId: Id, itemId: Id, expectedSequence: z.int().nonnegative(), fileChecksum: Hash, manufacturingPlanChecksum: Hash }).strict(),
  source: z.object({ stepId: Id, resultIndex: z.int().nonnegative(), dataChecksum: Hash, expectedSequence: z.int().nonnegative() }).strict(),
  model: z.object({ providerId: Id, modelId: Id }).strict(), counters: Counters }).strict();
const State = z.object({ run: z.object({ id: Id, requestId: z.uuid(), requestChecksum: Hash, status: z.string(), revision: z.int(), stopped: z.boolean(),
  inputChecksum: Hash, resultChecksum: Hash.nullable(), knownCostUsd: z.string(), unknownCost: z.boolean(), expiresAt: z.iso.datetime() }).strict(),
  item: z.object({ id: Id, proposalChecksum: Hash, originalProtocol: z.string().nullable(), originalOrderId: Id.nullable(), originalChecksum: Hash.nullable(),
    preparationRequestChecksum: Hash.nullable(), completionChecksum: Hash.nullable(), preparationRequested: z.boolean(), fulfillmentIntentId: Id.nullable() }).strict(),
  original: z.object({ id: Id, requestId: z.uuid(), requestChecksum: Hash, contractVersion: z.string(), status: z.string(), generation: z.int(),
    leasePresent: z.boolean(), acknowledged: z.boolean(), redacted: z.boolean(), privateAvailable: z.boolean().nullable(), viewStatus: z.string().nullable(),
    receipt: FulfillmentCommandReceiptSchema.nullable() }).strict().nullable(), originalRead: z.enum(["not_linked", "available", "denied"]), counters: Counters }).strict();
// The original owner fixture's business projection uses MD5, independently of
// the SHA-256 proposal/request/source identities above.
const Business = z.record(z.string().regex(/^[a-z_]+$/), z.object({ count: z.int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{32}$/) }).strict());
function businessChanges(before: z.infer<typeof Business>, after: z.infer<typeof Business>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(table => before[table]?.count !== after[table]?.count || before[table]?.hash !== after[table]?.hash)
    .map(table => ({ table, before: before[table] ?? null, after: after[table] ?? null }));
}
type Source = z.infer<typeof Seed>;
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, code: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}

function ownerChild() {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    resolve(root, "tools/testing/agent-native-v4-browser.mts"), "--agent-native-v4-browser-child"], { cwd: root, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
  const evidence = { pid: child.pid ?? null, closeAcknowledged: false, exited: false, exitCode: null as number | null,
    signal: null as string | null, forced: false, startupCode: null as string | null };
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let acceptReady!: () => void, rejectReady!: (error: Error) => void, sequence = 0, failed: Error | undefined, closing: Promise<void> | undefined;
  const ready = new Promise<void>((done, reject) => { acceptReady = done; rejectReady = reject; }); void ready.catch(() => {});
  const fail = (error: Error) => { failed ??= error; rejectReady(error); for (const value of waiting.values()) value.reject(error); waiting.clear(); };
  child.stderr?.on("data", (bytes: Buffer) => { evidence.startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED)\b/.exec(bytes.toString("utf8"))?.[1] ?? null; });
  child.on("message", (raw: unknown) => {
    const value = z.discriminatedUnion("type", [z.object({ type: z.literal("ready"), nonce: z.literal(isolated.nonce) }).strict(),
      z.object({ type: z.literal("result"), nonce: z.literal(isolated.nonce), id: z.int().positive(), value: z.unknown() }).strict(),
      z.object({ type: z.literal("failure"), nonce: z.literal(isolated.nonce), id: z.int().positive().optional(), phase: z.string().regex(/^[a-z_]{1,64}$/),
        code: z.string().regex(/^(?:[A-Z0-9]{5}|native4_browser_[a-z0-9_]{1,96})$/).nullable() }).strict()]).safeParse(raw);
    if (!value.success) { fail(new Error("native4_browser_ipc_invalid")); return; }
    if (value.data.type === "ready") { acceptReady(); return; }
    if (value.data.type === "failure") { fail(new Error(JSON.stringify(value.data))); return; }
    const pending = waiting.get(value.data.id); if (!pending) { fail(new Error("native4_browser_ipc_unmatched")); return; }
    waiting.delete(value.data.id); pending.resolve(value.data.value);
  });
  child.once("error", () => fail(new Error("native4_browser_child_spawn_failed")));
  const ended = new Promise<void>(done => child.once("close", (code, signal) => {
    evidence.exited = true; evidence.exitCode = code; evidence.signal = signal;
    if (!evidence.closeAcknowledged || code !== 0 || signal) fail(new Error("native4_browser_child_exit_invalid")); done();
  }));
  async function request(input: { operation: "seed"; context: TenantContext } | { operation: "business" | "state" | "close" }) {
    await bounded(ready, "native4_browser_child_ready_timeout", 60_000);
    if (failed || evidence.exited || !child.connected) throw failed ?? new Error("native4_browser_child_unavailable");
    const id = ++sequence;
    return bounded(new Promise<unknown>((done, reject) => {
      waiting.set(id, { resolve: done, reject });
      child.send({ ...input, id, nonce: isolated.nonce }, error => { if (error) { waiting.delete(id); reject(new Error("native4_browser_ipc_delivery_failed")); } });
    }), "native4_browser_child_request_timeout", input.operation === "seed" ? 180_000 : 40_000);
  }
  async function drain() {
    const failures: unknown[] = [];
    try { z.object({ closed: z.literal(true) }).strict().parse(await request({ operation: "close" })); evidence.closeAcknowledged = true; }
    catch (error) { failures.push(error); }
    try { await bounded(ended, "native4_browser_child_close_timeout", 20_000); } catch (error) { failures.push(error); }
    if (!evidence.exited) { evidence.forced = true; child.kill("SIGKILL"); await bounded(ended, "native4_browser_child_forced_close_timeout", 10_000); }
    if (evidence.forced || !evidence.closeAcknowledged || evidence.exitCode !== 0 || evidence.signal) failures.push(new Error("native4_browser_child_cleanup_unverified"));
    if (failures.length) throw new AggregateError(failures, "native4_browser_child_cleanup_failed");
  }
  return { request, evidence, close: () => closing ??= drain() };
}

type ReadAudit = { document: string; sequence: number; beginOrder: number; start: number; method: string; urlHash: string; bodyHash: string | null; authorityHash: string | null;
  status: number | null; echoHash: string | null; resolvedAt: number | null; signalAbortAt: number | null; fetchError: string | null;
  signalAbortOrder: number | null; readerError: string | null; cancelAt: number | null; eofAt: number | null; jsonAt: number | null; bytes: number; reads: number };
type ClearEvent = { document: string; name: string; at: number; order: number };
type BusinessReadBegin = { document: string; path: string; urlHash: string; method: "GET"; at: number; order: number };
declare global { interface Window { __native4Reads?: { document: string; rows: ReadAudit[]; pending: number; failures: number;
  chronology: number; clearEvents: ClearEvent[]; businessReadBegins: BusinessReadBegin[] } } }
const nativePath = "/api/agent-native-v4", afcPath = "/api/agent-fulfillment-commands";
const metadata = [
  { path: "/api/agent-resources/definition", body: AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }) },
  { path: "/api/agent-tools/definition", body: AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } }) },
  { path: "/api/agent-resources/candidates", body: AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" }) },
];
type Row = { ordinal: number; request: PlaywrightRequest; at: number; document: number; path: string; method: string; urlHash: string; erp: boolean;
  bodyHash: string | null; authorityHash: string | null; status: number | null; echoHash: string | null; finished: boolean; failure: string | null;
  metadata: boolean; expectedLoss: boolean; heldClear: boolean; bodyMeta: Record<string, unknown> | null; bodyReadFailed: boolean };

async function observe(page: Page) {
  const rows: Row[] = [], byRequest = new Map<PlaywrightRequest, Row>(), audits = new Map<string, ReadAudit>(), documents = new Map<number, string>();
  const clearEvents = new Map<string, ClearEvent>(), businessReadBegins = new Map<string, BusinessReadBegin>(), terminalClearPairs = new Map<number, Record<string, unknown>>();
  const controls: Array<{ name: string; start: number; end: number | null; authorityHash: string | null }> = [];
  const errors: Array<Record<string, unknown>> = [], tasks = new Set<Promise<void>>(), definitions: Array<Record<string, unknown>> = [];
  let document = 0, authorityHash: string | null = null, source: Source | undefined, originalIntent: string | undefined, cleared = false;
  const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); };
  await page.addInitScript(({ prefixes, paths, clearNames }) => {
    const state: NonNullable<Window["__native4Reads"]> = { document: crypto.randomUUID(), rows: [], pending: 0, failures: 0,
      chronology: 0, clearEvents: [], businessReadBegins: [] };
    window.__native4Reads = state;
    const now = () => performance.timeOrigin + performance.now(), streams = new WeakMap<object, ReadAudit>(), readers = new WeakMap<object, ReadAudit>();
    const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const pending = (job: Promise<void>) => { state.pending++; void job.then(() => state.pending--, () => { state.pending--; state.failures++; }); };
    const errorName = (error: unknown) => error instanceof Error && ["AbortError", "TypeError", "Error"].includes(error.name) ? error.name : "Unknown";
    const responses = new WeakMap<object, ReadAudit>(), fetchOriginal = window.fetch;
    window.fetch = function(input, options) {
      // Native invocation and this timestamp/order are synchronous. Preserve
      // coarse clock ties verbatim; the shared order also covers CLEAR/abort.
      const result = fetchOriginal.call(this, input, options), beginAt = now(), beginOrder = ++state.chronology;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      url.hash = "";
      const method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin === location.origin && method === "GET" && url.pathname.startsWith("/api/") && url.pathname !== "/api/erp-auth/session") {
        const begin: BusinessReadBegin = { document: state.document, path: url.pathname, urlHash: "", method: "GET", at: beginAt, order: beginOrder };
        state.businessReadBegins.push(begin); pending(sha(url.href).then(value => { begin.urlHash = value; }));
      }
      if (url.origin !== location.origin || ![...paths, ...prefixes].some(path => url.pathname === path || prefixes.includes(path) && url.pathname.startsWith(path + "/"))) return result;
      const headers = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined));
      const stamp = headers.get("x-yummyai-context-authority"), signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      const row: ReadAudit = { document: state.document, sequence: state.rows.length + 1, beginOrder, start: beginAt, method, urlHash: "", bodyHash: null, authorityHash: null,
        status: null, echoHash: null, resolvedAt: null, signalAbortAt: null, signalAbortOrder: null, fetchError: null, readerError: null, cancelAt: null, eofAt: null, jsonAt: null, bytes: 0, reads: 0 };
      state.rows.push(row);
      pending((async () => { row.urlHash = await sha(url.href); if (typeof options?.body === "string") row.bodyHash = await sha(options.body); if (stamp) row.authorityHash = await sha(stamp); })());
      const recordAbort = () => { if (row.signalAbortAt === null) { row.signalAbortAt = now(); row.signalAbortOrder = ++state.chronology; } };
      if (signal?.aborted) recordAbort(); else signal?.addEventListener("abort", recordAbort, { once: true });
      void result.then(response => { row.status = response.status; row.resolvedAt = now(); responses.set(response, row); if (response.body) streams.set(response.body, row);
        const echo = response.headers.get("x-yummyai-context-authority"); if (echo) pending(sha(echo).then(value => { row.echoHash = value; }));
      }, error => { row.fetchError = errorName(error); });
      return result; // The original Promise, response, signal and read order remain unchanged.
    };
    const get = ReadableStream.prototype.getReader, read = ReadableStreamDefaultReader.prototype.read, cancel = ReadableStreamDefaultReader.prototype.cancel, json = Response.prototype.json;
    Object.defineProperty(ReadableStream.prototype, "getReader", { ...Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader"), value: function(this: ReadableStream, ...args: unknown[]) {
      const reader: object = Reflect.apply(get, this, args), row = streams.get(this); if (row) readers.set(reader, row); return reader;
    } });
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "read", { ...Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "read"), value: function(this: object, ...args: unknown[]) {
      const result: Promise<{ done: boolean; value?: unknown }> = Reflect.apply(read, this, args), row = readers.get(this);
      if (row) void result.then(value => { if (value.done) row.eofAt = now(); else { row.reads++; if (value.value instanceof Uint8Array) row.bytes += value.value.byteLength; } }, error => { row.readerError = errorName(error); });
      return result;
    } });
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", { ...Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "cancel"), value: function(this: object, ...args: unknown[]) {
      const row = readers.get(this); if (row) row.cancelAt = now(); return Reflect.apply(cancel, this, args);
    } });
    Object.defineProperty(Response.prototype, "json", { ...Object.getOwnPropertyDescriptor(Response.prototype, "json"), value: function(this: Response, ...args: unknown[]) {
      const result: Promise<unknown> = Reflect.apply(json, this, args), row = responses.get(this);
      if (row) void result.then(() => { row.jsonAt = now(); }, error => { row.readerError = errorName(error); }); return result;
    } });
    for (const name of clearNames) window.addEventListener(name, () => state.clearEvents.push({ document: state.document, name, at: now(), order: ++state.chronology }), { capture: true });
  }, { prefixes: [nativePath, afcPath], paths: metadata.map(value => value.path),
    clearNames: [AGENT_LOOP_INTENT_CLEAR_EVENT, AGENT_NATIVE_V4_CLEAR_EVENT, AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, ASSIST_INTENT_CLEAR_EVENT] });
  page.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) document++;
    const url = new URL(request.url()); url.hash = "";
    const meta = metadata.find(value => value.path === url.pathname && !url.search && request.method() === "POST");
    const owned = url.pathname.startsWith(nativePath + "/") || url.pathname.startsWith(afcPath + "/");
    const body = meta || owned ? request.postData() : null;
    let exactMetadata = false;
    if (meta && body) { try { exactMetadata = digest(JSON.parse(body)) === digest(meta.body); } catch { /* Unknown POST remains a failure below. */ } }
    const row: Row = { ordinal: rows.length + 1, request, at: Date.now(), document, path: url.pathname, method: request.method(), urlHash: hash(url.href), erp: url.origin === "http://localhost:3130",
      bodyHash: body === null ? null : hash(body), authorityHash: null, status: null, echoHash: null, finished: false, failure: null,
      metadata: exactMetadata, expectedLoss: false, heldClear: false, bodyMeta: null, bodyReadFailed: false };
    rows.push(row); byRequest.set(request, row);
    track(request.headerValue("x-yummyai-context-authority").then(value => { row.authorityHash = value ? hash(value) : null; }));
  });
  page.on("response", response => {
    const row = byRequest.get(response.request()); if (!row) return;
    row.status = response.status();
    track((async () => {
      const echo = await response.headerValue("x-yummyai-context-authority"); row.echoHash = echo ? hash(echo) : null;
      if (row.status !== 200 || !row.metadata) return;
      try {
        await response.finished(); const value: unknown = await response.json();
        if (row.path === metadata[0].path) { const parsed = AgentResourceDefinitionSchema.parse(value);
          if (parsed.tool !== "research.evidence" || digest(agentResourceDefinitionPayload(parsed)) !== parsed.definitionChecksum) throw new Error("native4_metadata_definition_invalid");
          row.bodyMeta = { definitionChecksum: parsed.definitionChecksum, contextAuthorityHash: hash(parsed.contextAuthority) };
        } else if (row.path === metadata[1].path) { const parsed = AgentToolDefinitionSchema.parse(value);
          if (parsed.selection.kind !== "read" || parsed.selection.tool !== "knowledge.search" || digest(agentToolDefinitionPayload(parsed)) !== parsed.definitionChecksum) throw new Error("native4_metadata_definition_invalid");
          row.bodyMeta = { definitionChecksum: parsed.definitionChecksum, contextAuthorityHash: hash(parsed.contextAuthority) };
        } else if (row.path === metadata[2].path) { const parsed = AgentResourceCandidatesSchema.parse(value);
          if (digest(parsed.query) !== digest(metadata[2].body) || parsed.inputChecksum !== digest(parsed.query)) throw new Error("native4_metadata_candidates_invalid");
          row.bodyMeta = { inputChecksum: parsed.inputChecksum, returned: parsed.coverage.returned, total: parsed.coverage.total, contextAuthorityHash: hash(parsed.contextAuthority) };
        }
      } catch { row.bodyReadFailed = true; }
    })());
  });
  page.on("requestfinished", request => { const row = byRequest.get(request); if (row) row.finished = true; });
  page.on("requestfailed", request => { const row = byRequest.get(request), error = request.failure()?.errorText; if (row) row.failure = error && /^net::ERR_[A-Z_]+$/.test(error) ? error : "unknown"; });
  page.on("pageerror", error => errors.push({ kind: "pageerror", name: ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(error.name) ? error.name : "Unknown", messageHash: hash(error.message) }));
  page.on("console", message => { if (message.type() === "error") errors.push({ kind: "console", at: Date.now(), messageHash: hash(message.text()),
    networkFailure: /^Failed to load resource: net::ERR_(?:FAILED|ABORTED)$/.test(message.text()) }); });
  async function sample() {
    await expect.poll(() => page.evaluate(() => window.__native4Reads?.pending ?? 0)).toBe(0);
    const value = await page.evaluate(() => window.__native4Reads ?? null);
    if (value) {
      documents.set(document, value.document);
      for (const row of value.rows) audits.set(`${row.document}:${row.sequence}`, row);
      for (const event of value.clearEvents) clearEvents.set(`${event.document}:${event.order}`, event);
      for (const begin of value.businessReadBegins) businessReadBegins.set(`${begin.document}:${begin.order}`, begin);
      if (value.failures) throw new Error("native4_passive_observer_failed");
    }
    while (tasks.size) await Promise.all([...tasks]);
    return value;
  }
  async function identity() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json()), actor = actors().operator;
    expect(session.userId).toBe(actor.userId); expect(session.tenantId).toBe(actor.tenantId); expect(session.canUseErp).toBe(true);
    authorityHash = hash(erpSessionAuthority(session));
    return { session, context: TenantContextSchema.parse({ tenantId: session.tenantId, userId: session.userId, permissions: session.permissions,
      dataScope: session.dataScope, permissionScopes: session.permissionScopes, teamIds: session.teamIds, teamAuthority: session.teamAuthority }) };
  }
  async function control<T>(name: string, operation: () => Promise<T>) {
    const entry = { name, start: Date.now(), end: null as number | null, authorityHash }; controls.push(entry);
    try { return await operation(); } finally { await sample(); entry.end = Date.now(); }
  }
  function complete(row: ReadAudit | undefined) { return Boolean(row && row.status === 200 && (row.eofAt !== null || row.jsonAt !== null)
    && row.readerError === null && row.fetchError === null && row.cancelAt === null && (row.signalAbortAt === null || row.signalAbortAt > (row.eofAt ?? row.jsonAt ?? Infinity))); }
  function pair(row: Row) {
    const doc = documents.get(row.document); if (!doc || !row.authorityHash) return undefined;
    const group = rows.filter(item => item.document === row.document && item.method === row.method && item.urlHash === row.urlHash && item.bodyHash === row.bodyHash && item.authorityHash === row.authorityHash);
    const native = [...audits.values()].filter(item => item.document === doc && item.method === row.method && item.urlHash === row.urlHash && item.bodyHash === row.bodyHash && item.authorityHash === row.authorityHash).sort((a, b) => a.sequence - b.sequence);
    return group.length === native.length ? native[group.indexOf(row)] : undefined; // Complete same-document, exact-request sequence; never skip a missing hop.
  }
  async function metadataDom() {
    const resources = page.getByRole("region", { name: "业务资源读取", exact: true }), tools = page.getByRole("region", { name: "原生工具与命令目录", exact: true });
    await expect(resources.locator('button[aria-pressed="true"]').filter({ hasText: "research.evidence" })).toHaveCount(1);
    await expect(tools.locator('button[aria-pressed="true"]').filter({ hasText: "knowledge.search" })).toHaveCount(1);
    const candidates = resources.getByRole("region", { name: "原业务对象候选", exact: true });
    await expect(candidates).toHaveAttribute("aria-busy", "false");
    await expect(candidates.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/)).toHaveCount(1);
    expect(await resources.getByRole("textbox", { name: "搜索原业务对象", exact: true }).inputValue()).toBe("");
    expect(await candidates.getByRole("combobox", { name: "选择原业务对象", exact: true }).inputValue()).toBe("");
    const resourceHash = (await resources.getByRole("region", { name: "所选业务资源定义", exact: true }).locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code").textContent())?.trim();
    const toolHash = (await tools.getByRole("region", { name: "所选严格工具定义", exact: true }).locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code").textContent())?.trim();
    if (!Hash.safeParse(resourceHash).success || !Hash.safeParse(toolHash).success) throw new Error("native4_original_definition_dom_missing");
    definitions.push({ document, authorityHash, resourceHash, toolHash, at: Date.now(), candidatesAccepted: true }); await sample();
  }
  function terminalClear(row: Row, native: ReadAudit | undefined) {
    if (!cleared || !source || !originalIntent || !native || !row.erp || row.method !== "GET" || row.bodyHash !== null || !row.authorityHash
      || row.failure !== "net::ERR_ABORTED" || row.status !== null && row.status !== 200 || native.method !== "GET" || native.bodyHash !== null
      || native.status !== null && native.status !== 200 || native.authorityHash !== row.authorityHash || native.document !== documents.get(row.document)
      || native.fetchError !== "AbortError" && native.readerError !== "AbortError" || native.fetchError !== null && native.fetchError !== "AbortError"
      || native.readerError !== null && native.readerError !== "AbortError" || native.signalAbortAt === null || native.signalAbortOrder === null
      || native.bytes !== 0 || native.reads !== 0 || native.eofAt !== null || native.jsonAt !== null || native.cancelAt !== null) return false;
    const target = row.path === `${nativePath}/workspace` || row.path === `${nativePath}/runs/${source.runId}`
      ? { url: "http://localhost:3130" + row.path, event: AGENT_NATIVE_V4_CLEAR_EVENT }
      : row.path === `${afcPath}/requests/${originalIntent}`
        ? { url: "http://localhost:3130" + row.path + "?" + new URLSearchParams({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: source.order.orderId }), event: AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT }
        : null;
    if (!target || row.urlHash !== hash(target.url) || native.urlHash !== row.urlHash) return false;
    const events = [...clearEvents.values()].filter(value => value.document === native.document).sort((a, b) => a.order - b.order);
    const first = events[0], central = events.filter(value => value.name === AGENT_LOOP_INTENT_CLEAR_EVENT), family = events.filter(value => value.name === target.event);
    const assist = events.filter(value => value.name === ASSIST_INTENT_CLEAR_EVENT), abortAt = native.signalAbortAt;
    const control = controls.find(value => value.name === "actual_logout_CLEAR_before_old200_release" && value.authorityHash === row.authorityHash
      && value.end !== null && abortAt >= value.start && abortAt <= value.end);
    if (!first || central.length !== 1 || family.length !== 1 || assist.length !== 1 || first !== central[0] || !control
      || control.end === null
      || central[0].order >= family[0].order || family[0].order >= assist[0].order
      || native.beginOrder >= central[0].order || native.start > central[0].at || native.signalAbortOrder <= central[0].order
      || abortAt < central[0].at || central[0].at < control.start || assist[0].at > control.end) return false;
    const reverse = rows.filter(value => { const paired = pair(value); return paired?.document === native.document && paired.sequence === native.sequence; });
    if (reverse.length !== 1 || reverse[0] !== row) return false;
    // CLEAR terminates this exact original reader. This is not a successful
    // read and cannot require a new authenticated request after logout.
    terminalClearPairs.set(row.ordinal, { ordinal: row.ordinal, interpretation: "terminal_CLEAR_cancellation_without_consumption",
      request: { document: row.document, method: row.method, urlHash: row.urlHash, bodyHash: row.bodyHash, authorityHash: row.authorityHash, status: row.status, finished: row.finished, failure: row.failure, timing: row.request.timing() },
      native, centralClear: central[0], familyClear: family[0], assistClear: assist[0], control, actualPrivateBodyCheckboxAndBothMarkersAbsent: true });
    return true;
  }
  function check() {
    const failures: Array<Record<string, unknown>> = [], pairings: Array<Record<string, unknown>> = [];
    terminalClearPairs.clear();
    for (const begin of businessReadBegins.values()) {
      const first = [...clearEvents.values()].filter(value => value.document === begin.document).sort((a, b) => a.order - b.order)[0];
      if (first && (begin.order >= first.order || begin.at > first.at)) failures.push({ reason: "business_GET_started_after_CLEAR", begin, firstClear: first });
    }
    for (const row of rows) {
      if (row.status !== null && row.status >= 400) failures.push({ ordinal: row.ordinal, reason: "http_error" });
      if (row.failure && row.failure !== "net::ERR_ABORTED" && !row.expectedLoss) failures.push({ ordinal: row.ordinal, reason: "unexpected_transport_failure" });
      // The synthetic IdP's real login form is outside the ERP API write
      // boundary. It is still recorded and subject to the HTTP-error gate.
      if (row.erp && row.method !== "GET" && row.method !== "HEAD") {
        const prepare = source && row.path === `${nativePath}/runs/${source.runId}/items/${source.proposal.itemId}/prepare`;
        const confirm = originalIntent && row.path === `${afcPath}/requests/${originalIntent}/confirm`;
        if (row.method !== "POST" || !prepare && !confirm && !row.metadata && row.path !== "/api/erp-auth/logout") failures.push({ ordinal: row.ordinal, reason: "unknown_write" });
      }
      const own = row.path.startsWith(nativePath + "/") || row.path.startsWith(afcPath + "/"), native = pair(row);
      if (own || row.metadata) pairings.push({ ordinal: row.ordinal, audit: native ? { document: native.document, sequence: native.sequence } : null,
        basis: "exact_document_method_url_body_authority_complete_sequence", rawCdpStart: row.request.timing().startTime, rawNativeStart: native?.start ?? null });
      if (row.metadata) {
        const dom = definitions.find(value => value.document === row.document && value.authorityHash === row.authorityHash);
        if (row.status !== 200 || !complete(native) || row.echoHash !== row.authorityHash || !row.bodyMeta || row.bodyReadFailed || !dom
          || row.path === metadata[0].path && row.bodyMeta.definitionChecksum !== dom.resourceHash
          || row.path === metadata[1].path && row.bodyMeta.definitionChecksum !== dom.toolHash) failures.push({ ordinal: row.ordinal, reason: "metadata_read_unproven" });
      }
      const terminal = own && row.failure ? terminalClear(row, native) : false;
      if (own && row.failure && !row.expectedLoss && !row.heldClear && !complete(native) && !terminal) {
        const following = rows.find(value => value.ordinal > row.ordinal && value.document === row.document && value.urlHash === row.urlHash && value.method === row.method && value.bodyHash === row.bodyHash && value.authorityHash === row.authorityHash);
        if (row.method !== "GET" || native?.fetchError !== "AbortError" && native?.readerError !== "AbortError" || native?.signalAbortAt === null
          || native?.bytes !== 0 || native?.reads !== 0 || native?.eofAt !== null || native?.jsonAt !== null || !following || !complete(pair(following))) failures.push({ ordinal: row.ordinal, reason: "owned_read_cancel_unproven" });
      }
    }
    for (const error of errors) if (!(error.kind === "console" && error.networkFailure && rows.some(row => row.expectedLoss && row.failure && Math.abs(Number(error.at) - row.at) <= 2000))) failures.push(error);
    expect(failures).toEqual([]); return pairings;
  }
  return { rows, errors, controls, definitions, sample, identity, control, metadataDom, pair, complete, check,
    setSource(value: Source) { source = value; }, setIntent(value: string) { originalIntent = Id.parse(value); },
    markLoss(request: PlaywrightRequest) { const row = byRequest.get(request); if (!row) throw new Error("native4_lost_request_untracked"); row.expectedLoss = true; return row; },
    markClear(request: PlaywrightRequest) { const row = byRequest.get(request); if (!row) throw new Error("native4_clear_request_untracked"); row.heldClear = true; return row; },
    setCleared() { cleared = true; },
    snapshot() { return { scope: "targeted_original_API_consumers_all_HTTP_errors_unknown_ERP_writes_console_errors; unrelated_RSC_cancellation_recorded_without_EOF_claim", cleared,
      requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), native: [...audits.values()], controls, definitions, errors,
      clearEvents: [...clearEvents.values()], businessReadBegins: [...businessReadBegins.values()], terminalClearPairs: [...terminalClearPairs.values()] }; } };
}

async function widths(page: Page, testInfo: TestInfo, name: string, keyboard?: { entry: Locator; target: Locator }) {
  const result: Array<Record<string, unknown>> = [];
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.getAnimations().every(animation => animation.playState !== "running" && !animation.pending))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    if (keyboard) {
      await expect(keyboard.entry).toBeVisible(); await expect(keyboard.target).toBeVisible();
      await keyboard.entry.focus();
      let reached = false;
      for (let step = 0; step < 40; step++) {
        await page.keyboard.press("Tab");
        if (await keyboard.target.evaluate(element => element === document.activeElement)) { reached = true; break; }
      }
      expect(reached).toBe(true);
      // Real Tab scrolling must leave the focused target inside the viewport
      // and uncovered by a sticky footer/header or another element.
      expect(await keyboard.target.evaluate(element => {
        const rect = element.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return rect.width > 0 && rect.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && !!hit && (hit === element || element.contains(hit));
      })).toBe(true);
    }
    const path = testInfo.outputPath(`${name}-${viewport.width}.png`); await page.screenshot({ path, fullPage: false });
    await testInfo.attach(`${name}-${viewport.width}`, { path, contentType: "image/png" }); result.push({ ...viewport, file: path,
      tabReachableAndUncovered: keyboard ? true : null, reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches) });
  }
  return result;
}
async function markers(page: Page) {
  return page.evaluate(({ parent, preparation }) => Object.keys(sessionStorage).filter(key => key.startsWith(parent) || key.startsWith(preparation))
    .flatMap(key => { const text = sessionStorage.getItem(key); if (!text) return []; try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value : [value]; } catch { return [{ invalid: true }]; } }),
  { parent: AGENT_NATIVE_V4_INTENT_PREFIX, preparation: AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX });
}
async function sourceForm(page: Page, source: Source) {
  const handoff = page.getByRole("region", { name: "模型履约提案补项", exact: true }); await expect(handoff).toBeVisible(); await expect(handoff).toHaveAttribute("aria-busy", "false");
  const factorySummary = page.locator("summary").filter({ hasText: /^工厂交付与回执/ }); await expect(factorySummary).toHaveCount(1);
  const factoryDetails = factorySummary.locator("..");
  if (!await factoryDetails.evaluate(element => element instanceof HTMLDetailsElement && element.open)) await factorySummary.click();
  const packet = page.locator(`#delivery-package-${source.delivery.packageId}`); await expect(packet).toBeVisible();
  if (!await packet.evaluate(element => element instanceof HTMLDetailsElement && element.open)) await packet.locator(":scope > summary").click();
  const form = packet.locator('form[aria-label^="登记工厂回执 "]'); await expect(form).toHaveCount(1);
  const details = form.locator(".."); if (!await details.evaluate(element => element instanceof HTMLDetailsElement && element.open)) await details.locator(":scope > summary").click();
  await expect(form).toBeVisible(); const feedbackKind = form.getByRole("combobox", { name: "回执类型", exact: true });
  await expect(feedbackKind).toBeVisible(); await feedbackKind.selectOption("received"); await expect(feedbackKind).toHaveValue("received");
  await expect(form.locator('input[name="verified"]')).not.toBeChecked(); await form.locator('input[name="reference"]').fill("SYNTHETIC-NATIVE-V4-ORIGINAL-UI");
  await form.locator('textarea[name="note"]').fill("Synthetic operator attestation of the original file and manufacturing plan only");
  await form.locator('input[name="occurredAt"]').fill(await page.evaluate(() => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }));
  await form.locator('input[name="verified"]').check(); return form;
}

test.describe("native v4 personal original form handoff", () => {
  for (const clear of [false, true]) test(clear ? "actual_CLEAR_discards_the_held_original200_and_cannot_rebuild_private_markers_at_1440_and_390"
    : "lost201_original_item_GET_recovery_uses_the_same_AFC_drawer_and_one_explicit_received_receipt_at_1440_and_390", async ({ page }, testInfo) => {
    const seen = await observe(page), owner = ownerChild(), releases: Array<() => void> = [], failures: unknown[] = [];
    const proof: Record<string, unknown> = { nonce: isolated.nonce, scope: "precomputed_original_start_and_exact_Redis_processor_with_loopback_Responses; actual_personal_UI_only_completes_prepares_confirms",
      webPaidStartButtonExercised: false, primaryFailure: false, networkFailed: false, cleanupFailed: false };
    try {
      await seen.control("personal_login", () => loginErp(page, "operator", "/navigation")); const person = await seen.identity();
      const seed = Seed.parse(await owner.request({ operation: "seed", context: person.context })); seen.setSource(seed); proof.seed = seed;
      expect(seed.delivery.expectedSequence).toBe(1);
      proof.originalFeedbackKind = "received";
      proof.priorSubmitted = { source: "synthetic_original_owner_seed_before_browser", submittedBeforeBrowser: true,
        expectedSequence: seed.delivery.expectedSequence, browserSubmissionVerified: false };
      expect(seed.counters.modelCalls).toBe(4); expect(seed.counters.responses).toBe(4); expect(seed.counters.providerFailures).toBe(0);
      expect(seed.proposal.operatorChecks.every(value => value.state === "pending")).toBe(true);
      const before = Business.parse(await owner.request({ operation: "business" }));
      proof.businessBeforeUI = before;
      await seen.control("read_completed_parent", async () => {
        await page.goto(`/ai-tasks?${new URLSearchParams({ agentNativeV4: seed.runId })}`);
        const proposals = page.getByRole("region", { name: "逐项核对模型业务与履约提案", exact: true }); await expect(proposals).toBeVisible();
        await expect(proposals.getByRole("listitem", { name: `模型原提案 ${seed.proposal.position + 1}`, exact: true })).toBeVisible();
        await seen.metadataDom();
      });
      await seen.control("original_source_form", async () => {
        const link = page.getByRole("listitem", { name: `模型原提案 ${seed.proposal.position + 1}`, exact: true }).getByRole("link", { name: "到原表单补齐并本人核对", exact: true });
        const href = new URL((await link.getAttribute("href"))!, page.url());
        expect(href.pathname).toBe("/production"); expect(href.searchParams.get("agentNativeV4")).toBe(seed.runId);
        expect(href.searchParams.get("agentNativeV4Item")).toBe(seed.proposal.itemId); expect(href.searchParams.get("delivery")).toBe(seed.delivery.packageId);
        await link.click();
      });
      const form = await sourceForm(page, seed), preparePath = `${nativePath}/runs/${seed.runId}/items/${seed.proposal.itemId}/prepare`;
      proof.operatorCheckboxInitiallyFalseThenManuallyChecked = true;
      await seen.control("responsive_original_form", async () => { proof.formImages = await widths(page, testInfo, "native-v4-original-form", {
        entry: form.getByRole("combobox", { name: "回执类型", exact: true }), target: form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }),
      }); });
      let preparedId: string | null = null;
      const lost = latch(); releases.push(lost.release);
      const lose = async (route: Route) => {
        const request = route.request(), body = PrepareAgentNativeV4ItemSchema.parse(request.postDataJSON());
        expect(request.method()).toBe("POST"); expect(new URL(request.url()).search).toBe("");
        expect(body.requestId).toBe(seed.parentRequest.requestId); expect(body.proposalChecksum).toBe(seed.proposal.proposalChecksum);
        const original = body.completion?.original;
        if (!original || original.kind !== "delivery_feedback") throw new Error("native4_actual_original_feedback_required");
        expect(original.requestId).toBe(seed.proposal.itemId); expect(original.targetId).toBe(seed.delivery.itemId); expect(original.packageId).toBe(seed.delivery.packageId);
        expect(original.input.verifiedByOperator).toBe(true); expect(original.input.kind).toBe("received");
        expect(original.input.fileChecksum).toBe(seed.delivery.fileChecksum); expect(original.input.manufacturingChecksum).toBe(seed.delivery.manufacturingPlanChecksum);
        const response = await route.fetch(); expect(response.status()).toBe(201);
        const receipt = AgentNativeV4ItemReceiptSchema.parse(await response.json()); expect(receipt.disposition).toBe("known");
        preparedId = receipt.fulfillmentIntentId; seen.markLoss(request); lost.release(); await route.abort("failed");
      };
      const prepareMatch = (url: URL) => url.pathname === preparePath;
      await page.route(prepareMatch, lose);
      const beforePrepare = await seen.control("complete_original_and_lose201", async () => {
        const snapshot = Business.parse(await owner.request({ operation: "business" }));
        proof.businessBeforePrepare = snapshot;
        const uiChanges = businessChanges(before, snapshot);
        proof.businessChangesDuringUI = uiChanges;
        proof.searchProjectionAllowance = { phase: "beforeUI_to_beforePrepare_only", table: "order_work_items",
          columns: ["search_revision", "search_specification_version_id", "search_design_executor"],
          protectedDigest: "order_work_items_without_search_projection", countMayChange: false,
          source: "apps/api/src/orders/order-workspace.service.ts:269,383-412 refreshSearchProjection" };
        const protectedKey = "order_work_items_without_search_projection";
        if (!before[protectedKey] || !snapshot[protectedKey] || !before.order_work_items || !snapshot.order_work_items)
          throw new Error("native4_original_business_projection_missing");
        expect(uiChanges.map(value => value.table)).toEqual(uiChanges.length ? ["order_work_items"] : []);
        expect(snapshot.order_work_items.count).toBe(before.order_work_items.count);
        expect(snapshot[protectedKey].count).toBe(before[protectedKey].count);
        expect(snapshot[protectedKey].hash).toBe(before[protectedKey].hash);
        await form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }).click(); await bounded(lost.promise, "native4_original_prepare_not_reached");
        await expect(page.getByText("本项准备结果尚未核对 只读取原回执 不换键或改正文重发", { exact: true })).toBeVisible();
        return snapshot;
      });
      await page.unroute(prepareMatch, lose);
      if (!preparedId) throw new Error("native4_original_intent_missing");
      seen.setIntent(preparedId);
      const staged = State.parse(await owner.request({ operation: "state" }));
      proof.prepared = staged;
      expect(staged.item.fulfillmentIntentId).toBe(preparedId); expect(staged.original?.viewStatus).toBe("prepared"); expect(staged.original?.receipt === null).toBe(true);
      const afterPrepare = Business.parse(await owner.request({ operation: "business" }));
      proof.businessAfterPrepare = afterPrepare;
      proof.businessChangesSinceBeforeUI = businessChanges(before, afterPrepare);
      proof.businessChangesDuringPrepare = businessChanges(beforePrepare, afterPrepare);
      expect(digest(afterPrepare)).toBe(digest(beforePrepare));
      await seen.control("reload_GET_only_original_item_recovery", async () => {
        await page.reload(); const handoff = page.getByRole("region", { name: "模型履约提案补项", exact: true });
        await expect(handoff).toHaveAttribute("aria-busy", "false"); const recover = handoff.getByRole("button", { name: "只读取本项原准备回执", exact: true });
        await expect(recover).toBeEnabled(); await recover.click();
        await expect(page.getByRole("dialog", { name: "核对原履约操作", exact: true })).toBeVisible();
        const params = new URL(page.url()).searchParams; expect(params.get("agentFulfillmentCommand")).toBe(preparedId); expect(params.get("agentNativeV4")).toBe(seed.runId);
        expect(params.get("order")).toBe(seed.order.orderId);
        if (await page.getByRole("region", { name: "业务资源读取", exact: true }).count()) await seen.metadataDom();
      });
      const drawer = page.getByRole("dialog", { name: "核对原履约操作", exact: true }), review = drawer.getByRole("region", { name: "核对 Agent 原履约操作", exact: true });
      await expect(review).toHaveAttribute("aria-busy", "false");
      const confirmation = drawer.getByRole("checkbox", { name: "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约", exact: true });
      await expect(confirmation).not.toBeChecked();
      await expect(drawer.getByRole("region", { name: "完整原履约填写核对", exact: true })).toContainText("SYNTHETIC-NATIVE-V4-ORIGINAL-UI");
      await seen.control("responsive_prepared_original_drawer", async () => { proof.preparedImages = await widths(page, testInfo, "native-v4-prepared-drawer", {
        entry: drawer.getByRole("button", { name: "重新读取原履约操作", exact: true }), target: confirmation,
      }); });
      await expect(confirmation).not.toBeChecked();
      if (!clear) {
        await seen.control("explicit_original_confirmation", async () => {
          await confirmation.check(); const response = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `${afcPath}/requests/${preparedId}/confirm`);
          await drawer.getByRole("button", { name: "确认执行这笔原履约", exact: true }).click(); const actual = await response; expect(actual.status()).toBe(200);
          const input = ConfirmAgentFulfillmentCommandSchema.parse(actual.request().postDataJSON());
          expect(input.orderId).toBe(seed.order.orderId); expect(input.requestId).toBe(seed.proposal.itemId); expect(input.requestChecksum).toBe(staged.item.originalChecksum);
          const result = AgentFulfillmentCommandViewSchema.parse(await actual.json());
          expect(result.native.id).toBe(preparedId); expect(result.native.status).toBe("succeeded");
          const receipt = FulfillmentCommandReceiptSchema.parse(result.native.receipt); if (receipt.kind !== "delivery_feedback") throw new Error("native4_actual_feedback_receipt_required");
          expect(receipt.packageId).toBe(seed.delivery.packageId); expect(receipt.itemId).toBe(seed.delivery.itemId); proof.receipt = receipt;
          await expect(review).toHaveAttribute("aria-busy", "false"); await expect(drawer.getByText("已取得原业务回执", { exact: true })).toBeVisible();
        });
        const completed = State.parse(await owner.request({ operation: "state" })), after = Business.parse(await owner.request({ operation: "business" }));
        expect(completed.original?.viewStatus).toBe("succeeded"); expect(completed.original?.receipt?.kind).toBe("delivery_feedback");
        expect(after.production_delivery_feedback.count - beforePrepare.production_delivery_feedback.count).toBe(1);
        const stable = digest(after); proof.completed = completed;
        await seen.control("responsive_original_receipt", async () => { proof.images = await widths(page, testInfo, "native-v4-original-receipt"); });
        expect(digest(Business.parse(await owner.request({ operation: "business" })))).toBe(stable);
      } else {
        // Real logout synchronously emits the original CLEAR before its network
        // result. The native modal makes the sidebar inert: call only the
        // original button's handler and disclose that activation explicitly.
        // Keep the prepared drawer open and hold its real AFC reader, including
        // the original private content and confirmation credentials in memory.
        const held = latch(), release = latch(), logout = latch(), finishLogout = latch(); releases.push(release.release, finishLogout.release);
        let rawHeld: Row | undefined, heldView: { id: string; canConfirm: boolean; hasToken: boolean } | undefined;
        const detailPath = `${afcPath}/requests/${preparedId}`, heldDelivered = latch(); releases.push(heldDelivered.release);
        await page.route(url => url.pathname === detailPath, async route => {
          expect(route.request().method()).toBe("GET");
          const query = AgentFulfillmentCommandGetQuerySchema.parse(Object.fromEntries(new URL(route.request().url()).searchParams));
          expect(query.orderId).toBe(seed.order.orderId);
          rawHeld = seen.markClear(route.request()); const response = await route.fetch(); expect(response.status()).toBe(200);
          const original = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(original.native.id).toBe(preparedId);
          expect(original.privateAvailable).toBe(true); expect(original.canConfirm).toBe(true); expect(original.confirmationToken !== null).toBe(true);
          expect(hash(original.contextAuthority)).toBe(hash(erpSessionAuthority(person.session)));
          expect(hash(response.headers()["x-yummyai-context-authority"] ?? "")).toBe(hash(erpSessionAuthority(person.session)));
          heldView = { id: original.native.id, canConfirm: original.canConfirm, hasToken: original.confirmationToken !== null };
          held.release(); await release.promise;
          try { await route.fulfill({ response }); }
          catch { await expect.poll(() => route.request().failure()?.errorText).toBe("net::ERR_ABORTED"); }
          finally { heldDelivered.release(); }
        });
        await page.route(url => url.pathname === "/api/erp-auth/logout", async route => { const response = await route.fetch(); expect(response.ok()).toBe(true); logout.release(); await finishLogout.promise; await route.fulfill({ response }); });
        await seen.control("actual_logout_CLEAR_before_old200_release", async () => {
          await drawer.getByRole("button", { name: "重新读取原履约操作", exact: true }).click(); await bounded(held.promise, "native4_held_original_get_missing");
          expect((await markers(page)).length).toBeGreaterThan(0);
          await page.getByRole("button", { name: "退出登录", exact: true }).evaluate(element => {
            if (!(element instanceof HTMLButtonElement)) throw new Error("native4_original_logout_button_invalid"); element.click();
          });
          await bounded(logout.promise, "native4_original_logout_missing");
          await expect(page.getByRole("region", { name: "逐项核对模型业务与履约提案", exact: true })).toHaveCount(0);
          await expect(page.locator('[aria-label="完整原履约填写核对"]')).toHaveCount(0);
          await expect(page.locator('.afc-drawer input[type="checkbox"]')).toHaveCount(0);
          expect((await markers(page)).length).toBe(0); release.release();
          await expect.poll(async () => { const sample = await seen.sample(); return Boolean(sample?.clearEvents.length); }).toBe(true);
          await bounded(heldDelivered.promise, "native4_held_original_delivery_not_finished");
          await expect.poll(async () => {
            await seen.sample(); const value = rawHeld && seen.pair(rawHeld);
            return Boolean(value && (value.fetchError === "AbortError" && value.signalAbortAt !== null && value.bytes === 0 && value.reads === 0 && value.eofAt === null && value.jsonAt === null || seen.complete(value)));
          }).toBe(true);
          await expect(page.getByRole("region", { name: "逐项核对模型业务与履约提案", exact: true })).toHaveCount(0);
          await expect(page.locator('[aria-label="完整原履约填写核对"]')).toHaveCount(0); await expect(page.locator('.afc-drawer input[type="checkbox"]')).toHaveCount(0);
          expect((await markers(page)).length).toBe(0);
          proof.clear = { actualLogout: true, activation: "programmatic_original_logout_handler_due_to_modal", originalHeldStatus: 200,
            ordinal: rawHeld?.ordinal, originalView: heldView, native: rawHeld ? seen.pair(rawHeld) ?? null : null,
            markerPrefixesChecked: [AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX], markersEmpty: true, originalBodyAndConfirmationAbsent: true };
          seen.setCleared(); proof.images = await widths(page, testInfo, "native-v4-real-CLEAR"); finishLogout.release(); await page.waitForURL("**/login");
        });
        expect(digest(Business.parse(await owner.request({ operation: "business" })))).toBe(digest(beforePrepare));
      }
      const posts = seen.rows.filter(row => row.method === "POST" && row.path === preparePath); expect(posts.length).toBe(1);
      expect(seen.rows.filter(row => row.method === "POST" && row.path === `${afcPath}/requests/${preparedId}/confirm`).length).toBe(clear ? 0 : 1);
      const final = State.parse(await owner.request({ operation: "state" })); expect(digest(final.counters)).toBe(digest(seed.counters)); proof.finalState = final;
      const saved = await markers(page); proof.markerCount = saved.length;
      for (const value of saved) { const parsed = AgentNativeV4PreparationIntentSchema.safeParse(value); expect(parsed.success).toBe(true); }
    } catch (error) { proof.primaryFailure = true; failures.push(error); }
    finally {
      for (const release of releases) release();
      try { await seen.sample(); proof.pairings = seen.check(); } catch (error) { proof.networkFailed = true; failures.push(error); }
      try { await owner.close(); } catch (error) { proof.cleanupFailed = true; failures.push(error); }
      proof.child = owner.evidence; proof.network = seen.snapshot();
      const path = testInfo.outputPath("agent-native-v4-proof.json"); await writeFile(path, JSON.stringify(proof, null, 2) + "\n"); await testInfo.attach("agent-native-v4-proof", { path, contentType: "application/json" });
    }
    if (failures.length) throw new AggregateError(failures, "native4_actual_personal_acceptance_failed");
  });
});
