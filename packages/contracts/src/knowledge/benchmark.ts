import { z } from "zod";
import { AssistModelSchema, AssistResultSchema, CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { KnowledgeEvaluationCaseSchema } from "@yummyai/contracts/knowledge/evaluation-case";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";
import { BenchmarkDecimalSchema } from "@yummyai/contracts/knowledge/benchmark-values";
import { BENCHMARK_OPERATIONS } from "@yummyai/contracts/knowledge/benchmark-command";
import { AssistTaskBasisRequestSchema, AssistTaskTargetQuerySchema } from "@yummyai/contracts/ai/task-workspace";
export { benchmarkCommandCanonical, BENCHMARK_OPERATIONS, type BenchmarkOperation } from "@yummyai/contracts/knowledge/benchmark-command";

const Id=z.uuidv7().transform(v=>v.toLowerCase()), RequestId=z.uuid().transform(v=>v.toLowerCase());
const Hash=z.string().regex(/^[a-f0-9]{64}$/), Reason=z.string().trim().min(1).max(1000);
const Scope=z.enum(["self","team","tenant"]);
export const BENCHMARK_RULE_VERSION="extractive-arithmetic-v1" as const;
export const BENCHMARK_GRADER_VERSION="knowledge-benchmark-checks-v1" as const;
export const BENCHMARK_COST_VERSION="all-attempts-latest-outcome-v1" as const;
export const BUSINESS_BENCHMARK_RULE_VERSION="business-facts-v1" as const;
export const BUSINESS_BENCHMARK_GRADER_VERSION="business-benchmark-checks-v1" as const;
export const ROLE_BENCHMARK_RULE_VERSION="role-facts-v1" as const;
export const ROLE_BENCHMARK_GRADER_VERSION="role-benchmark-checks-v1" as const;
export const LEGACY_BUSINESS_BENCHMARK_ROLES=["procurement_review","business_review"] as const;
export const BUSINESS_BENCHMARK_ROLES=[...LEGACY_BUSINESS_BENCHMARK_ROLES,"creative","order_review","artwork_preflight","template_config","sku_package","after_sales_review"] as const;
export const BusinessBenchmarkRoleSchema=z.enum(BUSINESS_BENCHMARK_ROLES);
export type BusinessBenchmarkRole=z.infer<typeof BusinessBenchmarkRoleSchema>;
export const BenchmarkResourceBindingSchema=z.object({
 kind:z.enum(["creative_project","research_item","research_snapshot","research_study","specification_version","artwork_version","order_line","order_attachment","editor_version","artwork_material","template_inspection","listing_version","sku_recipe","asset","sales_plan","after_sales_case"]),
 id:z.uuid().transform(value=>value.toLowerCase()),parentId:z.uuid().transform(value=>value.toLowerCase()).optional(),
 versionId:z.uuid().transform(value=>value.toLowerCase()).optional(),checksum:Hash.optional(),
}).strict();
export const BenchmarkResourceBindingsSchema=z.object({version:z.literal("role-benchmark-resources-v1"),items:z.array(BenchmarkResourceBindingSchema).min(1).max(512),
 permissionScopes:z.record(z.string().min(1).max(100),Scope),
 teamIds:z.array(Id).max(200),
}).strict().superRefine((value,context)=>{
 if(new Set(value.items.map(item=>`${item.kind}:${item.id}`)).size!==value.items.length)context.addIssue({code:"custom",message:"固定业务资源不能重复"});
 if(!Object.keys(value.permissionScopes).length||Object.keys(value.permissionScopes).length>64)context.addIssue({code:"custom",message:"原逐权限范围必须完整且有界"});
 if(new Set(value.teamIds).size!==value.teamIds.length)context.addIssue({code:"custom",message:"原团队范围不能重复"});
});
export type BenchmarkResourceBinding=z.infer<typeof BenchmarkResourceBindingSchema>;
export type BenchmarkResourceBindings=z.infer<typeof BenchmarkResourceBindingsSchema>;
export const BusinessBenchmarkTargetQuerySchema=AssistTaskTargetQuerySchema.extend({kind:BusinessBenchmarkRoleSchema}).strict();
export const BusinessBenchmarkBasisRequestSchema=AssistTaskBasisRequestSchema.extend({kind:BusinessBenchmarkRoleSchema,targetId:z.string().trim().min(1).max(80)}).strict();
export const BenchmarkUsdSchema=z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,8})?$/).transform(v=>{
 const [whole,fraction=""]=v.split(".");return whole+"."+fraction.padEnd(8,"0");
});
const TotalUsd=z.string().regex(/^(0|[1-9]\d{0,17})\.\d{8}$/);
export const BenchmarkMinutesSchema=z.string().regex(/^(0|[1-9]\d{0,5})(\.\d{1,3})?$/);
export const BenchmarkCalculationSchema=z.object({
 key:z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
 operator:z.enum(["sum","difference","product","quotient"]),
 operands:z.array(BenchmarkDecimalSchema).min(2).max(20),
 scale:z.int().min(0).max(8),unit:z.string().trim().min(1).max(40),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 expectedValue:BenchmarkDecimalSchema,
}).strict().superRefine((v,c)=>{if(v.operator==="quotient"&&v.operands.length!==2)c.addIssue({code:"custom",message:"除法固定两个操作数"});});
export const KnowledgeBenchmarkCaseSchema=z.object({
 key:z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
 role:z.literal("knowledge_answer"),
 evaluation:KnowledgeEvaluationCaseSchema,
 calculations:z.array(BenchmarkCalculationSchema).max(20),
}).strict().superRefine((v,c)=>{if(new Set(v.calculations.map(x=>x.key)).size!==v.calculations.length)c.addIssue({code:"custom",message:"数值答案标识不能重复"});});
export const BusinessBenchmarkCaseSchema=z.object({
 key:z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),role:BusinessBenchmarkRoleSchema,label:z.string().trim().min(1).max(180),
 task:z.union([
  CreateAssistSchema.options[6].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[7].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[1].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[2].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[3].omit({requestId:true,modelId:true,automaticAudit:true,retryAudit:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[4].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[5].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
  CreateAssistSchema.options[8].omit({requestId:true,modelId:true}).extend({expectedTaskFingerprint:Hash}),
 ]),
 expectedFacts:z.array(z.string().trim().min(1).max(500)).max(20),forbiddenClaims:z.array(z.string().trim().min(1).max(500)).max(20),expectRefusal:z.boolean(),
}).strict().superRefine((v,c)=>{if(v.task.kind!==v.role)c.addIssue({code:"custom",message:"业务角色必须与原任务一致"});});
export const BenchmarkCaseSchema=z.union([KnowledgeBenchmarkCaseSchema,BusinessBenchmarkCaseSchema]);
export const BenchmarkDatasetFieldsSchema=z.object({
 name:z.string().trim().min(1).max(180),description:z.string().trim().max(2000),items:z.array(BenchmarkCaseSchema).min(1).max(50),
}).strict().superRefine((v,c)=>{if(new Set(v.items.map(x=>x.key)).size!==v.items.length)c.addIssue({code:"custom",message:"样本标识不能重复"});if(v.items.some(x=>x.role==="knowledge_answer")&&v.items.some(x=>x.role!=="knowledge_answer"))c.addIssue({code:"custom",message:"知识和业务样本分别发布数据集"});});
export const SaveBenchmarkDatasetSchema=z.object({fields:BenchmarkDatasetFieldsSchema,expectedRevision:z.int().nonnegative(),reason:Reason,requestId:RequestId}).strict();
export const PublishBenchmarkDatasetSchema=z.object({expectedRevision:z.int().positive(),retentionDays:z.int().min(1).max(30),reason:Reason,requestId:RequestId}).strict();
export const BenchmarkDatasetSummarySchema=z.object({id:Id,revision:z.int().positive(),name:z.string().max(180),itemCount:z.int().min(1).max(50),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()}).strict();
export const BenchmarkDatasetSchema=BenchmarkDatasetSummarySchema.extend({fields:BenchmarkDatasetFieldsSchema}).strict();
export const BenchmarkSourcePinSchema=z.union([z.object({sourceId:z.string().max(180),entryId:Id,versionId:Id,version:z.int().positive(),checksum:Hash,title:z.string().max(500)}).strict(),z.object({sourceId:z.string().max(180),kind:z.literal("business"),resourceId:z.string().min(1).max(200),checksum:Hash,title:z.string().max(500),resourceBindings:BenchmarkResourceBindingsSchema.optional()}).strict()]);
export const BenchmarkVersionSummarySchema=z.object({id:Id,datasetId:Id,version:z.int().positive(),datasetRevision:z.int().positive(),name:z.string().max(180),checksum:Hash,
 itemCount:z.int().min(2).max(50),dataScope:Scope,createdAt:z.iso.datetime(),basisExpiresAt:z.iso.datetime()}).strict();
export const BenchmarkItemSchema=z.object({id:Id,versionId:Id,caseId:Id.nullable(),ordinal:z.int().min(0).max(49),fields:BenchmarkCaseSchema,
 caseChecksum:Hash,basisFingerprint:Hash,taskFingerprint:Hash,sourcePins:z.array(BenchmarkSourcePinSchema).max(256),
 method:AgentMethodSelectionSchema.nullable(),expiresAt:z.iso.datetime(),usable:z.boolean()}).strict().superRefine((v,c)=>{
 if(v.fields.role==="knowledge_answer"?v.caseId===null||v.sourcePins.length>6||v.sourcePins.some(p=>"kind" in p):v.caseId!==null||v.sourcePins.some(p=>!("kind" in p)))c.addIssue({code:"custom",message:"固定样本的原角色、协议及来源类型不一致"});
 if((v.fields.role==="procurement_review"||v.fields.role==="business_review")&&v.sourcePins.length>32)c.addIssue({code:"custom",message:"原业务v1来源上限保持32条"});
 const first=v.sourcePins[0];
 if(v.fields.role!=="knowledge_answer"&&!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role=>role===v.fields.role)&&
  (!first||!("kind" in first)||!first.resourceBindings))c.addIssue({code:"custom",message:"新业务角色须固定完整资源授权依据"});
});
export const BenchmarkVersionSchema=BenchmarkVersionSummarySchema.extend({description:z.string().max(2000).optional(),items:z.array(BenchmarkItemSchema).min(2).max(50)}).strict()
 .superRefine((v,c)=>{if(v.items.length!==v.itemCount||v.items.some((x,i)=>x.versionId!==v.id||x.ordinal!==i)||new Set(v.items.map(x=>x.id)).size!==v.itemCount)c.addIssue({code:"custom",message:"发布版本必须包含完整有序样本"});});
