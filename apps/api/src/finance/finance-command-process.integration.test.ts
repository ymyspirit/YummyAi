import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { FinanceCommandDetailSchema, FinanceCommandOriginalSchema } from "@yummyai/contracts/finance/finance-command";
import { connectDatabase, financeCommands, migrateDatabase, withTenant } from "@yummyai/database";
import { createQueue, QueueName } from "../../../../packages/jobs/src/index.js";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { financeCommandBusinessTables, financeCommandFixture, financeCommandKey, requireFinanceCommandFixture,
  type FinanceCommandScenario } from "./finance-command.fixtures.js";

requireFinanceCommandFixture();
if (process.env.E2E_FINANCE_COMMAND_PROCESS_ISOLATED !== "1") throw new Error("Finance process acceptance requires its own disposable process suite");
type Event = { type: string; phase?: string; state?: string; commandId?: string; pid?: number; url?: string;
  scheduler?: string; queues?: string[]; schedulers?: string[]; redacted?: number; failures?: number; receivedAt: number };
type Identity = Awaited<ReturnType<typeof startFactoryIdentityFixture>>;
type Probe = { child: ChildProcess; events: Event[]; closed: Promise<number>;
  wait(type: string, phase?: string, after?: number, timeoutMs?: number): Promise<Event>; stop(force?: boolean): Promise<number> };
const apiDirectory = fileURLToPath(new URL("../../", import.meta.url)), phases = ["before_commit", "after_commit"] as const;
const cases = ["statement_record", "payment_allocate", "bill_adjustment_record", "cost_version_approve"] as const;
const tables = { statement_record: "finance_statements", payment_allocate: "finance_payment_allocation_batches",
  bill_adjustment_record: "finance_bill_adjustments", cost_version_approve: "finance_cost_allocation_versions" };

