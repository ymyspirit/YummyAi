import { LegacyAssistResultSchema, type AssistResult } from "@yummyai/contracts/ai/assist";
import type { BusinessBenchmarkCase, BenchmarkAssessment, BenchmarkItem } from "@yummyai/contracts/knowledge/benchmark";
import { BenchmarkResourceBindingsSchema, BusinessBenchmarkRoleSchema, LEGACY_BUSINESS_BENCHMARK_ROLES } from "@yummyai/contracts/knowledge/benchmark";
import { assistScope, validateAssistResult, type AssistContext } from "./assist.js";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";
import { knowledgeEvaluationChecksum } from "./knowledge-evaluation.js";

export const businessBenchmarkCaseChecksum=(fields:BusinessBenchmarkCase)=>knowledgeEvaluationChecksum(fields);
export function businessBenchmarkBasisFingerprint(fields:BusinessBenchmarkCase,prepared:AssistContext){
 return knowledgeEvaluationChecksum({version:LEGACY_BUSINESS_BENCHMARK_ROLES.some(role=>role===fields.role)?"business-benchmark-basis-v1":"role-benchmark-basis-v1",caseChecksum:businessBenchmarkCaseChecksum(fields),
  taskFingerprint:assistTaskFingerprint(prepared),inputAuthority:prepared.inputAuthority,method:prepared.methodSelection??null,expiresAt:prepared.expiresAt});
}
export function businessBenchmarkSourcePins(prepared:AssistContext):BenchmarkItem["sourcePins"]{
 const role=BusinessBenchmarkRoleSchema.safeParse(prepared.request.kind),legacy=LEGACY_BUSINESS_BENCHMARK_ROLES.some(value=>value===prepared.request.kind);
 if(!role.success||!prepared.inputAuthority||prepared.sources.length>(legacy?32:256))
  throw new Error("business_benchmark_sources_invalid");
 const resources=legacy?null:BenchmarkResourceBindingsSchema.parse(prepared.benchmarkResources);
 if(!legacy&&(!prepared.sources.length||prepared.images.some(image=>!image.dataUrl?.startsWith("data:image/jpeg;base64,"))))throw new Error("business_benchmark_media_not_fixed");
 return prepared.sources.map((source,index)=>({sourceId:source.id,kind:"business" as const,resourceId:assistScope(prepared.request),
  checksum:knowledgeEvaluationChecksum({source,taskFingerprint:assistTaskFingerprint(prepared),inputAuthority:prepared.inputAuthority}),title:source.label,
  ...(resources&&index===0?{resourceBindings:resources}:{})}));
}

/** Only the prepared business packet enters this rule executor. It does not
 * receive assertions, expected answers, or permission to create business facts. */
