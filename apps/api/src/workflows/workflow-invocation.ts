import {
  HarnessInvocationViewSchema,
  type HarnessInvocationView,
} from "@yummyai/contracts/harness";
import type { WorkflowExecutionSnapshot } from "@yummyai/contracts/workflow/execution";
import type { workflowNodeAttempts } from "@yummyai/database";

export function workflowInvocationView(
  attempt: typeof workflowNodeAttempts.$inferSelect,
  snapshot: WorkflowExecutionSnapshot | null,
  receipt: { id: string; outputChecksum: string; createdAt: string } | null,
  delegated: boolean,
  ownerUnavailable: boolean,
): HarnessInvocationView {
  const contract = snapshot?.executionContract;
  return HarnessInvocationViewSchema.parse({
    version: "harness-invocation-v1",
    owner: "workflow",
    id: attempt.id,
    requestId: snapshot
      ? snapshot.input.kind === "catalog"
        ? snapshot.input.value.operationId
        : snapshot.input.value.input.idempotencyKey
      : null,
    parentId: null,
    method: contract?.skill ?? null,
    tool: contract?.tools[0] ?? null,
    state: attempt.status,
    boundary: receipt
      ? "owner_receipt"
      : delegated
        ? "delegated_task"
        : snapshot
          ? "not_submitted"
          : "legacy_missing",
    dispatches: attempt.dispatchCount,
    processingAttempts: attempt.startedAt ? attempt.recoveryCount + 1 : 0,
    submittedAt: null,
    receivedAt: receipt?.createdAt ?? null,
    startedAt: attempt.startedAt?.toISOString() ?? null,
    finishedAt: attempt.finishedAt?.toISOString() ?? null,
    providerRequestId: null,
    responseChecksum: receipt?.outputChecksum ?? null,
    model: null,
    artifact: receipt
      ? { kind: "owner_receipt", id: receipt.id, checksum: receipt.outputChecksum }
      : null,
    usage: { inputTokens: null, outputTokens: null },
    billing: {
      basis: "not_applicable",
      amountUsd: null,
      budgetState: null,
      budgetAmountUsd: null,
      needsProviderEvidence: false,
    },
    issues: [
      ...(!snapshot ? ["legacy_execution_missing"] : []),
      ...(!contract ? ["execution_contract_unavailable"] : []),
      ...(ownerUnavailable ? ["linked_owner_unavailable"] : []),
      ...(attempt.status === "completed" && !receipt && !delegated ? ["receipt_unavailable"] : []),
    ],
  });
}
