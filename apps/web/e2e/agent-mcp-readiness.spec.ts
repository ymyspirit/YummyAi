import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_RESOURCES_VERSION, AgentResourceDefinitionRequestSchema, AgentResourceCandidatesQuerySchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { requireAgentMcpReadinessEnvironment } from "../../../tools/testing/require-agent-mcp-readiness-environment.mjs";
import { AGENT_MCP_V2_READINESS_START_COMMAND, AGENT_MCP_V2_START_COMMAND } from "../src/features/ai-tasks/agent-mcp-template";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentMcpReadinessEnvironment(process.env, true), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const familyNames = ["loop", "plan", "native_v1", "native_v2", "native_v3"] as const;
const reads = ["/api/erp-auth/session", "/api/agent-native-v3/workspace", "/api/agent-native-v2/workspace", "/api/agent-native/workspace", "/api/agent-tools/workspace",
  "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-commands/workspace", "/api/agent-read/workspace", "/api/agent-reads/workspace", "/api/agent-resources/workspace", "/api/agent-fulfillment/workspace",
  "/api/ai-assists/models", "/api/ai-assists/runs", "/api/ai-assists/task-workspace", ...familyNames.map(family => "/api/agent-readiness/" + family)];
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
type Clipboard = { values: string[]; defer: boolean; entered: boolean; release: (() => void) | null };
const target = (url: URL) => { const entries = [...url.searchParams.entries()]; return new Set(entries.map(([key]) => key)).size === entries.length ? sha(JSON.stringify([url.pathname, entries.filter(([key]) => key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))])) : null; };

/** Family-local passive audit of the existing mount reads, not a new business
 * adapter. No clone/tee/extra read, changed signals or fake ERP response. */
