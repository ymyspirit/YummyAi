import { createHash } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz";
import { TenantContextSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { requireAgentNativeV4Environment } from "../../../../tools/testing/require-agent-native-v4-environment.mjs";

// The config and this gate run before importing decorated application owners or
// connecting. Importing this suite in an ordinary environment cannot bootstrap it.
const environment = requireAgentNativeV4Environment();
const { connectDatabase, withTenant, agentPlanRuns, agentPlanItems, orderFulfillmentCommandIntents } = await import("@yummyai/database");
const persistence = await import("@yummyai/database");
const { eq, and, sql } = await import("drizzle-orm");
const { agentNativeV4Fixture } = await import("./agent-native-v4.test-fixture.js");
const { nativeV3Scopes } = await import("./agent-native-v3.test-fixture.js");
const { AGENT_NATIVE_V4_VERSION: version, AgentNativeV4ViewSchema, AgentNativeV4ReceiptSchema, AgentNativeV4ItemReceiptSchema } = await import("@yummyai/contracts/ai/agent-native-v4");
const { AGENT_FULFILLMENT_COMMAND_VERSION: originalVersion } = await import("@yummyai/contracts/ai/agent-fulfillment-command");
const { FulfillmentCommandKindSchema, FulfillmentCommandReceiptSchema } = await import("@yummyai/contracts/order/fulfillment-command");
const database = connectDatabase(environment.url), f = agentNativeV4Fixture(database);
type Scenario = Awaited<ReturnType<typeof f.scenario>>;
const current = () => f.current();
async function read(id: string, context?: TenantContext) { return AgentNativeV4ViewSchema.parse(await f.service().get(context ?? await current(), id)); }
async function planned(kind: Parameters<typeof f.scenario>[0], options: { short?: boolean; context?: TenantContext } = {}) {
  const scenario = await f.scenario(kind), input = await f.request(scenario);
  if (options.short) input.limits.deadlineSeconds = 30;
  const context = options.context ?? await current(), created = await f.service(options.short ? 31 : undefined).start(context, input);
  await f.process(created.id); const view = await read(created.id), item = view.items[0];
  expect(view.status, JSON.stringify({ status: view.status, errorCode: view.errorCode,
    steps: view.steps.map(step => ({ kind: step.kind, phase: step.phase, code: step.errorCode, submission: step.submissionState })) })).toBe("completed");
  if (!item || !view.result?.proposals[0]) throw new Error("actual_native4_original_proposal_missing");
  return { scenario, input, view, item, prepare: f.prepareInput(view, item, scenario) };
}
async function child(id: string, scenario: Scenario) { return f.fulfillmentCommands.get(await current(), id, { version: originalVersion, orderId: scenario.scene.order.id }); }
async function originalCount(requestId: string) {
  return withTenant(database.db, await current(), async tx => (await tx.select({ id: orderFulfillmentCommandIntents.id }).from(orderFulfillmentCommandIntents)
    .where(eq(orderFulfillmentCommandIntents.requestId, requestId))).length);
}
// Preserve every original field, including Date milliseconds, while failure
// diffs expose only a digest instead of private bodies, tokens or ciphertext.
function safeSnapshotHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("actual_native4_snapshot_missing");
  return createHash("sha256").update(serialized).digest("hex");
}
function pgCode(error: unknown): string | null {
  for (let depth = 0; depth < 8 && error && typeof error === "object"; depth++) {
    if ("code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) return error.code;
    error = "cause" in error ? error.cause : null;
  } return null;
}
function hasDatabaseReason(error: unknown, reason: string): boolean {
  for (let depth = 0; depth < 8 && error && typeof error === "object"; depth++) {
    if ("message" in error && error.message === reason) return true;
    error = "cause" in error ? error.cause : null;
  } return false;
}

describe.sequential("native v4 real Responses original fulfillment preparation", () => {
  beforeAll(async () => { await f.initialize(); }, 240_000);
  afterEach(async () => { vi.restoreAllMocks(); await f.settle(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "native4_disposable_teardown_failed");
  });

  it.each(FulfillmentCommandKindSchema.options)("original14_%s_real_Responses_suggestion_then_complete_prepare_and_separate_confirm", async kind => {
    const context = await current(), scenario = await f.scenario(kind), before = await f.business(), input = await f.request(scenario), confirms = f.calls.confirm;
    const calls = f.modelCalls.length, run = await f.service().start(context, input); await f.process(run.id);
    const view = await read(run.id), item = view.items[0], proposal = view.result?.proposals[0];
    expect(view.status, JSON.stringify({ status: view.status, code: view.errorCode })).toBe("completed");
    if (!item || !proposal) throw new Error("actual_native4_original_proposal_missing");
    expect(f.modelCalls.length - calls).toBe(4); expect(f.wire.slice(calls).every(row => row.method === "POST" && row.path === "/v1/responses")).toBe(true);
    expect(f.providerFailures).toEqual([]); expect(view.cost).toMatchObject({ coverage: "known", knownCostUsd: "0.000840", reservedUsd: "0.000000" });
    expect(view.result!.claims).toHaveLength(1); expect(proposal.originalChecksum).toBeNull(); expect(proposal.preparationRequestChecksum).toBeNull();
    expect(proposal.draft.original).toBeNull(); expect(proposal.draft.fulfillment?.original.input).toEqual({});
    expect(proposal.operatorChecks.every(check => check.state === "pending")).toBe(true);
    expect(item.completionState).toBe("operator_required"); expect(item.preparationState).toBe("not_requested");
    expect(item.canPrepare).toBe(true); // All14 original forms now have a separate operator-completion entry.
    expect(await f.business()).toEqual(before); expect(await originalCount(item.id)).toBe(0);
    const receipt = AgentNativeV4ItemReceiptSchema.parse(await f.service().prepareItem(context, view.id, item.id, f.prepareInput(view, item, scenario)));
    expect(receipt.disposition).toBe("known"); expect(receipt.agentCommandId).toBeNull();
    expect(receipt.ownerCommandId).toBeNull(); expect(receipt.originalProtocol).toBe(originalVersion);
    if (!receipt.fulfillmentIntentId) throw new Error("actual_native4_fulfillment_intent_missing");
    expect(new Set([view.id, item.id, receipt.fulfillmentIntentId]).size).toBe(3); expect(await originalCount(item.id)).toBe(1);
    expect(receipt.preparationRequestChecksum).not.toBe(item.proposalChecksum); expect(receipt.completionChecksum).not.toBe(item.proposalChecksum);
    const prepared = await child(receipt.fulfillmentIntentId, scenario);
    expect(prepared.native.status).toBe("prepared"); expect(prepared.native.requestId).toBe(item.id);
    expect(prepared.native.kind).toBe(kind); expect(prepared.native.receipt === null).toBe(true);
    expect(safeSnapshotHash(prepared.original)).toBe(safeSnapshotHash(f.complete(scenario, item.id).original)); expect(prepared.canConfirm).toBe(true);
    expect(await f.business()).toEqual(before); expect(f.calls.confirm).toBe(confirms);
    const confirmed = await f.fulfillmentCommands.confirm(context, prepared.native.id, f.confirmation(prepared));
    expect(confirmed.native.status).toBe("succeeded"); expect(FulfillmentCommandReceiptSchema.parse(confirmed.native.receipt).kind).toBe(kind);
    expect(await f.business()).not.toEqual(before);
  });

  it("lost201_parent_and_item_restore_the_three_original_identities_by_GET_without_paid_or_owner_replay", async () => {
    const context = await current(), scenario = await f.scenario("shipment_review"), input = await f.request(scenario), offset = f.httpCalls.length;
    f.loseStartResponse(); await expect(f.http(f.base.a, "/runs", input)).rejects.toThrow();
    const parentResponse = await f.http(f.base.a, `/receipt?${new URLSearchParams(f.proof(input))}`);
    expect(parentResponse.status).toBe(200); const parent = AgentNativeV4ReceiptSchema.parse(await parentResponse.json());
    if (!parent.runId) throw new Error("actual_lost_parent_receipt_missing");
    await f.process(parent.runId); const view = await read(parent.runId), item = view.items[0];
    if (!item) throw new Error("actual_lost_item_missing");
    const before = await f.business(), paid = f.modelCalls.length, writes = f.calls.prepare;
    f.losePrepareResponse(); await expect(f.http(f.base.a, `/runs/${view.id}/items/${item.id}/prepare`, f.prepareInput(view, item, scenario))).rejects.toThrow();
    const recovery = f.httpCalls.length;
    const response = await f.http(f.base.a, `/runs/${view.id}/items/${item.id}/receipt?${new URLSearchParams(f.itemQuery(view, item))}`);
    expect(response.status).toBe(200); const receipt = AgentNativeV4ItemReceiptSchema.parse(await response.json());
    expect(receipt.disposition).toBe("known"); expect(receipt.runId).toBe(view.id); expect(receipt.itemId).toBe(item.id);
    expect(receipt.fulfillmentIntentId).not.toBe(view.id); expect(receipt.fulfillmentIntentId).not.toBe(item.id);
    expect(await f.service().itemReceipt(context, view.id, item.id, f.itemQuery(view, item))).toEqual(receipt);
    expect(f.httpCalls.slice(recovery).every(row => row.method === "GET" && row.bodyChecksum === null)).toBe(true);
    expect(f.httpCalls.slice(offset).filter(row => row.method === "POST")).toHaveLength(2);
    expect(f.calls.prepare - writes).toBe(1); expect(await originalCount(item.id)).toBe(1); expect(f.modelCalls.length).toBe(paid); expect(await f.business()).toEqual(before);
  });

  it("unknown_before_original_owner_only_reads_the_fixed_item_and_never_implicitly_prepares_a_second_time", async () => {
    const value = await planned("delivery_feedback"), context = await current(), before = await f.business();
    f.hooks.beforePrepare = async () => { throw new Error("synthetic_before_original_owner_dispatch_lost"); };
    await expect(f.service().prepareItem(context, value.view.id, value.item.id, value.prepare)).rejects.toThrow("synthetic_before_original_owner_dispatch_lost");
    f.hooks.beforePrepare = undefined; const calls = f.calls.prepare, paid = f.modelCalls.length;
    for (let count = 0; count < 2; count++) {
      const receipt = await f.service().itemReceipt(context, value.view.id, value.item.id, f.itemQuery(value.view, value.item));
      expect(receipt.disposition).toBe("unknown"); expect(receipt.fulfillmentIntentId).toBeNull();
    }
    const item = (await read(value.view.id)).items[0];
    expect(item?.preparationState).toBe("requested_unknown"); expect(item?.completionState).toBe("bound"); expect(item?.canPrepare).toBe(false);
    expect(await originalCount(value.item.id)).toBe(0); expect(f.calls.prepare).toBe(calls); expect(f.modelCalls.length).toBe(paid); expect(await f.business()).toEqual(before);
  });

  it("same_item_concurrency_is_once_bound_and_foreign_actor_body_order_version_and_token_cannot_replace_it", async () => {
    const value = await planned("shipment_review"), context = await current(), before = await f.business(), writes = f.calls.prepare;
    const originalCompletion = value.prepare.completion;
    if (!originalCompletion) throw new Error("actual_operator_completion_missing");
    const responses = await Promise.all([f.service().prepareItem(context, value.view.id, value.item.id, value.prepare), f.service().prepareItem(context, value.view.id, value.item.id, value.prepare)]);
    // The losing caller may observe the committed staging transaction before
    // the winner's original owner returns. It must remain unknown, never issue
    // a second preparation; a subsequent original GET resolves the exact link.
    expect(responses.every(row => ["known", "unknown"].includes(row.disposition))).toBe(true);
    expect(responses.filter(row => row.disposition === "known").length).toBeGreaterThan(0);
    expect(new Set(responses.flatMap(row => row.fulfillmentIntentId ? [row.fulfillmentIntentId] : [])).size).toBe(1);
    expect(f.calls.prepare - writes).toBe(1); expect(await originalCount(value.item.id)).toBe(1);
    for (const completion of [{ ...originalCompletion, orderId: createEntityId() },
      { ...originalCompletion, original: { ...originalCompletion.original, versionId: createEntityId() } },
      { ...originalCompletion, original: { ...originalCompletion.original, input: { ...originalCompletion.original.input, reason: "Different original completed body" } } }])
      await expect(f.service().prepareItem(context, value.view.id, value.item.id, { ...value.prepare, completion })).rejects.toThrow();
    for (const { actor, expectedTenantCount } of [{ actor: f.base.second, expectedTenantCount: 1 }, { actor: f.base.foreign, expectedTenantCount: 0 }]) {
      expect(actor.context.tenantId === context.tenantId).toBe(expectedTenantCount === 1);
      expect(actor.context.userId === context.userId).toBe(false);
      await expect(f.service().get(await f.current(actor), value.view.id)).rejects.toMatchObject({ status: 404 });
      await expect(f.service().itemReceipt(await f.current(actor), value.view.id, value.item.id, f.itemQuery(value.view, value.item))).rejects.toMatchObject({ status: 404 });
      expect(await withTenant(database.db, await f.current(actor), tx => tx.select({ id: agentPlanItems.id }).from(agentPlanItems).where(eq(agentPlanItems.id, value.item.id))))
        .toHaveLength(expectedTenantCount); // Tenant RLS and original actor authorization are independent; fixture getters return new actor objects.
    }
    const final = await f.service().itemReceipt(context, value.view.id, value.item.id, f.itemQuery(value.view, value.item));
    expect(final.disposition).toBe("known");
    const id = final.fulfillmentIntentId; if (!id) throw new Error("actual_concurrent_child_missing");
    const prepared = await child(id, value.scenario), proof = f.confirmation(prepared);
    await expect(f.fulfillmentCommands.confirm(context, id, { ...proof, confirmationToken: "synthetic-invalid-token" })).rejects.toThrow();
    expect(await f.business()).toEqual(before);
  });

  it("same_transaction_complete_and_prepare_audit_failure_rolls_back_all_binding_fields_before_original_owner", async () => {
    const value = await planned("delivery_feedback"), context = await current(), before = await f.business(), writes = f.calls.prepare;
    const actual = persistence.recordAuditInTransaction;
    const spy = vi.spyOn(persistence, "recordAuditInTransaction").mockImplementation(async (...args: Parameters<typeof persistence.recordAuditInTransaction>) => {
      if (args[2].action === "agent.plan.item.prepare") throw new Error("synthetic_native4_prepare_audit_rollback"); return actual(...args);
    });
    try { await expect(f.service().prepareItem(context, value.view.id, value.item.id, value.prepare)).rejects.toThrow("synthetic_native4_prepare_audit_rollback"); }
    finally { spy.mockRestore(); }
    const row = (await f.rows(context)).items.find(item => item.id === value.item.id);
    if (!row) throw new Error("actual_rolled_back_item_missing");
    expect(row.encryptedCompletion === null).toBe(true); expect(row.completionChecksum).toBeNull(); expect(row.completionBoundAt).toBeNull();
    expect(row.preparationRequestedAt).toBeNull(); expect(row.originalChecksum).toBeNull(); expect(row.preparationRequestChecksum).toBeNull(); expect(row.fulfillmentIntentId).toBeNull();
    expect((await f.rows(context)).audits.filter(event => event.entity_id === value.item.id && ["agent.plan.item.complete", "agent.plan.item.prepare"].includes(event.action))).toHaveLength(0);
    expect(f.calls.prepare).toBe(writes); expect(await originalCount(value.item.id)).toBe(0); expect(await f.business()).toEqual(before);
  });

  it("actual_original_production_progress_invalidates_the_saved_source_before_any_new_preparation", async () => {
    const value = await planned("production_milestone"), context = await current(), command = value.scenario.command;
    if (command.kind !== "production_milestone") throw new Error("actual_original_milestone_required");
    await f.original.owners.production.recordMilestone(context, command.targetId, command.input);
    const before = await f.business(), paid = f.modelCalls.length, writes = f.calls.prepare;
    await expect(f.service().prepareItem(context, value.view.id, value.item.id, value.prepare)).rejects.toThrow();
    expect(await originalCount(value.item.id)).toBe(0); expect(f.calls.prepare).toBe(writes);
    expect(f.modelCalls.length).toBe(paid); expect(await f.business()).toEqual(before);
  });

  it("current_Workflow_and_PII_withdrawal_blocks_new_preparation_and_never_promotes_birth_self_scope", async () => {
    const initial = await current(), narrowed = TenantContextSchema.parse({ ...initial, permissionScopes: { ...initial.permissionScopes, [Permission.WorkflowRun]: "self" } });
    const value = await planned("delivery_feedback", { context: narrowed }), before = await f.business();
    const scopes = nativeV3Scopes(); delete scopes[Permission.WorkflowRun]; await f.base.scopes(f.base.a, scopes);
    await expect(f.service().prepareItem(await current(), value.view.id, value.item.id, value.prepare)).rejects.toThrow();
    expect(await originalCount(value.item.id)).toBe(0); await f.base.scopes(f.base.a, nativeV3Scopes());
    const receipt = await f.service().prepareItem(await current(), value.view.id, value.item.id, value.prepare);
    if (!receipt.fulfillmentIntentId) throw new Error("actual_birth_scope_child_missing");
    const birth = await f.original.intent(receipt.fulfillmentIntentId, await current());
    expect(birth?.authoritySnapshot.permissionScopes?.[Permission.WorkflowRun]).toBe("self");
    const noPii = nativeV3Scopes(); delete noPii[Permission.OrderPiiRead]; await f.base.scopes(f.base.a, noPii);
    const cleared = await read(value.view.id);
    expect(cleared.privateAvailable).toBe(false); expect(cleared.goal === null).toBe(true); expect(cleared.contextText === null).toBe(true);
    expect(cleared.bindings.length).toBe(0); expect(cleared.allowedCommands.length).toBe(0); expect(cleared.definitions.length).toBe(0);
    expect(cleared.observations.length).toBe(0); expect(cleared.result === null).toBe(true);
    expect(await f.business()).toEqual(before);
  });

  it.each(["stop", "ttl"] as const)("parent_%s_between_coordination_commit_and_original_birth_creates_no_child_and_no_business", async change => {
    const value = await planned("delivery_feedback", { short: change === "ttl" }), context = await current(), before = await f.business();
    const hold = f.hold("beforePrepare"), pending = f.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    const observed = pending.then(result => ({ result, error: null }), error => ({ result: null, error }));
    try {
      await f.bounded(hold.entered, "actual_original_prepare_birth_gate_not_reached");
      if (change === "stop") await f.service().stop(context, value.view.id, { version, requestId: value.view.requestId }); else await f.waitParentExpired(value.view.id);
      hold.release(); expect((await observed).error).not.toBeNull();
      expect(await originalCount(value.item.id)).toBe(0); expect(await f.business()).toEqual(before);
    } finally { hold.release(); await observed; }
  });

  it.each(["stop", "ttl"] as const)("parent_%s_after_original_birth_invalidates_the_original_confirm_source_without_reexecution", async change => {
    const value = await planned("delivery_feedback", { short: change === "ttl" }), context = await current(), before = await f.business();
    const receipt = await f.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    if (!receipt.fulfillmentIntentId) throw new Error("actual_late_stop_child_missing");
    const prepared = await child(receipt.fulfillmentIntentId, value.scenario), proof = f.confirmation(prepared);
    if (change === "stop") await f.service().stop(context, value.view.id, { version, requestId: value.view.requestId }); else await f.waitParentExpired(value.view.id);
    await expect(f.fulfillmentCommands.confirm(context, prepared.native.id, proof)).rejects.toThrow();
    const cleared = await child(prepared.native.id, value.scenario);
    expect(cleared.privateAvailable).toBe(false); expect(cleared.original === null).toBe(true); expect(cleared.confirmationToken === null).toBe(true);
    expect(cleared.native.summary === null).toBe(true); expect(cleared.native.receipt === null).toBe(true);
    expect(await originalCount(value.item.id)).toBe(1); expect(await f.business()).toEqual(before);
  });

  it("real_Responses_received_checkpoint_is_reused_after_synthetic_lease_handoff_without_another_HTTP_purchase", async () => {
    const context = await current(), input = await f.request(), hold = f.hold("afterCheckpoint"), run = await f.service().start(context, input), calls = f.modelCalls.length;
    const first = f.process(run.id);
    try {
      await f.bounded(hold.entered, "actual_responses_checkpoint_not_saved");
      const checkpoint = (await f.rows(context)).steps.find(step => step.runId === run.id);
      expect(checkpoint?.phase).toBe("response_ready"); expect(checkpoint?.submissionState).toBe("received"); expect(checkpoint?.costUsd).toBe("0.000210");
      if (!checkpoint?.responseChecksum) throw new Error("actual_responses_checkpoint_hash_missing");
      // Only a synthetic runtime ownership-loss setup. This does not claim that
      // a real child process was killed or that the five-minute lease elapsed.
      await withTenant(database.db, context, tx => tx.update(agentPlanRuns).set({ leaseExpiresAt: sql`clock_timestamp()-interval '1 second'` }).where(eq(agentPlanRuns.id, run.id)));
      f.hooks.afterCheckpoint = undefined; await f.process(run.id); hold.release(); await first;
      const currentStep = (await f.rows(context)).steps.find(step => step.id === checkpoint.id);
      expect(currentStep?.responseChecksum).toBe(checkpoint.responseChecksum); expect(currentStep?.submissionState).toBe("received");
      const completed = await read(run.id);
      expect(f.modelCalls.length - calls).toBe(1); expect(completed.status).toBe("completed"); expect(completed.cost.coverage).toBe("known"); expect(completed.cost.knownCostUsd).toBe("0.000210");
    } finally { hold.release(); await first; }
  });

  it.each(["submitted_unknown", "missing_usage"] as const)("real_Responses_%s_retains_unknown_cost_and_original_cap_without_retrying_HTTP", async fault => {
    const context = await current(), input = await f.request(), before = await f.business(), run = await f.service().start(context, input), calls = f.modelCalls.length;
    f.controls.fault = fault; await f.process(run.id);
    const uncertain = await read(run.id);
    expect(uncertain.status).toBe("uncertain"); expect(uncertain.result === null).toBe(true); expect(uncertain.items.length).toBe(0);
    expect(uncertain.cost.coverage).toBe("unknown"); expect(uncertain.cost.reservedUsd).toBe("1.000000");
    const rows = await f.rows(context); await f.process(run.id); await f.service().receipt(context, f.proof(input));
    expect(f.modelCalls.length - calls).toBe(1); expect(safeSnapshotHash(await f.rows(context))).toBe(safeSnapshotHash(rows)); expect(await f.business()).toEqual(before);
  });

  it("SQL_rejects_null_fulfillment_kind_and_once_bound_completion_replacement_while_foreign_RLS_sees_no_item", async () => {
    const context = await current(), queued = await f.service().start(context, await f.request()), row = (await f.rows(context)).runs.find(run => run.id === queued.id);
    if (!row) throw new Error("actual_sql_birth_control_missing");
    await withTenant(database.db, context, tx => tx.execute(sql`select agent_plan_check_selection(r) from agent_plan_runs r where r.id=${row.id}::uuid`));
    let code: string | null = null, rejectedNullKind = false;
    try { await withTenant(database.db, context, async tx => {
      // start() has already recorded dispatch progress, so cloning its row into
      // INSERT would fail the earlier birth-state gate. Exercise the actual SQL
      // selection function directly with the real row composite and one invalid
      // NULL kind. No row is inserted or changed, and this transaction must reject.
      await tx.execute(sql`select agent_plan_check_selection(jsonb_populate_record(null::agent_plan_runs,
        to_jsonb(r)||jsonb_build_object('allowed_commands','[{"domain":"fulfillment","kind":null}]'::jsonb)))
        from agent_plan_runs r where r.id=${row.id}::uuid`);
      throw new Error("actual_sql_null_kind_unexpectedly_accepted");
    }); } catch (error) { code = pgCode(error); rejectedNullKind = hasDatabaseReason(error, "agent_plan_commands_invalid"); }
    expect(code).toBe("23514"); expect(rejectedNullKind).toBe(true);
    expect(safeSnapshotHash((await f.rows(context)).runs.find(run => run.id === row.id))).toBe(safeSnapshotHash(row));
    await f.service().stop(context, queued.id, { version, requestId: queued.requestId }); await f.process(queued.id);
    const value = await planned("delivery_feedback"), receipt = await f.service().prepareItem(context, value.view.id, value.item.id, value.prepare);
    expect(receipt.disposition).toBe("known"); const before = (await f.rows(context)).items.find(item => item.id === value.item.id);
    code = null;
    try { await withTenant(database.db, context, async tx => { await tx.update(agentPlanItems).set({ completionChecksum: "f".repeat(64) }).where(eq(agentPlanItems.id, value.item.id)); await tx.execute(sql`set constraints all immediate`); }); }
    catch (error) { code = pgCode(error); }
    expect(code).toBe("23514"); expect(safeSnapshotHash((await f.rows(context)).items.find(item => item.id === value.item.id))).toBe(safeSnapshotHash(before));
    expect(await withTenant(database.db, await f.current(f.base.foreign), tx => tx.select({ id: agentPlanItems.id }).from(agentPlanItems)
      .where(and(eq(agentPlanItems.id, value.item.id), eq(agentPlanItems.tenantId, context.tenantId))))).toEqual([]);
  });
});