describe.sequential("finance originals survive actual API exits and an independent zero-consumer privacy process", () => {
  const database = connectDatabase(), f = financeCommandFixture(database), identities = new Map<string, Identity>(), probes: Probe[] = [];
  beforeAll(async () => { await migrateDatabase(database); await f.initialize(); }, 90_000);
  afterEach(async () => {
    const stopped = await Promise.allSettled(probes.map(probe => probe.stop(true)));
    await f.restoreRights(); await f.cleanupCommands();
    if (stopped.some(result => result.status === "rejected")) throw new Error("Owned Finance process cleanup incomplete");
  }, 60_000);
  afterAll(async () => {
    const stopped = await Promise.allSettled(probes.map(probe => probe.stop(true)));
    try { await Promise.all([...identities.values()].map(identity => identity.close())); }
    finally { f.destroy(); await database.client.end(); }
    const allExited = probes.every(probe => probe.child.exitCode !== null || probe.child.signalCode !== null);
    process.stdout.write(JSON.stringify({ type: "finance.process.teardown", pids: probes.map(probe => probe.child.pid), allExited,
      identitiesClosed: identities.size }) + "\n");
    if (!allExited || stopped.some(result => result.status === "rejected")) throw new Error("Owned Finance child remains active");
  }, 60_000);
  function observe(child: ChildProcess): Probe {
    const events: Event[] = []; let exited = false, pending = "";
    const accept = (raw: unknown) => {
      if (!raw || typeof raw !== "object" || !("type" in raw) || typeof raw.type !== "string") return;
      const item = raw as Omit<Event, "receivedAt">;
      // Keep lifecycle identifiers and counts only; never retain private input,
      // a JWT, encryption key, arbitrary stderr or an upstream error body.
      if (!["finance.fixture.ready", "finance.fixture.barrier", "finance.fixture.closed", "worker.lifecycle", "worker.maintenance"].includes(item.type)) return;
      events.push({ type: item.type, phase: item.phase, state: item.state, commandId: item.commandId, pid: item.pid, url: item.url,
        scheduler: item.scheduler, queues: item.queues, schedulers: item.schedulers, redacted: item.redacted, failures: item.failures, receivedAt: performance.now() });
    };
    child.on("message", accept);
    child.stderr?.on("data", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8"); const lines = pending.split("\n"); pending = lines.pop()!.slice(-65_536);
      for (const line of lines) { try { accept(JSON.parse(line)); } catch { /* Private raw output is intentionally discarded. */ } }
    });
    const closed = new Promise<number>(resolve => {
      child.once("error", () => { exited = true; resolve(-1); }); child.once("exit", code => { exited = true; resolve(code ?? -1); });
    });
    const probe: Probe = { child, events, closed,
      wait: (type, phase, after = 0, timeoutMs = 40_000) => new Promise((resolve, reject) => {
        const find = () => events.slice(after).find(event => event.type === type && (!phase || event.phase === phase || event.state === phase));
        const known = find(); if (known) { resolve(known); return; }
        if (exited) { reject(new Error(`Owned Finance process exited before ${type}`)); return; }
        const clean = () => { clearTimeout(timer); child.off("message", changed); child.stdout?.off("data", changed); child.off("exit", stopped); child.off("error", stopped); };
        const changed = () => { const event = find(); if (event) { clean(); resolve(event); } };
        const stopped = () => { clean(); reject(new Error(`Owned Finance process exited before ${type}`)); };
        const timer = setTimeout(() => { clean(); reject(new Error(`Owned Finance lifecycle deadline ${type}`)); }, timeoutMs);
        child.on("message", changed); child.stdout?.on("data", changed); child.once("exit", stopped); child.once("error", stopped);
      }),
      async stop(force = false) {
        if (!exited) { if (force || !child.connected) child.kill("SIGKILL"); else child.send("shutdown", () => {}); }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Owned Finance shutdown deadline")); }, 10_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      },
    }; probes.push(probe); return probe;
  }
  async function identity(s: FinanceCommandScenario) {
    const old = identities.get(s.context.tenantId); if (old) return old;
    const monetary = s.context.tenantId === f.cost.context.tenantId, subject = monetary ? "monetary" : "procurement-command";
    const value = await startFactoryIdentityFixture(s.context.tenantId, `${subject}-${s.context.userId}`, "http://localhost:3130", {
      application: "erp", clientId: "yummyai-web", accounts: {
        coworker: { subject: `${monetary ? "allocation" : subject}-${s.coworker.userId}`, name: "Synthetic Finance coworker" },
        outsider: { subject: `${subject}-${s.outsider.userId}`, name: "Synthetic foreign Finance operator", tenantId: s.outsider.tenantId },
      },
    }); identities.set(s.context.tenantId, value); return value;
  }
  function launch(auth: Identity, options: { gate?: typeof phases[number]; action?: "prepare" | "execute"; commandId?: string; requestKey?: string } = {}) {
    return observe(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/testing/finance-api-process-fixture.mts"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, NODE_ENV: "test", TSX_DISABLE_CACHE: "1",
        OIDC_ISSUER: auth.baseUrl, OIDC_JWKS_URI: `${auth.baseUrl}/protocol/openid-connect/certs`, FINANCE_COMMAND_ENCRYPTION_KEY: f.key.toString("base64url"),
        FINANCE_FIXTURE_GATE: options.gate ?? "none", FINANCE_FIXTURE_ACTION: options.action ?? "execute",
        FINANCE_FIXTURE_COMMAND_ID: options.commandId, FINANCE_FIXTURE_REQUEST_KEY: options.requestKey },
    }));
  }
  async function request(probe: Probe, auth: Identity, path = "", body?: unknown) {
    const ready = await probe.wait("finance.fixture.ready");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(ready.url ?? "")) throw new Error("Unsafe isolated Finance API origin");
    return fetch(`${ready.url}/v1/finance/commands${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${await auth.operatorToken()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(50_000) });
  }
  async function detail(response: Response, status = 200) { expect(response.status).toBe(status); return FinanceCommandDetailSchema.parse(await response.json()); }
  function fixed(row: Awaited<ReturnType<typeof f.row>>) {
    return { id: row.id, kind: row.kind, targetId: row.target_id, actor: row.created_by, key: row.request_key, checksum: row.request_checksum,
      ownerChecksum: row.owner_input_checksum, cipher: row.encrypted_input, authority: row.authority_snapshot, expiresAt: row.expires_at };
  }

  it.each(phases)("recovers an actually interrupted prepare at %s using the identical original key", async phase => {
    const s = await f.scenario("payment_record"), auth = await identity(s), requestKey = financeCommandKey();
    s.original = { ...s.original, input: { ...s.original.input, idempotencyKey: requestKey } } as typeof s.original;
    const before = await f.state(s.context, financeCommandBusinessTables), interrupted = launch(auth, { gate: phase, action: "prepare", requestKey });
    const response = request(interrupted, auth, "", s.original).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    const barrier = await interrupted.wait("finance.fixture.barrier", phase); expect(barrier.pid).toBe(interrupted.child.pid);
    const visible = await withTenant(database.db, s.context, tx => tx.execute<{ id: string }>(sql`select id from finance_commands where request_key=${requestKey}`));
    expect(visible).toHaveLength(phase === "before_commit" ? 0 : 1);
    if (phase === "after_commit") expect(visible[0]!.id).toBe(barrier.commandId);
    await interrupted.stop(true); expect((await response).received).toBe(false);
    const fresh = launch(auth), resumed = await detail(await request(fresh, auth, "", s.original), 201);
    expect(resumed).toMatchObject({ status: "prepared", requestKey });
    if (phase === "after_commit") expect(resumed.id).toBe(barrier.commandId);
    const originalResponse = await request(fresh, auth, `/${resumed.id}/original`); expect(originalResponse.status).toBe(200);
    expect(FinanceCommandOriginalSchema.parse(await originalResponse.json()).original).toEqual(s.original);
    expect(await f.state(s.context, financeCommandBusinessTables)).toEqual(before); await fresh.stop();
  }, 150_000);

  it.each(cases.flatMap(kind => phases.map(phase => ({ kind, phase }))))("retains one real $kind receipt after API exit $phase", async ({ kind, phase }) => {
    const s = await f.scenario(kind), pending = await f.commands.prepare(s.context, s.original), auth = await identity(s), saved = fixed(await f.row(s.context, pending.id));
    const before = await f.state(s.context), interrupted = launch(auth, { gate: phase, commandId: pending.id });
    const response = request(interrupted, auth, `/${pending.id}/execute`, {}).then(value => ({ received: true, status: value.status }), () => ({ received: false, status: 0 }));
    expect(await interrupted.wait("finance.fixture.barrier", phase)).toMatchObject({ commandId: pending.id, phase, pid: interrupted.child.pid });
    expect((await f.row(s.context, pending.id)).status).toBe(phase === "before_commit" ? "prepared" : "succeeded");
    await interrupted.stop(true); expect((await response).received).toBe(false);
    if (phase === "before_commit") expect(await f.state(s.context)).toEqual(before);
    const fresh = launch(auth), restored = await detail(await request(fresh, auth, `/${pending.id}`));
    expect(restored).toMatchObject({ id: pending.id, requestKey: s.original.input.idempotencyKey, status: phase === "before_commit" ? "prepared" : "succeeded" });
    const readOriginal = await request(fresh, auth, `/${pending.id}/original`); expect(readOriginal.status).toBe(200);
    expect(FinanceCommandOriginalSchema.parse(await readOriginal.json()).original).toEqual(s.original);
    const done = await detail(await request(fresh, auth, `/${pending.id}/execute`, {}));
    expect(done.status).toBe("succeeded"); expect(done.result).not.toBeNull(); expect(fixed(await f.row(s.context, pending.id))).toEqual(saved);
    expect(await f.proof(s.context, done.result!)).toMatchObject({ command_id: pending.id, actor_id: s.context.userId, request_key: s.original.input.idempotencyKey });
    const rows = await withTenant(database.db, s.context, tx => tx.execute<{ id: string }>(sql`
      select id from ${sql.identifier(tables[kind])} where idempotency_key=${s.original.input.idempotencyKey}`));
    expect([...rows]).toEqual([{ id: done.result!.id }]);
    const after = await f.state(s.context); expect((await detail(await request(fresh, auth, `/${pending.id}/execute`, {}))).result).toEqual(done.result);
    expect(await f.state(s.context)).toEqual(after); await fresh.stop();
  }, 150_000);

  it("rechecks current Review after the actual API restarts and only reads an already completed receipt after Review is later revoked", async () => {
    const s = await f.scenario("bill_adjustment_record"), pending = await f.commands.prepare(s.context, s.original), auth = await identity(s), child = launch(auth);
    await child.wait("finance.fixture.ready"); await f.rights(s.context, [Permission.FinanceRead]); const before = await f.state(s.context);
    expect((await request(child, auth, `/${pending.id}/execute`, {})).status).toBe(403); expect(await f.state(s.context)).toEqual(before);
    await f.restoreRights(); const done = await detail(await request(child, auth, `/${pending.id}/execute`, {}));
    await f.rights(s.context, [Permission.FinanceRead]); const after = await f.state(s.context);
    expect((await detail(await request(child, auth, `/${pending.id}/execute`, {}))).result).toEqual(done.result); expect(await f.state(s.context)).toEqual(after);
    await child.stop();
  }, 150_000);

  it("runs actual minute privacy cycles, skips a held input, preserves real receipts and restarts with zero business consumers", async () => {
    const due: string[] = []; let liveId = "", succeededId = "";
    const context = f.payable.context;
    for (let index = 0; index < 102; index++) {
      const s = await f.scenario("payment_adjustment_record"), pending = await f.commands.prepare(s.context, s.original);
      if (index < 101) due.push(pending.id); else liveId = pending.id;
      if (index === 1) { succeededId = pending.id; await f.commands.execute(context, pending.id); }
    }
    const success = await f.commands.get(context, succeededId), successProof = await f.proof(context, success.result!);
    const [lifetime] = await withTenant(database.db, context, tx => tx.execute<{ exact: boolean }>(sql`select expires_at=created_at+interval '7 days' as exact from finance_commands where id=${liveId}::uuid`));
    expect(lifetime!.exact).toBe(true);
    requireFinanceCommandFixture();
    // The exact owned synthetic rows become eight days old; no business fact,
    // proof, amount, creation witness or production gate is rewritten.
    await database.client.begin(async synthetic => {
      await synthetic.unsafe("set local session_replication_role=replica");
      await synthetic.unsafe("with t as(select date_trunc('milliseconds',clock_timestamp()) as at) update finance_commands set created_at=t.at-interval '8 days',expires_at=t.at-interval '1 day' from t where tenant_id=$1 and id=any($2::uuid[])",
        [context.tenantId, `{${due.join(",")}}`]);
    });
    const before = await f.state(context, [...financeCommandBusinessTables, "finance_original_write_proofs"]);
    let unlock!: () => void, ready!: () => void, failed!: (error: unknown) => void;
    const locked = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const holding = withTenant(database.db, context, async tx => {
      await tx.select({ id: financeCommands.id }).from(financeCommands).where(eq(financeCommands.id, due[0]!)).for("update");
      await new Promise<void>(resolve => { unlock = resolve; ready(); });
    }).catch(error => { failed(error); throw error; });
    await locked;
    let queue: ReturnType<typeof createQueue> | undefined, sentinel: Awaited<ReturnType<ReturnType<typeof createQueue>["add"]>> | undefined;
    const maintenance = () => observe(spawn(process.execPath, ["--import", "./node_modules/tsx/dist/loader.mjs", "../../tools/scripts/finance-command-retention-runtime.mjs"], {
      cwd: apiDirectory, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, FINANCE_COMMAND_ENCRYPTION_KEY: f.key.toString("base64url"),
        TSX_DISABLE_CACHE: "1", WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all" },
    }));
    try {
      queue = createQueue(QueueName.WorkflowNode); sentinel = await queue.add("synthetic-finance-retention-sentinel", { synthetic: true }, { jobId: `finance-retention-${randomUUID()}` });
      const child = maintenance(), readyEvent = await child.wait("worker.lifecycle", "ready");
      expect(readyEvent).toMatchObject({ queues: [], schedulers: ["financeCommandRetentionScheduler"] });
      const first = await child.wait("worker.maintenance", "completed", 0, 90_000);
      expect(first).toMatchObject({ scheduler: "financeCommandRetentionScheduler", redacted: 100, failures: 0 });
      expect((await f.row(context, due[0]!)).encrypted_input).not.toBeNull();
      unlock(); await holding;
      const next = await child.wait("worker.maintenance", "completed", child.events.length, 90_000);
      expect(next).toMatchObject({ redacted: 1, failures: 0 }); expect(next.receivedAt - first.receivedAt).toBeGreaterThanOrEqual(55_000);
      expect(next.receivedAt - first.receivedAt).toBeLessThan(90_000);
      expect((await f.row(context, due[0]!)).encrypted_input).toBeNull(); expect((await f.row(context, liveId)).encrypted_input).not.toBeNull();
      expect((await f.commands.get(context, succeededId)).result).toEqual(success.result); expect(await f.proof(context, success.result!)).toEqual(successProof);
      expect(await f.state(context, [...financeCommandBusinessTables, "finance_original_write_proofs"])).toEqual(before);
      expect(await sentinel.getState()).toBe("waiting"); expect(await child.stop()).toBe(0);
      const restarted = maintenance(); expect(await restarted.wait("worker.lifecycle", "ready")).toMatchObject({ queues: [], schedulers: ["financeCommandRetentionScheduler"] });
      expect(await restarted.wait("worker.maintenance", "completed", 0, 90_000)).toMatchObject({ redacted: 0, failures: 0 });
      expect(await sentinel.getState()).toBe("waiting"); expect(await restarted.stop()).toBe(0);
      process.stdout.write(JSON.stringify({ type: "finance.maintenance.accepted", dueCount: due.length, redactedBatches: [first.redacted, next.redacted],
        intervalMs: next.receivedAt - first.receivedAt, zeroConsumers: true, actualProofPreserved: true }) + "\n");
    } finally {
      unlock(); await holding; if (sentinel) await sentinel.remove(); if (queue) await queue.close();
    }
  }, 240_000);
});
