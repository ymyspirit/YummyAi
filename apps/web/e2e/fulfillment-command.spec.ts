import { expect, test, type Locator, type Page, type Request, type Route, type TestInfo } from "@playwright/test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { ProductionDeliveryPackageViewSchema, ProductionDeliveryWorkspaceSchema } from "@yummyai/contracts/order/production-delivery";
import { OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { FulfillmentCommandListSchema, FulfillmentCommandQuerySchema, FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema,
  fulfillmentCommandCanonicalJson, type FulfillmentCommandKind, type FulfillmentCommandView } from "@yummyai/contracts/order/fulfillment-command";
import { connectDatabase, memberships, membershipRoles, roles, withTenant } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireFulfillmentCommandEnvironment } from "../../../tools/testing/require-fulfillment-command-environment.mjs";
import { actors, loginErp } from "./erp-identity-fixture";

const isolated = requireFulfillmentCommandEnvironment(process.env, "current", true);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const basePath = "/api/order-centers/fulfillment-commands";
const Seed = z.object({ type: z.literal("fulfillment.browser.seeded"), mode: z.enum(["shipment", "delivery"]),
  orderId: z.uuidv7(), lineId: z.uuidv7(), productionId: z.uuidv7(), packageId: z.uuidv7(), shipmentId: z.uuidv7().nullable(),
  orderNumber: z.string().min(1), resourcesClosed: z.literal(true), modelCalls: z.literal(0), workerProcesses: z.literal(0) }).strict();
type Source = z.infer<typeof Seed>;
function latch() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
async function bounded<T>(operation: Promise<T>, label: string, timeout = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(label)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function safeFailure(error: unknown) {
  const value = error instanceof Error ? error : new Error("non_error_failure");
  return { name: ["Error", "TypeError", "AssertionError", "TimeoutError", "AggregateError"].includes(value.name) ? value.name : "Other",
    messageSha256: sha(value.message), code: error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : null };
}
async function seed(mode: Source["mode"]) {
  requireFulfillmentCommandEnvironment(process.env, "current", true);
  const child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
    resolve(root, "tools/testing/fulfillment-command-browser.mts"), mode], { cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
  const evidence = { mode, pid: child.pid ?? null, resourcesClosed: false, exited: false, forced: false, exitCode: null as number | null, signal: null as string | null,
    startupType: null as string | null, startupCode: null as string | null };
  let accept!: (value: Source) => void, reject!: (error: Error) => void, received = false;
  const result = new Promise<Source>((done, failed) => { accept = done; reject = failed; });
  child.stderr?.on("data", (bytes: Buffer) => {
    const text = bytes.toString("utf8"); evidence.startupType ??= /\b(SyntaxError|ReferenceError|TypeError|TransformError)\b/.exec(text)?.[1] ?? null;
    evidence.startupCode ??= /\b(ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)\b/.exec(text)?.[1] ?? null;
  });
  child.on("message", (raw: unknown) => {
    const value = Seed.safeParse(raw);
    if (value.success && !received && value.data.mode === mode) { received = true; evidence.resourcesClosed = true; accept(value.data); return; }
    if (raw && typeof raw === "object" && "type" in raw && raw.type === "fulfillment.browser.failed") {
      const failure = z.object({ type: z.literal("fulfillment.browser.failed"), phase: z.string().regex(/^[a-z_]{1,64}$/),
        errorName: z.string().regex(/^[A-Za-z]{1,64}$/), code: z.string().regex(/^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT)$/).nullable() }).strict().safeParse(raw);
      reject(new Error(failure.success ? JSON.stringify(failure.data) : "fulfillment_seed_finite_failure_invalid"));
    } else reject(new Error("fulfillment_seed_protocol_invalid"));
  });
  child.once("error", () => reject(new Error("fulfillment_seed_spawn_failed")));
  const ended = new Promise<void>(done => child.once("close", (code, signal) => {
    evidence.exited = true; evidence.exitCode = code; evidence.signal = signal;
    if (!received) reject(new Error(JSON.stringify({ code: "fulfillment_seed_early_exit", ...evidence }))); done();
  }));
  let primary: unknown, source: Source | undefined;
  try { source = await bounded(result, "fulfillment_seed_deadline", 180_000); await bounded(ended, "fulfillment_seed_normal_close_deadline", 15_000); }
  catch (error) { primary = error; }
  if (!evidence.exited) { evidence.forced = true; child.kill("SIGKILL"); await bounded(ended, "fulfillment_seed_forced_close_deadline", 10_000); }
  if (primary) throw primary;
  if (!source || evidence.forced || evidence.exitCode !== 0 || evidence.signal || !evidence.resourcesClosed) throw new Error("fulfillment_seed_not_normally_closed");
  return { source, evidence };
}

async function session(page: Page) {
  const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200);
  const value = ErpSessionViewSchema.parse(await response.json()), original = actors().operator;
  expect(value.authenticated).toBe(true); expect(value.userId).toBe(original.userId); expect(value.tenantId).toBe(original.tenantId);
  return value;
}
function ownedFacts(source: Source, context: TenantContext) {
  requireFulfillmentCommandEnvironment(process.env, "current", true);
  const database = connectDatabase(isolated.url);
  let closed = false;
  async function snapshot() {
    return withTenant(database.db, context, async tx => {
      const [identity] = await tx.execute<{ application: boolean }>(sql`select current_user='yummyai_app' as application`);
      if (!identity?.application) throw new Error("fulfillment_browser_nonowner_role_required");
      const values: Record<string, { count: number; sha256: string }> = {};
      for (const name of ["orders", "order_lines", "order_events", "order_work_items", "order_work_events", "production_orders", "production_order_versions",
        "production_milestone_events", "production_delivery_packages", "production_delivery_items", "production_delivery_feedback", "quality_inspections", "quality_inspection_groups",
        "shipments", "shipment_versions", "shipment_packages", "shipment_package_lines", "shipment_production_allocations", "shipment_version_reviews", "shipment_tracking_events", "shipment_manual_confirmations"]) {
        const [value] = await tx.execute<{ count: number; canonical: string }>(sql`select count(*)::int as count,
          coalesce(string_agg(row_to_json(r)::text,E'\n' order by row_to_json(r)::text),'') as canonical from ${sql.identifier(name)} r`);
        if (!value) throw new Error("fulfillment_browser_original_projection_missing"); values[name] = { count: value.count, sha256: sha(value.canonical) };
      }
      return values;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function withdrawPii() {
    const actor = actors().operator;
    const prior = await withTenant(database.db, context, async tx => {
      const links = await tx.select({ id: membershipRoles.roleId }).from(membershipRoles).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
        .where(and(eq(membershipRoles.membershipId, actor.membershipId), eq(memberships.userId, actor.userId), eq(memberships.status, "active")));
      if (links.length !== 1 || links[0]?.id !== actor.roleId) throw new Error("fulfillment_browser_exact_original_role_required");
      const [row] = await tx.select().from(roles).where(eq(roles.id, actor.roleId)).for("update");
      if (!row || !row.permissions.includes(Permission.OrderPiiRead)) throw new Error("fulfillment_browser_original_pii_permission_required");
      const permissions = row.permissions.filter(bit => bit !== Permission.OrderPiiRead), scope = z.enum(["self", "team", "tenant"]).parse(row.dataScope);
      const changed = await tx.update(roles).set({ permissions }).where(and(eq(roles.id, actor.roleId), eq(roles.dataScope, scope),
        sql`${roles.permissions}=${JSON.stringify(row.permissions)}::jsonb`)).returning({ id: roles.id });
      if (changed.length !== 1) throw new Error("fulfillment_browser_withdraw_cas_failed");
      return { permissions: row.permissions, scope, changedPermissions: permissions };
    });
    let restored = false;
    return { restore: async () => {
      if (restored) return;
      const changed = await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: prior.permissions, dataScope: prior.scope }).where(and(
        eq(roles.id, actor.roleId), eq(roles.dataScope, prior.scope), sql`${roles.permissions}=${JSON.stringify(prior.changedPermissions)}::jsonb`)).returning({ id: roles.id }));
      if (changed.length !== 1) throw new Error("fulfillment_browser_restore_cas_failed"); restored = true;
    }, get restored() { return restored; } };
  }
  return { source, snapshot, withdrawPii, close: async () => { if (!closed) { await database.client.end(); closed = true; } }, get closed() { return closed; } };
}

const AuditSchema = z.object({ key: z.string(), documentKey: z.string(), revision: z.number().int(), method: z.string(), urlHash: z.string(), urlKey: z.string(),
  authorityHash: z.string().nullable(), startedAt: z.number(), resolvedAt: z.number().nullable(), status: z.number().nullable(), echoHash: z.string().nullable(),
  bytes: z.number(), reads: z.number(), eofAt: z.number().nullable(), consumedAt: z.number().nullable(), consumedBy: z.enum(["json", "text", "arrayBuffer"]).nullable(),
  cancelledAt: z.number().nullable(), signalAbortAt: z.number().nullable(), signalAbortedAtResolve: z.boolean(), signalAbortedAtEnd: z.boolean(),
  errorAt: z.number().nullable(), errorName: z.enum(["AbortError", "TypeError", "SyntaxError", "Other"]).nullable() }).strict();
