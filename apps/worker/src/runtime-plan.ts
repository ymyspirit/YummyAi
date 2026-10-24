import { QueueName, type QueueNameValue } from "@yummyai/jobs";

export const runtimeQueues = Object.values(QueueName).filter(name => !new Set<QueueNameValue>([
  QueueName.AiAnalysis, QueueName.Capture, QueueName.Export, QueueName.Metrics, QueueName.OrderIngestion,
]).has(name));

export const schedulerOwners = {
  workflowNodeScheduler: QueueName.WorkflowNode,
  workflowAttentionScheduler: null,
  orderLineAttentionScheduler: null,
  businessFollowupScheduler: null,
  materialCommandRetentionScheduler: null,
  incomingCommandRetentionScheduler: null,
  procurementCommandRetentionScheduler: null,
  financeCommandRetentionScheduler: null,
  advertisingCommandRetentionScheduler: null,
  factoryErpSourceRetentionScheduler: null,
  captureMediaScheduler: QueueName.Media,
  aiAssistScheduler: QueueName.AiAssist,
  agentLoopScheduler: QueueName.AgentLoop,
  agentPlanScheduler: QueueName.AgentPlan,
  knowledgeMaintenanceScheduler: QueueName.KnowledgeMaintenance,
  productionRenderDispatcher: QueueName.ProductionEditorRender,
  orderDesignDispatcher: QueueName.OrderDesign,
  podArtworkScheduler: QueueName.PodArtwork,
  creativeDesignScheduler: QueueName.CreativeDesign,
  creativeAdaptationScheduler: QueueName.CreativeDesignAdaptation,
  mockupCompileScheduler: QueueName.MockupTemplateCompile,
  mockupRenderScheduler: QueueName.MockupRender,
  studioGenerationScheduler: QueueName.StudioGeneration,
} as const;
export type WorkerSchedulerName = keyof typeof schedulerOwners;
export interface WorkerRuntimePlan { queues: ReadonlySet<QueueNameValue>; schedulers: ReadonlySet<WorkerSchedulerName> }
export class WorkerSelectionError extends Error {
  constructor() { super("WORKER_RUNTIME_SELECTION_INVALID"); this.name = "WorkerSelectionError"; }
}

function selection(value: string | undefined, allowed: readonly string[], fallback: readonly string[]) {
  if (value === undefined || value === "all") return new Set(value === "all" ? allowed : fallback);
  if (value === "none") return new Set<string>();
  const names = value.split(",").map(name => name.trim());
  if (!names.length || new Set(names).size !== names.length || names.some(name => !name || !allowed.includes(name))) throw new WorkerSelectionError();
  return new Set(names);
}

/** Process capabilities only: job authorization and provider approval stay with owners. */
export function resolveWorkerRuntimePlan(
  environment: Readonly<NodeJS.ProcessEnv>,
  availableQueues: readonly QueueNameValue[],
): WorkerRuntimePlan {
  if (new Set(availableQueues).size !== availableQueues.length || availableQueues.some(name => !runtimeQueues.includes(name))) throw new WorkerSelectionError();
  const available = new Set(availableQueues), requested = selection(environment.WORKER_QUEUES, runtimeQueues, availableQueues);
  // Explicit all has the same optional-capability behavior as the legacy default.
  const queues = new Set([...requested].filter(name => available.has(name as QueueNameValue)) as QueueNameValue[]);
  if (environment.WORKER_QUEUES !== undefined && environment.WORKER_QUEUES !== "all" && queues.size !== requested.size) throw new WorkerSelectionError();
  const names = Object.keys(schedulerOwners) as WorkerSchedulerName[];
  const eligible = names.filter(name => schedulerOwners[name] === null || queues.has(schedulerOwners[name]!));
  const full = environment.WORKER_QUEUES === undefined || environment.WORKER_QUEUES === "all";
  const defaults = eligible.filter(name => full || schedulerOwners[name] !== null);
  const schedulers = selection(environment.WORKER_SCHEDULERS, eligible, defaults);
  // Unknown names and a dispatcher without its own consumer never widen the plan.
  if ([...schedulers].some(name => !names.includes(name as WorkerSchedulerName))) throw new WorkerSelectionError();
  if (!queues.size && !schedulers.size) throw new WorkerSelectionError();
  return { queues, schedulers: schedulers as Set<WorkerSchedulerName> };
}