export const CreateBenchmarkExperimentSchema=z.object({datasetVersionId:Id,label:z.string().trim().min(1).max(180),baselineVersion:z.enum([BENCHMARK_RULE_VERSION,BUSINESS_BENCHMARK_RULE_VERSION,ROLE_BENCHMARK_RULE_VERSION]),
 modelId:Id,maxAttemptsPerItem:z.int().min(1).max(5),reason:Reason,requestId:RequestId}).strict();
export const BenchmarkExperimentSummarySchema=z.object({id:Id,datasetVersionId:Id,label:z.string().max(180),baselineVersion:z.enum([BENCHMARK_RULE_VERSION,BUSINESS_BENCHMARK_RULE_VERSION,ROLE_BENCHMARK_RULE_VERSION]),
 modelId:Id,model:AssistModelSchema,routeFingerprint:Hash,maxAttemptsPerItem:z.int().min(1).max(5),itemCount:z.int().min(2).max(50),dataScope:Scope,createdAt:z.iso.datetime()}).strict();
export const BenchmarkCheckSchema=z.object({key:z.string().min(1).max(120),label:z.string().max(200),status:z.enum(["pass","fail"]),detail:z.string().max(6500)}).strict();
export const BenchmarkAssessmentSchema=z.object({id:Id,attemptId:Id,graderVersion:z.enum([BENCHMARK_GRADER_VERSION,BUSINESS_BENCHMARK_GRADER_VERSION,ROLE_BENCHMARK_GRADER_VERSION]),caseChecksum:Hash,basisFingerprint:Hash,
 outputChecksum:Hash,hardPass:z.boolean(),checks:z.array(BenchmarkCheckSchema).min(7).max(50),createdAt:z.iso.datetime()}).strict()
 .superRefine((v,c)=>{if(v.hardPass!==v.checks.every(x=>x.status==="pass"))c.addIssue({code:"custom",message:"硬失败不可由合格标签覆盖"});});
