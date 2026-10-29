import { authenticateKnowledgeEvaluation, KnowledgeEvaluationProofError, knowledgeEvaluationChecksum, knowledgeEvaluationAssessmentChecksum, scoreKnowledgeEvaluation, sealKnowledgeEvaluationAssessment, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { KnowledgeEvaluationAssessmentSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
import type { AssistResult } from "@yummyai/contracts/ai/assist";
import { knowledgeEvaluationRuns, knowledgeEvaluationAssessments, knowledgeGovernanceEvents, type aiAssistRuns, type TenantTransaction } from "@yummyai/database";
import { assertEvaluationScope, currentEvaluationContext, loadKnowledgeEvaluationExecution } from "@yummyai/knowledge-core";
import { eq } from "drizzle-orm";
import { assertBenchmarkEvaluationExecution, completeBenchmarkEvaluationExecution } from "./knowledge-benchmark-execution.js";

export async function assertEvaluationExecution(tx: TenantTransaction, context: TenantContext, native: typeof aiAssistRuns.$inferSelect, input: AssistContext, vault: SecretVault) {
  if (input.request.kind !== "knowledge_answer" || input.request.purpose !== "evaluation") return null;
  // Queue envelopes carry identity, not grants. The authenticated original
  // Assist policy is the execution ceiling; current membership is still required.
  const policy = input.accessPolicy;
  if (!policy?.dataScope) throw new KnowledgeEvaluationProofError();
  const current = await currentEvaluationContext(tx, { tenantId: context.tenantId, userId: context.userId,
    permissions: policy.requiredPermissions, dataScope: policy.dataScope }, "run");
  const [row] = await tx.select({ id: knowledgeEvaluationRuns.id }).from(knowledgeEvaluationRuns).where(eq(knowledgeEvaluationRuns.assistRunId, native.id));
  const receipt = row ? await loadKnowledgeEvaluationExecution(tx, row.id) : null;
  if (!receipt || receipt.run.createdBy !== current.userId || (!receipt.protocolView && native.creationTransactionId !== null)) throw new KnowledgeEvaluationProofError();
  authenticateKnowledgeEvaluation(vault, receipt, input);
  assertEvaluationScope(current, receipt.protocolView?.dataScope ?? input.accessPolicy?.dataScope ?? "tenant", "run", !!receipt.run.caseSnapshot.search.spuIds.length);
  await assertBenchmarkEvaluationExecution(tx, current, native, input, vault, receipt);
  return receipt;
}

/** Called only inside the native successful result-adoption transaction. */
export async function completeEvaluationExecution(tx: TenantTransaction, context: TenantContext, native: typeof aiAssistRuns.$inferSelect, input: AssistContext, result: AssistResult, vault: SecretVault) {
  const receipt = await assertEvaluationExecution(tx, context, native, input, vault);
  if (!receipt?.protocolView) return; // Original legacy runs remain explicitly unrecorded.
  if (receipt.assessmentView) throw new KnowledgeEvaluationProofError();
  const assessment = KnowledgeEvaluationAssessmentSchema.parse({
    id: createEntityId(), runId: receipt.run.id, basisFingerprint: receipt.protocolView.basisFingerprint,
    outputChecksum: knowledgeEvaluationChecksum(result), assertionVersion: receipt.protocolView.assertionVersion,
    ...scoreKnowledgeEvaluation(receipt.run.caseSnapshot, { status: "completed", knowledge: input.knowledge ?? [], result, error: null }),
    createdAt: new Date().toISOString(),
  });
  const resultChecksum = knowledgeEvaluationAssessmentChecksum(assessment);
  await tx.insert(knowledgeEvaluationAssessments).values({ ...assessment, tenantId: context.tenantId, createdBy: receipt.run.createdBy,
    createdAt: new Date(assessment.createdAt), creationTransactionId: "0", resultChecksum,
    proof: sealKnowledgeEvaluationAssessment(vault, { tenantId: context.tenantId, createdBy: receipt.run.createdBy, resultChecksum, assessment }),
  });
  await tx.insert(knowledgeGovernanceEvents).values({ id: createEntityId(), tenantId: context.tenantId, resourceId: receipt.run.id,
    action: "evaluation.assessed", reason: "按原执行协议封存确定性检查，仍需独立事实性人工核验", createdBy: receipt.run.createdBy,
    detail: { assessmentId: assessment.id, outputChecksum: assessment.outputChecksum, resultChecksum },
  });
  await completeBenchmarkEvaluationExecution(tx, context, native, input, result, vault, receipt);
}
