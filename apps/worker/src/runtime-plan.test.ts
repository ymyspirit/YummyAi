import { describe, expect, it } from "vitest";
import { QueueName } from "@yummyai/jobs";
import { resolveWorkerRuntimePlan, runtimeQueues, schedulerOwners, WorkerSelectionError } from "./runtime-plan.js";

describe("Worker process capabilities", () => {
  it("retains all enabled consumers and timers when selection is absent", () => {
    const plan = resolveWorkerRuntimePlan({}, runtimeQueues);
    expect([...plan.queues]).toHaveLength(29);
    expect([...plan.schedulers]).toEqual(Object.keys(schedulerOwners));
    expect(new Set([...runtimeQueues, QueueName.AiAnalysis, QueueName.Capture, QueueName.Export, QueueName.Metrics, QueueName.OrderIngestion])).toEqual(new Set(Object.values(QueueName)));
  });
  it("explicit queue selection includes only its own dispatchers by default", () => {
    const plan = resolveWorkerRuntimePlan({ WORKER_QUEUES: "media, knowledge-maintenance" }, runtimeQueues);
    expect([...plan.queues]).toEqual([QueueName.Media, QueueName.KnowledgeMaintenance]);
    expect([...plan.schedulers]).toEqual(["captureMediaScheduler", "knowledgeMaintenanceScheduler"]);
  });
  it("selects the Agent loop consumer and only its own scheduler", () => {
    const plan = resolveWorkerRuntimePlan({ WORKER_QUEUES: QueueName.AgentLoop }, runtimeQueues);
    expect([...plan.queues]).toEqual([QueueName.AgentLoop]);
    expect([...plan.schedulers]).toEqual(["agentLoopScheduler"]);
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: "media", WORKER_SCHEDULERS: "agentLoopScheduler" }, runtimeQueues)).toThrow(WorkerSelectionError);
  });
  it("keeps business planning dispatch separate from the original read loop and unrelated consumers", () => {
    const plan = resolveWorkerRuntimePlan({ WORKER_QUEUES: QueueName.AgentPlan }, runtimeQueues);
    expect([...plan.queues]).toEqual([QueueName.AgentPlan]);
    expect([...plan.schedulers]).toEqual(["agentPlanScheduler"]);
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: QueueName.AgentLoop, WORKER_SCHEDULERS: "agentPlanScheduler" }, runtimeQueues)).toThrow(WorkerSelectionError);
  });
  it("allows a consumer without background dispatch or a timer without consumers", () => {
    const consumer = resolveWorkerRuntimePlan({ WORKER_QUEUES: "pod-artwork", WORKER_SCHEDULERS: "none" }, runtimeQueues);
    expect([...consumer.schedulers]).toEqual([]);
    const timer = resolveWorkerRuntimePlan({ WORKER_QUEUES: "none", WORKER_SCHEDULERS: "workflowAttentionScheduler" }, runtimeQueues);
    expect([...timer.queues]).toEqual([]); expect([...timer.schedulers]).toEqual(["workflowAttentionScheduler"]);
    const retention = resolveWorkerRuntimePlan({ WORKER_QUEUES: "none", WORKER_SCHEDULERS: "materialCommandRetentionScheduler" }, runtimeQueues);
    expect([...retention.queues]).toEqual([]); expect([...retention.schedulers]).toEqual(["materialCommandRetentionScheduler"]);
    const incoming = resolveWorkerRuntimePlan({ WORKER_QUEUES: "none", WORKER_SCHEDULERS: "incomingCommandRetentionScheduler" }, runtimeQueues);
    expect([...incoming.queues]).toEqual([]); expect([...incoming.schedulers]).toEqual(["incomingCommandRetentionScheduler"]);
    const advertising = resolveWorkerRuntimePlan({ WORKER_QUEUES: "none", WORKER_SCHEDULERS: "advertisingCommandRetentionScheduler" }, runtimeQueues);
    expect([...advertising.queues]).toEqual([]); expect([...advertising.schedulers]).toEqual(["advertisingCommandRetentionScheduler"]);
  });
  it.each(["", "media,", ",media", "media,media", "capture", "not-a-queue", "all,media", "MEDIA"])("rejects malformed selection %j without falling back to all", value => {
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: value }, runtimeQueues)).toThrow(WorkerSelectionError);
  });
  it("does not enable an optional queue whose provider capability is disabled", () => {
    const available = runtimeQueues.filter(name => name !== QueueName.OrderPersonalizationRender);
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: QueueName.OrderPersonalizationRender }, available)).toThrow(WorkerSelectionError);
    expect(resolveWorkerRuntimePlan({ WORKER_QUEUES: "all" }, available).queues.has(QueueName.OrderPersonalizationRender)).toBe(false);
    expect(resolveWorkerRuntimePlan({}, available).queues.has(QueueName.OrderPersonalizationRender)).toBe(false);
  });
  it.each(["", "workflowNodeScheduler", "captureMediaScheduler,", "unknown", "captureMediaScheduler,captureMediaScheduler"])("rejects invalid or unowned timers %j", value => {
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: "media", WORKER_SCHEDULERS: value }, runtimeQueues)).toThrow(WorkerSelectionError);
  });
  it("does not declare an empty process ready", () => {
    expect(() => resolveWorkerRuntimePlan({ WORKER_QUEUES: "none" }, runtimeQueues)).toThrow(WorkerSelectionError);
  });
  it("does not echo arbitrary configuration in diagnostic errors", () => {
    try { resolveWorkerRuntimePlan({ WORKER_QUEUES: "synthetic-private-input" }, runtimeQueues); }
    catch (error) { expect((error as Error).message).toBe("WORKER_RUNTIME_SELECTION_INVALID"); }
  });
});
