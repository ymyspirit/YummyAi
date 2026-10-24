import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictException, HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { AgentReadinessFamilySchema, AgentReadinessSchema, type AgentReadinessFamily } from "@yummyai/contracts/ai/agent-readiness";
import { ErpSessionViewSchema, erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3ReceiptSchema } from "@yummyai/contracts/ai/agent-native-v3";
import { aiAssistRuns, agentLoopRuns, connectDatabase, withTenant } from "@yummyai/database";
import { requireAgentReadinessEnvironment } from "../../../../tools/testing/require-agent-readiness-environment.mjs";
import { bounded, deferred, type AgentActor } from "./agent-read.test-fixture.js";
import { agentReadinessFixture, readinessAuthority } from "./agent-readiness.test-fixture.js";
import { evaluateAgentReadinessBudget } from "./agent-readiness-budget.js";

const environment = requireAgentReadinessEnvironment(), database = connectDatabase(environment.url), f = agentReadinessFixture(database);
// This fixture owns the historical five families. V4 has its own original-owner acceptance lane.
const families = AgentReadinessFamilySchema.exclude(["native_v4"]).options;
const allScopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
async function read(actor: AgentActor, family: AgentReadinessFamily = "native_v3") {
  if(family==="native_v4")throw new Error("Native-v4 requires its independent fixture");
  const context = await f.base.current(actor), response = await f.http(actor, `/v1/ai/agent-readiness/${family}`);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  const view = AgentReadinessSchema.parse(await response.json());
  expect(view.contextAuthority).toBe(readinessAuthority(context));
  expect(response.headers.get("x-yummyai-context-authority")).toBe(view.contextAuthority);
  expect(view.family).toBe(family);
  expect(view.workspaceVersion).toBe((await f.owners[family].workspace(context)).version);
  expect(view.effects).toEqual({ modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 });
  expect(view.notChecked).toEqual(["request_budget", "selected_sources", "provider_connection", "consumer_readiness"]);
  return view;
}
async function stableRead(actor: AgentActor, family: AgentReadinessFamily = "native_v3") {
  const before = await f.state(actor), value = await read(actor, family);
  expect(await f.state(actor)).toEqual(before); return value;
}
function code(error: unknown) {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : null;
}

