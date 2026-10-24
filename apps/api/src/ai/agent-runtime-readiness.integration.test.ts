import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Permission } from "@yummyai/authz";
import { AgentReadinessFamilySchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { AGENT_RUNTIME_FAMILIES, AGENT_RUNTIME_LEASE_MS, AGENT_RUNTIME_MAX_VALID_MS, AgentRuntimeReadinessSchema } from "@yummyai/contracts/ai/agent-runtime-readiness";
import { AgentNativeV3ReceiptSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { connectDatabase } from "@yummyai/database";
import { requireAgentRuntimeReadinessEnvironment } from "../../../../tools/testing/require-agent-runtime-readiness-environment.mjs";
import { waitForAgentRuntime } from "../../../../tools/testing/agent-runtime-readiness-runtime.mjs";
import { agentRuntimeReadinessFixture } from "./agent-runtime-readiness.test-fixture.js";
import { AgentRuntimeReadinessService } from "./agent-runtime-readiness.service.js";
import { readinessAuthority } from "./agent-readiness.test-fixture.js";
import { bounded, type AgentActor } from "./agent-read.test-fixture.js";

const environment = requireAgentRuntimeReadinessEnvironment(), database = connectDatabase(environment.url), f = agentRuntimeReadinessFixture(database);
const allScopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
const observed: Array<Record<string, unknown>> = [], originals: Array<Record<string, unknown>> = [];
let cleanupFailed = false;
async function read(actor: AgentActor, family: AgentReadinessFamily = "native_v3") {
  const response = await f.http(actor, "/v1/ai/agent-runtime-readiness/" + family);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const value = AgentRuntimeReadinessSchema.parse(await response.json());
  expect(value.family).toBe(family); expect(value.contextAuthority).toBe(readinessAuthority(await f.base.current(actor)));
  expect(response.headers.get("x-yummyai-context-authority")).toBe(value.contextAuthority);
  expect(value.executorVersion).toBe(AGENT_RUNTIME_FAMILIES[family].executorVersion);
  expect(value.effects).toEqual({ modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 });
  expect(value.notChecked).toEqual(["request_budget", "selected_sources", "provider_connection", "business_admission"]);
  expect(Date.parse(value.validUntil) - Date.parse(value.checkedAt)).toBe(value.validForMs);
  expect(value.validForMs).toBeLessThanOrEqual(AGENT_RUNTIME_MAX_VALID_MS);
  observed.push({ family, state: value.state, checks: value.checks, reasons: value.reasons, checkedAt: value.checkedAt,
    validUntil: value.validUntil, validForMs: value.validForMs, authoritySha256: f.hash(value.contextAuthority) });
  return value;
}
async function ready(actor: AgentActor, family: AgentReadinessFamily = "native_v3") {
  return waitForAgentRuntime(async () => { const value = await read(actor, family); return value.state === "observed_ready" ? value : null; }, "runtime_real_presence_not_ready", 25_000);
}
async function stableRead(actor: AgentActor, family: AgentReadinessFamily = "native_v3") {
  const before = await f.state(actor), value = await read(actor, family); expect(await f.state(actor)).toEqual(before); return value;
}
async function expired(value: Awaited<ReturnType<typeof f.original>>) {
  await waitForAgentRuntime(() => f.isExpired(value), "runtime_original_actual_expiry_deadline", 42_000);
}
function sameOriginal(before: Awaited<ReturnType<typeof f.originalMetadata>>, after: Awaited<ReturnType<typeof f.originalMetadata>>) {
  expect({ id: after.id, version: after.version, request: after.request_id, checksum: after.request_checksum, input: after.input_checksum })
    .toEqual({ id: before.id, version: before.version, request: before.request_id, checksum: before.request_checksum, input: before.input_checksum });
  expect(after.status).toBe("expired"); expect(after.step_count).toBe(0); expect(after.private_present).toBe(false);
  originals.push({ id: after.id, version: after.version, requestId: after.request_id, requestChecksum: after.request_checksum,
    inputChecksum: after.input_checksum, status: after.status, steps: after.step_count, privatePresent: after.private_present });
}

describe.sequential("independent Harness runtime proof from actual standard Worker consumers", () => {
  beforeAll(async () => { await f.initialize(); });
  afterAll(async () => {
    const errors: unknown[] = [];
    try { await f.close(); } catch (error) { cleanupFailed = true; errors.push(error); }
    try { await database.client.end(); } catch (error) { cleanupFailed = true; errors.push(error); }
    const directory = resolve(environment.lane, "qa"); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, environment.nonce + "-runtime-proof.json"), JSON.stringify({ operation: "5a91d7c3",
      standardEntry: "apps/worker/src/run.ts", consumerSelection: ["agent-loop", "agent-plan"], observed, originals,
      childProcesses: f.workers.map(worker => worker.evidence), cleanupFailed,
      providerExecution: "only actual expired original runs were handed to a consumer; all original step counts remain zero",
      noOrdinaryQueueConnected: true }, null, 2));
    if (errors.length) throw new AggregateError(errors, "runtime_readiness_disposable_cleanup_failed");
  });

  it("missing_and_dispatcher distinguishes no Worker from a real selected consumer with no recovery scheduler", async () => {
    const { actor } = await f.readiness.actor(false);
    for (const family of AgentReadinessFamilySchema.exclude(["native_v4"]).options) {
      const value = await stableRead(actor, family); expect(value.state).toBe("unavailable"); expect(value.reasons).toContain("runtime_not_observed");
    }
    const worker = await f.launchWorker({ queues: ["agent-plan"], schedulers: [] });
    try {
      expect(await worker.ready()).toMatchObject({ queues: ["agent-plan"], schedulers: [] });
      const view = await waitForAgentRuntime(async () => { const value = await read(actor); return value.checks.consumer === "ready" ? value : null; }, "runtime_consumer_only_not_observed");
      expect(view.state).toBe("unavailable"); expect(view.checks.dispatcher).toBe("unavailable"); expect(view.reasons).toContain("dispatcher_unavailable");
      expect((await stableRead(actor, "loop")).checks.consumer).toBe("unavailable");
    } finally { expect((await worker.stop()).code).toBe(0); }
    expect((await stableRead(actor)).state).toBe("unavailable");
  });

  it("standard_five_expiry processes original five protocol IDs through the two real consumers with no model turn", async () => {
    const values = await Promise.all(AgentReadinessFamilySchema.exclude(["native_v4"]).options.map(family => f.original(family)));
    const before = await Promise.all(values.map(value => f.originalMetadata(value))); await Promise.all(values.map(expired));
    const worker = await f.launchWorker();
    try {
      const lifecycle = await worker.ready(); expect([...lifecycle.queues].sort()).toEqual(["agent-loop", "agent-plan"]);
      expect([...lifecycle.schedulers].sort()).toEqual(["agentLoopScheduler", "agentPlanScheduler"]);
      for (const value of values) await ready(value.actor, value.family);
      for (const [index, value] of values.entries()) {
        const after = await waitForAgentRuntime(async () => { const row = await f.originalMetadata(value); return row.status === "expired" ? row : null; }, "runtime_original_not_expired_by_consumer", 40_000);
        sameOriginal(before[index]!, after);
        const recovered = await value.owner.receipt(await f.base.current(value.actor), { requestId: value.view.requestId, requestChecksum: value.view.requestChecksum });
        expect(recovered).toMatchObject({ disposition: "known", runId: value.view.id, requestChecksum: value.view.requestChecksum });
        expect((await f.state(value.actor)).modelCalls).toBe(0);
      }
      expect(worker.evidence.jobs.some(job => job.queue === "agent-loop" && job.state === "completed")).toBe(true);
      expect(worker.evidence.jobs.some(job => job.queue === "agent-plan" && job.state === "completed")).toBe(true);
    } finally { expect((await worker.stop()).code).toBe(0); }
  });

  it("queue_pause keeps live connections separate and deducts actual time spent after the original inspection", async () => {
    const { actor } = await f.readiness.actor(false), worker = await f.launchWorker();
    try {
      await worker.ready(); await ready(actor); await f.queue("agent-plan").pause();
      const paused = await stableRead(actor); expect(paused.state).toBe("unavailable"); expect(paused.checks.queue).toBe("paused"); expect(paused.reasons).toContain("queue_paused");
      await f.queue("agent-plan").resume(); await ready(actor);
      const hold = f.holdInspect(), pending = f.service.get(await f.base.current(actor), "native_v3");
      try {
        await bounded(hold.entered, "runtime_original_inspection_not_held"); const captured = hold.captured();
        if (!captured || captured.status !== "known" || captured.observations.length !== 1) throw new Error("runtime_held_inspection_missing");
        const until = Date.parse(captured.checkedAt) + captured.observations[0]!.expiresInMs;
        await waitForAgentRuntime(async () => { const actual = await f.presence.inspect("agent-plan"); return actual.status === "known" && Date.parse(actual.checkedAt) > until; }, "runtime_held_proof_server_deadline", AGENT_RUNTIME_LEASE_MS + 5_000);
        hold.release(); const stale = await bounded(pending, "runtime_held_observation_not_settled");
        expect(stale.state).toBe("unavailable"); expect(stale.validForMs).toBe(0);
      } finally { hold.clear(); await pending; }
      await ready(actor);
    } finally { await f.queue("agent-plan").resume(); expect((await worker.stop()).code).toBe(0); }
  });

  it("redis_disconnect withdraws a real consumer and gives unknown when the API observation transport itself is cut", async () => {
    const { actor } = await f.readiness.actor(false), proxy = await f.proxy(), worker = await f.launchWorker({ proxy });
    try {
      await worker.ready(); await ready(actor); const before = await f.state(actor); proxy.cut();
      await waitForAgentRuntime(() => worker.evidence.processExited, "runtime_disconnected_worker_did_not_exit", 20_000);
      expect(worker.evidence.exitCode).toBe(1); expect(worker.evidence.lifecycle.some(event => event.code === "WORKER_CONNECTION_ERROR")).toBe(true);
      expect((await read(actor)).state).not.toBe("observed_ready");
      const unknown = await f.serviceThrough(proxy).get(await f.base.current(actor), "native_v3");
      expect(unknown.state).toBe("unknown"); expect(unknown.checks).toEqual({ consumer: "unknown", dispatcher: "unknown", queue: "unknown" });
      expect(unknown.validForMs).toBe(0); expect(await f.state(actor)).toEqual(before);
    } finally { await worker.stop("kill"); await proxy.close(); }
  });

  it("strong_kill loses the live Worker name immediately and the unwithdrawn original proof expires by actual Redis TTL", async () => {
    const { actor } = await f.readiness.actor(false), worker = await f.launchWorker();
    try {
      await worker.ready(); await ready(actor);
      const proof = await f.presence.inspect("agent-plan"); expect(proof.status).toBe("known");
      const connected = proof.observations.filter(value => proof.connectedWorkerNames.includes(value.report.workerName));
      expect(connected).toHaveLength(1);
      const original = connected[0]!; expect(original.expiresInMs).toBeGreaterThan(0); expect(original.expiresInMs).toBeLessThanOrEqual(AGENT_RUNTIME_LEASE_MS);
      await worker.stop("kill"); expect(worker.evidence.forced).toBe(true);
      expect(worker.evidence.lifecycle.some(event => event.state === "stopped")).toBe(false);
      await waitForAgentRuntime(async () => { const observed = await f.presence.inspect("agent-plan"); return observed.status === "known" && !observed.connectedWorkerNames.includes(original.report.workerName); }, "runtime_killed_name_still_connected");
      expect((await stableRead(actor)).state).not.toBe("observed_ready");
      await waitForAgentRuntime(async () => { const observed = await f.presence.inspect("agent-plan"); return observed.status === "known" && !observed.observations.some(value => value.report.instanceId === original.report.instanceId); },
        "runtime_actual_redis_ttl_not_expired", AGENT_RUNTIME_LEASE_MS + 5_000);
    } finally { await worker.stop("kill"); }
  });

  it("graceful_stop withdraws before an actual active expired job drains and retains the original receipt", async () => {
    const value = await f.original("native_v3"); await expired(value); const before = await f.originalMetadata(value);
    const gate = await f.holdOriginal(value); await f.enqueueOriginal(value); const worker = await f.launchWorker();
    try {
      await worker.ready(); await ready(value.actor);
      await waitForAgentRuntime(async () => (await f.queue("agent-plan").getJob(value.view.id))?.getState().then(state => state === "active"), "runtime_original_job_not_active");
      worker.child.send({ type: "worker.shutdown" }, () => undefined);
      await waitForAgentRuntime(() => worker.evidence.lifecycle.some(event => event.state === "stopping"), "runtime_actual_stopping_not_seen");
      await waitForAgentRuntime(async () => (await read(value.actor)).state !== "observed_ready", "runtime_stopping_proof_not_withdrawn");
      expect(worker.evidence.processExited).toBe(false); gate.release(); await gate.settled;
      expect((await worker.stop()).code).toBe(0); expect(worker.evidence.forced).toBe(false);
      sameOriginal(before, await f.originalMetadata(value));
      expect(worker.evidence.lifecycle.at(-1)).toMatchObject({ state: "stopped", clean: true });
    } finally { gate.release(); await gate.settled; await worker.stop("kill"); }
  });

  it("multiple_instances rejects the old exact report after withdrawal without deleting another live instance", async () => {
    const { actor } = await f.readiness.actor(false), first = await f.launchWorker(), second = await f.launchWorker();
    try {
      await Promise.all([first.ready(), second.ready()]); await ready(actor);
      const initial = await waitForAgentRuntime(async () => { const value = await f.presence.inspect("agent-plan"); return value.observations.length === 2 ? value : null; }, "runtime_two_instances_not_observed");
      const beforeNames = initial.observations.map(value => value.report.workerName).sort(); expect(new Set(beforeNames).size).toBe(2);
      // Negative input boundary only: degrade real captured reports. No synthetic
      // positive report is used as evidence that an actual consumer is ready.
      const split = structuredClone(initial);
      split.observations[0]!.report.dispatcher.started = false;
      split.observations[1]!.report.consumer.running = false;
      const splitView = await new AgentRuntimeReadinessService(database, { inspect: async () => split }).get(await f.base.current(actor), "native_v3");
      expect(splitView.state).toBe("unavailable"); expect(splitView.validForMs).toBe(0);
      const wrongName = { ...initial, connectedWorkerNames: [] };
      expect((await new AgentRuntimeReadinessService(database, { inspect: async () => wrongName }).get(await f.base.current(actor), "native_v3")).checks.consumer).toBe("unavailable");
      expect((await first.stop()).code).toBe(0);
      const one = await waitForAgentRuntime(async () => { const value = await f.presence.inspect("agent-plan"); return value.observations.length === 1 ? value : null; }, "runtime_old_instance_not_withdrawn");
      const active = one.observations[0]!.report, old = initial.observations.find(value => value.report.instanceId !== active.instanceId)!;
      await expect(f.presence.publish(old.report)).rejects.toThrow();
      await ready(actor); const after = await f.presence.inspect("agent-plan");
      expect(after.observations.map(value => value.report.instanceId)).toEqual([active.instanceId]);
      expect(after.connectedWorkerNames).toContain(active.workerName);
    } finally { await first.stop("kill"); expect((await second.stop()).code).toBe(0); }
  });

  it("current_authority bounds late telemetry and preserves the exact old task receipt while no runtime exists", async () => {
    const value = await f.original("native_v3", false), actor = value.actor, originalContext = await f.base.current(actor), token = await f.token(actor);
    const initial = await f.state(actor), query = new URLSearchParams({ requestId: value.view.requestId, requestChecksum: value.view.requestChecksum });
    expect((await stableRead(actor)).state).toBe("unavailable");
    const oldResponse = await f.http(actor, "/v1/agent-native-v3/receipt?" + query);
    expect(oldResponse.status).toBe(200); expect(AgentNativeV3ReceiptSchema.parse(await oldResponse.json())).toMatchObject({ disposition: "known", runId: value.view.id });
    const noRun = allScopes(); delete noRun[Permission.WorkflowRun]; await f.base.scopes(actor, noRun);
    const inspections = f.inspections.length, readOnly = await read(actor); expect(readOnly.state).toBe("not_checked"); expect(f.inspections).toHaveLength(inspections);
    const narrow = await f.base.current(actor); await f.base.scopes(actor, allScopes());
    expect((await f.service.get(narrow, "native_v3")).state).toBe("not_checked"); expect(f.inspections).toHaveLength(inspections);
    const hold = f.holdInspect(), pending = f.http(actor, "/v1/ai/agent-runtime-readiness/native_v3");
    try {
      await bounded(hold.entered, "runtime_actual_inspect_not_reached"); await f.base.scopes(actor, noRun); hold.release();
      const refused = await bounded(pending, "runtime_late_diagnostic_not_settled"); expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ code: "authority_changed" });
    } finally { hold.clear(); await pending; await f.base.scopes(actor, allScopes()); }
    expect(await f.token(actor)).toBe(token);
    for (const suffix of ["native_v5", "native_v3?queue=agent-loop", "native_v3?tenantId=foreign"]) {
      const response = await f.http(actor, "/v1/ai/agent-runtime-readiness/" + suffix); expect(response.status).toBe(400); await response.body?.cancel();
    }
    const post = await f.http(actor, "/v1/ai/agent-runtime-readiness/native_v3", "POST"); expect(post.status).toBe(404); await post.body?.cancel();
    const noRead = allScopes(); delete noRead[Permission.WorkflowRead]; await f.base.scopes(actor, noRead);
    const denied = await f.http(actor, "/v1/ai/agent-runtime-readiness/native_v3"); expect(denied.status).toBe(403); await denied.body?.cancel();
    await f.base.scopes(actor, allScopes());
    const recovered = await f.readiness.owners.native_v3.get(originalContext, value.view.id);
    expect(recovered.id).toBe(value.view.id); expect(recovered.requestChecksum).toBe(value.view.requestChecksum);
    const after = await f.state(actor);
    for (const table of ["agent_plan_runs", "agent_plan_steps", "ai_budget_ledger", "agent_command_requests", "model_billing_reconciliations"]) expect(after.tables[table]).toEqual(initial.tables[table]);
    expect(after.dispatches).toBe(initial.dispatches); expect(after.modelCalls).toBe(0); expect(after.sourceCalls).toBe(initial.sourceCalls);
  });
});
