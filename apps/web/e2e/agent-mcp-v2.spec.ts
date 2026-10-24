import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { expect, test, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_MCP_TOOL_NAMES as names } from "@yummyai/contracts/ai/agent-mcp";
import { AgentMcpV2PacketSchema } from "@yummyai/contracts/ai/agent-mcp-v2";
import { AGENT_NATIVE_V3_VERSION, CreateAgentNativeV3Schema, AgentNativeV3ViewSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ItemReceiptSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { requireAgentMcpV2Environment } from "../../../tools/testing/require-agent-mcp-v2-environment.mjs";
import { agentReadBrowserFixture } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const Connection = z.object({ clientId: z.int().nonnegative(), tools: z.array(z.string()), personal: ErpSessionViewSchema }).strict();
const Progress = z.object({ modelCalls: z.int().nonnegative(), definitions: z.int().nonnegative(), reads: z.int().nonnegative(), settled: z.boolean(), entered: z.boolean(), failure: z.string().nullable() }).strict();
const Packet = z.object({ packet: AgentMcpV2PacketSchema, isError: z.boolean() }).strict();
const flags = ["--allow-native-v3", "--allow-model-run", "--max-cost-usd=1", "--allow-prepare", "--allow-fulfillment", "--allow-command=procurement/requisition_create", "--allow-command=finance/bill_record"];
test.describe.configure({ mode: "serial" }); test.setTimeout(300_000);
async function bounded<T>(promise: Promise<T>, code: string, ms = 30_000): Promise<T> { let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class McpV2Child {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { yes(value: unknown): void; no(error: Error): void; timer: NodeJS.Timeout }>();
  readonly evidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false,
    clients: [] as Array<{ closed: boolean; processExited: boolean; credentialLeaked: boolean; injectedEnvironmentKeys: string[] }> };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-mcp-v2.test-fixture.ts"), "--agent-mcp-v2-browser-child"], { cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let yes!: () => void, no!: (error: Error) => void; this.ready = new Promise((accept, reject) => { yes = accept; no = reject; });
    const timeout = setTimeout(() => no(new Error("mcp_v2_child_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (code, signal) => { clearTimeout(timeout); Object.assign(this.evidence, { exited: true, exitCode: code, signal });
      no(new Error("mcp_v2_child_exited_before_ready")); for (const row of this.pending.values()) { clearTimeout(row.timer); row.no(new Error("mcp_v2_child_exited_with_pending_request")); } this.pending.clear(); done(); }));
    this.child.once("error", () => { clearTimeout(timeout); no(new Error("mcp_v2_child_spawn_failed")); });
    this.child.on("message", raw => { if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce) return; if (value.type === "ready") { clearTimeout(timeout); yes(); return; }
      if (typeof value.id !== "number" || !["result", "failure"].includes(String(value.type))) return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.yes(value.value); else row.no(new Error("mcp_v2_child_failed_" + (typeof value.phase === "string" && /^[a-z0-9_]{1,80}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[a-z0-9_]{1,80}$/.test(value.code) ? "_" + value.code : ""))); });
  }
  async request(input: Record<string, unknown>) {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("mcp_v2_child_unavailable"); const id = ++this.sequence;
    return new Promise<unknown>((yes, no) => { const timer = setTimeout(() => { this.pending.delete(id); no(new Error("mcp_v2_child_request_timeout")); }, input.operation === "close" ? 20_000 : 180_000);
      this.pending.set(id, { yes, no, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); no(new Error("mcp_v2_child_delivery_failed")); } }); });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.evidence.exited) { const value = z.object({ closed: z.literal(true), clients: z.array(z.object({ closed: z.boolean(), processExited: z.boolean(), credentialLeaked: z.boolean(), injectedEnvironmentKeys: z.array(z.string()) }).passthrough()) }).strict()
      .parse(await this.request({ operation: "close" })); this.evidence.acknowledged = value.closed; this.evidence.clients = value.clients; } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "mcp_v2_child_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.evidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "mcp_v2_child_kill_exit_timeout", 2000); } catch (failure) { errors.push(failure); } }
    if (!this.evidence.acknowledged || this.evidence.exitCode !== 0 || this.evidence.signal !== null || !this.evidence.exited || this.evidence.clients.some(client => !client.closed || !client.processExited || client.credentialLeaked))
      errors.push(new Error("mcp_v2_child_unclean_exit")); if (errors.length) throw new AggregateError(errors, "MCP v2 browser child cleanup failed");
  }
}
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function fixture(leaf: string) {
  requireAgentMcpV2Environment(process.env, true); const base = await agentReadBrowserFixture("mcp-v2-" + leaf); let child: McpV2Child;
  try { child = new McpV2Child(base.nonce); } catch (error) { try { await base.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "MCP v2 browser initialization failed"); } throw error; }
  let closed = false;
  return { ...base, childClose: child.evidence, seed: () => child.request({ operation: "seed", context: TenantContextSchema.parse(base.context) }),
    async login(page: Page) {
      const auth = z.object({ authorizationUrl: z.url() }).strict().parse(await child.request({ operation: "auth_begin" }));
      const issuer = new URL(process.env.FACTORY_IDENTITY_FIXTURE_URL!); expect(new URL(auth.authorizationUrl).origin).toBe(issuer.origin);
      const popup = await page.context().newPage();
      try { await popup.goto(auth.authorizationUrl); await expect(popup.getByRole("heading", { name: "Synthetic identity fixture", exact: true })).toBeVisible();
        await popup.getByRole("combobox", { name: /^Test account/ }).selectOption("operator"); await popup.getByRole("button", { name: "Continue synthetic login", exact: true }).click();
        await expect(popup.getByText("ERP sign-in received. You may close this window.", { exact: true })).toBeVisible();
      } finally { await popup.close(); }
      const connection = Connection.parse(await child.request({ operation: "auth_finish", flags })), personal = await session(page);
      expect(connection.personal.userId).toBe(personal.userId); expect(connection.personal.tenantId).toBe(personal.tenantId);
      expect(erpSessionAuthority(connection.personal)).toBe(erpSessionAuthority(personal)); expect(connection.personal.userId).toBe(base.context.userId); return connection;
    },
    async connect() { return Connection.parse(await child.request({ operation: "connect", flags })); },
    async call(id: number, name: string, input: Record<string, unknown>) { return Packet.parse(await child.request({ operation: "call", clientId: id, name, input })); },
    async input(id: number, mode: "fulfillment" | "one") { return CreateAgentNativeV3Schema.parse(await child.request({ operation: "request", clientId: id, mode })); },
    execute: (id: string, hold = false) => child.request({ operation: "execute", runId: id, hold }), release: () => child.request({ operation: "release" }),
    async progress() { return Progress.parse(await child.request({ operation: "progress" })); }, async wait() { return Progress.parse(await child.request({ operation: "wait" })); },
    business: () => child.request({ operation: "business" }), state: (requestId: string) => child.request({ operation: "state", requestId }),
    refresh: () => child.request({ operation: "refresh" }),
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      for (const done of [() => base.restore(), () => child.close(), () => base.close()]) try { await done(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "MCP v2 personal browser cleanup failed"); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const metadataReadPaths = [
  "/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/agent-native-v3/workspace", "/api/agent-reads/workspace",
  "/api/agent-resources/workspace", "/api/agent-tools/workspace", "/api/agent-fulfillment/workspace", "/api/agent-commands/workspace",
  "/api/ai-assists/task-workspace", "/api/ai-assists/models", "/api/agent-loops/workspace",
];
const nativeRunPath = /^\/api\/agent-native-v3\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const commandRequestPath = /^\/api\/agent-commands\/requests\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
function readQueryVariant(url: URL): "none" | "assist_page1" | "unsupported" {
  return url.search === "" ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "unsupported";
}
const ReadAuditSchema = z.object({
  documentAt: z.number().positive().finite(), sequence: z.int().positive(), startedAt: z.int().nonnegative(), at: z.int().nonnegative(),
  path: z.string().refine(path => metadataReadPaths.includes(path) || nativeRunPath.test(path) || commandRequestPath.test(path)),
  queryVariant: z.enum(["none", "assist_page1"]), method: z.literal("GET"), status: z.int().min(0).max(599).optional(),
  bytes: z.int().nonnegative().nullable(), reads: z.int().nonnegative(), eofAt: z.int().nonnegative().optional(), abortSeenAtEof: z.boolean().optional(),
  completion: z.enum(["reader", "json"]).optional(), signalAbortAt: z.int().nonnegative().optional(), bodyCancelAt: z.int().nonnegative().optional(),
  bodyErrorAt: z.int().nonnegative().optional(), fetchErrorAt: z.int().nonnegative().optional(),
  bodyErrorName: z.enum(["AbortError", "TimeoutError", "TypeError", "Error", "DOMException"]).optional(),
  fetchErrorName: z.enum(["AbortError", "TimeoutError", "TypeError", "Error", "DOMException"]).optional(),
}).strict().refine(row => row.queryVariant === "none" || row.path === "/api/ai-assists/task-workspace");
type ReadAudit = z.infer<typeof ReadAuditSchema>;
/** Observe only reads the application already performs; return every original Promise unchanged. */
async function installReadCompletionAudit(page: Page) {
  const entries = new Map<string, ReadAudit>(); let rejected = 0;
  await page.exposeBinding("__yummyaiMcpV2ReadComplete", (source, value: unknown) => {
    if (source.frame !== page.mainFrame()) return;
    const parsed = ReadAuditSchema.safeParse(value); if (!parsed.success) { rejected++; return; }
    const row = parsed.data; entries.set(row.documentAt + ":" + row.sequence, row);
    if (entries.size > 250) entries.delete(entries.keys().next().value!);
  });
  await page.addInitScript(({ metadata }) => {
    type State = {
      documentAt: number; sequence: number; startedAt: number; at: number; path: string; method: "GET"; queryVariant: "none" | "assist_page1";
      status?: number; bytes: number | null; reads: number; eofAt?: number; abortSeenAtEof?: boolean; completion?: "reader" | "json"; signalAbortAt?: number;
      bodyCancelAt?: number; bodyErrorAt?: number; fetchErrorAt?: number; bodyErrorName?: string; fetchErrorName?: string;
    };
    const responses = new WeakMap<Response, State>(), streams = new WeakMap<object, State>(), readers = new WeakMap<object, State>(); let sequence = 0;
    const publish = (state: State) => {
      try { state.at = Date.now();
        const send = (window as Window & { __yummyaiMcpV2ReadComplete?: (entry: State) => Promise<void> }).__yummyaiMcpV2ReadComplete;
        if (send) void send({ ...state }).catch(() => {});
      } catch { /* Audit delivery never changes the application's operation. */ }
    };
    const errorName = (value: unknown) => value && typeof value === "object" && "name" in value && typeof value.name === "string" &&
      ["AbortError", "TimeoutError", "TypeError", "Error", "DOMException"].includes(value.name) ? value.name : "Error";
    const fetch = window.fetch;
    window.fetch = function (...args: Parameters<typeof fetch>) {
      let state: State | undefined;
      try {
        const [input, init] = args, request = input instanceof Request ? input : null;
        const url = new URL(request?.url ?? String(input), location.href), method = (init?.method ?? request?.method ?? "GET").toUpperCase();
        const selected = metadata.includes(url.pathname) ||
          /^\/api\/agent-native-v3\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname) ||
          /^\/api\/agent-commands\/requests\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname);
        const queryVariant = url.search === "" ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "unsupported";
        if (url.origin === location.origin && method === "GET" && queryVariant !== "unsupported" && selected) {
          const now = Date.now(); state = { documentAt: performance.timeOrigin, sequence: ++sequence, startedAt: now, at: now,
            path: url.pathname, method: "GET", queryVariant, bytes: 0, reads: 0 };
          const original = state, signal = init && "signal" in init ? init.signal : request?.signal;
          signal?.addEventListener("abort", () => { original.signalAbortAt = Date.now(); publish(original); }, { once: true });
          if (signal?.aborted) original.signalAbortAt = now;
          publish(original);
        }
      } catch { /* No request, header, body or cancellation reason is retained. */ }
      const result = Reflect.apply(fetch, this, args) as ReturnType<typeof fetch>;
      try {
        const original = state;
        if (original) void result.then(response => {
          try { original.status = response.status; responses.set(response, original); if (response.body) streams.set(response.body, original); publish(original); }
          catch { /* Never clone, tee or read an additional body. */ }
        }, failure => { original.fetchErrorAt = Date.now(); original.fetchErrorName = errorName(failure); publish(original); });
      } catch { /* Preserve the original Promise and its rejection. */ }
      return result;
    };
    const getReader = ReadableStream.prototype.getReader;
    ReadableStream.prototype.getReader = function (this: ReadableStream<unknown>, ...args: Parameters<typeof getReader>) {
      const result = Reflect.apply(getReader, this, args) as ReturnType<typeof getReader>;
      try { const state = streams.get(this); if (state) readers.set(result, state); } catch { /* Preserve the original reader. */ }
      return result;
    } as typeof getReader;
    const read = ReadableStreamDefaultReader.prototype.read;
    ReadableStreamDefaultReader.prototype.read = function (this: ReadableStreamDefaultReader<unknown>, ...args: Parameters<typeof read>) {
      const result = Reflect.apply(read, this, args) as Promise<ReadableStreamReadResult<unknown>>;
      try {
        const state = readers.get(this);
        if (state) void result.then(part => {
          try { state.reads++;
            if (!part.done && ArrayBuffer.isView(part.value)) state.bytes = (state.bytes ?? 0) + part.value.byteLength;
            if (part.done) {
              if (state.eofAt === undefined) { state.eofAt = Date.now(); state.completion = "reader"; state.abortSeenAtEof = state.signalAbortAt !== undefined; }
              publish(state);
            }
          } catch { /* Only byte lengths and EOF are observed; chunk contents are not copied. */ }
        }, failure => { state.bodyErrorAt = Date.now(); state.bodyErrorName = errorName(failure); publish(state); });
      } catch { /* The original read Promise remains the returned value. */ }
      return result;
    };
    const readerCancel = ReadableStreamDefaultReader.prototype.cancel;
    ReadableStreamDefaultReader.prototype.cancel = function (this: ReadableStreamDefaultReader<unknown>, ...args: Parameters<typeof readerCancel>) {
      const result = Reflect.apply(readerCancel, this, args) as Promise<void>;
      try { const state = readers.get(this); if (state) { state.bodyCancelAt = Date.now(); publish(state); } } catch { /* Do not inspect the reason. */ }
      return result;
    };
    const streamCancel = ReadableStream.prototype.cancel;
    ReadableStream.prototype.cancel = function (this: ReadableStream<unknown>, ...args: Parameters<typeof streamCancel>) {
      const result = Reflect.apply(streamCancel, this, args) as Promise<void>;
      try { const state = streams.get(this); if (state) { state.bodyCancelAt = Date.now(); publish(state); } } catch { /* Preserve original cancellation. */ }
      return result;
    };
    const json = Response.prototype.json;
    Response.prototype.json = function (this: Response, ...args: Parameters<typeof json>) {
      const result = Reflect.apply(json, this, args) as ReturnType<typeof json>;
      try {
        const state = responses.get(this);
        if (state) void result.then(() => {
          if (state.eofAt === undefined) { state.eofAt = Date.now(); state.completion = "json"; state.abortSeenAtEof = state.signalAbortAt !== undefined; }
          if (!state.reads) state.bytes = null; publish(state);
        }, failure => { state.bodyErrorAt = Date.now(); state.bodyErrorName = errorName(failure); publish(state); });
      } catch { /* The fulfilled JSON value is never accessed or retained. */ }
      return result;
    };
  }, { metadata: metadataReadPaths });
  return { snapshot: () => [...entries.values()], rejected: () => rejected };
}
function observe(page: Page) {
  const metadata = new Set(metadataReadPaths), navigationPaths = new Set(["/", "/ai-tasks", "/business-tasks", "/navigation", "/orders", "/production", "/logistics"]);
  type Navigation = { at: number; startedAt: number | null; generation: number; path: string; fullDocument: boolean };
  type Control = { id: number; kind: string; start: number; end: number | null; startGeneration: number; endGeneration: number | null; completed: boolean;
    before: { path: string; commandId: string | null }; after: Control["before"] | null; authorityHashes: string[]; navigations: Navigation[] };
  type Observed = { ordinal: number; path: string; method: string; authorityHash: string | null; responseAuthorityHash: string | null; at: number; generation: number; settled: boolean;
    resourceType: string; isNavigation: boolean; local: boolean; queryEmpty: boolean; queryVariant: ReturnType<typeof readQueryVariant>;
    nextRouterPrefetch: boolean; rsc: boolean; timing: Record<string, number>; responseStatus: number | null };
  type Failure = Observed & { code: string; failedAt: number };
  const timing = (request: Request) => Object.fromEntries(Object.entries(request.timing()).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
  const identity = () => { const url = new URL(page.url()), value = url.searchParams.get("agentCommand");
    return { path: url.pathname, commandId: value && /^[a-f0-9-]{36}$/i.test(value) ? value : null }; };
  const requests = new Map<Request, Observed>(), controls: Control[] = [], navigations: Navigation[] = [], knownRunIds = new Set<string>(), preparedCommands = new Set<string>();
  const knownAuthorities = new Map<string, { userId: string; tenantId: string; source: "personal_session" }>();
  const documentRequests: Array<{ at: number; path: string; ordinal: number; used: boolean }> = [];
  const pageErrors: string[] = [], consoleErrors: Array<{ path: string; hash: string }> = [], responses: Array<{ path: string; status: number }> = [];
  const posts: string[] = [], failures: Failure[] = [], classifications: Array<Record<string, unknown>> = []; let generation = 0, sequence = 0;
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return; generation++; const path = new URL(frame.url()).pathname;
    const document = documentRequests.findLast(row => !row.used && row.path === path && row.at >= (navigations.at(-1)?.at ?? 0) &&
      [...requests.values()].some(request => request.ordinal === row.ordinal && request.responseStatus === 200)); if (document) document.used = true;
    const navigation = { at: Date.now(), startedAt: document?.at ?? null, generation, path, fullDocument: document !== undefined }; navigations.push(navigation);
    for (const control of controls) if (control.end === null) control.navigations.push(navigation);
  });
  page.on("request", request => {
    const url = new URL(request.url()), headers = request.headers(), authority = headers["x-yummyai-context-authority"], now = Date.now();
    requests.set(request, { ordinal: ++sequence, path: url.pathname, method: request.method(), authorityHash: authority ? sha(authority) : null,
      responseAuthorityHash: null, at: now, generation, settled: false, resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(),
      local: url.origin === "http://localhost:3130", queryEmpty: url.search === "", queryVariant: readQueryVariant(url),
      nextRouterPrefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", timing: timing(request), responseStatus: null });
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push({ at: now, path: url.pathname, ordinal: sequence, used: false });
    if (request.method() === "POST") posts.push(url.pathname);
  });
  page.on("requestfinished", request => { const row = requests.get(request); if (row) { row.settled = true; row.timing = timing(request); } });
  page.on("requestfailed", request => { const row = requests.get(request); if (row) { row.settled = true; row.timing = timing(request);
    failures.push({ ...row, code: request.failure()?.errorText === "net::ERR_ABORTED" ? "net::ERR_ABORTED" : "other", failedAt: Date.now() }); } });
  page.on("pageerror", error => pageErrors.push(sha(error.message)));
  page.on("console", message => { if (message.type() !== "error") return; let path = "unknown"; try { path = new URL(message.location().url).pathname; } catch { /* Kept as unknown. */ }
    consoleErrors.push({ path, hash: sha(message.text()) }); });
  page.on("response", response => { const row = requests.get(response.request()), authority = response.headers()["x-yummyai-context-authority"];
    if (row) { row.responseStatus = response.status(); row.responseAuthorityHash = authority ? sha(authority) : null; row.timing = timing(response.request()); }
    if (response.status() >= 400) responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  const currentAuthority = async () => {
    const personal = await session(page), authority = erpSessionAuthority(personal), hash = sha(authority);
    knownAuthorities.set(hash, { userId: personal.userId, tenantId: personal.tenantId, source: "personal_session" });
    for (const control of controls) if (control.end === null && !control.authorityHashes.includes(hash)) control.authorityHashes.push(hash);
    return authority;
  };
  const stable = async () => {
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect.poll(() => [...requests.values()].filter(row => !row.settled && (row.path.startsWith("/api/") ||
      row.rsc && !row.nextRouterPrefetch && navigationPaths.has(row.path))).length).toBe(0);
  };
  const eligibleRead = (row: Observed) => row.local && row.method === "GET" && row.resourceType === "fetch" && !row.isNavigation &&
    (row.queryEmpty && row.queryVariant === "none" || !row.queryEmpty && row.path === "/api/ai-assists/task-workspace" && row.queryVariant === "assist_page1") &&
    row.authorityHash !== null && knownAuthorities.has(row.authorityHash) && (metadata.has(row.path) ||
      nativeRunPath.test(row.path) && knownRunIds.has(row.path.slice(row.path.lastIndexOf("/") + 1).toLowerCase()) ||
      commandRequestPath.test(row.path) && preparedCommands.has(row.path.slice(row.path.lastIndexOf("/") + 1).toLowerCase()));
  const classify = (row: Failure, audits: ReadAudit[]) => {
    const result = (kind: string, audit?: ReadAudit, control?: Control, navigation?: Navigation) => ({ ordinal: row.ordinal, kind,
      auditKey: audit ? audit.documentAt + ":" + audit.sequence : null, controlId: control?.id ?? null, navigationGeneration: navigation?.generation ?? null,
      actualStartTime: row.timing.startTime ?? 0, fetchStartedAt: audit?.startedAt ?? null, browserEofAt: audit?.eofAt ?? null, nodeFailedAt: row.failedAt,
      bytes: audit?.bytes ?? null, observedCallbackDifferenceMs: audit?.eofAt === undefined ? null : audit.eofAt - row.failedAt,
      clockRelation: "independent_callback_observations" });
    if (row.code !== "net::ERR_ABORTED") return null;
    if (row.local && row.method === "GET" && row.resourceType === "fetch" && !row.isNavigation && row.responseStatus === 200 &&
      row.authorityHash === null && navigationPaths.has(row.path)) {
      if (row.nextRouterPrefetch) return result("intentional_prefetch_cancel");
      const control = controls.find(value => value.completed && value.end !== null && row.at >= value.start && row.failedAt <= value.end &&
        row.generation >= value.startGeneration && row.generation <= value.endGeneration! && value.navigations.some(nav => nav.path === row.path));
      if (row.rsc && control) return result("controlled_navigation_rsc_cancel", undefined, control, control.navigations.find(nav => nav.path === row.path));
    }
    if (!eligibleRead(row)) return null;
    const closeStart = (request: Observed, audit: ReadAudit) => request.path === audit.path && request.method === audit.method && request.queryVariant === audit.queryVariant &&
      (request.responseStatus === null ? audit.status === undefined : audit.status === request.responseStatus) &&
      Math.abs((request.timing.startTime && request.timing.startTime > 0 ? request.timing.startTime : request.at) - audit.startedAt) <= 25;
    const candidates = audits.filter(audit => closeStart(row, audit));
    if (candidates.length > 1 || candidates.length === 1 && [...requests.values()].filter(other => eligibleRead(other) && closeStart(other, candidates[0]!)).length !== 1) return null;
    const audit = candidates[0], responseMatches = row.responseStatus === 200 && row.responseAuthorityHash === row.authorityHash;
    if (audit?.status === 200 && responseMatches && row.timing.startTime! > 0 && row.timing.responseStart! >= 0 && row.timing.responseEnd! >= row.timing.responseStart! &&
      audit.eofAt !== undefined && audit.abortSeenAtEof === false && (audit.completion === "json" ||
        audit.completion === "reader" && audit.reads > 0 && audit.bytes !== null && audit.bytes > 0) &&
      audit.bodyCancelAt === undefined && audit.bodyErrorAt === undefined && audit.fetchErrorAt === undefined)
      return result("completed_read_with_terminal_abort", audit);
    if (audit && audit.eofAt === undefined && audit.bytes === 0 && audit.bodyCancelAt === undefined && audit.signalAbortAt !== undefined &&
      audit.signalAbortAt <= row.failedAt && (audit.fetchErrorName === "AbortError" || audit.bodyErrorName === "AbortError") && (row.responseStatus === null || responseMatches)) {
      const control = controls.find(value => value.completed && value.end !== null && row.authorityHash !== null && value.authorityHashes.includes(row.authorityHash) &&
        audit.signalAbortAt! >= value.start && audit.signalAbortAt! <= value.end && row.failedAt >= value.start && row.failedAt <= value.end &&
        row.generation >= value.startGeneration && row.generation <= value.endGeneration!);
      if (control) return result("controlled_stale_read_signal_abort", audit, control);
    }
    if (audit?.eofAt === undefined && (audit === undefined || audit.bytes === 0) && audit?.bodyCancelAt === undefined && (row.responseStatus === null || responseMatches)) {
      const control = controls.find(value => value.completed && value.end !== null && row.authorityHash !== null && value.authorityHashes.includes(row.authorityHash) &&
        row.failedAt >= value.start && row.failedAt <= value.end && value.navigations.some(nav => nav.fullDocument && nav.startedAt !== null &&
          row.generation < nav.generation && row.at <= nav.startedAt && row.failedAt >= nav.startedAt));
      const navigation = control?.navigations.find(nav => nav.fullDocument && nav.startedAt !== null && row.generation < nav.generation && row.at <= nav.startedAt && row.failedAt >= nav.startedAt);
      if (navigation) return result("old_document_read_cancelled_by_observed_navigation", audit, control, navigation);
    }
    return null;
  };
  return { posts, failures, pageErrors, consoleErrors, responses, currentAuthority, stable,
    knownRun(raw: unknown) { const view = AgentNativeV3ViewSchema.parse(raw); knownRunIds.add(view.id.toLowerCase()); return view; },
    knownPreparation(raw: unknown) { const receipt = AgentNativeV3ItemReceiptSchema.parse(raw);
      if (receipt.disposition !== "known" || !receipt.agentCommandId || !receipt.ownerCommandId) throw new Error("mcp_v2_original_command_receipt_missing");
      preparedCommands.add(receipt.agentCommandId.toLowerCase()); return receipt; },
    async control<T>(kind: string, action: () => Promise<T>): Promise<T> {
      const control: Control = { id: controls.length + 1, kind, start: Date.now(), end: null, startGeneration: generation, endGeneration: null,
        completed: false, before: identity(), after: null, authorityHashes: [...knownAuthorities.keys()], navigations: [] }; controls.push(control);
      try { const value = await action(); await stable(); await currentAuthority(); control.completed = true; return value; }
      finally { control.end = Date.now(); control.endGeneration = generation; control.after = identity(); }
    },
    diagnostic: () => ({ controls, navigations, knownAuthorities: [...knownAuthorities].map(([hash, facts]) => ({ hash, ...facts })),
      knownRunIds: [...knownRunIds], preparedCommands: [...preparedCommands], classifications, reads: [...requests.values()].filter(eligibleRead) }),
    check(audits: ReadAudit[]) {
      expect(pageErrors).toEqual([]); expect(consoleErrors).toEqual([]); expect(responses).toEqual([]);
      for (const [request, current] of requests) { current.timing = timing(request); const failure = failures.find(row => row.ordinal === current.ordinal);
        if (failure) { failure.timing = current.timing; failure.responseStatus = current.responseStatus; failure.responseAuthorityHash = current.responseAuthorityHash; } }
      expect(failures.filter(row => { const match = classify(row, audits); if (match) classifications.push(match); return !match; })).toEqual([]);
      expect(posts.filter(path => /\/api\/(agent-native(?:-v[23])?|agent-plans|agent-loops|ai-assists)\/runs$/.test(path))).toEqual([]);
    } };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown; const cleanup: unknown[] = [], seen = observe(page), audit = await installReadCompletionAudit(page), proof: Record<string, unknown> = {
    operation: "7c4e1b92", title: info.title, officialSdk: "2.3.1_stdio", protocol: "erp-agent-mcp-v2", actualNativeVersion: AGENT_NATIVE_V3_VERSION,
    actualPersonalPkce: true, externalModelTransport: "synthetic_http_only", businessExecution: "separate_original_ERP_confirmation", hostAdoption: "official_client_fixture_not_ordinary_host" };
  try { f = await fixture(info.title.includes("PKCE") ? "pkce" : "restore");
    await seen.control("initial_login_and_fill", () => loginErp(page, "operator", "/ai-tasks")); await f.seed(); await action(f, seen, proof); }
  catch (error) { failure = error; }
  finally {
    try { await f?.release(); } catch (error) { cleanup.push(error); } try { await f?.close(); } catch (error) { cleanup.push(error); }
    try { await seen.stable(); expect(audit.rejected()).toBe(0); seen.check(audit.snapshot()); } catch (error) { cleanup.push(error); }
    Object.assign(proof, { childClose: f?.childClose ?? null, cleanupFailureCount: cleanup.length, pageErrors: seen.pageErrors, consoleErrors: seen.consoleErrors,
      responses: seen.responses, failures: seen.failures, posts: seen.posts, networkAudit: seen.diagnostic(), readAudit: audit.snapshot(), rejectedReadAudits: audit.rejected() });
    const path = info.outputPath("agent-mcp-v2-proof.json"); await writeFile(path, JSON.stringify(proof)); await info.attach("agent-mcp-v2-proof", { path, contentType: "application/json" });
  }
  if (failure || cleanup.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanup], "MCP v2 personal browser acceptance failed");
}
async function readRun(f: Fixture, clientId: number, id: string) { const response = await f.call(clientId, names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "run", id });
  expect(response.isError).toBe(false); const value = AgentNativeV3ViewSchema.parse(response.packet.data); expect(value.id).toBe(id); await verifyAgentNativeV3Transport(value); return value; }
async function accessPanel(page: Page, info: TestInfo, copyTemplate: boolean) {
  const panel = page.getByRole("region", { name: "MCP 本机接入", exact: true }); await panel.locator("summary").click();
  const version = panel.getByRole("radio", { name: /^新 v2 · native-v3/ }); await version.click(); await expect(version).toBeChecked();
  await expect(panel.locator(".mcp-choice-content")).toHaveAttribute("data-version", "v2");
  await expect(panel.locator(".mcp-choice-content")).toHaveAttribute("aria-busy", "false");
  await expect(panel.getByRole("region", { name: "MCP 本机个人登录", exact: true })).toBeVisible();
  await expect(panel).toContainText("当前客户端连接状态未知"); const template = panel.getByLabel("所选无密钥宿主配置模板");
  await expect(template).toContainText("main-v2.ts"); await expect(template).not.toContainText("ACCESS_TOKEN");
  if (copyTemplate) {
    await page.evaluate(() => {
      const copies: string[] = []; (window as Window & { __mcpV2TemplateCopies?: string[] }).__mcpV2TemplateCopies = copies;
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => {
        if (!text.includes("main-v2.ts") || /ACCESS_TOKEN|refresh_token|bearer/i.test(text) || copies.length >= 2) throw new Error("mcp_v2_template_copy_invalid");
        copies.push(text);
      } } });
    });
    for (const format of ["codex", "json"]) {
      await panel.getByRole("combobox", { name: "宿主配置格式", exact: true }).selectOption(format);
      await expect(panel.locator(".mcp-choice-content")).toHaveAttribute("aria-busy", "false");
      await expect(template).toContainText(format === "codex" ? "[mcp_servers.yummyai_erp_v2]" : '"mcpServers"');
      const expected = await template.textContent(); expect(expected).not.toBeNull();
      await panel.getByRole("button", { name: "复制宿主模板", exact: true }).click();
      await expect(panel.getByRole("status")).toHaveText("已复制无密钥宿主模板 尚未写入或验证宿主配置");
      expect(await page.evaluate(() => (window as Window & { __mcpV2TemplateCopies?: string[] }).__mcpV2TemplateCopies?.at(-1))).toBe(expected);
      await expect(panel).toContainText("当前客户端连接状态未知");
    }
    expect(await page.evaluate(() => (window as Window & { __mcpV2TemplateCopies?: string[] }).__mcpV2TemplateCopies?.length)).toBe(2);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 }); const anchor = panel.getByRole("button", { name: "复制宿主模板", exact: true });
    await anchor.scrollIntoViewIfNeeded(); await expect(anchor).toBeVisible();
    await expect.poll(() => panel.evaluate(element => getComputedStyle(element).opacity === "1" && element.getAnimations({ subtree: true }).every(animation => animation.playState !== "running"))).toBe(true);
    expect(await anchor.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; })).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`mcp-v2-access-${width}.png`) });
  }
  return { viewportWidths: [1440, 390], noHorizontalOverflow: true, clipboard: copyTemplate ? "template_only_stub_two_real_button_copies" : "not_invoked" };
}

