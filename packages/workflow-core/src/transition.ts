import type {
  TenantContext,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRunStatus,
} from "@yummyai/contracts";
import { workflowNodeRuns, workflowNodeAttempts, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { WorkflowExecutionError } from "./errors.js";

export function nextWorkflowNodeId(
  graph: WorkflowGraph,
  nodeId: string,
  parameters: Record<string, unknown>,
) {
  const node = graph.nodes.find((item) => item.id === nodeId);
  const outgoing = graph.edges.filter((edge) => edge.source === nodeId && edge.kind !== "rework");
  if (node?.kind === "condition_gate") {
    const conditionValue =
      typeof parameters.conditionValue === "string" ? parameters.conditionValue : undefined;
    return (
      outgoing.find((edge) => edge.kind === "condition" && edge.conditionValue === conditionValue)
        ?.target ?? outgoing.find((edge) => edge.kind === "default")?.target
    );
  }
  return outgoing.find((edge) => edge.kind === "success")?.target ?? outgoing[0]?.target;
}

export async function cancelWorkflowAttempts(tx: TenantTransaction, runId: string) {
  await tx
    .update(workflowNodeRuns)
    .set({ attentionNextAt: null })
    .where(eq(workflowNodeRuns.runId, runId));
  await tx
    .update(workflowNodeAttempts)
    .set({
      status: "cancelled",
      leaseToken: null,
      leaseExpiresAt: null,
      finishedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        inArray(
          workflowNodeAttempts.nodeRunId,
          tx
            .select({ id: workflowNodeRuns.id })
            .from(workflowNodeRuns)
            .where(eq(workflowNodeRuns.runId, runId)),
        ),
        inArray(workflowNodeAttempts.status, ["queued", "running", "waiting"]),
      ),
    );
}
export async function pauseWorkflowAttempts(tx: TenantTransaction, runId: string) {
  await tx
    .update(workflowNodeAttempts)
    .set({ status: "queued", leaseToken: null, leaseExpiresAt: null, lastDispatchedAt: null })
    .where(
      and(
        inArray(
          workflowNodeAttempts.nodeRunId,
          tx
            .select({ id: workflowNodeRuns.id })
            .from(workflowNodeRuns)
            .where(eq(workflowNodeRuns.runId, runId)),
        ),
        inArray(workflowNodeAttempts.status, ["queued", "running", "waiting"]),
      ),
    );
}

// Callers authorize the decision and lock the run before invoking this primitive.
// The same transition is used by human commands and verified internal completions.
export async function completeWorkflowNode(
  tx: TenantTransaction,
  context: TenantContext,
  runId: string,
  graph: WorkflowGraph,
  node: WorkflowNode,
  nodeRun: typeof workflowNodeRuns.$inferSelect,
  input: {
    parameters: Record<string, unknown>;
    parameterSnapshot: Record<string, unknown>;
    note?: string;
  },
  now: Date,
) {
  if (nodeRun.runId !== runId || nodeRun.nodeId !== node.id || nodeRun.status !== "in_progress")
    throw new WorkflowExecutionError("WORKFLOW_NODE_STATE_CHANGED");
  const nextId = nextWorkflowNodeId(graph, node.id, input.parameters);
  const next = graph.nodes.find((item) => item.id === nextId);
  if (!next) throw new WorkflowExecutionError("WORKFLOW_NEXT_NODE_INVALID");
  await tx
    .update(workflowNodeRuns)
    .set({
      status: "completed",
      note: input.note ?? nodeRun.note,
      blockerReason: null,
      parameterSnapshot: input.parameterSnapshot,
      completedAt: now,
      attentionNextAt: null,
      startedAt: nodeRun.startedAt ?? now,
      updatedBy: context.userId,
      updatedAt: now,
    })
    .where(eq(workflowNodeRuns.id, nodeRun.id));
  if (node.kind === "condition_gate") {
    const selected = graph.edges.find((edge) => edge.source === node.id && edge.target === nextId);
    const others = graph.edges
      .filter(
        (edge) => edge.source === node.id && edge.kind !== "rework" && edge.id !== selected?.id,
      )
      .map((edge) => edge.target);
    if (others.length)
      await tx
        .update(workflowNodeRuns)
        .set({
          status: "skipped",
          attentionNextAt: null,
          updatedBy: context.userId,
          updatedAt: now,
        })
        .where(and(eq(workflowNodeRuns.runId, runId), inArray(workflowNodeRuns.nodeId, others)));
  }
  await tx
    .update(workflowNodeRuns)
    .set({
      status: next.kind === "end" ? "completed" : "in_progress",
      startedAt: now,
      ...(next.kind === "end" ? { completedAt: now } : {}),
      updatedBy: context.userId,
      updatedAt: now,
    })
    .where(and(eq(workflowNodeRuns.runId, runId), eq(workflowNodeRuns.nodeId, next.id)));
  return {
    nextRunStatus: (next.kind === "end" ? "completed" : "active") as WorkflowRunStatus,
    currentNodeId: next.kind === "end" ? null : next.id,
    activatedNode: next.kind === "internal_action" ? next : undefined,
  };
}

export function reopenedWorkflowAttention() {
  return {
    responsibilityRevision: sql<number>`case when ${workflowNodeRuns.responsibilityRevision}>0 then ${workflowNodeRuns.responsibilityRevision}+1 else 0 end`,
    assignmentNotifiedAt: null,
    dueNotifiedAt: null,
    escalationNotifiedAt: null,
    attentionLastError: null,
    attentionNextAt: sql<Date | null>`case when ${workflowNodeRuns.responsibilityRevision}>0 and ${workflowNodeRuns.assignedUserId} is not null then clock_timestamp() else null end`,
  };
}
