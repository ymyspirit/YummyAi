import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Page, type TestInfo, type Request, type Locator } from "@playwright/test";
import { z } from "zod";
import { TenantContextSchema, createEntityId } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AgentCommandOriginalSchema, AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { AgentFulfillmentCallSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { agentResourceInputSchemas } from "@yummyai/contracts/ai/agent-resources";
import { AgentNativeV3BindingSchema, AgentNativeV3ViewSchema, AgentNativeV3WorkspaceSchema, AgentNativeV3ItemReceiptSchema, AgentNativeV3IntentSchema,
  AgentNativeV3PreparationIntentSchema, AGENT_NATIVE_V3_INTENT_PREFIX, AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX, type AgentNativeV3View } from "@yummyai/contracts/ai/agent-native-v3";
import { verifyAgentNativeV3Transport } from "@yummyai/contracts/ai/agent-native-v3-transport";
import { withTenant, roles, membershipRoles, memberships } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import { loginErp } from "./erp-identity-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url)), sha = (text: string) => createHash("sha256").update(text).digest("hex");
const panel = (page: Page) => page.getByRole("region", { name: "十二类原生工具模型任务", exact: true });
const evidence = (page: Page) => page.getByRole("region", { name: "十二类工具任务实际依据", exact: true });
const Seed = z.object({ bindings: z.array(AgentNativeV3BindingSchema), query: z.string(), originals: z.array(AgentCommandOriginalSchema), contextText: z.string(),
  inputs: z.object(agentResourceInputSchemas).strict(), inspectionId: z.uuidv7(), factoryId: z.uuidv7(), from: z.string(), orderId: z.uuidv7(), orderSequence: z.int().positive() }).strict();
const Stats = z.object({ modelCalls: z.int().nonnegative(), definitions: z.int().nonnegative(), reads: z.int().nonnegative(), settled: z.boolean(), entered: z.boolean(), failure: z.string().nullable() }).strict();
type Source = z.infer<typeof Seed>;
test.describe.configure({ mode: "serial" }); test.setTimeout(300_000);
function latch() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 30_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
class NativeV3Child {
  private readonly child: ChildProcess; private readonly ready: Promise<void>; private readonly ended: Promise<void>; private sequence = 0;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly evidence = { acknowledged: false, exited: false, exitCode: null as number | null, signal: null as NodeJS.Signals | null, forcedKill: false };
  constructor(private readonly nonce: string) {
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "apps/api/src/ai/agent-native-v3.test-fixture.ts"), "--agent-native-v3-browser-child"], { cwd: root, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") } });
    let accept!: () => void, reject!: (error: Error) => void; this.ready = new Promise((yes, no) => { accept = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error("native_v3_child_ready_timeout")), 30_000);
    this.ended = new Promise(done => this.child.once("exit", (exitCode, signal) => {
      clearTimeout(timer); Object.assign(this.evidence, { exited: true, exitCode, signal }); reject(new Error("native_v3_child_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("native_v3_child_exited_with_pending_request")); } this.pending.clear(); done();
    }));
    this.child.once("error", () => { clearTimeout(timer); reject(new Error("native_v3_child_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>; if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timer); accept(); return; }
      if (typeof value.id !== "number" || value.type !== "result" && value.type !== "failure") return;
      const row = this.pending.get(value.id); if (!row) return; this.pending.delete(value.id); clearTimeout(row.timer);
      if (value.type === "result") row.accept(value.value);
      else row.reject(new Error("native_v3_child_failed_" + (typeof value.phase === "string" && /^[a-z0-9_]{1,60}$/.test(value.phase) ? value.phase : "unknown") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Record<string, unknown>): Promise<unknown> {
    await this.ready; if (!this.child.connected || this.evidence.exited) throw new Error("native_v3_child_unavailable"); const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("native_v3_child_request_timeout")); }, input.operation === "close" ? 20_000 : 180_000);
      this.pending.set(id, { accept, reject, timer }); this.child.send({ ...input, nonce: this.nonce, id }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error("native_v3_child_send_failed")); } });
    });
  }
  async close() {
    const errors: unknown[] = [];
    try { if (!this.evidence.exited) { const value = z.object({ closed: z.literal(true) }).strict().parse(await this.request({ operation: "close" })); this.evidence.acknowledged = value.closed; } } catch (error) { errors.push(error); }
    try { if (this.child.connected) this.child.disconnect(); } catch (error) { errors.push(error); }
    try { await bounded(this.ended, "native_v3_child_exit_timeout", 20_000); }
    catch (error) { errors.push(error); this.evidence.forcedKill = true; this.child.kill("SIGKILL"); try { await bounded(this.ended, "native_v3_child_kill_exit_timeout", 2000); } catch (failure) { errors.push(failure); } }
    if (!this.evidence.acknowledged || !this.evidence.exited || this.evidence.exitCode !== 0 || this.evidence.signal !== null) errors.push(new Error("native_v3_child_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "NativeV3 child cleanup failed");
  }
}
async function fixture(leaf: string) {
  requireAgentReadBrowser(); const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  const flags = ["E2E_AGENT_NATIVE_V3_ISOLATED", "E2E_AGENT_NATIVE_V2_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED",
    "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED", "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED",
    "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY", "E2E_AGENT_FULFILLMENT_ISOLATED", "E2E_FACTORY_ERP_IMPORT_ISOLATED"];
  if (flags.some(key => process.env[key] !== "1") || process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || api.port !== "8130")
    throw new Error("NativeV3 browser requires the exact compiled personal disposable boundary");
  const base = await agentReadBrowserFixture("native-v3-" + leaf); let child: NativeV3Child;
  try { child = new NativeV3Child(base.nonce); } catch (error) { try { await base.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "NativeV3 browser initialization and cleanup failed"); } throw error; }
  let closed = false, auxiliaryRole: string | undefined;
  return { ...base, childClose: child.evidence,
    async seed() { return Seed.parse(await child.request({ operation: "seed", context: TenantContextSchema.parse(base.context) })); },
    execute: (runId: string, hold = false) => child.request({ operation: "execute", runId, hold }),
    async progress() { return Stats.parse(await child.request({ operation: "progress" })); },
    async wait() { return Stats.parse(await child.request({ operation: "wait" })); },
    release: () => child.request({ operation: "release" }),
    async business() { const records = z.record(z.string(), z.object({ count: z.number(), hash: z.string() }).strict());
      return z.object({ native: records, fulfillment: records, carrier: z.record(z.string(), z.int().nonnegative()), enqueues: z.tuple([z.int().nonnegative(), z.int().nonnegative()]) }).strict()
        .parse(await child.request({ operation: "business" })); },
    async piiSelf() {
      await withTenant(base.database.db, base.context, async tx => {
        const [member] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, base.context.userId), eq(memberships.status, "active")));
        if (!member) throw new Error("Actual personal member missing for PII scope transition");
        const original = await tx.select({ id: roles.id, permissions: roles.permissions }).from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id))
          .where(eq(membershipRoles.membershipId, member.id));
        for (const role of original) await tx.update(roles).set({ permissions: role.permissions.filter(bit => bit !== Permission.OrderPiiRead) }).where(eq(roles.id, role.id));
        auxiliaryRole = createEntityId(); await tx.insert(roles).values({ id: auxiliaryRole, tenantId: base.context.tenantId,
          name: "Synthetic native V3 private-scope " + auxiliaryRole, permissions: [Permission.OrderPiiRead], dataScope: "self" });
        await tx.insert(membershipRoles).values({ tenantId: base.context.tenantId, membershipId: member.id, roleId: auxiliaryRole });
      });
    },
    async state(requestId: string) { return withTenant(base.database.db, base.context, async tx => ({
      runs: Array.from(await tx.execute(sql`select id,version,request_id,status,revision,model_turns,known_cost_usd::text,unknown_cost,input_checksum,result_checksum from agent_plan_runs where owner_id=${base.context.userId}::uuid and request_id=${requestId}::uuid order by id`)),
      steps: Array.from(await tx.execute(sql`select s.id,s.sequence,s.kind,s.phase,s.submission_state,s.input_checksum,s.output_checksum,s.response_checksum,s.cost_usd::text from agent_plan_steps s join agent_plan_runs r on r.id=s.run_id and r.tenant_id=s.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by s.sequence`)),
      budgets: Array.from(await tx.execute(sql`select b.id,b.state,b.amount_usd::text from ai_budget_ledger b join agent_plan_runs r on r.id=b.request_id and r.tenant_id=b.tenant_id where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`)),
    })); },
    async close() { if (closed) return; closed = true; const errors: unknown[] = [];
      try { if (auxiliaryRole) await withTenant(base.database.db, base.context, async tx => {
        await tx.delete(membershipRoles).where(eq(membershipRoles.roleId, auxiliaryRole!)); await tx.delete(roles).where(eq(roles.id, auxiliaryRole!));
      }); } catch (error) { errors.push(error); }
      try { await base.restore(); } catch (error) { errors.push(error); }
      try { await child.close(); } catch (error) { errors.push(error); }
      try { await base.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "NativeV3 personal browser cleanup failed");
    } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function session(page: Page) { const response = await page.request.get("/api/erp-auth/session"); expect(response.status()).toBe(200); return ErpSessionViewSchema.parse(await response.json()); }
