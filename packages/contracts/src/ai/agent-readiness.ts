import { z } from "zod";

/** A current, read-only sidecar. Historical task/workspace ABIs stay unchanged. */
export const AGENT_READINESS_VERSION = "erp.agent.readiness.v1" as const;
export const AgentReadinessFamilySchema = z.enum(["loop", "plan", "native_v1", "native_v2", "native_v3", "native_v4"]);
export const AgentReadinessBlockerSchema = z.enum([
  "workflow_run_permission_missing",
  "model_not_configured",
  "model_routes_disabled",
  "model_provider_unsupported",
  "model_pricing_missing",
  "model_task_cap_missing",
  "original_read_unavailable",
  "original_command_unavailable",
  "task_budget_below_minimum",
  "monthly_cost_unknown",
  "monthly_budget_exhausted",
  "active_task_limit",
]);
export const AgentReadinessSchema = z.object({
  version: z.literal(AGENT_READINESS_VERSION),
  family: AgentReadinessFamilySchema,
  contextAuthority: z.string().min(1).max(65_536),
  workspaceVersion: z.string().min(1).max(100),
  checkedAt: z.iso.datetime(),
  state: z.enum(["blocked", "no_known_blocker"]),
  blockers: z.array(AgentReadinessBlockerSchema).max(12),
  checks: z.object({
    runPermission: z.enum(["granted", "missing"]),
    model: z.enum(["available", "unavailable"]),
    originalCapability: z.enum(["available", "unavailable"]),
    taskBudget: z.enum(["positive", "below_minimum", "not_checked"]),
    monthlyBudget: z.enum(["not_configured", "available", "exhausted", "cost_unknown", "not_checked"]),
    concurrency: z.enum(["available", "at_limit", "not_checked"]),
  }).strict(),
  canConfigureModels: z.boolean(),
  metadataOnly: z.literal(true),
  notChecked: z.tuple([
    z.literal("request_budget"), z.literal("selected_sources"),
    z.literal("provider_connection"), z.literal("consumer_readiness"),
  ]),
  effects: z.object({ modelCalls: z.literal(0), queueDispatches: z.literal(0), budgetReservations: z.literal(0), businessWrites: z.literal(0) }).strict(),
}).strict().superRefine((value, ctx) => {
  const blockers = new Set(value.blockers);
  const matches = (present: boolean, code: z.infer<typeof AgentReadinessBlockerSchema>) => present === blockers.has(code);
  const modelCodes = ["model_not_configured", "model_routes_disabled", "model_provider_unsupported", "model_pricing_missing", "model_task_cap_missing"] as const;
  const capabilityCode = value.family === "plan" ? "original_command_unavailable" : "original_read_unavailable";
  const otherCapabilityCode = value.family === "plan" ? "original_read_unavailable" : "original_command_unavailable";
  if (blockers.size !== value.blockers.length || (value.state === "blocked") !== (blockers.size > 0)
    || !matches(value.checks.runPermission === "missing", "workflow_run_permission_missing")
    || (value.checks.model === "unavailable") !== modelCodes.some(code => blockers.has(code))
    || !matches(value.checks.originalCapability === "unavailable", capabilityCode) || blockers.has(otherCapabilityCode)
    || !matches(value.checks.taskBudget === "below_minimum", "task_budget_below_minimum")
    || !matches(value.checks.monthlyBudget === "cost_unknown", "monthly_cost_unknown")
    || !matches(value.checks.monthlyBudget === "exhausted", "monthly_budget_exhausted")
    || !matches(value.checks.concurrency === "at_limit", "active_task_limit")) {
    ctx.addIssue({ code: "custom", message: "Readiness state and fixed blockers must agree" });
  }
  const budgetUnchecked = value.checks.taskBudget === "not_checked" && value.checks.monthlyBudget === "not_checked" && value.checks.concurrency === "not_checked";
  if ((value.checks.runPermission === "missing") !== budgetUnchecked
    || value.checks.runPermission === "granted" && (value.checks.taskBudget === "not_checked" || value.checks.monthlyBudget === "not_checked" || value.checks.concurrency === "not_checked")) {
    ctx.addIssue({ code: "custom", message: "Budget and concurrency metadata require current run permission" });
  }
});

export type AgentReadinessFamily = z.infer<typeof AgentReadinessFamilySchema>;
export type AgentReadinessBlocker = z.infer<typeof AgentReadinessBlockerSchema>;
export type AgentReadiness = z.infer<typeof AgentReadinessSchema>;