describe.sequential("Agent readiness five original owners with current non-owner tenant metadata", () => {
  beforeAll(async () => { await f.initialize(); });
  afterAll(async () => {
    const failures: unknown[] = [];
    try { await f.close(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "readiness_disposable_cleanup_failed");
  });

  it("model_diagnostics distinguish missing disabled unsupported unpriced and subminimum caps without probing a provider", async () => {
    const absent = (await f.actor(false)).actor;
    for (const family of families) {
      const view = await stableRead(absent, family);
      expect(view.blockers).toContain("model_not_configured"); expect(view.checks.model).toBe("unavailable");
    }
    const { actor } = await f.actor();
    for (const family of families) expect((await stableRead(actor, family)).state).toBe("no_known_blocker");
    const modes = [
      ["disabled", "model_routes_disabled"], ["unsupported", "model_provider_unsupported"],
      ["unpriced", "model_pricing_missing"], ["uncapped", "model_task_cap_missing"],
    ] as const;
    for (const [mode, blocker] of modes) {
      const restore = await f.modelMode(actor, mode);
      try { for (const family of families) { const view = await stableRead(actor, family); expect(view.checks.model).toBe("unavailable"); expect(view.blockers).toContain(blocker); } }
      finally { await restore(); }
    }
    expect((await stableRead(actor)).checks.model).toBe("available");
  });

  it("exact_micro_budget checks one micro of headroom without approving a specific request and ignores released or prior UTC month amounts", async () => {
    const { actor } = await f.actor();
    await f.policy(actor, { monthly: "1.000000", task: "1", caps: { erp_agent: 0.0000009, erp_agent_plan: 1 } });
    for (const family of families) expect((await stableRead(actor, family)).checks.taskBudget).toBe("below_minimum");
    await f.policy(actor, { monthly: "1.000000", task: "1", caps: { erp_agent: 1, erp_agent_plan: 0.0000009 } });
    expect((await stableRead(actor, "loop")).checks.taskBudget).toBe("positive");
    for (const family of families.filter(item => item !== "loop")) expect((await stableRead(actor, family)).checks.taskBudget).toBe("below_minimum");
    await f.policy(actor, { monthly: "1.000000", task: "0.000001" });
    await f.ledger(actor, "0.500000", "reserved"); await f.ledger(actor, "0.499999", "committed");
    await f.ledger(actor, "99.999999", "released"); await f.ledger(actor, "99.999999", "committed", true);
    for (const family of families) {
      const view = await stableRead(actor, family);
      expect(view.checks.taskBudget).toBe("positive"); expect(view.checks.monthlyBudget).toBe("available");
    }
    expect(evaluateAgentReadinessBudget({ taskCapUsd: "0.000001", monthlyCapUsd: "99999999.999999", monthUsedUsd: "99999999.999998", legacyCostUnknown: false, activeTasks: "3" }))
      .toEqual({ taskBudget: "positive", monthlyBudget: "available", concurrency: "available" });
    await f.ledger(actor, "0.000001", "reserved");
    for (const family of families) { const view = await stableRead(actor, family); expect(view.checks.monthlyBudget).toBe("exhausted"); expect(view.blockers).toContain("monthly_budget_exhausted"); }
  });

  it("legacy_unknown synthetic predicate blocks only a started unpriced current month call without not-submitted evidence", async () => {
    for (const variant of ["not_started", "not_submitted", "known_zero", "bounded", "previous_month", "unknown"] as const) {
      const { actor } = await f.actor(); await f.policy(actor); await f.legacyUnknown(actor, variant);
      for (const family of families) {
        const view = await stableRead(actor, family);
        expect(view.checks.monthlyBudget).toBe(variant === "unknown" ? "cost_unknown" : "available");
        expect(view.blockers.includes("monthly_cost_unknown")).toBe(variant === "unknown");
      }
    }
    expect(f.syntheticLegacy).toHaveLength(6);
  });

  it("active_four counts original queued plan loop and assist rows while old task and receipt GETs remain readable without dispatch", async () => {
    const { actor, modelId } = await f.actor(); if (!modelId) throw new Error("readiness_test_model_missing");
    await f.policy(actor);
    const context = await f.base.current(actor), input = await f.nativeRequest(actor, modelId);
    const first = await f.owners.native_v3.start(context, input);
    await f.owners.native_v3.start(context, await f.nativeRequest(actor, modelId));
    await f.owners.loop.start(context, await f.loopRequest(actor, modelId));
    const knowledge = await f.base.knowledgeRequest(actor);
    await f.base.assists.create(context, { ...knowledge, modelId });
    const before = await f.state(actor);
    expect(before.tables.agent_plan_runs?.count).toBe(2); expect(before.tables.agent_loop_runs?.count).toBe(1); expect(before.tables.ai_assist_runs?.count).toBe(1);
    for (const family of families) { const view = await read(actor, family); expect(view.checks.concurrency).toBe("at_limit"); expect(view.blockers).toContain("active_task_limit"); }
    const restore = await f.modelMode(actor, "disabled");
    try {
      const blocked = await stableRead(actor); expect(blocked.blockers).toContain("model_routes_disabled");
      const historical = await f.owners.native_v3.get(await f.base.current(actor), first.id);
      const receipt = AgentNativeV3ReceiptSchema.parse(await f.owners.native_v3.receipt(await f.base.current(actor),
        { requestId: input.requestId, requestChecksum: first.requestChecksum }));
      expect(historical.id).toBe(first.id); expect(historical.requestChecksum).toBe(first.requestChecksum);
      expect(receipt).toMatchObject({ disposition: "known", runId: first.id, requestChecksum: first.requestChecksum });
    } finally { await restore(); }
    expect(await f.state(actor)).toEqual(before);
  });

  it("current_authority honors self run owner tenant reads withheld budgets and the strict five-family HTTP boundary", async () => {
    const { actor } = await f.actor(); await f.policy(actor, { monthly: "0", task: "0" });
    const originalScopes = allScopes();
    await f.base.scopes(actor, { ...originalScopes, [Permission.WorkflowRun]: "self" });
    const selfRun = await stableRead(actor);
    expect(selfRun.checks.runPermission).toBe("granted"); expect(selfRun.checks.taskBudget).toBe("below_minimum"); expect(selfRun.checks.monthlyBudget).toBe("exhausted");
    const withoutRun = { ...originalScopes }; delete withoutRun[Permission.WorkflowRun]; delete withoutRun[Permission.ModelConfigure];
    await f.base.scopes(actor, withoutRun);
    for (const family of families) {
      const view = await stableRead(actor, family);
      expect(view.checks).toMatchObject({ runPermission: "missing", taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" });
      expect(view.canConfigureModels).toBe(false); expect(view.blockers).not.toContain("monthly_budget_exhausted");
    }
    const readOnlyCeiling = await f.base.current(actor);
    await f.base.scopes(actor, originalScopes);
    const bounded = await f.service().get(readOnlyCeiling, "native_v3");
    expect(bounded.checks.runPermission).toBe("missing"); expect(bounded.checks.monthlyBudget).toBe("not_checked");
    expect(bounded.canConfigureModels).toBe(false);
    await f.base.scopes(actor, { [Permission.WorkflowRead]: "tenant", [Permission.WorkflowRun]: "self" });
    expect((await stableRead(actor, "loop")).blockers).toContain("original_read_unavailable");
    expect((await stableRead(actor, "plan")).blockers).toContain("original_command_unavailable");
    // Original knowledge.search needs WorkflowRead itself. Its directory is
    // legitimately available; this neither searches knowledge nor fixes a source.
    for (const family of ["native_v1", "native_v2", "native_v3"] as const) {
      const workspace = await f.owners[family].workspace(await f.base.current(actor));
      expect(workspace.toolWorkspace.tools.find(tool => tool.key === "knowledge.search")?.available).toBe(true);
      const view = await stableRead(actor, family);
      expect(view.checks.originalCapability).toBe("available"); expect(view.blockers).not.toContain("original_read_unavailable");
    }
    await f.base.scopes(actor, originalScopes);
    for (const path of ["native_v5", "native_v3?maxCostUsd=1", "native_v3?family=loop", "native_v3?tenantId=foreign"]) {
      const response = await f.http(actor, `/v1/ai/agent-readiness/${path}`); expect(response.status).toBe(400); await response.body?.cancel();
    }
    for (const [path, method] of [["native_v3/extra", "GET"], ["native_v3", "POST"]] as const) {
      const response = await f.http(actor, `/v1/ai/agent-readiness/${path}`, method); expect(response.status).toBe(404); await response.body?.cancel();
    }
    const foreign = (await f.actor(false)).actor;
    expect((await stableRead(foreign)).blockers).toContain("model_not_configured");
    expect((await stableRead(actor)).checks.model).toBe("available");
    const identityResponse = await f.http(actor, "/v1/identity/session");
    const identity = ErpSessionViewSchema.parse(await identityResponse.json());
    expect(identity.userId).toBe(actor.userId); expect(erpSessionAuthority(identity)).toBe(readinessAuthority(await f.base.current(actor)));
    const noRead = { ...originalScopes }; delete noRead[Permission.WorkflowRead]; await f.base.scopes(actor, noRead);
    const refused = await f.http(actor, "/v1/ai/agent-readiness/native_v3"); expect(refused.status).toBe(403); await refused.body?.cancel();
    await f.base.scopes(actor, originalScopes); await f.base.memberActive(actor, false);
    await expect(f.service().get(actor.context, "native_v3")).rejects.toThrow();
    await f.base.memberActive(actor, true);
  });

  it("late_workspace requires current membership again after an actual original workspace completed and never returns stale diagnostics", async () => {
    const { actor } = await f.actor(), entered = deferred(), release = deferred();
    const originalScopes = allScopes(), before = await f.state(actor), oldContext = await f.base.current(actor);
    f.controls.afterWorkspace = async (family, context) => { if (family === "native_v3" && context.userId === actor.userId) { entered.resolve(); await release.promise; } };
    const pending = f.service().get(oldContext, "native_v3").then(value => ({ value, error: null }), error => ({ value: null, error: error as unknown }));
    try {
      await bounded(entered.promise, "readiness_original_workspace_not_reached");
      const changed = { ...originalScopes }; delete changed[Permission.WorkflowRun]; await f.base.scopes(actor, changed);
      expect(readinessAuthority(await f.base.current(actor))).not.toBe(readinessAuthority(oldContext));
      release.resolve(); const outcome = await bounded(pending, "readiness_late_workspace_not_settled");
      expect(outcome.value).toBeNull(); expect(outcome.error).toBeInstanceOf(ConflictException); expect(code(outcome.error)).toBe("authority_changed");
    } finally { release.resolve(); await pending; f.controls.afterWorkspace = undefined; await f.base.scopes(actor, originalScopes); }
    expect(await f.state(actor)).toEqual(before);
    expect((await stableRead(actor)).state).toBe("no_known_blocker");
  });

  it("concurrent_readiness is only a snapshot while original start still reserves exact money and rejects a stale positive diagnostic", async () => {
    const { actor, modelId } = await f.actor(); if (!modelId) throw new Error("readiness_test_model_missing");
    await f.policy(actor, { monthly: "0.000001", task: "0.000001" });
    const before = await f.state(actor);
    const snapshots = await Promise.all(Array.from({ length: 8 }, () => f.service().get(actor.context, "native_v3")));
    for (const snapshot of snapshots) { expect(snapshot.state).toBe("no_known_blocker"); expect(snapshot.notChecked).toContain("request_budget"); expect(snapshot.effects.budgetReservations).toBe(0); }
    expect(await f.state(actor)).toEqual(before);
    await expect(f.owners.native_v3.start(actor.context, await f.nativeRequest(actor, modelId, 1))).rejects.toMatchObject({ response: { code: "agent_budget_limit" } });
    expect(await f.state(actor)).toEqual(before);
    const one = await f.nativeRequest(actor, modelId, 0.000001), two = await f.nativeRequest(actor, modelId, 0.000001);
    const outcomes = await Promise.allSettled([f.owners.native_v3.start(actor.context, one), f.owners.native_v3.start(actor.context, two)]);
    expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(item => item.status === "rejected"); expect(rejected).toHaveLength(1);
    expect(code(rejected[0]!.reason)).toBe("agent_monthly_budget_limit");
    const afterStart = await f.state(actor);
    expect(afterStart.tables.agent_plan_runs?.count).toBe(1); expect(afterStart.tables.ai_budget_ledger?.count).toBe(1);
    expect(afterStart.dispatches - before.dispatches).toBe(1); expect(afterStart.modelCalls).toBe(0); expect(afterStart.sourceCalls).toBe(0);
    const diagnostic = await stableRead(actor); expect(diagnostic.blockers).toContain("monthly_budget_exhausted");
    const original = outcomes.find(item => item.status === "fulfilled"); if (!original || original.status !== "fulfilled") throw new Error("readiness_original_admission_missing");
    const query = new URLSearchParams({ requestId: original.value.requestId, requestChecksum: original.value.requestChecksum });
    const response = await f.http(actor, `/v1/agent-native-v3/receipt?${query}`);
    expect(response.status).toBe(200); expect(AgentNativeV3ReceiptSchema.parse(await response.json())).toMatchObject({ version: AGENT_NATIVE_V3_VERSION, runId: original.value.id, disposition: "known" });
    expect(await f.state(actor)).toEqual(afterStart);
    expect(await withTenant(database.db, actor.context, tx => tx.select().from(aiAssistRuns))).toEqual([]);
    expect(await withTenant(database.db, actor.context, tx => tx.select().from(agentLoopRuns))).toEqual([]);
  });
});