async function readRun(page: Page, id: string, seen: ReturnType<typeof observe>) {
  const authority = await seen.currentAuthority(), response = await page.request.get("/api/agent-native-v3/runs/" + id, { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); expect(response.headers()["x-yummyai-context-authority"]).toBe(authority);
  const value = AgentNativeV3ViewSchema.parse(await response.json()); expect(value.id).toBe(id); expect(value.contextAuthority).toBe(authority); await verifyAgentNativeV3Transport(value); return value;
}
async function openRun(page: Page, run: AgentNativeV3View, seen: ReturnType<typeof observe>) {
  return seen.control("read_original_run", async () => {
  const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
  if (await review.isVisible()) { await review.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(review).not.toBeVisible(); }
  const input = panel(page).getByRole("textbox", { name: "十二类工具任务 ID", exact: true }); await input.fill(run.id);
  await panel(page).getByRole("button", { name: "按原 ID 读取任务", exact: true }).click(); await expect(evidence(page)).toBeVisible();
  });
}
async function refresh(page: Page, id: string, seen: ReturnType<typeof observe>) {
  return seen.control("refresh_original_run", async () => {
  await expect.poll(() => new URL(page.url()).searchParams.get("agentNativeV3")).toBe(id);
  const button = panel(page).getByRole("button", { name: "只重新读取原任务", exact: true }); await expect(button).toBeEnabled(); await button.click(); await expect(button).toBeEnabled();
  return readRun(page, id, seen);
  });
}
async function markers(page: Page, preparation = false) {
  const prefix = preparation ? AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX : AGENT_NATIVE_V3_INTENT_PREFIX;
  const values = await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(sessionStorage.getItem(key)!) as unknown), prefix);
  return preparation ? values.map(value => AgentNativeV3PreparationIntentSchema.parse(value)) : values.map(value => AgentNativeV3IntentSchema.parse(value));
}
const metadataReadPaths = [
  "/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/agent-native-v3/workspace", "/api/agent-reads/workspace",
  "/api/agent-resources/workspace", "/api/agent-tools/workspace", "/api/agent-fulfillment/workspace", "/api/agent-commands/workspace",
  "/api/ai-assists/task-workspace", "/api/ai-assists/models",
];
const nativeRunPath = /^\/api\/agent-native-v3\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const commandRequestPath = /^\/api\/agent-commands\/requests\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
function readQueryVariant(url: URL): "none" | "assist_page1" | "unsupported" {
  return url.search === "" ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "unsupported";
}
type FactoryDirectoryAction = { id: string; idHash: string; worker: "app/(erp)/ai-tasks/page"; exportedName: "loadFactoryDirectory" };
async function factoryDirectoryAction(): Promise<FactoryDirectoryAction> {
  const cwd = process.env.KNOWLEDGE_BROWSER_CWD; if (!cwd) throw new Error("native_v3_factory_action_candidate_missing");
  let manifest: unknown;
  try { manifest = JSON.parse(await readFile(resolve(cwd, ".next/server/server-reference-manifest.json"), "utf8")); }
  catch { throw new Error("native_v3_factory_action_manifest_unavailable"); }
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(manifest)) throw new Error("native_v3_factory_action_manifest_invalid");
  const worker = "app/(erp)/ai-tasks/page" as const, matches: string[] = [];
  for (const runtime of ["node", "edge"]) {
    const entries = manifest[runtime]; if (!record(entries)) continue;
    for (const [id, entry] of Object.entries(entries)) {
      if (!record(entry) || entry.exportedName !== "loadFactoryDirectory" || typeof entry.filename !== "string" || !record(entry.workers) || !Object.hasOwn(entry.workers, worker)) continue;
      const filename = entry.filename.replaceAll("\\", "/");
      if (filename !== "apps/web/src/features/manual-operations/operation-actions.ts" && filename !== "src/features/manual-operations/operation-actions.ts" &&
        filename !== "./src/features/manual-operations/operation-actions.ts" && !filename.endsWith("/apps/web/src/features/manual-operations/operation-actions.ts")) continue;
      if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error("native_v3_factory_action_reference_invalid");
      matches.push(id);
    }
  }
  if (matches.length !== 1) throw new Error("native_v3_factory_action_reference_not_unique");
  return { id: matches[0]!, idHash: sha(matches[0]!), worker, exportedName: "loadFactoryDirectory" };
}
const ReadAuditSchema = z.object({
  documentAt: z.number().positive().finite(), sequence: z.int().positive(), startedAt: z.int().nonnegative(), at: z.int().nonnegative(),
  path: z.string().refine(path => metadataReadPaths.includes(path) || nativeRunPath.test(path) || commandRequestPath.test(path) || path === "/api/agent-tools/objects" || path === "/ai-tasks"),
  queryVariant: z.enum(["none", "assist_page1", "unsupported"]), factoryActionMatched: z.boolean(), emptyArgs: z.boolean(), rscMime: z.boolean(),
  method: z.enum(["GET", "POST"]), status: z.int().min(0).max(599).optional(), bytes: z.int().nonnegative().nullable(), reads: z.int().nonnegative(),
  eofAt: z.int().nonnegative().optional(), abortSeenAtEof: z.boolean().optional(), completion: z.enum(["reader", "json"]).optional(), signalAbortAt: z.int().nonnegative().optional(),
  bodyCancelAt: z.int().nonnegative().optional(), bodyErrorAt: z.int().nonnegative().optional(), fetchErrorAt: z.int().nonnegative().optional(),
  bodyErrorName: z.enum(["AbortError", "TimeoutError", "TypeError", "Error", "DOMException"]).optional(),
  fetchErrorName: z.enum(["AbortError", "TimeoutError", "TypeError", "Error", "DOMException"]).optional(),
}).strict().refine(row => row.path === "/ai-tasks" ? row.method === "POST" && row.factoryActionMatched && row.emptyArgs :
    !row.factoryActionMatched && !row.emptyArgs && (row.method === "POST" ? row.path === "/api/agent-tools/objects" : row.path !== "/api/agent-tools/objects"))
  .refine(row => row.queryVariant === "none" || row.queryVariant === "assist_page1" && row.path === "/api/ai-assists/task-workspace");
