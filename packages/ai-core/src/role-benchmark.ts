import { LegacyAssistResultSchema, type AssistResult } from "@yummyai/contracts/ai/assist";
import { BusinessBenchmarkRoleSchema, BenchmarkResourceBindingsSchema, LEGACY_BUSINESS_BENCHMARK_ROLES,
 type BusinessBenchmarkCase, type BenchmarkAssessment } from "@yummyai/contracts/knowledge/benchmark";
import type { AssistContext } from "./assist.js";
import { gradeBusinessBenchmark, runBusinessBenchmarkBaseline } from "./business-benchmark.js";

function assertRoleInput(input:AssistContext){
 BusinessBenchmarkRoleSchema.parse(input.request.kind);
 if(input.benchmarkExecutionVersion||input.artworkAudit||input.request.kind==="artwork_preflight"&&(input.request.automaticAudit||input.request.retryAudit))throw new Error("role_benchmark_readonly_input_required");
 if(!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role=>role===input.request.kind))BenchmarkResourceBindingsSchema.parse(input.benchmarkResources);
 if(["expectedFacts","expectedValue","forbiddenClaims","expectRefusal","evaluation","benchmarkCalculations"].some(key=>key in input.data))throw new Error("business_benchmark_ground_truth_in_input");
}

/** An extractive rule baseline, never an image inspection or invented creative
 * generator. Original production schema failures remain visible in the grade. */
export function runRoleBenchmarkBaseline(input:AssistContext):AssistResult{
 assertRoleInput(input);
 if(LEGACY_BUSINESS_BENCHMARK_ROLES.some(role=>role===input.request.kind))return runBusinessBenchmarkBaseline(input);
 const imageIds=new Set(input.images.map(image=>image.sourceId));
 const allowed=input.sources.filter(source=>!imageIds.has(source.id)&&!source.id.startsWith("knowledge:"));
 const findings:AssistResult["findings"]=[];
 for(const [key,value] of Object.entries(input.data)){
  if(["operatingKnowledge","retrieval","conversation","operatingMethod"].includes(key))continue;
  const serialized=JSON.stringify(value);if(serialized===undefined)continue;
  if(serialized.length>100000)throw new Error("role_benchmark_rule_input_too_large");
  const requestedId=value&&typeof value==="object"&&"sourceId" in value?String(value.sourceId):key;
  const source=allowed.find(candidate=>candidate.id===requestedId)??allowed[0];if(!source)continue;
  for(let offset=0;offset<serialized.length;offset+=1900)findings.push({title:`原业务依据 ${key}${serialized.length>1900?` ${Math.floor(offset/1900)+1}`:""}`,
   detail:serialized.slice(offset,offset+1900),kind:"fact",severity:"info",location:key,
   evidence:[{sourceId:source.id,detail:"摘录原业务拥有者的固定字段；不据此判断图片像素、创作质量或生产合格"}]});
 }
 if(findings.length>50)throw new Error("role_benchmark_rule_input_too_large");
 const missing=input.checks.filter(check=>check.severity!=="info").map(check=>`${check.code}: ${check.message}`.slice(0,500));
 if(input.images.length)missing.push("本规则未读取图片像素，不能核实视觉内容、清晰度或生产条件，需人工对照原图");
 if(input.request.kind==="creative")missing.push("本规则仅摘录原要求和研究事实，无法生成三个已核实的原创方向；原生产输出检查保持硬失败");
 if(!findings.length)missing.push("缺少可引用的文字事实，无法给出已核实业务结论");
 if(missing.length>25)throw new Error("role_benchmark_rule_input_too_large");
 return LegacyAssistResultSchema.parse({summary:"原拥有者事实与缺项摘录；图像、创作和采用条件需独立人工核对",findings,directions:[],matches:[],missingInformation:missing,actions:[]});
}

export function gradeRoleBenchmark(fields:BusinessBenchmarkCase,result:AssistResult,input:AssistContext,availableImageIds:string[]):Pick<BenchmarkAssessment,"hardPass"|"checks">{
 const base=gradeBusinessBenchmark(fields,result,input,availableImageIds),known=new Set(input.images.map(image=>image.sourceId));
 const unique=new Set(availableImageIds),text=JSON.stringify(result).normalize("NFKC").toLowerCase();
 const refusal=result.missingInformation.length>0&&/缺|不足|待|不能|无法|未.{0,8}(确认|核实)|unknown|insufficient|cannot/i.test(text);
 const fixed=input.images.every(image=>image.dataUrl?.startsWith("data:image/jpeg;base64,"));
 const delivered=unique.size===availableImageIds.length&&availableImageIds.every(id=>known.has(id));
 const all=input.images.every(image=>unique.has(image.sourceId));
 const readOnly=!input.benchmarkExecutionVersion&&!input.artworkAudit&&!(input.request.kind==="artwork_preflight"&&(input.request.automaticAudit||input.request.retryAudit));
 const checks:BenchmarkAssessment["checks"]=[...base.checks,
  {key:"fixed_media",label:"固定媒体与本次实际图片",status:fixed&&delivered&&(all||refusal)?"pass":"fail",detail:"仅承认原固定分析字节和本次实际图像凭据；缺图须明确拒绝视觉结论，规则摘录不表示已经看图"},
  {key:"readonly_execution",label:"原生只读评测边界",status:readOnly?"pass":"fail",detail:"普通业务分析协议，不进入自动生产审核，不授予设计、模板、刊登或售后采用权"},
 ];
 return {hardPass:checks.every(check=>check.status==="pass"),checks};
}
