import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, expect, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_RESOURCES_VERSION, AgentResourceDefinitionRequestSchema, AgentResourceCandidatesQuerySchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentRuntimeReadinessSchema } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { AgentReadinessSchema } from "@yummyai/contracts/ai/agent-readiness";
import { AgentNativeV3ViewSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { requireAgentRuntimeReadinessEnvironment } from "../../../tools/testing/require-agent-runtime-readiness-environment.mjs";
import { openAgentRuntimeWorker } from "../../../tools/testing/agent-runtime-readiness-runtime.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentRuntimeReadinessEnvironment(process.env, true), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const familyNames = ["loop", "plan", "native_v1", "native_v2", "native_v3"] as const;
const reads = ["/api/erp-auth/session", "/api/agent-native-v3/workspace", "/api/agent-native-v2/workspace", "/api/agent-native/workspace", "/api/agent-tools/workspace",
  "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-commands/workspace", "/api/agent-read/workspace", "/api/agent-reads/workspace", "/api/agent-resources/workspace", "/api/agent-fulfillment/workspace",
  "/api/ai-assists/models", "/api/ai-assists/runs", "/api/ai-assists/task-workspace", ...familyNames.map(family => "/api/agent-readiness/" + family), ...familyNames.map(family => "/api/agent-runtime-readiness/" + family)];
const candidateInput = AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" });
const posts = [
  { kind: "resource_definition", path: "/api/agent-resources/definition", body: JSON.stringify(AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" })) },
  { kind: "tool_definition", path: "/api/agent-tools/definition", body: JSON.stringify(AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } })) },
  { kind: "research_candidates", path: "/api/agent-resources/candidates", body: JSON.stringify(candidateInput) },
] as const;
type ReadKind = "metadata_get" | typeof posts[number]["kind"];
const Audit = z.object({ document: z.uuid(), sequence: z.int().positive(), kind: z.enum(["metadata_get", "resource_definition", "tool_definition", "research_candidates"]), path: z.string().max(100),
  query: z.enum(["none", "assist_page1"]), method: z.enum(["GET", "POST"]), start: z.number().finite(), status: z.int().min(100).max(599).nullable(),
  eof: z.boolean(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(), json: z.boolean(), abortAt: z.number().finite().nullable(), abortSeenAtEof: z.boolean().nullable(),
  cancel: z.boolean(), bodyError: z.boolean(), fetchError: z.enum(["AbortError", "Other"]).nullable(), fetchErrorAt: z.number().finite().nullable() }).strict();
type ReadAudit = z.infer<typeof Audit> & { generation: number };
type Net = { request: Request; ordinal: number; generation: number; at: number; terminalAt: number | null; path: string; query: "none" | "assist_page1" | "other"; method: string;
  kind: ReadKind | null; bodyChecksum: string | null; erp: boolean; authority: string | null; echo: string | null; status: number | null; mime: "rsc" | "json" | "other" | null;
  navigation: boolean; resourceType: string; prefetch: boolean; rsc: boolean; failed: boolean; aborted: boolean; finished: boolean; targetHash: string | null; classification: string | null; auditPair: string | null };
const target = (url: URL) => { const entries = [...url.searchParams.entries()]; return new Set(entries.map(([key]) => key)).size === entries.length ? sha(JSON.stringify([url.pathname, entries.filter(([key]) => key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))])) : null; };

/** Family-local passive audit of the existing mount reads, not a new business
 * adapter. No clone/tee/extra read, changed signals or fake ERP response. */
