import { expect, test, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AgentResourceCandidatesQuerySchema, AgentResourceDefinitionRequestSchema, AGENT_RESOURCES_VERSION } from "@yummyai/contracts/ai/agent-resources";
import { AgentToolDefinitionRequestSchema, AGENT_TOOLS_VERSION } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AgentFulfillmentCommandIntentSchema, AgentFulfillmentCommandReceiptSchema,
  AgentFulfillmentCommandViewSchema, PrepareAgentFulfillmentCommandSchema, ConfirmAgentFulfillmentCommandSchema,
  CancelAgentFulfillmentCommandSchema, AcknowledgeAgentFulfillmentCommandSchema, AgentFulfillmentCommandGetQuerySchema, AgentFulfillmentCommandListQuerySchema,
  canonicalAgentFulfillmentOriginal, type AgentFulfillmentCommandView } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { connectDatabase, memberships, membershipRoles, roles, withTenant } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireAgentFulfillmentCommandEnvironment } from "../../../tools/testing/require-agent-fulfillment-command-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireAgentFulfillmentCommandEnvironment(process.env, true), root = fileURLToPath(new URL("../../../", import.meta.url));
const prefix = "/api/agent-fulfillment-commands", intentPrefix = "yummyai.agent-fulfillment-command.intent.v1:";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const review = (page: Page) => page.getByRole("region", { name: "核对 Agent 原履约操作", exact: true });
const Seed = z.object({ type: z.literal("agent.fulfillment.command.browser.seeded"), nonce: z.string().regex(/^[a-f0-9]{32}$/),
  mode: z.enum(["shipment", "delivery"]), orderId: z.uuidv7(), lineId: z.uuidv7(), productionId: z.uuidv7(), packageId: z.uuidv7(),
  shipmentId: z.uuidv7().nullable(), orderNumber: z.string().min(1), resourcesClosed: z.literal(true), modelCalls: z.literal(0), workerProcesses: z.literal(0) }).strict();
type Source = z.infer<typeof Seed>;
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(promise: Promise<T>, message: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function seed(mode: Source["mode"]) {
  const child = spawn(process.execPath, ["--import", new URL("../../api/node_modules/tsx/dist/loader.mjs", import.meta.url).href,
    resolve(root, "tools/testing/agent-fulfillment-command-browser.mts"), mode], { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
  const evidence = { pid: child.pid ?? null, exited: false, exitCode: null as number | null, signal: null as string | null, forced: false, resourcesClosed: false,
    startupCode: null as string | null, startupType: null as string | null };
  let accept!: (value: Source) => void, reject!: (error: Error) => void, received = false;
  const packet = new Promise<Source>((done, fail) => { accept = done; reject = fail; });
  child.stderr?.on("data", (bytes: Buffer) => { const value = bytes.toString("utf8");
    evidence.startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED)\b/.exec(value)?.[1] ?? null;
    evidence.startupType ??= /\b(SyntaxError|TypeError|TransformError|ReferenceError)\b/.exec(value)?.[1] ?? null; });
  child.on("message", (raw: unknown) => {
    const parsed = Seed.safeParse(raw);
    if (parsed.success && !received && parsed.data.nonce === isolated.nonce && parsed.data.mode === mode) {
      received = true; evidence.resourcesClosed = true; accept(parsed.data); return;
    }
    const failed = z.object({ type: z.literal("agent.fulfillment.command.browser.failed"), phase: z.string().regex(/^[a-z_]{1,64}$/),
      errorName: z.string().regex(/^[A-Za-z]{1,64}$/), code: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable() }).strict().safeParse(raw);
    reject(new Error(failed.success ? JSON.stringify(failed.data) : "agent_fulfillment_seed_protocol_invalid"));
  });
  child.once("error", () => reject(new Error("agent_fulfillment_seed_spawn_failed")));
  const ended = new Promise<void>(done => child.once("close", (code, signal) => { evidence.exited = true; evidence.exitCode = code; evidence.signal = signal;
    if (!received) reject(new Error("agent_fulfillment_seed_early_exit")); done(); }));
  let primary: unknown, source: Source | undefined;
  try { source = await bounded(packet, "agent_fulfillment_seed_timeout", 180_000); await bounded(ended, "agent_fulfillment_seed_close_timeout", 15_000); }
  catch (error) { primary = error; }
  if (!evidence.exited) { evidence.forced = true; child.kill("SIGKILL"); await bounded(ended, "agent_fulfillment_seed_forced_close_timeout", 10_000); }
  if (primary) throw primary;
  if (!source || evidence.forced || evidence.exitCode !== 0 || evidence.signal || !evidence.resourcesClosed) throw new Error("agent_fulfillment_seed_not_normally_closed");
  return { source, evidence };
}
async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const value = ErpSessionViewSchema.parse(await response.json()), actor = actors().operator;
  expect(value.userId).toBe(actor.userId); expect(value.tenantId).toBe(actor.tenantId); expect(value.authenticated).toBe(true); return value;
}
function facts(context: TenantContext) {
  const database = connectDatabase(isolated.url); let closed = false, restored = true;
  let restore: (() => Promise<void>) | undefined;
  async function snapshot() {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, { count: number; sha256: string }> = {};
      for (const name of ["orders", "order_lines", "order_events", "production_orders", "production_order_versions", "production_milestone_events",
        "production_delivery_packages", "production_delivery_items", "production_delivery_feedback", "quality_inspections", "quality_inspection_groups",
        "shipments", "shipment_versions", "shipment_packages", "shipment_package_lines", "shipment_production_allocations", "shipment_version_reviews",
        "shipment_tracking_events", "shipment_manual_confirmations"]) {
        const [value] = await tx.execute<{ count: number; text: string }>(sql`select count(*)::int as count,
          coalesce(string_agg(row_to_json(r)::text,E'\n' order by row_to_json(r)::text),'') as text from ${sql.identifier(name)} r`);
        if (!value) throw new Error("agent_fulfillment_original_projection_missing"); result[name] = { count: value.count, sha256: sha(value.text) };
      }
      return result;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function withdrawRun() {
    const actor = actors().operator;
    const prior = await withTenant(database.db, context, async tx => {
      const links = await tx.select({ id: membershipRoles.roleId }).from(membershipRoles).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(and(eq(memberships.id, actor.membershipId), eq(memberships.userId, actor.userId), eq(memberships.status, "active")));
      if (links.length !== 1 || links[0]?.id !== actor.roleId) throw new Error("agent_fulfillment_exact_operator_role_required");
      const [row] = await tx.select({ permissions: roles.permissions, scope: roles.dataScope }).from(roles).where(eq(roles.id, actor.roleId)).for("update");
      if (!row?.permissions.includes(Permission.WorkflowRun)) throw new Error("agent_fulfillment_original_run_bit_required");
      const scope = z.enum(["self", "team", "tenant"]).parse(row.scope), changed = row.permissions.filter(bit => bit !== Permission.WorkflowRun);
      const updated = await tx.update(roles).set({ permissions: changed }).where(and(eq(roles.id, actor.roleId), eq(roles.dataScope, scope),
        sql`${roles.permissions}=${JSON.stringify(row.permissions)}::jsonb`)).returning({ id: roles.id });
      if (updated.length !== 1) throw new Error("agent_fulfillment_withdraw_run_CAS_failed"); return { ...row, scope, changed };
    });
    restored = false; restore = async () => {
      if (restored) return;
      const updated = await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: prior.permissions, dataScope: prior.scope }).where(and(
        eq(roles.id, actor.roleId), eq(roles.dataScope, prior.scope), sql`${roles.permissions}=${JSON.stringify(prior.changed)}::jsonb`)).returning({ id: roles.id }));
      if (updated.length !== 1) throw new Error("agent_fulfillment_restore_run_CAS_failed"); restored = true;
    };
  }
  return { snapshot, withdrawRun, restore: async () => { await restore?.(); }, get restored() { return restored; }, get closed() { return closed; },
    close: async () => { const failures: unknown[] = []; try { await restore?.(); } catch (error) { failures.push(error); }
      try { if (!closed) { await database.client.end(); closed = true; } } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "agent_fulfillment_browser_facts_close_failed"); } };
}

