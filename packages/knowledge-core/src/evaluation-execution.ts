import { authorize, ForbiddenError, intersectPermissionContexts, permissionScope, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { KnowledgeEvaluationAssessmentSchema, KnowledgeEvaluationProtocolSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
import { aiAssistRuns, knowledgeEvaluationRuns, knowledgeEvaluationProtocols, knowledgeEvaluationAssessments, loadCurrentMembershipContext, type TenantTransaction } from "@yummyai/database";
import { eq } from "drizzle-orm";

export async function currentEvaluationContext(tx: TenantTransaction, ceiling: TenantContext, operation: "read" | "run" | "review" | "manage" = "read") {
  const current = intersectPermissionContexts(ceiling, await loadCurrentMembershipContext(tx, ceiling, { lock: true }));
  authorize(current, Permission.WorkflowRead);
  if (operation === "run") {
    authorize(current, Permission.WorkflowManage);
    authorize(current, Permission.WorkflowRun);
  }
  if (operation === "review") authorize(current, Permission.WorkflowApprove);
  if (operation === "manage") authorize(current, Permission.WorkflowManage);
  return current;
}

export function assertEvaluationScope(context: TenantContext, scope: TenantContext["dataScope"], operation: "read" | "run" | "review", hasProducts = false) {
  const required = [Permission.WorkflowRead, ...(operation === "run" ? [Permission.WorkflowManage, Permission.WorkflowRun] : []),
    ...(operation === "review" ? [Permission.WorkflowApprove] : []), ...(hasProducts ? [Permission.ProductRead] : [])];
  const rank = { self: 0, team: 1, tenant: 2 };
  for (const bit of required) {
    authorize(context, bit);
    if (rank[permissionScope(context, bit)] < rank[scope]) throw new ForbiddenError(bit, "outside_data_scope");
  }
}

export function evaluationDataScope(context: TenantContext, hasProducts = false): TenantContext["dataScope"] {
  const bits = [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowRun, ...(hasProducts ? [Permission.ProductRead] : [])];
  const scopes = bits.map(bit => permissionScope(context, bit));
  return scopes.includes("self") ? "self" : scopes.includes("team") ? "team" : "tenant";
}

/** Load only through the caller's withTenant transaction. No legacy backfill. */
export async function loadKnowledgeEvaluationExecution(tx: TenantTransaction, id: string) {
  const [row] = await tx.select({ run: knowledgeEvaluationRuns, native: aiAssistRuns,
    protocol: knowledgeEvaluationProtocols, assessment: knowledgeEvaluationAssessments })
    .from(knowledgeEvaluationRuns)
    .innerJoin(aiAssistRuns, eq(aiAssistRuns.id, knowledgeEvaluationRuns.assistRunId))
    .leftJoin(knowledgeEvaluationProtocols, eq(knowledgeEvaluationProtocols.runId, knowledgeEvaluationRuns.id))
    .leftJoin(knowledgeEvaluationAssessments, eq(knowledgeEvaluationAssessments.runId, knowledgeEvaluationRuns.id))
    .where(eq(knowledgeEvaluationRuns.id, id));
  if (!row) return null;
  return {
    ...row,
    protocolView: row.protocol ? KnowledgeEvaluationProtocolSchema.parse({
      version: "knowledge-evaluation-v1", runId: row.protocol.runId,
      caseRevision: row.protocol.caseRevision, caseChecksum: row.protocol.caseChecksum,
      requestChecksum: row.protocol.requestChecksum, basisFingerprint: row.protocol.basisFingerprint,
      inputFingerprint: row.protocol.inputFingerprint, modelId: row.protocol.modelId, dataScope: row.protocol.dataScope,
      promptVersion: row.protocol.promptVersion, assertionVersion: row.protocol.assertionVersion,
      createdAt: row.protocol.createdAt.toISOString(),
    }) : null,
    assessmentView: row.assessment ? KnowledgeEvaluationAssessmentSchema.parse({
      id: row.assessment.id, runId: row.assessment.runId, basisFingerprint: row.assessment.basisFingerprint,
      outputChecksum: row.assessment.outputChecksum, assertionVersion: row.assessment.assertionVersion,
      retrievalRecall: row.assessment.retrievalRecall, citedRecall: row.assessment.citedRecall,
      checks: row.assessment.checks, createdAt: row.assessment.createdAt.toISOString(),
    }) : null,
  };
}
export type KnowledgeEvaluationExecution = NonNullable<Awaited<ReturnType<typeof loadKnowledgeEvaluationExecution>>>;