test("uses personal PKCE and protocol-only native v3 fulfillment discovery then separately confirms each original operation in ERP", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const connected = await f.login(page); expect(connected.tools.sort()).toEqual(Object.values(names).sort());
    proof.accessPanel = await accessPanel(page, info, true);
    const input = await f.input(connected.clientId, "fulfillment"), before = await f.business();
    expect(input.bindings).toHaveLength(3); const created = await f.call(connected.clientId, names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: JSON.stringify(input) });
    expect(created.isError).toBe(false); const id = seen.knownRun(created.packet.data).id; await f.execute(id); await f.wait(); const run = await readRun(f, connected.clientId, id);
    expect(run.status).toBe("completed"); expect(run.observations.map(row => row.request.bindingIndex)).toEqual([0, 1, 2]); expect(run.observations.every(row => row.indexComplete === true && row.collectionComplete === null)).toBe(true);
    expect(run.items).toHaveLength(2); expect(await f.business()).toEqual(before); const effects: Array<{ itemId: string; commandId: string; ownerCommandId: string }> = [];
    for (const item of run.items) {
      const prepare = await f.call(connected.clientId, names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id, itemId: item.id,
        requestJson: JSON.stringify({ version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) });
      expect(prepare.isError, JSON.stringify({ kind: prepare.packet.kind, code: prepare.packet.data.code, status: prepare.packet.data.status })).toBe(false);
      const original = seen.knownPreparation(prepare.packet.data); expect(original.disposition).toBe("known");
      // A human ERP confirmation remains a separate browser action.
      const dialog = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
      await seen.control("open_original_command", async () => { await page.goto("/ai-tasks?agentCommand=" + original.agentCommandId); await expect(dialog).toBeVisible(); });
      await dialog.getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
      const accepted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/agent-commands/requests/${original.agentCommandId}/confirm`)
        .then(async response => ({ status: response.status(), body: await response.json() as unknown }));
      await seen.control("confirm_original_command", async () => { await dialog.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click(); expect((await accepted).status).toBe(200); });
      const receipt = await f.call(connected.clientId, names.savedResult, { kind: "command", id: original.agentCommandId, originalChecksum: item.originalChecksum });
      expect(receipt.isError).toBe(false); expect(receipt.packet.data.state).toBe("succeeded");
      effects.push({ itemId: item.id, commandId: original.agentCommandId!, ownerCommandId: original.ownerCommandId! });
      await seen.control("close_original_command", async () => { await dialog.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(dialog).not.toBeVisible(); });
    }
    expect(seen.posts.filter(path => path.endsWith("/confirm"))).toHaveLength(2);
    Object.assign(proof, { runId: id, requestId: run.requestId, originalKinds: run.observations.map(row => row.results[0]?.tool), cost: run.cost, effects, progress: await f.progress(), actualPreparationOnlyUntilERPConfirmation: true });
  });
});

test("restores original parent and item receipts from a new MCP process after real refresh and hides current withdrawn native sources", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const connection = await f.login(page), input = await f.input(connection.clientId, "one"), created = await f.call(connection.clientId, names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "start", requestJson: JSON.stringify(input) });
    expect(created.isError).toBe(false); const id = seen.knownRun(created.packet.data).id; await f.execute(id); await f.wait(); const run = await readRun(f, connection.clientId, id), item = run.items[0]!;
    const prepared = await f.call(connection.clientId, names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id, itemId: item.id,
      requestJson: JSON.stringify({ version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) });
    expect(prepared.isError, JSON.stringify({ kind: prepared.packet.kind, code: prepared.packet.data.code, status: prepared.packet.data.status })).toBe(false);
    const known = seen.knownPreparation(prepared.packet.data); expect(known.disposition).toBe("known");
    const before = await f.state(run.requestId), business = await f.business(), models = (await f.progress()).modelCalls;
    const rotation = await f.refresh(); await seen.control("reload_original_page_after_refresh", async () => { await page.reload(); await expect(page.getByRole("region", { name: "MCP 本机接入", exact: true })).toBeVisible(); });
    proof.accessPanel = await accessPanel(page, info, false); const replacement = await f.connect();
    const parent = await f.call(replacement.clientId, names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "request_receipt_from_request", requestJson: JSON.stringify(input) });
    expect(AgentNativeV3ReceiptSchema.parse(parent.packet.data).runId).toBe(id);
    const child = await f.call(replacement.clientId, names.savedResult, { version: AGENT_NATIVE_V3_VERSION, kind: "item_receipt", id, itemId: item.id, requestId: run.requestId, proposalChecksum: item.proposalChecksum });
    expect(AgentNativeV3ItemReceiptSchema.parse(child.packet.data)).toMatchObject({ disposition: "known", agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId });
    expect(await f.state(run.requestId)).toEqual(before); expect(await f.business()).toEqual(business); expect((await f.progress()).modelCalls).toBe(models);
    // The page itself is not forced through a competing authority navigation.
    await f.inventorySelf(); const hidden = await readRun(f, replacement.clientId, id);
    expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, bindings: [], steps: [], definitions: [], observations: [], result: null, readContracts: null });
    expect(hidden.items[0]).toMatchObject({ id: item.id, agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId });
    const denied = await f.call(replacement.clientId, names.execute, { version: AGENT_NATIVE_V3_VERSION, operation: "prepare", id, itemId: item.id,
      requestJson: JSON.stringify({ version: AGENT_NATIVE_V3_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum }) });
    expect(denied.isError).toBe(true); expect(await f.state(run.requestId)).toEqual(before); expect(await f.business()).toEqual(business);
    expect(seen.posts.filter(path => path.endsWith("/confirm"))).toHaveLength(0);
    Object.assign(proof, { runId: id, requestId: run.requestId, itemId: item.id, agentCommandId: known.agentCommandId, ownerCommandId: known.ownerCommandId,
      originalReceiptsOnly: true, refresh: rotation, privateCleared: true, noRepeatedModelOrPrepare: true, progress: await f.progress() });
  });
});
