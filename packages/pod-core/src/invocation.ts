import {
  HarnessInvocationViewSchema,
  type HarnessInvocationView,
  type ModelBillingAcknowledgment,
} from "@yummyai/contracts/harness";
import type { podArtworkInvocations, podArtworkTasks } from "@yummyai/database";
import type { podArtworkExecutions } from "@yummyai/database";

export function podInvocationViews(
  task: Pick<typeof podArtworkTasks.$inferSelect,"id"|"status"|"attemptCount"|"startedAt"|"completedAt">,
  rows: Array<typeof podArtworkInvocations.$inferSelect>,
  reconciliations: ReadonlyMap<string,ModelBillingAcknowledgment> = new Map(),
  execution?: Pick<typeof podArtworkExecutions.$inferSelect, "phase" | "attemptCount" | "dispatchCount"> & Partial<Pick<typeof podArtworkExecutions.$inferSelect, "methodSnapshot">>,
): HarnessInvocationView[] {
  if (!rows.length)
    return [
      HarnessInvocationViewSchema.parse({
        version: "harness-invocation-v1",
        owner: "pod",
        id: task.id,
        requestId: task.id,
        parentId: null,
        method: execution?.methodSnapshot?.executionContract.skill ?? null,
        tool: execution?.methodSnapshot?.executionContract.tools[0] ?? null,
        state:
          task.status === "running"
            ? "running"
            : task.status === "queued"
              ? "queued"
              : task.status === "cancelled"
                ? "cancelled"
                : task.status === "failed" || task.status === "blocked"
                  ? "failed"
                  : "completed",
        boundary: execution ? "not_submitted" : "legacy_missing",
        dispatches: execution?.dispatchCount ?? null,
        processingAttempts: execution?.attemptCount ?? task.attemptCount,
        submittedAt: null,
        receivedAt: null,
        startedAt: task.startedAt?.toISOString() ?? null,
        finishedAt: task.completedAt?.toISOString() ?? null,
        providerRequestId: null,
        responseChecksum: null,
        model: null,
        artifact: null,
        usage: { inputTokens: null, outputTokens: null },
        billing: {
          basis: execution ? "not_submitted" : "unknown",
          amountUsd: null,
          budgetState: null,
          budgetAmountUsd: null,
          needsProviderEvidence: !execution,
        },
        issues: execution?.methodSnapshot ? [] : execution ? ["execution_contract_unavailable"] : ["legacy_execution_missing", "cost_unknown"],
      }),
    ];
  return rows.map((row) =>
    HarnessInvocationViewSchema.parse({
      version: "harness-invocation-v1",
      owner: "pod",
      id: row.id,
      requestId: task.id,
      parentId: null,
      method: execution?.methodSnapshot?.executionContract.skill ?? null,
      tool: execution?.methodSnapshot?.executionContract.tools[0] ?? null,
      state:
        row.phase === "pending"
          ? "running"
          : row.phase === "submitted" || row.phase === "received"
            ? "running"
            : row.phase,
      boundary: row.receivedAt ? "received" : row.submittedAt ? "submitted" : "not_submitted",
      dispatches: execution?.dispatchCount ?? null,
      processingAttempts: execution?.attemptCount ?? null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      receivedAt: row.receivedAt?.toISOString() ?? null,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      providerRequestId: row.providerRequestId,
      responseChecksum: row.responseChecksum,
      model: row.modelKey ? { key: row.modelKey, version: row.modelVersion } : null,
      artifact: row.resultVersionId
        ? { kind: "design_version", id: row.resultVersionId, checksum: null }
        : null,
      usage: { inputTokens: null, outputTokens: null },
      billing: {
        basis:
          row.reportedCostUsd !== null
            ? "processor_reported"
            : row.submittedAt
              ? "unknown"
              : "not_submitted",
        amountUsd: row.reportedCostUsd,
        budgetState: null,
        budgetAmountUsd: null,
        needsProviderEvidence: !!row.submittedAt && !reconciliations.has(row.id),
        reconciliation: reconciliations.get(row.id) ?? null,
      },
      issues: [
        ...(!execution?.methodSnapshot ? ["execution_contract_unavailable"] : []),
        ...(row.phase === "uncertain" ? ["submission_unknown"] : []),
        ...(row.reportedCostUsd === null && row.submittedAt ? ["cost_unknown"] : []),
        ...(row.metadataValid === false ? ["response_metadata_invalid"] : []),
      ],
    }),
  );
}
