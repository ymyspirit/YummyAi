import { z } from "zod";
import { AgentReadinessFamilySchema, AgentReadinessSchema } from "@yummyai/contracts/ai/agent-readiness";
import { AGENT_LOOP_VERSION } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_PLAN_VERSION } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_VERSION } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_VERSION } from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_VERSION } from "@yummyai/contracts/ai/agent-native-v4";

export const AGENT_RUNTIME_PRESENCE_VERSION = "erp.agent.runtime.presence.v1" as const;
export const AGENT_RUNTIME_READINESS_VERSION = "erp.agent.runtime-readiness.v1" as const;
export const AGENT_RUNTIME_LEASE_MS = 15_000;
export const AGENT_RUNTIME_PULSE_MS = 3_000;
export const AGENT_RUNTIME_DISPATCH_FRESH_MS = 75_000;
export const AGENT_RUNTIME_MAX_VALID_MS = 10_000;
export const AGENT_RUNTIME_IO_TIMEOUT_MS = 1_500;
export const AGENT_RUNTIME_MAX_INSTANCES = 64;
export const AgentRuntimeQueueSchema = z.enum(["agent-loop", "agent-plan"]);
export const AgentRuntimeExecutorVersionSchema = z.enum([AGENT_LOOP_VERSION, AGENT_PLAN_VERSION, AGENT_NATIVE_VERSION, AGENT_NATIVE_V2_VERSION, AGENT_NATIVE_V3_VERSION, AGENT_NATIVE_V4_VERSION]);
export const AGENT_RUNTIME_FAMILIES = Object.freeze({
  loop: Object.freeze({ queue: "agent-loop", scheduler: "agentLoopScheduler", executorVersion: AGENT_LOOP_VERSION }),
  plan: Object.freeze({ queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_PLAN_VERSION }),
  native_v1: Object.freeze({ queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_VERSION }),
  native_v2: Object.freeze({ queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V2_VERSION }),
  native_v3: Object.freeze({ queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V3_VERSION }),
  native_v4: Object.freeze({ queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V4_VERSION }),
} as const);
export const agentRuntimeWorkerName = (instanceId: string) => "yummyai-agent-runtime-" + z.uuid().parse(instanceId);

/** Internal ephemeral transport proof. Never contains a tenant, job or model. */
export const AgentRuntimePresenceReportSchema = z.object({
  version: z.literal(AGENT_RUNTIME_PRESENCE_VERSION), instanceId: z.uuid(), queue: AgentRuntimeQueueSchema,
  workerName: z.string().max(80), executorVersions: z.array(AgentRuntimeExecutorVersionSchema).min(1).max(5),
  lifecycle: z.enum(["starting", "ready", "stopping", "stopped", "error"]),
  consumer: z.object({ running: z.boolean(), paused: z.boolean(), normalConnection: z.enum(["ready", "unavailable"]), blockingConnection: z.enum(["ready", "unavailable"]) }).strict(),
  dispatcher: z.object({ name: z.enum(["agentLoopScheduler", "agentPlanScheduler"]), started: z.boolean(), closing: z.boolean(),
    lastSuccessAgeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(), currentFailure: z.boolean() }).strict(),
}).strict().superRefine((value, context) => {
  const loop = value.queue === "agent-loop";
  if (value.workerName !== "yummyai-agent-runtime-" + value.instanceId || new Set(value.executorVersions).size !== value.executorVersions.length
    || value.dispatcher.name !== (loop ? "agentLoopScheduler" : "agentPlanScheduler")
    || value.executorVersions.some(version => loop ? version !== AGENT_LOOP_VERSION : version === AGENT_LOOP_VERSION))
    context.addIssue({ code: "custom", message: "Worker identity, supported protocol and dispatcher must match the actual queue" });
});