type ReadAudit = z.infer<typeof AuditSchema>;
function urlKey(raw: string) {
  const url = new URL(raw), values = [...url.searchParams];
  if (new Set(values.map(([key]) => key)).size !== values.length) return null;
  url.searchParams.delete("_rsc");
  return sha(JSON.stringify({ origin: url.origin, path: url.pathname, query: [...url.searchParams].sort(([a], [b]) => a.localeCompare(b)) }));
}
type Wire = { request: Request; ordinal: number; path: string; method: string; urlHash: string; urlKey: string | null; bodyHash: string | null;
  authorityHash: string | null; echoHash: string | null; document: number; at: number; terminalAt: number | null; status: number | null;
  finished: boolean; failure: "ERR_ABORTED" | "ERR_FAILED" | "Other" | null; prefetch: boolean; rsc: boolean; resourceType: string; navigation: boolean;
  timing: { startTime: number; requestStart: number; responseStart: number; responseEnd: number }; classification?: string };
type Control = { name: string; start: number; end: number | null; transition?: { previous: string; next: string; denied: boolean;
  piiOnly: true; oldDocument: number; newDocument: number; privateClearedAt: number | null } };
async function observe(page: Page, source: Source) {
  const rows: Wire[] = [], raw = new Map<Request, Wire>(), audits = new Map<string, ReadAudit>(), pending: Promise<unknown>[] = [];
  const controls: Control[] = [], sessions: Array<{ document: number; at: number; authorityHash: string }> = [];
  const authorityViews = new Map<string, Awaited<ReturnType<typeof session>>>();
  const documents: Array<{ generation: number; request: Request; domAt: number | null }> = [];
  const links: Array<{ document: number; at: number; key: string; path: string }> = [];
  const projectPins: Array<{ document: number; ordinal: number; projectId: string }> = [];
  const lifecycleReads: Array<{ ordinal: number; id: string; requestId: string; requestChecksum: string; kind: FulfillmentCommandKind;
    status: "succeeded" | "acknowledged"; receiptSha256: string | null }> = [];
  const originalActionViews = new Map<number, FulfillmentCommandView>();
  const replacedReads: Array<{ ordinal: number; auditKey: string; pairing: "positive_cdp" | "zero_cdp_unique_request_time";
    successorOrdinal: number; successorAuditKey: string; control: string; document: number; documentOrdinal: number;
    authorityHash: string; lifecycleOrdinal: number; lifecycleId: string; lifecycleKind: FulfillmentCommandKind;
    originalSignalAbortAt: number; originalErrorAt: number; successorCompletedAt: number }> = [];
  const withdrawnReads: Array<{ ordinal: number; auditKey: string; queryKind: "original_order_exceptions_all_page_1" | "original_order_production_commands";
    oldDocumentOrdinal: number; newDocumentOrdinal: number; sessionOrdinal: number; previousAuthority: string; nextAuthority: string;
    signalAbortAt: number; errorAt: number; privateClearedAt: number; observation: "cancelled_zero_response_read_without_EOF_or_successor" }> = [];
  const originalReadChains: Array<{ ordinal: number; control: string; documentOrdinal: number; authorityHash: string; intentId: string;
    requestId: string; requestChecksum: string; receiptSha256: string;
    lifecycle: Array<{ ordinal: number; phase: "succeeded" | "acknowledged"; completedAt: number }>;
    cancelled: Array<{ ordinal: number; auditKey: string; pairing: "positive_cdp" | "zero_cdp_unique_request_time";
      lifecycleOrdinal: number; signalAbortAt: number; errorAt: number; successorOrdinal: number }>;
    terminal: { ordinal: number; auditKey: string; completedAt: number; completion: "original_stream_EOF" | "original_response_consumer" } }> = [];
  const errors: Array<{ kind: "console" | "page"; at: number; messageHash: string; sourceUrlHash: string | null; resourceFailure: boolean }> = [];
  const intents = new Map<string, FulfillmentCommandView>(), planned = new Map<FulfillmentCommandKind, { targetId: string; acknowledge: boolean }>();
  const exceptions = new Map<Request, { kind: "lost_committed_execute" | "late_committed_execute"; view: FulfillmentCommandView; control: Control }>();
  let generation = 0;
  await page.exposeBinding("__fulfillmentObserveRead", (_binding, value: unknown) => {
    const next = AuditSchema.parse(value), prior = audits.get(next.key);
    if (!prior || prior.revision < next.revision) audits.set(next.key, next);
  });
  await page.addInitScript(() => {
    const documentKey = crypto.randomUUID(), originalFetch = window.fetch;
    let sequence = 0;
    const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
    const clock = () => performance.timeOrigin + performance.now();
    const category = (error: unknown): "AbortError" | "TypeError" | "SyntaxError" | "Other" => error instanceof Error
      ? error.name === "AbortError" ? "AbortError" : error.name === "TypeError" ? "TypeError" : error.name === "SyntaxError" ? "SyntaxError" : "Other" : "Other";
    Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: function(this: Window, ...args: Parameters<typeof fetch>) {
      const [input, init] = args, url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const operation = Reflect.apply(originalFetch, this, args);
      if (url.origin !== location.origin) return operation;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const authority = headers.get("x-yummyai-context-authority"), signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      const query = [...url.searchParams]; if (new Set(query.map(([key]) => key)).size !== query.length) return operation;
      const canonical = new URL(url); canonical.searchParams.delete("_rsc");
      const identity = Promise.all([digest(url.href), digest(JSON.stringify({ origin: canonical.origin, path: canonical.pathname,
        query: [...canonical.searchParams].sort(([a], [b]) => a.localeCompare(b)) })), authority === null ? null : digest(authority)]);
      const row: ReadAudit = { key: `${documentKey}:${++sequence}`, documentKey, revision: 0, method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        urlHash: "", urlKey: "", authorityHash: null, startedAt: clock(), resolvedAt: null, status: null, echoHash: null,
        bytes: 0, reads: 0, eofAt: null, consumedAt: null, consumedBy: null, cancelledAt: null, signalAbortAt: null,
        signalAbortedAtResolve: false, signalAbortedAtEnd: false, errorAt: null, errorName: null };
      const push = () => {
        row.revision++; const snapshot = { ...row };
        void identity.then(async ([urlHash, key, authorityHash]) => {
          const target = window as unknown as Window & { __fulfillmentObserveRead(value: ReadAudit): Promise<void> };
          await target.__fulfillmentObserveRead({ ...snapshot, urlHash, urlKey: key, authorityHash });
        }).catch(() => {});
      };
      const failed = (error: unknown) => { row.errorAt = clock(); row.errorName = category(error); push(); };
      signal?.addEventListener("abort", () => { row.signalAbortAt = clock(); push(); }, { once: true }); push();
      void operation.then((response: Response) => {
        row.resolvedAt = clock(); row.status = response.status; row.signalAbortedAtResolve = signal?.aborted ?? false;
        const echo = response.headers.get("x-yummyai-context-authority");
        if (echo !== null) void digest(echo).then(value => { row.echoHash = value; push(); });
        push();
        const stream = response.body;
        if (stream) {
          const getReader = stream.getReader;
          Object.defineProperty(stream, "getReader", { configurable: true, value: function(this: ReadableStream, ...parameters: unknown[]) {
            const reader = Reflect.apply(getReader, this, parameters), read = reader.read, cancel = reader.cancel;
            Object.defineProperty(reader, "read", { configurable: true, value: function(this: ReadableStreamDefaultReader<Uint8Array>, ...values: unknown[]) {
              const result: Promise<ReadableStreamReadResult<Uint8Array>> = Reflect.apply(read, this, values);
              void result.then(value => {
                if (value.done) { row.eofAt = clock(); row.signalAbortedAtEnd = signal?.aborted ?? false; }
                else { row.reads++; row.bytes += value.value.byteLength; }
                push();
              }, failed); return result;
            } });
            Object.defineProperty(reader, "cancel", { configurable: true, value: function(this: ReadableStreamDefaultReader<Uint8Array>, ...values: unknown[]) {
              row.cancelledAt = clock(); push(); return Reflect.apply(cancel, this, values);
            } }); return reader;
          } });
        }
        for (const method of ["json", "text", "arrayBuffer"] as const) {
          const consume = response[method];
          Object.defineProperty(response, method, { configurable: true, value: function(this: Response) {
            const result: Promise<unknown> = Reflect.apply(consume, this, []);
            void result.then(() => { row.consumedAt = clock(); row.consumedBy = method; row.signalAbortedAtEnd = signal?.aborted ?? false; push(); }, failed); return result;
          } });
        }
      }, failed);
      return operation;
    } });
  });
  page.on("request", request => {
    if (request.isNavigationRequest() && request.resourceType() === "document" && request.frame() === page.mainFrame()) {
      generation++; documents.push({ generation, request, domAt: null });
    }
    const headers = request.headers(), body = request.postDataBuffer(), url = new URL(request.url());
    const row: Wire = { request, ordinal: rows.length + 1, path: url.pathname, method: request.method(), urlHash: sha(url.href), urlKey: urlKey(url.href),
      bodyHash: body ? sha(body) : null, authorityHash: headers["x-yummyai-context-authority"] ? sha(headers["x-yummyai-context-authority"]!) : null, echoHash: null,
      document: generation, at: Date.now(), terminalAt: null, status: null, finished: false, failure: null,
      prefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", resourceType: request.resourceType(), navigation: request.isNavigationRequest(),
      timing: { startTime: 0, requestStart: -1, responseStart: -1, responseEnd: -1 } };
    rows.push(row); raw.set(request, row);
  });
  page.on("domcontentloaded", () => { const actual = documents.at(-1); if (actual) actual.domAt = Date.now(); });
  const terminal = (request: Request, finished: boolean) => {
    const row = raw.get(request); if (!row) return;
    row.terminalAt = Date.now(); row.finished = finished;
    const error = request.failure()?.errorText; row.failure = error ? error.includes("ERR_ABORTED") ? "ERR_ABORTED" : error.includes("ERR_FAILED") ? "ERR_FAILED" : "Other" : null;
    const timing = request.timing(); row.timing = { startTime: timing.startTime, requestStart: timing.requestStart, responseStart: timing.responseStart, responseEnd: timing.responseEnd };
  };
  page.on("requestfinished", request => terminal(request, true)); page.on("requestfailed", request => terminal(request, false));
  page.on("response", response => {
    const row = raw.get(response.request()); if (!row) return; row.status = response.status();
    row.echoHash = response.headers()["x-yummyai-context-authority"] ? sha(response.headers()["x-yummyai-context-authority"]!) : null;
    const lineRead = row.method === "GET" && row.path === `/api/order-centers/lines/${source.lineId}` && new URL(response.url()).search === "";
    const lookup = row.method === "GET" && row.path === basePath
      ? FulfillmentCommandQuerySchema.safeParse(Object.fromEntries(new URL(response.url()).searchParams)) : null;
    const originalRead = lookup?.success && lookup.data.orderId === source.orderId;
    const originalAction = row.method === "POST" && /^\/api\/order-centers\/fulfillment-commands\/[a-f0-9-]{36}\/(?:execute|acknowledge)$/.test(row.path);
    if (response.status() === 200 && (lineRead || originalRead || originalAction)) {
      const read = response.finished().then(async failure => {
        if (failure !== null) return;
        const value: unknown = await response.json();
        if (lineRead) {
          const actual = OrderWorkDetailViewSchema.parse(value);
          if (actual.line.id !== source.lineId || actual.line.orderId !== source.orderId) throw new Error("fulfillment_browser_original_project_source_mismatch");
          if (actual.line.editorProjectId) projectPins.push({ document: row.document, ordinal: row.ordinal, projectId: actual.line.editorProjectId });
        } else {
          const values = originalRead ? FulfillmentCommandListSchema.parse(value).items : [FulfillmentCommandViewSchema.parse(value)];
          for (const actual of values) {
            if (actual.orderId !== source.orderId || !actual.lineIds.includes(source.lineId)) throw new Error("fulfillment_browser_original_lifecycle_source_mismatch");
            if (originalAction) originalActionViews.set(row.ordinal, actual);
            if (actual.status === "succeeded" || actual.status === "acknowledged") lifecycleReads.push({ ordinal: row.ordinal, id: actual.id,
              requestId: actual.requestId, requestChecksum: actual.requestChecksum, kind: actual.kind, status: actual.status,
              receiptSha256: actual.receipt ? sha(JSON.stringify(actual.receipt)) : null });
          }
        }
      });
      void read.catch(() => {}); pending.push(read);
    }
  });
  page.on("console", message => { if (message.type() === "error") errors.push({ kind: "console", at: Date.now(), messageHash: sha(message.text()),
    sourceUrlHash: message.location().url ? sha(message.location().url) : null, resourceFailure: /^Failed to load resource: (?:net::ERR_(?:ABORTED|FAILED)|the server responded with a status of (?:403|404|409))/.test(message.text()) }); });
  page.on("pageerror", error => errors.push({ kind: "page", at: Date.now(), messageHash: sha(error.message), sourceUrlHash: null, resourceFailure: false }));
  const pair = (row: Wire) => {
    const candidates = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash && value.authorityHash === row.authorityHash
      && row.timing.startTime > 0 && Math.abs(value.startedAt - row.timing.startTime) < 5);
    if (candidates.length !== 1) return null;
    const value = candidates[0]!;
    if (rows.filter(other => other.method === value.method && other.urlHash === value.urlHash && other.authorityHash === value.authorityHash
      && other.request.timing().startTime > 0 && Math.abs(other.request.timing().startTime - value.startedAt) < 5).length !== 1) return null;
    return value;
  };
  const complete = (row: Wire) => {
    const audit = pair(row), end = audit?.eofAt ?? audit?.consumedAt;
    return Boolean(audit && end && audit.status === row.status && row.status !== null && !audit.signalAbortedAtResolve && !audit.signalAbortedAtEnd
      && (audit.signalAbortAt === null || audit.signalAbortAt > end) && (audit.cancelledAt === null || audit.cancelledAt > end)
      && (audit.errorAt === null || audit.errorAt > end) && (audit.eofAt !== null ? audit.bytes > 0 && audit.reads > 0 : audit.consumedBy !== null)
      && (row.authorityHash === null || audit.echoHash === row.authorityHash && row.echoHash === row.authorityHash));
  };
  const zeroResponseAbort = (audit: ReadAudit) => audit.status === null && audit.resolvedAt === null && audit.echoHash === null
    && audit.bytes === 0 && audit.reads === 0 && audit.eofAt === null && audit.consumedAt === null && audit.consumedBy === null
    && audit.cancelledAt === null && audit.signalAbortAt !== null && audit.errorAt !== null && audit.errorName === "AbortError"
    && audit.startedAt <= audit.signalAbortAt && audit.signalAbortAt <= audit.errorAt;
  const zeroCdp = (row: Wire) => row.timing.startTime === 0 && row.timing.requestStart === -1 && row.timing.responseStart === -1 && row.timing.responseEnd === -1;
  function abortedPair(row: Wire) {
    const positive = pair(row); if (positive) return { audit: positive, pairing: "positive_cdp" as const };
    if (!zeroCdp(row) || row.status !== null || row.failure !== "ERR_ABORTED" || row.terminalAt === null) return null;
    const candidates = [...audits.values()].filter(value => value.method === row.method && value.urlHash === row.urlHash
      && value.authorityHash === row.authorityHash && zeroResponseAbort(value) && Math.abs(value.startedAt - row.at) < 15
      && value.errorAt !== null && Math.abs(value.errorAt - row.terminalAt!) < 50);
    if (candidates.length !== 1) return null;
    const audit = candidates[0]!;
    const requests = rows.filter(other => other.method === audit.method && other.urlHash === audit.urlHash && other.authorityHash === audit.authorityHash
      && (other.timing.startTime > 0 ? Math.abs(other.timing.startTime - audit.startedAt) < 5 : zeroCdp(other) && Math.abs(other.at - audit.startedAt) < 15));
    return requests.length === 1 && requests[0] === row ? { audit, pairing: "zero_cdp_unique_request_time" as const } : null;
  }
  function replacedOriginalRead(row: Wire, window: Control, documentOrdinal: number, authorityHash: string) {
    const restored = window.name === "exact_role_restore_original_GET_only" && window.transition?.denied === false && window.transition.piiOnly
      && window.transition.newDocument === row.document && window.transition.next === authorityHash;
    if (window.transition && !restored || !restored && !["original_package_review", "reload_original_dispatch_GET_only", "explicit_platform_attestation"].includes(window.name)
      || row.method !== "GET" || row.resourceType !== "fetch" || row.navigation || row.prefetch || row.rsc || row.bodyHash !== null
      || row.status !== null || row.echoHash !== null || row.failure !== "ERR_ABORTED") return null;
    const paths = new Set(["/api/order-centers/workspace", "/api/agent-fulfillment/workspace", `/api/order-centers/lines/${source.lineId}`,
      `/api/order-centers/lines/${source.lineId}/order-detail`, `/api/order-centers/orders/${source.orderId}/fulfillment`]);
    const projects = new Set(projectPins.filter(value => value.document === row.document).map(value => value.projectId));
    if (projects.size === 1) paths.add(`/api/production-editor/projects/${[...projects][0]!}`);
    if (!paths.has(row.path) || row.authorityHash !== null && row.authorityHash !== authorityHash
      || row.path !== "/api/order-centers/workspace" && new URL(row.request.url()).search !== ""
      || row.path === "/api/agent-fulfillment/workspace" && row.authorityHash !== authorityHash) return null;
    const paired = abortedPair(row), audit = paired?.audit;
    if (!paired || !audit || !zeroResponseAbort(audit) || audit.signalAbortAt === null || audit.errorAt === null || row.terminalAt === null
      || audit.startedAt < window.start || audit.errorAt > (window.end ?? 0) || audit.errorAt > row.terminalAt + 5
      || !sessions.some(value => value.document === row.document && value.at <= audit.signalAbortAt! && value.authorityHash === authorityHash)
      || !sessions.some(value => value.document === row.document && value.at >= audit.errorAt! && value.at <= (window.end ?? 0) && value.authorityHash === authorityHash)) return null;
    const successor = rows.find(value => value.ordinal > row.ordinal && value.document === row.document && value.method === "GET"
      && value.urlHash === row.urlHash && value.authorityHash === row.authorityHash);
    const nextAudit = successor ? pair(successor) : null, nextEnd = nextAudit?.eofAt ?? nextAudit?.consumedAt;
    if (!successor || !nextAudit || !nextEnd || nextAudit.documentKey !== audit.documentKey || nextAudit.startedAt < audit.signalAbortAt
      || successor.at > (window.end ?? 0) || nextEnd > (window.end ?? 0) || successor.status !== 200 || !complete(successor)
      || !successor.finished && successor.failure !== "ERR_ABORTED") return null;
    const kind = restored ? "delivery_feedback" : window.name === "original_package_review" ? "shipment_review" : window.name === "explicit_platform_attestation" ? "shipment_platform_confirmation" : "shipment_dispatch";
    const events = lifecycleReads.filter(value => {
      const original = intents.get(value.id), event = rows.find(entry => entry.ordinal === value.ordinal), observed = event ? pair(event) : null;
      const end = observed?.eofAt ?? observed?.consumedAt;
      if (!original || original.kind !== kind || value.kind !== kind || value.requestId !== original.requestId || value.requestChecksum !== original.requestChecksum
        || !event || event.document !== row.document || event.at < window.start || !end || end > audit.signalAbortAt!
        || !observed || observed.documentKey !== audit.documentKey || !complete(event) || event.authorityHash !== authorityHash) return false;
      if (!restored && window.name !== "reload_original_dispatch_GET_only") return event.method === "POST" && event.path === `${basePath}/${value.id}/acknowledge`
        && event.status === 200 && value.status === "acknowledged";
      const committed = [...exceptions.values()].find(entry => entry.kind === (restored ? "late_committed_execute" : "lost_committed_execute") && entry.view.id === value.id);
      return event.method === "GET" && event.path === basePath && event.status === 200 && value.status === "succeeded"
        && committed !== undefined && value.receiptSha256 === sha(JSON.stringify(committed.view.receipt));
    });
    if (events.length !== 1) return null;
    const lifecycle = events[0]!;
    return { ordinal: row.ordinal, auditKey: audit.key, pairing: paired.pairing, successorOrdinal: successor.ordinal, successorAuditKey: nextAudit.key,
      control: window.name, document: row.document, documentOrdinal, authorityHash, lifecycleOrdinal: lifecycle.ordinal, lifecycleId: lifecycle.id,
      lifecycleKind: lifecycle.kind, originalSignalAbortAt: audit.signalAbortAt, originalErrorAt: audit.errorAt, successorCompletedAt: nextEnd };
  }
  function chainedOriginalPlatformRead(row: Wire, window: Control, documentOrdinal: number, authorityHash: string) {
    if (window.name !== "explicit_platform_attestation" || window.transition || !source.shipmentId
      || row.path !== `/api/order-centers/orders/${source.orderId}/fulfillment` || new URL(row.request.url()).search !== ""
      || row.authorityHash !== null && row.authorityHash !== authorityHash) return null;
    const originals = [...intents.values()].filter(value => value.kind === "shipment_platform_confirmation" && value.orderId === source.orderId
      && value.targetId === source.shipmentId && value.lineIds.includes(source.lineId));
    if (originals.length !== 1) return null;
    const original = originals[0]!;
    const phases = new Map<"succeeded" | "acknowledged", { ordinal: number; phase: "succeeded" | "acknowledged"; completedAt: number; auditKey: string; documentKey: string; receiptSha256: string | null }>();
    for (const value of lifecycleReads.filter(entry => entry.id === original.id)) {
      const action = rows.find(entry => entry.ordinal === value.ordinal), view = originalActionViews.get(value.ordinal), audit = action ? pair(action) : null;
      const end = audit?.eofAt ?? audit?.consumedAt;
      if (!action || !view || !audit || !end || action.document !== row.document || action.at < window.start || action.terminalAt === null
        || action.terminalAt > (window.end ?? 0) || end > (window.end ?? 0) || action.method !== "POST" || action.status !== 200 || !action.finished
        || action.bodyHash !== null || new URL(action.request.url()).search !== "" || action.authorityHash !== authorityHash || !complete(action)) continue;
      if (value.requestId !== original.requestId || value.requestChecksum !== original.requestChecksum || value.kind !== original.kind
        || view.id !== original.id || view.requestId !== original.requestId || view.requestChecksum !== original.requestChecksum || view.kind !== original.kind
        || view.orderId !== original.orderId || view.targetId !== original.targetId || view.createdAt !== original.createdAt
        || JSON.stringify([...view.lineIds].sort()) !== JSON.stringify([...original.lineIds].sort()) || view.status !== value.status) return null;
      if (view.status === "succeeded") {
        if (action.path !== `${basePath}/${original.id}/execute` || view.acknowledged || view.receipt?.kind !== "shipment_platform_confirmation"
          || view.receipt.shipmentId !== source.shipmentId || value.receiptSha256 !== sha(JSON.stringify(view.receipt))) return null;
      } else if (view.status === "acknowledged") {
        if (action.path !== `${basePath}/${original.id}/acknowledge` || !view.acknowledged || view.receipt !== null || view.summary !== null || value.receiptSha256 !== null) return null;
      } else return null;
      if (phases.has(view.status)) return null;
      phases.set(view.status, { ordinal: action.ordinal, phase: view.status, completedAt: end, auditKey: audit.key, documentKey: audit.documentKey, receiptSha256: value.receiptSha256 });
    }
    const succeeded = phases.get("succeeded"), acknowledged = phases.get("acknowledged");
    if (!succeeded || !acknowledged || !succeeded.receiptSha256 || succeeded.ordinal >= acknowledged.ordinal
      || succeeded.completedAt >= acknowledged.completedAt || succeeded.documentKey !== acknowledged.documentKey) return null;
    const stages = [succeeded, acknowledged], used = new Set<"succeeded" | "acknowledged">();
    const cancelled: (typeof originalReadChains)[number]["cancelled"] = [];
    let currentRead = row;
    // One original operation exposes succeeded then acknowledged. Each cancelled
    // read must consume a distinct completed phase, so business phase progression
    // bounds this chain. Never skip an intervening same-URL original request.
    for (;;) {
      const paired = abortedPair(currentRead), audit = paired?.audit;
      if (!paired || !audit || !zeroResponseAbort(audit) || audit.signalAbortAt === null || audit.errorAt === null || currentRead.terminalAt === null
        || currentRead.method !== "GET" || currentRead.resourceType !== "fetch" || currentRead.navigation || currentRead.prefetch || currentRead.rsc
        || currentRead.status !== null || currentRead.bodyHash !== null || currentRead.echoHash !== null || currentRead.failure !== "ERR_ABORTED"
        || currentRead.at < window.start || currentRead.terminalAt > (window.end ?? 0) || audit.startedAt < window.start || audit.errorAt > (window.end ?? 0)
        || audit.documentKey !== succeeded.documentKey || audit.startedAt < succeeded.completedAt
        || !sessions.some(value => value.document === row.document && value.at <= audit.signalAbortAt! && value.authorityHash === authorityHash)
        || !sessions.some(value => value.document === row.document && value.at >= audit.errorAt! && value.at <= (window.end ?? 0) && value.authorityHash === authorityHash)) return null;
      const stage = stages.filter(value => value.completedAt <= audit.signalAbortAt!).at(-1);
      if (!stage || used.has(stage.phase) || !cancelled.length && stage.phase !== "succeeded") return null;
      used.add(stage.phase);
      const successor = rows.find(value => value.ordinal > currentRead.ordinal && value.document === row.document && value.method === "GET"
        && value.urlHash === row.urlHash && value.authorityHash === row.authorityHash);
      if (!successor || successor.at > (window.end ?? 0)) return null;
      const successorAudit = successor.status === 200 ? pair(successor) : abortedPair(successor)?.audit;
      if (!successorAudit || successorAudit.documentKey !== audit.documentKey || successorAudit.startedAt < audit.signalAbortAt) return null;
      cancelled.push({ ordinal: currentRead.ordinal, auditKey: audit.key, pairing: paired.pairing, lifecycleOrdinal: stage.ordinal,
        signalAbortAt: audit.signalAbortAt, errorAt: audit.errorAt, successorOrdinal: successor.ordinal });
      const end = successorAudit.eofAt ?? successorAudit.consumedAt;
      if (successor.status === 200 && end && complete(successor) && (successor.finished || successor.failure === "ERR_ABORTED")) {
        if (end > (window.end ?? 0) || end < acknowledged.completedAt) return null;
        return { ordinal: row.ordinal, control: window.name, documentOrdinal, authorityHash, intentId: original.id,
          requestId: original.requestId, requestChecksum: original.requestChecksum, receiptSha256: succeeded.receiptSha256,
          lifecycle: stages.map(value => ({ ordinal: value.ordinal, phase: value.phase, completedAt: value.completedAt })), cancelled,
          terminal: { ordinal: successor.ordinal, auditKey: successorAudit.key, completedAt: end,
            completion: successorAudit.eofAt !== null ? "original_stream_EOF" as const : "original_response_consumer" as const } };
      }
      currentRead = successor;
    }
  }
  function withdrawnOriginalRead(row: Wire, window: Control) {
    const transition = window.transition;
    if (window.name !== "permission_change_after_committed_delivery_response" || !transition?.denied || !transition.piiOnly || transition.privateClearedAt === null
      || row.document !== transition.oldDocument || row.method !== "GET" || row.resourceType !== "fetch" || row.navigation || row.prefetch || row.rsc
      || row.status !== null || row.authorityHash !== null || row.echoHash !== null || row.bodyHash !== null || row.failure !== "ERR_ABORTED") return null;
    const url = new URL(row.request.url());
    const exceptionsRead = row.path === `/api/order-exceptions/${source.orderId}` && url.searchParams.size === 2
      && url.searchParams.get("status") === "all" && url.searchParams.get("page") === "1";
    const commandsRead = row.path === "/api/order-centers/production-commands" && url.searchParams.size === 1 && url.searchParams.get("orderId") === source.orderId;
    if (!exceptionsRead && !commandsRead) return null;
    const paired = abortedPair(row), audit = paired?.audit;
    if (!audit || !zeroResponseAbort(audit) || audit.signalAbortAt === null || audit.errorAt === null || row.terminalAt === null
      || audit.startedAt < window.start || audit.errorAt > (window.end ?? 0) || transition.privateClearedAt > (window.end ?? 0)) return null;
    const original = documents.find(value => value.generation === transition.oldDocument), oldRow = original ? raw.get(original.request) : undefined;
    const navigations = documents.filter(value => { const request = raw.get(value.request); return request && request.at >= window.start && request.at <= (window.end ?? 0); });
    if (navigations.length !== 1) return null;
    const fresh = navigations[0]!, freshRow = raw.get(fresh.request);
    if (!original || !oldRow || oldRow.status !== 200 || !oldRow.finished || original.domAt === null || original.domAt > row.at
      || !freshRow || fresh.generation !== transition.newDocument || freshRow.status !== 200 || !freshRow.finished || fresh.domAt === null
      || freshRow.path !== "/production" || freshRow.urlHash !== oldRow.urlHash || freshRow.at > audit.signalAbortAt
      || fresh.domAt < audit.errorAt || transition.privateClearedAt < fresh.domAt) return null;
    const oldAuthority = new Set(sessions.filter(value => value.document === row.document && value.at < row.at).map(value => value.authorityHash));
    const newAuthority = new Set(sessions.filter(value => value.document === fresh.generation && value.at >= fresh.domAt! && value.at <= (window.end ?? 0)).map(value => value.authorityHash));
    if (oldAuthority.size !== 1 || !oldAuthority.has(transition.previous) || newAuthority.size !== 1 || !newAuthority.has(transition.next)
      || transition.previous === transition.next) return null;
    const originalSession = rows.filter(value => value.document === row.document && value.path === "/api/erp-auth/session" && value.method === "GET"
      && new URL(value.request.url()).search === "" && value.at >= window.start && value.at <= row.at && value.status === 200 && complete(value)
      && pair(value)?.documentKey === audit.documentKey && (pair(value)?.consumedAt ?? Infinity) <= audit.signalAbortAt!);
    if (originalSession.length !== 1) return null;
    return { ordinal: row.ordinal, auditKey: audit.key, queryKind: exceptionsRead ? "original_order_exceptions_all_page_1" as const : "original_order_production_commands" as const,
      oldDocumentOrdinal: oldRow.ordinal, newDocumentOrdinal: freshRow.ordinal, sessionOrdinal: originalSession[0]!.ordinal,
      previousAuthority: transition.previous, nextAuthority: transition.next, signalAbortAt: audit.signalAbortAt, errorAt: audit.errorAt,
      privateClearedAt: transition.privateClearedAt, observation: "cancelled_zero_response_read_without_EOF_or_successor" as const };
  }
  async function sampleLinks() {
    const hrefs = await page.locator("a[href]").evaluateAll(elements => elements.map(element => element.getAttribute("href")).filter(value => value !== null));
    const origin = new URL(page.url()).origin;
    for (const href of hrefs) {
      const url = new URL(href, page.url()); if (url.origin !== origin) continue;
      const key = urlKey(url.href); if (key && !links.some(value => value.document === generation && value.key === key))
        links.push({ document: generation, at: Date.now(), key, path: url.pathname });
    }
  }
  async function current() {
    const value = await session(page), authorityHash = sha(erpSessionAuthority(value));
    authorityViews.set(authorityHash, value); sessions.push({ document: generation, at: Date.now(), authorityHash });
    await sampleLinks(); return value;
  }
  async function stable() {
    await expect.poll(() => rows.filter(row => row.terminalAt === null && !(row.method === "GET" && complete({ ...row, timing: row.request.timing() }))).length,
      { timeout: 20_000, message: "Every original request must terminate or have its own completed reader evidence" }).toBe(0);
    await Promise.all(pending); await sampleLinks();
  }
  function start(name: string) { const control: Control = { name, start: Date.now(), end: null }; controls.push(control); return control; }
  async function control<T>(name: string, operation: () => Promise<T>) {
    const window = start(name);
    try { const value = await operation(); await stable(); await current(); return value; }
    finally { window.end = Date.now(); }
  }
  async function focusChanged(control: Control, denied: boolean, previous: string) {
    await sampleLinks();
    const oldDocument = generation, prior = authorityViews.get(previous);
    if (!prior) throw new Error("fulfillment_authority_prior_session_not_observed");
    const navigation = page.waitForRequest(request => request.isNavigationRequest() && request.resourceType() === "document"
      && request.frame() === page.mainFrame() && new URL(request.url()).pathname === (source.shipmentId ? "/shipments" : "/production"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const documentRequest = await navigation, response = await documentRequest.response();
    expect(response?.status()).toBe(200); expect(await response?.finished()).toBeNull(); await page.waitForLoadState("domcontentloaded");
    const document = documents.find(value => value.request === documentRequest);
    if (!document) throw new Error("fulfillment_authority_document_not_observed");
    await expect.poll(() => document.domAt).not.toBeNull();
    await expect.poll(() => raw.get(documentRequest)?.finished).toBe(true);
    const observed = await current(); expect(generation).toBe(document.generation);
    expect(prior.permissions.includes(Permission.OrderPiiRead)).toBe(denied);
    expect(observed.permissions.includes(Permission.OrderPiiRead)).toBe(!denied);
    const withoutPii = (value: Awaited<ReturnType<typeof session>>) => erpSessionAuthority({ ...value,
      permissions: value.permissions.filter(bit => bit !== Permission.OrderPiiRead),
      permissionScopes: value.permissionScopes && Object.fromEntries(Object.entries(value.permissionScopes).filter(([bit]) => bit !== Permission.OrderPiiRead)) });
    expect(withoutPii(observed)).toBe(withoutPii(prior));
    const next = sha(erpSessionAuthority(observed)); expect(next).not.toBe(previous);
    control.transition = { previous, next, denied, piiOnly: true, oldDocument, newDocument: document.generation, privateClearedAt: null };
    return observed;
  }
  async function check() {
    await stable();
    const sourcePaths = new Set(["/api/order-centers/options", "/api/order-centers/workspace", `/api/order-centers/lines/${source.lineId}`,
      `/api/order-centers/lines/${source.lineId}/order-detail`, `/api/order-centers/lines/${source.lineId}/operations`,
      `/api/order-centers/lines/${source.lineId}/summary`, `/api/order-centers/lines/${source.lineId}/whole-fulfillment`,
      `/api/order-centers/orders/${source.orderId}/fulfillment`, "/api/order-centers/deliveries", `/api/order-centers/deliveries/${source.packageId}`, basePath,
      ...[...intents.keys()].map(id => `${basePath}/${id}`)]);
    for (const row of rows) {
      const timing = row.request.timing(); row.timing = { startTime: timing.startTime, requestStart: timing.requestStart, responseStart: timing.responseStart, responseEnd: timing.responseEnd };
      const window = controls.find(value => value.end !== null && row.at >= value.start && (row.terminalAt ?? row.at) <= value.end);
      const exception = exceptions.get(row.request), document = documents.find(value => value.generation === row.document), documentRow = document ? raw.get(document.request) : undefined;
      const actualDocument = Boolean(documentRow?.status === 200 && documentRow.finished && document?.domAt !== null && document?.domAt !== undefined && document.domAt <= row.at);
      const personal = new Set(sessions.filter(value => value.document === row.document && value.at <= (window?.end ?? 0)).map(value => value.authorityHash));
      if (exception) {
        expect(row.method).toBe("POST"); expect(row.path).toBe(`${basePath}/${exception.view.id}/execute`); expect(row.bodyHash).toBeNull();
        expect(exception.view.status).toBe("succeeded"); expect(exception.view.receipt).not.toBeNull();
        if (exception.kind === "lost_committed_execute") { expect(row.failure).toBe("ERR_FAILED"); row.classification = "lost_exact_successful_execute_response"; }
        else {
          expect(exception.control.transition?.denied).toBe(true); expect(exception.control.transition?.previous).toBe(row.authorityHash);
          expect(exception.control.transition?.next).not.toBe(row.authorityHash);
          expect(documents.filter(value => { const entry = raw.get(value.request); return entry && entry.at >= exception.control.start && entry.at <= (exception.control.end ?? 0) && entry.status === 200 && entry.finished; })).toHaveLength(1);
          expect(row.failure === "ERR_ABORTED" || row.failure === "ERR_FAILED" || row.finished).toBe(true); row.classification = "late_exact_success_response_obsolete_after_authority_navigation";
        }
        continue;
      }
      if (row.status !== null && row.status >= 400) {
        const denied = window?.transition?.denied && row.method === "GET" && [403, 404].includes(row.status) && sourcePaths.has(row.path)
          && (row.authorityHash === null || row.authorityHash === window.transition.next) && complete(row)
          && rows.some(original => original.at < window.start && original.method === "GET" && original.urlHash === row.urlHash && original.status === 200 && (original.finished || complete(original)));
        if (denied) row.classification = "exact_current_pii_refusal_in_controlled_authority_change";
        else continue;
      } else if (row.finished) row.classification = "request_finished";
      else if (row.failure === "ERR_ABORTED" && row.status === 200 && complete(row)) row.classification = "original_reader_completed_before_driver_terminal_abort";
      else if (row.failure === "ERR_ABORTED" && row.method === "GET" && row.resourceType === "fetch" && !row.navigation && row.prefetch && row.rsc
        && row.status === 200 && row.authorityHash === null && row.echoHash === null && row.timing.startTime > 0 && row.timing.requestStart >= 0
        && row.timing.responseStart >= 0 && row.timing.responseEnd >= row.timing.responseStart && window && actualDocument && personal.size === 1
        && row.urlKey && links.some(link => link.document === row.document && link.key === row.urlKey && link.at <= (window.end ?? 0)))
        row.classification = "literal_same_document_prefetch_cancelled_after_200";
      else if (window && actualDocument && documentRow && personal.size === 1) {
        const withdrawal = withdrawnOriginalRead(row, window);
        if (withdrawal) { withdrawnReads.push(withdrawal); row.classification = "exact_zero_response_read_cancelled_during_same_person_pii_withdrawal"; }
        else {
          const replacement = replacedOriginalRead(row, window, documentRow.ordinal, [...personal][0]!);
          if (replacement) { replacedReads.push(replacement); row.classification = "unique_signal_aborted_zero_response_read_replaced_after_original_lifecycle"; }
          else {
            const chain = chainedOriginalPlatformRead(row, window, documentRow.ordinal, [...personal][0]!);
            if (chain) { originalReadChains.push(chain); row.classification = "original_platform_read_cancelled_in_phase_bounded_replacement_chain"; }
          }
        }
      }
    }
    const unknown = rows.filter(row => !row.classification);
    const rejectedErrors = errors.filter(error => !error.resourceFailure || error.kind === "page" || !rows.some(row => row.classification !== "request_finished"
      && row.classification !== undefined && error.sourceUrlHash === row.urlHash && row.terminalAt !== null && Math.abs(error.at - row.terminalAt) < 2000));
    const writes = rows.filter(row => row.method !== "GET" && row.method !== "HEAD" && row.path.startsWith("/api/"));
    for (const row of writes) {
      expect(new URL(row.request.url()).search).toBe("");
      if (!exceptions.has(row.request)) expect(row.authorityHash).toBe(row.echoHash);
      if (row.path === basePath && row.method === "POST") {
        const command = PrepareFulfillmentCommandSchema.parse(row.request.postDataJSON()), plan = planned.get(command.kind);
        expect(plan).toBeDefined(); expect(command.targetId).toBe(plan?.targetId); expect(row.authorityHash).not.toBeNull();
        const expected = [...intents.values()].find(value => value.requestId === command.requestId);
        expect(expected?.requestChecksum).toBe(sha(fulfillmentCommandCanonicalJson(command)));
      } else {
        const match = /^\/api\/order-centers\/fulfillment-commands\/([a-f0-9-]{36})\/(execute|acknowledge)$/.exec(row.path), original = match ? intents.get(match[1]!) : undefined;
        expect(row.method).toBe("POST"); expect(original).toBeDefined(); expect(row.bodyHash).toBeNull();
        expect(match?.[2] === "execute" || match?.[2] === "acknowledge" && original && planned.get(original.kind)?.acknowledge).toBe(true);
      }
    }
    for (const [kind, plan] of planned) {
      const values = [...intents.values()].filter(value => value.kind === kind); expect(values).toHaveLength(1);
      const value = values[0]!;
      expect(writes.filter(row => row.path === basePath && PrepareFulfillmentCommandSchema.parse(row.request.postDataJSON()).kind === kind)).toHaveLength(1);
      expect(writes.filter(row => row.path === `${basePath}/${value.id}/execute`)).toHaveLength(1);
      expect(writes.filter(row => row.path === `${basePath}/${value.id}/acknowledge`)).toHaveLength(plan.acknowledge ? 1 : 0);
    }
    expect(unknown.map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path, status: row.status, failure: row.failure }))).toEqual([]);
    expect(rejectedErrors).toEqual([]);
  }
  return { rows, controls, control, start, current, stable, focusChanged, sampleLinks, check,
    plan(kind: FulfillmentCommandKind, targetId: string) { if (planned.has(kind)) throw new Error("fulfillment_browser_duplicate_new_operation"); planned.set(kind, { targetId, acknowledge: false }); },
    register(value: FulfillmentCommandView) { expect(value.orderId).toBe(source.orderId); expect(value.lineIds).toContain(source.lineId); intents.set(value.id, value); },
    acknowledge(value: FulfillmentCommandView) { const plan = planned.get(value.kind); if (!plan) throw new Error("fulfillment_browser_unplanned_ack"); plan.acknowledge = true; },
    exceptional(request: Request, kind: "lost_committed_execute" | "late_committed_execute", view: FulfillmentCommandView, control: Control) { exceptions.set(request, { kind, view, control }); },
    proof() { return { requests: rows.map(({ request: _request, ...value }) => { void _request; return value; }), readAudit: [...audits.values()], controls, sessions,
      sessionObservation: "actual_independent_current_session_read_not_original_browser_response_body_or_EOF",
      controlledOriginalResponses: [...exceptions].map(([request, value]) => ({ ordinal: raw.get(request)?.ordinal ?? null, kind: value.kind, upstreamStatus: 200,
        id: value.view.id, requestId: value.view.requestId, requestChecksum: value.view.requestChecksum, receiptSha256: sha(JSON.stringify(value.view.receipt)),
        control: value.control.name, observation: "actual_route_fetch_response_json_not_browser_reader_EOF" })),
      documents: documents.map(value => ({ generation: value.generation, ordinal: raw.get(value.request)?.ordinal ?? null, domAt: value.domAt })),
      literalLinks: links, originalProjectPins: projectPins, originalLifecycleReads: lifecycleReads, replacedOriginalReads: replacedReads,
      originalReadChains, withdrawnOriginalReads: withdrawnReads, errors }; } };
}