const AuditSchema = z.object({ key: z.string().max(100), document: z.uuid(), method: z.enum(["GET", "POST", "HEAD"]),
  urlHash: z.string().regex(/^[a-f0-9]{64}$/), bodyHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), authority: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  startedAt: z.number().finite(), status: z.int().min(100).max(599).nullable(), echo: z.string().regex(/^[a-f0-9]{64}$/).nullable(), resolvedAt: z.number().finite().nullable(),
  bytes: z.int().nonnegative(), reads: z.int().nonnegative(), readerEOF: z.number().finite().nullable(), jsonResolved: z.number().finite().nullable(),
  cancelledAt: z.number().finite().nullable(), abortedAtComplete: z.boolean(), signalAbort: z.number().finite().nullable(),
  error: z.enum(["AbortError", "TypeError", "SyntaxError", "Other"]).nullable(), definitionChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
type Audit = z.infer<typeof AuditSchema>;
type Row = { request: Request; ordinal: number; generation: number; path: string; method: string; urlHash: string; bodyHash: string | null;
  authority: string | null; echo: string | null; at: number; terminalAt: number | null; status: number | null; finished: boolean; failed: boolean;
  aborted: boolean; prefetch: boolean; rsc: boolean; resource: string; classification: string | null };
type PersonalObservation = { generation: number; document: string; at: number; authority: string; locationHash: string; workflowRun: boolean };
type RecoveryNavigation = { control: string; start: number; observedAt: number; clickAt: number; end: number | null;
  href: string; hrefHash: string; before: PersonalObservation; after: PersonalObservation | null };
type AuthorityTransition = { kind: "withdraw" | "restore"; control: string; start: number; focusAt: number | null; end: number | null;
  before: PersonalObservation; after: PersonalObservation | null; runtimeNotChecked: boolean };
declare global { interface Window { __afcAudit?: (value: unknown) => Promise<void>; __afcDocument?: string;
  __afcRecoveryLinkDOM?: Array<{ document: string; at: number; href: string }>; __afcRecoveryLinkObserver?: MutationObserver } }
const mountReads = [
  { path: "/api/agent-resources/definition", input: AgentResourceDefinitionRequestSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence" }) },
  { path: "/api/agent-tools/definition", input: AgentToolDefinitionRequestSchema.parse({ version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: "knowledge.search" } }) },
  { path: "/api/agent-resources/candidates", input: AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", q: "" }) },
];
async function observe(page: Page, source: Source) {
  const rows: Row[] = [], audits = new Map<string, Audit>(), controls: Array<{ name: string; start: number; end: number | null }> = [];
  const sessions: PersonalObservation[] = [], links: Array<{ generation: number; document: string; at: number; hash: string; requestHash: string;
    basis?: "controlled_original_recovery_link_DOM" }> = [];
  const recoveryNavigations: RecoveryNavigation[] = [], navigationPairings: Array<Record<string, unknown>> = [];
  const detailPairings: Array<Record<string, unknown>> = [], listStability: Array<Record<string, unknown>> = [];
  const authorityChecks: Array<{ at: number; authority: string; workflowRun: boolean }> = [], authorityTransitions: AuthorityTransition[] = [];
  const deliveryPairs = new Map<number, Record<string, unknown>>(), deliveryCancellations: Array<Record<string, unknown>> = [], deliveryRsc: Array<Record<string, unknown>> = [];
  const deliverySettled: Array<Record<string, unknown>> = [];
  const definitions: Array<{ generation: number; authority: string; kind: string; checksum: string; queryEmpty: boolean }> = [];
  const errors: Array<{ kind: string; at: number; hash: string; expectedNetwork: boolean }> = [];
  const special = new Map<Request, string>(), documents = new Map<Request, { generation: number; finished: boolean; status: number | null }>();
  const originals = new Map<string, { orderId: string; requestId: string; requestChecksum: string; originalChecksum: string | null }>();
  let generation = 0;
  await page.exposeBinding("__afcAudit", (_source, raw: unknown) => {
    const value = AuditSchema.safeParse(raw);
    if (!value.success) { errors.push({ kind: "invalid_passive_audit", at: Date.now(), hash: sha("invalid_finite_audit"), expectedNetwork: false }); return; }
    audits.set(value.data.key, value.data);
  });
  await page.addInitScript(({ metadata }) => {
    const originalFetch = window.fetch.bind(window), documentKey = crypto.randomUUID(); let sequence = 0;
    window.__afcDocument = documentKey;
    const now = () => performance.timeOrigin + performance.now();
    const hash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, "0")).join("");
    window.fetch = function (this: Window, ...args: Parameters<typeof window.fetch>) {
      const [input, options] = args;
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return originalFetch(input, options);
      const authority = new Headers(options?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-yummyai-context-authority");
      const method = (options?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(), signal = options?.signal ?? (input instanceof Request ? input.signal : undefined);
      const record = { key: `${documentKey}:${++sequence}`, document: documentKey, method, urlHash: "", bodyHash: null as string | null, authority: null as string | null, startedAt: now(),
        status: null as number | null, echo: null as string | null, resolvedAt: null as number | null, bytes: 0, reads: 0,
        readerEOF: null as number | null, jsonResolved: null as number | null, cancelledAt: null as number | null, abortedAtComplete: false,
        signalAbort: null as number | null, error: null as Audit["error"], definitionChecksum: null as string | null };
      const definition = method === "POST" && !url.search && metadata.some(value => value.path === url.pathname && value.body === options?.body);
      const decoder = new TextDecoder(); let metadataText = "", metadataBytes = 0;
      const pin = (value: unknown) => {
        if (definition && value && typeof value === "object" && "definitionChecksum" in value && typeof value.definitionChecksum === "string"
          && /^[a-f0-9]{64}$/.test(value.definitionChecksum)) record.definitionChecksum = value.definitionChecksum;
      };
      const identity = Promise.all([hash(url.href), typeof options?.body === "string" ? hash(options.body) : Promise.resolve(null), authority ? hash(authority) : Promise.resolve(null)])
        .then(([urlHash, bodyHash, stamp]) => { record.urlHash = urlHash!; record.bodyHash = bodyHash; record.authority = stamp; });
      const publish = () => { void identity.then(() => window.__afcAudit?.({ ...record })).catch(() => {}); };
      const errorName = (error: unknown): Audit["error"] => error instanceof Error && ["AbortError", "TypeError", "SyntaxError"].includes(error.name) ? error.name === "AbortError" ? "AbortError" : error.name === "TypeError" ? "TypeError" : "SyntaxError" : "Other";
      signal?.addEventListener("abort", () => { record.signalAbort ??= now(); publish(); }, { once: true }); publish();
      // Attach observations without replacing the fetch/read promises, signals,
      // returned Response, stream or reader. No clone/tee/replay/extra read.
      const pending = Reflect.apply(originalFetch, this, args) as Promise<Response>;
      void pending.then(response => {
        record.status = response.status; record.resolvedAt = now();
        const echo = response.headers.get("x-yummyai-context-authority"); if (echo) void hash(echo).then(value => { record.echo = value; publish(); }); publish();
        const json = response.json; response.json = function (...parameters) {
          const original = Reflect.apply(json, this, parameters) as Promise<unknown>;
          void original.then(value => { record.jsonResolved = now(); record.abortedAtComplete = signal?.aborted === true;
            pin(value);
            publish(); }, error => { record.error = errorName(error); publish(); }); return original;
        };
        if (response.body) {
          const getReader = response.body.getReader;
          response.body.getReader = function (this: ReadableStream<Uint8Array>, ...parameters: Parameters<typeof getReader>) {
            const reader = Reflect.apply(getReader, this, parameters) as ReadableStreamDefaultReader<Uint8Array>, read = reader.read, cancel = reader.cancel;
            reader.read = function (...input) {
              const original = Reflect.apply(read, this, input) as Promise<ReadableStreamReadResult<Uint8Array>>;
              void original.then(value => { record.reads++;
                if (value.done) { record.readerEOF = now(); record.abortedAtComplete = signal?.aborted === true;
                  if (definition && metadataBytes <= 1_048_576) { try { pin(JSON.parse(metadataText + decoder.decode())); } catch { record.error = "SyntaxError"; } metadataText = ""; }
                } else { record.bytes += value.value.byteLength;
                  if (definition) { metadataBytes += value.value.byteLength; if (metadataBytes <= 1_048_576) metadataText += decoder.decode(value.value, { stream: true }); else metadataText = ""; }
                }
                publish(); }, error => { record.error = errorName(error); publish(); }); return original;
            };
            reader.cancel = function (...input) { record.cancelledAt = now(); publish(); return Reflect.apply(cancel, this, input); }; return reader;
          } as typeof getReader;
        }
      }, error => { record.error = errorName(error); publish(); }).catch(() => { record.error = "Other"; publish(); }); return pending;
    };
  }, { metadata: mountReads.map(value => ({ path: value.path, body: JSON.stringify(value.input) })) });
  page.on("request", request => {
    const url = new URL(request.url()); if (!["localhost", "127.0.0.1"].includes(url.hostname)) return;
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) {
      generation++; documents.set(request, { generation, finished: false, status: null });
    }
    const headers = request.headers(), raw = request.postData();
    rows.push({ request, ordinal: rows.length + 1, generation, path: url.pathname, method: request.method(), urlHash: sha(url.href), bodyHash: raw === null ? null : sha(raw),
      authority: headers["x-yummyai-context-authority"] ? sha(headers["x-yummyai-context-authority"]) : null, echo: null, at: Date.now(), terminalAt: null,
      status: null, finished: false, failed: false, aborted: false, prefetch: headers["next-router-prefetch"] === "1" || headers.purpose === "prefetch", rsc: headers.rsc === "1",
      resource: request.resourceType(), classification: null });
  });
  page.on("response", response => { const row = rows.find(value => value.request === response.request()); if (row) { row.status = response.status(); const echo = response.headers()["x-yummyai-context-authority"]; row.echo = echo ? sha(echo) : null; }
    const document = documents.get(response.request()); if (document) document.status = response.status(); });
  page.on("requestfinished", request => { const row = rows.find(value => value.request === request); if (row) { row.finished = true; row.terminalAt = Date.now(); }
    const document = documents.get(request); if (document) document.finished = true; });
  page.on("requestfailed", request => { const row = rows.find(value => value.request === request); if (row) { row.failed = true; row.aborted = request.failure()?.errorText === "net::ERR_ABORTED"; row.terminalAt = Date.now(); } });
  page.on("pageerror", error => errors.push({ kind: "pageerror", at: Date.now(), hash: sha(error.message), expectedNetwork: false }));
  page.on("console", value => { if (value.type() === "error") errors.push({ kind: "console", at: Date.now(), hash: sha(value.text()),
    expectedNetwork: /^Failed to load resource: net::ERR_(?:FAILED|ABORTED)$/.test(value.text()) }); });
  async function current() {
    const beforeDocument = await page.evaluate(() => window.__afcDocument ?? null);
    const value = await session(page), authority = sha(erpSessionAuthority(value));
    const sampled = await page.locator("a[href]").evaluateAll(elements => ({ document: window.__afcDocument ?? null, location: location.href,
      hrefs: elements.map(element => element.getAttribute("href")).filter((value): value is string => value !== null), recoveryLinks: window.__afcRecoveryLinkDOM ?? [] }));
    if (beforeDocument !== sampled.document) throw new Error("agent_fulfillment_current_document_changed");
    const document = z.uuid().parse(sampled.document), at = Date.now();
    sessions.push({ generation, document, at, authority, locationHash: sha(sampled.location), workflowRun: value.permissions.includes(Permission.WorkflowRun) });
    for (const href of sampled.hrefs) { const url = new URL(href, sampled.location); if (url.origin === new URL(sampled.location).origin) {
      const hash = sha(url.href); url.hash = ""; links.push({ generation, document, at, hash, requestHash: sha(url.href) });
    } }
    if (source.mode === "delivery") for (const observed of sampled.recoveryLinks) {
      const url = new URL(observed.href, sampled.location), keys = [...url.searchParams.keys()];
      if (observed.document !== document || url.origin !== new URL(sampled.location).origin || url.pathname !== "/ai-tasks" || url.hash
        || keys.length !== 3 || new Set(keys).size !== 3 || url.searchParams.get("order") !== source.orderId || url.searchParams.get("line") !== source.lineId
        || url.searchParams.get("delivery") !== source.packageId || !controls.some(value => value.name === "original_delivery_prepare_only"
          && observed.at >= value.start && (value.end === null || observed.at <= value.end))) continue;
      const hash = sha(url.href);
      if (!links.some(value => value.document === document && value.at === observed.at && value.hash === hash))
        links.push({ generation, document, at: observed.at, hash, requestHash: hash, basis: "controlled_original_recovery_link_DOM" });
    }
    for (const [kind, name, title] of [["resource", "业务资源读取", "所选业务资源定义"], ["tool", "原生工具与命令目录", "所选严格工具定义"]] as const) {
      const area = page.getByRole("region", { name, exact: true }), definition = area.getByRole("region", { name: title, exact: true });
      const code = definition.locator("details").filter({ has: page.getByText("固定定义校验值", { exact: true }) }).locator("code");
      const chosen = area.locator('button[aria-pressed="true"]').filter({ hasText: kind === "resource" ? "research.evidence" : "knowledge.search" });
      if (await code.count() === 1 && await chosen.count() === 1) {
        const checksum = (await code.textContent())?.trim();
        if (checksum && /^[a-f0-9]{64}$/.test(checksum)) {
          const candidate = area.getByRole("region", { name: "原业务对象候选", exact: true }), query = area.getByRole("textbox", { name: "搜索原业务对象", exact: true });
          const choice = candidate.getByRole("combobox", { name: "选择原业务对象", exact: true });
          const accepted = candidate.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/);
          definitions.push({ generation, authority, kind, checksum, queryEmpty: kind === "resource" && await query.count() === 1 && await choice.count() === 1
            && await query.inputValue() === "" && await choice.inputValue() === "" && await candidate.getAttribute("aria-busy") === "false" && await accepted.count() === 1 });
        }
      }
    }
    return value;
  }
  function pair(row: Row) {
    const time = row.request.timing(); if (!(time.startTime > 0)) return null;
    const candidates = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
      && value.authority === row.authority && Math.abs(value.startedAt - time.startTime) <= 5);
    if (candidates.length !== 1) return null; const audit = candidates[0]!;
    if (rows.filter(other => other.method === row.method && other.urlHash === row.urlHash && other.bodyHash === row.bodyHash && other.authority === row.authority
      && other.request.timing().startTime > 0 && Math.abs(other.request.timing().startTime - audit.startedAt) <= 5).length !== 1) return null;
    return audit;
  }
  const complete = (value: Audit | null) => value !== null && (value.readerEOF !== null || value.jsonResolved !== null) && value.cancelledAt === null && !value.abortedAtComplete && value.error === null;
  async function control<T>(name: string, action: () => Promise<T>) {
    const window = { name, start: Date.now(), end: null as number | null }; controls.push(window);
    try { const value = await action(); await current(); return value; } finally { window.end = Date.now(); }
  }
  async function openRecoveryLink(link: Locator) {
    await current(); const before = sessions.at(-1);
    const active = controls.filter(value => value.name === "reload_and_original_receipt_GET_only" && value.end === null);
    const from = new URL(page.url()), literal = await link.getAttribute("href");
    if (!before || active.length !== 1 || literal === null) throw new Error("agent_fulfillment_original_recovery_link_missing");
    const target = new URL(literal, from);
    const originalQuery = (url: URL) => [...url.searchParams.keys()].length === 2 && url.searchParams.getAll("order").length === 1
      && url.searchParams.getAll("line").length === 1 && url.searchParams.get("order") === source.orderId && url.searchParams.get("line") === source.lineId;
    if (source.mode !== "shipment" || from.pathname !== "/shipments" || !originalQuery(from) || target.origin !== from.origin
      || target.pathname !== "/ai-tasks" || target.hash || !originalQuery(target) || before.locationHash !== sha(from.href))
      throw new Error("agent_fulfillment_original_recovery_link_mismatch");
    const observedAt = Date.now(), navigation: RecoveryNavigation = { control: active[0]!.name, start: active[0]!.start, observedAt,
      clickAt: Date.now(), end: null, href: target.href, hrefHash: sha(target.href), before, after: null };
    recoveryNavigations.push(navigation);
    try {
      await link.click(); await expect(page).toHaveURL(target.href);
      await expect(page.getByRole("region", { name: "本人原履约准备恢复", exact: true })).toBeVisible();
      await current(); navigation.after = sessions.at(-1) ?? null;
    } finally { navigation.end = Date.now(); }
  }
  function originalNavigationCancellation(row: Row) {
    const paths = [`/api/order-centers/orders/${source.orderId}/fulfillment`, `/api/order-centers/lines/${source.lineId}/operations`];
    const url = new URL(row.request.url()), timing = row.request.timing();
    if (source.mode !== "shipment" || row.method !== "GET" || !paths.includes(row.path) || url.search || url.hash || row.bodyHash !== null
      || row.authority !== null || row.echo !== null || row.prefetch || row.rsc || row.resource !== "fetch" || !row.failed || !row.aborted
      || row.finished || row.terminalAt === null || row.status !== null && row.status !== 200) return null;
    const preHeader = row.status === null && timing.startTime === 0 && timing.requestStart === -1 && timing.responseStart === -1 && timing.responseEnd === -1;
    if (!(timing.startTime > 0) && !preHeader) return null;
    const windows = recoveryNavigations.filter(value => value.after !== null && value.end !== null && value.before.generation === row.generation
      && value.after.generation === row.generation && value.before.document === value.after.document && value.before.authority === value.after.authority
      && value.after.locationHash === value.hrefHash && row.at >= value.start && row.terminalAt! >= value.clickAt
      && row.terminalAt! <= value.end && !sessions.some(observation => observation.generation === row.generation && observation.document === value.before.document
        && observation.at >= value.before.at && observation.at <= value.after!.at && observation.authority !== value.before.authority));
    if (windows.length !== 1) return null; const navigation = windows[0]!, after = navigation.after!;
    const docs = [...documents.entries()].filter(([, value]) => value.generation === row.generation);
    if (docs.length !== 1 || !docs[0]![1].finished || docs[0]![1].status !== 200) return null;
    const document = rows.find(value => value.request === docs[0]![0]);
    if (!document?.finished || document.terminalAt === null || document.terminalAt > row.at) return null;
    const destination = rows.filter(value => value.generation === row.generation && value.method === "GET" && value.path === "/ai-tasks" && value.rsc
      && !value.prefetch && value.authority === null && value.echo === null && value.at >= navigation.clickAt && value.terminalAt !== null
      && value.terminalAt <= navigation.end! && value.status === 200 && value.finished && !value.failed && value.request.timing().responseEnd > 0
      && literalURL(value) === navigation.href);
    if (destination.length !== 1) return null;
    const destinationStartedAt = destination[0]!.request.timing().startTime;
    if (!(destinationStartedAt > 0) || row.at > destinationStartedAt) return null;
    const anchors = rows.flatMap(value => {
      if (value.generation !== row.generation || value.method !== "GET" || value.path !== `/api/order-centers/lines/${source.lineId}`
        || new URL(value.request.url()).search || value.bodyHash !== null || value.authority !== null || value.echo !== null || value.status !== 200) return [];
      const audit = pair(value), consumedAt = audit?.jsonResolved ?? audit?.readerEOF ?? null;
      return complete(audit) && audit?.document === navigation.before.document && audit.status === 200 && consumedAt !== null && consumedAt <= row.at
        ? [{ ordinal: value.ordinal, auditKey: audit.key, document: audit.document, consumedAt }] : [];
    });
    if (!anchors.length) return null;
    // Only these two original source reads may use request-event time when CDP
    // never sent headers. The real source consumer anchors the document; the
    // literal recovery Link and both actual sessions anchor leaving that page.
    // A zero-consumption cancellation is never a successful read or an EOF.
    const requestTime = timing.startTime > 0 ? timing.startTime : row.at;
    const candidates = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
      && value.authority === row.authority && value.document === navigation.before.document && Math.abs(value.startedAt - requestTime) <= 5
      && value.startedAt >= Math.max(navigation.start, document.terminalAt!) && value.startedAt <= destinationStartedAt && value.status === null && value.resolvedAt === null
      && value.echo === null && value.signalAbort !== null && value.signalAbort >= navigation.clickAt && value.signalAbort <= navigation.end!
      && value.startedAt <= value.signalAbort && value.error === "AbortError" && value.bytes === 0 && value.reads === 0 && value.readerEOF === null
      && value.jsonResolved === null && value.cancelledAt === null && !value.abortedAtComplete);
    if (candidates.length !== 1) return null; const audit = candidates[0]!;
    const reverse = rows.filter(other => {
      if (other.generation !== row.generation || other.method !== row.method || other.urlHash !== row.urlHash || other.bodyHash !== row.bodyHash || other.authority !== row.authority) return false;
      const raw = other.request.timing(), zero = other.status === null && other.failed && other.aborted && !other.finished
        && raw.startTime === 0 && raw.requestStart === -1 && raw.responseStart === -1 && raw.responseEnd === -1;
      const time = raw.startTime > 0 ? raw.startTime : zero ? other.at : null;
      return time !== null && Math.abs(time - audit.startedAt) <= 5;
    });
    if (reverse.length !== 1 || reverse[0] !== row) return null;
    return { ordinal: row.ordinal, auditKey: audit.key, basis: timing.startTime > 0 ? "positive_cdp_start" : "pre_header_request_event",
      requestTime, requestEventAt: row.at, rawTiming: { ...timing }, originalFetchStartedAt: audit.startedAt, differenceMs: requestTime - audit.startedAt,
      uniqueAuditCount: candidates.length, uniqueRequestCount: reverse.length, signalAbort: audit.signalAbort, error: audit.error,
      originalFetchStatus: audit.status, originalFetchResolvedAt: audit.resolvedAt, bytes: audit.bytes, reads: audit.reads, readerEOF: audit.readerEOF, jsonResolved: audit.jsonResolved,
      navigation: { ...navigation, after }, documentOrdinal: document.ordinal, destinationOrdinal: destination[0]!.ordinal, destinationStartedAt, anchors };
  }
  function literalURL(row: Row) {
    const url = new URL(row.request.url()), keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return null; url.searchParams.delete("_rsc"); return url.href;
  }
  function originalRead(row: Row, kind: "list" | "detail", id?: string) {
    const url = new URL(row.request.url()), keys = [...url.searchParams.keys()];
    if (row.method !== "GET" || row.bodyHash !== null || row.prefetch || row.rsc || url.hash || new Set(keys).size !== keys.length
      || row.path !== (kind === "list" ? `${prefix}/requests` : `${prefix}/requests/${id}`)) return false;
    const parsed = (kind === "list" ? AgentFulfillmentCommandListQuerySchema : AgentFulfillmentCommandGetQuerySchema).safeParse(Object.fromEntries(url.searchParams));
    return parsed.success && parsed.data.orderId === source.orderId && !("lineId" in parsed.data);
  }
  async function waitForOriginalListAfterConfirmation(id: string) {
    if (!originals.has(id)) throw new Error("agent_fulfillment_list_original_intent_missing");
    const confirmations = rows.filter(row => row.path === `${prefix}/requests/${id}/confirm` && row.method === "POST");
    if (confirmations.length !== 1) throw new Error("agent_fulfillment_list_confirmation_not_unique");
    const confirmation = confirmations[0]!; let issued: Row | undefined;
    // Observe the list read already started by the original confirm finally.
    // Waiting does not click refresh, issue a GET, or retry a failed fetch.
    await expect.poll(() => {
      const found = rows.filter(row => row.generation === confirmation.generation && row.at >= confirmation.at && originalRead(row, "list"));
      if (found.length === 1) issued = found[0]; return found.length;
    }).toBe(1);
    if (!issued) throw new Error("agent_fulfillment_confirm_background_list_missing");
    const original = issued;
    await expect.poll(() => {
      const accepted = pair(confirmation), value = pair(original), acceptedAt = accepted?.readerEOF ?? accepted?.jsonResolved ?? null;
      return confirmation.status === 200 && confirmation.authority !== null && confirmation.echo === confirmation.authority && complete(accepted)
        && accepted?.status === 200 && accepted.echo === confirmation.authority && acceptedAt !== null && original.status === 200 && original.authority === confirmation.authority
        && original.echo === original.authority && complete(value) && value?.status === 200 && value.echo === original.authority && value.readerEOF !== null
        && value.document === accepted?.document && value.startedAt >= acceptedAt && (original.finished || original.failed);
    }).toBe(true);
    const area = page.getByRole("region", { name: "本单已保存履约准备", exact: true });
    await expect(area.getByText("正在读取本单原提交", { exact: true })).toBeHidden();
    await expect(area.getByRole("button", { name: "只读核对本单原准备", exact: true })).toBeEnabled();
    const value = pair(original);
    listStability.push({ intentId: id, confirmationOrdinal: confirmation.ordinal, ordinal: original.ordinal, auditKey: value?.key,
      rawTiming: original.request.timing(), originalFetchStartedAt: value?.startedAt, readerEOF: value?.readerEOF, observedAt: Date.now(),
      status: original.status, finished: original.finished, failed: original.failed, authority: original.authority });
  }
  function anchoredDetailCancellation(row: Row) {
    const id = new RegExp(`^${prefix}/requests/([a-f0-9-]{36})$`).exec(row.path)?.[1], timing = row.request.timing();
    if (!id || !originals.has(id) || !originalRead(row, "detail", id) || row.resource !== "fetch" || row.status !== null || row.finished || !row.failed || !row.aborted
      || row.authority === null || row.echo !== null || row.terminalAt === null || timing.startTime !== 0 || timing.requestStart !== -1
      || timing.responseStart !== -1 || timing.responseEnd !== -1) return null;
    const windows = controls.filter(value => value.name === "committed_original_remount_GET_only" && value.end !== null && row.at >= value.start && row.terminalAt! <= value.end);
    if (windows.length !== 1) return null; const window = windows[0]!;
    const next = rows.filter(value => value.generation === row.generation && value.ordinal > row.ordinal && value.method === row.method && value.urlHash === row.urlHash
      && value.bodyHash === row.bodyHash && value.authority === row.authority).sort((a, b) => a.ordinal - b.ordinal)[0];
    if (!next || !originalRead(next, "detail", id) || next.status !== 200 || !next.finished || next.failed || next.echo !== row.authority
      || next.terminalAt === null || next.terminalAt > window.end!) return null;
    const successor = pair(next);
    if (!complete(successor) || successor?.status !== 200 || successor.echo !== row.authority || successor.authority !== row.authority || successor.readerEOF === null) return null;
    const previous = rows.filter(value => value.generation === row.generation && value.ordinal < row.ordinal && value.method === "GET" && value.path.startsWith(prefix + "/")).at(-1);
    if (!previous || !originalRead(previous, "list") || previous.status !== 200 || !previous.finished || previous.failed || previous.authority !== row.authority
      || previous.echo !== row.authority || previous.at < window.start || previous.at > row.at) return null;
    const preceding = pair(previous);
    if (!complete(preceding) || preceding?.status !== 200 || preceding.echo !== row.authority || preceding.authority !== row.authority
      || preceding.document !== successor.document || preceding.readerEOF === null) return null;
    const before = sessions.filter(value => value.at <= window.start).at(-1),
      after = sessions.find(value => value.generation === row.generation && value.document === successor.document && value.at >= successor.readerEOF! && value.at <= window.end!);
    if (!before || !after || before.authority !== row.authority || after.authority !== row.authority || before.locationHash !== after.locationHash
      || sessions.some(value => value.at >= before.at && value.at <= after.at && value.authority !== row.authority)) return null;
    const docs = [...documents.entries()].filter(([, value]) => value.generation === row.generation);
    if (docs.length !== 1 || !docs[0]![1].finished || docs[0]![1].status !== 200) return null;
    const document = rows.find(value => value.request === docs[0]![0]);
    if (!document || document.at < window.start || document.urlHash !== before.locationHash || document.terminalAt === null || document.terminalAt > row.at) return null;
    const sequence = (value: Audit) => {
      const raw = value.key.startsWith(value.document + ":") ? value.key.slice(value.document.length + 1) : "";
      return /^[1-9][0-9]*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
    };
    const firstSequence = sequence(preceding), lastSequence = sequence(successor);
    if (firstSequence === null || lastSequence === null || firstSequence >= lastSequence) return null;
    // For this registered detail only, positive-CDP pairs (still +/-5ms) bound
    // both the actual Request order and the original fetch-call order. There
    // must be exactly one intervening family read on each side. No start time
    // is invented and no global event-time tolerance is increased.
    const candidates = [...audits.values()].filter(value => {
      const call = sequence(value);
      return value.document === successor.document && value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
        && value.authority === row.authority && call !== null && call > firstSequence && call < lastSequence && value.startedAt > preceding.startedAt
        && value.startedAt < successor.startedAt && value.status === null && value.resolvedAt === null && value.echo === null && value.error === "AbortError"
        && value.signalAbort !== null && value.startedAt <= value.signalAbort && value.signalAbort <= successor.startedAt && value.signalAbort <= row.terminalAt!
        && value.startedAt >= window.start && value.readerEOF === null && value.jsonResolved === null && value.bytes === 0 && value.reads === 0
        && value.cancelledAt === null && !value.abortedAtComplete;
    });
    if (candidates.length !== 1) return null; const original = candidates[0]!;
    const betweenRequests = rows.filter(value => value.generation === row.generation && value.method === "GET" && value.path.startsWith(prefix + "/")
      && value.ordinal > previous.ordinal && value.ordinal < next.ordinal);
    const familyHashes = new Set(rows.filter(value => value.generation === row.generation && value.path.startsWith(prefix + "/")).map(value => value.urlHash));
    const betweenAudits = [...audits.values()].filter(value => {
      const call = sequence(value);
      return value.document === original.document && value.method === "GET" && familyHashes.has(value.urlHash) && call !== null && call > firstSequence && call < lastSequence;
    });
    if (betweenRequests.length !== 1 || betweenRequests[0] !== row || betweenAudits.length !== 1 || betweenAudits[0]?.key !== original.key) return null;
    const reverse = betweenRequests.filter(value => value.method === original.method && value.urlHash === original.urlHash && value.bodyHash === original.bodyHash
      && value.authority === original.authority && value.at >= previous.at && value.at <= next.at && value.status === null && value.failed && value.aborted
      && value.request.timing().startTime === 0 && value.request.timing().requestStart === -1 && value.request.timing().responseStart === -1 && value.request.timing().responseEnd === -1);
    if (reverse.length !== 1 || reverse[0] !== row) return null;
    const raw = (value: Row) => { const { request, ...fields } = value; return { ...fields, timing: request.timing() }; };
    return { basis: "anchored_sequence_preheader", intentId: id, document: original.document, control: { ...window }, previousSession: { ...before }, nextSession: { ...after },
      rawRequest: raw(row), rawNative: { ...original }, requestEventDifferenceMs: row.at - original.startedAt, candidateCount: candidates.length, reverseCount: reverse.length,
      before: { request: raw(previous), native: { ...preceding } }, after: { request: raw(next), native: { ...successor } },
      interveningRequests: betweenRequests.map(value => value.ordinal), interveningNativeKeys: betweenAudits.map(value => value.key), documentOrdinal: document.ordinal };
  }
  const deliveryControlNames = new Set(["original_delivery_prepare_only", "actual_WorkflowRun_withdrawal_and_late_original200",
    "restore_only_reads_original_intent_without_confirmation", "explicit_cleanup_cancel_and_ack_original_preparation"]);
  const nativeSequence = (value: Audit) => {
    const text = value.key.startsWith(value.document + ":") ? value.key.slice(value.document.length + 1) : "";
    return /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  };
  const readSignature = (value: { method: string; urlHash: string; bodyHash: string | null; authority: string | null }) =>
    JSON.stringify([value.method, value.urlHash, value.bodyHash, value.authority]);
  const rawRead = (value: Row) => { const { request, ...fields } = value; return { ...fields, timing: request.timing() }; };
  function deliveryRead(row: Row) {
    if (source.mode !== "delivery" || row.method !== "GET" || row.bodyHash !== null || row.prefetch || row.rsc || row.resource !== "fetch") return null;
    const url = new URL(row.request.url()); if (url.hash) return null;
    if (originalRead(row, "list")) return "list";
    const id = new RegExp(`^${prefix}/requests/([a-f0-9-]{36})$`).exec(row.path)?.[1];
    if (id && originals.has(id) && originalRead(row, "detail", id)) return "detail";
    // This scenario never changes the original task history filters. Its real
    // mount/focus reader always sends page=1; query-free or other filters differ.
    if (row.path === "/api/ai-assists/task-workspace") return url.search === "?page=1" ? "workspace" : null;
    if (url.search) return null;
    if ([`${prefix}/workspace`, "/api/agent-native-v3/workspace", "/api/agent-fulfillment/workspace", "/api/agent-resources/workspace",
      "/api/agent-reads/workspace", "/api/agent-tools/workspace", "/api/agent-loops/workspace", "/api/agent-plans/workspace", "/api/agent-dependency-plans/workspace"].includes(row.path)) return "workspace";
    if (/^\/api\/agent-readiness\/(?:native_v3|loop|plan)$/.test(row.path)) return "readiness";
    if (/^\/api\/agent-runtime-readiness\/(?:native_v3|loop|plan)$/.test(row.path)) return "runtime";
    return null;
  }
  function deliveryPair(row: Row): Audit | null {
    const direct = pair(row); if (direct) return direct;
    if (source.mode !== "delivery" || !controls.some(value => deliveryControlNames.has(value.name) && row.at >= value.start && (value.end === null || row.at <= value.end))) return null;
    const metadata = mountReads.find(value => value.path === row.path);
    if (deliveryRead(row) === null && !(row.method === "POST" && metadata && !new URL(row.request.url()).search && row.bodyHash === sha(JSON.stringify(metadata.input)))) return null;
    const known = new Set(sessions.filter(value => value.generation === row.generation).map(value => value.document));
    if (known.size !== 1) return null; const documentKey = [...known][0]!;
    const docs = [...documents.entries()].filter(([, value]) => value.generation === row.generation && value.finished && value.status === 200);
    if (docs.length !== 1) return null; const main = rows.find(value => value.request === docs[0]![0]);
    if (!main || !(main.request.timing().startTime > 0)) return null;
    const apiRows = rows.filter(value => value.generation === row.generation && value.resource === "fetch" && value.path.startsWith("/api/"));
    const anchors = apiRows.flatMap(value => {
      const audit = pair(value), metadata = mountReads.find(item => item.path === value.path);
      const allowed = deliveryRead(value) !== null || value.method === "GET" && value.path === "/api/erp-auth/session" && !new URL(value.request.url()).search
        || value.method === "POST" && metadata && !new URL(value.request.url()).search && value.bodyHash === sha(JSON.stringify(metadata.input));
      if (!allowed || value.status !== 200 || !complete(audit) || audit?.status !== 200 || audit.document !== documentKey || nativeSequence(audit) === null) return [];
      if (value.authority !== null && (value.echo !== value.authority || audit.authority !== value.authority || audit.echo !== value.authority)) return [];
      return [{ row: value, audit }];
    });
    const before = anchors.filter(value => value.row.ordinal < row.ordinal).at(-1), after = anchors.find(value => value.row.ordinal > row.ordinal);
    if (!before && !after) return null;
    const replacement = !after ? authorityTransitions.find(value => value.after !== null && value.end !== null && value.before.document === documentKey
      && value.before.generation === row.generation && value.after.document !== documentKey) : undefined;
    const nextMain = replacement?.after ? rows.find(value => value.generation === replacement.after!.generation && value.resource === "document"
      && documents.has(value.request) && value.status === 200 && value.finished && !value.failed && value.urlHash === replacement.before.locationHash) : undefined;
    if (!after && (!replacement || !nextMain || !(nextMain.request.timing().startTime > 0))) return null;
    const nativeRows = [...audits.values()].filter(value => value.document === documentKey).sort((a, b) => (nativeSequence(a) ?? -1) - (nativeSequence(b) ?? -1));
    if (!nativeRows.length || nativeRows.some(value => nativeSequence(value) === null)) return null;
    const first = before ? nativeSequence(before.audit)! : 0, last = after ? nativeSequence(after.audit)! : (nativeSequence(nativeRows.at(-1)!) ?? -1) + 1;
    if (first >= last) return null;
    const requestSpan = apiRows.filter(value => value.ordinal > (before?.row.ordinal ?? main.ordinal) && value.ordinal < (after?.row.ordinal ?? nextMain!.ordinal));
    const nativeSpan = nativeRows.filter(value => nativeSequence(value)! > first && nativeSequence(value)! < last);
    // Match the entire bounded sequence, including repeated URLs and metadata
    // reads. Never skip an intervening Request/call or adjust a raw timestamp.
    // A document boundary is an actual completed main request, not a made-up
    // native fetch/EOF. In-document anchors still use the original +/-5ms gate.
    if (!requestSpan.length || requestSpan.length !== nativeSpan.length || nativeSpan.some((value, index) => nativeSequence(value) !== first + index + 1)
      || requestSpan.some((value, index) => readSignature(value) !== readSignature(nativeSpan[index]!))) return null;
    const index = requestSpan.indexOf(row); if (index < 0 || requestSpan.filter(value => value.request === row.request).length !== 1) return null;
    const audit = nativeSpan[index]!;
    if (nativeSpan.filter(value => value.key === audit.key).length !== 1 || audit.startedAt < main.request.timing().startTime) return null;
    deliveryPairs.set(row.ordinal, { basis: "bounded_original_document_sequence", rawRequest: rawRead(row), rawNative: { ...audit },
      requestEventDifferenceMs: row.at - audit.startedAt, cdpDifferenceMs: row.request.timing().startTime > 0 ? row.request.timing().startTime - audit.startedAt : null,
      before: before ? { request: rawRead(before.row), native: { ...before.audit } } : { mainDocument: rawRead(main), nativeSequenceBeforeFirstCall: 0 },
      after: after ? { request: rawRead(after.row), native: { ...after.audit } } : { replacementDocument: rawRead(nextMain!), authorityTransition: replacement },
      alignment: requestSpan.map((value, position) => ({ ordinal: value.ordinal, auditKey: nativeSpan[position]!.key, signatureHash: sha(readSignature(value)) })),
      candidateCount: 1, reverseCount: 1 });
    return audit;
  }
  async function currentSession() {
    const value = await session(page); authorityChecks.push({ at: Date.now(), authority: sha(erpSessionAuthority(value)), workflowRun: value.permissions.includes(Permission.WorkflowRun) }); return value;
  }
  async function beginAuthorityTransition(kind: AuthorityTransition["kind"]) {
    await current(); const before = sessions.at(-1), name = kind === "withdraw" ? "actual_WorkflowRun_withdrawal_and_late_original200" : "restore_only_reads_original_intent_without_confirmation";
    const active = controls.filter(value => value.name === name && value.end === null);
    if (source.mode !== "delivery" || !before || active.length !== 1 || before.workflowRun !== (kind === "withdraw")) throw new Error("agent_fulfillment_authority_transition_invalid");
    const value: AuthorityTransition = { kind, control: name, start: Date.now(), focusAt: null, end: null, before, after: null, runtimeNotChecked: false };
    authorityTransitions.push(value); return value;
  }
  async function focusAuthorityTransition(value: AuthorityTransition) {
    if (!authorityTransitions.includes(value) || value.focusAt !== null) throw new Error("agent_fulfillment_authority_focus_invalid");
    value.focusAt = Date.now(); await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  }
  async function finishAuthorityTransition(value: AuthorityTransition) {
    await page.waitForLoadState("domcontentloaded"); await current(); const after = sessions.at(-1);
    if (!after || after.document === value.before.document || after.generation <= value.before.generation || after.locationHash !== value.before.locationHash
      || after.authority === value.before.authority || after.workflowRun !== (value.kind === "restore")) throw new Error("agent_fulfillment_authority_document_not_changed");
    value.after = after;
    if (value.kind === "withdraw") {
      for (const name of ["原生工具 v3启动诊断", "有界读取任务启动诊断", "模型业务计划启动诊断"]) {
        await expect(page.getByRole("region", { name, exact: true }).getByRole("region", { name: "执行服务当前观察", exact: true })
          .getByText("当前缺少任务运行权限 未检查执行服务", { exact: true })).toBeVisible();
      }
      value.runtimeNotChecked = true;
    }
    value.end = Date.now();
  }
  async function settleDeliveryReads() {
    await current();
    await expect.poll(() => {
      const current = sessions.at(-1); if (!current) return false;
      const latest = new Map<string, Row>();
      for (const row of rows) if (row.generation === current.generation && row.authority === current.authority && (deliveryRead(row) !== null
        || row.method === "POST" && mountReads.some(value => value.path === row.path && row.bodyHash === sha(JSON.stringify(value.input))))) latest.set(readSignature(row), row);
      return [...latest.values()].some(row => deliveryRead(row) === "detail") && [...latest.values()].every(row => {
        const audit = deliveryPair(row); return row.status === 200 && row.echo === current.authority && complete(audit) && audit?.status === 200
          && audit.authority === current.authority && audit.echo === current.authority && audit.document === current.document && (row.finished || row.failed);
      });
    }).toBe(true);
    await expect(review(page)).toHaveAttribute("aria-busy", "false");
    await expect(page.getByRole("region", { name: "本单已保存履约准备", exact: true }).getByRole("button", { name: "只读核对本单原准备", exact: true })).toBeEnabled();
    for (const name of ["原生工具 v3启动诊断", "有界读取任务启动诊断", "模型业务计划启动诊断"]) await expect(page.getByRole("region", { name, exact: true })).toHaveAttribute("aria-busy", "false");
    const resources = page.getByRole("region", { name: "业务资源读取", exact: true }), candidate = resources.getByRole("region", { name: "原业务对象候选", exact: true });
    // ObjectPicker can be idle before its debounced request starts. The accepted
    // bounded-count DOM plus the original strict candidates consumer above are
    // required as well; idle alone never establishes an accepted candidate read.
    await expect(resources.locator('button[aria-pressed="true"]').filter({ hasText: "research.evidence" })).toHaveCount(1);
    await expect(resources.getByRole("textbox", { name: "搜索原业务对象", exact: true })).toHaveValue("");
    await expect(candidate.getByRole("combobox", { name: "选择原业务对象", exact: true })).toHaveValue("");
    await expect(candidate).toHaveAttribute("aria-busy", "false");
    await expect(candidate.getByText(/^本页 \d+ 项 · 原服务报告总数 (?:\d+|未知) · 当前候选始终为有界范围 不称全量$/)).toBeVisible();
    await current(); const observed = sessions.at(-1)!;
    deliverySettled.push({ at: observed.at, document: observed.document, authority: observed.authority, generation: observed.generation,
      consumed: rows.filter(row => row.generation === observed.generation && row.authority === observed.authority && deliveryRead(row) !== null).flatMap(row => {
        const value = deliveryPair(row); return complete(value) ? [{ ordinal: row.ordinal, auditKey: value?.key, readerEOF: value?.readerEOF, jsonResolved: value?.jsonResolved }] : [];
      }) });
  }
  function authorityBracket(start: number, end: number, limit: number) {
    const points = [...sessions.map(value => ({ at: value.at, authority: value.authority, workflowRun: value.workflowRun })), ...authorityChecks].sort((a, b) => a.at - b.at);
    const before = points.filter(value => value.at <= start).at(-1), after = points.find(value => value.at >= end && value.at <= limit);
    if (!before || !after || before.authority !== after.authority || points.some(value => value.at >= before.at && value.at <= after.at && value.authority !== before.authority)) return null;
    return { before, after };
  }
  function deliveryCancellation(row: Row) {
    const kind = deliveryRead(row), timing = row.request.timing();
    if (!kind || row.authority === null || row.echo !== null || row.status !== null || row.finished || !row.failed || !row.aborted || row.terminalAt === null
      || timing.startTime !== 0 || timing.requestStart !== -1 || timing.responseStart !== -1 || timing.responseEnd !== -1) return null;
    const windows = controls.filter(value => deliveryControlNames.has(value.name) && value.end !== null && row.at >= value.start && row.terminalAt! <= value.end);
    if (windows.length !== 1) return null; const window = windows[0]!, audit = deliveryPair(row);
    if (!audit || audit.authority !== row.authority || audit.status !== null || audit.echo !== null || audit.resolvedAt !== null || audit.error !== "AbortError"
      || audit.signalAbort === null || audit.signalAbort < audit.startedAt || audit.signalAbort > row.terminalAt || audit.bytes !== 0 || audit.reads !== 0
      || audit.readerEOF !== null || audit.jsonResolved !== null || audit.cancelledAt !== null || audit.abortedAtComplete) return null;
    const transition = authorityTransitions.find(value => value.after !== null && value.end !== null && value.focusAt !== null && value.control === window.name
      && value.before.generation === row.generation && value.before.document === audit.document && value.before.authority === row.authority
      && row.at >= value.focusAt && audit.startedAt >= value.focusAt && audit.signalAbort! >= value.focusAt && row.terminalAt! <= value.end);
    if (transition?.after) {
      const nextDocument = rows.filter(value => value.generation === transition.after!.generation && documents.has(value.request) && value.status === 200
        && value.finished && !value.failed && value.urlHash === transition.before.locationHash);
      if (nextDocument.length !== 1 || !(nextDocument[0]!.request.timing().startTime > 0) || row.at > nextDocument[0]!.request.timing().startTime) return null;
      const previous = rows.filter(value => value.generation === row.generation && value.method === row.method && value.urlHash === row.urlHash && value.bodyHash === row.bodyHash
        && value.authority === row.authority && value.at < transition.focusAt! && value.status === 200).flatMap(value => {
          const native = deliveryPair(value); return complete(native) && native?.document === audit.document && native.status === 200 && native.echo === row.authority
            && (native.readerEOF ?? native.jsonResolved ?? Infinity) <= transition.focusAt! ? [{ ordinal: value.ordinal, native }] : [];
        }).at(-1);
      if (!previous) return null;
      if (kind === "runtime" && transition.kind === "withdraw" && transition.runtimeNotChecked && !transition.after.workflowRun) {
        return { basis: "actual_authority_document_runtime_not_checked", rawRequest: rawRead(row), rawNative: { ...audit }, previous,
          transition: { ...transition }, replacementDocument: rawRead(nextDocument[0]!), consumerEOFClaimed: false };
      }
      const replacement = rows.filter(value => value.generation === transition.after!.generation && value.method === row.method && value.urlHash === row.urlHash
        && value.bodyHash === row.bodyHash && value.authority === transition.after!.authority && value.status === 200 && value.echo === value.authority && deliveryRead(value) === kind)
        .flatMap(value => { const native = deliveryPair(value); return complete(native) && native?.document === transition.after!.document && native.status === 200
          && native.echo === value.authority && native.readerEOF !== null ? [{ request: rawRead(value), native: { ...native } }] : []; })[0];
      if (!replacement) return null;
      return { basis: "actual_authority_document_replaced_original_call", rawRequest: rawRead(row), rawNative: { ...audit }, previous,
        transition: { ...transition }, replacementDocument: rawRead(nextDocument[0]!), replacement, consumerEOFClaimed: false };
    }
    const next = rows.filter(value => value.generation === row.generation && value.ordinal > row.ordinal && readSignature(value) === readSignature(row)).sort((a, b) => a.ordinal - b.ordinal)[0];
    if (!next || deliveryRead(next) !== kind || next.status !== 200 || next.echo !== row.authority || next.terminalAt === null || next.terminalAt > window.end!) return null;
    const successor = deliveryPair(next);
    if (!complete(successor) || successor?.document !== audit.document || successor.status !== 200 || successor.authority !== row.authority || successor.echo !== row.authority
      || successor.readerEOF === null || successor.startedAt < audit.signalAbort) return null;
    const bracket = authorityBracket(row.at, successor.readerEOF, window.end!);
    if (!bracket || bracket.before.authority !== row.authority) return null;
    return { basis: "same_document_original_zero_read_replaced", rawRequest: rawRead(row), rawNative: { ...audit }, successor: { request: rawRead(next), native: { ...successor } },
      control: { ...window }, sessions: bracket, consumerEOFClaimed: false };
  }
  function deliveryPrefetch(row: Row) {
    if (source.mode !== "delivery" || row.method !== "GET" || row.resource !== "fetch" || row.bodyHash !== null || !row.failed || !row.aborted || row.status !== 200
      || !row.prefetch || !row.rsc || row.authority !== null || row.echo !== null || row.terminalAt === null || !(row.request.timing().responseEnd > 0)) return null;
    const literal = literalURL(row); if (!literal) return null;
    const windows = controls.filter(value => deliveryControlNames.has(value.name) && value.end !== null && row.at >= value.start && row.terminalAt! <= value.end);
    if (windows.length !== 1) return null; const window = windows[0]!, bracket = authorityBracket(row.at, row.terminalAt, window.end!);
    if (!bracket) return null;
    const known = new Set(sessions.filter(value => value.generation === row.generation).map(value => value.document));
    if (known.size !== 1) return null; const document = [...known][0]!;
    const matching = links.filter(value => value.generation === row.generation && value.document === document && value.requestHash === sha(literal) && value.at <= window.end!);
    const doc = rows.filter(value => value.generation === row.generation && documents.has(value.request) && value.status === 200 && value.finished && !value.failed
      && value.terminalAt !== null && value.terminalAt <= row.at);
    if (!matching.length || doc.length !== 1 || rows.some(value => value.generation === row.generation && value.at >= row.at && value.at <= row.terminalAt!
      && value.authority !== null && value.authority !== bracket.before.authority)) return null;
    return { rawRequest: rawRead(row), literalDOM: matching, sessions: bracket, documentOrdinal: doc[0]!.ordinal, control: { ...window }, consumerEOFClaimed: false };
  }
  async function check() {
    await current();
    await expect.poll(() => rows.filter(row => row.path.startsWith(prefix) && !row.finished && !row.failed && !special.has(row.request)).length).toBe(0);
    for (const row of rows) {
      if (special.has(row.request)) { row.classification = special.get(row.request)!; continue; }
      const audit = pair(row);
      const consumed = source.mode === "delivery" && row.status === 200 ? deliveryPair(row) : audit;
      if (row.failed && row.aborted && row.status === 200 && complete(consumed) && consumed?.status === row.status && consumed.echo === row.echo && row.authority !== null && row.echo === row.authority
        && (source.mode !== "delivery" || consumed.authority === row.authority && consumed.readerEOF !== null))
        row.classification = "original_consumer_completed_before_terminal_abort";
      if (row.failed && row.aborted && row.status === null && audit?.error === "AbortError" && audit.signalAbort !== null && audit.bytes === 0 && audit.reads === 0) {
        const next = rows.filter(value => value.ordinal > row.ordinal && value.generation === row.generation && value.method === row.method && value.urlHash === row.urlHash
          && value.bodyHash === row.bodyHash && value.authority === row.authority).sort((a, b) => a.ordinal - b.ordinal)[0];
        const successor = next ? pair(next) : null;
        if (next?.status === 200 && next.echo === row.authority && complete(successor) && successor?.document === audit.document
          && controls.some(value => row.at >= value.start && next.terminalAt !== null && value.end !== null && next.terminalAt <= value.end))
          row.classification = "zero_read_original_replaced_by_exact_completed_consumer";
      }
      if (row.failed && row.aborted && row.method === "GET" && row.status === 200 && row.prefetch && row.rsc && row.authority === null && row.echo === null
        && row.request.timing().responseEnd > 0 && controls.some(value => row.at >= value.start && row.terminalAt !== null && value.end !== null && row.terminalAt <= value.end)) {
        const url = new URL(row.request.url()), params = [...url.searchParams.keys()];
        if (new Set(params).size === params.length) { url.searchParams.delete("_rsc");
          const knownSessions = sessions.filter(value => value.generation === row.generation), doc = [...documents.values()].filter(value => value.generation === row.generation);
          if (knownSessions.length && new Set(knownSessions.map(value => value.authority)).size === 1 && doc.length === 1 && doc[0]?.finished && doc[0].status === 200
            && links.some(value => value.generation === row.generation && value.requestHash === sha(url.href))) row.classification = "literal_DOM_RSC_prefetch_terminal_abort_no_EOF_claim";
        }
      }
      if (row.classification === null) {
        const evidence = originalNavigationCancellation(row);
        if (evidence) { row.classification = "exact_original_source_navigation_abort_without_consumption_no_EOF_claim"; navigationPairings.push(evidence); }
      }
      if (row.classification === null) {
        const evidence = anchoredDetailCancellation(row);
        if (evidence) { row.classification = "registered_detail_preheader_cancel_replaced_by_exact_original_consumer_EOF"; detailPairings.push(evidence); }
      }
      if (row.classification === null) {
        const evidence = deliveryCancellation(row);
        if (evidence) { row.classification = "delivery_original_lifecycle_zero_read_cancellation_no_EOF_claim"; deliveryCancellations.push(evidence); }
      }
      if (row.classification === null) {
        const evidence = deliveryPrefetch(row);
        if (evidence) { row.classification = "delivery_literal_DOM_session_bracket_prefetch_abort_no_EOF_claim"; deliveryRsc.push(evidence); }
      }
    }
    expect(rows.filter(row => row.status !== null && row.status >= 400).map(({ ordinal, path, status }) => ({ ordinal, path, status }))).toEqual([]);
    expect(rows.filter(row => row.failed && row.classification === null).map(({ ordinal, path, method, status }) => ({ ordinal, path, method, status }))).toEqual([]);
    const inControl = (row: Row, name: string) => controls.some(value => value.name === name && row.at >= value.start && value.end !== null && row.at <= value.end);
    function originalWrite(row: Row) {
      let raw: unknown; try { raw = row.request.postDataJSON(); } catch { return false; }
      if (row.path === `${prefix}/prepare`) {
        const input = PrepareAgentFulfillmentCommandSchema.safeParse(raw), expected = source.mode === "shipment" ? "shipment_review" : "delivery_feedback";
        return input.success && input.data.orderId === source.orderId && input.data.original.kind === expected
          && (input.data.original.kind === "shipment_review" ? input.data.original.targetId === source.shipmentId
            : input.data.original.kind === "delivery_feedback" && input.data.original.packageId === source.packageId)
          && inControl(row, source.mode === "shipment" ? "original_prepare201_response_lost" : "original_delivery_prepare_only");
      }
      const match = new RegExp(`^${prefix}/requests/([a-f0-9-]{36})/(confirm|cancel|acknowledge)$`).exec(row.path);
      if (!match) return false; const original = originals.get(match[1]!); if (!original) return false;
      const input = match[2] === "confirm" ? ConfirmAgentFulfillmentCommandSchema.safeParse(raw)
        : match[2] === "cancel" ? CancelAgentFulfillmentCommandSchema.safeParse(raw) : AcknowledgeAgentFulfillmentCommandSchema.safeParse(raw);
      if (!input.success || input.data.orderId !== original.orderId || input.data.requestId !== original.requestId || input.data.requestChecksum !== original.requestChecksum) return false;
      if (match[2] === "confirm") return "originalChecksum" in input.data && input.data.originalChecksum === original.originalChecksum
        && input.data.decision === "execute_original" && inControl(row, "explicit_individual_original_confirmation");
      return inControl(row, "explicit_cleanup_cancel_and_ack_original_preparation") || match[2] === "acknowledge" && inControl(row, "explicit_acknowledgement_after_original_receipt_review");
    }
    const unknownWrites = rows.filter(row => row.method === "POST" && row.path.startsWith("/api/")).filter(row => {
      if (row.path.startsWith(prefix)) return !originalWrite(row);
      const metadata = mountReads.find(value => value.path === row.path); if (!metadata || row.bodyHash !== sha(JSON.stringify(metadata.input)) || row.status !== 200 || row.echo !== row.authority || !row.authority) return true;
      if (source.mode === "delivery" && new URL(row.request.url()).search) return true;
      const audit = source.mode === "delivery" ? deliveryPair(row) : pair(row); if (!complete(audit)) return true;
      const kind = row.path === "/api/agent-tools/definition" ? "tool" : "resource";
      return !definitions.some(value => value.generation === row.generation && value.authority === row.authority && value.kind === kind
        && (row.path.endsWith("candidates") ? value.queryEmpty && rows.some(other => other.path === "/api/agent-resources/definition" && other.generation === row.generation
          && other.authority === row.authority && (source.mode === "delivery" ? deliveryPair(other) : pair(other))?.definitionChecksum === value.checksum) : value.checksum === audit?.definitionChecksum));
    });
    expect(unknownWrites.map(({ ordinal, path, method, status }) => ({ ordinal, path, method, status })), "Only original strict metadata reads and this explicitly confirmed family may POST").toEqual([]);
    expect(errors.filter(error => !error.expectedNetwork || !rows.some(row => special.has(row.request) && row.terminalAt !== null && Math.abs(error.at - row.terminalAt) <= 2000))).toEqual([]);
  }
  return { rows, current, currentSession, control, openRecoveryLink, waitForOriginalListAfterConfirmation, beginAuthorityTransition, focusAuthorityTransition,
    finishAuthorityTransition, settleDeliveryReads, check, mark: (request: Request, label: string) => special.set(request, label),
    register(value: AgentFulfillmentCommandView) {
      if (value.native.orderId !== source.orderId) throw new Error("agent_fulfillment_observed_original_order_mismatch");
      originals.set(value.native.id, { orderId: value.native.orderId, requestId: value.native.requestId, requestChecksum: value.native.requestChecksum, originalChecksum: value.originalChecksum });
    },
    proof: () => ({ controls, sessions, links, definitions, recoveryNavigations, navigationPairings, detailPairings, listStability, authorityChecks, authorityTransitions,
      deliveryPairs: [...deliveryPairs.values()], deliveryCancellations, deliveryRsc, deliverySettled, audits: [...audits.values()], errors,
      documents: [...documents.entries()].map(([request, value]) => ({ ...value, ordinal: rows.find(row => row.request === request)?.ordinal ?? null })),
      requests: rows.map(({ request, ...row }) => ({ ...row, timing: request.timing() })) }) };
}