export const ReviewBenchmarkAttemptSchema=z.object({expectedReviewId:Id.nullable(),decision:z.enum(["pass","fail","needs_review"]),minutes:BenchmarkMinutesSchema,
 hourlyUsd:BenchmarkUsdSchema.nullable(),reason:Reason,requestId:RequestId}).strict();
export const BenchmarkReviewSchema=ReviewBenchmarkAttemptSchema.omit({expectedReviewId:true,requestId:true}).extend({id:Id,attemptId:Id,previousId:Id.nullable(),sequence:z.int().positive(),createdAt:z.iso.datetime()}).strict();
export const BenchmarkModelCostSchema=z.object({amountUsd:BenchmarkUsdSchema.nullable(),source:z.enum(["not_submitted","usage_estimate","billing_acknowledged","unknown"]),
 billingReceiptId:Id.nullable(),localProcessingAttempts:z.int().nonnegative(),confirmedProviderCalls:z.int().nonnegative(),possibleProviderCalls:z.int().nonnegative()}).strict();
export const BenchmarkAttemptSchema=z.object({id:Id,experimentId:Id,itemId:Id,arm:z.enum(["baseline","candidate"]),ordinal:z.int().min(1).max(5),
 requestId:RequestId,evaluationRunId:Id.nullable(),nativeRunId:Id.nullable().optional(),createdAt:z.iso.datetime(),state:z.enum(["queued","running","completed","failed","cancelled","uncertain","unavailable"]),
 assessment:BenchmarkAssessmentSchema.nullable(),review:BenchmarkReviewSchema.nullable(),modelCost:BenchmarkModelCostSchema,resultAvailable:z.boolean(),result:AssistResultSchema.nullable()}).strict();