type ReadAudit = z.infer<typeof ReadAuditSchema>;
/** Observe only reads the application already performs. Return every original Promise unchanged. */
async function installReadCompletionAudit(page: Page, factoryAction: FactoryDirectoryAction) {
  const entries = new Map<string, ReadAudit>(); let rejected = 0;
  await page.exposeBinding("__yummyaiNativeV3ReadComplete", (source, value: unknown) => {
    if (source.frame !== page.mainFrame()) return;
    const parsed = ReadAuditSchema.safeParse(value); if (!parsed.success) { rejected++; return; }
    const row = parsed.data; entries.set(row.documentAt + ":" + row.sequence, row);
    if (entries.size > 250) entries.delete(entries.keys().next().value!);
  });
  await page.addInitScript(({ metadata, factoryActionId }) => {
    type State = {
      documentAt: number; sequence: number; startedAt: number; at: number; path: string; method: "GET" | "POST"; queryVariant: "none" | "assist_page1" | "unsupported";
      status?: number; bytes: number | null; reads: number; eofAt?: number; abortSeenAtEof?: boolean; completion?: "reader" | "json"; signalAbortAt?: number;
      bodyCancelAt?: number; bodyErrorAt?: number; fetchErrorAt?: number; bodyErrorName?: string; fetchErrorName?: string;
      factoryActionMatched: boolean; emptyArgs: boolean; rscMime: boolean;
    };
    const responses = new WeakMap<Response, State>(), streams = new WeakMap<object, State>(), readers = new WeakMap<object, State>(); let sequence = 0;
    const publish = (state: State) => {
      try {
        state.at = Date.now();
        const send = (window as Window & { __yummyaiNativeV3ReadComplete?: (entry: State) => Promise<void> }).__yummyaiNativeV3ReadComplete;
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
        const factoryActionMatched = url.origin === location.origin && method === "POST" && url.pathname === "/ai-tasks" && url.search === "" &&
          new Headers(init?.headers ?? request?.headers).get("next-action") === factoryActionId;
        const emptyArgs = factoryActionMatched && init?.body === "[]";
        const selected = factoryActionMatched && emptyArgs || method === "GET" && (metadata.includes(url.pathname) ||
          /^\/api\/agent-native-v3\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname) ||
          /^\/api\/agent-commands\/requests\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(url.pathname)) ||
          method === "POST" && url.pathname === "/api/agent-tools/objects";
        const queryVariant = url.search === "" ? "none" : url.pathname === "/api/ai-assists/task-workspace" && url.search === "?page=1" ? "assist_page1" : "unsupported";
        if (url.origin === location.origin && queryVariant !== "unsupported" && selected) {
          const now = Date.now(); state = { documentAt: performance.timeOrigin, sequence: ++sequence, startedAt: now, at: now,
            path: url.pathname, method: method as "GET" | "POST", queryVariant, factoryActionMatched, emptyArgs, rscMime: false, bytes: 0, reads: 0 };
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
          try { original.status = response.status; original.rscMime = /^text\/x-component(?:;|$)/i.test(response.headers.get("content-type") ?? "");
            responses.set(response, original); if (response.body) streams.set(response.body, original); publish(original); }
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
          try {
            state.reads++;
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
  }, { metadata: metadataReadPaths, factoryActionId: factoryAction.id });
  return { snapshot: () => [...entries.values()], rejected: () => rejected };
}
async function viewportFact(page: Page, anchor: Locator, path: string) {
  await expect(anchor).toBeVisible(); await anchor.evaluate(element => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect.poll(() => anchor.evaluate(element => {
    const box = element.getBoundingClientRect(); let left = Math.max(0, box.left), right = Math.min(innerWidth, box.right), top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
    const surfaces: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      surfaces.push(node); const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    }
    const points = [0.25, 0.5, 0.75].map(ratio => document.elementFromPoint(left + (right - left) * ratio, top + (bottom - top) / 2));
    const shell = element.closest(".anv2-resource") ?? element;
    return { fullTextInViewport: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.right <= right + 1 && box.top >= top - 1 && box.bottom <= bottom + 1,
      unobscured: points.every(hit => hit !== null && (element.contains(hit) || hit.contains(element))),
      opacity: surfaces.every(node => Number(getComputedStyle(node).opacity) === 1),
      finiteAnimationsRunning: shell.getAnimations({ subtree: true }).filter(animation => { const timing = animation.effect?.getComputedTiming();
        return timing && Number.isFinite(Number(timing.endTime)) && (animation.playState === "running" || animation.pending); }).length };
  })).toEqual({ fullTextInViewport: true, unobscured: true, opacity: true, finiteAnimationsRunning: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path, fullPage: false, animations: "allow" });
}
async function fill(page: Page, f: Fixture, source: Source, complete: boolean, seen: ReturnType<typeof observe>) {
  await loginErp(page, "operator", "/ai-tasks"); await expect(panel(page)).toBeVisible();
  const personal = await session(page); expect({ tenantId: personal.tenantId, userId: personal.userId }).toEqual({ tenantId: f.context.tenantId, userId: f.context.userId });
  expect(erpSessionAuthority(personal)).toBe(erpSessionAuthority(f.context)); expect(await seen.currentAuthority()).toBe(erpSessionAuthority(personal));
  const form = panel(page).getByRole("form", { name: "启动十二类原生工具模型任务", exact: true }); await expect(form).toBeVisible();
  await form.getByRole("textbox", { name: "本次任务目标", exact: true }).fill("Synthetic V3 eleven-owner source verification " + source.inputs["orders.order"].orderId);
  await form.getByRole("textbox", { name: "用户补充资料 未经事实核验", exact: true }).fill(source.contextText);
  await form.getByRole("combobox", { name: "本次原生任务模型", exact: true }).selectOption(f.model.modelId);
  await form.getByRole("textbox", { name: "美元费用上限", exact: true }).fill("1"); await form.getByRole("spinbutton", { name: "本次模型轮数上限", exact: true }).fill("32");
  const editor = form.getByRole("region", { name: "配置十二类原读取范围", exact: true });
  const selected = complete ? source.bindings : [source.bindings[13]!];
  for (const binding of selected) {
    const factoryChoice = binding.tool === "factory.capacity" ? await seen.beginFactoryChoice(source.factoryId) : null;
    await editor.getByRole("combobox", { name: "选择本次读取工具", exact: true }).selectOption(binding.tool);
    if (binding.tool === "orders.exceptions.page") { await editor.getByRole("combobox", { name: "原订单异常范围", exact: true }).selectOption("all"); await editor.getByRole("button", { name: "确定原订单异常范围", exact: true }).click(); }
    else if (binding.tool === "inventory.balances.page") await editor.getByRole("button", { name: "确定原库存读取范围", exact: true }).click();
    else if (binding.tool === "knowledge.search") { await editor.getByRole("combobox", { name: "知识主题", exact: true }).selectOption("operations"); await editor.getByRole("button", { name: "确定原知识范围", exact: true }).click(); }
    else if (binding.tool === "creative.history") { await editor.getByRole("combobox", { name: "创意执行范围", exact: true }).selectOption("inspection");
      const picker = editor.getByRole("combobox", { name: "选择已有创意对象", exact: true }); await expect(picker.locator(`option[value="${source.inspectionId}"]`)).toHaveCount(1); await picker.selectOption(source.inspectionId); }
    else if (binding.tool === "factory.capacity") { const picker = editor.getByRole("combobox", { name: "选择真实工厂", exact: true }); await expect(picker.locator(`option[value="${source.factoryId}"]`)).toHaveCount(1); await picker.selectOption(source.factoryId); await expect(picker).toHaveValue(source.factoryId);
      if (factoryChoice === null) throw new Error("Factory choice UI window missing"); await seen.acceptFactoryChoice(factoryChoice, source.factoryId);
      await editor.getByLabel("工厂当地起始日期", { exact: true }).fill(source.from); await editor.getByRole("spinbutton", { name: "产能读取天数", exact: true }).fill("2"); await editor.getByRole("button", { name: "确定原工厂日期窗口", exact: true }).click(); }
    else if (binding.tool === "orders.fulfillment") {
      const load = editor.getByRole("button", { name: "读取真实订单候选", exact: true }); if (await load.isVisible()) await load.click();
      const picker = editor.getByRole("combobox", { name: /^选择履约原订单/ }); await expect(picker.locator(`option[value="${source.orderId}"]`)).toHaveCount(1); await picker.selectOption(source.orderId);
      await editor.getByRole("combobox", { name: "本单履约来源", exact: true }).selectOption(binding.scope.kind);
    }
    else { let id: string;
      if (binding.tool === "advertising.analysis") { const input = source.inputs[binding.tool], account = editor.getByRole("combobox", { name: "选择真实广告账户", exact: true });
        await expect(account.locator(`option[value="${input.accountId}"]`)).toHaveCount(1); await account.selectOption(input.accountId); id = input.analysisId; }
      else if (binding.tool === "research.evidence") id = source.inputs[binding.tool].researchItemId;
      else if (binding.tool === "catalog.sku") id = source.inputs[binding.tool].skuId;
      else if (binding.tool === "listing.version") id = source.inputs[binding.tool].listingId;
      else if (binding.tool === "orders.order") id = source.inputs[binding.tool].orderId;
      else id = source.inputs["finance.profit_run"].runId;
      const picker = editor.getByRole("combobox", { name: "选择原业务对象", exact: true }); await expect(picker.locator(`option[value="${id}"]`)).toHaveCount(1); await picker.selectOption(id);
    }
    const add = editor.getByRole("button", { name: "加入本次固定读取范围", exact: true }); await expect(add).toBeEnabled(); await add.click();
  }
  await expect(editor.getByRole("heading", { name: `固定读取范围 · ${selected.length} / 16`, exact: true })).toBeVisible();
  const authority = await seen.currentAuthority(), response = await page.request.get("/api/agent-native-v3/workspace", { headers: { "x-yummyai-context-authority": authority } });
  expect(response.status()).toBe(200); const workspace = AgentNativeV3WorkspaceSchema.parse(await response.json()); expect(workspace.contextAuthority).toBe(authority);
  await form.locator("details.ap-command-picker > summary").click();
  for (const key of complete ? ["procurement/requisition_create", "finance/bill_record"] : ["procurement/requisition_create"]) {
    const capability = workspace.toolWorkspace.commands.find(row => row.domain + "/" + row.kind === key); if (!capability) throw new Error("Actual original command capability missing");
    expect(capability.available).toBe(true); await form.getByRole("checkbox", { name: capability.label, exact: true }).check();
  }
  return form;
}
function observe(page: Page, actionReference: () => FactoryDirectoryAction | undefined) {
  const metadata = new Set(metadataReadPaths), identityMetadata = new Set(["/api/agent-native/workspace", "/api/agent-native-v2/workspace", "/api/agent-native-v3/workspace", "/api/ai-assists/task-workspace", "/api/agent-commands/workspace"]),
    navigationPaths = new Set(["/", "/ai-tasks", "/business-tasks", "/navigation", "/orders", "/production", "/logistics"]);
  type Navigation = { at: number; startedAt: number | null; generation: number; path: string; fullDocument: boolean };
  type Control = { id: number; kind: string; start: number; end: number | null; startGeneration: number; endGeneration: number | null; completed: boolean;
    before: { path: string; runId: string | null; commandId: string | null }; after: Control["before"] | null; authorityHashes: string[]; navigations: Navigation[] };
  type Observed = { ordinal: number; path: string; method: string; authorityHash: string | null; responseAuthorityHash: string | null; at: number; generation: number; settled: boolean;
    factoryActionMatched: boolean; emptyArgs: boolean; responseRscMime: boolean;
    resourceType: string; isNavigation: boolean; local: boolean; queryEmpty: boolean; queryVariant: ReturnType<typeof readQueryVariant>; prefetch: boolean; nextRouterPrefetch: boolean; rsc: boolean; timing: Record<string, number>; responseStatus: number | null };
  type Failure = Observed & { reason: string; failedAt: number };
  type Classification = { ordinal: number; kind: string; controlId: number | null; auditKey: string | null; eofAt: number | null; bytes: number | null;
    actualStartTime: number; fetchStartedAt: number | null; startDelta: number | null; navigationGeneration: number | null; factoryChoiceId: number | null;
    browserEofAt: number | null; nodeFailedAt: number; observedCallbackDifferenceMs: number | null; clockRelation: "independent_callback_observations" };
  const timing = (request: Request) => Object.fromEntries(Object.entries(request.timing()).filter(([, value]) => typeof value === "number" && Number.isFinite(value)));
  const identity = () => { const url = new URL(page.url()), id = (key: string) => { const value = url.searchParams.get(key); return value && /^[a-f0-9-]{36}$/i.test(value) ? value : null; };
    return { path: url.pathname, runId: id("agentNativeV3"), commandId: id("agentCommand") }; };
  const requests = new Map<Request, Observed>(), held = new Set<Request>(), posts: Array<{ path: string; at: number }> = [];
  const failures: Failure[] = [], errors: Array<Observed & { status: number; code: string | null; responseAt: number }> = [];
  const consoleErrors: Array<{ path: string; status: number | null; network: boolean; hash: string; at: number }> = [], pageErrors: string[] = [], pending: Promise<void>[] = [];
  const committedLosses = new Map<Request, { ordinal: number; path: string; committedAt: number; status: 201; runId: string; requestId: string; itemId: string | null; checksum: string }>();
  const consoleMatches: Array<{ consoleHash: string; ordinal: number; kind: string }> = [];
  const preparedCommands = new Map<string, { at: number; runId: string; itemId: string; ownerCommandId: string; proposalChecksum: string }>();
  const controls: Control[] = [], navigations: Navigation[] = [], classifications: Classification[] = [];
  const factoryChoices: Array<{ id: number; controlId: number; start: number; end: number | null; generation: number; factoryId: string;
    authorityHash: string; currentAuthorityHash: string | null; accepted: boolean }> = [];
  const knownAuthorities = new Map<string, { at: number; userId: string; tenantId: string; source: "personal_session" }>();
  const documentRequests: Array<{ at: number; path: string; ordinal: number; used: boolean }> = [];
  let generation = 0, sequence = 0, transition: { start: number; end: number | null; oldAuthorityHash: string; currentAuthorityHash: string | null; navigations: Navigation[] } | null = null;
  page.on("framenavigated", frame => {
    if (frame !== page.mainFrame()) return; generation++; const now = Date.now(), path = new URL(frame.url()).pathname;
    const document = documentRequests.findLast(row => !row.used && row.path === path && row.at >= (navigations.at(-1)?.at ?? 0) &&
      [...requests.values()].some(request => request.ordinal === row.ordinal && request.responseStatus === 200)); if (document) document.used = true;
    const navigation = { at: now, startedAt: document?.at ?? null, generation, path, fullDocument: document !== undefined }; navigations.push(navigation);
    for (const control of controls) if (control.end === null) control.navigations.push(navigation);
    if (transition && transition.end === null && path === "/ai-tasks") transition.navigations.push(navigation);
  });
  page.on("request", request => {
    const url = new URL(request.url()), path = url.pathname, headers = request.headers(), authority = headers["x-yummyai-context-authority"], now = Date.now();
    const factoryActionMatched = url.origin === "http://localhost:3130" && request.method() === "POST" && path === "/ai-tasks" && url.search === "" &&
      actionReference() !== undefined && headers["next-action"] === actionReference()!.id;
    const emptyArgs = factoryActionMatched && request.postData() === "[]";
    requests.set(request, { factoryActionMatched, emptyArgs, responseRscMime: false, ordinal: ++sequence, path, method: request.method(), authorityHash: authority ? sha(authority) : null, responseAuthorityHash: null,
      at: now, generation, settled: false, resourceType: request.resourceType(), isNavigation: request.isNavigationRequest(), local: url.origin === "http://localhost:3130", queryEmpty: url.search === "", queryVariant: readQueryVariant(url),
      prefetch: /\bprefetch\b/i.test(headers.purpose ?? headers["sec-purpose"] ?? ""), nextRouterPrefetch: headers["next-router-prefetch"] === "1", rsc: headers.rsc === "1", timing: timing(request), responseStatus: null });
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push({ at: now, path, ordinal: sequence, used: false });
    if (request.method() === "POST" && /^\/api\/(agent|ai-assists)/.test(path)) posts.push({ path, at: now });
  });
  page.on("requestfinished", request => { const row = requests.get(request); if (row) { row.settled = true; row.timing = timing(request); } });
  page.on("requestfailed", request => { const row = requests.get(request); if (row) { row.settled = true; row.timing = timing(request); failures.push({ ...row, reason: request.failure()?.errorText ?? "unknown", failedAt: Date.now() }); } });
  page.on("pageerror", error => pageErrors.push(sha(error.name + ":" + error.message)));
  page.on("response", response => {
    const request = requests.get(response.request()), responseAuthority = response.headers()["x-yummyai-context-authority"];
    if (request) { request.responseStatus = response.status(); request.responseAuthorityHash = responseAuthority ? sha(responseAuthority) : null; request.responseRscMime = /^text\/x-component(?:;|$)/i.test(response.headers()["content-type"] ?? ""); request.timing = timing(response.request()); }
    if (response.status() < 400) return; if (!request) throw new Error("Unobserved browser HTTP failure");
    const row = { ...request, status: response.status(), code: null as string | null, responseAt: Date.now() }; errors.push(row);
    pending.push(response.json().then((value: unknown) => { if (value && typeof value === "object" && "code" in value && typeof value.code === "string") row.code = value.code; }).catch(() => {}));
  });
  page.on("console", message => {
    if (message.type() !== "error") return; let path = ""; try { path = new URL(message.location().url).pathname; } catch { /* Unlocated errors stay failures. */ }
    const match = /^Failed to load resource: the server responded with a status of (\d{3})/.exec(message.text());
    consoleErrors.push({ path, status: match ? Number(match[1]) : null, network: /^Failed to load resource: net::ERR_(FAILED|CONNECTION_RESET)/.test(message.text()), hash: sha(message.text()), at: Date.now() });
  });
  const currentAuthority = async () => {
    const personal = await session(page), authority = erpSessionAuthority(personal), hash = sha(authority);
    if (!knownAuthorities.has(hash)) knownAuthorities.set(hash, { at: Date.now(), userId: personal.userId, tenantId: personal.tenantId, source: "personal_session" });
    for (const control of controls) if (control.end === null && !control.authorityHashes.includes(hash)) control.authorityHashes.push(hash);
    return authority;
  };
  const stable = async () => {
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    await expect.poll(() => [...requests.values()].filter(row => !row.settled && (row.path.startsWith("/api/") ||
      row.rsc && !row.nextRouterPrefetch && navigationPaths.has(row.path))).length).toBe(0);
  };
  const inTransition = (row: Observed, at: number) => transition !== null && transition.end !== null && transition.navigations.length > 0 &&
    row.authorityHash !== null && knownAuthorities.has(row.authorityHash) && [transition.oldAuthorityHash, transition.currentAuthorityHash].includes(row.authorityHash) &&
    at >= transition.start && at <= transition.end && row.generation <= transition.navigations.at(-1)!.generation &&
    (row.at >= transition.start || [...held].some(request => requests.get(request)?.ordinal === row.ordinal));
  const readQueryAllowed = (row: Observed) => row.queryEmpty && row.queryVariant === "none" || !row.queryEmpty && row.path === "/api/ai-assists/task-workspace" && row.queryVariant === "assist_page1";
  const deniedTransition = (row: (typeof errors)[number]) => row.status === 409 && row.code === "authority_changed" && identityMetadata.has(row.path) && row.method === "GET" && readQueryAllowed(row) &&
    inTransition(row, row.responseAt) && (row.responseAuthorityHash === null || row.responseAuthorityHash === row.authorityHash);
  const eligibleRead = (row: Observed, runId: unknown) => row.local && readQueryAllowed(row) && row.resourceType === "fetch" && !row.isNavigation &&
    row.authorityHash !== null && knownAuthorities.has(row.authorityHash) && (row.method === "GET" &&
      (metadata.has(row.path) || typeof runId === "string" && row.path === "/api/agent-native-v3/runs/" + runId ||
        commandRequestPath.test(row.path) && preparedCommands.has(row.path.slice(row.path.lastIndexOf("/") + 1))) ||
      row.method === "POST" && row.path === "/api/agent-tools/objects");
  const eligibleFactoryAction = (row: Observed) => actionReference() !== undefined && row.local && row.method === "POST" && row.path === "/ai-tasks" &&
    row.queryEmpty && row.queryVariant === "none" && row.resourceType === "fetch" && !row.isNavigation && row.factoryActionMatched && row.emptyArgs && row.authorityHash === null;
  const controlled = (row: Failure, at: number) => controls.find(control => control.completed && control.end !== null &&
    row.authorityHash !== null && control.authorityHashes.includes(row.authorityHash) && at >= control.start && at <= control.end &&
    row.failedAt >= control.start && row.failedAt <= control.end && row.generation >= control.startGeneration && row.generation <= control.endGeneration!);
  const classify = (row: Failure, audits: ReadAudit[], runId: unknown): Classification | null => {
    const result = (kind: string, audit: ReadAudit | undefined, control: Control | undefined, navigation: Navigation | undefined = undefined): Classification => ({
      ordinal: row.ordinal, kind, controlId: control?.id ?? null, auditKey: audit ? audit.documentAt + ":" + audit.sequence : null,
      eofAt: audit?.eofAt ?? null, bytes: audit?.bytes ?? null, actualStartTime: row.timing.startTime ?? 0, fetchStartedAt: audit?.startedAt ?? null,
      startDelta: audit ? Math.abs((row.timing.startTime && row.timing.startTime > 0 ? row.timing.startTime : row.at) - audit.startedAt) : null,
      navigationGeneration: navigation?.generation ?? null, factoryChoiceId: null,
      browserEofAt: audit?.eofAt ?? null, nodeFailedAt: row.failedAt, observedCallbackDifferenceMs: audit?.eofAt === undefined ? null : audit.eofAt - row.failedAt,
      clockRelation: "independent_callback_observations",
    });
    if ([...committedLosses.values()].some(commit => commit.ordinal === row.ordinal && row.method === "POST" && commit.status === 201 && row.failedAt >= commit.committedAt) &&
      /^net::ERR_(FAILED|CONNECTION_RESET)$/.test(row.reason)) return result("injected_committed_response_loss", undefined, undefined);
    if (row.reason !== "net::ERR_ABORTED") return null;
    if (row.local && row.method === "GET" && row.resourceType === "fetch" && !row.isNavigation && row.responseStatus === 200 &&
      row.authorityHash === null && navigationPaths.has(row.path)) {
      if (row.nextRouterPrefetch) return result("intentional_prefetch_cancel", undefined, undefined);
      const control = controls.find(value => value.completed && value.end !== null && row.at >= value.start && row.failedAt <= value.end &&
        row.generation >= value.startGeneration && row.generation <= value.endGeneration! && value.navigations.some(nav => nav.path === row.path));
      if (row.rsc && control) return result("controlled_navigation_rsc_cancel", undefined, control, control.navigations.find(nav => nav.path === row.path));
    }
    const factoryActionRead = eligibleFactoryAction(row);
    if (!eligibleRead(row, runId) && !factoryActionRead) return null;
    const closeStart = (request: Observed, audit: ReadAudit) => request.path === audit.path && request.method === audit.method && request.queryVariant === audit.queryVariant &&
      request.factoryActionMatched === audit.factoryActionMatched && request.emptyArgs === audit.emptyArgs &&
      (request.responseStatus === null ? audit.status === undefined : audit.status === request.responseStatus) &&
      Math.abs((request.timing.startTime && request.timing.startTime > 0 ? request.timing.startTime : request.at) - audit.startedAt) <= 25;
    const candidates = audits.filter(audit => closeStart(row, audit));
    if (candidates.length > 1 || candidates.length === 1 && [...requests.values()].filter(other => (eligibleRead(other, runId) || eligibleFactoryAction(other)) && closeStart(other, candidates[0]!)).length !== 1) return null;
    const audit = candidates[0];
    if (factoryActionRead) {
      const choices = factoryChoices.filter(value => value.accepted && value.end !== null && value.currentAuthorityHash === value.authorityHash &&
        knownAuthorities.has(value.authorityHash) && row.generation === value.generation && row.at >= value.start && row.at <= value.end &&
        audit !== undefined && audit.startedAt >= value.start && audit.eofAt !== undefined && audit.eofAt <= value.end);
      const choice = choices.length === 1 ? choices[0] : undefined;
      if (choice && [...requests.values()].filter(other => eligibleFactoryAction(other) && other.generation === choice.generation && other.at >= choice.start && other.at <= choice.end!).length !== 1) return null;
      const control = choice ? controls.find(value => value.id === choice.controlId && value.completed && value.end !== null) : undefined;
      if (choice && control && row.responseStatus === 200 && row.responseRscMime && audit?.status === 200 && audit.rscMime && audit.completion === "reader" &&
        audit.reads > 0 && audit.bytes !== null && audit.bytes > 0 && audit.eofAt !== undefined && audit.abortSeenAtEof === false &&
        audit.bodyCancelAt === undefined && audit.bodyErrorAt === undefined && audit.fetchErrorAt === undefined && row.timing.startTime! > 0 &&
        row.timing.responseStart! >= 0 && row.timing.responseEnd! >= row.timing.responseStart!)
        return { ...result("completed_original_factory_directory_action", audit, control), factoryChoiceId: choice.id };
      return null;
    }
    const responseMatches = row.responseStatus === 200 && row.responseAuthorityHash === row.authorityHash;
    if (audit?.status === 200 && responseMatches && row.timing.startTime! > 0 && row.timing.responseStart! >= 0 && row.timing.responseEnd! >= row.timing.responseStart! &&
      audit.eofAt !== undefined && audit.abortSeenAtEof === false && (audit.completion === "json" ||
        audit.completion === "reader" && audit.reads > 0 && audit.bytes !== null && audit.bytes > 0) &&
      audit.bodyCancelAt === undefined && audit.bodyErrorAt === undefined && audit.fetchErrorAt === undefined)
      return result("completed_read_with_terminal_abort", audit, undefined);
    if (audit && audit.eofAt === undefined && audit.bytes === 0 && audit.bodyCancelAt === undefined && audit.signalAbortAt !== undefined &&
      audit.signalAbortAt <= row.failedAt && (audit.fetchErrorName === "AbortError" || audit.bodyErrorName === "AbortError") &&
      (row.responseStatus === null || responseMatches)) {
      const control = controlled(row, audit.signalAbortAt);
      if (control || inTransition(row, row.failedAt) && transition && audit.signalAbortAt >= transition.start && audit.signalAbortAt <= transition.end!)
        return result("controlled_stale_read_signal_abort", audit, control);
    }
    // Only a real new document can explain an old document losing its signal audit.
    if (row.method === "GET" && audit?.eofAt === undefined && (audit === undefined || audit.bytes === 0) && audit?.bodyCancelAt === undefined &&
      (row.responseStatus === null || responseMatches)) {
      const control = controls.find(value => value.completed && value.end !== null && row.authorityHash !== null && value.authorityHashes.includes(row.authorityHash) &&
        row.failedAt >= value.start && row.failedAt <= value.end && value.navigations.some(nav => nav.fullDocument && nav.startedAt !== null &&
          row.generation < nav.generation && row.at <= nav.startedAt && row.failedAt >= nav.startedAt));
      const navigation = control?.navigations.find(nav => nav.fullDocument && nav.startedAt !== null && row.generation < nav.generation && row.at <= nav.startedAt && row.failedAt >= nav.startedAt) ??
        (transition && transition.end !== null && inTransition(row, row.failedAt) ? transition.navigations.find(nav => nav.fullDocument && nav.startedAt !== null &&
          row.generation < nav.generation && row.at <= nav.startedAt && row.failedAt >= nav.startedAt) : undefined);
      if (navigation) return result("old_document_read_cancelled_by_observed_navigation", audit, control, navigation);
    }
    return null;
  };
  return {
    posts, failures, errors, consoleErrors, pageErrors, currentAuthority, stable,
    async beginFactoryChoice(factoryId: string) {
      const authorityHash = sha(await currentAuthority()), control = controls.findLast(value => value.end === null);
      if (!control || new URL(page.url()).pathname !== "/ai-tasks") throw new Error("Factory choice requires its actual UI control window");
      const choice = { id: factoryChoices.length + 1, controlId: control.id, start: Date.now(), end: null, generation, factoryId: z.uuidv7().parse(factoryId),
        authorityHash, currentAuthorityHash: null, accepted: false }; factoryChoices.push(choice); return choice.id;
    },
    async acceptFactoryChoice(id: number, factoryId: string) {
      const choice = factoryChoices.find(value => value.id === id), authorityHash = sha(await currentAuthority());
      if (!choice || choice.accepted || choice.factoryId !== factoryId || choice.authorityHash !== authorityHash || choice.generation !== generation)
        throw new Error("Factory option was not accepted in its original personal UI window");
      choice.currentAuthorityHash = authorityHash; choice.end = Date.now(); choice.accepted = true;
    },
    prepared201(status: number, raw: unknown) {
      if (status !== 201) throw new Error("Known original command requires its actual prepare201");
      const receipt = AgentNativeV3ItemReceiptSchema.parse(raw);
      if (receipt.disposition !== "known" || !receipt.agentCommandId || !receipt.ownerCommandId) throw new Error("Known original command IDs missing from strict prepare201");
      preparedCommands.set(receipt.agentCommandId, { at: Date.now(), runId: receipt.runId, itemId: receipt.itemId, ownerCommandId: receipt.ownerCommandId, proposalChecksum: receipt.proposalChecksum });
      return receipt;
    },
    committedLoss(request: Request, receipt: { status: 201; runId: string; requestId: string; itemId: string | null; checksum: string }) {
      const row = requests.get(request), path = receipt.itemId === null ? "/api/agent-native-v3/runs" : "/api/agent-native-v3/runs/" + receipt.runId + "/items/" + receipt.itemId + "/prepare";
      if (!row || !row.local || row.method !== "POST" || row.path !== path || row.authorityHash === null || !knownAuthorities.has(row.authorityHash) || committedLosses.has(request))
        throw new Error("Committed loss must identify its exact original authenticated POST");
      committedLosses.set(request, { ...receipt, ordinal: row.ordinal, path, committedAt: Date.now() });
    },
    hold(request: Request) { if (!requests.has(request)) throw new Error("Held request was not observed"); held.add(request); },
    async control<T>(kind: string, action: () => Promise<T>): Promise<T> {
      const window: Control = { id: controls.length + 1, kind, start: Date.now(), end: null, startGeneration: generation, endGeneration: null,
        completed: false, before: identity(), after: null, authorityHashes: [...knownAuthorities.keys()], navigations: [] }; controls.push(window);
      try { const value = await action(); await stable(); await currentAuthority(); window.completed = true; return value; }
      finally { window.end = Date.now(); window.endGeneration = generation; window.after = identity(); }
    },
    transition(authority: string) {
      if (!knownAuthorities.has(sha(authority))) throw new Error("Authority was not observed from the actual personal session");
      transition = { start: Date.now(), end: null, oldAuthorityHash: sha(authority), currentAuthorityHash: null, navigations: [] };
    },
    async finishTransition(authority: string) {
      await stable(); expect(await currentAuthority()).toBe(authority); if (!transition || !transition.navigations.length) throw new Error("Actual identity navigation missing");
      transition.currentAuthorityHash = sha(authority); if (transition.oldAuthorityHash === transition.currentAuthorityHash) throw new Error("Actual authority did not change"); transition.end = Date.now();
    },
    diagnostic: () => ({ transition, controls, navigations, factoryAction: actionReference() ? { idHash: actionReference()!.idHash, worker: actionReference()!.worker, exportedName: actionReference()!.exportedName } : null,
      factoryChoices, factoryActionRequests: [...requests.values()].filter(row => row.local && row.method === "POST" && row.path === "/ai-tasks"), preparedCommands: [...preparedCommands].map(([id, row]) => ({ id, ...row })), committedLosses: [...committedLosses.values()], consoleMatches, knownAuthorities: [...knownAuthorities].map(([hash, facts]) => ({ hash, ...facts })), classifications,
      heldOrdinals: [...held].map(request => requests.get(request)?.ordinal), metadata: [...requests.values()].filter(row => metadata.has(row.path)),
      nativeReads: [...requests.values()].filter(row => row.method === "GET" && nativeRunPath.test(row.path)) }),
    async check(audits: ReadAudit[], runId: unknown) {
      await Promise.all(pending); expect(pageErrors).toEqual([]);
      for (const [request, current] of requests) {
        current.timing = timing(request); const failure = failures.find(row => row.ordinal === current.ordinal);
        if (failure) { failure.timing = current.timing; failure.responseStatus = current.responseStatus; failure.responseAuthorityHash = current.responseAuthorityHash; failure.responseRscMime = current.responseRscMime; }
      }
      const unexplained = failures.filter(row => { const match = classify(row, audits, runId); if (match) classifications.push(match); return !match; });
      expect(unexplained).toEqual([]);
      expect(errors.filter(row => !deniedTransition(row))).toEqual([]);
      const lossFailures = failures.filter(row => classifications.some(value => value.ordinal === row.ordinal && value.kind === "injected_committed_response_loss"));
      for (const commit of committedLosses.values()) expect(lossFailures.filter(row => row.ordinal === commit.ordinal)).toHaveLength(1);
      const consumedLosses = new Set<number>(), consumedDenials = new Set<number>();
      expect(consoleErrors.filter(error => {
        const lost = error.network ? lossFailures.filter(row => row.path === error.path && !consumedLosses.has(row.ordinal) && Math.abs(row.failedAt - error.at) < 2000) : [];
        if (lost.length === 1) { consumedLosses.add(lost[0]!.ordinal); consoleMatches.push({ consoleHash: error.hash, ordinal: lost[0]!.ordinal, kind: "exact_committed_response_loss" }); return false; }
        const denied = error.status === 409 ? errors.filter(row => row.path === error.path && deniedTransition(row) && !consumedDenials.has(row.ordinal) && Math.abs(row.responseAt - error.at) < 2000) : [];
        if (denied.length === 1) { consumedDenials.add(denied[0]!.ordinal); consoleMatches.push({ consoleHash: error.hash, ordinal: denied[0]!.ordinal, kind: "exact_identity_window_denial" }); return false; }
        return true;
      })).toEqual([]);
      expect(posts.filter(row => /^\/api\/(agent-native|agent-native-v2|agent-plans|agent-loops|ai-assists)\/runs$/.test(row.path))).toEqual([]);
    },
  };
}
async function leaf(page: Page, info: TestInfo, action: (f: Fixture, seen: ReturnType<typeof observe>, proof: Record<string, unknown>) => Promise<void>) {
  let f: Fixture | undefined, failure: unknown, audit: Awaited<ReturnType<typeof installReadCompletionAudit>> | undefined; const cleanup: unknown[] = [], proof: Record<string, unknown> = { operation: "3f7a21d8", title: info.title,
    externalModelTransport: "synthetic_http_only", actualOwners: true, modelBusinessSemantics: "not_proven_requires_original_operator_confirmation" };
  let factoryAction: FactoryDirectoryAction | undefined; const seen = observe(page, () => factoryAction);
  try { factoryAction = await factoryDirectoryAction(); audit = await installReadCompletionAudit(page, factoryAction); f = await fixture(info.testId.replace(/[^a-z0-9]/gi, "").slice(-24)); proof.nonce = f.nonce; await action(f, seen, proof);
    expect(audit.rejected()).toBe(0); await seen.check(audit.snapshot(), proof.runId); } catch (error) { failure = error; }
  proof.readCompletionAudit = audit?.snapshot() ?? []; proof.readCompletionAuditRejected = audit?.rejected() ?? 0;
  try { await f?.close(); } catch (error) { cleanup.push(error); }
  const path = info.outputPath("agent-native-v3-proof.json"); await writeFile(path, JSON.stringify({ ...proof, completed: failure === undefined, cleanupFailureCount: cleanup.length,
    posts: seen.posts, errors: seen.errors, consoleErrors: seen.consoleErrors, pageErrors: seen.pageErrors, failedRequests: seen.failures, identityWindow: seen.diagnostic(), childClose: f?.childClose ?? null }, null, 2));
  await info.attach("agent-native-v3-proof", { path, contentType: "application/json" });
  if (failure !== undefined || cleanup.length) throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanup], "NativeV3 personal browser acceptance or cleanup failed");
}

test("one personal native-v3 task actually reads all fourteen original bindings then prepares and confirms two individually reviewed original commands", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), before = await f.business(), form = await seen.control("initial_login_and_fill", () => fill(page, f, source, true, seen)); await seen.stable();
    const response = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === "/api/agent-native-v3/runs");
    const created = await seen.control("start_original_task", async () => {
      await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); const createdResponse = await response; expect(createdResponse.status()).toBe(201);
      return AgentNativeV3ViewSchema.parse(await createdResponse.json());
    }); proof.runId = created.id; proof.requestId = created.requestId;
    await f.execute(created.id); const worker = await f.wait(); expect(worker).toMatchObject({ modelCalls: 29, definitions: 148, reads: 155, settled: true, failure: null }); proof.worker = worker;
    const permissionProbes = { definitions: worker.definitions - 28 - 5, reads: worker.reads - 28 - 12 };
    expect(permissionProbes).toEqual({ definitions: 115, reads: 115 }); proof.permissionProbes = permissionProbes;
    proof.evidenceTransportCalls = { definitions: 28, reads: 28, beforeModelFulfillmentDefinitions: 5, beforeModelFulfillmentPages: 12, toolCalls: 73 };
    const run = await refresh(page, created.id, seen); expect(run).toMatchObject({ status: "completed", cost: { modelTurns: 29, knownCostUsd: "0.006090", reservedUsd: "0.000000" } });
    expect(run.steps).toHaveLength(57); expect(run.toolCalls).toBe(73); expect(run.observations.map(row => row.tool)).toEqual(source.bindings.map(row => row.tool));
    expect(run.observations.filter(row => row.tool === "orders.fulfillment").map(row => [row.collectionComplete, row.indexComplete])).toEqual([[null, true], [null, true], [null, true]]);
    proof.readBindings = run.observations.map(row => ({ tool: row.tool, bindingIndex: row.request.bindingIndex, basisChecksum: row.basisChecksum, collectionComplete: row.collectionComplete, indexComplete: row.indexComplete }));
    expect(run.items).toHaveLength(2); expect(run.items.every(row => row.preparationState === "not_requested")).toBe(true); expect(await f.business()).toEqual(before);
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await viewportFact(page, panel(page).getByRole("heading", { name: "十二类原生工具模型任务", exact: true }), info.outputPath("native-v3-panel-" + width + ".png"));
      await evidence(page).getByRole("combobox", { name: "查看十二类原读取步骤", exact: true }).selectOption("9"); await evidence(page).getByRole("region", { name: "十二类工具任务来源", exact: true }).scrollIntoViewIfNeeded();
      const financeSource = evidence(page).getByRole("region", { name: "利润原计算事实", exact: true });
      await expect(financeSource).toBeVisible(); await expect(financeSource.getByText("USD 53.00", { exact: true }).first()).toBeVisible();
      await expect.poll(() => evidence(page).locator(".anv2-resource").evaluate(shell => {
        const result = shell.querySelector(".ar-result");
        return { shellOpacity: getComputedStyle(shell).opacity, resultOpacity: result ? getComputedStyle(result).opacity : null,
          finiteAnimationsRunning: shell.getAnimations({ subtree: true }).filter(animation => {
            const timing = animation.effect?.getComputedTiming();
            return timing && Number.isFinite(Number(timing.endTime)) && (animation.playState === "running" || animation.pending);
          }).length };
      })).toEqual({ shellOpacity: "1", resultOpacity: "1", finiteAnimationsRunning: 0 });
      await viewportFact(page, financeSource.getByText("USD 53.00", { exact: true }).first(), info.outputPath("native-v3-finance-source-" + width + ".png"));
      await evidence(page).getByRole("combobox", { name: "查看十二类原读取步骤", exact: true }).selectOption("11");
      const factory = evidence(page).getByRole("region", { name: "工厂原表观察", exact: true });
      await viewportFact(page, factory.getByText(/^工厂已确认作废 仍需原订单处理/), info.outputPath("native-v3-factory-void-" + width + ".png"));
      const quality = evidence(page).getByRole("region", { name: "原实物质检组", exact: true }), history = quality.locator("details.af-history").first();
      if (!await history.evaluate(element => (element as HTMLDetailsElement).open)) await history.locator("summary").first().click();
      for (const [name, text] of [["passed", "检验通过 · 100.00%"], ["failed", "检验未通过 · 0.00%"]])
        await viewportFact(page, quality.getByText(text!, { exact: true }), info.outputPath(`native-v3-quality-${name}-${width}.png`));
      await evidence(page).getByRole("combobox", { name: "查看十二类原读取步骤", exact: true }).selectOption("13");
      await viewportFact(page, evidence(page).getByText(/^USD 6\.00/).first(), info.outputPath("native-v3-logistics-cost-" + width + ".png"));
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); const effects: object[] = [];
    for (const [position, item] of run.items.entries()) { await openRun(page, run, seen); const proposal = evidence(page).getByRole("listitem", { name: "十二类工具提案 " + (position + 1), exact: true }), prior = await f.business();
      const saved = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-native-v3/runs/${run.id}/items/${item.id}/prepare`)
        .then(async response => ({ status: response.status(), body: await response.json() as unknown }));
      const prepare = proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true }); await expect(prepare).toBeEnabled();
      const [preparedResponse] = await seen.control("open_prepared_original_review", async () => {
        const values = await Promise.all([saved, prepare.click()]); await expect(page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true })).toBeVisible(); return values;
      }); expect(preparedResponse.status).toBe(201);
      const prepared = seen.prepared201(preparedResponse.status, preparedResponse.body); expect(prepared.disposition).toBe("known"); expect(await f.business()).toEqual(prior);
      const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }); await expect(review).toBeVisible(); await review.getByRole("checkbox", { name: /^我已核对这笔原目标/ }).check();
      const result = page.waitForResponse(value => value.request().method() === "POST" && new URL(value.url()).pathname === `/api/agent-commands/requests/${prepared.agentCommandId}/confirm`)
        .then(async response => ({ status: response.status(), body: await response.json() as unknown }));
      const [resultResponse] = await seen.control("confirm_individually_reviewed_original", () => Promise.all([result, review.getByRole("button", { name: "确认执行这笔原操作", exact: true }).click()]));
      expect(resultResponse.status).toBe(200); const actual = AgentCommandViewSchema.parse(resultResponse.body);
      expect(actual).toMatchObject({ state: "succeeded", ownerCommandId: prepared.ownerCommandId, canConfirm: false }); const after = await f.business();
      if (position === 0) expect(after.native.inventory_procurement_requisitions!.count - prior.native.inventory_procurement_requisitions!.count).toBe(1);
      else expect(after.native.finance_payable_bills!.count - prior.native.finance_payable_bills!.count).toBe(1);
      effects.push({ itemId: item.id, agentCommandId: prepared.agentCommandId, ownerCommandId: prepared.ownerCommandId, state: actual.state });
    }
    expect((await f.progress()).modelCalls).toBe(29); expect(seen.posts.filter(row => row.path.endsWith("/prepare"))).toHaveLength(2); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toHaveLength(2);
    const lastReview = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true });
    if (await lastReview.isVisible()) await seen.control("close_original_review", async () => { await lastReview.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(lastReview).not.toBeVisible(); });
    await seen.stable();
    const historicalTab = page.getByRole("tab", { name: "v2 历史任务", exact: true }), oldWorkspace = page.waitForResponse(value => value.request().method() === "GET" && new URL(value.url()).pathname === "/api/agent-native-v2/workspace" && value.status() === 200);
    await seen.control("select_v2_history_version", async () => { await historicalTab.click(); await oldWorkspace; await expect(page.getByRole("region", { name: "十一类原生工具模型任务", exact: true })).toBeVisible(); });
    await seen.control("return_to_v3_version", async () => { await page.getByRole("tab", { name: "v3 含履约读取", exact: true }).click(); await expect(panel(page)).toBeVisible(); });
    proof.effects = effects; proof.onlyExplicitBusinessWrites = true;
  });
});

test("recovers lost original parent and child responses across refresh without paying twice then hides late private results after actual authority withdrawal", async ({ page }, info) => {
  await leaf(page, info, async (f, seen, proof) => {
    const source = await f.seed(), form = await seen.control("initial_login_and_fill", () => fill(page, f, source, false, seen)), committed = latch(); let original: AgentNativeV3View | undefined; await seen.stable();
    const parentPath = "/api/agent-native-v3/runs";
    await page.route("**" + parentPath, async route => { if (route.request().method() !== "POST") { await route.continue(); return; }
      const response = await route.fetch(); expect(response.status()).toBe(201); original = AgentNativeV3ViewSchema.parse(await response.json()); seen.committedLoss(route.request(), { status: 201, runId: original.id, requestId: original.requestId, itemId: null, checksum: original.requestChecksum }); committed.resolve(); await route.abort("connectionreset"); }, { times: 1 });
    await seen.control("start_original_task_with_lost_response", async () => { await form.getByRole("button", { name: "启动新的付费原生工具任务", exact: true }).click(); await bounded(committed.promise, "Actual V3 parent201 did not commit"); }); if (!original) throw new Error("Actual V3 parent missing");
    const run = original; proof.runId = run.id; proof.requestId = run.requestId;
    await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, requestChecksum: run.requestChecksum, runId: null, state: "unknown" }]);
    const state = await f.state(run.requestId); await seen.stable(); await seen.control("reload_unknown_parent", async () => { await page.reload(); await expect(panel(page)).toBeVisible(); }); const marker = panel(page).getByRole("article", { name: "十二类工具原请求 " + run.requestId, exact: true });
    await marker.getByRole("button", { name: "只读取原请求回执", exact: true }).click(); await expect.poll(() => markers(page)).toMatchObject([{ requestId: run.requestId, runId: run.id, state: "known" }]);
    expect(await f.state(run.requestId)).toEqual(state); expect((await f.progress()).modelCalls).toBe(0); expect(seen.posts.filter(row => row.path === parentPath)).toHaveLength(1);
    await seen.control("read_recovered_original_run", async () => { await marker.getByRole("button", { name: "读取原任务详情", exact: true }).click(); await expect(evidence(page)).toBeVisible(); }); await f.execute(run.id); await f.wait(); const completed = await refresh(page, run.id, seen);
    expect(completed.status).toBe("completed"); expect(completed.items).toHaveLength(1); const item = completed.items[0]!, preparedPath = `/api/agent-native-v3/runs/${run.id}/items/${item.id}/prepare`, born = latch();
    let prepared: z.infer<typeof AgentNativeV3ItemReceiptSchema> | undefined;
    await page.route("**" + preparedPath, async route => { const response = await route.fetch(); expect(response.status()).toBe(201); prepared = seen.prepared201(response.status(), await response.json()); seen.committedLoss(route.request(), { status: 201, runId: prepared.runId, requestId: run.requestId, itemId: prepared.itemId, checksum: prepared.proposalChecksum }); born.resolve(); await route.abort("connectionreset"); }, { times: 1 });
    const proposal = evidence(page).getByRole("listitem", { name: "十二类工具提案 1", exact: true }), prepare = proposal.getByRole("button", { name: "保存这项原准备并核对", exact: true });
    await expect(prepare).toBeEnabled(); await seen.control("prepare_original_with_lost_response", async () => { await prepare.click(); await bounded(born.promise, "Actual V3 child201 did not commit"); });
    await expect.poll(() => markers(page, true)).toMatchObject([{ runId: run.id, itemId: item.id, state: "unknown" }]); if (!prepared?.ownerCommandId) throw new Error("Actual original prepared owner ID missing");
    const frozen = await f.state(run.requestId), business = await f.business(); await seen.stable(); await seen.control("reload_unknown_item", async () => { await page.reload(); await expect(evidence(page)).toBeVisible(); });
    const restored = evidence(page).getByRole("listitem", { name: "十二类工具提案 1", exact: true }); await restored.getByRole("button", { name: "读取这项原准备回执", exact: true }).click();
    const restoredLink = restored.getByRole("link", { name: "核对这项原操作" }); await expect(restoredLink).toBeVisible();
    const restoredHref = await restoredLink.getAttribute("href"); expect(restoredHref).not.toBeNull(); const restoredUrl = new URL(restoredHref!, page.url());
    expect(restoredUrl.pathname).toBe("/ai-tasks"); expect(restoredUrl.searchParams.get("agentNativeV3")).toBe(run.id); expect(restoredUrl.searchParams.get("agentCommand")).toBe(prepared.agentCommandId);
    const recoveredCommandId = prepared.agentCommandId;
    await seen.control("recover_known_original_review", async () => {
      await restoredLink.click(); const review = page.getByRole("dialog", { name: "核对 Agent 原操作", exact: true }); await expect(review).toBeVisible();
      await expect.poll(() => ({ path: new URL(page.url()).pathname, runId: new URL(page.url()).searchParams.get("agentNativeV3"), commandId: new URL(page.url()).searchParams.get("agentCommand") }))
        .toEqual({ path: "/ai-tasks", runId: run.id, commandId: recoveredCommandId });
      await review.getByRole("button", { name: "关闭操作核对", exact: true }).click(); await expect(review).not.toBeVisible();
    });
    proof.originalReviewRecoveryNavigation = { path: restoredUrl.pathname, runId: run.id, commandId: prepared.agentCommandId, confirmed: false };
    expect(await f.state(run.requestId)).toEqual(frozen); expect(await f.business()).toEqual(business); expect(seen.posts.filter(row => row.path === preparedPath)).toHaveLength(1);
    proof.recoveredItem = { itemId: item.id, agentCommandId: prepared.agentCommandId, ownerCommandId: prepared.ownerCommandId };
    await seen.stable(); const oldAuthority = await seen.currentAuthority();
    const entered = latch(), release = latch(), settled = latch(), path = `/api/agent-native-v3/runs/${run.id}`; let returned = false, routeFailure: string | null = null;
    await page.route("**" + path, async route => { try { seen.hold(route.request()); expect(route.request().headers()["x-yummyai-context-authority"]).toBe(oldAuthority);
      const response = await route.fetch(); expect(response.status()).toBe(200); const body = AgentNativeV3ViewSchema.parse(await response.json()); expect(body.privateAvailable).toBe(true);
      entered.resolve(); await release.promise; await route.fulfill({ response, body: JSON.stringify(body) }); returned = true;
    } catch (error) { routeFailure = sha(error instanceof Error ? error.name : "Error"); } finally { settled.resolve(); } }, { times: 1 });
    const refreshPromise = panel(page).getByRole("button", { name: "只重新读取原任务", exact: true }).click();
    try { await bounded(entered.promise, "Actual old-authority V3 BFF response was not captured"); seen.transition(oldAuthority); await f.piiSelf();
      const navigation = page.waitForEvent("framenavigated", frame => frame === page.mainFrame() && new URL(frame.url()).pathname === "/ai-tasks"); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await navigation;
      await expect(panel(page)).toBeVisible(); const authority = await seen.currentAuthority();
      release.resolve(); await bounded(settled.promise, "Held original V3 response did not settle"); await refreshPromise;
      const hidden = await readRun(page, run.id, seen); expect(hidden).toMatchObject({ privateAvailable: false, goal: null, contextText: null, readContracts: null, steps: [], definitions: [], observations: [], result: null });
      await seen.finishTransition(authority);
      expect(hidden.items[0]?.id).toBe(item.id); expect(hidden.items[0]?.agentCommandId).toBe(prepared.agentCommandId);
      await expect(panel(page).getByText(completed.goal!, { exact: true })).toHaveCount(0); await expect(panel(page).getByRole("region", { name: "十二类工具任务来源", exact: true })).toHaveCount(0);
      await expect(panel(page).getByRole("region", { name: "原生标量来源引用", exact: true })).toHaveCount(0); await expect(panel(page).getByRole("button", { name: "保存这项原准备并核对", exact: true })).toHaveCount(0);
      const saved = completed.observations[0]!.results[0]!; if (saved.version !== "erp-agent-fulfillment-v1" || !completed.readContracts) throw new Error("Actual original logistics call and pin required");
      const deniedInput = AgentFulfillmentCallSchema.parse({ version: saved.version, tool: saved.tool, executionContract: completed.readContracts.fulfillment,
        definitionChecksum: saved.definitionChecksum, input: saved.input });
      const origin = new URL(page.url()).origin; expect(origin).toBe("http://localhost:3130");
      const denied = await page.request.post("/api/agent-fulfillment/call", { headers: { origin, "content-type": "application/json", "x-yummyai-context-authority": authority }, data: deniedInput });
      expect(denied.status()).toBe(403); proof.currentOriginalReadDenied = { path: "/api/agent-fulfillment/call", status: denied.status() };
      expect(await f.business()).toEqual(business); expect((await f.progress()).modelCalls).toBe(4); expect(seen.posts.filter(row => row.path.endsWith("/confirm"))).toHaveLength(0);
      proof.currentAuthorityHash = sha(authority); proof.lateResult = { returned, routeFailure, privateCleared: true }; proof.worker = await f.progress();
    } finally { release.resolve(); await bounded(settled.promise, "V3 held response cleanup did not settle"); await page.unroute("**" + path); }
  });
});
