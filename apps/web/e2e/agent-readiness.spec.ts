import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { test, expect, type Page, type Request, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { AgentReadinessSchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { AGENT_RESOURCES_VERSION, AgentResourceCandidatesQuerySchema, AgentResourceDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema } from "@yummyai/contracts/ai/agent-tools";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { requireAgentReadinessEnvironment } from "../../../tools/testing/require-agent-readiness-environment.mjs";
import { studioRuntimeUrl } from "../src/features/creative-studio/studio-configuration";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentReadinessEnvironment(process.env, true);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const families = { loop: "有界读取任务启动诊断", plan: "模型业务计划启动诊断", native_v1: "原生工具 v1启动诊断", native_v2: "原生工具 v2启动诊断", native_v3: "原生工具 v3启动诊断" } as const;
const metadataPaths = ["/api/erp-auth/session", "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/agent-native-v3/workspace",
  "/api/agent-tools/workspace", "/api/agent-read/workspace", "/api/agent-resources/workspace", "/api/agent-commands/workspace", "/api/agent-fulfillment/workspace", "/api/ai-assists/models", "/api/ai-assists/runs", "/api/ai-assists/task-workspace",
  ...Object.keys(families).map(family => "/api/agent-readiness/" + family)];
const AuditSchema = z.object({ document: z.uuid(), sequence: z.int().positive(), path: z.string().max(100), queryHash: z.string().regex(/^[a-f0-9]{64}$/), method: z.enum(["GET", "POST"]),
  start: z.number().finite(), status: z.int().min(100).max(599).nullable(), eof: z.boolean(), json: z.boolean(), bytes: z.int().nonnegative(), reads: z.int().nonnegative(),
  abortSeenAtEof: z.boolean().nullable(), aborted: z.boolean(), abortAt: z.number().finite().nullable(), cancelled: z.boolean(), bodyError: z.boolean(),
  fetchError: z.enum(["AbortError", "Other"]).nullable(), fetchErrorAt: z.number().finite().nullable() }).strict();
type Audit = z.infer<typeof AuditSchema> & { generation: number };
type DiscoveryPost = "tool_definition" | "resource_candidates";
type Row = { request: Request; ordinal: number; generation: number; at: number; terminalAt: number | null; path: string; method: string; urlHash: string; queryHash: string; navigationQueryHash: string | null;
  status: number | null; finished: boolean; failed: boolean; aborted: boolean; navigation: boolean; resourceType: string; prefetch: boolean; rsc: boolean; mime: "rsc" | "json" | "other" | null; authority: string | null; echo: string | null;
  personal: string | null; metadata: boolean; definition: boolean; discovery: DiscoveryPost | null; bodyChecksum: string | null; erp: boolean; classification: string | null; auditPair: { document: string; sequence: number } | null };
const canonical = (url: URL, transport = false) => {
  const entries = [...url.searchParams.entries()]; if (entries.length !== new Set(entries.map(([key]) => key)).size) return null;
  return JSON.stringify([url.pathname, entries.filter(([key]) => !transport || key !== "_rsc").sort(([a], [b]) => a.localeCompare(b))]);
};
const readPath = (url: URL) => metadataPaths.includes(url.pathname) && (!url.search || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1");
const definitionBody = JSON.stringify(AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }));
const toolDefinitionBody = JSON.stringify(AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } }));
const resourceCandidatesInput = AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" });
const discoveryPosts = [
  { kind: "tool_definition", path: "/api/agent-tools/definition", body: toolDefinitionBody },
  { kind: "resource_candidates", path: "/api/agent-resources/candidates", body: JSON.stringify(resourceCandidatesInput) },
] as const;
const prefetchTargets = ["/", "/navigation", "/orders", "/ai-tasks", "/business-tasks", "/settings/ai", "/creative-designs/studio/image"];

/** Observe only reads already made by the application. Original promises,
 * Response objects, reader order and signals are preserved; no clone/tee/read. */