export function runBusinessBenchmarkBaseline(prepared:AssistContext):AssistResult{
 if(!["procurement_review","business_review"].includes(prepared.request.kind)||prepared.benchmarkExecutionVersion)
  throw new Error("business_benchmark_role_invalid");
 if(["expectedFacts","expectedValue","forbiddenClaims","expectRefusal","evaluation","benchmarkCalculations"].some(key=>key in prepared.data))
  throw new Error("business_benchmark_ground_truth_in_input");
 const sourceIds=new Set(prepared.sources.map(source=>source.id));
 const findings:AssistResult["findings"]=[];
 for(const [key,value] of Object.entries(prepared.data)){
  if(["operatingKnowledge","retrieval","conversation"].includes(key))continue;
  const serialized=JSON.stringify(value);if(serialized===undefined)continue;
  // Keep complete bounded sections; never silently truncate monetary facts.
  if(serialized.length>8000)throw new Error("business_benchmark_rule_input_too_large");
  const preferred=key==="workflow"?"workflow":key==="afterSales"?"after-sales":key==="comparison"?(value as {id?:string}|null)?.id:
   prepared.request.kind==="procurement_review"?"inventory":(prepared.data.current as {id?:string}|undefined)?.id;
  const sourceId=preferred&&sourceIds.has(preferred)?preferred:prepared.sources.find(s=>!s.id.startsWith("knowledge:"))?.id;
  if(!sourceId)continue;
  for(let offset=0;offset<serialized.length;offset+=1800){
   findings.push({title:`原业务依据 ${key}${serialized.length>1800?` ${Math.floor(offset/1800)+1}`:""}`,
    detail:serialized.slice(offset,offset+1800),kind:"fact",severity:"info",location:key,
    evidence:[{sourceId,detail:"摘录原拥有者给出的固定值；金额及数量单位保留原字段，不重新计算"}]});
  }
 }
 if(findings.length>50)throw new Error("business_benchmark_rule_input_too_large");
 const missingInformation=prepared.checks.filter(c=>c.severity!=="info").map(c=>`${c.code}: ${c.message}`.slice(0,500));
 if(missingInformation.length>25)throw new Error("business_benchmark_rule_input_too_large");
 if(!findings.length)missingInformation.push("缺少可引用业务来源，无法提供业务结论");
 return LegacyAssistResultSchema.parse({summary:"原业务事实摘录；未知值和缺项保留，金额与采购建议需人工核对",findings,
  directions:[],matches:[],missingInformation,actions:[]});
}

/** Text assertions are explicit operator requirements, not semantic proof of
 * financial correctness or an alternative to review of the original ERP facts. */
export function gradeBusinessBenchmark(fields:BusinessBenchmarkCase,result:AssistResult,prepared:AssistContext,availableImageIds:string[]=[]):Pick<BenchmarkAssessment,"hardPass"|"checks">{
 const checks:BenchmarkAssessment["checks"]=[],add=(key:string,label:string,pass:boolean,detail:string)=>checks.push({key,label,status:pass?"pass":"fail",detail:detail.slice(0,6500)});
 add("business_role","原业务角色",fields.role===prepared.request.kind&&fields.task.kind===fields.role,"固定样本与原生执行角色一致");
 const shape=LegacyAssistResultSchema.safeParse(result);add("business_schema","原生产输出契约",shape.success,"使用原生产输出结构；不增加评测专属数值字段");
 let valid=true;try{validateAssistResult(result,prepared,availableImageIds);}catch{valid=false;}
 add("business_evidence","原生业务引用检查",valid,"事实必须引用本次允许的真实来源，不执行任何业务采用动作");
 const text=JSON.stringify(result).normalize("NFKC").toLowerCase(),normalize=(v:string)=>v.normalize("NFKC").toLowerCase();
 const missing=fields.expectedFacts.filter(value=>!text.includes(normalize(value)));
 add("expected_facts","声明的文本要求",missing.length===0,missing.length?`未出现：${missing.join("；")}`:"声明的文本要求全部出现；不据此证明金额语义正确");
 const forbidden=fields.forbiddenClaims.filter(value=>text.includes(normalize(value)));
 add("forbidden_claims","禁止的说法",forbidden.length===0,forbidden.length?`出现禁止说法：${forbidden.join("；")}`:"未出现声明的禁止说法");
 const refusal=result.missingInformation.length>0&&/缺|不足|待|不能|无法|未.{0,8}(确认|核实)|unknown|insufficient|cannot/i.test(text);
 add("refusal","缺项与拒答",!fields.expectRefusal||refusal,"需拒答的样本必须明确缺项和结论限制");
 add("original_gaps","原规则缺项保留",!prepared.checks.some(c=>c.severity!=="info")||result.missingInformation.length>0,"原规则警告及人工核对项存在时，结果不得表现为资料完整");
 add("task_identity","固定任务指纹",fields.task.expectedTaskFingerprint===assistTaskFingerprint(prepared),"两臂使用发布时的原业务输入；真实金额与数量继续以ERP为准");
 return {hardPass:checks.every(c=>c.status==="pass"),checks};
}
