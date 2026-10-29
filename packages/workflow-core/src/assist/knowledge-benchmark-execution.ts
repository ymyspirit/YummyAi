import { BenchmarkProofError, assistTaskFingerprint, gradeBenchmark, isBenchmarkAssist, knowledgeEvaluationBasis, knowledgeEvaluationChecksum, openBenchmarkValue, sealBenchmarkValue, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { AssistResult } from "@yummyai/contracts/ai/assist";
import { BENCHMARK_GRADER_VERSION, BenchmarkAssessmentSchema } from "@yummyai/contracts/knowledge/benchmark";
import { knowledgeBenchmarkAttempts as attempts, knowledgeBenchmarkItems as items, knowledgeBenchmarkExperiments as experiments,
 knowledgeBenchmarkVersions as versions, knowledgeBenchmarkAssessments as assessments, knowledgeEvaluationCases as cases,
 knowledgeGovernanceEvents as events, readModelExecutionRouteFingerprint, type aiAssistRuns, type TenantTransaction } from "@yummyai/database";
import type { KnowledgeEvaluationExecution } from "@yummyai/knowledge-core";
import { eq } from "drizzle-orm";

export async function assertBenchmarkEvaluationExecution(tx:TenantTransaction,context:TenantContext,native:typeof aiAssistRuns.$inferSelect,input:AssistContext,vault:SecretVault,receipt:KnowledgeEvaluationExecution){
 const [row]=await tx.select({attempt:attempts,item:items,experiment:experiments,version:versions}).from(attempts)
  .innerJoin(items,eq(items.id,attempts.itemId)).innerJoin(experiments,eq(experiments.id,attempts.experimentId))
  .innerJoin(versions,eq(versions.id,experiments.datasetVersionId)).where(eq(attempts.evaluationRunId,receipt.run.id));
 if(!row){
  const [original]=await tx.select({marker:cases.benchmarkVersionId}).from(cases).where(eq(cases.id,receipt.run.caseId));
  if(original?.marker||isBenchmarkAssist(input))throw new BenchmarkProofError();
  return null;
 }
 const {attempt,item,experiment,version}=row;
 if(item.fields.role!=="knowledge_answer")throw new BenchmarkProofError();
 if(!isBenchmarkAssist(input)||attempt.createdBy!==context.userId||item.createdBy!==context.userId||version.createdBy!==context.userId||experiment.createdBy!==context.userId||
  attempt.arm!=="candidate"||attempt.requestId!==native.requestId||attempt.itemId!==item.id||item.versionId!==version.id||experiment.datasetVersionId!==version.id||
  item.caseId!==receipt.run.caseId||experiment.modelId!==native.modelSnapshot.id||experiment.dataScope!==input.accessPolicy?.dataScope||
  receipt.protocolView?.basisFingerprint!==item.basisFingerprint||knowledgeEvaluationChecksum(item.fields.evaluation)!==item.caseChecksum||
  assistTaskFingerprint(input)!==item.taskFingerprint||knowledgeEvaluationBasis(receipt.run.caseSnapshot,input,native.promptVersion)!==item.basisFingerprint||
  version.checksum!==knowledgeEvaluationChecksum(version.manifest)||!item.encryptedBasis||item.expiresAt<=new Date()||
  await readModelExecutionRouteFingerprint(tx,experiment.modelId)!==experiment.routeFingerprint)throw new BenchmarkProofError();
 const original=openBenchmarkValue<{tenantId:string;createdBy:string;itemId:string;versionId:string;caseId:string;caseChecksum:string;basisFingerprint:string;taskFingerprint:string;expiresAt:string;prepared:AssistContext}>(vault,"basis",item.encryptedBasis);
 if(original.tenantId!==context.tenantId||original.createdBy!==context.userId||original.itemId!==item.id||original.versionId!==version.id||original.caseId!==item.caseId||
  original.caseChecksum!==item.caseChecksum||original.basisFingerprint!==item.basisFingerprint||original.taskFingerprint!==item.taskFingerprint||
  original.expiresAt!==item.expiresAt.toISOString()||assistTaskFingerprint(original.prepared)!==item.taskFingerprint)throw new BenchmarkProofError();
 return row;
}

/** Native response adoption and benchmark grading commit together. Reads never score. */
export async function completeBenchmarkEvaluationExecution(tx:TenantTransaction,context:TenantContext,native:typeof aiAssistRuns.$inferSelect,input:AssistContext,result:AssistResult,vault:SecretVault,receipt:KnowledgeEvaluationExecution){
 const row=await assertBenchmarkEvaluationExecution(tx,context,native,input,vault,receipt);if(!row)return;
 if(row.item.fields.role!=="knowledge_answer")throw new BenchmarkProofError();
 const assessment=BenchmarkAssessmentSchema.parse({id:createEntityId(),attemptId:row.attempt.id,graderVersion:BENCHMARK_GRADER_VERSION,
  caseChecksum:row.item.caseChecksum,basisFingerprint:row.item.basisFingerprint,outputChecksum:knowledgeEvaluationChecksum(result),
  ...gradeBenchmark(row.item.fields,result,input.knowledge??[]),createdAt:new Date().toISOString()});
 await tx.insert(assessments).values({...assessment,tenantId:context.tenantId,createdBy:context.userId,createdAt:new Date(assessment.createdAt),creationTransactionId:"0",
  expiresAt:row.item.expiresAt,encryptedOutput:null,proof:sealBenchmarkValue(vault,"assessment",{tenantId:context.tenantId,createdBy:context.userId,assessment})});
 await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,resourceId:row.attempt.id,action:"benchmark.assessment",
  reason:"按原固定样本与注册评分方法封存结构化硬检查",detail:{assessmentId:assessment.id,outputChecksum:assessment.outputChecksum}});
}
