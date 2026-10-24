import { describe, expect, it } from "vitest";
import { AGENT_LOOP_VERSION } from "@yummyai/contracts/ai/agent-loop";
import { AGENT_PLAN_VERSION } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_VERSION } from "@yummyai/contracts/ai/agent-native";
import { AGENT_NATIVE_V2_VERSION } from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_NATIVE_V3_VERSION } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_NATIVE_V4_VERSION } from "@yummyai/contracts/ai/agent-native-v4";
import {
  AGENT_RUNTIME_FAMILIES, AGENT_RUNTIME_LEASE_MS, AGENT_RUNTIME_MAX_VALID_MS,
  AGENT_RUNTIME_PRESENCE_VERSION, AGENT_RUNTIME_READINESS_VERSION,
  AgentRuntimeObservationSchema, AgentRuntimePresenceReportSchema, AgentRuntimeReadinessSchema,
  agentRuntimeWorkerName, type AgentRuntimePresenceReport, type AgentRuntimeReadiness,
} from "./agent-runtime-readiness.js";

const instanceId = "019d1710-b400-7000-8000-000000000001";
const report = (): AgentRuntimePresenceReport => ({
  version: AGENT_RUNTIME_PRESENCE_VERSION, instanceId, queue: "agent-plan", workerName: agentRuntimeWorkerName(instanceId),
  executorVersions: [AGENT_PLAN_VERSION, AGENT_NATIVE_VERSION, AGENT_NATIVE_V2_VERSION, AGENT_NATIVE_V3_VERSION], lifecycle: "ready",
  consumer: { running: true, paused: false, normalConnection: "ready", blockingConnection: "ready" },
  dispatcher: { name: "agentPlanScheduler", started: true, closing: false, lastSuccessAgeMs: 0, currentFailure: false },
});
const view = (): AgentRuntimeReadiness => ({
  version: AGENT_RUNTIME_READINESS_VERSION, family: "native_v3", contextAuthority: "synthetic-runtime-current-authority",
  presenceVersion: AGENT_RUNTIME_PRESENCE_VERSION, executorVersion: AGENT_NATIVE_V3_VERSION,
  checkedAt: "2026-10-23T00:00:00.000Z", validUntil: "2026-10-23T00:00:10.000Z", validForMs: AGENT_RUNTIME_MAX_VALID_MS,
  state: "observed_ready", checks: { consumer: "ready", dispatcher: "ready", queue: "open" }, reasons: [], metadataOnly: true, advisoryOnly: true,
  notChecked: ["request_budget", "selected_sources", "provider_connection", "business_admission"],
  effects: { modelCalls: 0, queueDispatches: 0, budgetReservations: 0, businessWrites: 0 },
});

