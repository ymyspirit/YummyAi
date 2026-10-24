import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { LegacyAssistResultSchema } from "@yummyai/contracts/ai/assist";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { knowledgeGovernanceFixture } from "./knowledge-governance-fixture";
import { centerApi } from "./order-centers-fixture";
import { actors } from "./erp-identity-fixture";

export const roleBenchmarkRoles = ["creative", "order_review", "artwork_preflight", "template_config", "sku_package", "after_sales_review"] as const;
export type RoleBenchmarkRole = typeof roleBenchmarkRoles[number];
const SourceSchema = z.object({ role: z.enum(roleBenchmarkRoles), targetId: z.uuidv7(), complete: z.boolean(), ids: z.record(z.string(), z.string()), notes: z.string() }).strict();
export type RoleBenchmarkSource = z.infer<typeof SourceSchema>;
const StateSchema = z.record(z.string(), z.object({ count: z.int().nonnegative(), hash: z.string().regex(/^[a-f0-9]{32}$/) }).strict());
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const ownedRoot = resolve(workspace, "tmp/role-benchmark-20261021-b84f6d29/frontend/browser-proof");
export function requireRoleBenchmarkBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const api = new URL(process.env.API_BASE_URL ?? "https://invalid.invalid");
  if (!nonce || !process.env.ERP_FIXTURE_ACTORS || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) || api.port !== "8130" ||
    process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_ROLE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_BUSINESS_BENCHMARK_ISOLATED !== "1" ||
    process.env.E2E_KNOWLEDGE_BENCHMARK_ISOLATED !== "1" || process.env.E2E_KNOWLEDGE_EVALUATION_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "current" ||
    process.env.E2E_COMPILED_WEB !== "1" || process.env.WEB_AUTH_MODE !== "personal" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Role benchmark browser requires the exact compiled personal nonce API, database, bucket and all isolation flags before connection");
  return { nonce };
}

type Request = { operation: "initialize"; context: ReturnType<typeof TenantContextSchema.parse> } | { operation: "source"; role: RoleBenchmarkRole; complete: boolean }
  | { operation: "state" } | { operation: "output"; itemId: string; versionId: string } | { operation: "close" };
type RpcCloseEvidence = { transport: "node-tsx-import"; acknowledged: boolean; exited: boolean; exitCode: number | null;
  signal: NodeJS.Signals | null; timedOut: boolean; forcedKill: boolean; failures: string[] };
const rpcFailureCode = (error: unknown, fallback: string) => error instanceof Error && /^role_rpc_[a-z0-9_]+$/.test(error.message) ? error.message : fallback;
const rpcResponseFailureCodes = new Set(["owner_rpc_failed", "role_rpc_resource_cleanup_failed", "role_rpc_initialization_and_cleanup_failed", "role_rpc_owner_close_failed", "role_rpc_database_close_failed"]);
/** The decorated owner graph is loaded only by a single Node/tsx child using API tsconfig.
 * Playwright receives plain IDs/output DTOs, never imports that graph. */
