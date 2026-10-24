import { expect, test, type Locator, type Page, type Request as BrowserRequest, type Route, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EntityIdSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_NATIVE_V4_VERSION, AGENT_NATIVE_V4_CLEAR_EVENT, AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX,
  AgentNativeV4ItemReceiptSchema, PrepareAgentNativeV4ItemSchema } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandViewSchema, ConfirmAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AgentFulfillmentOperatorCheckSchema } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_LOOP_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/agent-loop";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { ShipmentCreateWorkspaceSchema } from "@yummyai/contracts/order/shipment";
import { AGENT_RESOURCES_VERSION, AgentResourceDefinitionRequestSchema, AgentResourceDefinitionSchema, agentResourceDefinitionPayload,
  AgentResourceCandidatesQuerySchema, AgentResourceCandidatesSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionRequestSchema, AgentToolDefinitionSchema, agentToolDefinitionPayload } from "@yummyai/contracts/ai/agent-tools";
import type { ShipmentCreateBrowserSeed, ShipmentCreateBrowserState, ShipmentCreateBrowserBusiness } from "../../../tools/testing/shipment-create-browser.mts";
import { requireShipmentCreateEnvironment } from "../../../tools/testing/require-shipment-create-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireShipmentCreateEnvironment(process.env, "current", true), root = fileURLToPath(new URL("../../../", import.meta.url));
const Id = EntityIdSchema, Hash = z.string().regex(/^[a-f0-9]{64}$/), Md5 = z.string().regex(/^[a-f0-9]{32}$/);
const hash = (text: string) => createHash("sha256").update(text).digest("hex"), digest = (value: unknown) => hash(canonicalJson(value));
const nativePath = "/api/agent-native-v4", afcPath = "/api/agent-fulfillment-commands";
const Counter = z.object({ modelCalls: z.int().nonnegative(), responses: z.int().nonnegative(), paidProviderCalls: z.literal(0),
  workerProcesses: z.literal(0), providerFailures: z.int().nonnegative() }).strict();
const Group = z.object({ lineId: Id, productionOrderId: Id, productionVersionId: Id, qualityGroupId: Id, qualityInspectionId: Id,
  productionProjectionVersion: z.int().positive(), productionProjectionVersionAfterInspection: z.int().positive(),
  quantity: z.int().positive(), availableQuantity: z.int().nonnegative(), result: z.enum(["passed", "failed"]) }).strict();
const Seed = z.object({ version: z.literal(AGENT_NATIVE_V4_VERSION), runId: Id,
  parentRequest: z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict(),
  proposal: z.object({ itemId: Id, position: z.int().nonnegative(), proposalChecksum: Hash, originalProtocol: z.literal(AGENT_FULFILLMENT_COMMAND_VERSION),
    originalOrderId: Id, originalChecksum: z.null(), preparationRequestChecksum: z.null(), operatorChecks: z.array(AgentFulfillmentOperatorCheckSchema) }).strict(),
  order: z.object({ orderId: Id, sequence: z.int().positive(), lines: z.array(z.object({ lineId: Id, quantity: z.int().positive(), productionOrderId: Id }).strict()).length(2) }).strict(),
  groups: z.object({ aGood: Group, aHeld: Group, bGood: Group }).strict(),
  packages: z.array(z.object({ packageReferenceId: z.string().min(1), lines: z.array(z.object({ orderLineId: Id, quantity: z.int().positive() }).strict()).min(1) }).strict()).length(2),
  source: z.object({ stepId: Id, resultIndex: z.int().nonnegative(), dataChecksum: Hash, expectedSequence: z.int().positive() }).strict(),
  model: z.object({ providerId: Id, modelId: Id }).strict(), counters: Counter }).strict();
const Business = z.record(z.string().regex(/^[a-z_]+$/), z.object({ count: z.int().nonnegative(), hash: Md5 }).strict());
const Receipt = z.object({ kind: z.literal("shipment_create"), shipmentId: Id, versionId: Id, versionNumber: z.int().positive() }).strict();
const State = z.object({ run: z.object({ id: Id, requestId: z.uuid(), requestChecksum: Hash, status: z.string(), revision: z.int(), stopped: z.boolean(),
  inputChecksum: Hash, resultChecksum: Hash.nullable(), knownCostUsd: z.string(), unknownCost: z.boolean(), expiresAt: z.iso.datetime() }).strict(),
  item: z.object({ id: Id, proposalChecksum: Hash, originalProtocol: z.string().nullable(), originalOrderId: Id.nullable(), originalChecksum: Hash.nullable(),
    preparationRequestChecksum: Hash.nullable(), completionChecksum: Hash.nullable(), preparationRequested: z.boolean(), fulfillmentIntentId: Id.nullable() }).strict(),
  original: z.object({ id: Id, requestId: z.uuid(), requestChecksum: Hash, contractVersion: z.string(), status: z.string(), generation: z.int(),
    leasePresent: z.boolean(), acknowledged: z.boolean(), redacted: z.boolean(), privateAvailable: z.boolean().nullable(), viewStatus: z.string().nullable(), receipt: Receipt.nullable() }).strict().nullable(),
  originalRead: z.enum(["not_linked", "available", "denied"]), shipment: z.object({ id: Id, orderId: Id, status: z.string(), currentVersionNumber: z.int(),
    approvedVersionNumber: z.int().nullable(), wholeOrder: z.boolean(), versions: z.array(z.object({ id: Id, versionNumber: z.int(), requestChecksum: Hash.nullable(), productionSourceVersion: z.int().nullable() }).strict()),
    packages: z.array(z.object({ id: Id, versionId: Id, packageReferenceId: z.string() }).strict()),
    packageLines: z.array(z.object({ id: Id, versionId: Id, packageId: Id, orderLineId: Id, quantity: z.int() }).strict()),
    productionAllocations: z.array(z.object({ id: Id, versionId: Id, packageId: Id, packageLineId: Id, orderLineId: Id, productionOrderId: Id,
      productionVersionId: Id, qualityInspectionId: Id, qualityGroupId: Id.nullable(), productionProjectionVersion: z.int(), quantity: z.int() }).strict()),
    reviewCount: z.int(), trackingCount: z.int(), writebackCount: z.int(), manualConfirmationCount: z.int(), physicalHandover: z.object({
      shipmentVersionId: Id.nullable(), packageCount: z.int(), dispatchedPackageCount: z.int(), allDispatched: z.boolean() }).strict() }).strict().nullable(),
  shipmentFacts: z.object({ tables: Business, role: z.string().min(1), orderShipmentCount: z.int() }).strict(), counters: Counter }).strict();