async function observe(page: Page) {
  const localReads = [...reads];
  const rows: Net[] = [], audits = new Map<string, ReadAudit>(), documents = new Map<string, number>();
  const controls: Array<{ kind: string; start: number; end: number; generation: number }> = [], sessions: Array<{ generation: number; at: number; authority: string }> = [];
  const dom: Array<{ generation: number; at: number; authority: string; resource: string | null; tool: string | null; candidates: boolean; queryChecksum: string | null }> = [];
  const links: Array<{ generation: number; at: number; path: string; targetHash: string }> = [], errors: Array<{ kind: "page" | "console"; name: string; sha256: string }> = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3130").origin;
  const navigationPaths = ["/", "/navigation", "/orders", "/ai-tasks", "/business-tasks", "/settings/ai"];
  let generation = 0, authority = "";
  await page.exposeBinding("__runtimeReadinessAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return; const value = Audit.safeParse(raw); if (!value.success) return;
    if (value.data.kind === "metadata_get" ? !localReads.includes(value.data.path) || value.data.method !== "GET" : !posts.some(post => post.path === value.data.path && post.kind === value.data.kind) || value.data.method !== "POST") return;
    const key = value.data.document + ":" + value.data.sequence; if (!audits.has(key) && audits.size >= 250) return;
    if (!documents.has(value.data.document)) documents.set(value.data.document, generation);
    audits.set(key, { ...value.data, generation: documents.get(value.data.document)! });
  });
  await page.addInitScript(({ paths, exactPosts }) => {
    if (window !== window.top) return;
    const originalFetch = window.fetch, documentId = crypto.randomUUID(); let sequence = 0;
    (window as unknown as { __runtimeReadinessObservedPaths: string[] }).__runtimeReadinessObservedPaths = paths;
    type State = z.infer<typeof Audit>;
    const emit = (value: State) => { try { const binding = (window as unknown as { __runtimeReadinessAudit?: (value: State) => Promise<void> }).__runtimeReadinessAudit; if (binding) void binding({ ...value }).catch(() => {}); } catch { /* Observe only. */ } };
    window.fetch = function (...args) {
      let value: State | undefined, signal: AbortSignal | null | undefined;
      try {
        const input = args[0], options = args[1], url = new URL(input instanceof Request ? input.url : String(input), location.href), method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        const post = method === "POST" && !url.search && new Headers(options?.headers).get("content-type") === "application/json" ? exactPosts.find(post => post.path === url.pathname && post.body === options?.body) : undefined;
        const read = method === "GET" && paths.includes(url.pathname) && (!url.search || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1");
        if (url.origin === location.origin && (post || read)) {
          value = { document: documentId, sequence: ++sequence, kind: post?.kind ?? "metadata_get", path: url.pathname, query: url.search ? "assist_page1" : "none", method: post ? "POST" : "GET", start: Date.now(), status: null,
            eof: false, bytes: 0, reads: 0, json: false, abortAt: null, abortSeenAtEof: null, cancel: false, bodyError: false, fetchError: null, fetchErrorAt: null };
          signal = options?.signal ?? (input instanceof Request ? input.signal : null); const state = value;
          if (signal?.aborted) state.abortAt = state.start;
          signal?.addEventListener("abort", () => { state.abortAt ??= Date.now(); emit(state); }, { once: true }); emit(state);
        }
      } catch { /* Unknown input receives no exception. */ }
      const pending = Reflect.apply(originalFetch, this, args) as Promise<Response>;
      if (value) { const state = value;
        void pending.then(response => {
          state.status = response.status; emit(state);
          const complete = (json: boolean) => { if (!state.eof) { state.eof = true; state.abortSeenAtEof = state.abortAt !== null; } state.json ||= json; emit(state); };
          const originalJson = response.json; response.json = function (...args) { const result = Reflect.apply(originalJson, this, args) as Promise<unknown>; void result.then(() => complete(true), () => { state.bodyError = true; emit(state); }); return result; };
          if (response.body) { const originalReader = response.body.getReader;
            response.body.getReader = function (this: ReadableStream<Uint8Array>, ...args: Parameters<typeof originalReader>) {
              const reader = Reflect.apply(originalReader, this, args) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
              reader.read = function (...args) { const result = Reflect.apply(read, this, args) as Promise<ReadableStreamReadResult<Uint8Array>>;
                void result.then(part => { state.reads++; if (part.done) complete(false); else { state.bytes += part.value.byteLength; emit(state); } }, () => { state.bodyError = true; emit(state); }); return result; };
              reader.cancel = function (...args) { state.cancel = true; emit(state); return Reflect.apply(cancel, this, args); }; return reader;
            } as typeof originalReader;
          }
        }, error => { state.fetchError = error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Other"; state.fetchErrorAt = Date.now(); emit(state); });
      }
      return pending;
    };
  }, { paths: localReads, exactPosts: posts });
  page.on("request", request => {
    const url = new URL(request.url()), headers = request.headers(), navigation = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame(); if (navigation) generation++;
    const erp = url.origin === origin, post = erp && request.method() === "POST" && !url.search && headers["content-type"] === "application/json" ? posts.find(post => post.path === url.pathname && post.body === request.postData()) : undefined;
    const query = !url.search ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "other";
    rows.push({ request, ordinal: rows.length + 1, generation, at: Date.now(), terminalAt: null, path: url.pathname, query, method: request.method(), kind: post?.kind ?? (erp && request.method() === "GET" && localReads.includes(url.pathname) && query !== "other" ? "metadata_get" : null),
      bodyChecksum: post ? sha(post.body) : null, erp, authority: headers["x-yummyai-context-authority"] ? sha(headers["x-yummyai-context-authority"]) : null, echo: null, status: null, mime: null,
      navigation, resourceType: request.resourceType(), prefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", failed: false, aborted: false, finished: false, targetHash: target(url), classification: null, auditPair: null });
  });
  page.on("response", response => { const row = rows.find(row => row.request === response.request()); if (!row) return; const headers = response.headers(), type = headers["content-type"]?.toLowerCase() ?? "";
    row.status = response.status(); row.echo = headers["x-yummyai-context-authority"] ? sha(headers["x-yummyai-context-authority"]) : null; row.mime = type.startsWith("application/json") ? "json" : type.startsWith("text/x-component") ? "rsc" : "other"; });
  page.on("requestfinished", request => { const row = rows.find(row => row.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(row => row.request === request); if (row) { row.failed = true; row.aborted = request.failure()?.errorText === "net::ERR_ABORTED"; row.terminalAt = Date.now(); } });
  page.on("console", message => { if (message.type() === "error") errors.push({ kind: "console", name: "error", sha256: sha(message.text()) }); });
  page.on("pageerror", error => errors.push({ kind: "page", name: ["TypeError", "Error", "ReferenceError"].includes(error.name) ? error.name : "Other", sha256: sha(error.message) }));
  async function current() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); const session = ErpSessionViewSchema.parse(await response.json());
    expect(session.userId).toBe(actors().operator.userId); expect(session.tenantId).toBe(actors().operator.tenantId); authority = sha(erpSessionAuthority(session)); sessions.push({ generation, at: Date.now(), authority });
    for (const href of await page.getByRole("link").evaluateAll(nodes => nodes.map(node => (node as HTMLAnchorElement).href))) { const url = new URL(href), checksum = target(url);
      if (url.origin === origin && navigationPaths.includes(url.pathname) && checksum) links.push({ generation, at: Date.now(), path: url.pathname, targetHash: checksum }); }
    const resources = page.getByRole("region", { name: "业务资源读取", exact: true }), tools = page.getByRole("region", { name: "原生工具与命令目录", exact: true });
    async function checksum(region: ReturnType<Page["getByRole"]>, definition: string, key: string) {
      const selected = region.locator('button[aria-pressed="true"]').filter({ hasText: key }), code = region.getByRole("region", { name: definition, exact: true }).locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code");
      if (await selected.count() !== 1 || await code.count() !== 1) return null; const value = (await code.textContent())?.trim(); return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
    }
    const resource = await checksum(resources, "所选业务资源定义", "research.evidence"), tool = await checksum(tools, "所选严格工具定义", "knowledge.search");
    const picker = resources.getByRole("region", { name: "原业务对象候选", exact: true }), query = resources.getByRole("textbox", { name: "搜索原业务对象", exact: true }), choice = picker.getByRole("combobox", { name: "选择原业务对象", exact: true });
    const candidates = !!resource && await query.count() === 1 && await choice.count() === 1 && await query.inputValue() === "" && await choice.inputValue() === "" && await picker.getAttribute("aria-busy") === "false"
      && await picker.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/).count() === 1 && await picker.getByRole("alert").count() === 0;
    dom.push({ generation, at: Date.now(), authority, resource, tool, candidates, queryChecksum: candidates ? sha(canonicalJson(candidateInput)) : null });
    return session;
  }
  const zeroTiming = (row: Net) => { const value = row.request.timing(); return row.status === null && value.startTime === 0 && value.requestStart === -1 && value.responseStart === -1 && value.responseEnd === -1; };
  function pair(row: Net, unresolved = false) {
    const timing = row.request.timing(), fallback = unresolved && zeroTiming(row), at = fallback ? row.at : timing.startTime;
    if (!fallback && (!(at > 0) || timing.responseStart < 0)) return null;
    const values = [...audits.values()].filter(value => value.generation === row.generation && value.path === row.path && value.kind === row.kind && value.query === row.query && value.method === row.method && value.status === row.status && Math.abs(value.start - at) <= 25);
    if (values.length !== 1) return null; const selected = values[0]!;
    if (rows.filter(value => value.generation === row.generation && value.kind === row.kind && value.path === row.path && value.query === row.query && value.method === row.method && value.status === row.status
      && Math.abs((fallback && zeroTiming(value) ? value.at : value.request.timing().startTime) - selected.start) <= 25).length !== 1) return null; return selected;
  }
  const complete = (value: ReadAudit | null): value is ReadAudit => !!value?.eof && value.abortSeenAtEof === false && !value.cancel && !value.bodyError && !value.fetchError && (value.json || value.bytes > 0 && value.reads > 0);
  const auditKey = (value: ReadAudit) => value.document + ":" + value.sequence;
  async function stable() { await expect.poll(() => rows.filter(row => !row.finished && !row.failed).length, { timeout: 20_000 }).toBe(0); }
  async function control(kind: string, action: () => Promise<void>) { const item = { kind, start: Date.now(), end: 0, generation }; controls.push(item);
    try {
      await action();
      if (kind === "login") {
        const picker = page.getByRole("region", { name: "业务资源读取", exact: true }).getByRole("region", { name: "原业务对象候选", exact: true });
        await expect(picker).toHaveAttribute("aria-busy", "false");
        await expect(picker.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/)).toBeVisible();
      }
      await current(); await stable(); await current();
    } finally { item.end = Date.now(); item.generation = generation; }
  }
  function check() {
    const postAllowed = new Set<Request>();
    for (const row of rows) {
      const unique = [...new Set(sessions.filter(value => value.generation === row.generation).map(value => value.authority))], known = unique.length === 1 && unique[0] === authority;
      const document = rows.filter(value => value.erp && value.generation === row.generation && value.navigation && value.finished && value.status === 200 && value.terminalAt !== null && value.terminalAt <= row.at);
      const windows = controls.filter(value => value.generation === row.generation && value.start <= row.at && value.end >= (row.terminalAt ?? Infinity)), audit = pair(row);
      if (row.erp && row.method === "POST" && row.kind && row.kind !== "metadata_get" && row.status === 200 && row.mime === "json" && row.authority === authority && row.echo === authority && known && document.length === 1 && windows.length === 1 && complete(audit)) {
        const descriptor = posts.find(value => value.kind === row.kind), shown = dom.filter(value => value.generation === row.generation && value.authority === authority && value.at >= (row.terminalAt ?? Infinity));
        const checksums = shown.map(value => row.kind === "tool_definition" ? value.tool : value.resource).filter(value => value !== null);
        const sourceDefinitions = rows.filter(value => value.generation === row.generation && value.kind === "resource_definition" && value.at < row.at && postAllowed.has(value.request));
        const candidateKnown = row.kind !== "research_candidates" || sourceDefinitions.length === 1 && shown.some(value => value.candidates && value.queryChecksum === sha(canonicalJson(candidateInput)));
        const timing = row.request.timing();
        if (descriptor && row.bodyChecksum === sha(descriptor.body) && checksums.length > 0 && new Set(checksums).size === 1 && candidateKnown && timing.responseEnd >= timing.responseStart) { postAllowed.add(row.request); row.auditPair = auditKey(audit); }
      }
      if (!row.failed) continue;
      if (row.erp && row.aborted && row.status === 200 && row.kind && known && row.authority === authority && row.echo === authority && complete(audit) && (row.method === "GET" || postAllowed.has(row.request))) { row.classification = "completed_original_read_with_terminal_abort"; row.auditPair = auditKey(audit); continue; }
      const workspace: Record<string, string> = { "/api/agent-readiness/native_v3": "/api/agent-native-v3/workspace", "/api/agent-readiness/loop": "/api/agent-loops/workspace", "/api/agent-readiness/plan": "/api/agent-plans/workspace", "/api/agent-runtime-readiness/native_v3": "/api/agent-native-v3/workspace", "/api/agent-runtime-readiness/loop": "/api/agent-loops/workspace", "/api/agent-runtime-readiness/plan": "/api/agent-plans/workspace" };
      if (row.erp && row.method === "GET" && row.resourceType === "fetch" && row.aborted && row.query === "none" && workspace[row.path] && known && row.authority === authority && document.length === 1 && windows.length === 1 && windows[0]!.kind === "login" && zeroTiming(row)) {
        const old = pair(row, true), basis = rows.filter(value => value.erp && value.generation === row.generation && value.path === workspace[row.path] && value.query === "none" && value.method === "GET" && value.finished && value.status === 200 && value.authority === authority && value.echo === authority && value.at >= windows[0]!.start && value.at <= row.at && value.terminalAt !== null && value.terminalAt >= (row.terminalAt ?? Infinity) && value.terminalAt <= windows[0]!.end);
        const next = rows.filter(value => value !== row && value.erp && value.generation === row.generation && value.path === row.path && value.kind === row.kind && value.query === "none" && value.method === "GET" && value.finished && value.status === 200 && value.authority === authority && value.echo === authority
          && value.at >= (row.terminalAt ?? Infinity) && value.terminalAt !== null && value.terminalAt <= windows[0]!.end && complete(pair(value)));
        if (old && old.fetchError === "AbortError" && old.abortAt !== null && old.fetchErrorAt !== null && old.abortAt <= old.fetchErrorAt && old.bytes === 0 && old.reads === 0 && !old.eof && !old.json && !old.cancel && !old.bodyError && basis.length === 1 && next.length === 1 && basis[0]!.terminalAt! <= next[0]!.at) {
          row.classification = "initial_read_replaced_after_original_workspace"; row.auditPair = auditKey(old); continue;
        }
      }
      const timing = row.request.timing();
      if (row.erp && row.method === "GET" && row.resourceType === "fetch" && row.aborted && row.prefetch && row.rsc && row.mime === "rsc" && row.status === 200 && !row.authority && !row.echo && navigationPaths.includes(row.path) && row.targetHash && known && document.length === 1
        && timing.startTime > 0 && timing.responseStart >= 0 && timing.responseEnd >= timing.responseStart && windows.some(window => links.some(link => link.generation === row.generation && link.path === row.path && link.targetHash === row.targetHash && link.at >= window.start && link.at <= window.end))) row.classification = "literal_dom_rsc_prefetch_cancel";
    }
    const safe = (values: Net[]) => values.map(({ request, ...row }) => { void request; return row; });
    expect(safe(rows.filter(row => row.status !== null && row.status >= 400)), "Unknown HTTP failure").toEqual([]);
    expect(safe(rows.filter(row => (row.failed || !row.finished) && !row.classification)), "Unknown network termination").toEqual([]);
    expect(safe(rows.filter(row => row.erp && row.method === "POST" && !postAllowed.has(row.request))), "No business or paid POST is allowed").toEqual([]);
    expect(errors, "Unknown console/page errors remain failures").toEqual([]);
  }
  async function original(runId: string) {
    const path = "/api/agent-native-v3/runs/" + z.uuidv7().parse(runId); localReads.push(path);
    await page.evaluate(path => { (window as unknown as { __runtimeReadinessObservedPaths: string[] }).__runtimeReadinessObservedPaths.push(path); }, path);
  }
  return { control, current, stable, check, original, proof: () => ({ requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), audits: [...audits.values()], sessions, controls, links, dom, errors }) };
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const BrowserSeed = z.object({ modelId: z.uuidv7(), providerId: z.uuidv7(), runId: z.uuidv7(), requestId: z.uuid(), requestChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.iso.datetime(), authoritySha256: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal("original_model_configuration_and_analysis_model_owners"),
  paidCalls: z.literal(0), originalAdmissionReservations: z.literal(1) }).strict();
const BrowserCloseBase = z.object({ nonce: z.string().regex(/^[a-f0-9]{32}$/), pid: z.int().positive(), closed: z.literal(true), databaseClosed: z.literal(true),
  fixtureClosed: z.literal(true), modelConfigurationRetired: z.literal(true), actorAuthorityUnchanged: z.literal(true), originalHistory: z.literal("retained_immutable"),
  providerCalls: z.literal(0), modelSteps: z.literal(0) }).strict();
const BrowserClose = z.union([
  BrowserCloseBase.extend({ budgetRestored: z.literal(true), budgetCleanup: z.object({ mode: z.literal("restored_original_policy"), requiresIndependentDatabaseAbsence: z.literal(false) }).strict() }).strict(),
  BrowserCloseBase.extend({ budgetRestored: z.literal(false), budgetCleanup: z.object({ mode: z.literal("disposable_database_teardown"), requiresIndependentDatabaseAbsence: z.literal(true), databaseName: z.literal(isolated.name) }).strict() }).strict(),
]);
const BrowserCleanupDiagnostic = z.object({ phase: z.enum(["original_metadata", "original_stop", "original_stop_receipt", "model_retirement", "budget_restore", "actor_authority", "owner_retirement", "fixture_close", "database_close"]),
  code: z.union([z.enum(["runtime_browser_unexpected_model_step", "runtime_browser_original_stop_receipt_changed", "runtime_browser_owned_configuration_missing", "runtime_browser_owned_budget_changed",
    "runtime_browser_actor_changed_during_fixture", "runtime_browser_model_step_not_zero", "runtime_browser_owner_retirement_failed", "runtime_browser_fixture_close_failed",
    "runtime_readiness_fixture_cleanup_failed", "runtime_worker_cleanup_unproven", "agent_stop_invalid", "agent_request_conflict"]), z.string().regex(/^[0-9A-Z]{5}$/)]).nullable(),
  status: z.int().min(400).max(599).nullable() }).strict();
async function deadline<T>(promise: Promise<T>, label: string, timeout = 20_000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}

/** Private setup process reuses the actual API owners under the API tsconfig.
 * Its synthetic model is never called; the ERP page still uses normal OIDC/BFF. */
async function setupBrowserActor(session: z.infer<typeof ErpSessionViewSchema>) {
  const temp = resolve(isolated.lane, "qa", isolated.nonce, "browser-owner-" + crypto.randomUUID()); await mkdir(temp, { recursive: true });
  const environment: Record<string, string> = { TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json"), TEMP: temp, TMP: temp };
  for (const [key, value] of Object.entries(process.env)) if (value && (key.startsWith("E2E_") || ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "DATABASE_URL", "REDIS_URL", "S3_ENDPOINT", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_PRIVATE_BUCKET",
    "API_BASE_URL", "API_ACCESS_TOKEN", "ERP_FIXTURE_ACTORS", "WEB_AUTH_MODE", "MODEL_CREDENTIAL_ENCRYPTION_KEY"].includes(key))) environment[key] = value;
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(root, "apps/api/src/ai/agent-runtime-readiness.test-fixture.ts"), "--runtime-readiness-browser-fixture"],
  { cwd: root, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const stderr = createHash("sha256"); let stderrBytes = 0, stdoutBytes = 0, exited = false, closed = false, exitCode: number | null = null, privateEnvironmentLeaked = false;
  const cleanupDiagnostics: z.infer<typeof BrowserCleanupDiagnostic>[] = [];
  const protectedValues = [environment.API_ACCESS_TOKEN, environment.MODEL_CREDENTIAL_ENCRYPTION_KEY, environment.S3_SECRET_ACCESS_KEY].filter((value): value is string => !!value);
  let tail = "", resolveBoot!: () => void, rejectBoot!: (error: Error) => void;
  const boot = new Promise<void>((done, reject) => { resolveBoot = done; rejectBoot = reject; });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const done = new Promise<void>(resolveDone => child.once("close", code => { exited = true; exitCode = code; rejectBoot(new Error("runtime_browser_setup_exited_before_boot")); for (const value of pending.values()) value.reject(new Error("runtime_browser_setup_process_exited")); pending.clear(); resolveDone(); }));
  const inspectOutput = (chunk: Buffer) => { const text = tail + chunk.toString("utf8"); privateEnvironmentLeaked ||= protectedValues.some(value => text.includes(value)); tail = text.slice(-4096); };
  child.stderr?.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; stderr.update(chunk); inspectOutput(chunk); });
  child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes += chunk.byteLength; inspectOutput(chunk); });
  child.on("error", () => { rejectBoot(new Error("runtime_browser_setup_spawn_failed")); for (const value of pending.values()) value.reject(new Error("runtime_browser_setup_spawn_failed")); });
  child.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "runtime.readiness.fixture.boot"
      && "nonce" in message && message.nonce === isolated.nonce && "pid" in message && message.pid === child.pid) { resolveBoot(); return; }
    if (!message || typeof message !== "object" || !("type" in message) || message.type !== "runtime.readiness.fixture" || !("id" in message) || typeof message.id !== "string") return;
    const item = pending.get(message.id); if (!item) return; pending.delete(message.id);
    if ("ok" in message && message.ok === true && "value" in message) item.resolve(message.value);
    else {
      if ("cleanupDiagnostics" in message) {
        const diagnostics = z.array(BrowserCleanupDiagnostic).max(16).safeParse(message.cleanupDiagnostics);
        if (!diagnostics.success) { item.reject(new Error("runtime_browser_cleanup_diagnostics_invalid")); return; }
        cleanupDiagnostics.splice(0, cleanupDiagnostics.length, ...diagnostics.data);
      }
      item.reject(new Error("runtime_browser_setup_operation_failed"));
    }
  });
  function request(operation: "setup" | "expired" | "close", value?: unknown) {
    if (exited) return Promise.reject(new Error("runtime_browser_setup_already_exited")); const id = crypto.randomUUID();
    const promise = new Promise<unknown>((resolveValue, reject) => { pending.set(id, { resolve: resolveValue, reject }); child.send({ type: "runtime.readiness.fixture", id, operation, value }, error => { if (error) { pending.delete(id); reject(new Error("runtime_browser_setup_ipc_failed")); } }); });
    return deadline(promise, "runtime_browser_setup_deadline", operation === "expired" ? 45_000 : 25_000);
  }
  let seed: z.infer<typeof BrowserSeed>;
  try { await deadline(boot, "runtime_browser_setup_boot_deadline"); seed = BrowserSeed.parse(await request("setup", session)); expect(seed.authoritySha256).toBe(sha(erpSessionAuthority(session))); }
  catch (error) {
    // The child retires any partially created owner state after a failed reply.
    // Allow that real close before using the bounded last-resort process stop.
    let closeFailure: unknown;
    try { await deadline(done, "runtime_browser_setup_failed_close_deadline", 20_000); }
    catch (failure) { closeFailure = failure; child.kill("SIGKILL"); await deadline(done, "runtime_browser_setup_force_close_deadline"); }
    if (closeFailure) throw new AggregateError([error, closeFailure], "runtime_browser_setup_and_close_failed");
    throw error;
  }
  return { seed, cleanupDiagnostics: () => cleanupDiagnostics.map(value => ({ ...value })), async expired() { const value = await request("expired"); expect(value).toEqual({ expired: true, modelSteps: 0 }); },
    async close() {
      if (closed) throw new Error("runtime_browser_setup_closed_twice"); closed = true;
      const receipt = BrowserClose.parse(await request("close")); expect(receipt.nonce).toBe(isolated.nonce); expect(receipt.pid).toBe(child.pid);
      await deadline(done, "runtime_browser_setup_close_not_observed"); expect(exitCode).toBe(0); expect(privateEnvironmentLeaked).toBe(false); tail = "";
      return { ...receipt, exited, exitCode, stderrBytes, stdoutBytes, privateEnvironmentLeaked, stderrSha256: stderr.digest("hex") };
    }, async forceClose() { if (!exited) child.kill("SIGKILL"); await deadline(done, "runtime_browser_setup_force_close_deadline"); },
  };
}