describe("independent Harness runtime observation contract", () => {
  it("binds all six executor versions to the actual two queues and their exact dispatcher", () => {
    expect(AGENT_RUNTIME_FAMILIES).toEqual({
      loop: { queue: "agent-loop", scheduler: "agentLoopScheduler", executorVersion: AGENT_LOOP_VERSION },
      plan: { queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_PLAN_VERSION },
      native_v1: { queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_VERSION },
      native_v2: { queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V2_VERSION },
      native_v3: { queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V3_VERSION },
      native_v4: { queue: "agent-plan", scheduler: "agentPlanScheduler", executorVersion: AGENT_NATIVE_V4_VERSION },
    });
    expect(AgentRuntimePresenceReportSchema.parse(report())).toEqual(report());
    for (const value of [
      { ...report(), workerName: "unrelated-worker" }, { ...report(), queue: "agent-loop" },
      { ...report(), executorVersions: [AGENT_NATIVE_V3_VERSION, AGENT_NATIVE_V3_VERSION] },
      { ...report(), executorVersions: [AGENT_LOOP_VERSION] },
      { ...report(), dispatcher: { ...report().dispatcher, name: "agentLoopScheduler" } },
      { ...report(), tenantId: instanceId }, { ...report(), credential: "synthetic-private-value" },
    ]) expect(AgentRuntimePresenceReportSchema.safeParse(value).success).toBe(false);
    expect(() => agentRuntimeWorkerName("not-a-uuid")).toThrow();
  });

  it("never permits unknown Redis observations to carry a stale positive worker or queue result", () => {
    const known = { status: "known", checkedAt: view().checkedAt, queuePaused: false, connectedWorkerNames: [report().workerName],
      observations: [{ report: report(), expiresInMs: AGENT_RUNTIME_LEASE_MS, observedAgeMs: 0 }] };
    expect(AgentRuntimeObservationSchema.safeParse(known).success).toBe(true);
    expect(AgentRuntimeObservationSchema.safeParse({ ...known, status: "unknown", queuePaused: null, connectedWorkerNames: [], observations: [] }).success).toBe(true);
    for (const value of [
      { ...known, status: "unknown" }, { ...known, queuePaused: null },
      { ...known, observations: [{ ...known.observations[0], expiresInMs: 0 }] },
      { ...known, observations: [{ ...known.observations[0], expiresInMs: AGENT_RUNTIME_LEASE_MS + 1 }] },
      { ...known, observations: [{ ...known.observations[0], observedAgeMs: -1 }] },
      { ...known, privateBody: "synthetic-private-value" },
    ]) expect(AgentRuntimeObservationSchema.safeParse(value).success).toBe(false);
  });

  it("requires matching protocol, all three ready checks and an exact finite server freshness interval", () => {
    expect(AgentRuntimeReadinessSchema.parse(view())).toEqual(view());
    const nativeV4 = { ...view(), family: "native_v4", executorVersion: AGENT_NATIVE_V4_VERSION };
    expect(AgentRuntimeReadinessSchema.parse(nativeV4)).toEqual(nativeV4);
    expect(AgentRuntimeReadinessSchema.safeParse({ ...nativeV4, executorVersion: AGENT_NATIVE_V3_VERSION }).success).toBe(false);
    for (const value of [
      { ...view(), family: "loop" }, { ...view(), executorVersion: AGENT_PLAN_VERSION },
      { ...view(), validForMs: 0, validUntil: view().checkedAt },
      { ...view(), validForMs: AGENT_RUNTIME_MAX_VALID_MS + 1 },
      { ...view(), validUntil: "2026-10-23T00:00:09.999Z" },
      { ...view(), checks: { ...view().checks, dispatcher: "unavailable" } },
      { ...view(), checks: { ...view().checks, queue: "paused" } },
      { ...view(), reasons: ["consumer_unavailable"] },
      { ...view(), effects: { ...view().effects, queueDispatches: 1 } },
      { ...view(), admissionApproved: true }, { ...view(), credential: "synthetic-private-value" },
    ]) expect(AgentRuntimeReadinessSchema.safeParse(value).success).toBe(false);
  });

  it("keeps permission withholding and transport uncertainty distinct from an unavailable consumer", () => {
    const inactive = { ...view(), validUntil: view().checkedAt, validForMs: 0 };
    const unavailable = { ...inactive, state: "unavailable", checks: { consumer: "unavailable", dispatcher: "unavailable", queue: "open" }, reasons: ["runtime_not_observed"] };
    const withheld = { ...inactive, state: "not_checked", checks: { consumer: "not_checked", dispatcher: "not_checked", queue: "not_checked" }, reasons: ["workflow_run_permission_missing"] };
    const unknown = { ...inactive, state: "unknown", checks: { consumer: "unknown", dispatcher: "unknown", queue: "unknown" }, reasons: ["runtime_observation_unknown"] };
    for (const value of [unavailable, withheld, unknown]) expect(AgentRuntimeReadinessSchema.safeParse(value).success).toBe(true);
    for (const value of [
      { ...withheld, checks: { ...withheld.checks, consumer: "ready" } },
      { ...unknown, reasons: ["runtime_not_observed"] }, { ...unavailable, reasons: ["workflow_run_permission_missing"] },
      { ...unavailable, reasons: [] }, { ...unavailable, reasons: ["runtime_not_observed", "runtime_not_observed"] },
      { ...unavailable, state: "observed_ready" },
    ]) expect(AgentRuntimeReadinessSchema.safeParse(value).success).toBe(false);
  });
});