async function observe(page: Page) {
  const rows: Row[] = [], audits = new Map<string, Audit>(), documents = new Map<string, number>(), controls: Array<{ kind: string; start: number; end: number; generationBefore: number; generationAfter: number }> = [];
  const sessions: Array<{ generation: number; at: number; authority: string }> = [], links: Array<{ generation: number; at: number; path: string; queryHash: string }> = [];
  const definitions: Array<{ generation: number; at: number; authority: string; version: typeof AGENT_RESOURCES_VERSION; tool: "research.evidence"; checksum: string }> = [];
  const toolDefinitions: Array<{ generation: number; at: number; authority: string; version: typeof AGENT_TOOLS_VERSION; kind: "read"; tool: "knowledge.search"; checksum: string }> = [];
  const candidateSelections: Array<{ generation: number; at: number; authority: string; tool: "research.evidence"; queryChecksum: string; queryValueHash: string; selectedValueHash: string; definitionChecksum: string; acceptedPage: true }> = [];
  const discoveryReads: Array<{ ordinal: number; kind: DiscoveryPost; document: number; audit: { document: string; sequence: number }; domAt: number; definitionChecksum: string; domQueryChecksum: string | null; sourceDefinition: number | null; controlStart: number }> = [];
  const cancellations: Array<{ ordinal: number; document: number; workspace: number; replacement: number; audit: { document: string; sequence: number }; replacementAudit: { document: string; sequence: number }; controlStart: number }> = [];
  const errors: Array<{ kind: "console" | "page"; at: number; urlHash: string | null; consumed: boolean; name?: string; messageHash?: string; category?: string; frame?: string | null }> = [], iframe = new Set<Request>();
  const erpOrigin = new URL(test.info().project.use.baseURL ?? "http://localhost:3130").origin;
  let generation = 0, personal: string | null = null;
  await page.exposeBinding("__readinessAudit", ({ frame }, raw: unknown) => {
    if (frame !== page.mainFrame()) return;
    const parsed = AuditSchema.safeParse(raw); if (!parsed.success) return;
    const value = parsed.data;
    if (!metadataPaths.includes(value.path) && !(value.method === "POST" && ["/api/creative-studio/configuration", "/api/agent-resources/definition", ...discoveryPosts.map(item => item.path)].includes(value.path))) return;
    const key = value.document + ":" + value.sequence; if (!audits.has(key) && audits.size >= 250) return;
    if (!documents.has(value.document)) documents.set(value.document, generation);
    audits.set(key, { ...value, generation: documents.get(value.document)! });
  });
  await page.addInitScript(({ paths, definitionInput, discoveryInputs }) => {
    if (window !== window.top) return;
    const fetchOriginal = window.fetch, documentId = crypto.randomUUID(); let sequence = 0;
    const sha = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
    type State = Omit<Audit, "generation">;
    const emit = (value: State) => { try { const send = (window as unknown as { __readinessAudit?: (value: State) => Promise<void> }).__readinessAudit; if (send) void send({ ...value }).catch(() => {}); } catch { /* Observation only. */ } };
    window.fetch = function (...args) {
      let selected: State | undefined, signal: AbortSignal | null | undefined, queryText = "";
      try {
        const raw = args[0], options = args[1], url = new URL(raw instanceof Request ? raw.url : String(raw), location.href);
        const method = (options?.method ?? (raw instanceof Request ? raw.method : "GET")).toUpperCase();
        const exactConfiguration = method === "POST" && url.pathname === "/api/creative-studio/configuration" && !url.search && new Headers(options?.headers).get("content-type") === "application/json" && typeof options?.body === "string" && options.body === JSON.stringify({ operation: "configuration.get" });
        const exactDefinition = method === "POST" && url.pathname === "/api/agent-resources/definition" && !url.search && new Headers(options?.headers).get("content-type") === "application/json" && options?.body === definitionInput;
        const exactDiscovery = method === "POST" && !url.search && new Headers(options?.headers).get("content-type") === "application/json" && discoveryInputs.some(value => value.path === url.pathname && value.body === options?.body);
        const exactRead = method === "GET" && paths.includes(url.pathname) && (!url.search || url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1");
        if (url.origin === location.origin && (exactConfiguration || exactDefinition || exactDiscovery || exactRead)) {
          queryText = JSON.stringify([url.pathname, [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))]);
          selected = { document: documentId, sequence: ++sequence, path: url.pathname, queryHash: "0".repeat(64), method: exactConfiguration || exactDefinition || exactDiscovery ? "POST" : "GET", start: Date.now(), status: null,
            eof: false, json: false, bytes: 0, reads: 0, abortSeenAtEof: null, aborted: false, abortAt: null, cancelled: false, bodyError: false, fetchError: null, fetchErrorAt: null };
          signal = options?.signal ?? (raw instanceof Request ? raw.signal : null); selected.aborted = signal?.aborted ?? false;
          const value = selected; if (value.aborted) value.abortAt = value.start;
          signal?.addEventListener("abort", () => { value.aborted = true; value.abortAt ??= Date.now(); emit(value); }, { once: true });
          void sha(queryText).then(valueHash => { value.queryHash = valueHash; emit(value); });
        }
      } catch { /* Unknown requests gain no exception. */ }
      const pending = Reflect.apply(fetchOriginal, this, args) as Promise<Response>;
      if (selected) {
        const value = selected;
        void pending.then(response => {
          value.status = response.status; emit(value);
          const completed = (json: boolean) => { if (!value.eof) { value.eof = true; value.abortSeenAtEof = value.aborted; } value.json ||= json; emit(value); };
          const json = response.json; response.json = function (...input) {
            const original = Reflect.apply(json, this, input) as Promise<unknown>;
            void original.then(() => completed(true), () => { value.bodyError = true; emit(value); }); return original;
          };
          if (response.body) {
            const getReader = response.body.getReader;
            response.body.getReader = function (this: ReadableStream<Uint8Array>, ...input: Parameters<typeof getReader>) {
              const reader = Reflect.apply(getReader, this, input) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
              reader.read = function (...input) {
                const original = Reflect.apply(read, this, input) as Promise<ReadableStreamReadResult<Uint8Array>>;
                void original.then(part => { value.reads++; if (part.done) completed(false); else { value.bytes += part.value.byteLength; emit(value); } }, () => { value.bodyError = true; emit(value); }); return original;
              };
              reader.cancel = function (...input) { value.cancelled = true; emit(value); return Reflect.apply(cancel, this, input); }; return reader;
            } as typeof getReader;
          }
        }, error => { value.fetchError = error instanceof DOMException && error.name === "AbortError" ? "AbortError" : "Other"; value.fetchErrorAt = Date.now(); emit(value); });
      }
      return pending;
    };
  }, { paths: metadataPaths, definitionInput: definitionBody, discoveryInputs: discoveryPosts });
  page.on("request", request => {
    const url = new URL(request.url()), header = request.headers(), navigates = request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame();
    if (navigates) generation++;
    const exactConfiguration = request.method() === "POST" && url.pathname === "/api/creative-studio/configuration" && !url.search && header["content-type"] === "application/json" && request.postData() === JSON.stringify({ operation: "configuration.get" });
    const exactDefinition = request.method() === "POST" && url.pathname === "/api/agent-resources/definition" && !url.search && header["content-type"] === "application/json" && request.postData() === definitionBody;
    const discovery = request.method() === "POST" && !url.search && header["content-type"] === "application/json" ? discoveryPosts.find(value => value.path === url.pathname && value.body === request.postData()) : undefined;
    const navigationQuery = canonical(url, true);
    rows.push({ request, ordinal: rows.length + 1, generation, at: Date.now(), terminalAt: null, path: url.pathname, method: request.method(), urlHash: hash(url.href), queryHash: hash(canonical(url) ?? "unsupported"), navigationQueryHash: navigationQuery === null ? null : hash(navigationQuery),
      status: null, finished: false, failed: false, aborted: false, navigation: navigates, resourceType: request.resourceType(), prefetch: header["next-router-prefetch"] === "1", rsc: header.rsc === "1", mime: null,
      authority: header["x-yummyai-context-authority"] ? hash(header["x-yummyai-context-authority"]) : null,
      echo: null, personal, metadata: request.method() === "GET" && readPath(url) || exactConfiguration || exactDefinition || discovery !== undefined, definition: exactDefinition, discovery: discovery?.kind ?? null,
      bodyChecksum: exactDefinition ? hash(definitionBody) : exactConfiguration ? hash(JSON.stringify({ operation: "configuration.get" })) : discovery ? hash(discovery.body) : null,
      erp: url.origin === erpOrigin, classification: null, auditPair: null });
  });
  page.on("response", response => { const row = rows.find(row => row.request === response.request()); if (row) { row.status = response.status(); const header = response.headers(), value = header["x-yummyai-context-authority"]; row.echo = value ? hash(value) : null;
    const type = header["content-type"]?.toLowerCase() ?? ""; row.mime = type.startsWith("text/x-component") ? "rsc" : type.startsWith("application/json") ? "json" : "other"; } });
  page.on("requestfinished", request => { const row = rows.find(row => row.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); } });
  page.on("requestfailed", request => { const row = rows.find(row => row.request === request); if (row) { row.failed = true; row.aborted = request.failure()?.errorText === "net::ERR_ABORTED"; row.terminalAt = Date.now(); } });
  page.on("console", message => { if (message.type() === "error") { let urlHash: string | null = null; try { urlHash = hash(new URL(message.location().url).href); } catch { /* No URL. */ } errors.push({ kind: "console", at: Date.now(), urlHash, consumed: false }); } });
  page.on("pageerror", error => {
    const names = ["TypeError", "ReferenceError", "RangeError", "SyntaxError", "DOMException", "Error"], react = /Minified React error #(\d{1,4})/.exec(error.message);
    const frame = /(\/_next\/static\/[A-Za-z0-9_./-]+\.js):(\d+):(\d+)/.exec(error.stack ?? "");
    errors.push({ kind: "page", at: Date.now(), urlHash: null, consumed: false, name: names.includes(error.name) ? error.name : "Other", messageHash: hash(error.message),
      category: /^crypto\.randomUUID is not a function$/.test(error.message) ? "crypto_random_uuid_unavailable" : react ? "react_" + react[1] : error.name === "TypeError" ? "type_error" : "other",
      frame: frame ? `${frame[1]}:${frame[2]}:${frame[3]}` : null });
  });
  async function current() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json()), actor = actors().operator;
    expect(session.userId).toBe(actor.userId); expect(session.tenantId).toBe(actor.tenantId);
    personal = hash(erpSessionAuthority(session)); sessions.push({ generation, at: Date.now(), authority: personal });
    const targets = await page.getByRole("link").evaluateAll(elements => elements.map(element => (element as HTMLAnchorElement).href));
    for (const target of targets) {
      const url = new URL(target); const value = canonical(url);
      if (url.origin === new URL(page.url()).origin && value && prefetchTargets.includes(url.pathname))
        links.push({ generation, at: Date.now(), path: url.pathname, queryHash: hash(value) });
    }
    const resources = page.getByRole("region", { name: "业务资源读取", exact: true });
    const selected = resources.locator('button[aria-pressed="true"]').filter({ hasText: "research.evidence" });
    const definition = resources.getByRole("region", { name: "所选业务资源定义", exact: true });
    const checksum = definition.locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code");
    let resourceChecksum: string | null = null;
    if (await selected.count() === 1 && await checksum.count() === 1) {
      const value = (await checksum.textContent())?.trim();
      if (value && /^[a-f0-9]{64}$/.test(value)) { resourceChecksum = value; definitions.push({ generation, at: Date.now(), authority: personal, version: AGENT_RESOURCES_VERSION, tool: "research.evidence", checksum: value }); }
    }
    const inputs = resources.getByRole("region", { name: "所选资源严格输入", exact: true }), query = inputs.getByRole("textbox", { name: "搜索原业务对象", exact: true });
    const candidates = inputs.getByRole("region", { name: "原业务对象候选", exact: true }), choice = candidates.getByRole("combobox", { name: "选择原业务对象", exact: true });
    const acceptedPage = candidates.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/);
    if (resourceChecksum && await query.count() === 1 && await choice.count() === 1 && await acceptedPage.count() === 1 && await candidates.getAttribute("aria-busy") === "false" && await candidates.getByRole("alert").count() === 0) {
      const queryValue = await query.inputValue(), selectedValue = await choice.inputValue();
      const parsed = AgentResourceCandidatesQuerySchema.safeParse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: queryValue });
      if (parsed.success && parsed.data.tool === "research.evidence" && queryValue === "" && selectedValue === "") candidateSelections.push({ generation, at: Date.now(), authority: personal, tool: parsed.data.tool,
        queryChecksum: hash(canonicalJson(parsed.data)), queryValueHash: hash(queryValue), selectedValueHash: hash(selectedValue), definitionChecksum: resourceChecksum, acceptedPage: true });
    }
    const tools = page.getByRole("region", { name: "原生工具与命令目录", exact: true });
    const selectedTool = tools.locator('button[aria-pressed="true"]').filter({ hasText: "knowledge.search" }), toolDefinition = tools.getByRole("region", { name: "所选严格工具定义", exact: true });
    const toolChecksum = toolDefinition.locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code");
    if (await selectedTool.count() === 1 && await toolChecksum.count() === 1 && await toolDefinition.getByText("原生只读", { exact: true }).count() === 1) {
      const value = (await toolChecksum.textContent())?.trim();
      if (value && /^[a-f0-9]{64}$/.test(value)) toolDefinitions.push({ generation, at: Date.now(), authority: personal, version: AGENT_TOOLS_VERSION, kind: "read", tool: "knowledge.search", checksum: value });
    }
    return session;
  }
  const noCdpResponseTiming = (row: Row) => { const timing = row.request.timing(); return row.status === null && timing.startTime === 0 && timing.requestStart === -1 && timing.responseStart === -1 && timing.responseEnd === -1; };
  const pair = (row: Row, initialUnresolved = false) => {
    const timing = row.request.timing(), fallback = initialUnresolved && row.erp && row.method === "GET" && /^\/api\/agent-readiness\/(?:loop|plan|native_v3)$/.test(row.path) && noCdpResponseTiming(row);
    if (!fallback && (!(timing.startTime > 0) || !(timing.responseStart >= 0))) return null;
    const start = fallback ? row.at : timing.startTime;
    const candidates = [...audits.values()].filter(audit => audit.generation === row.generation && audit.path === row.path && audit.queryHash === row.queryHash && audit.method === row.method && audit.status === row.status && Math.abs(audit.start - start) <= 25);
    if (candidates.length !== 1) return null; const selected = candidates[0]!;
    if (rows.filter(other => { const time = other.request.timing(), otherStart = fallback && noCdpResponseTiming(other) ? other.at : time.startTime;
      return other.generation === row.generation && other.path === row.path && other.queryHash === row.queryHash && other.method === row.method && other.status === selected.status && otherStart > 0 && Math.abs(selected.start - otherStart) <= 25; }).length !== 1) return null;
    return selected;
  };
  async function stable() { await expect.poll(() => rows.filter(row => !row.finished && !row.failed && !iframe.has(row.request)).length, { timeout: 20_000 }).toBe(0); }
  async function control<T>(kind: string, action: () => Promise<T>) {
    const window = { kind, start: Date.now(), end: 0, generationBefore: generation, generationAfter: generation }; controls.push(window);
    try { const value = await action(); await current(); await stable(); await current(); return value; } finally { window.end = Date.now(); window.generationAfter = generation; }
  }
  function complete(value: Audit | null): value is Audit {
    return !!value?.eof && value.abortSeenAtEof === false && !value.cancelled && !value.bodyError && !value.fetchError && (value.json || value.bytes > 0 && value.reads > 0);
  }
  const definitionKnown = (row: Row) => {
    const matches = definitions.filter(value => value.generation === row.generation && value.authority === row.authority && value.version === AGENT_RESOURCES_VERSION && value.tool === "research.evidence");
    return row.definition && row.bodyChecksum === hash(definitionBody) && row.authority === personal && row.echo === personal && matches.length > 0 && new Set(matches.map(value => value.checksum)).size === 1;
  };
  function discoveryRead(row: Row, audit: Audit | null) {
    if (!row.discovery || !personal || !row.erp || row.method !== "POST" || row.resourceType !== "fetch" || row.status !== 200 || row.mime !== "json" || row.authority !== personal || row.echo !== personal || !complete(audit)
      || !(row.finished && !row.failed || row.failed && row.aborted) || row.terminalAt === null) return null;
    const descriptor = discoveryPosts.find(value => value.kind === row.discovery);
    if (!descriptor || row.path !== descriptor.path || row.bodyChecksum !== hash(descriptor.body) || new URL(row.request.url()).search) return null;
    const known = [...new Set(sessions.filter(value => value.generation === row.generation).map(value => value.authority))], timing = row.request.timing();
    const documents = rows.filter(value => value.erp && value.navigation && value.generation === row.generation && value.path === "/ai-tasks" && value.status === 200 && value.finished && !value.failed && value.terminalAt !== null && value.terminalAt <= row.at);
    const windows = controls.filter(value => value.kind === "personal_login" && value.generationAfter === row.generation && value.start <= row.at && value.end >= row.terminalAt!);
    if (known.length !== 1 || known[0] !== personal || documents.length !== 1 || windows.length !== 1 || !(timing.startTime > 0) || !(timing.responseStart >= 0) || !(timing.responseEnd >= timing.responseStart)) return null;
    if (row.discovery === "tool_definition") {
      const shown = toolDefinitions.filter(value => value.generation === row.generation && value.authority === personal && value.at >= row.terminalAt! && value.version === AGENT_TOOLS_VERSION && value.kind === "read" && value.tool === "knowledge.search");
      if (!shown.length || new Set(shown.map(value => value.checksum)).size !== 1) return null;
      return { ordinal: row.ordinal, kind: row.discovery, document: documents[0]!.ordinal, audit: { document: audit.document, sequence: audit.sequence }, domAt: shown[0]!.at,
        definitionChecksum: shown[0]!.checksum, domQueryChecksum: null, sourceDefinition: null, controlStart: windows[0]!.start };
    }
    const shown = candidateSelections.filter(value => value.generation === row.generation && value.authority === personal && value.at >= row.terminalAt! && value.tool === "research.evidence" && value.acceptedPage
      && value.queryChecksum === hash(canonicalJson(resourceCandidatesInput)) && value.queryValueHash === hash("") && value.selectedValueHash === hash(""));
    const sourceDefinitions = rows.filter(value => value.generation === row.generation && value.definition && value.at < row.at && value.status === 200 && (value.finished && !value.failed || value.failed && value.aborted) && definitionKnown(value) && complete(pair(value)));
    const original = definitions.filter(value => value.generation === row.generation && value.authority === personal);
    if (!shown.length || new Set(shown.map(value => value.definitionChecksum)).size !== 1 || sourceDefinitions.length !== 1 || !original.length || original.some(value => value.checksum !== shown[0]!.definitionChecksum)) return null;
    return { ordinal: row.ordinal, kind: row.discovery, document: documents[0]!.ordinal, audit: { document: audit.document, sequence: audit.sequence }, domAt: shown[0]!.at,
      definitionChecksum: shown[0]!.definitionChecksum, domQueryChecksum: shown[0]!.queryChecksum, sourceDefinition: sourceDefinitions[0]!.ordinal, controlStart: windows[0]!.start };
  }
  function check() {
    const approvedDiscovery = new Set<Request>();
    for (const row of rows) {
      if (iframe.has(row.request) && row.failed && row.status === null && row.request.failure()?.errorText === "net::ERR_CONNECTION_REFUSED") { row.classification = "exact_injected_configuration_iframe_offline"; continue; }
      const audit = pair(row), unique = [...new Set(sessions.filter(item => item.generation === row.generation).map(item => item.authority))];
      const currentKnown = unique.length === 1 && unique[0] === personal;
      const discovery = discoveryRead(row, audit);
      if (discovery) { approvedDiscovery.add(row.request); row.auditPair = discovery.audit; discoveryReads.push(discovery); }
      if (!row.failed) continue;
      const expectedReadStatus = row.method === "GET" || row.definition || row.discovery ? 200 : row.path === "/api/creative-studio/configuration" && row.bodyChecksum === hash(JSON.stringify({ operation: "configuration.get" })) ? 201 : null;
      if (row.erp && row.aborted && row.metadata && row.status === expectedReadStatus && currentKnown && (row.authority === personal || row.authority === null && row.personal === personal) && (!row.echo || row.echo === personal)
        && (!row.definition || definitionKnown(row)) && (!row.discovery || approvedDiscovery.has(row.request)) && complete(audit)) {
        row.classification = "completed_read_with_terminal_abort"; row.auditPair = { document: audit.document, sequence: audit.sequence }; continue;
      }
      const url = new URL(row.request.url()), key = canonical(url, true), timing = row.request.timing();
      const doc = rows.filter(item => item.erp && item.generation === row.generation && item.navigation && item.status === 200 && item.finished);
      const initialWorkspace: Record<string, string> = { "/api/agent-readiness/native_v3": "/api/agent-native-v3/workspace", "/api/agent-readiness/loop": "/api/agent-loops/workspace", "/api/agent-readiness/plan": "/api/agent-plans/workspace" };
      const initial = controls.filter(window => window.kind === "personal_login" && window.generationAfter === row.generation && window.start <= row.at && window.end >= (row.terminalAt ?? Infinity));
      if (row.erp && row.aborted && row.method === "GET" && row.resourceType === "fetch" && !url.search && initialWorkspace[row.path] && noCdpResponseTiming(row) && row.authority === personal && currentKnown
        && doc.length === 1 && doc[0]!.terminalAt !== null && doc[0]!.terminalAt! <= row.at && initial.length === 1) {
        const window = initial[0]!, cancelled = pair(row, true);
        const workspace = rows.filter(value => value.generation === row.generation && value.erp && value.method === "GET" && value.path === initialWorkspace[row.path] && !new URL(value.request.url()).search && value.status === 200 && value.finished && !value.failed
          && value.authority === personal && value.echo === personal && value.at >= window.start && value.at <= row.at && value.terminalAt !== null && value.terminalAt >= (row.terminalAt ?? Infinity) && value.terminalAt <= window.end);
        const replacement = rows.filter(value => value !== row && value.generation === row.generation && value.erp && value.method === "GET" && value.path === row.path && value.queryHash === row.queryHash && value.status === 200 && value.finished && !value.failed
          && value.authority === personal && value.echo === personal && value.at >= (row.terminalAt ?? Infinity) && value.terminalAt !== null && value.terminalAt <= window.end && complete(pair(value)));
        if (cancelled?.aborted && cancelled.abortAt !== null && cancelled.fetchErrorAt !== null && cancelled.abortAt <= cancelled.fetchErrorAt && cancelled.fetchError === "AbortError" && cancelled.status === null && cancelled.bytes === 0 && cancelled.reads === 0
          && !cancelled.eof && !cancelled.json && !cancelled.cancelled && !cancelled.bodyError && workspace.length === 1 && replacement.length === 1 && workspace[0]!.terminalAt! <= replacement[0]!.at
          && sessions.some(value => value.generation === row.generation && value.authority === personal && value.at >= doc[0]!.terminalAt! && value.at <= window.end)) {
          const next = pair(replacement[0]!); if (next) {
            row.classification = "initial_read_replaced_after_workspace"; row.auditPair = { document: cancelled.document, sequence: cancelled.sequence };
            cancellations.push({ ordinal: row.ordinal, document: doc[0]!.ordinal, workspace: workspace[0]!.ordinal, replacement: replacement[0]!.ordinal,
              audit: row.auditPair, replacementAudit: { document: next.document, sequence: next.sequence }, controlStart: window.start });
            continue;
          }
        }
      }
      if (row.erp && row.aborted && row.method === "GET" && row.resourceType === "fetch" && row.prefetch && row.rsc && row.mime === "rsc" && row.status === 200 && prefetchTargets.includes(row.path) && !row.authority && !row.echo && key
        && currentKnown && doc.length === 1 && doc[0]!.terminalAt !== null && doc[0]!.terminalAt! <= row.at && timing.startTime > 0 && timing.responseStart >= 0 && timing.responseEnd >= timing.responseStart
        && controls.some(window => window.generationAfter === row.generation && window.start <= row.at && window.end >= (row.terminalAt ?? Infinity)
          && links.some(link => link.generation === row.generation && link.path === row.path && link.queryHash === hash(key) && link.at >= window.start && link.at <= window.end)
          && sessions.some(value => value.generation === row.generation && value.authority === personal && value.at >= doc[0]!.terminalAt! && value.at <= window.end))) row.classification = "literal_dom_prefetch_cancel";
    }
    for (const request of iframe) {
      const row = rows.find(row => row.request === request); if (!row?.failed) continue;
      const matching = errors.filter(error => !error.consumed && error.kind === "console" && error.urlHash === row.urlHash && row.classification === "exact_injected_configuration_iframe_offline");
      if (matching.length === 1) matching[0]!.consumed = true;
    }
    const safe = (values: Row[]) => values.map(value => { const { request, ...row } = value; void request; return row; });
    expect(safe(rows.filter(row => row.status !== null && row.status >= 400 && !iframe.has(row.request))), "Unexpected HTTP failure").toEqual([]);
    expect(safe(rows.filter(row => (row.failed || !row.finished) && !row.classification)), "Unclassified network termination").toEqual([]);
    expect(errors.filter(error => !error.consumed), "Unexpected console or page error").toEqual([]);
    expect(safe(rows.filter(row => row.erp && row.method === "POST" && (!row.metadata || row.definition && !definitionKnown(row) || row.discovery && !approvedDiscovery.has(row.request)))), "No business or paid POST is authorized by readiness").toEqual([]);
  }
  return { current, control, stable, check, iframe,
    proof: () => ({ requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), audits: [...audits.values()], controls, sessions, links, definitions, toolDefinitions, candidateSelections, discoveryReads, cancellations, errors }) };
}

