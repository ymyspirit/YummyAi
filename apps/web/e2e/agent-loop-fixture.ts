import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { requireDisposableIntegrationEnvironment } from "../../../tools/testing/require-disposable-integration.mjs";
import { agentReadBrowserFixture, requireAgentReadBrowser } from "./agent-read-fixture";
import type * as FixtureModule from "../../api/src/ai/agent-loop.test-fixture.js";
import type * as NativeProcessor from "../../worker/src/processors/agent-loop.processor.js";
import type * as AiCoreModule from "../../../packages/ai-core/src/index.js";
import type * as JobsModule from "../../../packages/jobs/src/index.js";

const workspace = fileURLToPath(new URL("../../../", import.meta.url)), thisFile = fileURLToPath(import.meta.url);
export function requireAgentLoopBrowser() {
  const url = new URL(requireDisposableIntegrationEnvironment()), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1], redis = process.env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || process.env.E2E_AGENT_LOOP_ISOLATED !== "1" || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` ||
    !redis || process.env.REDIS_URL !== redis || process.env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(redis).hostname))
    throw new Error("Agent loop browser requires every exact isolated nonce resource before connection");
  requireAgentReadBrowser(); return { url: url.href, nonce };
}
const Seed = z.object({ orderId: z.uuidv7(), exceptionId: z.uuidv7(), stockItemId: z.uuidv7(), locationIds: z.array(z.uuidv7()).min(1).max(105) }).strict();
const Stats = z.object({ modelCalls: z.int().nonnegative(), readCalls: z.int().nonnegative(), modelGateEntered: z.boolean(), settled: z.boolean(),
  failure: z.string().nullable(), originalQueueJobId: z.string().nullable() }).strict();
type Command = { operation: "seed"; context: TenantContext; accountId: string; count: number } |
  { operation: "execute"; runId: string; holdFirstModel: boolean; bothTools: boolean } | { operation: "progress" | "release" | "wait" | "close" };

class LoopChild {
  private readonly child: ChildProcess;
  private readonly ready: Promise<void>;
  private readonly ended: Promise<void>;
  private sequence = 0; private exited = false; private badExit = false; private closing: Promise<void> | undefined;
  private readonly waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor() {
    const { nonce } = requireAgentLoopBrowser();
    this.child = spawn(process.execPath, ["--import", pathToFileURL(resolve(workspace, "apps/api/node_modules/tsx/dist/loader.mjs")).href, thisFile, "--agent-loop-browser-child"],
      { cwd: workspace, windowsHide: true, env: { ...process.env, TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(workspace, "apps/api/tsconfig.json") }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let ready!: () => void, rejectReady!: (error: Error) => void;
    this.ready = new Promise((accept, reject) => { ready = accept; rejectReady = reject; });
    const timer = setTimeout(() => rejectReady(new Error("agent_loop_child_ready_timeout")), 30_000);
    this.ended = new Promise(accept => this.child.once("exit", (code, signal) => {
      clearTimeout(timer); this.exited = true; this.badExit = code !== 0 || signal !== null; rejectReady(new Error("agent_loop_child_exited"));
      for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("agent_loop_child_pending_exit")); }
      this.waiting.clear(); accept();
    }));
    this.child.once("error", () => { clearTimeout(timer); rejectReady(new Error("agent_loop_child_spawn_failed")); });
    this.child.on("message", raw => {
      if (!raw || typeof raw !== "object") return; const value = raw as Record<string, unknown>;
      if (value.nonce !== nonce) return;
      if (value.type === "ready") { clearTimeout(timer); ready(); return; }
      if (typeof value.id !== "number") return;
      const pending = this.waiting.get(value.id); if (!pending) return; this.waiting.delete(value.id); clearTimeout(pending.timer);
      if (value.type === "result") pending.resolve(value.value);
      else pending.reject(new Error("agent_loop_child_" + (typeof value.phase === "string" && /^[a-z0-9_]{1,50}$/.test(value.phase) ? value.phase : "failed") +
        (typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code) ? "_" + value.code : "")));
    });
  }
  async request(input: Command): Promise<unknown> {
    await this.ready; if (this.exited || !this.child.connected) throw new Error("agent_loop_child_unavailable");
    const id = ++this.sequence, { nonce } = requireAgentLoopBrowser();
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("agent_loop_child_request_timeout")); }, 120_000);
      this.waiting.set(id, { resolve: accept, reject, timer });
      this.child.send({ ...input, nonce, id }, error => { if (error) { clearTimeout(timer); this.waiting.delete(id); reject(new Error("agent_loop_child_delivery_failed")); } });
    });
  }
  close() { return this.closing ??= this.drain(); }
  private async drain() {
    const errors: unknown[] = [];
    if (!this.exited) {
      try { z.object({ closed: z.literal(true) }).strict().parse(await this.request({ operation: "close" })); } catch (error) { errors.push(error); }
      if (this.child.connected) this.child.disconnect();
    }
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([this.ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("agent_loop_child_drain_timeout")), 20_000); })]); }
    catch (error) {
      errors.push(error); this.child.kill("SIGKILL"); let killed: NodeJS.Timeout | undefined;
      try { await Promise.race([this.ended, new Promise<never>((_, reject) => { killed = setTimeout(() => reject(new Error("agent_loop_child_kill_exit_timeout")), 2_000); })]); }
      catch (failure) { errors.push(failure); } finally { if (killed) clearTimeout(killed); }
    } finally { if (timer) clearTimeout(timer); }
    if (this.badExit) errors.push(new Error("agent_loop_child_unclean_exit"));
    if (errors.length) throw new AggregateError(errors, "agent_loop_child_cleanup_failed");
  }
}

export async function agentLoopBrowserFixture(leaf: string) {
  requireAgentLoopBrowser(); const base = await agentReadBrowserFixture("loop-" + leaf); let child: LoopChild | undefined;
  return { ...base,
    async seed(count: number) { child ??= new LoopChild(); return Seed.parse(await child.request({ operation: "seed", context: base.context, accountId: base.model.storeId, count })); },
    async execute(id: string, options: { holdFirstModel?: boolean; bothTools?: boolean } = {}) {
      if (!child) throw new Error("Agent loop child has no real sources");
      return z.object({ started: z.literal(true), originalQueueJobId: z.string().min(1) }).strict().parse(await child.request({ operation: "execute", runId: id,
        holdFirstModel: options.holdFirstModel ?? false, bothTools: options.bothTools ?? false }));
    },
    async progress() { if (!child) throw new Error("Agent loop child missing"); return Stats.parse(await child.request({ operation: "progress" })); },
    async release() { if (!child) throw new Error("Agent loop child missing"); await child.request({ operation: "release" }); },
    async wait() { if (!child) throw new Error("Agent loop child missing"); return Stats.parse(await child.request({ operation: "wait" })); },
    async businessState() {
      const { withTenant } = await import("@yummyai/database"), { sql } = await import("drizzle-orm");
      return withTenant(base.database.db, base.context, async tx => {
        const values: Record<string, { count: number; hash: string }> = {};
        for (const table of ["orders", "order_lines", "order_source_snapshots", "order_exceptions", "order_exception_events", "order_events", "order_protected_access_events",
          "inventory_balances", "inventory_movements", "inventory_reservations", "inventory_reservation_events"])
          values[table] = (await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,
            md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as hash from ${sql.identifier(table)} t`))[0]!;
        return values;
      });
    },
    async loopState(requestId: string) {
      const { withTenant } = await import("@yummyai/database"), { sql } = await import("drizzle-orm");
      return withTenant(base.database.db, base.context, async tx => {
        const rows = await tx.execute<{ id: string; requestId: string; status: string; inputChecksum: string; modelTurns: number }>(sql`
          select id,request_id as "requestId",status,input_checksum as "inputChecksum",model_turns as "modelTurns" from agent_loop_runs
          where owner_id=${base.context.userId}::uuid and request_id=${requestId}::uuid order by id`);
        const budgets = await tx.execute<{ id: string; state: string; amountUsd: string }>(sql`select b.id,b.state,b.amount_usd::text as "amountUsd"
          from ai_budget_ledger b join agent_loop_runs r on r.tenant_id=b.tenant_id and r.id=b.request_id
          where r.owner_id=${base.context.userId}::uuid and r.request_id=${requestId}::uuid order by b.id`);
        const audits = await tx.execute<{ action: string; count: number }>(sql`select a.action,count(*)::int as count from audit_events a join agent_loop_runs r
          on r.tenant_id=a.tenant_id and r.id=a.entity_id where r.request_id=${requestId}::uuid group by a.action order by a.action`);
        return { runs: Array.from(rows), budgets: Array.from(budgets), audits: Array.from(audits) };
      });
    },
    async close() {
      const failures: unknown[] = []; try { await child?.close(); } catch (error) { failures.push(error); }
      try { await base.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "agent_loop_browser_fixture_cleanup_failed");
    },
  };
}