export const StartBenchmarkAttemptSchema=z.object({itemId:Id,expectedLatestAttemptId:Id.nullable(),confirmNewPaidAttempt:z.literal(true),requestId:RequestId}).strict();
export const BenchmarkCellSchema=z.object({itemId:Id,key:z.string().max(60),label:z.string().max(180),baselineAttemptId:Id,baselineHardPass:z.boolean(),
 latestAttemptId:Id.nullable(),latestAttemptOrdinal:z.int().min(0).max(5),state:z.enum(["not_started","queued","running","completed","failed","cancelled","uncertain","unavailable"]),
 hardPass:z.boolean().nullable(),qualified:z.boolean(),reviewDecision:z.enum(["pass","fail","needs_review"]).nullable()}).strict();
export const BenchmarkExperimentSchema=BenchmarkExperimentSummarySchema.extend({cells:z.array(BenchmarkCellSchema).min(2).max(50)}).strict()
 .superRefine((v,c)=>{if(v.cells.length!==v.itemCount||new Set(v.cells.map(x=>x.itemId)).size!==v.itemCount)c.addIssue({code:"custom",message:"实验分母必须覆盖原发布样本"});});
export const RecordBenchmarkExpenseSchema=z.object({arm:z.enum(["baseline","candidate"]),expectedExpenseId:Id.nullable(),storageUsd:BenchmarkUsdSchema.nullable(),
 maintenanceUsd:BenchmarkUsdSchema.nullable(),expectedActivityFingerprint:Hash,periodStart:z.iso.datetime(),periodEnd:z.iso.datetime(),allocationBasis:Reason,confirmedActual:z.literal(true),requestId:RequestId}).strict()
 .superRefine((v,c)=>{if(v.periodEnd<v.periodStart)c.addIssue({code:"custom",message:"成本分摊期间无效"});});