const changes = (before: ShipmentCreateBrowserBusiness, after: ShipmentCreateBrowserBusiness) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  .filter(key => before[key]?.count !== after[key]?.count || before[key]?.hash !== after[key]?.hash).map(table => ({ table, before: before[table] ?? null, after: after[table] ?? null }));
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(operation: Promise<T>, code: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); })]); }
  finally { clearTimeout(timer); }
}
function childOwner() {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    resolve(root, "tools/testing/shipment-create-browser.mts"), "--shipment-create-browser-child"], { cwd: root, windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
  const evidence = { pid: child.pid ?? null, closeRequested: false, closeRequestId: null as number | null, closeAcknowledged: false, exited: false,
    exitCode: null as number | null, signal: null as string | null, forced: false, startupCode: null as string | null };
  const waiting = new Map<number, { close: boolean; resolve(value: unknown): void; reject(error: Error): void }>();
  let resolveReady!: () => void, rejectReady!: (error: Error) => void, sequence = 0, failed: Error | undefined, closing: Promise<void> | undefined;
  const ready = new Promise<void>((done, reject) => { resolveReady = done; rejectReady = reject; }); void ready.catch(() => {});
  function fail(error: Error) { failed ??= error; rejectReady(error); for (const item of waiting.values()) item.reject(error); waiting.clear(); }
  child.stderr?.on("data", (bytes: Buffer) => { evidence.startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED)\b/.exec(bytes.toString("utf8"))?.[1] ?? null; });
  child.on("message", (raw: unknown) => {
    const parsed = z.discriminatedUnion("type", [z.object({ type: z.literal("ready"), nonce: z.literal(isolated.nonce) }).strict(),
      z.object({ type: z.literal("result"), nonce: z.literal(isolated.nonce), id: z.int().positive(), value: z.unknown() }).strict(),
      z.object({ type: z.literal("failure"), nonce: z.literal(isolated.nonce), id: z.int().positive().optional(), phase: z.string().regex(/^[a-z_]{1,64}$/),
        code: z.string().regex(/^(?:[A-Z0-9]{5}|shipment_browser_[a-z0-9_]{1,96})$/).nullable() }).strict()]).safeParse(raw);
    if (!parsed.success) { fail(new Error("shipment_browser_packet_invalid")); return; }
    const packet = parsed.data;
    if (packet.type === "ready") { resolveReady(); return; }
    if (packet.type === "failure") { fail(new Error(JSON.stringify(packet))); return; }
    const pending = waiting.get(packet.id); if (!pending) { fail(new Error("shipment_browser_packet_unmatched")); return; }
    waiting.delete(packet.id); if (pending.close) evidence.closeAcknowledged = z.object({ closed: z.literal(true) }).strict().safeParse(packet.value).success;
    pending.resolve(packet.value);
  });
  child.once("error", () => fail(new Error("shipment_browser_spawn_failed")));
  const ended = new Promise<void>(done => child.once("close", (code, signal) => {
    evidence.exited = true; evidence.exitCode = code; evidence.signal = signal;
    if (!evidence.closeAcknowledged || code !== 0 || signal) fail(new Error("shipment_browser_child_exit_invalid")); done();
  }));
  async function request(input: { operation: "seed"; context: TenantContext } | { operation: "business" | "state" | "close" }) {
    await bounded(ready, "shipment_browser_ready_timeout", 60_000);
    if (!child.connected || evidence.exited) throw failed ?? new Error("shipment_browser_child_unavailable");
    // Keep the original failure sticky for every business operation. A seed
    // failure after ready must still allow the precise close RPC to reach the
    // child; its ACK and exit remain independent, mandatory cleanup evidence.
    if (failed && input.operation !== "close") throw failed;
    const id = ++sequence;
    return bounded(new Promise<unknown>((done, reject) => { waiting.set(id, { close: input.operation === "close", resolve: done, reject });
      child.send({ ...input, id, nonce: isolated.nonce }, error => {
        if (error) { waiting.delete(id); reject(new Error("shipment_browser_send_failed")); }
        else if (input.operation === "close") { evidence.closeRequested = true; evidence.closeRequestId = id; }
      });
    }), "shipment_browser_request_timeout", input.operation === "seed" ? 180_000 : 45_000);
  }
  async function drain() {
    const failures: unknown[] = [];
    try { z.object({ closed: z.literal(true) }).strict().parse(await request({ operation: "close" })); } catch (error) { failures.push(error); }
    try { await bounded(ended, "shipment_browser_exit_timeout", 20_000); } catch (error) { failures.push(error); }
    if (!evidence.exited) { evidence.forced = true; child.kill("SIGKILL"); await bounded(ended, "shipment_browser_forced_exit_timeout", 10_000); }
    if (evidence.forced || !evidence.closeAcknowledged || evidence.exitCode !== 0 || evidence.signal) failures.push(new Error("shipment_browser_close_unverified"));
    if (failures.length) throw new AggregateError(failures, "shipment_browser_close_failed");
  }
  return { request, evidence, close: () => closing ??= drain() };
}

type Audit = { document: string; sequence: number; order: number; start: number; method: string; urlHash: string; bodyHash: string | null; authorityHash: string | null;
  status: number | null; echoHash: string | null; signalAbortAt: number | null; signalAbortOrder: number | null; fetchError: string | null; readerError: string | null;
  cancelAt: number | null; eofAt: number | null; jsonAt: number | null; bytes: number; reads: number };
type Clear = { document: string; name: string; at: number; order: number };
type ReadBegin = { document: string; path: string; at: number; order: number };
declare global { interface Window { __shipmentCreateReads?: { document: string; rows: Audit[]; clears: Clear[]; begins: ReadBegin[]; clock: number; pending: number; failures: number } } }
const metadata = [
  { path: "/api/agent-resources/definition", body: AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }) },
  { path: "/api/agent-tools/definition", body: AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } }) },
  { path: "/api/agent-resources/candidates", body: AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" }) },
];
type Row = { ordinal: number; request: BrowserRequest; at: number; document: number; path: string; queryKeys: string[]; urlHash: string; method: string; bodyHash: string | null;
  authorityHash: string | null; echoHash: string | null; status: number | null; finished: boolean; failure: string | null; expectedLoss: boolean; metadata: boolean;
  metadataProof: { checksum: string; authorityHash: string } | null; metadataError: boolean };
type ConsoleDiagnostic = { category: "react_minified" | "react_hydration" | "html_nesting" | "svg_attribute_parse" | "autofocus_blocked" | "aria_focus_hidden"
  | "native_pattern_regex_invalid" | "native_form_value_format" | "invalid_form_control" | "browser_network" | "unknown";
  reactErrorNumber: number | null; knownOriginalCarrierPattern: boolean;
  source: { pathname: string; line: number; column: number; coordinateBase: 0 } | null };