async function loopChild() {
  const { url, nonce } = requireAgentLoopBrowser();
  const [{ connectDatabase, withTenant, loadCurrentMembershipContext }, { intersectPermissionContexts }, { createEnvironmentSecretVault }, jobs, owner, native] = await Promise.all([
    import("@yummyai/database"), import("@yummyai/authz"),
    import(pathToFileURL(resolve(workspace, "packages/ai-core/src/index.ts")).href) as Promise<typeof AiCoreModule>,
    import(pathToFileURL(resolve(workspace, "packages/jobs/src/index.ts")).href) as Promise<typeof JobsModule>,
    import(pathToFileURL(resolve(workspace, "apps/api/src/ai/agent-loop.test-fixture.ts")).href) as Promise<typeof FixtureModule>,
    import(pathToFileURL(resolve(workspace, "apps/worker/src/processors/agent-loop.processor.ts")).href) as Promise<typeof NativeProcessor>,
  ]);
  const database = connectDatabase(url), fixture = owner.agentLoopFixture(database, {
    contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"), modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"),
  }), queue = jobs.createQueue(jobs.QueueName.AgentLoop, process.env.E2E_DISPOSABLE_REDIS_URL);
  let context: TenantContext | undefined, source: z.infer<typeof Seed> | undefined, active: Promise<unknown> | undefined, phase = "ready", settled = false;
  let failure: string | null = null, originalQueueJobId: string | null = null, modelGateEntered = false, releaseGate: (() => void) | undefined;
  const stats = () => Stats.parse({ modelCalls: fixture.modelCalls.length, readCalls: fixture.readCalls.length, modelGateEntered, settled, failure, originalQueueJobId });
  let serial = Promise.resolve(), closed = false;
  const close = async () => {
    if (closed) return; closed = true; releaseGate?.(); const failures: unknown[] = [];
    try { await active; } catch (error) { failures.push(error); }
    try { await queue.close(); } catch (error) { failures.push(error); }
    try { fixture.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "agent_loop_rpc_close_failed");
  };
  process.on("disconnect", () => { releaseGate?.(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>; if (message.nonce !== nonce || typeof message.id !== "number") return;
      try {
        let value: unknown;
        if (message.operation === "close") { await close(); value = { closed: true }; }
        else if (message.operation === "seed") {
          phase = "identity"; const ceiling = TenantContextSchema.parse(message.context);
          context = await withTenant(database.db, ceiling, async tx => intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true })));
          const accountId = z.uuidv7().parse(message.accountId), count = z.int().min(1).max(105).parse(message.count), external = createEntityId();
          phase = "order";
          const order = await fixture.base.orders.ingestNormalized(context, { accountId, platform: "amazon", externalEventId: external + ":1", externalOrderId: external,
            providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 1000, currency: "USD" },
            lines: [{ externalLineId: external + ":line", externalListingId: null, skuCode: null, title: "Synthetic bounded Agent metadata order", quantity: 1,
              unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 }], redactedSource: { fixture: "agent-loop", id: external }, protectedDetails: null });
          const basis = await fixture.base.orders.exceptionOperations(context, order.id);
          const exception = await fixture.base.orders.openExceptionReviewed(context, order.id, { category: "address", code: "SYNTHETIC_LOOP_PRIVATE_CODE", message: "Synthetic private exception excluded from tool DTOs",
            expectedOrderSequence: basis.orderSequence, expectedSourceChecksum: basis.sourceChecksum, idempotencyKey: randomUUID() });
          phase = "inventory"; const suffix = createEntityId().slice(-12).toUpperCase();
          const warehouse = await fixture.base.inventory.createWarehouse(context, { code: "LOOP-" + suffix, name: "Synthetic bounded Agent warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
          const item = await fixture.base.inventory.createStockItem(context, { code: "LOOP-MAT-" + suffix, name: "Synthetic exact loop stock", skuId: null, baseUnit: "meter" });
          const locationIds: string[] = [];
          for (let index = 0; index < count; index++) {
            phase = "balance_" + index;
            const location = await fixture.base.inventory.createLocation(context, { warehouseId: warehouse.id, code: "LOOP-LOC-" + index, name: "Synthetic loop location " + index }); locationIds.push(location.id);
            await fixture.base.inventory.recordMovement(context, { stockItemId: item.id, locationId: location.id, lotId: null, bucket: "physical", type: "opening", quantityDelta: "1.000000001", unit: "meter",
              sourceType: "opening", sourceId: "synthetic-loop:" + location.id, reasonCode: "INITIAL_COUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
          }
          source = Seed.parse({ orderId: order.id, exceptionId: exception.id, stockItemId: item.id, locationIds }); value = source;
        } else if (message.operation === "execute") {
          if (!source || !context || active && !settled) throw new Error("agent_loop_rpc_execution_unavailable");
          const id = z.uuidv7().parse(message.runId);
          const job = await queue.getJob(id); if (!job?.id) throw new Error("agent_loop_real_redis_intent_missing");
          const envelope = jobs.JobEnvelopeSchema.parse(job.data); const payload = z.object({ runId: z.uuidv7(), operation: z.literal("execute") }).strict().parse(envelope.payload);
          if (payload.runId !== id || envelope.tenantId !== context.tenantId || envelope.requestedBy !== context.userId) throw new Error("agent_loop_real_redis_identity_mismatch");
          originalQueueJobId = job.id; modelGateEntered = false; settled = false; failure = null;
          let gate: Promise<void> | undefined;
          if (message.holdFirstModel === true) gate = new Promise(accept => { releaseGate = accept; });
          fixture.controls.beforeModel = async packet => { if (packet.turn === 1 && gate) { modelGateEntered = true; await gate; } };
          fixture.controls.decision = packet => !packet.collections.length ? message.bothTools === true ? owner.exceptionDecision(source!.orderId) : owner.inventoryDecision(source!.stockItemId)
            : message.bothTools === true && packet.collections.length === 1 ? owner.inventoryDecision(source!.stockItemId) : owner.finishLoop(packet);
          phase = "execute_original_envelope";
          active = new native.AgentLoopProcessor(fixture.runtime()).process(envelope).then(result => { settled = true; return result; }, error => { settled = true; failure = "runtime_rejected"; throw error; });
          void active.catch(() => {}); value = { started: true, originalQueueJobId };
        } else if (message.operation === "release") { releaseGate?.(); value = { released: true }; }
        else if (message.operation === "progress") value = stats();
        else if (message.operation === "wait") { await active; value = stats(); }
        else throw new Error("agent_loop_rpc_operation_invalid");
        process.send?.({ type: "result", nonce, id: message.id, value });
      } catch (error) {
        let code: string | null = null, candidate: unknown = error;
        for (let depth = 0; depth < 6 && candidate && typeof candidate === "object"; depth++) {
          if ("code" in candidate && typeof candidate.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code)) { code = candidate.code; break; }
          candidate = "cause" in candidate ? candidate.cause : null;
        }
        process.send?.({ type: "failure", nonce, id: message.id, phase, code });
      }
    });
  });
  process.send?.({ type: "ready", nonce });
}
if (process.argv.includes("--agent-loop-browser-child")) void loopChild().catch(() => { process.exitCode = 1; process.disconnect?.(); });