async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
async function record(info: TestInfo, value: unknown) { const path = info.outputPath("agent-readiness-proof.json"); await writeFile(path, JSON.stringify(value, null, 2)); await info.attach("agent-readiness-proof", { path, contentType: "application/json" }); }
async function diagnostic(page: Page, family: AgentReadinessFamily) {
  const region = page.getByRole("region", { name: families[family], exact: true });
  await expect(region.getByText("当前存在启动阻断", { exact: true })).toBeVisible();
  await expect(region.getByText("尚未配置任务可用模型", { exact: true })).toBeVisible();
  await expect(region.getByText("尚未验证 本次请求金额 所选具体来源 模型提供方连通性 任务执行服务在线状态", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "只读刷新启动诊断", exact: true })).toBeEnabled();
  return region;
}
async function verifyReadinessResponse(page: Page, family: AgentReadinessFamily, action: () => Promise<unknown>) {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/agent-readiness/" + family && response.request().method() === "GET").then(async response => ({ status: response.status(), authority: response.headers()["x-yummyai-context-authority"], body: AgentReadinessSchema.parse(await response.json()) }));
  await action(); const actual = await response; expect(actual.status).toBe(200); expect(actual.body.family).toBe(family);
  expect(actual.authority).toBe(actual.body.contextAuthority); expect(actual.body.blockers).toContain("model_not_configured");
  expect(actual.body.effects).toEqual({ modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 });
  return actual.body;
}