function consoleDiagnostic(text: string, location: { url: string; lineNumber: number; columnNumber: number }): ConsoleDiagnostic {
  const react = /\bMinified React error #([0-9]{1,5})\b/.exec(text);
  let category: ConsoleDiagnostic["category"] = "unknown";
  if (react) category = "react_minified";
  else if (/hydration failed|hydration mismatch|hydrating/i.test(text)) category = "react_hydration";
  else if (/cannot be a descendant|cannot contain a nested|validateDOMNesting|In HTML,/i.test(text)) category = "html_nesting";
  else if (/Error: <(?:svg|path|circle|rect|line|polyline|polygon|ellipse|g|text|use)> attribute [A-Za-z-]+:/i.test(text)) category = "svg_attribute_parse";
  else if (/autofocus.*blocked|already has a focused element/i.test(text)) category = "autofocus_blocked";
  else if (/Blocked aria-hidden|aria-hidden.*(?:focus|descendant)/i.test(text)) category = "aria_focus_hidden";
  else if (/Pattern attribute value.*(?:invalid regular expression|not a valid regular expression)|Invalid character in character class/i.test(text)) category = "native_pattern_regex_invalid";
  else if (/An invalid form control.*not focusable/i.test(text)) category = "invalid_form_control";
  else if (/The specified value|does not conform to the required format/i.test(text)) category = "native_form_value_format";
  else if (/^Failed to load resource:/.test(text)) category = "browser_network";
  let source: ConsoleDiagnostic["source"] = null;
  try {
    const url = new URL(location.url);
    if (url.origin === "http://localhost:3130" && /^\/_next\/static\/[A-Za-z0-9_./-]+\.js$/.test(url.pathname) && url.pathname.length <= 300
      && Number.isSafeInteger(location.lineNumber) && location.lineNumber >= 0 && Number.isSafeInteger(location.columnNumber) && location.columnNumber >= 0)
      source = { pathname: url.pathname, line: location.lineNumber, column: location.columnNumber, coordinateBase: 0 };
  } catch { /* No nonlocal location, raw text, query or URL fragment is retained. */ }
  return { category, reactErrorNumber: react ? Number(react[1]) : null,
    knownOriginalCarrierPattern: category === "native_pattern_regex_invalid" && text.includes("[A-Z0-9_:-]+"), source };
}
async function observer(page: Page) {
  const rows: Row[] = [], requests = new Map<BrowserRequest, Row>(), audits = new Map<string, Audit>(), documents = new Map<number, string>();
  const clears = new Map<string, Clear>(), begins = new Map<string, ReadBegin>(), tasks = new Set<Promise<void>>(), definitions: Array<{ document: number; authority: string; resource: string; tool: string }> = [];
  const errors: Array<{ kind: string; hash: string; at: number; expectedNetwork: boolean; diagnostic?: ConsoleDiagnostic }> = [], controls: Array<{ name: string; start: number; end: number | null; authority: string | null }> = [];
  const terminalClearPairs: Array<Record<string, unknown>> = [];
  let document = 0, authority: string | null = null, source: ShipmentCreateBrowserSeed | undefined, cleared = false;
  const track = (task: Promise<void>) => { tasks.add(task); void task.then(() => tasks.delete(task), () => {
    tasks.delete(task); errors.push({ kind: "passive_observer_task_failed", hash: hash("passive_observer_task_failed"), at: Date.now(), expectedNetwork: false });
  }); };
  await page.addInitScript(({ prefixes, paths, events }) => {
    const state: NonNullable<Window["__shipmentCreateReads"]> = { document: crypto.randomUUID(), rows: [], clears: [], begins: [], clock: 0, pending: 0, failures: 0 };
    window.__shipmentCreateReads = state;
    const now = () => performance.timeOrigin + performance.now(), streams = new WeakMap<object, Audit>(), readers = new WeakMap<object, Audit>(), responses = new WeakMap<object, Audit>();
    const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const pending = (task: Promise<void>) => { state.pending++; void task.then(() => state.pending--, () => { state.pending--; state.failures++; }); };
    const errorName = (error: unknown) => error instanceof Error && ["AbortError", "TypeError", "Error"].includes(error.name) ? error.name : "Unknown";
    const originalFetch = window.fetch;
    window.fetch = function(input, options) {
      const result = originalFetch.call(this, input, options), start = now(), order = ++state.clock;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href); url.hash = "";
      const method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin === location.origin && method === "GET" && url.pathname.startsWith("/api/") && url.pathname !== "/api/erp-auth/session")
        state.begins.push({ document: state.document, path: url.pathname, at: start, order });
      if (url.origin !== location.origin || !paths.includes(url.pathname) && !prefixes.some(prefix => url.pathname.startsWith(prefix + "/"))
        && !/^\/api\/order-centers\/orders\/[a-f0-9-]{36}\/shipment-create-workspace$/.test(url.pathname)) return result;
      const stamp = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-yummyai-context-authority");
      const signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      const row: Audit = { document: state.document, sequence: state.rows.length + 1, order, start, method, urlHash: "", bodyHash: null, authorityHash: null,
        status: null, echoHash: null, signalAbortAt: null, signalAbortOrder: null, fetchError: null, readerError: null, cancelAt: null, eofAt: null, jsonAt: null, bytes: 0, reads: 0 };
      state.rows.push(row); pending((async () => { row.urlHash = await sha(url.href); if (typeof options?.body === "string") row.bodyHash = await sha(options.body); if (stamp) row.authorityHash = await sha(stamp); })());
      const abort = () => { if (row.signalAbortAt === null) { row.signalAbortAt = now(); row.signalAbortOrder = ++state.clock; } };
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      void result.then(response => { row.status = response.status; responses.set(response, row); if (response.body) streams.set(response.body, row);
        const echo = response.headers.get("x-yummyai-context-authority"); if (echo) pending(sha(echo).then(value => { row.echoHash = value; }));
      }, error => { row.fetchError = errorName(error); }); return result;
    };
    // Passive original consumption only: no clone, tee, replay, stream read or
    // substitute Promise. JSON completion is distinct from observed reader EOF.
    const get = ReadableStream.prototype.getReader, read = ReadableStreamDefaultReader.prototype.read, cancel = ReadableStreamDefaultReader.prototype.cancel, json = Response.prototype.json;
    Object.defineProperty(ReadableStream.prototype, "getReader", { ...Object.getOwnPropertyDescriptor(ReadableStream.prototype, "getReader"), value: function(this: ReadableStream, ...args: unknown[]) {
      const reader: object = Reflect.apply(get, this, args), row = streams.get(this); if (row) readers.set(reader, row); return reader;
    } });
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "read", { ...Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "read"), value: function(this: object, ...args: unknown[]) {
      const result: Promise<{ done: boolean; value?: unknown }> = Reflect.apply(read, this, args), row = readers.get(this);
      if (row) void result.then(value => { if (value.done) row.eofAt = now(); else { row.reads++; if (value.value instanceof Uint8Array) row.bytes += value.value.byteLength; } }, error => { row.readerError = errorName(error); }); return result;
    } });
    Object.defineProperty(ReadableStreamDefaultReader.prototype, "cancel", { ...Object.getOwnPropertyDescriptor(ReadableStreamDefaultReader.prototype, "cancel"), value: function(this: object, ...args: unknown[]) {
      const row = readers.get(this); if (row) row.cancelAt = now(); return Reflect.apply(cancel, this, args);
    } });
    Object.defineProperty(Response.prototype, "json", { ...Object.getOwnPropertyDescriptor(Response.prototype, "json"), value: function(this: Response, ...args: unknown[]) {
      const result: Promise<unknown> = Reflect.apply(json, this, args), row = responses.get(this);
      if (row) void result.then(() => { row.jsonAt = now(); }, error => { row.readerError = errorName(error); }); return result;
    } });
    for (const name of events) window.addEventListener(name, () => state.clears.push({ document: state.document, name, at: now(), order: ++state.clock }), { capture: true });
  }, { prefixes: [nativePath, afcPath], paths: metadata.map(item => item.path), events: [AGENT_LOOP_INTENT_CLEAR_EVENT, AGENT_NATIVE_V4_CLEAR_EVENT, ASSIST_INTENT_CLEAR_EVENT] });
  page.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) document++;
    const url = new URL(request.url()); url.hash = ""; const body = request.postData(), meta = metadata.find(item => item.path === url.pathname && !url.search && request.method() === "POST");
    let exact = false; if (meta && body) try { exact = digest(JSON.parse(body)) === digest(meta.body); } catch { /* Unknown writes remain unknown. */ }
    const row: Row = { ordinal: rows.length + 1, request, at: Date.now(), document, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort(), urlHash: hash(url.href),
      method: request.method(), bodyHash: body === null ? null : hash(body), authorityHash: null, echoHash: null, status: null, finished: false, failure: null,
      expectedLoss: false, metadata: exact, metadataProof: null, metadataError: false };
    rows.push(row); requests.set(request, row); track(request.headerValue("x-yummyai-context-authority").then(value => { row.authorityHash = value ? hash(value) : null; }));
  });
  page.on("response", response => {
    const row = requests.get(response.request()); if (!row) return; row.status = response.status();
    track((async () => {
      const echo = await response.headerValue("x-yummyai-context-authority"); row.echoHash = echo ? hash(echo) : null;
      if (!row.metadata || row.status !== 200) return;
      try {
        await response.finished(); const raw: unknown = await response.json();
        if (row.path === metadata[0].path) { const parsed = AgentResourceDefinitionSchema.parse(raw);
          if (parsed.tool !== "research.evidence" || digest(agentResourceDefinitionPayload(parsed)) !== parsed.definitionChecksum) throw new Error("original_definition_invalid");
          row.metadataProof = { checksum: parsed.definitionChecksum, authorityHash: hash(parsed.contextAuthority) };
        } else if (row.path === metadata[1].path) { const parsed = AgentToolDefinitionSchema.parse(raw);
          if (parsed.selection.kind !== "read" || parsed.selection.tool !== "knowledge.search" || digest(agentToolDefinitionPayload(parsed)) !== parsed.definitionChecksum) throw new Error("original_definition_invalid");
          row.metadataProof = { checksum: parsed.definitionChecksum, authorityHash: hash(parsed.contextAuthority) };
        } else { const parsed = AgentResourceCandidatesSchema.parse(raw);
          if (digest(parsed.query) !== digest(metadata[2].body) || parsed.inputChecksum !== digest(parsed.query)) throw new Error("original_candidates_invalid");
          row.metadataProof = { checksum: parsed.inputChecksum, authorityHash: hash(parsed.contextAuthority) };
        }
      } catch { row.metadataError = true; }
    })());
  });
  page.on("requestfinished", request => { const row = requests.get(request); if (row) row.finished = true; });
  page.on("requestfailed", request => { const row = requests.get(request); if (row) row.failure = request.failure()?.errorText ?? "unknown"; });
  page.on("pageerror", error => errors.push({ kind: "pageerror", hash: hash(error.message), at: Date.now(), expectedNetwork: false }));
  page.on("console", message => { if (message.type() === "error") {
    const text = message.text();
    errors.push({ kind: "console", hash: hash(text), at: Date.now(), expectedNetwork: /^Failed to load resource: net::ERR_(FAILED|ABORTED)$/.test(text),
      diagnostic: consoleDiagnostic(text, message.location()) });
  } });
  async function sample() {
    await expect.poll(() => page.evaluate(() => window.__shipmentCreateReads?.pending ?? 0)).toBe(0);
    const value = await page.evaluate(() => window.__shipmentCreateReads ?? null);
    if (value) { documents.set(document, value.document); for (const row of value.rows) audits.set(`${row.document}:${row.sequence}`, row);
      for (const event of value.clears) clears.set(`${event.document}:${event.order}`, event); for (const begin of value.begins) begins.set(`${begin.document}:${begin.order}`, begin);
      if (value.failures) throw new Error("shipment_passive_observation_failed"); }
    while (tasks.size) await Promise.all([...tasks]); return value;
  }
  async function identity() {
    const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
    const session = ErpSessionViewSchema.parse(await response.json()), actor = actors().operator;
    expect(session.userId).toBe(actor.userId); expect(session.tenantId).toBe(actor.tenantId); expect(session.canUseErp).toBe(true);
    authority = hash(erpSessionAuthority(session)); return TenantContextSchema.parse({ tenantId: session.tenantId, userId: session.userId, permissions: session.permissions,
      dataScope: session.dataScope, permissionScopes: session.permissionScopes, teamIds: session.teamIds, teamAuthority: session.teamAuthority });
  }
  async function control<T>(name: string, action: () => Promise<T>) {
    const value = { name, start: Date.now(), end: null as number | null, authority }; controls.push(value);
    try { return await action(); } finally { await sample(); value.end = Date.now(); }
  }
  function pair(row: Row) {
    const doc = documents.get(row.document); if (!doc || !row.authorityHash) return undefined;
    const original = rows.filter(value => value.document === row.document && value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash && value.authorityHash === row.authorityHash);
    const native = [...audits.values()].filter(value => value.document === doc && value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash && value.authorityHash === row.authorityHash).sort((a, b) => a.sequence - b.sequence);
    return original.length === native.length ? native[original.indexOf(row)] : undefined; // Entire exact same-document sequence: never skip a missing intermediate read.
  }
  const complete = (audit: Audit | undefined) => !!audit && audit.status === 200 && (audit.eofAt !== null || audit.jsonAt !== null)
    && audit.fetchError === null && audit.readerError === null && audit.cancelAt === null && (audit.signalAbortAt === null || audit.signalAbortAt > (audit.eofAt ?? audit.jsonAt ?? Infinity));
  async function metadataDom() {
    const resource = page.getByRole("region", { name: "业务资源读取", exact: true }), tool = page.getByRole("region", { name: "原生工具与命令目录", exact: true });
    await expect(resource.locator('button[aria-pressed="true"]').filter({ hasText: "research.evidence" })).toHaveCount(1);
    await expect(tool.locator('button[aria-pressed="true"]').filter({ hasText: "knowledge.search" })).toHaveCount(1);
    const candidates = resource.getByRole("region", { name: "原业务对象候选", exact: true }); await expect(candidates).toHaveAttribute("aria-busy", "false");
    await expect(candidates.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/)).toHaveCount(1);
    await expect(resource.getByRole("textbox", { name: "搜索原业务对象", exact: true })).toHaveValue("");
    await expect(candidates.getByRole("combobox", { name: "选择原业务对象", exact: true })).toHaveValue("");
    const checksum = async (region: Locator) => Hash.parse((await region.locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code").textContent())?.trim());
    if (!authority) throw new Error("shipment_personal_authority_missing");
    definitions.push({ document, authority, resource: await checksum(resource.getByRole("region", { name: "所选业务资源定义", exact: true })),
      tool: await checksum(tool.getByRole("region", { name: "所选严格工具定义", exact: true })) }); await sample();
  }
  function terminalClear(row: Row, audit: Audit | undefined) {
    if (!source || !cleared || !audit || row.path !== `/api/order-centers/orders/${source.order.orderId}/shipment-create-workspace` || row.queryKeys.length
      || row.method !== "GET" || row.bodyHash !== null || !row.authorityHash || row.failure !== "net::ERR_ABORTED" || row.status !== null && row.status !== 200
      || audit.fetchError !== "AbortError" || audit.readerError !== null || audit.signalAbortAt === null || audit.signalAbortOrder === null
      || audit.bytes !== 0 || audit.reads !== 0 || audit.eofAt !== null || audit.jsonAt !== null || audit.cancelAt !== null) return false;
    const events = [...clears.values()].filter(event => event.document === audit.document).sort((a, b) => a.order - b.order), first = events[0];
    const family = events.find(event => event.name === AGENT_NATIVE_V4_CLEAR_EVENT), assist = events.find(event => event.name === ASSIST_INTENT_CLEAR_EVENT);
    const accepted = !!first && first.name === AGENT_LOOP_INTENT_CLEAR_EVENT && !!family && !!assist && first.order < family.order && family.order < assist.order
      && audit.order < first.order && audit.start <= first.at && audit.signalAbortOrder > first.order && audit.signalAbortAt >= first.at
      && controls.some(control => control.name === "actual_CLEAR_of_original_packing_form" && control.authority === row.authorityHash && control.end !== null
        && control.start <= first.at && control.end >= assist.at);
    if (accepted) terminalClearPairs.push({ ordinal: row.ordinal, interpretation: "terminal_CLEAR_without_consumption_or_EOF", audit,
      rawTiming: row.request.timing(), central: first, family, assist, privateFieldsChecksAndBothMarkersAbsent: cleared });
    return accepted;
  }
  function check(intent: string | null) {
    const failures: Array<Record<string, unknown>> = [], pairings: Array<Record<string, unknown>> = [];
    for (const begin of begins.values()) { const first = [...clears.values()].filter(event => event.document === begin.document).sort((a, b) => a.order - b.order)[0];
      if (first && (begin.order >= first.order || begin.at > first.at)) failures.push({ reason: "business_GET_started_after_CLEAR", begin, first }); }
    for (const row of rows) {
      const api = new URL(row.request.url()).origin === "http://localhost:3130" && row.path.startsWith("/api/");
      if (row.status !== null && row.status >= 400) failures.push({ ordinal: row.ordinal, reason: "HTTP_error" });
      if (row.failure && row.failure !== "net::ERR_ABORTED" && !row.expectedLoss) failures.push({ ordinal: row.ordinal, reason: "unknown_transport" });
      const prepare = source && row.path === `${nativePath}/runs/${source.runId}/items/${source.proposal.itemId}/prepare`, confirm = intent && row.path === `${afcPath}/requests/${intent}/confirm`;
      if (api && !["GET", "HEAD"].includes(row.method) && (row.method !== "POST" || !prepare && !confirm && !row.metadata && row.path !== "/api/erp-auth/logout")) failures.push({ ordinal: row.ordinal, reason: "unknown_write" });
      const own = row.path.startsWith(nativePath + "/") || row.path.startsWith(afcPath + "/") || source && row.path === `/api/order-centers/orders/${source.order.orderId}/shipment-create-workspace`;
      const audit = pair(row);
      if (own || row.metadata) pairings.push({ ordinal: row.ordinal, audit: audit ? { document: audit.document, sequence: audit.sequence } : null,
        basis: "complete_exact_document_method_URL_body_full_authority_sequence", rawCdpStart: row.request.timing().startTime, rawNativeStart: audit?.start ?? null });
      if (row.metadata) {
        const dom = definitions.find(value => value.document === row.document && value.authority === row.authorityHash);
        if (!complete(audit) || row.status !== 200 || row.echoHash !== row.authorityHash || row.metadataProof?.authorityHash !== row.authorityHash || row.metadataError || !dom
          || row.path === metadata[0].path && row.metadataProof?.checksum !== dom.resource || row.path === metadata[1].path && row.metadataProof?.checksum !== dom.tool)
          failures.push({ ordinal: row.ordinal, reason: "strict_original_metadata_consumer_unproven" });
      }
      if (own && row.failure && !row.expectedLoss && !complete(audit) && !terminalClear(row, audit)) {
        const next = rows.find(value => value.ordinal > row.ordinal && value.document === row.document && value.urlHash === row.urlHash && value.method === row.method
          && value.bodyHash === row.bodyHash && value.authorityHash === row.authorityHash);
        if (row.method !== "GET" || !audit || audit.fetchError !== "AbortError" && audit.readerError !== "AbortError" || audit.signalAbortAt === null
          || audit.bytes !== 0 || audit.reads !== 0 || audit.eofAt !== null || audit.jsonAt !== null || !next || !complete(pair(next)))
          failures.push({ ordinal: row.ordinal, reason: "original_consumer_cancel_unproven" });
      }
    }
    for (const error of errors) if (!(error.kind === "console" && error.expectedNetwork && rows.some(row => row.expectedLoss && row.failure && Math.abs(row.at - error.at) <= 2000))) failures.push(error);
    expect(failures).toEqual([]); return pairings;
  }
  return { rows, sample, identity, control, metadataDom, pair, complete, check, setSource(value: ShipmentCreateBrowserSeed) { source = value; }, setCleared() { cleared = true; },
    loss(request: BrowserRequest) { const row = requests.get(request); if (!row) throw new Error("shipment_actual_lost_request_missing"); row.expectedLoss = true; },
    snapshot() { return { scope: "targeted_original_API_consumers; all_HTTP_errors_unknown_API_writes_and_console_errors_fail; unrelated_RSC_cancellations_recorded_without_EOF_claim",
      requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })), audits: [...audits.values()], clearEvents: [...clears.values()], businessReadBegins: [...begins.values()], terminalClearPairs, controls, definitions, errors }; } };
}