const labels = { loop: "有界读取任务启动诊断", plan: "模型业务计划启动诊断", native_v1: "原生工具 v1启动诊断", native_v2: "原生工具 v2启动诊断", native_v3: "原生工具 v3启动诊断" } as const;
function runtimeRegion(page: Page, family: keyof typeof labels = "native_v3") { return page.getByRole("region", { name: labels[family], exact: true }).getByRole("region", { name: "执行服务当前观察", exact: true }); }
async function refreshSeededWorkspace(page: Page) {
  const workspace = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-native-v3/workspace" && response.request().method() === "GET");
  const diagnosis = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-readiness/native_v3" && response.request().method() === "GET");
  await page.getByRole("button", { name: "重新读取原生模型契约", exact: true }).click(); expect((await workspace).status()).toBe(200);
  const original = await diagnosis; expect(original.status()).toBe(200); expect(AgentReadinessSchema.parse(await original.json()).state).toBe("no_known_blocker");
  await expect(page.getByRole("region", { name: labels.native_v3, exact: true }).getByText("初步检查无已知阻断", { exact: true })).toBeVisible();
}
async function actualRuntime(page: Page, state: "observed_ready" | "unavailable", family: keyof typeof labels = "native_v3") {
  const path = "/api/agent-runtime-readiness/" + family;
  const response = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "GET");
  await runtimeRegion(page, family).getByRole("button", { name: "只读刷新执行服务", exact: true }).click();
  const result = await response; expect(result.status()).toBe(200); const value = AgentRuntimeReadinessSchema.parse(await result.json());
  expect(value.state).toBe(state); expect(result.headers()["x-yummyai-context-authority"]).toBe(value.contextAuthority);
  expect(value.effects).toEqual({ modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 }); return value;
}
async function settled(page: Page) {
  await expect.poll(() => page.getByRole("region", { name: labels.native_v3, exact: true }).evaluate(node => {
    const animations = node.getAnimations({ subtree: true }), transitions = document.getAnimations().filter(animation => /view-transition/i.test((animation.effect as KeyframeEffect | null)?.pseudoElement ?? ""));
    return getComputedStyle(node).opacity === "1" && node.querySelector('[aria-busy="true"]') === null
      && animations.every(animation => animation.playState !== "running" && !animation.pending)
      && transitions.every(animation => animation.playState !== "running" && !animation.pending);
  }), { timeout: 8_000 }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}
async function screenshot(page: Page, info: TestInfo, prefix: string) {
  await page.setViewportSize({ width: 1440, height: 960 }); await runtimeRegion(page).scrollIntoViewIfNeeded(); await settled(page); await page.screenshot({ path: info.outputPath(prefix + "-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await runtimeRegion(page).scrollIntoViewIfNeeded(); await settled(page); await page.screenshot({ path: info.outputPath(prefix + "-mobile.png") });
}
async function recoverOriginal(page: Page, seed: z.infer<typeof BrowserSeed>) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-native-v3/runs/" + seed.runId && response.request().method() === "GET");
  const region = page.getByRole("region", { name: "十二类工具原任务读取", exact: true });
  await region.getByRole("textbox", { name: "十二类工具任务 ID", exact: true }).fill(seed.runId);
  await region.getByRole("button", { name: "按原 ID 读取任务", exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200); const view = AgentNativeV3ViewSchema.parse(await actual.json());
  expect(view.id).toBe(seed.runId); expect(view.requestId).toBe(seed.requestId); expect(view.requestChecksum).toBe(seed.requestChecksum);
  await expect(page.getByRole("region", { name: "十二类工具任务实际依据", exact: true })).toBeVisible();
  return { id: view.id, requestId: view.requestId, requestChecksum: view.requestChecksum, status: view.status, privateAvailable: view.privateAvailable };
}
async function writeProof(info: TestInfo, value: unknown) { const path = info.outputPath("agent-runtime-readiness-proof.json"); await writeFile(path, JSON.stringify(value, null, 2)); await info.attach("agent-runtime-readiness-proof", { path, contentType: "application/json" }); }

test.describe("compiled personal Harness execution-service observation", () => {
  test("withholds new paid starts without a Worker while the exact old task remains readable at 1440 and 390", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = []; let primaryFailure = false, networkFailed = false, cleanupFailed = false;
    let setup: Awaited<ReturnType<typeof setupBrowserActor>> | undefined, closeReceipt: unknown, original: unknown;
    try {
      await page.setViewportSize({ width: 1440, height: 960 }); await seen.control("login", () => loginErp(page, "operator", "/ai-tasks"));
      setup = await setupBrowserActor(await seen.current()); await seen.original(setup.seed.runId); await seen.control("seeded_workspace", () => refreshSeededWorkspace(page));
      await seen.control("runtime_read", async () => { expect((await actualRuntime(page, "unavailable")).validForMs).toBe(0); });
      const form = page.getByRole("form", { name: "启动十二类原生工具模型任务", exact: true });
      await expect(form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true })).toBeDisabled();
      await expect(form.getByRole("textbox", { name: "本次任务目标", exact: true })).toBeDisabled();
      await expect(page.getByRole("region", { name: "十二类工具原任务读取", exact: true }).getByRole("button", { name: "按原 ID 读取任务", exact: true })).toBeEnabled();
      await setup.expired(); await seen.control("read_original", async () => { original = await recoverOriginal(page, setup!.seed); });
      await screenshot(page, info, "runtime-unavailable");
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    try { if (setup) closeReceipt = await setup.close(); } catch (error) { cleanupFailed = true; failures.push(error); try { await setup?.forceClose(); } catch (closeError) { failures.push(closeError); } }
    await writeProof(info, { nonce: isolated.nonce, scope: "actual_personal_gets_and_original_owner_setup_no_paid_post", primaryFailure, networkFailed, cleanupFailed,
      seed: setup?.seed, original, closeReceipt, cleanupDiagnostics: setup?.cleanupDiagnostics(), network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "Runtime unavailable UI or strict network failed");
  });

  test("opens the real new-start gate only while the standard Worker is observed and closes it after strong kill at 1440 and 390", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = []; let primaryFailure = false, networkFailed = false, cleanupFailed = false;
    let setup: Awaited<ReturnType<typeof setupBrowserActor>> | undefined, worker: Awaited<ReturnType<typeof openAgentRuntimeWorker>> | undefined;
    let closeReceipt: unknown, original: unknown, readyView: unknown;
    try {
      await page.setViewportSize({ width: 1440, height: 960 }); await seen.control("login", () => loginErp(page, "operator", "/ai-tasks"));
      setup = await setupBrowserActor(await seen.current()); await seen.original(setup.seed.runId); await seen.control("seeded_workspace", () => refreshSeededWorkspace(page));
      await setup.expired(); worker = await openAgentRuntimeWorker(); await worker.ready();
      await seen.control("runtime_ready", async () => {
        await expect(runtimeRegion(page).getByText("本次观察到执行服务就绪", { exact: true })).toBeVisible({ timeout: 20_000 });
        readyView = await actualRuntime(page, "observed_ready");
      });
      const form = page.getByRole("form", { name: "启动十二类原生工具模型任务", exact: true }), submit = form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true });
      await seen.control("fill_original_request_without_submission", async () => {
        await form.getByRole("textbox", { name: "本次任务目标", exact: true }).fill("Synthetic bounded original inventory read — no request is submitted");
        await form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).selectOption(setup!.seed.modelId);
        await form.getByRole("textbox", { name: "美元费用上限", exact: true }).fill("0.01");
        await form.getByRole("combobox", { name: "选择本次读取工具", exact: true }).selectOption("inventory.balances.page");
        await form.getByRole("button", { name: "确定原库存读取范围", exact: true }).click();
        await form.getByRole("button", { name: "加入本次固定读取范围", exact: true }).click(); await expect(submit).toBeEnabled();
      });
      await seen.control("strong_kill_original_worker", async () => { await worker!.stop("kill"); await expect(submit).toBeDisabled({ timeout: 20_000 }); });
      expect(worker.evidence.processExited).toBe(true); expect(worker.evidence.forced).toBe(true);
      await expect(runtimeRegion(page).getByText("本次观察到执行服务就绪", { exact: true })).toHaveCount(0);
      await expect(form.getByRole("textbox", { name: "本次任务目标", exact: true })).toHaveValue("Synthetic bounded original inventory read — no request is submitted");
      await seen.control("read_original_after_worker_stop", async () => { original = await recoverOriginal(page, setup!.seed); });
      await screenshot(page, info, "runtime-worker-stopped");
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await worker?.stop("kill"); } catch (error) { cleanupFailed = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    try { if (setup) closeReceipt = await setup.close(); } catch (error) { cleanupFailed = true; failures.push(error); try { await setup?.forceClose(); } catch (closeError) { failures.push(closeError); } }
    await writeProof(info, { nonce: isolated.nonce, scope: "actual_standard_worker_original_gets_no_paid_post", primaryFailure, networkFailed, cleanupFailed,
      seed: setup?.seed, readyView, original, worker: worker?.evidence, closeReceipt, cleanupDiagnostics: setup?.cleanupDiagnostics(), network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "Runtime live gate UI or strict network failed");
  });
});

