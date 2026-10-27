import { assistPromptVersion, BenchmarkProofError, assistFingerprint, assistTaskFingerprint, businessBenchmarkBasisFingerprint,
 businessBenchmarkCaseChecksum, businessBenchmarkSourcePins, gradeBusinessBenchmark, knowledgeEvaluationChecksum, openBenchmarkValue,
 sealBenchmarkValue, gradeRoleBenchmark, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import { authorize, authorizeAssistRequest, intersectPermissionContexts, permissionScope, Permission, requiredAssistRequestPermissions,
 assertBusinessBenchmarkScope, benchmarkDomainMinimumScope, requiredAssistPermissions, type PermissionValue } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { AssistResult } from "@yummyai/contracts/ai/assist";
import { ROLE_BENCHMARK_GRADER_VERSION, BenchmarkAssessmentSchema, BusinessBenchmarkRoleSchema, BenchmarkResourceBindingsSchema,
 LEGACY_BUSINESS_BENCHMARK_ROLES, benchmarkExecutionVersions, type BusinessBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { knowledgeBenchmarkAttempts as attempts, knowledgeBenchmarkItems as items, knowledgeBenchmarkVersions as versions,
 knowledgeBenchmarkExperiments as experiments, knowledgeBenchmarkAssessments as assessments, knowledgeGovernanceEvents as events,
 loadCurrentMembershipContext, readModelExecutionRouteFingerprint, assertBusinessBenchmarkResources, type aiAssistRuns, type TenantTransaction } from "@yummyai/database";
import { eq } from "drizzle-orm";

export async function assertBusinessBenchmarkExecution(tx:TenantTransaction,ceiling:TenantContext,native:typeof aiAssistRuns.$inferSelect,input:AssistContext,vault:SecretVault){
 const [row]=await tx.select({attempt:attempts,item:items,version:versions,experiment:experiments}).from(attempts)
  .innerJoin(items,eq(items.id,attempts.itemId)).innerJoin(versions,eq(versions.id,items.versionId))
  .innerJoin(experiments,eq(experiments.id,attempts.experimentId)).where(eq(attempts.nativeRunId,native.id));
 if(!native.benchmarkItemId){if(row)throw new BenchmarkProofError();return null;}
 if(!row)throw new BenchmarkProofError();
 const {attempt,item,version,experiment}=row;
 const role=BusinessBenchmarkRoleSchema.safeParse(input.request.kind);if(!role.success)throw new BenchmarkProofError();
 const legacy=LEGACY_BUSINESS_BENCHMARK_ROLES.some(value=>value===role.data);
 const parsed=legacy?null:BenchmarkResourceBindingsSchema.safeParse(input.benchmarkResources);
 if(parsed&&!parsed.success)throw new BenchmarkProofError();
 const bindings=parsed?.success?parsed.data:undefined;
 const domain=requiredAssistPermissions(role.data,"read");
 const policy=input.accessPolicy;if(!policy?.dataScope)throw new BenchmarkProofError();
 const policyScope=policy.dataScope;
 // The queue carries identity only. Derive the ceiling from the authenticated
 // original packet and published experiment, then intersect current grants.
 const knownPermissions=new Set<string>(Object.values(Permission));
 const pinnedPermissions=Object.keys(bindings?.permissionScopes??{});
 if([...pinnedPermissions,...policy.requiredPermissions].some(bit=>!knownPermissions.has(bit)))throw new BenchmarkProofError();
 const permissions=[...new Set([...policy.requiredPermissions,Permission.WorkflowRead,Permission.WorkflowManage,Permission.WorkflowRun,
  ...pinnedPermissions])] as PermissionValue[];
 const originalScopes:NonNullable<TenantContext["permissionScopes"]>={};
 for(const bit of permissions){
  const original=bindings?.permissionScopes[bit]??(legacy?(benchmarkDomainMinimumScope(role.data,bit)==="tenant"?"tenant":policyScope):undefined);
  if(!original)throw new BenchmarkProofError();originalScopes[bit]=original;
 }
 const context=intersectPermissionContexts({tenantId:ceiling.tenantId,userId:ceiling.userId,permissions,dataScope:experiment.dataScope,teamIds:bindings?.teamIds,
  permissionScopes:originalScopes},await loadCurrentMembershipContext(tx,ceiling,{lock:true}));
 const rank={self:0,team:1,tenant:2};
 assertBusinessBenchmarkScope(context,experiment.dataScope,role.data);
 for(const permission of domain)authorize(context,permission);
 for(const permission of [Permission.WorkflowRead,Permission.WorkflowManage,Permission.WorkflowRun,
   ...requiredAssistRequestPermissions(input.request,"run",{hasKnowledge:!!input.knowledge?.length||input.methodSelection?.mode==="published"})]){
  authorize(context,permission);
  const workflow=permission===Permission.WorkflowRead||permission===Permission.WorkflowManage||permission===Permission.WorkflowRun;
  if((legacy||workflow)&&rank[permissionScope(context,permission)]<rank[experiment.dataScope])throw new BenchmarkProofError();
 }
 await assertBusinessBenchmarkResources(tx,context,[input.request as BusinessBenchmarkCase["task"]],bindings,"run");
 authorizeAssistRequest(context,input.request,"run",{hasKnowledge:!!input.knowledge?.length||input.methodSelection?.mode==="published",pinnedDataScope:experiment.dataScope});
 const manifest=version.manifest.fields as {items?:Array<{role:BusinessBenchmarkCase["role"]|"knowledge_answer"}>}|undefined;
 if(!manifest?.items?.length)throw new BenchmarkProofError();const family=benchmarkExecutionVersions(manifest.items.map(value=>value.role));
 if(experiment.baselineVersion!==family.baselineVersion||experiment.graderVersion!==family.graderVersion)throw new BenchmarkProofError();
 if(item.fields.role==="knowledge_answer"||item.caseId!==null||attempt.evaluationRunId!==null||attempt.arm!=="candidate"||
  item.id!==native.benchmarkItemId||item.fields.role!==native.kind||input.request.kind!==native.kind||input.benchmarkExecutionVersion||
  [attempt.createdBy,item.createdBy,version.createdBy,experiment.createdBy,native.ownerId].some(id=>id!==context.userId)||
  attempt.requestId!==native.requestId||input.request.requestId!==native.requestId||input.request.modelId!==experiment.modelId||
  version.id!==experiment.datasetVersionId||version.checksum!==knowledgeEvaluationChecksum(version.manifest)||
  experiment.modelId!==native.modelSnapshot.id||native.promptVersion!==assistPromptVersion(false,native.kind==="order_review")||
  native.inputFingerprint!==assistFingerprint(input)||!item.encryptedBasis||item.expiresAt<=new Date()||native.expiresAt>item.expiresAt||
  item.taskFingerprint!==assistTaskFingerprint(input)||item.caseChecksum!==businessBenchmarkCaseChecksum(item.fields)||
  item.basisFingerprint!==businessBenchmarkBasisFingerprint(item.fields,input)||
  knowledgeEvaluationChecksum(item.sourcePins)!==knowledgeEvaluationChecksum(businessBenchmarkSourcePins(input))||
  input.accessPolicy?.dataScope!==experiment.dataScope||!input.inputAuthority||
  await readModelExecutionRouteFingerprint(tx,experiment.modelId)!==experiment.routeFingerprint)throw new BenchmarkProofError();
 const original=openBenchmarkValue<{tenantId:string;createdBy:string;itemId:string;versionId:string;caseId:null;caseChecksum:string;basisFingerprint:string;taskFingerprint:string;expiresAt:string;prepared:AssistContext}>(vault,"basis",item.encryptedBasis);
 if(original.tenantId!==context.tenantId||original.createdBy!==context.userId||original.itemId!==item.id||original.versionId!==version.id||original.caseId!==null||
  original.caseChecksum!==item.caseChecksum||original.basisFingerprint!==item.basisFingerprint||original.taskFingerprint!==item.taskFingerprint||
  original.expiresAt!==item.expiresAt.toISOString()||businessBenchmarkBasisFingerprint(item.fields,original.prepared)!==item.basisFingerprint||
  knowledgeEvaluationChecksum(original.prepared.inputAuthority)!==knowledgeEvaluationChecksum(input.inputAuthority))throw new BenchmarkProofError();
 return {...row,context};
}

export async function completeBusinessBenchmarkExecution(tx:TenantTransaction,context:TenantContext,native:typeof aiAssistRuns.$inferSelect,input:AssistContext,result:AssistResult,vault:SecretVault,images:readonly {sourceId:string;dataUrl:string}[]=[]){
 const row=await assertBusinessBenchmarkExecution(tx,context,native,input,vault);if(!row)return;
 if(row.item.fields.role==="knowledge_answer")throw new BenchmarkProofError();
 const extended=row.experiment.graderVersion===ROLE_BENCHMARK_GRADER_VERSION;
 if(extended&&images.some(image=>!input.images.some(original=>original.sourceId===image.sourceId&&original.dataUrl===image.dataUrl)))throw new BenchmarkProofError();
 const assessment=BenchmarkAssessmentSchema.parse({id:createEntityId(),attemptId:row.attempt.id,graderVersion:row.experiment.graderVersion,
  caseChecksum:row.item.caseChecksum,basisFingerprint:row.item.basisFingerprint,outputChecksum:knowledgeEvaluationChecksum(result),
  ...(extended?gradeRoleBenchmark(row.item.fields,result,input,images.map(image=>image.sourceId)):gradeBusinessBenchmark(row.item.fields,result,input)),createdAt:new Date().toISOString()});
 await tx.insert(assessments).values({...assessment,tenantId:context.tenantId,createdBy:context.userId,createdAt:new Date(assessment.createdAt),creationTransactionId:"0",
  expiresAt:row.item.expiresAt,encryptedOutput:null,proof:sealBenchmarkValue(vault,"assessment",{tenantId:context.tenantId,createdBy:context.userId,assessment})});
 await tx.insert(events).values({id:createEntityId(),tenantId:context.tenantId,createdBy:context.userId,resourceId:row.attempt.id,action:"benchmark.assessment",
  reason:extended?"原生角色完成事务封存固定媒体与独立检查；业务事实、视觉与采用条件仍须人工核对":"原采购或经营任务完成事务封存独立文本与缺项检查；原ERP事实仍须人工核对",detail:{assessmentId:assessment.id,outputChecksum:assessment.outputChecksum}});
}