async function markers(page: Page) {
  return page.evaluate(prefixes => Object.keys(sessionStorage).filter(key => prefixes.some(prefix => key.startsWith(prefix)))
    .reduce((count, key) => { try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null"); return count + (Array.isArray(value) ? value.length : value ? 1 : 0); } catch { throw new Error("original_marker_invalid"); } }, 0),
  [AGENT_NATIVE_V4_INTENT_PREFIX, AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX]);
}
async function widths(page: Page, info: TestInfo, name: string, keyboard?: { from: Locator; to: Locator }) {
  const images: Array<Record<string, unknown>> = [];
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(() => page.evaluate(() => document.getAnimations().every(animation => animation.playState !== "running" && !animation.pending))).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (keyboard) {
      await keyboard.from.focus(); let reached = false;
      for (let step = 0; step < 90; step++) { await page.keyboard.press("Tab"); if (await keyboard.to.evaluate(element => element === document.activeElement)) { reached = true; break; } }
      expect(reached).toBe(true); expect(await keyboard.to.evaluate(element => { const box = element.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2, top = document.elementFromPoint(x, y);
        return box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && !!top && (top === element || element.contains(top)); })).toBe(true);
    }
    const path = info.outputPath(`${name}-${viewport.width}.png`); await page.screenshot({ path, fullPage: false }); await info.attach(`${name}-${viewport.width}`, { path, contentType: "image/png" });
    images.push({ ...viewport, path, keyboardReachableAndUncovered: !!keyboard, reducedMotion: await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches) });
  } return images;
}
async function packingForm(page: Page, source: ShipmentCreateBrowserSeed) {
  const handoff = page.getByRole("region", { name: "模型履约提案补项", exact: true }); await expect(handoff).toBeVisible(); await expect(handoff).toHaveAttribute("aria-busy", "false");
  const summary = page.locator("summary").filter({ hasText: /^按包裹分配本次发货$/ }); await expect(summary).toHaveCount(1);
  if (!await summary.locator("..").evaluate(element => element instanceof HTMLDetailsElement && element.open)) await summary.click();
  const form = page.getByRole("form", { name: "按包裹创建发货草稿", exact: true }); await expect(form).toBeVisible();
  await expect(summary.locator("..").locator(".sc-content")).toHaveAttribute("aria-busy", "false");
  await expect(form.locator(".sc-package")).toHaveCount(2);
  await form.getByLabel("计划发货时间", { exact: true }).fill(await page.evaluate(() => { const now = new Date(); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }));
  await form.getByLabel("发出国代码", { exact: true }).fill("US");
  for (const [index, proposed] of source.packages.entries()) {
    const packet = form.getByRole("region", { name: `本次包裹 ${index + 1}`, exact: true });
    // A named section is exposed as a region; the operator verifies each
    // original line and source independently in each physical package.
    await expect(packet).toBeVisible(); await expect(packet.getByLabel("包裹参考号", { exact: true })).toHaveValue(proposed.packageReferenceId);
    await packet.getByLabel("物流单号", { exact: true }).fill(`SYNTHETIC-PARTIAL-${index + 1}`);
    await packet.getByLabel("承运商代码", { exact: true }).fill("SYNTHETIC"); await packet.getByLabel("承运商名称", { exact: true }).fill("Synthetic original UI");
    await packet.getByLabel("物流服务", { exact: true }).fill("Synthetic partial original packages only");
    for (const [row, line] of proposed.lines.entries()) {
      await expect(packet.getByRole("combobox", { name: `包裹 ${index + 1} 商品 ${row + 1}`, exact: true })).toHaveValue(line.orderLineId);
      await expect(packet.getByRole("spinbutton", { name: `包裹 ${index + 1} 商品 ${row + 1} 装箱数量`, exact: true })).toHaveValue(String(line.quantity));
    }
    const physical = packet.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true });
    await expect(physical).not.toBeChecked();
    const allocations = packet.locator('input[type="hidden"][name$="shipmentProductionAllocations"]');
    const actual = z.record(z.string(), z.array(z.object({ productionOrderId: Id, productionVersionId: Id, qualityInspectionId: Id, qualityGroupId: Id.optional(),
      expectedProductionProjectionVersion: z.int(), quantity: z.int() }).strict())).parse(JSON.parse(await allocations.inputValue()));
    for (const line of proposed.lines) {
      const group = line.orderLineId === source.groups.aGood.lineId ? source.groups.aGood : source.groups.bGood, rows = actual[line.orderLineId];
      expect(rows?.length).toBe(1); expect(rows?.[0]?.qualityGroupId).toBe(group.qualityGroupId); expect(rows?.[0]?.productionVersionId).toBe(group.productionVersionId);
      expect(rows?.[0]?.qualityInspectionId).toBe(group.qualityInspectionId); expect(rows?.[0]?.expectedProductionProjectionVersion).toBe(group.productionProjectionVersion); expect(rows?.[0]?.quantity).toBe(line.quantity);
    }
    // The held physical group is never substituted for the passed group.
    if (proposed.lines.some(line => line.orderLineId === source.groups.aHeld.lineId)) {
      const held = packet.locator(`input[name$="${source.groups.aHeld.productionOrderId}:${source.groups.aHeld.qualityGroupId}"]`); await expect(held).toBeDisabled();
    }
    await physical.check();
  }
  await expect(form.getByRole("list", { name: "本次商品装箱合计", exact: true })).toContainText("本次 2 / 原数量 5 件");
  await expect(form.getByRole("list", { name: "本次商品装箱合计", exact: true })).toContainText("本次 1 / 原数量 1 件");
  await expect(form.getByRole("button", { name: "保存本次包裹草稿", exact: true })).toBeDisabled();
  await expect(form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true })).toBeEnabled(); return form;
}