export const BenchmarkExpenseSchema=z.object({id:Id,experimentId:Id,arm:z.enum(["baseline","candidate"]),previousId:Id.nullable(),sequence:z.int().positive(),
 storageUsd:BenchmarkUsdSchema.nullable(),maintenanceUsd:BenchmarkUsdSchema.nullable(),activityFingerprint:Hash,periodStart:z.iso.datetime(),periodEnd:z.iso.datetime(),allocationBasis:Reason,createdAt:z.iso.datetime()}).strict();
export const BenchmarkArmCostSchema=z.object({arm:z.enum(["baseline","candidate"]),state:z.enum(["complete","estimated","incomplete"]),totalItems:z.int().min(2).max(50),
 activityFingerprint:Hash,
 allAttempts:z.int().nonnegative(),qualifiedItems:z.int().nonnegative(),notRunItems:z.int().nonnegative(),pendingReviewItems:z.int().nonnegative(),hardFailedItems:z.int().nonnegative(),
 confirmedProviderCalls:z.int().nonnegative(),possibleProviderCalls:z.int().nonnegative(),localProcessingAttempts:z.int().nonnegative(),reviewMinutes:z.string(),
 modelKnownUsd:TotalUsd,humanKnownUsd:TotalUsd,storageKnownUsd:TotalUsd,maintenanceKnownUsd:TotalUsd,knownSubtotalUsd:TotalUsd,
 totalUsd:TotalUsd.nullable(),unitQualifiedCostUsd:TotalUsd.nullable(),estimatedUnitQualifiedCostUsd:TotalUsd.nullable(),missing:z.array(z.string().max(500)).max(500)}).strict();
export const BenchmarkCostSummarySchema=z.object({experimentId:Id,currency:z.literal("USD"),policyVersion:z.literal(BENCHMARK_COST_VERSION),asOf:z.iso.datetime(),
 baseline:BenchmarkArmCostSchema,candidate:BenchmarkArmCostSchema,latestExpenses:z.array(BenchmarkExpenseSchema).max(2)}).strict();
export const CreateBenchmarkReportSchema=z.object({reason:Reason,requestId:RequestId}).strict();
export const BenchmarkReportSchema=z.object({id:Id,experimentId:Id,sequence:z.int().positive(),datasetVersionId:Id,datasetChecksum:Hash,manifestChecksum:Hash,
 baselineVersion:z.enum([BENCHMARK_RULE_VERSION,BUSINESS_BENCHMARK_RULE_VERSION,ROLE_BENCHMARK_RULE_VERSION]),graderVersion:z.enum([BENCHMARK_GRADER_VERSION,BUSINESS_BENCHMARK_GRADER_VERSION,ROLE_BENCHMARK_GRADER_VERSION]),createdAt:z.iso.datetime(),
 attemptIds:z.array(Id).max(300),assessmentIds:z.array(Id).max(300),reviewIds:z.array(Id).max(3000),expenseIds:z.array(Id).max(2),billingReceiptIds:z.array(Id).max(250),
 summary:BenchmarkCostSummarySchema}).strict();