export const AgentRuntimeObservationSchema = z.object({
  status: z.enum(["known", "unknown"]), checkedAt: z.iso.datetime(), queuePaused: z.boolean().nullable(),
  connectedWorkerNames: z.array(z.string().max(80)).max(AGENT_RUNTIME_MAX_INSTANCES),
  observations: z.array(z.object({ report: AgentRuntimePresenceReportSchema,
    expiresInMs: z.number().int().min(1).max(AGENT_RUNTIME_LEASE_MS), observedAgeMs: z.number().int().min(0).max(AGENT_RUNTIME_LEASE_MS),
  }).strict()).max(AGENT_RUNTIME_MAX_INSTANCES),
}).strict().superRefine((value, context) => {
  if (value.status === "unknown" && (value.queuePaused !== null || value.observations.length || value.connectedWorkerNames.length)
    || value.status === "known" && value.queuePaused === null)
    context.addIssue({ code: "custom", message: "Unknown transport observations must not expose stale positive proof" });
});
export const AgentRuntimeReadinessReasonSchema = z.enum(["workflow_run_permission_missing", "runtime_not_observed", "runtime_protocol_unavailable",
  "consumer_unavailable", "dispatcher_unavailable", "queue_paused", "runtime_observation_unknown"]);
export const AgentRuntimeReadinessSchema = z.object({
  version: z.literal(AGENT_RUNTIME_READINESS_VERSION), family: AgentReadinessFamilySchema,
  contextAuthority: AgentReadinessSchema.shape.contextAuthority,
  presenceVersion: z.literal(AGENT_RUNTIME_PRESENCE_VERSION), executorVersion: AgentRuntimeExecutorVersionSchema,
  checkedAt: z.iso.datetime(), validUntil: z.iso.datetime(), validForMs: z.number().int().min(0).max(AGENT_RUNTIME_MAX_VALID_MS),
  state: z.enum(["observed_ready", "unavailable", "unknown", "not_checked"]),
  checks: z.object({ consumer: z.enum(["ready", "unavailable", "unknown", "not_checked"]), dispatcher: z.enum(["ready", "unavailable", "unknown", "not_checked"]),
    queue: z.enum(["open", "paused", "unknown", "not_checked"]) }).strict(),
  reasons: z.array(AgentRuntimeReadinessReasonSchema).max(7), metadataOnly: z.literal(true), advisoryOnly: z.literal(true),
  notChecked: z.tuple([z.literal("request_budget"), z.literal("selected_sources"), z.literal("provider_connection"), z.literal("business_admission")]),
  effects: z.object({ modelCalls: z.literal(0), queueDispatches: z.literal(0), budgetReservations: z.literal(0), businessWrites: z.literal(0) }).strict(),
}).strict().superRefine((value, context) => {
  const ready = value.state === "observed_ready", allReady = value.checks.consumer === "ready" && value.checks.dispatcher === "ready" && value.checks.queue === "open";
  if (value.executorVersion !== AGENT_RUNTIME_FAMILIES[value.family].executorVersion || new Set(value.reasons).size !== value.reasons.length
    || ready !== allReady || (ready ? !value.validForMs || value.reasons.length > 0 : value.validForMs !== 0 || value.reasons.length === 0)
    || Date.parse(value.validUntil) - Date.parse(value.checkedAt) !== value.validForMs
    || value.state === "not_checked" && (value.checks.consumer !== "not_checked" || value.checks.dispatcher !== "not_checked" || value.checks.queue !== "not_checked"
      || value.reasons.length !== 1 || value.reasons[0] !== "workflow_run_permission_missing")
    || value.state === "unknown" && (value.checks.consumer !== "unknown" || value.checks.dispatcher !== "unknown" || value.checks.queue !== "unknown"
      || value.reasons.length !== 1 || value.reasons[0] !== "runtime_observation_unknown")
    || value.state !== "not_checked" && value.reasons.includes("workflow_run_permission_missing"))
    context.addIssue({ code: "custom", message: "Runtime observations have finite freshness and never grant task admission" });
});
export type AgentRuntimePresenceReport = z.infer<typeof AgentRuntimePresenceReportSchema>;
export type AgentRuntimeObservation = z.infer<typeof AgentRuntimeObservationSchema>;
export type AgentRuntimeReadiness = z.infer<typeof AgentRuntimeReadinessSchema>;
export type AgentRuntimeQueue = z.infer<typeof AgentRuntimeQueueSchema>;