test.describe("original native v4 partial shipment form", () => {
  for (const clear of [false, true]) test(clear ? "actual_CLEAR_discards_the_held_original_workspace_without_recreating_packing_fields_or_checks"
    : "partial_two_package_lost201_item_GET_recovers_same_AFC_and_only_explicit_confirm_creates_one_draft", async ({ page }, info) => {
    const seen = await observer(page), owner = childOwner(), releases: Array<() => void> = [], failures: unknown[] = [];
    const proof: Record<string, unknown> = { nonce: isolated.nonce, webPaidStartButtonExercised: false, paidProviderCalls: 0, ordinaryWorkers: 0,
      scope: "precomputed_original_start_exact_Redis_processor_loopback_Responses_then_real_personal_original_form", primaryFailure: false, networkFailed: false, cleanupFailed: false };
    let intent: string | null = null;
    try {
      await seen.control("personal_login", () => loginErp(page, "operator", "/navigation")); const context = await seen.identity();
      const seed: ShipmentCreateBrowserSeed = Seed.parse(await owner.request({ operation: "seed", context })); seen.setSource(seed); proof.seed = seed;
      expect(seed.counters.modelCalls).toBe(4); expect(seed.counters.responses).toBe(4); expect(seed.counters.providerFailures).toBe(0);
      expect(seed.groups.aGood.quantity).toBe(3); expect(seed.groups.aHeld.quantity).toBe(2); expect(seed.groups.bGood.quantity).toBe(1);
      expect(seed.groups.aGood.productionProjectionVersionAfterInspection).toBe(seed.groups.aGood.productionProjectionVersion + 1);
      expect(seed.proposal.operatorChecks.every(value => value.state === "pending")).toBe(true);
      const beforeUI = Business.parse(await owner.request({ operation: "business" })); proof.businessBeforeUI = beforeUI;
      await seen.control("read_actual_completed_proposal", async () => {
        await page.goto(`/ai-tasks?${new URLSearchParams({ agentNativeV4: seed.runId })}`);
        await expect(page.getByRole("listitem", { name: `模型原提案 ${seed.proposal.position + 1}`, exact: true })).toBeVisible(); await seen.metadataDom();
      });
      await seen.control("actual_proposal_original_form_Link", async () => {
        const link = page.getByRole("listitem", { name: `模型原提案 ${seed.proposal.position + 1}`, exact: true }).getByRole("link", { name: "到原表单补齐并本人核对", exact: true });
        const href = await link.getAttribute("href"); if (!href) throw new Error("actual_original_form_link_missing"); const url = new URL(href, page.url());
        expect(url.pathname).toBe("/shipments"); expect(url.searchParams.get("agentNativeV4")).toBe(seed.runId); expect(url.searchParams.get("agentNativeV4Item")).toBe(seed.proposal.itemId);
        expect(url.searchParams.get("order")).toBe(seed.order.orderId); expect(seed.order.lines.some(line => line.lineId === url.searchParams.get("line"))).toBe(true); await link.click();
      });
      const form = await packingForm(page, seed); proof.physicalChecksInitiallyFalseThenManuallyChecked = true;
      await seen.control("responsive_actual_partial_form", async () => { proof.formImages = await widths(page, info, "partial-original-form", {
        from: form.getByLabel("计划发货时间", { exact: true }), to: form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }) }); });
      const preparePath = `${nativePath}/runs/${seed.runId}/items/${seed.proposal.itemId}/prepare`, lost = latch(); releases.push(lost.release);
      const matchPrepare = (url: URL) => url.pathname === preparePath;
      const lose = async (route: Route) => {
        const request = route.request(), input = PrepareAgentNativeV4ItemSchema.parse(request.postDataJSON()), original = input.completion?.original;
        expect(request.method()).toBe("POST"); expect(input.requestId).toBe(seed.parentRequest.requestId); expect(input.proposalChecksum).toBe(seed.proposal.proposalChecksum);
        if (!original || original.kind !== "shipment_create") throw new Error("actual_original_shipment_prepare_required");
        expect(original.targetId).toBe(seed.order.orderId); expect(original.requestId).toBe(seed.proposal.itemId); expect(original.input.idempotencyKey).toBe(seed.proposal.itemId);
        expect(original.input.packages.map(pkg => ({ packageReferenceId: pkg.packageReferenceId, lines: pkg.lines.map(line => ({ orderLineId: line.orderLineId, quantity: line.quantity })) }))).toEqual(seed.packages);
        const response = await route.fetch(); expect(response.status()).toBe(201); const receipt = AgentNativeV4ItemReceiptSchema.parse(await response.json());
        expect(receipt.disposition).toBe("known"); intent = Id.parse(receipt.fulfillmentIntentId); seen.loss(request); lost.release(); await route.abort("failed");
      };
      const beforePrepare = Business.parse(await owner.request({ operation: "business" })); proof.businessBeforePrepare = beforePrepare;
      const uiChanges = changes(beforeUI, beforePrepare), protectedKey = "order_work_items_without_search_projection"; proof.businessChangesDuringUI = uiChanges;
      proof.readProjectionAllowance = { table: "order_work_items", columns: ["search_revision", "search_specification_version_id", "search_design_executor"],
        phase: "beforeUI_to_beforePrepare_only", protectedKey, source: "OrderWorkspaceService.refreshSearchProjection" };
      expect(uiChanges.map(row => row.table)).toEqual(uiChanges.length ? ["order_work_items"] : []);
      if (!beforePrepare.order_work_items || !beforeUI.order_work_items || !beforePrepare[protectedKey] || !beforeUI[protectedKey]) throw new Error("actual_original_work_projection_missing");
      expect(beforePrepare.order_work_items.count).toBe(beforeUI.order_work_items.count); expect(digest(beforePrepare[protectedKey])).toBe(digest(beforeUI[protectedKey]));
      await page.route(matchPrepare, lose);
      await seen.control("actual_prepare201_response_lost", async () => {
        await form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }).click(); await bounded(lost.promise, "actual_prepare201_missing");
        await expect(page.getByText("本项准备结果尚未核对 只读取原回执 不换键或改正文重发", { exact: true })).toBeVisible();
      });
      await page.unroute(matchPrepare, lose); if (!intent) throw new Error("actual_fixed_shipment_intent_missing");
      const staged: ShipmentCreateBrowserState = State.parse(await owner.request({ operation: "state" })); proof.prepared = staged;
      expect(staged.item.fulfillmentIntentId).toBe(intent); expect(staged.original?.viewStatus).toBe("prepared"); expect(staged.shipment).toBeNull();
      expect(digest(Business.parse(await owner.request({ operation: "business" })))).toBe(digest(beforePrepare));
      if (!clear) {
        const beforeRecovery = seen.rows.length;
        await seen.control("reload_and_exact_item_GET_only_recovery", async () => {
          await page.reload(); const handoff = page.getByRole("region", { name: "模型履约提案补项", exact: true }); await expect(handoff).toHaveAttribute("aria-busy", "false");
          await handoff.getByRole("button", { name: "只读取本项原准备回执", exact: true }).click();
          await expect(page.getByRole("dialog", { name: "核对原履约操作", exact: true })).toBeVisible();
          if (await page.getByRole("region", { name: "业务资源读取", exact: true }).count()) await seen.metadataDom();
        });
        expect(seen.rows.slice(beforeRecovery).filter(row => row.path.startsWith(nativePath + "/") || row.path.startsWith(afcPath + "/")).every(row => row.method === "GET")).toBe(true);
        expect(new URL(page.url()).searchParams.get("agentFulfillmentCommand")).toBe(intent);
        const drawer = page.getByRole("dialog", { name: "核对原履约操作", exact: true }), review = drawer.getByRole("region", { name: "核对 Agent 原履约操作", exact: true });
        await expect(review).toHaveAttribute("aria-busy", "false");
        const checkbox = drawer.getByRole("checkbox", { name: "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约", exact: true }); await expect(checkbox).not.toBeChecked();
        await expect(drawer.getByRole("region", { name: "完整原履约填写核对", exact: true })).toContainText("SYNTHETIC-PARTIAL-1");
        await seen.control("responsive_same_original_AFC_drawer", async () => { proof.drawerImages = await widths(page, info, "partial-prepared-drawer", {
          from: drawer.getByRole("button", { name: "重新读取原履约操作", exact: true }), to: checkbox }); });
        await seen.control("explicit_original_confirmation_only_once", async () => {
          await checkbox.check(); const result = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${afcPath}/requests/${intent}/confirm`);
          await drawer.getByRole("button", { name: "确认执行这笔原履约", exact: true }).click(); const response = await result; expect(response.status()).toBe(200);
          const input = ConfirmAgentFulfillmentCommandSchema.parse(response.request().postDataJSON()); expect(input.orderId).toBe(seed.order.orderId); expect(input.requestId).toBe(seed.proposal.itemId);
          const confirmed = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(confirmed.native.id).toBe(intent); expect(confirmed.native.status).toBe("succeeded");
          proof.receipt = Receipt.parse(confirmed.native.receipt); await expect(drawer.getByText("已取得原业务回执", { exact: true })).toBeVisible(); await expect(review).toHaveAttribute("aria-busy", "false");
        });
        const completed: ShipmentCreateBrowserState = State.parse(await owner.request({ operation: "state" })); proof.completed = completed;
        const actual = completed.shipment; if (!actual) throw new Error("actual_partial_shipment_missing");
        expect(actual.status).toBe("draft"); expect(actual.wholeOrder).toBe(false); expect(actual.approvedVersionNumber).toBeNull(); expect(actual.packages.length).toBe(2); expect(actual.packageLines.length).toBe(3);
        expect(actual.packageLines.filter(row => row.orderLineId === seed.groups.aGood.lineId).reduce((total, row) => total + row.quantity, 0)).toBe(2);
        expect(actual.packageLines.filter(row => row.orderLineId === seed.groups.bGood.lineId).reduce((total, row) => total + row.quantity, 0)).toBe(1);
        expect(actual.productionAllocations.length).toBe(3); expect(actual.productionAllocations.some(row => row.qualityGroupId === seed.groups.aHeld.qualityGroupId)).toBe(false);
        for (const group of [seed.groups.aGood, seed.groups.bGood]) expect(actual.productionAllocations.filter(row => row.qualityGroupId === group.qualityGroupId)
          .every(row => row.productionVersionId === group.productionVersionId && row.qualityInspectionId === group.qualityInspectionId && row.productionProjectionVersion === group.productionProjectionVersion)).toBe(true);
        expect(actual.reviewCount + actual.trackingCount + actual.writebackCount + actual.manualConfirmationCount).toBe(0); expect(actual.physicalHandover.allDispatched).toBe(false);
        const after = Business.parse(await owner.request({ operation: "business" }));
        expect(after.shipments.count - beforePrepare.shipments.count).toBe(1); expect(after.shipment_packages.count - beforePrepare.shipment_packages.count).toBe(2);
        expect(after.shipment_package_lines.count - beforePrepare.shipment_package_lines.count).toBe(3);
        const stable = digest(after); await seen.control("responsive_draft_receipt", async () => { proof.images = await widths(page, info, "partial-draft-receipt"); });
        expect(digest(Business.parse(await owner.request({ operation: "business" })))).toBe(stable);
      } else {
        const path = `/api/order-centers/orders/${seed.order.orderId}/shipment-create-workspace`, held = latch(), release = latch(), delivered = latch(), logout = latch(), finishLogout = latch();
        releases.push(release.release, finishLogout.release); let heldRequest: BrowserRequest | undefined;
        await page.route(url => url.pathname === path, async route => {
          expect(route.request().method()).toBe("GET"); expect(new URL(route.request().url()).search).toBe(""); heldRequest = route.request();
          const response = await route.fetch(); expect(response.status()).toBe(200); const actual = ShipmentCreateWorkspaceSchema.parse(await response.json());
          expect(actual.orderId).toBe(seed.order.orderId); expect(actual.canCreate).toBe(true); expect(actual.contextAuthority).toBe(erpSessionAuthority(context)); held.release();
          await release.promise; try { await route.fulfill({ response }); } catch { await expect.poll(() => route.request().failure()?.errorText).toBe("net::ERR_ABORTED"); } finally { delivered.release(); }
        });
        await page.route(url => url.pathname === "/api/erp-auth/logout", async route => { const response = await route.fetch(); expect(response.ok()).toBe(true); logout.release(); await finishLogout.promise; await route.fulfill({ response }); });
        await seen.control("actual_CLEAR_of_original_packing_form", async () => {
          await page.getByRole("button", { name: "重新读取本单装箱依据", exact: true }).click(); await bounded(held.promise, "actual_held_workspace_missing");
          expect(await markers(page)).toBeGreaterThan(0);
          // The original order drawer may use showModal and make the sidebar
          // inert. Activate only its original React logout handler; this is
          // explicitly not a physical pointer gesture acceptance claim.
          await page.getByRole("button", { name: "退出登录", exact: true }).evaluate(element => {
            if (!(element instanceof HTMLButtonElement)) throw new Error("actual_original_logout_button_required"); element.click();
          }); await bounded(logout.promise, "actual_logout_missing");
          await expect(page.getByRole("form", { name: "按包裹创建发货草稿", exact: true })).toHaveCount(0);
          await expect(page.getByRole("checkbox", { name: "已按实物核对全部装箱批次 生产版本 合格记录和数量", exact: true })).toHaveCount(0);
          expect(await markers(page)).toBe(0); await seen.sample(); release.release(); await bounded(delivered.promise, "actual_old_workspace_not_released");
          await expect(page.getByRole("form", { name: "按包裹创建发货草稿", exact: true })).toHaveCount(0); expect(await markers(page)).toBe(0); seen.setCleared();
          const raw = seen.rows.find(row => row.request === heldRequest); if (!raw) throw new Error("held_original_request_missing");
          await expect.poll(async () => { await seen.sample(); const audit = seen.pair(raw); return !!audit && audit.fetchError === "AbortError" && audit.signalAbortAt !== null && !audit.bytes && !audit.reads && audit.eofAt === null && audit.jsonAt === null; }).toBe(true);
          proof.clear = { activation: "programmatic_original_logout_handler_due_to_modal", heldOrdinal: raw.ordinal, originalHTTP200: true, oldConsumer: seen.pair(raw),
            privatePackingFieldsAbsent: true, physicalChecksAbsent: true, bothV4MarkerIndexesEmpty: true, cancellationIsNotEOFOrSuccess: true };
          proof.images = await widths(page, info, "partial-real-CLEAR"); finishLogout.release(); await page.waitForURL("**/login");
        });
        expect(digest(Business.parse(await owner.request({ operation: "business" })))).toBe(digest(beforePrepare));
      }
      expect(seen.rows.filter(row => row.path === preparePath && row.method === "POST").length).toBe(1);
      expect(seen.rows.filter(row => row.path === `${afcPath}/requests/${intent}/confirm` && row.method === "POST").length).toBe(clear ? 0 : 1);
      const final: ShipmentCreateBrowserState = State.parse(await owner.request({ operation: "state" })); proof.final = final;
      expect(digest(final.counters)).toBe(digest(seed.counters)); if (clear) expect(final.shipment).toBeNull();
    } catch (error) { proof.primaryFailure = true; failures.push(error); }
    finally {
      for (const release of releases) release();
      try { await seen.sample(); proof.pairings = seen.check(intent); } catch (error) { proof.networkFailed = true; failures.push(error); }
      try { await owner.close(); } catch (error) { proof.cleanupFailed = true; failures.push(error); }
      proof.child = owner.evidence; proof.network = seen.snapshot();
      const path = info.outputPath("shipment-create-proof.json"); await writeFile(path, JSON.stringify(proof, null, 2) + "\n"); await info.attach("shipment-create-proof", { path, contentType: "application/json" });
    }
    if (failures.length) throw new AggregateError(failures, "actual_partial_shipment_personal_acceptance_failed");
  });
});