export const BenchmarkReceiptSchema=z.object({id:Id,revision:z.int().positive()}).strict();
export const BenchmarkCommandReceiptSchema=z.object({requestId:RequestId,operation:z.enum(BENCHMARK_OPERATIONS),parentId:Id.nullable(),
 requestChecksum:Hash,receipt:BenchmarkReceiptSchema,createdAt:z.iso.datetime()}).strict();
export const BenchmarkPageQuerySchema=z.object({cursor:Id.optional(),limit:z.coerce.number().int().min(1).max(20).default(20)}).strict();
export const BenchmarkAttemptPageQuerySchema=BenchmarkPageQuerySchema.extend({itemId:Id.optional(),arm:z.enum(["baseline","candidate"]).optional()}).strict();
const page=<T extends z.ZodType>(item:T)=>z.object({items:z.array(item).max(20),nextCursor:Id.nullable(),total:z.int().nonnegative()}).strict();
export const BenchmarkDatasetPageSchema=page(BenchmarkDatasetSummarySchema),BenchmarkVersionPageSchema=page(BenchmarkVersionSummarySchema),
 BenchmarkExperimentPageSchema=page(BenchmarkExperimentSummarySchema),BenchmarkAttemptPageSchema=page(BenchmarkAttemptSchema),BenchmarkReportPageSchema=page(BenchmarkReportSchema);
export type BenchmarkCalculation=z.infer<typeof BenchmarkCalculationSchema>;
export type BenchmarkCase=z.infer<typeof BenchmarkCaseSchema>;
export type KnowledgeBenchmarkCase=z.infer<typeof KnowledgeBenchmarkCaseSchema>;
export type BusinessBenchmarkCase=z.infer<typeof BusinessBenchmarkCaseSchema>;
export const benchmarkCaseLabel=(fields:BenchmarkCase)=>fields.role==="knowledge_answer"?fields.evaluation.label:fields.label;
export const benchmarkCaseHasProducts=(fields:BenchmarkCase)=>fields.role==="knowledge_answer"&&fields.evaluation.search.spuIds.length>0;
export type BenchmarkDatasetFields=z.infer<typeof BenchmarkDatasetFieldsSchema>;
export type BenchmarkDataset=z.infer<typeof BenchmarkDatasetSchema>;
export type BenchmarkVersion=z.infer<typeof BenchmarkVersionSchema>;
export type BenchmarkItem=z.infer<typeof BenchmarkItemSchema>;
export type BenchmarkExperiment=z.infer<typeof BenchmarkExperimentSchema>;
export type BenchmarkExperimentSummary=z.infer<typeof BenchmarkExperimentSummarySchema>;
export type BenchmarkAttempt=z.infer<typeof BenchmarkAttemptSchema>;
export type BenchmarkAssessment=z.infer<typeof BenchmarkAssessmentSchema>;
export type BenchmarkReview=z.infer<typeof BenchmarkReviewSchema>;
export type BenchmarkExpense=z.infer<typeof BenchmarkExpenseSchema>;
export type BenchmarkArmCost=z.infer<typeof BenchmarkArmCostSchema>;
export type BenchmarkCostSummary=z.infer<typeof BenchmarkCostSummarySchema>;
export type BenchmarkReport=z.infer<typeof BenchmarkReportSchema>;
export function benchmarkExecutionVersions(roles:readonly BenchmarkCase["role"][]){
 if(roles.some(role=>role!=="knowledge_answer"&&!LEGACY_BUSINESS_BENCHMARK_ROLES.some(legacy=>legacy===role)))return {baselineVersion:ROLE_BENCHMARK_RULE_VERSION,graderVersion:ROLE_BENCHMARK_GRADER_VERSION};
 return roles[0]==="knowledge_answer"?{baselineVersion:BENCHMARK_RULE_VERSION,graderVersion:BENCHMARK_GRADER_VERSION}:{baselineVersion:BUSINESS_BENCHMARK_RULE_VERSION,graderVersion:BUSINESS_BENCHMARK_GRADER_VERSION};
}