class RoleOwnerRpc {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, { operation: Request["operation"]; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private exited = false;
  private closing: Promise<void> | undefined;
  readonly closeEvidence: RpcCloseEvidence = { transport: "node-tsx-import", acknowledged: false, exited: false, exitCode: null, signal: null, timedOut: false, forcedKill: false, failures: [] };
  readonly ready: Promise<void>;
  readonly end: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  constructor(private readonly nonce: string) {
    requireRoleBenchmarkBrowser();
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(workspace, "apps/api/node_modules/tsx/dist/loader.mjs")).href, resolve(workspace, "tools/testing/role-benchmark-browser-rpc.mts")], {
      cwd: workspace, env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(workspace, "apps/api/tsconfig.json") }, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => readyReject(new Error("role_rpc_ready_timeout")), 30_000);
    this.end = new Promise(resolve => this.child.once("exit", (code, signal) => {
      clearTimeout(timer); this.exited = true; Object.assign(this.closeEvidence, { exited: true, exitCode: code, signal }); readyReject(new Error("role_rpc_exit_before_ready"));
      for (const value of this.waiting.values()) { clearTimeout(value.timer); value.reject(new Error("role_rpc_exit_with_pending_request")); } this.waiting.clear(); resolve({ code, signal });
    }));
    this.child.once("error", () => { clearTimeout(timer); readyReject(new Error("role_rpc_spawn_failed")); });
    this.child.on("message", raw => {
      const message = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      if (message.type === "ready" && message.nonce === nonce) { clearTimeout(timer); readyResolve(); return; }
      if (typeof message.id !== "number") return;
      const request = this.waiting.get(message.id); if (!request) return; clearTimeout(request.timer); this.waiting.delete(message.id);
      if (message.type === "result") request.resolve(message.value);
      else {
        if (request.operation === "close" && Array.isArray(message.cleanupFailures))
          this.closeEvidence.failures.push(...message.cleanupFailures.filter((code): code is string => typeof code === "string" && rpcResponseFailureCodes.has(code)).slice(0, 2));
        request.reject(new Error(`role_rpc_${request.operation}_${typeof message.code === "string" && rpcResponseFailureCodes.has(message.code) ? message.code : "owner_failed"}`));
      }
    });
  }
  async request(input: Request): Promise<unknown> {
    await this.ready;
    if (this.exited || !this.child.connected || requireRoleBenchmarkBrowser().nonce !== this.nonce) throw new Error("role_rpc_scope_unavailable");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); if (input.operation === "close") this.closeEvidence.timedOut = true;
        reject(new Error(input.operation === "close" ? "role_rpc_close_ack_timeout" : "role_rpc_request_timeout")); }, input.operation === "close" ? 20_000 : 180_000);
      this.waiting.set(id, { operation: input.operation, resolve, reject, timer });
      this.child.send({ ...input, id, nonce: this.nonce }, error => { if (error) { clearTimeout(timer); this.waiting.delete(id); reject(new Error("role_rpc_request_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const failures: Error[] = [], fail = (error: unknown, fallback: string) => {
      const code = rpcFailureCode(error, fallback); this.closeEvidence.failures.push(code); failures.push(new Error(code));
    };
    if (!this.exited) {
      try {
        const closed = await this.request({ operation: "close" });
        if (!closed || typeof closed !== "object" || !("closed" in closed) || closed.closed !== true) throw new Error("role_rpc_close_ack_missing");
        this.closeEvidence.acknowledged = true;
      } catch (error) { fail(error, "role_rpc_close_failed"); }
      try { if (this.child.connected) this.child.disconnect(); } catch (error) { fail(error, "role_rpc_disconnect_failed"); }
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.end, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { this.closeEvidence.timedOut = true; reject(new Error("role_rpc_exit_timeout")); }, 20_000);
      })]);
    } catch (error) {
      fail(error, "role_rpc_exit_failed"); this.closeEvidence.forcedKill = true;
      try { if (!this.child.kill("SIGKILL")) fail(null, "role_rpc_kill_not_delivered"); } catch (failure) { fail(failure, "role_rpc_kill_failed"); }
      let killed: NodeJS.Timeout | undefined;
      try { await Promise.race([this.end, new Promise<never>((_resolve, reject) => { killed = setTimeout(() => reject(new Error("role_rpc_kill_exit_timeout")), 2_000); })]); }
      catch (failure) { fail(failure, "role_rpc_kill_exit_failed"); }
      finally { if (killed) clearTimeout(killed); }
    } finally { if (timer) clearTimeout(timer); }
    if (!this.closeEvidence.acknowledged) fail(null, "role_rpc_closed_without_ack");
    if (this.closeEvidence.exited && (this.closeEvidence.exitCode !== 0 || this.closeEvidence.signal !== null)) fail(null, "role_rpc_unclean_exit");
    if (failures.length) throw new AggregateError(failures, "role_rpc_cleanup_failed");
  }
}