async function loaded(page: Page, source: Source) {
  await expect(page.getByRole("heading", { name: source.orderNumber, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "整单详情", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("region", { name: "本单原履约提交恢复", exact: true })).toHaveAttribute("aria-busy", "false");
}
async function captures(page: Page, info: TestInfo, scope: Locator, name: string) {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 }); await scope.scrollIntoViewIfNeeded(); await expect(scope).toBeVisible();
    await expect.poll(() => scope.evaluate(element => ({ opacity: getComputedStyle(element).opacity,
      active: element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length }))).toEqual({ opacity: "1", active: 0 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${name}-${width}.png`), fullPage: false });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => scope.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
async function markers(page: Page) {
  const values = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => sessionStorage.getItem(key)), intentPrefix);
  return values.map(value => AgentFulfillmentCommandIntentSchema.parse(JSON.parse(value!)));
}
async function readView(page: Page, id: string, orderId: string) {
  const current = await session(page), authority = erpSessionAuthority(current);
  const response = await page.request.get(`${prefix}/requests/${id}?${new URLSearchParams({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId })}`, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const value = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(value.contextAuthority).toBe(authority); expect(value.native.id).toBe(id); expect(value.native.orderId).toBe(orderId); return value;
}
async function acknowledge(page: Page, id: string) {
  const waiting = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `${prefix}/requests/${id}/acknowledge`);
  await page.getByRole("button", { name: "确认结果并清理原履约填写", exact: true }).click(); const response = await waiting; expect(response.status()).toBe(200);
  const value = AgentFulfillmentCommandViewSchema.parse(await response.json());
  expect(value.native.id).toBe(id); expect(value.native.status).toBe("acknowledged"); expect(value.native.receipt).toBeNull(); expect(value.original).toBeNull();
}
async function finish(page: Page, info: TestInfo, seen: Awaited<ReturnType<typeof observe>> | undefined, state: ReturnType<typeof facts> | undefined,
  primary: unknown, detail: Record<string, unknown>, release?: () => void) {
  const failures: unknown[] = primary ? [primary] : []; let networkFailed = false, cleanupFailed = false;
  release?.();
  try { await page.unrouteAll({ behavior: "wait" }); } catch (error) { cleanupFailed = true; failures.push(error); }
  try { await state?.close(); } catch (error) { cleanupFailed = true; failures.push(error); }
  try { await seen?.check(); } catch (error) { networkFailed = true; failures.push(error); }
  await writeFile(info.outputPath("agent-fulfillment-command-proof.json"), JSON.stringify({ nonce: isolated.nonce, ...detail,
    primaryFailure: Boolean(primary), networkFailed, cleanupFailed, databaseClosed: state?.closed ?? true, roleRestored: state?.restored ?? true,
    network: seen?.proof(), modelCalls: 0, workerProcesses: 0, modelProposalState: "not_integrated" }, null, 2) + "\n");
  if (failures.length) throw new AggregateError(failures, "agent_fulfillment_browser_leaf_failed");
}

test("agent_fulfillment_original_form_prepare201_loss_GET_recovery_individual_confirmation at 1440 and 390", async ({ page }, info) => {
  let seen: Awaited<ReturnType<typeof observe>> | undefined, state: ReturnType<typeof facts> | undefined, primary: unknown;
  const detail: Record<string, unknown> = { scope: "actual_personal_original_form_and_original_owners_synthetic_physical_attestation" };
  try {
    const seeded = await seed("shipment"), source = seeded.source; detail.seed = seeded.evidence; detail.source = source;
    if (!source.shipmentId) throw new Error("agent_fulfillment_original_shipment_missing");
    seen = await observe(page, source); const audit = seen;
    await audit.control("original_personal_source", async () => { await loginErp(page, "operator", "/navigation"); await audit.current();
      await page.goto(`/shipments?${new URLSearchParams({ order: source.orderId, line: source.lineId })}`); await loaded(page, source); });
    state = facts(TenantContextSchema.parse(await session(page))); const before = await state.snapshot();
    const record = page.locator("article.oc-record").filter({ has: page.getByText(`发货单 ${source.shipmentId}`, { exact: true }) });
    const form = record.locator('form[data-order-action="shipment-review"]'); await expect(form).toBeVisible();
    await form.getByLabel("核对说明", { exact: true }).fill("SYNTHETIC d6 original approved package review only");
    const lost = latch(); let prepared: AgentFulfillmentCommandView | undefined, originalRequest: Request | undefined;
    await page.route(`**${prefix}/prepare`, async route => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      if (originalRequest) throw new Error("agent_fulfillment_duplicate_prepare"); originalRequest = route.request();
      const input = PrepareAgentFulfillmentCommandSchema.parse(originalRequest.postDataJSON()), response = await route.fetch(); expect(response.status()).toBe(201);
      prepared = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(input.orderId).toBe(source.orderId); expect(input.original.kind).toBe("shipment_review");
      expect(input.original.targetId).toBe(source.shipmentId); expect(prepared.original).toEqual(input.original); expect(prepared.native.status).toBe("prepared");
      expect(prepared.originalChecksum).toBe(sha(canonicalAgentFulfillmentOriginal(input.original)));
      audit.register(prepared);
      audit.mark(originalRequest, "exact_original_prepare201_committed_response_deliberately_lost_no_EOF_claim"); await route.abort("failed"); lost.release();
    });
    await audit.control("original_prepare201_response_lost", async () => { await form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }).click();
      await bounded(lost.promise, "agent_fulfillment_real_prepare201_missing"); await expect(page.getByRole("link", { name: "只读恢复原履约准备", exact: true })).toBeVisible(); });
    if (!prepared || !originalRequest) throw new Error("agent_fulfillment_committed_prepare_missing"); const fixed = prepared;
    expect(await state.snapshot()).toEqual(before); const stored = (await markers(page)).filter(value => value.requestId === fixed.native.requestId);
    expect(stored).toHaveLength(1); expect(stored[0]).toMatchObject({ orderId: source.orderId, requestChecksum: fixed.native.requestChecksum, state: "unknown" });
    await page.unroute(`**${prefix}/prepare`); const readStart = audit.rows.length;
    await audit.control("reload_and_original_receipt_GET_only", async () => { await page.reload(); await loaded(page, source);
      await audit.openRecoveryLink(page.getByRole("link", { name: "只读恢复原履约准备", exact: true }));
      const recovery = page.getByRole("region", { name: "本人原履约准备恢复", exact: true }); await expect(recovery).toBeVisible();
      const receipt = page.waitForResponse(value => new URL(value.url()).pathname === `${prefix}/receipts` && value.request().method() === "GET");
      await recovery.getByRole("button", { name: "只读取原履约回执", exact: true }).click(); const actual = await receipt; expect(actual.status()).toBe(200);
      expect(AgentFulfillmentCommandReceiptSchema.parse(await actual.json())).toMatchObject({ id: fixed.native.id, disposition: "known" });
      await expect(review(page)).toBeVisible(); await expect(review(page)).toHaveAttribute("aria-busy", "false"); });
    expect(audit.rows.slice(readStart).filter(row => row.method === "POST" && row.path.startsWith(prefix))).toEqual([]);
    const reread = await readView(page, fixed.native.id, source.orderId); expect(reread.original).toEqual(fixed.original); expect(await state.snapshot()).toEqual(before);
    await expect(review(page).getByText("SYNTHETIC d6 original approved package review only", { exact: true })).toBeVisible();
    await audit.control("explicit_individual_original_confirmation", async () => {
      await review(page).getByRole("checkbox", { name: "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约", exact: true }).check();
      const response = page.waitForResponse(value => new URL(value.url()).pathname === `${prefix}/requests/${fixed.native.id}/confirm` && value.request().method() === "POST");
      await page.getByRole("button", { name: "确认执行这笔原履约", exact: true }).click(); const actual = await response; expect(actual.status()).toBe(200);
      const input = ConfirmAgentFulfillmentCommandSchema.parse(actual.request().postDataJSON()); expect(input.requestChecksum).toBe(fixed.native.requestChecksum);
      const completed = AgentFulfillmentCommandViewSchema.parse(await actual.json()); expect(completed.native.status).toBe("succeeded"); expect(completed.native.receipt?.kind).toBe("shipment_review");
      detail.originalReceipt = completed.native.receipt; await expect(review(page).getByLabel("原业务履约回执", { exact: true })).toBeVisible();
      await audit.waitForOriginalListAfterConfirmation(fixed.native.id);
    });
    const committed = await state.snapshot(); const start = audit.rows.length;
    await audit.control("committed_original_remount_GET_only", async () => { await page.reload(); await expect(review(page)).toHaveAttribute("aria-busy", "false");
      await expect(review(page).getByLabel("原业务履约回执", { exact: true })).toBeVisible(); });
    expect(audit.rows.slice(start).filter(row => row.method === "POST" && row.path.startsWith(prefix))).toEqual([]); expect(await state.snapshot()).toEqual(committed);
    await audit.control("responsive_receipt_visual_review", () => captures(page, info, review(page), "original-recovered"));
    await audit.control("explicit_acknowledgement_after_original_receipt_review", () => acknowledge(page, fixed.native.id));
    expect(audit.rows.filter(row => row.path === `${prefix}/prepare` && row.method === "POST")).toHaveLength(1);
    expect(audit.rows.filter(row => row.path === `${prefix}/requests/${fixed.native.id}/confirm` && row.method === "POST")).toHaveLength(1);
    detail.preparedIntentId = fixed.native.id; detail.requestChecksum = fixed.native.requestChecksum; detail.prepareOnlyBusinessUnchanged = true; detail.recoveryBusinessUnchanged = true;
  } catch (error) { primary = error; }
  await finish(page, info, seen, state, primary, detail);
});

test("agent_fulfillment_original_delivery_late_Workflow_withdrawal_preserves_read_only_recovery at 1440 and 390", async ({ page }, info) => {
  let seen: Awaited<ReturnType<typeof observe>> | undefined, state: ReturnType<typeof facts> | undefined, primary: unknown;
  const detail: Record<string, unknown> = { scope: "actual_same_operator_WorkflowRun_withdrawal_Order_and_PII_read_remain" }, release = latch();
  try {
    const seeded = await seed("delivery"), source = seeded.source; detail.seed = seeded.evidence; detail.source = source;
    seen = await observe(page, source); const audit = seen;
    await audit.control("original_personal_delivery_source", async () => { await loginErp(page, "operator", "/navigation"); await audit.current();
      await page.goto(`/production?${new URLSearchParams({ line: source.lineId, order: source.orderId, delivery: source.packageId })}`); await loaded(page, source);
      const delivery = page.locator("details.oc-whole-records").filter({ has: page.locator("summary").filter({ hasText: /^工厂交付与回执/ }) });
      await expect(delivery).toHaveCount(1); const toggle = delivery.locator(":scope > summary"), packet = page.locator(`#delivery-package-${source.packageId}`);
      await expect(toggle).toBeVisible(); const initiallyOpen = await delivery.evaluate(element => element instanceof HTMLDetailsElement && element.open);
      const initial = { open: initiallyOpen, ariaExpanded: await toggle.getAttribute("aria-expanded"), packageVisible: await packet.isVisible() };
      if (!initiallyOpen) await toggle.click();
      await expect(delivery).toHaveJSProperty("open", true); await expect(packet).toBeVisible();
      detail.deliverySection = { initial, clickedSummary: !initiallyOpen, openAndPackageVisible: true }; });
    state = facts(TenantContextSchema.parse(await session(page))); const before = await state.snapshot(), packet = page.locator(`#delivery-package-${source.packageId}`);
    const form = packet.getByRole("form", { name: /^登记工厂回执 / });
    await packet.getByText("可选补充回执与异常处理", { exact: true }).click(); await expect(form).toBeVisible();
    await form.getByRole("combobox", { name: "回执类型", exact: true }).selectOption("received");
    await form.getByLabel("回复依据", { exact: true }).fill("SYNTHETIC-D6-ORIGINAL");
    await form.getByLabel("工厂回复与处理说明", { exact: true }).fill("SYNTHETIC d6 exact original delivery observation only");
    await form.locator('input[name="verified"]').check();
    let prepared!: AgentFulfillmentCommandView;
    await audit.control("original_delivery_prepare_only", async () => {
      // Saving the scalar marker briefly renders the original recovery Link
      // before the real 201 supplies an intent ID. Capture that actual DOM
      // interval; never synthesize its href from the source implementation.
      await page.evaluate(({ orderId, lineId, packageId }) => {
        const documentKey = window.__afcDocument; if (!documentKey) throw new Error("agent_fulfillment_recovery_DOM_document_missing");
        window.__afcRecoveryLinkDOM = []; window.__afcRecoveryLinkObserver?.disconnect();
        const collect = () => {
          for (const element of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            if (element.textContent?.trim() !== "只读恢复原履约准备") continue;
            const href = element.getAttribute("href"); if (!href) continue;
            const url = new URL(href, location.href), keys = [...url.searchParams.keys()];
            if (url.origin !== location.origin || url.pathname !== "/ai-tasks" || url.hash || keys.length !== 3 || new Set(keys).size !== 3
              || url.searchParams.get("order") !== orderId || url.searchParams.get("line") !== lineId || url.searchParams.get("delivery") !== packageId) continue;
            if (!window.__afcRecoveryLinkDOM!.some(value => value.href === href)) window.__afcRecoveryLinkDOM!.push({ document: documentKey, at: performance.timeOrigin + performance.now(), href });
          }
        };
        window.__afcRecoveryLinkObserver = new MutationObserver(collect);
        window.__afcRecoveryLinkObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] }); collect();
      }, { orderId: source.orderId, lineId: source.lineId, packageId: source.packageId });
      const waiting = page.waitForResponse(value => new URL(value.url()).pathname === `${prefix}/prepare` && value.request().method() === "POST");
      await form.getByRole("button", { name: "只准备交由 Agent 核对", exact: true }).click(); const response = await waiting; expect(response.status()).toBe(201);
      prepared = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(prepared.native.kind).toBe("delivery_feedback"); expect(prepared.native.orderId).toBe(source.orderId);
      audit.register(prepared);
      const handoff = page.getByRole("link", { name: "到 AI 工作台核对原履约准备", exact: true }); await expect(handoff).toBeVisible(); await audit.current();
      await page.evaluate(() => window.__afcRecoveryLinkObserver?.disconnect());
      await handoff.click(); await expect(review(page)).toHaveAttribute("aria-busy", "false");
      await expect(review(page).getByRole("checkbox", { name: "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约", exact: true })).toBeVisible();
      await audit.settleDeliveryReads();
    });
    expect(await state.snapshot()).toEqual(before); const oldAuthority = erpSessionAuthority(await audit.currentSession()), entered = latch(); let held: Request | undefined;
    await page.route(`**${prefix}/requests/${prepared.native.id}?*`, async (route: Route) => {
      if (route.request().method() !== "GET" || held) { await route.continue(); return; }
      held = route.request(); const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(response.headers()["x-yummyai-context-authority"]).toBe(oldAuthority);
      const original = AgentFulfillmentCommandViewSchema.parse(await response.json()); expect(original.canConfirm).toBe(true); expect(original.native.id).toBe(prepared.native.id);
      entered.release(); await release.promise; await route.fulfill({ response });
    });
    await audit.control("actual_WorkflowRun_withdrawal_and_late_original200", async () => {
      await review(page).getByRole("button", { name: "重新读取原履约操作", exact: true }).click(); await bounded(entered.promise, "agent_fulfillment_held_real_original200_missing");
      const transition = await audit.beginAuthorityTransition("withdraw");
      await state!.withdrawRun(); await audit.focusAuthorityTransition(transition);
      await expect.poll(async () => (await audit.currentSession()).permissions.includes(Permission.WorkflowRun)).toBe(false);
      await expect(page.getByText("当前只读取原请求 没有工作流运行权限 不确认执行或取消原准备", { exact: true })).toBeVisible();
      const fresh = await readView(page, prepared.native.id, source.orderId); expect(fresh.canConfirm).toBe(false); expect(fresh.confirmationToken).toBeNull();
      expect(fresh.contextAuthority).not.toBe(oldAuthority); detail.oldAuthorityHash = sha(oldAuthority); detail.newAuthorityHash = sha(fresh.contextAuthority);
      await audit.finishAuthorityTransition(transition);
      if (!held) throw new Error("agent_fulfillment_original_held_request_missing");
      audit.mark(held, "exact_held_original200_superseded_by_verified_current_WorkflowRun_denial_no_EOF_claim"); release.release();
      await expect(page.getByRole("button", { name: "确认执行这笔原履约", exact: true })).toHaveCount(0);
      await audit.settleDeliveryReads();
    });
    expect(await state.snapshot()).toEqual(before); await audit.control("responsive_receipt_visual_review", () => captures(page, info, review(page), "late-current-read-only"));
    const restoreStart = audit.rows.length;
    await audit.control("restore_only_reads_original_intent_without_confirmation", async () => { const transition = await audit.beginAuthorityTransition("restore");
      await state!.restore(); await audit.focusAuthorityTransition(transition);
      await expect.poll(async () => (await audit.currentSession()).permissions.includes(Permission.WorkflowRun)).toBe(true);
      await expect(review(page).getByRole("checkbox", { name: "已核对原订单 原版本 全部填写与业务影响 明确执行这笔原履约", exact: true })).toBeVisible();
      const restored = await readView(page, prepared.native.id, source.orderId); expect(restored.native.id).toBe(prepared.native.id); expect(restored.native.status).toBe("prepared");
      await audit.finishAuthorityTransition(transition); await audit.settleDeliveryReads();
    });
    expect(audit.rows.slice(restoreStart).filter(row => row.method === "POST" && row.path.startsWith(prefix))).toEqual([]); expect(await state.snapshot()).toEqual(before);
    expect(audit.rows.filter(row => row.method === "POST" && row.path === `${prefix}/prepare`)).toHaveLength(1);
    expect(audit.rows.filter(row => row.method === "POST" && row.path.endsWith("/confirm"))).toEqual([]);
    await audit.control("explicit_cleanup_cancel_and_ack_original_preparation", async () => {
      const waiting = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `${prefix}/requests/${prepared.native.id}/cancel`);
      page.once("dialog", dialog => { void dialog.accept(); });
      await page.getByRole("button", { name: "取消这笔原履约准备", exact: true }).click(); const response = await waiting; expect(response.status()).toBe(200);
      expect(AgentFulfillmentCommandViewSchema.parse(await response.json()).native.status).toBe("cancelled"); await audit.settleDeliveryReads();
      await acknowledge(page, prepared.native.id); await audit.settleDeliveryReads();
    });
    expect(await state.snapshot()).toEqual(before);
    detail.preparedIntentId = prepared.native.id; detail.preparedOnly = true; detail.businessUnchanged = true; detail.restoreGETOnly = true;
  } catch (error) { primary = error; }
  await finish(page, info, seen, state, primary, detail, release.release);
});
