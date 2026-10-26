import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import type { TenantContext } from "@yummyai/contracts";
import { requireAgentNativeV4Environment } from "../../../tools/testing/require-agent-native-v4-environment.mjs";
import { agentReadBrowserFixture } from "./agent-read-fixture";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Seed = z.object({ spuId: Id, stockItemId: Id, modelId: Id, query: z.string().min(1), requisitionCode: z.string().min(1),
  journalSha256: Hash, currentMigrations: z.int().positive() }).strict();
const Plan = z.object({ runId: Id, requestId: z.uuid(), itemId: Id, proposalChecksum: Hash, knowledgeEntryId: Id,
  knowledgeVersion: z.int().positive(), knowledgeChecksum: Hash, modelCalls: z.int().positive(), knownCostUsd: z.string() }).strict();
const State = z.object({ requisitions: z.int().nonnegative(), modelCalls: z.int().nonnegative(), providerFailures: z.int().nonnegative(),
  parentChecksum: Hash.nullable(), commandState: z.string().nullable() }).strict();
type P6Seed = z.infer<typeof Seed>;
type P6Plan = z.infer<typeof Plan>;
type P6State = z.infer<typeof State>;
type Request = { operation: "seed"; context: TenantContext } | { operation: "plan"; entryId: string; version: number }
  | { operation: "state"; commandId?: string } | { operation: "close" };

function environment() {
  if (process.env.E2E_P6_KNOWLEDGE_AGENT_ISOLATED !== "1") throw new Error("p6_personal_browser_isolation_required");
  return requireAgentNativeV4Environment(process.env, "current", true);
}

/** This child only exposes seed/process/read/close. Confirmation stays in the real browser. */
class P6Owner {
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private readonly pending = new Map<number, { accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private exited = false;
  private badExit = false;
  private closing: Promise<void> | undefined;
  constructor() {
    const { nonce } = environment();
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(root, "apps/api/node_modules/tsx/dist/loader.mjs")).href,
      resolve(root, "tools/testing/p6-knowledge-agent-browser.mts"), "--p6-knowledge-agent-child"], {
      cwd: root, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "apps/api/tsconfig.json") },
    });
    let acceptReady!: () => void, rejectReady!: (failure: Error) => void;
    this.ready = new Promise((accept, reject) => { acceptReady = accept; rejectReady = reject; });
    const readyTimer = setTimeout(() => rejectReady(new Error("p6_owner_ready_timeout")), 30_000);
    this.ended = new Promise(accept => this.child.once("exit", (code, signal) => {
      this.exited = true; this.badExit = code !== 0 || signal !== null; clearTimeout(readyTimer);
      rejectReady(new Error("p6_owner_exited_before_ready"));
      for (const row of this.pending.values()) { clearTimeout(row.timer); row.reject(new Error("p6_owner_ended_with_pending_request")); }
      this.pending.clear(); accept();
    }));
    this.child.once("error", () => { clearTimeout(readyTimer); rejectReady(new Error("p6_owner_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return;
      const row = raw as Record<string, unknown>;
      if (row.nonce !== nonce) return;
      if (row.type === "ready") { clearTimeout(readyTimer); acceptReady(); return; }
      if (typeof row.id !== "number") return;
      const pending = this.pending.get(row.id); if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(row.id);
      if (row.type === "result") pending.accept(row.value);
      else pending.reject(new Error("p6_owner_failed_" + (typeof row.phase === "string" && /^[a-z0-9_]{1,60}$/.test(row.phase) ? row.phase : "unknown")
        + (typeof row.code === "string" && /^p6_[a-z0-9_]+$/.test(row.code) ? "_" + row.code : "")));
    });
  }
  async request(request: Request) {
    await this.ready;
    if (this.exited || !this.child.connected) throw new Error("p6_owner_unavailable");
    const id = ++this.sequence, { nonce } = environment();
    return new Promise<unknown>((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("p6_owner_request_timeout_" + request.operation)); },
        request.operation === "seed" || request.operation === "plan" ? 120_000 : 30_000);
      this.pending.set(id, { accept, reject, timer });
      this.child.send({ ...request, nonce, id }, failure => { if (failure) { clearTimeout(timer); this.pending.delete(id); reject(new Error("p6_owner_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const errors: unknown[] = [];
    if (!this.exited) {
      try { z.object({ closed: z.literal(true) }).strict().parse(await this.request({ operation: "close" })); }
      catch (failure) { errors.push(failure); }
      if (this.child.connected) this.child.disconnect();
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("p6_owner_drain_timeout")), 30_000); })]); }
    catch (failure) {
      errors.push(failure); this.child.kill("SIGKILL");
      let killed: NodeJS.Timeout | undefined;
      try { await Promise.race([this.ended, new Promise<never>((_, reject) => { killed = setTimeout(() => reject(new Error("p6_owner_kill_exit_timeout")), 2_000); })]); }
      catch (error) { errors.push(error); }
      finally { if (killed) clearTimeout(killed); }
    }
    finally { if (timer) clearTimeout(timer); }
    if (this.badExit) errors.push(new Error("p6_owner_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "p6_owner_cleanup_failed");
  }
}

export async function p6KnowledgeAgentFixture(leaf: string) {
  environment();
  const base = await agentReadBrowserFixture("p6-" + leaf);
  let child: P6Owner | undefined;
  try {
    child = new P6Owner();
    const owner = child, seed: P6Seed = Seed.parse(await owner.request({ operation: "seed", context: base.context }));
    let closed = false;
    return { ...base, seed,
      async plan(entryId: string, version: number): Promise<P6Plan> { return Plan.parse(await owner.request({ operation: "plan", entryId, version })); },
      async nativeState(commandId?: string): Promise<P6State> { return State.parse(await owner.request({ operation: "state", ...(commandId ? { commandId } : {}) })); },
      async close() {
        if (closed) return; closed = true;
        const errors: unknown[] = [];
        try { await owner.close(); } catch (failure) { errors.push(failure); }
        try { await base.close(); } catch (failure) { errors.push(failure); }
        if (errors.length) throw new AggregateError(errors, "p6_fixture_cleanup_failed");
      },
    };
  } catch (failure) {
    const errors: unknown[] = [failure];
    try { await child?.close(); } catch (error) { errors.push(error); }
    try { await base.close(); } catch (error) { errors.push(error); }
    throw new AggregateError(errors, "p6_fixture_initialization_failed");
  }
}