const unfinished = new Set<{ close(): Promise<void> }>();
export async function closeRoleBenchmarkBrowsers() {
  const failures: unknown[] = [];
  for (const value of [...unfinished]) { try { await value.close(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "role_benchmark_remaining_cleanup_failed");
}
export async function roleBenchmarkBrowser(leaf: string) {
  const isolated = requireRoleBenchmarkBrowser(), requests: Record<string, unknown>[] = [], proof: Record<string, unknown> = {
    leaf, nonce: isolated.nonce,
    admission: "Actual personal OIDC, current membership, real business owner source admissions, scans, parsers, controlled assets and real native Worker; only paid model HTTP is synthetic",
    creativeLimit: "Browser creative uses a real partial research record without remote image media. Fixed creative remote bytes are covered separately by isolated integration, not claimed here.",
    cleanupOwner: "This fixture drains its child owner/storage/DB connections and restores original roles. The outer disposable runner deletes all nonce data, bucket and identity resources.",
  };
  let fixture: Awaited<ReturnType<typeof knowledgeGovernanceFixture>> | undefined, rpc: RoleOwnerRpc | undefined, closed = false;
  try {
    fixture = await knowledgeGovernanceFixture(`role-benchmark-${leaf}`, { onModelRequest: value => requests.push(value) });
    const session = ErpSessionViewSchema.parse(await centerApi("identity/session")), actual = actors().operator;
    if (session.userId !== actual.userId || session.tenantId !== actual.tenantId) throw new Error("Role benchmark requires the actual personal operator membership");
    rpc = new RoleOwnerRpc(isolated.nonce); await rpc.request({ operation: "initialize", context: TenantContextSchema.parse(session) });
  } catch (error) {
    const failures: unknown[] = [error];
    try { await rpc?.close(); } catch (failure) { failures.push(failure); }
    try { await fixture?.close(); } catch { failures.push(new Error("model_fixture_cleanup_failed")); }
    if (failures.length > 1) throw new AggregateError(failures, "role_benchmark_initialization_and_cleanup_failed");
    throw error;
  }
  const owner = fixture, child = rpc;
  const result = { fixture: owner, proof, requests,
    async source(role: RoleBenchmarkRole, complete: boolean) { const source = SourceSchema.parse(await child.request({ operation: "source", role, complete })); if (source.role !== role || source.complete !== complete) throw new Error("Original role source response binding mismatch"); return source; },
    async state() { return StateSchema.parse(await child.request({ operation: "state" })); },
    async output(itemId: string, versionId: string) { return LegacyAssistResultSchema.parse(await child.request({ operation: "output", itemId, versionId })); },
    async close() {
      if (closed) return; const errors: string[] = [], failures: unknown[] = [];
      try { await child.close(); proof.childDrained = true; } catch (error) { errors.push("role_owner_child_cleanup_failed"); failures.push(error); }
      finally { proof.childClose = { ...child.closeEvidence, failures: [...child.closeEvidence.failures] }; }
      try { await owner.close(); proof.rolesRestored = true; proof.processorDatabaseClosed = true; } catch { errors.push("model_fixture_cleanup_failed"); failures.push(new Error("model_fixture_cleanup_failed")); }
      closed = true; unfinished.delete(result); proof.cleanupErrors = errors;
      try { const owned = resolve(ownedRoot, isolated.nonce); await mkdir(owned, { recursive: true }); await writeFile(resolve(owned, leaf + ".json"), JSON.stringify(proof, null, 2) + "\n"); }
      catch { failures.push(new Error("role_fixture_proof_write_failed")); }
      if (failures.length) throw new AggregateError(failures, "role_benchmark_fixture_cleanup_failed");
    },
  };
  unfinished.add(result); return result;
}