test.describe("compiled personal read-only Agent readiness", () => {
  test("shows five original family diagnostics and keeps original recovery controls at 1440 and 390", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = []; let primaryFailure = false, networkFailed = false;
    try {
      await page.setViewportSize({ width: 1440, height: 960 });
      await seen.control("personal_login", () => loginErp(page, "operator", "/ai-tasks"));
      for (const family of ["loop", "plan", "native_v3"] as const) await diagnostic(page, family);
      await expect(page.getByRole("region", { name: "本人十二类工具任务恢复", exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "十二类工具原任务读取", exact: true }).getByRole("button", { name: "按原 ID 读取任务", exact: true })).toBeEnabled();
      await expect(page.getByRole("form", { name: "启动十二类原生工具模型任务", exact: true }).getByRole("combobox", { name: "本次原生任务模型", exact: true })).toBeDisabled();
      const versions = page.getByRole("region", { name: "原生模型任务版本", exact: true });
      for (const [family, tab] of [["native_v2", "v2 历史任务"], ["native_v1", "v1 历史任务"], ["native_v3", "v3 含履约读取"]] as const)
        await seen.control("select_original_version", async () => { await versions.getByRole("tab", { name: tab, exact: true }).click(); await diagnostic(page, family); });
      const region = await diagnostic(page, "native_v3");
      const value = await seen.control("refresh_readiness", () => verifyReadinessResponse(page, "native_v3", () => region.getByRole("button", { name: "只读刷新启动诊断", exact: true }).click()));
      expect(value.contextAuthority).toBe(erpSessionAuthority(await seen.current()));
      await expect(region.getByRole("link", { name: "核对分析模型与费用设置", exact: true })).toHaveAttribute("href", "/settings/ai#analysis-model-settings");
      await region.scrollIntoViewIfNeeded(); await noOverflow(page); await page.screenshot({ path: info.outputPath("readiness-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 }); await region.scrollIntoViewIfNeeded(); await diagnostic(page, "native_v3"); await noOverflow(page);
      await page.screenshot({ path: info.outputPath("readiness-mobile.png") });
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    await record(info, { nonce: isolated.nonce, scope: "metadata_only_no_processor_or_model", primaryFailure, networkFailed, network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "Agent readiness UI or strict network failed");
  });

  test("opens real analysis fees while the exact configuration iframe is offline at 1440 and 390 without saving or starting anything", async ({ page }, info) => {
    const seen = await observe(page), failures: unknown[] = []; let primaryFailure = false, networkFailed = false;
    const runtime = studioRuntimeUrl(process.env, "settings"); if (!runtime) throw new Error("readiness_expected_local_configuration_runtime");
    const runtimeOrigin = new URL(runtime).origin;
    if (runtimeOrigin === new URL(info.project.use.baseURL ?? "http://localhost:3130").origin) throw new Error("readiness_configuration_iframe_must_be_separate");
    await page.route(url => url.origin === runtimeOrigin, async route => {
      const request = route.request(), url = new URL(request.url());
      const keys = [...url.searchParams.keys()];
      if (request.method() !== "GET" || request.resourceType() !== "document" || request.frame().parentFrame() !== page.mainFrame() || url.pathname !== "/" || keys.length !== 3 || new Set(keys).size !== 3 ||
        !keys.every(key => ["surface", "parentOrigin", "channel"].includes(key)) || url.searchParams.get("surface") !== "settings" || url.searchParams.get("parentOrigin") !== new URL(page.url()).origin || !z.uuid().safeParse(url.searchParams.get("channel")).success) return route.continue();
      seen.iframe.add(request); await route.abort("connectionrefused");
    });
    try {
      await page.setViewportSize({ width: 1440, height: 960 }); await seen.control("personal_settings_login", () => loginErp(page, "operator", "/settings/ai"));
      await expect(page.getByRole("heading", { name: "AI 模型配置", exact: true })).toBeVisible();
      const fees = page.locator("#analysis-model-settings"), configuration = page.waitForResponse(response => new URL(response.url()).pathname === "/api/creative-studio/configuration" && response.request().method() === "POST");
      const models = page.waitForResponse(response => new URL(response.url()).pathname === "/api/ai-assists/models" && response.request().method() === "GET");
      await seen.control("read_fees_independent_of_iframe", async () => {
        const workbench = page.getByRole("region", { name: "统一模型配置", exact: true });
        await workbench.getByRole("button", { name: "高级兼容配置", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "高级兼容配置工作区", exact: true })).toBeVisible();
        await fees.getByText("图文分析模型与费用设置", { exact: true }).click();
        const [actualConfiguration, actualModels] = await Promise.all([configuration, models]);
        expect(actualConfiguration.status()).toBe(201); expect(actualModels.status()).toBe(200);
        expect(actualConfiguration.request().postData() === JSON.stringify({ operation: "configuration.get" })).toBe(true);
        await expect(fees.getByText("尚未配置图文分析模型。", { exact: true })).toBeVisible();
        const channels = fees.getByRole("combobox", { name: "分析渠道", exact: true });
        await expect(channels).toBeEnabled();
        await expect(channels.getByRole("option", { name: "Synthetic acceptance only", exact: true })).toHaveCount(1);
        await expect(channels).toHaveValue("");
      });
      const canvasSettings = page.getByRole("region", { name: "渠道与默认模型配置", exact: true });
      await expect(canvasSettings.getByRole("button", { name: "重新连接配置", exact: true })).toBeVisible({ timeout: 35_000 });
      await expect(canvasSettings.getByRole("alert")).toContainText("配置界面暂时未能连接，请重试");
      expect(seen.iframe.size).toBe(1);
      await expect(fees.getByRole("button", { name: "刷新分析模型", exact: true })).toBeEnabled();
      await expect(fees.getByRole("button", { name: "添加图文分析模型", exact: true })).toBeDisabled();
      await fees.scrollIntoViewIfNeeded(); await noOverflow(page); await page.screenshot({ path: info.outputPath("fees-offline-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 }); await fees.scrollIntoViewIfNeeded(); await noOverflow(page);
      await expect(fees.getByRole("button", { name: "刷新分析模型", exact: true })).toBeEnabled(); await page.screenshot({ path: info.outputPath("fees-offline-mobile.png") });
    } catch (error) { primaryFailure = true; failures.push(error); }
    try { await seen.current(); await seen.stable(); seen.check(); } catch (error) { networkFailed = true; failures.push(error); }
    await record(info, { nonce: isolated.nonce, scope: "real_configuration_get_and_models_no_paid_or_configuration_write", primaryFailure, networkFailed, exactOfflineFrames: seen.iframe.size, network: seen.proof() });
    if (failures.length) throw new AggregateError(failures, "Independent fees UI or strict network failed");
  });
});