const recovery = (page: Page) => page.getByRole("region", { name: "本单原履约提交恢复", exact: true });
const originalRow = (page: Page, id: string) => recovery(page).getByRole("article", { name: `原履约提交 ${id}`, exact: true });
async function loaded(page: Page, source: Source) {
  await expect(page.getByRole("heading", { name: source.orderNumber, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "整单详情", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(recovery(page)).toHaveAttribute("aria-busy", "false");
}
async function created(page: Page, kind: FulfillmentCommandKind, submit: () => Promise<void>) {
  const authority = erpSessionAuthority(await session(page));
  const waiting = page.waitForResponse(response => {
    if (response.request().method() !== "POST" || new URL(response.url()).pathname !== basePath) return false;
    const command = PrepareFulfillmentCommandSchema.safeParse(response.request().postDataJSON()); return command.success && command.data.kind === kind;
  });
  await submit(); const response = await waiting; expect(response.status()).toBe(201);
  expect(response.request().headers()["x-yummyai-context-authority"]).toBe(authority);
  expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const value = FulfillmentCommandViewSchema.parse(await response.json()); expect(value.kind).toBe(kind); return value;
}
async function acknowledge(page: Page, seen: Awaited<ReturnType<typeof observe>>, value: FulfillmentCommandView) {
  const row = originalRow(page, value.id); await expect(row.getByLabel("原业务履约回执", { exact: true })).toBeVisible();
  const waiting = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${basePath}/${value.id}/acknowledge`);
  seen.acknowledge(value); await row.getByRole("button", { name: "已核对本次履约结果", exact: true }).click();
  const response = await waiting; expect(response.status()).toBe(200);
  const acknowledged = FulfillmentCommandViewSchema.parse(await response.json());
  expect(acknowledged).toMatchObject({ id: value.id, requestId: value.requestId, requestChecksum: value.requestChecksum, status: "acknowledged", acknowledged: true, summary: null, receipt: null });
  await expect(row).toBeHidden();
  await expect(recovery(page)).toHaveAttribute("aria-busy", "false");
}
async function localNow(page: Page) { return page.evaluate(() => { const value = new Date(); return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }); }
async function picture(page: Page, info: TestInfo, name: string, locator: Locator) {
  await locator.scrollIntoViewIfNeeded(); await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => {
    const parents: Element[] = []; for (let value: Element | null = element; value; value = value.parentElement) parents.push(value);
    return { opaque: parents.every(value => getComputedStyle(value).opacity === "1"), animations: [...new Set([...element.getAnimations({ subtree: true }), ...parents.flatMap(value => value.getAnimations())])]
      .filter(value => value.playState === "running" && value.effect?.getComputedTiming().iterations !== Infinity).length };
  })).toEqual({ opaque: true, animations: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const path = info.outputPath(name + ".png"); await page.screenshot({ path, fullPage: false }); await info.attach(name, { path, contentType: "image/png" });
}
async function twoWidths(page: Page, info: TestInfo, anchor: Locator, prefix: string) {
  await page.setViewportSize({ width: 1440, height: 960 }); await picture(page, info, prefix + "-1440", anchor);
  await page.setViewportSize({ width: 390, height: 844 }); await picture(page, info, prefix + "-390", anchor);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expect.poll(() => anchor.evaluate(element => element.getAnimations({ subtree: true }).filter(animation => animation.playState === "running"
    && animation.effect?.getComputedTiming().iterations !== Infinity && Number(animation.effect?.getComputedTiming().duration) > 1).length)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
async function finalize(info: TestInfo, seen: Awaited<ReturnType<typeof observe>> | undefined, facts: ReturnType<typeof ownedFacts> | undefined,
  bodyFailure: unknown, details: Record<string, unknown>, restore?: () => Promise<void>) {
  const failures: unknown[] = bodyFailure ? [bodyFailure] : [];
  let networkFailed = false, cleanupFailed = false;
  try { await restore?.(); } catch (error) { cleanupFailed = true; failures.push(error); }
  try { await seen?.check(); } catch (error) { networkFailed = true; failures.push(error); }
  try { await facts?.close(); } catch (error) { cleanupFailed = true; failures.push(error); }
  const path = info.outputPath("fulfillment-command-proof.json");
  await writeFile(path, JSON.stringify({ operation: "c1e5a7b9", nonce: isolated.nonce, primaryFailure: Boolean(bodyFailure), networkFailed, cleanupFailed,
    scope: "Actual compiled personal OIDC, original fulfillment owners and receipts; explicitly synthetic initial work and physical attestations; no real carrier, factory or marketplace action",
    details, databaseClosed: facts?.closed ?? null, failures: failures.map(safeFailure), network: seen?.proof() ?? null }, null, 2) + "\n", { flag: "wx" });
  await info.attach("fulfillment-command-proof", { path, contentType: "application/json" });
  if (failures.length) throw new AggregateError(failures, "fulfillment_browser_actual_acceptance_failed");
}

test("fulfillment_shipment_disconnect_original_receipt at 1440 and 390", async ({ page }, info) => {
  let seen: Awaited<ReturnType<typeof observe>> | undefined, facts: ReturnType<typeof ownedFacts> | undefined, primary: unknown;
  const details: Record<string, unknown> = {}; let routeHandler: ((route: Route) => Promise<void>) | undefined;
  try {
    const seeded = await seed("shipment"), source = seeded.source; details.seed = seeded.evidence; details.source = source;
    if (!source.shipmentId) throw new Error("fulfillment_original_draft_shipment_missing");
    seen = await observe(page, source); const audit = seen;
    await audit.control("personal_login", async () => { await loginErp(page, "operator", `/shipments?${new URLSearchParams({ line: source.lineId, order: source.orderId })}`); await loaded(page, source); });
    const current = await session(page); facts = ownedFacts(source, TenantContextSchema.parse(current));
    const record = page.locator("article.oc-record").filter({ has: page.getByText(`发货单 ${source.shipmentId}`, { exact: true }) }); await expect(record).toHaveCount(1);
    let review!: FulfillmentCommandView;
    await audit.control("original_package_review", async () => {
      const form = record.locator('form[data-order-action="shipment-review"]'); await expect(form).toBeVisible();
      await form.getByLabel("核对说明", { exact: true }).fill("SYNTHETIC exact original package and quantity review only");
      audit.plan("shipment_review", source.shipmentId!); review = await created(page, "shipment_review", () => form.getByRole("button", { name: "审核通过", exact: true }).click()); audit.register(review);
      await expect(originalRow(page, review.id).getByLabel("原业务履约回执", { exact: true })).toBeVisible(); await acknowledge(page, audit, review);
    });
    const actual = facts, committed = latch(); let successful: FulfillmentCommandView | undefined, intercepted: Request | undefined;
    const lossWindow = audit.start("original_dispatch_response_lost");
    routeHandler = async route => {
      if (route.request().method() !== "POST" || !new URL(route.request().url()).pathname.endsWith("/execute")) { await route.continue(); return; }
      if (intercepted) throw new Error("fulfillment_second_dispatch_execute_intercepted");
      intercepted = route.request(); const response = await route.fetch(); expect(response.status()).toBe(200);
      expect(response.headers()["x-yummyai-context-authority"]).toBe(erpSessionAuthority(current));
      successful = FulfillmentCommandViewSchema.parse(await response.json()); expect(successful.kind).toBe("shipment_dispatch"); expect(successful.status).toBe("succeeded");
      expect(successful.orderId).toBe(source.orderId); expect(successful.targetId).toBe(source.shipmentId);
      audit.exceptional(intercepted, "lost_committed_execute", successful, lossWindow); await route.abort("failed"); committed.release();
    };
    await page.route("**/api/order-centers/fulfillment-commands/*/execute", routeHandler);
    const dispatchForm = record.locator('form[data-order-action="shipment-dispatch"]'); await expect(dispatchForm).toBeVisible();
    await dispatchForm.getByLabel("交运凭证 / 说明", { exact: true }).fill("SYNTHETIC physical handover attestation only no carrier transaction");
    await dispatchForm.getByLabel("实际交运时间", { exact: true }).fill(await localNow(page));
    audit.plan("shipment_dispatch", source.shipmentId);
    const dispatch = await created(page, "shipment_dispatch", () => dispatchForm.getByRole("button", { name: "确认已交运", exact: true }).click()); audit.register(dispatch);
    await bounded(committed.promise, "fulfillment_dispatch_real_success_not_observed");
    if (!successful || !intercepted) throw new Error("fulfillment_original_dispatch_receipt_missing");
    const receipt = successful.receipt; expect(receipt?.kind).toBe("shipment_dispatch");
    if (receipt?.kind !== "shipment_dispatch") throw new Error("fulfillment_exact_dispatch_receipt_required");
    expect(receipt.trackingEventIds).toHaveLength(1);
    const originalFacts = await actual.snapshot(), writeBoundary = audit.rows.length;
    await expect(recovery(page).getByText("本次执行结果待核对 只读取原记录 不换键", { exact: true })).toBeVisible();
    await audit.stable(); await audit.current(); lossWindow.end = Date.now();
    await page.unroute("**/api/order-centers/fulfillment-commands/*/execute", routeHandler); routeHandler = undefined;
    await audit.control("reload_original_dispatch_GET_only", async () => {
      await page.reload({ waitUntil: "domcontentloaded" }); await audit.current(); await loaded(page, source);
      const row = originalRow(page, dispatch.id); await expect(row.getByLabel("原业务履约回执", { exact: true })).toBeVisible();
      await row.getByRole("button", { name: "只读取这笔原提交", exact: true }).click(); await expect(recovery(page)).toHaveAttribute("aria-busy", "false");
      for (const id of receipt.trackingEventIds) await expect(row.getByText(id, { exact: true })).toBeVisible();
    });
    expect(audit.rows.slice(writeBoundary).filter(row => row.method !== "GET" && row.method !== "HEAD")
      .map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path, bodyHash: row.bodyHash, status: row.status }))).toEqual([]);
    expect(await actual.snapshot()).toEqual(originalFacts); expect(originalFacts.shipment_tracking_events?.count).toBe(1);
    await audit.control("recovered_dispatch_visual", () => twoWidths(page, info, originalRow(page, dispatch.id), "shipment-original-receipt"));
    await audit.control("explicit_dispatch_ack", () => acknowledge(page, audit, dispatch));
    await audit.control("explicit_platform_attestation", async () => {
      const currentRecord = page.locator("article.oc-record").filter({ has: page.getByText(`发货单 ${source.shipmentId}`, { exact: true }) });
      await currentRecord.locator('[data-order-action="platform-confirmation"] > summary').click();
      const form = currentRecord.locator('[data-order-action="platform-confirmation"] form');
      await form.getByLabel("平台确认时间", { exact: true }).fill(await localNow(page));
      await form.getByLabel("平台发货确认凭证", { exact: true }).fill("SYNTHETIC operator observation only no marketplace request");
      audit.plan("shipment_platform_confirmation", source.shipmentId!);
      const confirmation = await created(page, "shipment_platform_confirmation", () => form.getByRole("button", { name: "记录已在平台确认发货", exact: true }).click()); audit.register(confirmation);
      await acknowledge(page, audit, confirmation);
    });
    details.recovery = { intentId: dispatch.id, requestId: dispatch.requestId, requestChecksum: dispatch.requestChecksum, receipt,
      originalTracking: originalFacts.shipment_tracking_events, reloadAndOriginalReadBusinessWrites: 0, originalSuccessfulResponseDropped: true,
      sameOriginalReceipt: true, explicitPlatformAttestationOnly: true, modelCalls: 0, providerCalls: 0 };
  } catch (error) { primary = error; }
  finally {
    if (routeHandler) await page.unroute("**/api/order-centers/fulfillment-commands/*/execute", routeHandler).catch(error => { primary ??= error; });
    await finalize(info, seen, facts, primary, details);
  }
});

test("fulfillment_delivery_late_authority at 1440 and 390", async ({ page }, info) => {
  let seen: Awaited<ReturnType<typeof observe>> | undefined, facts: ReturnType<typeof ownedFacts> | undefined, primary: unknown;
  let mutation: Awaited<ReturnType<ReturnType<typeof ownedFacts>["withdrawPii"]>> | undefined;
  const details: Record<string, unknown> = {}, released = latch(), entered = latch(); let routeHandler: ((route: Route) => Promise<void>) | undefined, handlerDone: Promise<void> | undefined;
  try {
    const seeded = await seed("delivery"), source = seeded.source; details.seed = seeded.evidence; details.source = source;
    expect(source.shipmentId).toBeNull(); seen = await observe(page, source); const audit = seen;
    const href = `/production?${new URLSearchParams({ line: source.lineId, order: source.orderId, delivery: source.packageId })}`;
    const originalDelivery = page.waitForResponse(async response => {
      if (response.status() !== 200 || response.request().method() !== "GET") return false;
      const url = new URL(response.url());
      if (url.pathname === `/api/order-centers/deliveries/${source.packageId}` && url.search === "") return true;
      if (url.pathname !== "/api/order-centers/deliveries" || url.searchParams.size !== 1 || url.searchParams.get("order") !== source.orderId) return false;
      return ProductionDeliveryWorkspaceSchema.parse(await response.json()).packages.some(packet => packet.id === source.packageId);
    });
    await audit.control("personal_login", async () => {
      await loginErp(page, "operator", href); await loaded(page, source);
      const factory = page.getByRole("region", { name: "整单详情", exact: true }).locator("details.oc-whole-records")
        .filter({ has: page.locator("summary").filter({ hasText: /^工厂交付与回执/ }) });
      await expect(factory).toHaveCount(1);
      const wasOpen = await factory.evaluate(element => element instanceof HTMLDetailsElement && element.open);
      if (!wasOpen) await factory.locator(":scope > summary").click();
      await expect(factory).toHaveAttribute("open", "");
      await expect(page.getByRole("region", { name: "抱枕交付与工厂回执", exact: true })).toHaveAttribute("aria-busy", "false");
      await expect(page.locator(`#delivery-package-${source.packageId}`)).toBeVisible();
      details.factoryExpansion = { actualSummaryClicked: !wasOpen, originalPackageVisible: true };
    });
    const deliveryResponse = await originalDelivery, deliveryBody: unknown = await deliveryResponse.json();
    const originalPacket = new URL(deliveryResponse.url()).pathname === `/api/order-centers/deliveries/${source.packageId}`
      ? ProductionDeliveryPackageViewSchema.parse(deliveryBody)
      : ProductionDeliveryWorkspaceSchema.parse(deliveryBody).packages.find(packet => packet.id === source.packageId);
    if (!originalPacket) throw new Error("fulfillment_exact_original_delivery_package_missing");
    details.originalDeliveryRead = { path: new URL(deliveryResponse.url()).pathname, queryKind: new URL(deliveryResponse.url()).search === "" ? "none" : "exact_original_order",
      requestUrlHash: sha(deliveryResponse.url()), status: deliveryResponse.status(), packageId: originalPacket.id };
    if (originalPacket.id !== source.packageId || originalPacket.items.length !== 1 || originalPacket.items[0]?.snapshot?.orderLineId !== source.lineId
      || originalPacket.items[0].productionOrderId !== source.productionId) throw new Error("fulfillment_exact_original_delivery_item_required");
    const originalItem = originalPacket.items[0];
    const current = await session(page), originalAuthority = sha(erpSessionAuthority(current)); facts = ownedFacts(source, TenantContextSchema.parse(current));
    const packet = page.locator(`#delivery-package-${source.packageId}`); await expect(packet).toBeVisible(); await expect(packet).toHaveAttribute("open", "");
    const form = packet.getByRole("form", { name: /^登记工厂回执 / });
    await audit.control("original_optional_delivery_attestation_form", async () => {
      await packet.getByText("可选补充回执与异常处理", { exact: true }).click(); await expect(form).toBeVisible();
      await form.getByRole("combobox", { name: "回执类型", exact: true }).selectOption("received");
      await form.getByLabel("回复依据", { exact: true }).fill("SYNTHETIC-ORIGINAL-RECEIVED");
      await form.getByLabel("工厂回复与处理说明", { exact: true }).fill("SYNTHETIC optional actual-file receipt attestation not a production prerequisite");
      await form.locator('input[name="verified"]').check();
    });
    const actual = facts; let successful: FulfillmentCommandView | undefined, intercepted: Request | undefined, obsoleteFulfill = false;
    const authorityWindow = audit.start("permission_change_after_committed_delivery_response");
    routeHandler = route => {
      if (route.request().method() !== "POST" || !new URL(route.request().url()).pathname.endsWith("/execute")) return route.continue();
      const operation = (async () => {
        if (intercepted) throw new Error("fulfillment_second_delivery_execute_intercepted");
        intercepted = route.request(); const response = await route.fetch(); expect(response.status()).toBe(200);
        expect(response.headers()["x-yummyai-context-authority"]).toBe(erpSessionAuthority(current));
        successful = FulfillmentCommandViewSchema.parse(await response.json()); expect(successful.status).toBe("succeeded"); expect(successful.kind).toBe("delivery_feedback");
        expect(successful.orderId).toBe(source.orderId); entered.release(); await released.promise;
        if (!successful || !intercepted) throw new Error("fulfillment_held_original_response_missing");
        audit.exceptional(intercepted, "late_committed_execute", successful, authorityWindow);
        try { await route.fulfill({ response }); }
        catch (error) {
          if (!authorityWindow.transition?.denied || !["net::ERR_ABORTED", "net::ERR_FAILED"].includes(intercepted.failure()?.errorText ?? "")) throw error;
          obsoleteFulfill = true;
        }
      })(); handlerDone = operation; return operation;
    };
    await page.route("**/api/order-centers/fulfillment-commands/*/execute", routeHandler);
    audit.plan("delivery_feedback", originalItem.id);
    // The command target is the exact original item, not its enclosing package.
    const waiting = page.waitForResponse(response => new URL(response.url()).pathname === basePath && response.request().method() === "POST");
    await form.getByRole("button", { name: "登记回执", exact: true }).click();
    const preparedResponse = await waiting; expect(preparedResponse.status()).toBe(201);
    const preparedCommand = PrepareFulfillmentCommandSchema.parse(preparedResponse.request().postDataJSON());
    expect(preparedCommand.kind).toBe("delivery_feedback");
    if (preparedCommand.kind !== "delivery_feedback") throw new Error("fulfillment_original_feedback_command_required");
    expect(preparedCommand.packageId).toBe(source.packageId);
    expect(preparedCommand.targetId).toBe(originalItem.id); expect(preparedCommand.input.kind).toBe("received");
    expect(preparedCommand.input.fileChecksum).toBe(originalItem.snapshot?.file.checksum);
    expect(preparedCommand.input.manufacturingChecksum).toBe(originalItem.snapshot?.manufacturing?.plan.checksum);
    expect(preparedResponse.request().headers()["x-yummyai-context-authority"]).toBe(erpSessionAuthority(current));
    expect(preparedResponse.headers()["x-yummyai-context-authority"]).toBe(erpSessionAuthority(current));
    const prepared = FulfillmentCommandViewSchema.parse(await preparedResponse.json()); audit.register(prepared);
    await bounded(entered.promise, "fulfillment_real_delivery_commit_not_observed");
    if (!successful) throw new Error("fulfillment_original_delivery_success_missing");
    const committedFacts = await actual.snapshot(), writeBoundary = audit.rows.length;
    mutation = await actual.withdrawPii();
    const changed = await audit.focusChanged(authorityWindow, true, originalAuthority); expect(sha(erpSessionAuthority(changed))).not.toBe(originalAuthority);
    await expect(page.getByText("当前账号缺少读取整单资料权限", { exact: true })).toBeVisible();
    await expect(packet).toHaveCount(0); await expect(page.getByLabel("原业务履约回执", { exact: true })).toHaveCount(0);
    await expect(page.locator(".oc-delivery-checksum")).toHaveCount(0);
    if (!authorityWindow.transition?.denied) throw new Error("fulfillment_pii_withdrawal_not_observed");
    authorityWindow.transition.privateClearedAt = Date.now();
    released.release(); await bounded(handlerDone ?? Promise.reject(new Error("fulfillment_held_handler_missing")), "fulfillment_held_handler_close_deadline");
    await audit.stable(); await audit.current(); authorityWindow.end = Date.now();
    await page.unroute("**/api/order-centers/fulfillment-commands/*/execute", routeHandler); routeHandler = undefined;
    await expect(packet).toHaveCount(0); await expect(page.getByLabel("原业务履约回执", { exact: true })).toHaveCount(0);
    const restoreWindow = audit.start("exact_role_restore_original_GET_only");
    await mutation.restore(); await audit.focusChanged(restoreWindow, false, sha(erpSessionAuthority(changed))); await loaded(page, source);
    const row = originalRow(page, prepared.id); await expect(row.getByLabel("原业务履约回执", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "只读取这笔原提交", exact: true }).click(); await expect(recovery(page)).toHaveAttribute("aria-busy", "false");
    if (successful.receipt?.kind !== "delivery_feedback") throw new Error("fulfillment_exact_feedback_receipt_missing");
    await expect(row.getByText(successful.receipt.feedbackId, { exact: true })).toBeVisible();
    await audit.stable(); await audit.current(); restoreWindow.end = Date.now();
    expect(audit.rows.slice(writeBoundary).filter(value => value.method !== "GET" && value.method !== "HEAD")
      .map(row => ({ ordinal: row.ordinal, method: row.method, path: row.path, bodyHash: row.bodyHash, status: row.status }))).toEqual([]);
    expect(await actual.snapshot()).toEqual(committedFacts);
    await audit.control("restored_original_delivery_visual", () => twoWidths(page, info, row, "delivery-original-receipt"));
    details.recovery = { intentId: prepared.id, requestId: prepared.requestId, requestChecksum: prepared.requestChecksum, receipt: successful.receipt,
      withdrawnPermission: Permission.OrderPiiRead, lateOriginal200NotAdopted: true, obsoleteFulfill, exactRoleRestored: mutation.restored,
      afterCommitBusinessWrites: 0, immutableFacts: committedFacts, originalReadOnlyRecovery: true, modelCalls: 0, providerCalls: 0,
      retainedHistory: "actual_successful_feedback_and_unacknowledged_original_index_until_outer_disposable_database_teardown" };
  } catch (error) { primary = error; }
  finally {
    released.release();
    if (handlerDone) await bounded(handlerDone, "fulfillment_pending_route_cleanup_deadline").catch(error => { primary ??= error; });
    if (routeHandler) await page.unroute("**/api/order-centers/fulfillment-commands/*/execute", routeHandler).catch(error => { primary ??= error; });
    await finalize(info, seen, facts, primary, details, mutation ? () => mutation!.restore() : undefined);
  }
});