async function observe(page: Page) {
  const rows: Net[] = [], audits = new Map<string, ReadAudit>(), documents = new Map<string, number>();
  const controls: Array<{ kind: string; start: number; end: number; generation: number }> = [], sessions: Array<{ generation: number; at: number; authority: string }> = [];
  const dom: Array<{ generation: number; at: number; authority: string; resource: string | null; tool: string | null; candidates: boolean; queryChecksum: string | null }> = [];
  const links: Array<{ generation: number; at: number; path: string; targetHash: string }> = [], errors: Array<{ kind: "page" | "console"; name: string; sha256: string }> = [];
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3130").origin;
  const navigationPaths = ["/", "/navigation", "/orders", "/ai-tasks", "/business-tasks", "/settings/ai"];
  let generation = 0, authority = "";
  await page.exposeBinding("__mcpReadinessAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return; const value = Audit.safeParse(raw); if (!value.success) return;
    if (value.data.kind === "metadata_get" ? !reads.includes(value.data.path) || value.data.method !== "GET" : !posts.some(post => post.path === value.data.path && post.kind === value.data.kind) || value.data.method !== "POST") return;
    const key = value.data.document + ":" + value.data.sequence; if (!audits.has(key) && audits.size >= 250) return;
    if (!documents.has(value.data.document)) documents.set(value.data.document, generation);
    audits.set(key, { ...value.data, generation: documents.get(value.data.document)! });
  });
  await page.addInitScript(({ paths, exactPosts }) => {
    if (window !== window.top) return;
    const originalFetch = window.fetch, documentId = crypto.randomUUID(); let sequence = 0;
    type State = z.infer<typeof Audit>;
    const emit = (value: State) => { try { const binding = (window as unknown as { __mcpReadinessAudit?: (value: State) => Promise<void> }).__mcpReadinessAudit; if (binding) void binding({ ...value }).catch(() => {}); } catch { /* Observe only. */ } };
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
    const clipboard: Clipboard = { values: [], defer: false, entered: false, release: null };
    (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard = clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (value: string) => { clipboard.values.push(value); clipboard.entered = true;
      if (!clipboard.defer) return Promise.resolve(); return new Promise<void>(accept => { clipboard.release = accept; }); } } });
  }, { paths: reads, exactPosts: posts });
  page.on("request", request => {
    const url = new URL(request.url()), headers = request.headers(), navigation = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame(); if (navigation) generation++;
    const erp = url.origin === origin, post = erp && request.method() === "POST" && !url.search && headers["content-type"] === "application/json" ? posts.find(post => post.path === url.pathname && post.body === request.postData()) : undefined;
    const query = !url.search ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "other";
    rows.push({ request, ordinal: rows.length + 1, generation, at: Date.now(), terminalAt: null, path: url.pathname, query, method: request.method(), kind: post?.kind ?? (erp && request.method() === "GET" && reads.includes(url.pathname) && query !== "other" ? "metadata_get" : null),
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
    try { await action(); await current(); await stable(); await current(); } finally { item.end = Date.now(); item.generation = generation; } }
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
      const workspace: Record<string, string> = { "/api/agent-readiness/native_v3": "/api/agent-native-v3/workspace", "/api/agent-readiness/loop": "/api/agent-loops/workspace", "/api/agent-readiness/plan": "/api/agent-plans/workspace" };
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
  return { control, current, stable, check, proof: () => ({ requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), audits: [...audits.values()], sessions, controls, links, dom, errors }) };
}

async function selectV2(page: Page) {
  const connection = page.getByRole("region", { name: "MCP 本机接入", exact: true });
  await connection.locator("summary").click(); const radio = connection.getByRole("radio", { name: /^新 v2 · native-v3/ }); await radio.click(); await expect(radio).toBeChecked();
  await expect(connection.getByRole("region", { name: "MCP 只读启动诊断", exact: true })).toBeVisible(); return connection;
}
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function settledMcp(page: Page) {
  let last: { width: number; rootOpacity: number; minTargetOpacity: number; detailsOpacity: number | null; activeLocal: number; activeViewTransitions: number; ready: boolean } | null = null;
  await expect.poll(async () => {
    last = await page.getByRole("region", { name: "MCP 本机接入", exact: true }).evaluate(element => {
      const active = (animation: Animation) => animation.pending || animation.playState === "running";
      const targets = [element, ...element.querySelectorAll(".mcp-content > *, .mcp-choice-content, .mcp-readiness, .mcp-readiness > *")].filter(node => node.getClientRects().length > 0);
      const rootOpacity = Number(getComputedStyle(element).opacity), minTargetOpacity = Math.min(...targets.map(node => Number(getComputedStyle(node).opacity)));
      const activeLocal = element.getAnimations({ subtree: true }).filter(active).length;
      const activeViewTransitions = document.getAnimations().filter(animation => {
        const effect = animation.effect, pseudo = effect && "pseudoElement" in effect ? effect.pseudoElement : null;
        return typeof pseudo === "string" && pseudo.startsWith("::view-transition") && active(animation);
      }).length;
      const details = element.querySelector("details"), detailsOpacity = details && CSS.supports("selector(details::details-content)") ? Number(getComputedStyle(details, "::details-content").opacity) : null;
      return { width: innerWidth, rootOpacity, minTargetOpacity, detailsOpacity, activeLocal, activeViewTransitions,
        ready: details?.open === true && rootOpacity === 1 && minTargetOpacity === 1 && (detailsOpacity === null || detailsOpacity === 1) && activeLocal === 0 && activeViewTransitions === 0 };
    });
    return last.ready;
  }, { timeout: 5_000, message: "MCP DOM opacity and local/ViewTransition animations must actually settle before screenshot" }).toBe(true);
  return last;
}
async function proof(info: TestInfo, value: unknown) { const path = info.outputPath("agent-mcp-readiness-proof.json"); await writeFile(path, JSON.stringify(value, null, 2)); await info.attach("agent-mcp-readiness-proof", { path, contentType: "application/json" }); }

test.describe("compiled personal MCP read-only startup guidance", () => {
  test("copies the five explicit readiness opt-ins without starting a client or business task at 1440 and 390", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = [], visuals: Array<Awaited<ReturnType<typeof settledMcp>>> = []; let primaryFailure = false, networkFailed = false;
    try {
      await page.setViewportSize({ width: 1440, height: 960 }); await seen.control("login", () => loginErp(page, "operator", "/ai-tasks"));
      await seen.control("mcp_readiness_copy", async () => {
        const connection = await selectV2(page), section = connection.getByRole("region", { name: "MCP 只读启动诊断", exact: true });
        await expect(section.locator('code[aria-label="MCP v2 只读诊断启动命令"]')).toHaveText(AGENT_MCP_V2_READINESS_START_COMMAND);
        expect(AGENT_MCP_V2_READINESS_START_COMMAND.startsWith(AGENT_MCP_V2_START_COMMAND + " ")).toBe(true);
        expect(AGENT_MCP_V2_READINESS_START_COMMAND.match(/--allow-readiness=[a-z0-9_]+/g)).toEqual(familyNames.map(family => "--allow-readiness=" + family));
        expect(/--allow-model-run|--allow-prepare|ACCESS_TOKEN=/.test(AGENT_MCP_V2_READINESS_START_COMMAND)).toBe(false);
        await section.getByRole("button", { name: "复制只读诊断启动命令", exact: true }).click();
        await expect(connection.getByRole("status")).toHaveText("已复制只读诊断启动命令 当前客户端连接与任务执行服务仍未验证");
        expect(await page.evaluate(() => (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard.values)).toEqual([AGENT_MCP_V2_READINESS_START_COMMAND]);
        await expect(connection.getByText("当前客户端连接状态未知", { exact: true })).toBeVisible();
        await section.scrollIntoViewIfNeeded(); await noOverflow(page); visuals.push(await settledMcp(page)); await page.screenshot({ path: info.outputPath("mcp-readiness-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 }); await section.scrollIntoViewIfNeeded(); await noOverflow(page); visuals.push(await settledMcp(page)); await page.screenshot({ path: info.outputPath("mcp-readiness-mobile.png") });
      });
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    await proof(info, { nonce: isolated.nonce, scope: "real_personal_page_public_clipboard_stub_public_command_copy_only_no_host_write", primaryFailure, networkFailed, visuals, network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "mcp_readiness_browser_failed");
  });

  test("hides v2 diagnostics in v1 and clears delayed copy feedback on version change and panel close at 1440 and 390", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = [], visuals: Array<Awaited<ReturnType<typeof settledMcp>>> = []; let primaryFailure = false, networkFailed = false;
    try {
      await page.setViewportSize({ width: 1440, height: 960 }); await seen.control("login", () => loginErp(page, "operator", "/ai-tasks"));
      await seen.control("mcp_readiness_late_copy", async () => {
        const connection = await selectV2(page), section = connection.getByRole("region", { name: "MCP 只读启动诊断", exact: true });
        async function deferCopy() { await page.evaluate(() => { const value = (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard; value.defer = true; value.entered = false; value.release = null; });
          await section.getByRole("button", { name: "复制只读诊断启动命令", exact: true }).click();
          await expect.poll(() => page.evaluate(() => (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard.entered)).toBe(true); }
        async function release() { await page.evaluate(() => { const value = (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard; value.release?.(); value.release = null; value.defer = false; }); }
        await deferCopy(); const v1 = connection.getByRole("radio", { name: /^原 v1 · 历史 native-v1/ }); await v1.click(); await expect(v1).toBeChecked(); await expect(section).toHaveCount(0); await release();
        await expect(connection.getByRole("status")).toHaveText("");
        const v2 = connection.getByRole("radio", { name: /^新 v2 · native-v3/ }); await v2.click(); await expect(v2).toBeChecked(); await expect(section).toBeVisible();
        await expect(section.getByRole("button", { name: "复制只读诊断启动命令", exact: true })).toBeEnabled();
        await deferCopy(); await connection.locator("summary").click(); await expect(connection.locator("details")).not.toHaveAttribute("open", ""); await release();
        await connection.locator("summary").click(); await expect(section).toBeVisible(); await expect(connection.getByRole("status")).toHaveText("");
        expect(await page.evaluate(() => (window as unknown as { __mcpReadinessClipboard: Clipboard }).__mcpReadinessClipboard.values)).toEqual([AGENT_MCP_V2_READINESS_START_COMMAND, AGENT_MCP_V2_READINESS_START_COMMAND]);
        await expect(connection.getByText("当前客户端连接状态未知", { exact: true })).toBeVisible();
        await section.scrollIntoViewIfNeeded(); await noOverflow(page); visuals.push(await settledMcp(page)); await page.screenshot({ path: info.outputPath("mcp-readiness-cleared-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 }); await section.scrollIntoViewIfNeeded(); await noOverflow(page); visuals.push(await settledMcp(page)); await page.screenshot({ path: info.outputPath("mcp-readiness-cleared-mobile.png") });
      });
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    await proof(info, { nonce: isolated.nonce, scope: "public_clipboard_stub_actual_version_and_close_no_client_connection_claim", primaryFailure, networkFailed, visuals, network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "mcp_readiness_clear_browser_failed");
  });
});
