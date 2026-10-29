import { normalizeModelTokenUsage, summarizeModelUsage } from "@yummyai/ai-core";
import type { AssistKind } from "@yummyai/contracts/ai/assist";
import { aiAssistRuns as runs, aiAssistExecutions as executions, type TenantTransaction } from "@yummyai/database";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

/** Financial metadata only, within the caller's already authorized owner/scope boundary. */
export async function readAssistUsageSummary(tx: TenantTransaction, ownerId: string, kind: AssistKind, scope: string, benchmarkItemId: string | null = null) {
  const rows = await tx.select({ tokenUsage: runs.tokenUsage, inputTokens: runs.inputTokens, outputTokens: runs.outputTokens })
    .from(runs).leftJoin(executions, and(eq(executions.runId, runs.id), eq(executions.tenantId, runs.tenantId)))
    .where(and(eq(runs.ownerId, ownerId), eq(runs.kind, kind), eq(runs.scope, scope),
      benchmarkItemId === null ? isNull(runs.benchmarkItemId) : eq(runs.benchmarkItemId, benchmarkItemId),
      or(isNotNull(executions.submittedAt), and(isNull(executions.runId), or(isNotNull(runs.tokenUsage), isNotNull(runs.inputTokens), isNotNull(runs.outputTokens), isNotNull(runs.costUsd))))));
  // Legacy actual scalar counts can be read without rewriting their null JSON receipt.
  return summarizeModelUsage(rows.map(row => row.tokenUsage ?? normalizeModelTokenUsage({ input_tokens: row.inputTokens, output_tokens: row.outputTokens })), "assist_scope");
}
