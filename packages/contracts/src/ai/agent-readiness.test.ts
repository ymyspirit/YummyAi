import { describe, expect, it } from "vitest";
import { AGENT_READINESS_VERSION, AgentReadinessFamilySchema, AgentReadinessSchema, type AgentReadiness, type AgentReadinessFamily } from "./agent-readiness.js";

function ready(family: AgentReadinessFamily = "native_v3"): AgentReadiness {
  return {
    version: AGENT_READINESS_VERSION, family, contextAuthority: "synthetic-current-personal-authority", workspaceVersion: "original-workspace-version",
    checkedAt: "2026-10-23T00:00:00.000Z", state: "no_known_blocker", blockers: [],
    checks: { runPermission: "granted", model: "available", originalCapability: "available", taskBudget: "positive", monthlyBudget: "available", concurrency: "available" },
    canConfigureModels: true, metadataOnly: true,
    notChecked: ["request_budget", "selected_sources", "provider_connection", "consumer_readiness"],
    effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 },
  };
}

describe("independent read-only Agent readiness v1 transport", () => {
  it("accepts all six backend families while preserving the four explicit unchecked boundaries", () => {
    expect(AgentReadinessFamilySchema.options).toEqual(["loop", "plan", "native_v1", "native_v2", "native_v3", "native_v4"]);
    for (const family of AgentReadinessFamilySchema.options) {
      const parsed = AgentReadinessSchema.parse(ready(family));
      expect(parsed.family).toBe(family);
      expect(parsed.notChecked).toEqual(["request_budget", "selected_sources", "provider_connection", "consumer_readiness"]);
      expect(parsed.state).toBe("no_known_blocker");
    }
    expect(AgentReadinessFamilySchema.safeParse("unknown_family").success).toBe(false);
  });

  it("rejects a fabricated successful reservation, private configuration or a specific request budget", () => {
    const value = ready();
    for (const changed of [
      { ...value, effects: { ...value.effects, budgetReservations: 1 } },
      { ...value, effects: { ...value.effects, modelCalls: 1 } },
      { ...value, effects: { ...value.effects, queueDispatches: 1 } },
      { ...value, effects: { ...value.effects, businessWrites: 1 } },
      { ...value, maxCostUsd: 0.000001 },
      { ...value, modelId: "synthetic-model" },
      { ...value, providerEndpoint: "https://synthetic.invalid" },
      { ...value, notChecked: ["selected_sources", "provider_connection", "consumer_readiness"] },
      { ...value, notChecked: ["selected_sources", "request_budget", "provider_connection", "consumer_readiness"] },
    ]) expect(AgentReadinessSchema.safeParse(changed).success).toBe(false);
  });

  it("requires truthful model, capability, budget and concurrency blocker combinations", () => {
    const value = ready();
    const blocked: AgentReadiness = { ...value, state: "blocked",
      blockers: ["model_pricing_missing", "original_read_unavailable", "monthly_cost_unknown", "active_task_limit"],
      checks: { ...value.checks, model: "unavailable", originalCapability: "unavailable", monthlyBudget: "cost_unknown", concurrency: "at_limit" } };
    expect(AgentReadinessSchema.parse(blocked)).toEqual(blocked);
    for (const changed of [
      { ...blocked, state: "no_known_blocker" },
      { ...blocked, blockers: [...blocked.blockers, "model_pricing_missing"] },
      { ...blocked, blockers: blocked.blockers.filter(code => code !== "monthly_cost_unknown") },
      { ...blocked, family: "plan" },
      { ...value, blockers: ["monthly_budget_exhausted"] },
      { ...value, checks: { ...value.checks, taskBudget: "below_minimum" } },
      { ...value, checks: { ...value.checks, concurrency: "at_limit" } },
    ]) expect(AgentReadinessSchema.safeParse(changed).success).toBe(false);
    const plan = { ...ready("plan"), state: "blocked", blockers: ["original_command_unavailable"],
      checks: { ...value.checks, originalCapability: "unavailable" } };
    expect(AgentReadinessSchema.safeParse(plan).success).toBe(true);
  });

  it("withholds every organization budget and concurrency check when the current user cannot run", () => {
    const value = ready();
    const denied: AgentReadiness = { ...value, state: "blocked", blockers: ["workflow_run_permission_missing"], canConfigureModels: false,
      checks: { ...value.checks, runPermission: "missing", taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" } };
    expect(AgentReadinessSchema.parse(denied)).toEqual(denied);
    for (const changed of [
      { ...denied, checks: { ...denied.checks, monthlyBudget: "available" } },
      { ...denied, checks: { ...denied.checks, taskBudget: "positive" } },
      { ...denied, checks: { ...denied.checks, concurrency: "available" } },
      { ...value, checks: { ...value.checks, monthlyBudget: "not_checked" } },
      { ...value, checks: { ...value.checks, taskBudget: "not_checked", monthlyBudget: "not_checked", concurrency: "not_checked" } },
    ]) expect(AgentReadinessSchema.safeParse(changed).success).toBe(false);
  });
});
