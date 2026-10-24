import { randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { AGENT_LOOP_VERSION, defaultAgentLoopLimits } from "@yummyai/contracts/ai/agent-loop";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import * as persistence from "@yummyai/database";
import { connectDatabase, withTenant, agentLoopRuns, agentLoopSteps, aiBudgetLedger, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bounded, deferred } from "./agent-read.test-fixture.js";
import { agentLoopFixture, requireAgentLoopEnvironment, inventoryDecision, exceptionDecision, finishLoop } from "./agent-loop.test-fixture.js";

const environment = requireAgentLoopEnvironment(), database = connectDatabase(environment.url), f = agentLoopFixture(database);
const proof = (request: { requestId: string }) => ({ requestId: request.requestId, requestChecksum: f.checksum(request) });
const scopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
function postgres(error: unknown) {
  let value = error; for (let depth = 0; depth < 8 && value && typeof value === "object"; depth++) {
    if ("code" in value && typeof value.code === "string" && /^[A-Z0-9]{5}$/.test(value.code))
      return { code: value.code, message: "message" in value ? String(value.message).slice(0, 180) : "" };
    value = "cause" in value ? value.cause : null;
  }
  throw new Error("Expected a native PostgreSQL constraint failure", { cause: error });
}
const failure = async (body: (tx: TenantTransaction) => Promise<unknown>) => {
  try { await withTenant(database.db, f.base.a.context, body); } catch (error) { return postgres(error); }
  throw new Error("Native counterexample unexpectedly committed");
};

describe.sequential("Bounded Agent loop through actual ERP read owners", () => {
  let large: Awaited<ReturnType<typeof f.base.stock>>;
  beforeAll(async () => { await f.initialize(); });
  afterEach(() => { f.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
  afterAll(async () => {
    const errors: unknown[] = []; try { f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Agent loop integration teardown failed");
  });

  it("executes real model decisions through both original owners, checks exact fields and final source versions without adopting any business changes", async () => {
    const order = await f.base.order(); await f.base.exception(order.id); const stock = await f.base.stock();
    const before = await f.physical(), calls = f.modelCalls.length, reads = f.readCalls.length;
    f.controls.decision = packet => packet.collections.length === 0 ? exceptionDecision(order.id)
      : packet.collections.length === 1 ? inventoryDecision(stock.stockItemId) : finishLoop(packet);
    const request = await f.request(f.base.a, { allowedTools: ["orders.exceptions.page", "inventory.balances.page"] });
    const run = await f.service().start(f.base.a.context, request); await f.process(run.id);
    const actual = await f.service().get(f.base.a.context, run.id);
    expect(actual).toMatchObject({ status: "completed", verification: "field_values_and_collection_versions", toolCalls: 4, observedRows: 4,
      cost: { knownCostUsd: "0.000630", reservedUsd: "0.000000", coverage: "known", modelTurns: 3 } });
    expect(actual.collections.map(row => row.tool)).toEqual(["orders.exceptions.page", "inventory.balances.page"]);
    expect(actual.steps.map(row => [row.kind, row.phase])).toEqual([["model", "completed"], ["read", "completed"], ["model", "completed"], ["read", "completed"], ["model", "completed"]]);
    expect(actual.result?.claims.find(row => row.field === "physicalQuantity")?.value).toBe("1.000000001");
    expect(actual.result?.claims.find(row => row.field === "unit")?.value).toBe("meter");
    expect(actual.result?.claims.filter(row => row.field === "total").map(row => row.value)).toEqual([1, 3]);
    expect(JSON.stringify(actual)).not.toContain("Synthetic private issue"); expect(JSON.stringify(f.modelCalls.slice(calls))).not.toContain("Synthetic private issue");
    expect(f.modelCalls.length - calls).toBe(3); expect(f.readCalls.length - reads).toBe(4);
    const persisted = await f.rows(), ledger = persisted.ledgers.find(row => row.requestId === run.id)!;
    expect(ledger).toMatchObject({ taskType: "erp_agent", amountUsd: "0.000630", state: "committed" });
    expect(await f.physical()).toEqual(before);
  });

  it("rejects a wrong quantity, unit or foreign source as a hard evidence failure and never invokes a dynamic write tool", async () => {
    const stock = await f.base.stock(f.base.a, 1), before = await f.physical();
    for (const variant of ["quantity", "unit", "source", "dynamic"] as const) {
      const calls = f.modelCalls.length, ownerCalls = f.readCalls.length;
      f.controls.decision = packet => {
        if (!packet.collections.length) return variant === "dynamic"
          ? { action: "read", label: "Forbidden command", read: { tool: "inventory.recordMovement", query: {} }, result: null } : inventoryDecision(stock.stockItemId);
        const decision = finishLoop(packet); if (!decision.result) throw new Error("Synthetic evidence fixture missing result");
        const claim = decision.result.claims.find(row => row.field === (variant === "unit" ? "unit" : "physicalQuantity"))!;
        if (variant === "quantity") claim.value = 1000;
        else if (variant === "unit") claim.value = "piece";
        else claim.sourceId = createEntityId();
        return decision;
      };
      const request = await f.request(), run = await f.service().start(f.base.a.context, request); await f.process(run.id);
      const actual = await f.service().get(f.base.a.context, run.id);
      expect(actual).toMatchObject({ status: "failed", result: null, verification: "not_adopted", errorCode: variant === "dynamic" ? "agent_model_output_invalid" : "agent_claim_invalid" });
      expect(f.modelCalls.length - calls).toBe(variant === "dynamic" ? 1 : 2);
      expect(f.readCalls.length - ownerCalls).toBe(variant === "dynamic" ? 0 : 1);
      expect(actual.cost).toMatchObject({ knownCostUsd: variant === "dynamic" ? "0.000210" : "0.000420", reservedUsd: "0.000000", coverage: "known" });
    }
    expect(await f.physical()).toEqual(before);
  });

  it("collects all 501 original records in exact order and reports a separately bounded prefix as partial rather than a complete total", async () => {
    large = await f.base.stock(f.base.a, 501); const before = await f.physical();
    f.controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(large.stockItemId);
    const fullRequest = await f.request(f.base.a, { maxCostUsd: 1, limits: { ...defaultAgentLoopLimits(), maxRows: 1000 } });
    const full = await f.service().start(f.base.a.context, fullRequest); await f.process(full.id);
    const actual = await f.service().get(f.base.a.context, full.id), collection = actual.collections[0]!;
    expect(actual).toMatchObject({ status: "completed", toolCalls: 7, observedRows: 501 });
    expect(collection).toMatchObject({ total: 501, readCount: 501, complete: true, limitReason: null });
    expect(new Set(collection.rows.map(row => row.sourceId)).size).toBe(501);
    expect(collection.rows.map(row => "dimensionKey" in row.data ? row.data.dimensionKey : "")).toEqual(collection.rows.map(row => "dimensionKey" in row.data ? row.data.dimensionKey : "").sort());
    const limited = await f.service().start(f.base.a.context, await f.request(f.base.a, { limits: { ...defaultAgentLoopLimits(), maxRows: 3 } })); await f.process(limited.id);
    const prefix = await f.service().get(f.base.a.context, limited.id);
    expect(prefix).toMatchObject({ status: "partial", toolCalls: 2, observedRows: 3 });
    expect(prefix.collections[0]).toMatchObject({ total: 501, readCount: 3, complete: false, limitReason: "row_limit" });
    expect(prefix.result?.claims.some(row => row.sourceId === "$collection")).toBe(false);
    expect(await f.physical()).toEqual(before);
  });

  it("rejects changes between actual owner pages and after collection completion before final source adoption", async () => {
    if (!large) large = await f.base.stock(f.base.a, 501);
    const change = async (source: string) => f.base.inventory.recordMovement(f.base.a.context, { stockItemId: large.stockItemId,
      locationId: large.locations[0]!, lotId: null, bucket: "physical", type: "adjustment", quantityDelta: "0.000000001", unit: "meter",
      sourceType: "manual", sourceId: source, reasonCode: "COUNT_CORRECTION", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    let changed = false;
    f.controls.afterRead = async page => { if (!changed && page.query.pageSize === 100) { changed = true; await change("synthetic-between-pages"); } };
    f.controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(large.stockItemId);
    const run = await f.service().start(f.base.a.context, await f.request(f.base.a, { maxCostUsd: 1, limits: { ...defaultAgentLoopLimits(), maxRows: 1000 } })); await f.process(run.id);
    expect(changed).toBe(true); expect(await f.service().get(f.base.a.context, run.id)).toMatchObject({ status: "failed", errorCode: "agent_collection_changed", result: null });
    f.controls.afterRead = undefined; changed = false;
    f.controls.beforeModel = async packet => { if (packet.collections.length) { changed = true; await change("synthetic-before-final-source-check"); } };
    const final = await f.service().start(f.base.a.context, await f.request(f.base.a, { limits: { ...defaultAgentLoopLimits(), maxRows: 3 } })); await f.process(final.id);
    expect(changed).toBe(true); expect(await f.service().get(f.base.a.context, final.id)).toMatchObject({ status: "failed", errorCode: "agent_collection_changed", result: null });
  });

  it("fences a real late owner response after per-bit revocation while pure-ID receipt and stop remain available to its original owner", async () => {
    const actor = await f.base.actor(f.base.a.tenantId), stock = await f.base.stock(actor, 1), entered = deferred(), release = deferred();
    const original = await f.base.current(actor), readStart = f.readCalls.length;
    f.controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(stock.stockItemId);
    f.controls.afterRead = async () => { entered.resolve(); await release.promise; };
    const request = await f.request(actor), run = await f.service().start(original, request), pending = f.process(run.id, actor);
    try {
      await bounded(entered.promise, "Actual owner late response did not reach the barrier");
      const narrowed = await f.base.scopes(actor, { ...scopes(), [Permission.InventoryRead]: "self" });
      await expect(f.service().get(original, run.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect(await f.service().receipt(narrowed, proof(request))).toMatchObject({ runId: run.id, privateAvailable: false, disposition: "known" });
      await expect(f.service().stop(narrowed, run.id, { version: AGENT_LOOP_VERSION, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      await expect(f.service().stop(f.base.second.context, run.id, { version: AGENT_LOOP_VERSION, requestId: request.requestId })).rejects.toBeInstanceOf(NotFoundException);
      expect(await f.service().stop(narrowed, run.id, { version: AGENT_LOOP_VERSION, requestId: request.requestId })).toMatchObject({ runId: run.id, privateAvailable: false, status: "stopping" });
      release.resolve(); await bounded(pending, "Stopped original late response did not settle");
      expect(f.readCalls.length - readStart).toBe(1);
      const restored = await f.base.scopes(actor, scopes()); expect(await f.service().get(restored, run.id)).toMatchObject({ status: "stopped", result: null, collections: [] });
      const self = await f.base.scopes(actor, { ...scopes(), [Permission.InventoryRead]: "self" });
      await expect(f.service().start(self, { ...request, requestId: randomUUID() })).rejects.toBeInstanceOf(ForbiddenException);
    } finally { release.resolve(); await pending; await f.base.scopes(actor, scopes()); }
  });

  it("serializes original paid admission and worker lease replay, preserves a committed intent after queue failure and never dispatches from receipt GET", async () => {
    const request = await f.request(), before = await f.rows(), dispatches = f.dispatches.length, calls = f.modelCalls.length;
    f.controls.failQueue = true;
    const [a, b] = await Promise.all([f.service().start(f.base.a.context, request), f.service().start(f.base.a.context, request)]);
    expect(a.id).toBe(b.id); expect(f.dispatches.length - dispatches).toBe(1);
    const pending = await f.rows(); expect(pending.runs.length - before.runs.length).toBe(1); expect(pending.ledgers.length - before.ledgers.length).toBe(1);
    expect(pending.audits.filter(row => row.action === "agent.loop.create" && row.entity_id === a.id)).toHaveLength(1);
    expect(await f.service().receipt(f.base.a.context, proof(request))).toMatchObject({ runId: a.id, status: "queued" });
    await f.service().get(f.base.a.context, a.id); expect(f.dispatches.length - dispatches).toBe(1); expect(f.modelCalls.length).toBe(calls);
    await expect(f.service().start(f.base.a.context, { ...request, goal: "Changed original paid body" })).rejects.toMatchObject({ response: { code: "agent_request_conflict" } });
    await expect(f.service().get(f.base.second.context, a.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.service().receipt(f.base.foreign.context, proof(request))).toMatchObject({ disposition: "not_found", runId: null, privateAvailable: false });
    f.controls.failQueue = false; f.controls.decision = packet => finishLoop(packet);
    const outcomes = await Promise.all([f.runtime().process(f.base.a.context, a.id), f.runtime().process(f.base.a.context, a.id)]);
    expect(outcomes.some(row => row.disposition === "settled")).toBe(true); expect(f.modelCalls.length - calls).toBe(1);
    const final = await f.service().get(f.base.a.context, a.id); expect(final.status).toBe("completed");
    expect((await f.service().start(f.base.a.context, request)).id).toBe(a.id); expect(f.dispatches.length - dispatches).toBe(1); expect(f.modelCalls.length - calls).toBe(1);
    const mixed: Array<{ id: string; requestId: string }> = [];
    let ordinary: { id: string } | undefined;
    try {
      const loopRequests = await Promise.all(Array.from({ length: 3 }, () => f.request())), ordinaryRequest = await f.base.knowledgeRequest();
      const [loopValues, native] = await Promise.all([
        Promise.all(loopRequests.map(body => f.service().start(f.base.a.context, body))), f.base.assists.create(f.base.a.context, ordinaryRequest),
      ]);
      expect(loopValues).toHaveLength(3);
      mixed.push(...loopValues.map(row => ({ id: row.id, requestId: row.requestId }))); ordinary = native;
      const occupied = await f.rows();
      await expect(f.service().start(f.base.a.context, await f.request())).rejects.toMatchObject({ response: { code: "agent_active_limit" } });
      await expect(f.base.assists.create(f.base.a.context, { ...ordinaryRequest, requestId: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
      expect(await f.rows()).toEqual(occupied);
    } finally {
      for (const row of mixed) { await f.service().stop(f.base.a.context, row.id, { version: AGENT_LOOP_VERSION, requestId: row.requestId }); await f.process(row.id); }
      if (ordinary) await f.base.process(ordinary.id);
    }
  });

  it("requires actual same-transaction admission, parent budget, audit and immutable source even after an early constraint flush", async () => {
    const request = await f.request(), before = await f.rows(), dispatches = f.dispatches.length;
    const audit = vi.spyOn(persistence, "recordAuditInTransaction").mockRejectedValueOnce(new Error("Synthetic original admission audit unavailable"));
    await expect(f.service().start(f.base.a.context, request)).rejects.toThrow("Synthetic original admission audit unavailable"); audit.mockRestore();
    expect(await f.rows()).toEqual(before); expect(f.dispatches.length).toBe(dispatches);
    const actual = await f.service().start(f.base.a.context, request), original = (await f.rows()).runs.find(row => row.id === actual.id)!;
    const born = await withTenant(database.db, f.base.a.context, tx => tx.execute<{ same: boolean; input: boolean }>(sql`
      select (r.creation_transaction_id::numeric%4294967296)::text=l.xmin::text and (r.creation_transaction_id::numeric%4294967296)::text=a.xmin::text as same,
        r.input_checksum=${original.inputChecksum} as input from agent_loop_runs r join ai_budget_ledger l on l.id=r.budget_ledger_id
        join audit_events a on a.entity_id=r.id and a.action='agent.loop.create' where r.id=${actual.id}::uuid`));
    expect(born).toEqual([{ same: true, input: true }]);
    const stable = await f.rows();
    expect((await failure(tx => tx.update(agentLoopRuns).set({ requestChecksum: "f".repeat(64) }).where(eq(agentLoopRuns.id, actual.id)))).code).toBe("23514");
    expect((await failure(async tx => { await tx.execute(sql`set constraints all immediate`);
      await tx.update(agentLoopRuns).set({ originCeiling: f.base.second.context }).where(eq(agentLoopRuns.id, actual.id)); })).code).toBe("23514");
    expect((await failure(async tx => {
      await tx.update(agentLoopRuns).set({ status: "completed", completedAt: new Date() }).where(eq(agentLoopRuns.id, actual.id));
      await tx.update(aiBudgetLedger).set({ state: "released" }).where(eq(aiBudgetLedger.id, original.budgetLedgerId));
      await tx.execute(sql`set constraints all immediate`);
    })).code).toBe("23514");
    const originalLedger = stable.ledgers.find(row => row.id === original.budgetLedgerId)!;
    expect((await failure(tx => tx.insert(aiBudgetLedger).values({ ...originalLedger, id: createEntityId(), requestId: createEntityId() }))).code).toBe("23514");
    for (const resourceId of [createEntityId(), actual.id]) expect((await failure(tx => persistence.recordAuditInTransaction(tx, f.base.a.context,
      { action: "agent.loop.create", resourceType: "agent_loop_run", resourceId, result: "success", metadata: {
        requestChecksum: original.requestChecksum, inputChecksum: original.inputChecksum, budgetLedgerId: original.budgetLedgerId } }))).code).toBe("23514");
    expect((await failure(tx => tx.insert(agentLoopSteps).values({ id: createEntityId(), tenantId: f.base.a.tenantId, runId: actual.id,
      sequence: 1, kind: "read", label: "Forged write-free child", tool: "inventory.balances.page", inputChecksum: "a".repeat(64), previousChecksum: original.inputChecksum,
      encryptedInput: "synthetic-not-an-authenticated-envelope" }))).code).toBe("23514");
    expect(await f.rows()).toEqual(stable);
    await f.service().stop(f.base.a.context, actual.id, { version: AGENT_LOOP_VERSION, requestId: request.requestId }); await f.process(actual.id);
  });

  it("keeps the full parent cap active, accounts for every checkpoint and preserves unknown cost without rerouting or a second model request", async () => {
    for (const mode of ["unknown_submission", "unknown_usage"] as const) {
      const entered = deferred(), release = deferred(), calls = f.modelCalls.length;
      f.controls.beforeModel = async () => { entered.resolve(); await release.promise; if (mode === "unknown_submission") throw new TypeError("Synthetic submitted HTTP response lost"); };
      f.controls.unknownUsage = mode === "unknown_usage"; f.controls.decision = packet => finishLoop(packet);
      const request = await f.request(), run = await f.service().start(f.base.a.context, request), pending = f.process(run.id);
      try {
        await bounded(entered.promise, "Actual submitted model request did not reach barrier");
        const state = await f.rows(), ledger = state.ledgers.find(row => row.requestId === run.id)!;
        expect(ledger).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
        expect(state.steps.find(row => row.runId === run.id)).toMatchObject({ submissionState: "submitted", phase: "submitted" });
        release.resolve(); await bounded(pending, "Unknown submitted model did not settle");
        const actual = await f.service().get(f.base.a.context, run.id);
        expect(actual).toMatchObject({ status: "uncertain", errorCode: mode === "unknown_submission" ? "agent_submission_unknown" : "agent_cost_unknown",
          cost: { knownCostUsd: "0.000000", reservedUsd: "0.100000", coverage: "unknown" }, result: null });
        await f.runtime().process(f.base.a.context, run.id); await f.service().receipt(f.base.a.context, proof(request));
        expect(f.modelCalls.length - calls).toBe(1); expect((await f.rows()).ledgers.find(row => row.requestId === run.id)).toEqual(ledger);
      } finally { release.resolve(); await pending; f.clear(); }
    }
  });

  it("reuses a real response-ready checkpoint after lease handoff and never pays again when the first worker returns late", async () => {
    const saved = deferred(), release = deferred(), calls = f.modelCalls.length;
    f.controls.decision = packet => finishLoop(packet); f.controls.afterCheckpoint = async () => { saved.resolve(); await release.promise; };
    const request = await f.request(), run = await f.service().start(f.base.a.context, request), first = f.process(run.id);
    try {
      await bounded(saved.promise, "Original provider checkpoint was not saved before the worker gate");
      const checkpoint = (await f.rows()).steps.find(row => row.runId === run.id)!;
      expect(checkpoint).toMatchObject({ phase: "response_ready", submissionState: "received", inputTokens: 50, outputTokens: 80, costUsd: "0.000210" });
      expect((await f.rows()).ledgers.find(row => row.requestId === run.id)).toMatchObject({ state: "reserved", amountUsd: "0.100000" });
      expect(checkpoint.encryptedResponse?.startsWith("synthetic")).toBe(false);
      await withTenant(database.db, f.base.a.context, tx => tx.update(agentLoopRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentLoopRuns.id, run.id)));
      f.controls.afterCheckpoint = undefined; await f.runtime().process(f.base.a.context, run.id);
      const complete = await f.service().get(f.base.a.context, run.id); expect(complete).toMatchObject({ status: "completed", cost: { knownCostUsd: "0.000210", modelTurns: 1 } });
      release.resolve(); await bounded(first, "Original lost-lease worker did not return");
      expect(f.modelCalls.length - calls).toBe(1); expect((await f.rows()).steps.find(row => row.id === checkpoint.id)?.responseChecksum).toBe(checkpoint.responseChecksum);
    } finally { release.resolve(); await first; }
  });

  it("stops before the first paid submission, retains immutable read-only receipts across expiration and never turns not-found into a replacement task", async () => {
    const calls = f.modelCalls.length, request = await f.request(), stopped = await f.service().start(f.base.a.context, request);
    const stop = { version: AGENT_LOOP_VERSION, requestId: request.requestId };
    await f.service().stop(f.base.a.context, stopped.id, stop); await f.process(stopped.id);
    const settled = await f.service().get(f.base.a.context, stopped.id); expect(settled).toMatchObject({ status: "stopped", steps: [], cost: { knownCostUsd: "0.000000", reservedUsd: "0.000000" } });
    expect(Math.abs(Date.parse(settled.expiresAt) - Date.parse(settled.createdAt) - 86_400_000)).toBeLessThan(2_000);
    expect((await f.rows()).ledgers.find(row => row.requestId === stopped.id)).toMatchObject({ state: "released", amountUsd: "0.100000" });
    const before = await f.rows(), dispatches = f.dispatches.length;
    expect(await f.service().stop(f.base.a.context, stopped.id, stop)).toMatchObject({ runId: stopped.id, status: "stopped" });
    const unknown = { requestId: randomUUID(), requestChecksum: "f".repeat(64) };
    expect(await f.service().receipt(f.base.a.context, unknown)).toMatchObject({ disposition: "not_found", runId: null });
    expect(await f.rows()).toEqual(before); expect(f.dispatches.length).toBe(dispatches); expect(f.modelCalls.length).toBe(calls);
    expect(settled.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(await f.base.current(f.base.a))));
    const stock = await f.base.stock(f.base.a, 1);
    f.controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(stock.stockItemId);
    const shortRequest = await f.request(f.base.a, { limits: { ...defaultAgentLoopLimits(), deadlineSeconds: 30 } });
    const original = await f.service(35).start(f.base.a.context, shortRequest); await f.process(original.id);
    const complete = await f.service().get(f.base.a.context, original.id); expect(complete.status).toBe("completed"); expect(complete.steps).toHaveLength(3);
    expect(Math.abs(Date.parse(complete.expiresAt) - Date.parse(complete.createdAt) - 35_000)).toBeLessThan(2_000);
    const preserved = await f.rows(), parent = preserved.runs.find(row => row.id === original.id)!, trace = preserved.steps.filter(row => row.runId === original.id).sort((a, b) => a.sequence - b.sequence);
    expect(parent.encryptedInput !== null && parent.encryptedResult !== null).toBe(true);
    expect(trace.every(row => row.encryptedInput !== null && row.encryptedOutput !== null)).toBe(true);
    const priorCalls = f.modelCalls.length, priorDispatches = f.dispatches.length;
    const expiration = async () => {
      const end = Date.now() + 40_000;
      for (;;) {
        const [clock] = await withTenant(database.db, f.base.a.context, tx => tx.execute<{ expired: boolean }>(sql`
          select clock_timestamp()>=expires_at as expired from agent_loop_runs where id=${original.id}::uuid`));
        if (clock?.expired) return;
        if (Date.now() >= end) throw new Error("Original DB expiry did not arrive within its fixed35 second retention");
        await new Promise<void>(accept => setTimeout(accept, 250));
      }
    };
    await expiration();
    await f.runtime().process(f.base.a.context, original.id, "expire");
    const cleaned = await f.rows(), cleared = cleaned.runs.find(row => row.id === original.id)!;
    expect(cleared).toMatchObject({ encryptedInput: null, encryptedResult: null, requestChecksum: parent.requestChecksum, inputChecksum: parent.inputChecksum,
      creationTransactionId: parent.creationTransactionId, status: parent.status });
    const stripPrivate = (row: (typeof trace)[number]) => { const { encryptedInput: _input, encryptedOutput: _output, encryptedResponse: _response, ...metadata } = row;
      void _input; void _output; void _response; return metadata; };
    const cleanedTrace = cleaned.steps.filter(row => row.runId === original.id).sort((a, b) => a.sequence - b.sequence);
    expect(cleanedTrace.map(stripPrivate)).toEqual(trace.map(stripPrivate));
    expect(cleanedTrace.every(row => row.encryptedInput === null && row.encryptedOutput === null && row.encryptedResponse === null)).toBe(true);
    const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(cleaned.ledgers)).toEqual(byId(preserved.ledgers)); expect(byId(cleaned.audits)).toEqual(byId(preserved.audits));
    const expired = await f.service().get(f.base.a.context, original.id);
    expect(expired).toMatchObject({ id: original.id, goal: null, result: null, collections: [], privateAvailable: false, status: "completed" });
    expect(expired.steps.map(row => row.outputChecksum)).toEqual(complete.steps.map(row => row.outputChecksum));
    expect(await f.service().receipt(f.base.a.context, proof(shortRequest))).toMatchObject({ runId: original.id, privateAvailable: false });
    expect(await f.rows()).toEqual(cleaned); expect(f.modelCalls.length).toBe(priorCalls); expect(f.dispatches.length).toBe(priorDispatches);
  });

  it("echoes current personal transport authority without widening the original per-bit ceiling and permits Workflow self owners to stop after domain read loss", async () => {
    const originalGrants = { [Permission.WorkflowRead]: "self" as const, [Permission.WorkflowRun]: "self" as const, [Permission.InventoryRead]: "tenant" as const };
    const actor = await f.base.actor(f.base.a.tenantId, originalGrants), peer = await f.base.actor(f.base.a.tenantId, originalGrants);
    const originalContext = await f.base.current(actor), request = await f.request(actor), calls = f.modelCalls.length, dispatches = f.dispatches.length;
    const original = await f.service().start(originalContext, request);
    expect(original).toMatchObject({ status: "queued", privateAvailable: true, contextAuthority: erpSessionAuthority(erpPermissionContext(originalContext)) });
    const born = (await f.rows(originalContext)).runs.find(row => row.id === original.id)!;
    expect(born.originCeiling.permissionScopes).toMatchObject({ [Permission.WorkflowRead]: "self", [Permission.WorkflowRun]: "self", [Permission.InventoryRead]: "tenant" });
    expect(born.originCeiling.permissions.includes(Permission.FinanceRead)).toBe(false);
    const expandedContext = await f.base.scopes(actor, { ...originalGrants, [Permission.FinanceRead]: "tenant" });
    const expandedStamp = erpSessionAuthority(erpPermissionContext(expandedContext)); expect(expandedStamp).not.toBe(original.contextAuthority);
    expect(await f.service().get(expandedContext, original.id)).toMatchObject({ id: original.id, privateAvailable: true, contextAuthority: expandedStamp });
    expect(await f.service().receipt(expandedContext, proof(request))).toMatchObject({ runId: original.id, privateAvailable: true, contextAuthority: expandedStamp });
    const peerContext = await f.base.current(peer);
    await expect(f.service().get(peerContext, original.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.service().receipt(peerContext, proof(request))).toMatchObject({ disposition: "not_found", runId: null, privateAvailable: false });
    await expect(f.service().stop(peerContext, original.id, { version: AGENT_LOOP_VERSION, requestId: request.requestId })).rejects.toBeInstanceOf(NotFoundException);
    const narrowed = await f.base.scopes(actor, { ...originalGrants, [Permission.InventoryRead]: "self", [Permission.FinanceRead]: "tenant" });
    const currentStamp = erpSessionAuthority(erpPermissionContext(narrowed)), prior = await f.rows(originalContext);
    await expect(f.service().get(narrowed, original.id)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service().start(narrowed, { ...request, requestId: randomUUID() })).rejects.toBeInstanceOf(ForbiddenException);
    expect(await f.service().receipt(narrowed, proof(request))).toMatchObject({ disposition: "known", runId: original.id, privateAvailable: false, contextAuthority: currentStamp });
    expect(await f.rows(originalContext)).toEqual(prior);
    expect(await f.service().stop(narrowed, original.id, { version: AGENT_LOOP_VERSION, requestId: request.requestId }))
      .toMatchObject({ runId: original.id, privateAvailable: false, status: "stopping", contextAuthority: currentStamp });
    await f.process(original.id, actor);
    expect(await f.service().receipt(narrowed, proof(request))).toMatchObject({ runId: original.id, status: "stopped", privateAvailable: false, contextAuthority: currentStamp });
    const after = (await f.rows(originalContext)).runs.find(row => row.id === original.id)!; expect(after.originCeiling).toEqual(born.originCeiling);
    expect(f.modelCalls.length).toBe(calls); expect(f.dispatches.length - dispatches).toBe(1);
  });

  it("completes actual paid model and inventory steps with Workflow self while retaining the original domain ceiling and rejecting a peer", async () => {
    const actor = await f.base.actor(f.base.a.tenantId), stock = await f.base.stock(actor, 1);
    const grants = { [Permission.WorkflowRead]: "self" as const, [Permission.WorkflowRun]: "self" as const, [Permission.InventoryRead]: "tenant" as const };
    const context = await f.base.scopes(actor, grants), peer = await f.base.actor(f.base.a.tenantId, grants), before = await f.physical();
    const calls = f.modelCalls.length, reads = f.readCalls.length, dispatches = f.dispatches.length;
    f.controls.decision = packet => packet.collections.length ? finishLoop(packet) : inventoryDecision(stock.stockItemId);
    const request = await f.request(actor), original = await f.service().start(context, request);
    const born = (await f.rows(context)).runs.find(row => row.id === original.id)!;
    expect(born.originCeiling.permissionScopes).toEqual(grants);
    const current = await f.base.scopes(actor, { ...grants, [Permission.FinanceRead]: "tenant" });
    await f.runtime().process(current, original.id);
    const actual = await f.service().get(current, original.id);
    expect(actual).toMatchObject({ status: "completed", privateAvailable: true, observedRows: 1, toolCalls: 2,
      verification: "field_values_and_collection_versions", contextAuthority: erpSessionAuthority(erpPermissionContext(current)),
      cost: { modelTurns: 2, knownCostUsd: "0.000420", reservedUsd: "0.000000", coverage: "known" } });
    expect(actual.steps.map(row => [row.kind, row.phase, row.submissionState])).toEqual([
      ["model", "completed", "received"], ["read", "completed", "not_submitted"], ["model", "completed", "received"],
    ]);
    expect(actual.collections).toHaveLength(1);
    expect(actual.collections[0]).toMatchObject({ tool: "inventory.balances.page", query: { stockItemId: stock.stockItemId, locationId: null }, total: 1, readCount: 1, complete: true });
    expect(actual.result?.claims.find(row => row.field === "physicalQuantity")?.value).toBe("1.000000001");
    expect(actual.result?.claims.find(row => row.field === "unit")?.value).toBe("meter");
    const ownerReads = f.readCalls.slice(reads); expect(ownerReads).toHaveLength(2);
    for (const read of ownerReads) {
      expect(read.input).toMatchObject({ tool: "inventory.balances.page", input: { stockItemId: stock.stockItemId, cursor: null } });
      expect(read.context.permissionScopes).toMatchObject(grants);
      expect(read.context.permissions.includes(Permission.FinanceRead)).toBe(false);
    }
    const final = await f.rows(context); expect(final.runs.find(row => row.id === original.id)?.originCeiling).toEqual(born.originCeiling);
    expect(final.ledgers.filter(row => row.requestId === original.id)).toMatchObject([{ state: "committed", taskType: "erp_agent", amountUsd: "0.000420" }]);
    await expect(f.service().get(peer.context, original.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.service().receipt(peer.context, proof(request))).toMatchObject({ disposition: "not_found", runId: null, privateAvailable: false });
    expect(f.modelCalls.length - calls).toBe(2); expect(f.dispatches.length - dispatches).toBe(1); expect(await f.physical()).toEqual(before);
  });
});
