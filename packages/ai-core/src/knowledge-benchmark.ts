import { AssistResultSchema, type AssistResult } from "@yummyai/contracts/ai/assist";
import type { KnowledgeReference } from "@yummyai/contracts/knowledge";
import { BenchmarkArmCostSchema, type BenchmarkArmCost, type BenchmarkAssessment, type BenchmarkAttempt, type BenchmarkCalculation, type KnowledgeBenchmarkCase, type BenchmarkExpense } from "@yummyai/contracts/knowledge/benchmark";
import { BenchmarkDecimalSchema } from "@yummyai/contracts/knowledge/benchmark-values";
import type { AssistContext } from "./assist.js";
import type { SecretVault } from "./secrets.js";
import { scoreKnowledgeEvaluation } from "./knowledge-evaluation.js";

type Domain="basis"|"assessment"|"baseline-output"|"report";
export class BenchmarkProofError extends Error { constructor(){super("knowledge_benchmark_proof_invalid");} }
export function sealBenchmarkValue(vault:SecretVault,domain:Domain,value:unknown){
 // Native Assist fingerprints preserve object insertion order. AEAD authenticates
 // this exact JSON; canonicalizing a prepared context would change its identity.
 return vault.encrypt(JSON.stringify({version:1,domain:"knowledge-benchmark-"+domain,value}));
}
export function openBenchmarkValue<T>(vault:SecretVault,domain:Domain,sealed:string):T{
 try{return vault.withSecret(sealed,text=>{const body=JSON.parse(text);if(body.version!==1||body.domain!=="knowledge-benchmark-"+domain||!("value" in body)||Object.keys(body).length!==3)throw new BenchmarkProofError();return body.value as T;});}
 catch{throw new BenchmarkProofError();}
}
type Rational={n:bigint;d:bigint};
function decimal(value:string):Rational{
 if(!BenchmarkDecimalSchema.safeParse(value).success)throw new Error("benchmark_decimal_invalid");
 const negative=value.startsWith("-"),[whole,fraction=""]=(negative?value.slice(1):value).split(".");
 return {n:BigInt(whole!+fraction)*(negative?-1n:1n),d:10n**BigInt(fraction.length)};
}
function rounded(n:bigint,d:bigint){if(d===0n)throw new Error("benchmark_division_by_zero");const negative=(n<0n)!==(d<0n),a=n<0n?-n:n,b=d<0n?-d:d;return ((a+b/2n)/b)*(negative?-1n:1n);}
function fixed(value:bigint,scale:number){const negative=value<0n,abs=negative?-value:value,base=10n**BigInt(scale);return (negative?"-":"")+(abs/base)+(scale?"."+String(abs%base).padStart(scale,"0"):"");}
export function calculateBenchmarkValue(task:Omit<BenchmarkCalculation,"expectedValue">):string{
 if(!["sum","difference","product","quotient"].includes(task.operator)||!Number.isInteger(task.scale)||task.scale<0||task.scale>8||
  task.operands.length<2||task.operands.length>20||task.operator==="quotient"&&task.operands.length!==2)throw new Error("benchmark_calculation_invalid");
 let value=decimal(task.operands[0]!);
 for(const operand of task.operands.slice(1)){
  const right=decimal(operand);
  if(task.operator==="sum")value={n:value.n*right.d+right.n*value.d,d:value.d*right.d};
  else if(task.operator==="difference")value={n:value.n*right.d-right.n*value.d,d:value.d*right.d};
  else if(task.operator==="product")value={n:value.n*right.n,d:value.d*right.d};
  else{if(right.n===0n)throw new Error("benchmark_division_by_zero");value={n:value.n*right.d,d:value.d*right.n};}
 }
 const result=rounded(value.n*10n**BigInt(task.scale),value.d),bound=1_000_000_000_000n*10n**BigInt(task.scale);
 if(result<=-bound||result>=bound)throw new Error("benchmark_calculation_out_of_range");
 return fixed(result,task.scale);
}

/** Registered baseline consumes real inputs only. Expected answers never enter this function. */
export function runBenchmarkBaseline(prepared:AssistContext):AssistResult{
 const references=prepared.knowledge??[],typedAnswers:NonNullable<AssistResult["typedAnswers"]>=[],missingInformation:string[]=[];
 const tasks=(prepared.data.benchmarkCalculations??[]) as Omit<BenchmarkCalculation,"expectedValue">[];
 for(const task of tasks){
  // Reject accidental gold leakage at the execution boundary.
  if("expectedValue" in task)throw new Error("benchmark_ground_truth_in_execution_input");
  try{typedAnswers.push({key:task.key,value:calculateBenchmarkValue(task),unit:task.unit,currency:task.currency,
   evidence:[{sourceId:"benchmark-input:"+task.key,detail:"按发布样本给定输入计算，不作为ERP经营事实"}]});}
  catch(error){missingInformation.push(task.key+": "+(error instanceof Error?error.message:"benchmark_calculation_invalid"));}
 }
 if(!references.length)missingInformation.push("当前固定样本没有可用知识来源，不能据此归纳知识事实");
 return AssistResultSchema.parse({summary:references.length?"以下为固定来源摘录，需要独立核对问题相关性": "资料不足；仅处理明确给出的计算输入",
  findings:references.map(reference=>({title:reference.title.slice(0,160)||"原知识来源",detail:reference.excerpt.slice(0,2000),kind:"fact",severity:"info",
   evidence:[{sourceId:reference.sourceId,detail:"原发布版本的来源摘录"}],location:null})),
  directions:[],matches:[],missingInformation,...(tasks.length?{typedAnswers}:{})});
}

export function gradeBenchmark(fields:KnowledgeBenchmarkCase,result:AssistResult,knowledge:KnowledgeReference[]):Pick<BenchmarkAssessment,"hardPass"|"checks">{
 const checks:BenchmarkAssessment["checks"]=scoreKnowledgeEvaluation(fields.evaluation,{status:"completed",knowledge,result,error:null}).checks.map(check=>({...check,status:check.status==="pass"?"pass":"fail"}));
 const answers=result.typedAnswers??[],keys=new Set(answers.map(answer=>answer.key)),declared=new Set(fields.calculations.map(task=>task.key));
 if(answers.length!==keys.size||answers.some(answer=>!declared.has(answer.key)))checks.push({key:"numeric_shape",label:"结构化答案标识",status:"fail",detail:"存在重复或未声明的数值答案"});
 const sourceIds=new Set(knowledge.map(reference=>reference.sourceId));
 for(const task of fields.calculations){
  const answer=answers.find(row=>row.key===task.key),problems:string[]=[];
  if(!answer)problems.push("缺少结构化答案");
  else{
   try{const actual=decimal(answer.value),expected=decimal(task.expectedValue);if(actual.n*expected.d!==expected.n*actual.d)problems.push("数值与独立预期不符");
    if((answer.value.split(".")[1]?.length??0)>task.scale)problems.push("超过本题规定的小数精度");}
   catch{problems.push("十进制数值无效");}
   if(answer.unit!==task.unit)problems.push("单位不符");if(answer.currency!==task.currency)problems.push("币种不符");
   if(!answer.evidence.length||answer.evidence.some(evidence=>evidence.sourceId!=="benchmark-input:"+task.key&&!sourceIds.has(evidence.sourceId)))problems.push("缺少有效原输入或来源引用");
  }
  // Invalid arithmetic is a hard failure even when a model guesses a matching gold value.
  try{calculateBenchmarkValue(task);}catch{problems.push("给定计算输入无法按注册规则执行");}
  checks.push({key:"numeric:"+task.key,label:"数值检查 "+task.key,status:problems.length?"fail":"pass",detail:problems.join("；")||"数值、精度、单位、币种和原引用均匹配独立预期"});
 }
 return {hardPass:checks.every(check=>check.status==="pass"),checks};
}

const usdUnits=(value:string)=>{if(!/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/.test(value))throw new Error("benchmark_usd_invalid");const [whole,fraction=""]=value.split(".");return BigInt(whole!)*100_000_000n+BigInt(fraction.padEnd(8,"0"));};
const minutesUnits=(value:string)=>{if(!/^(0|[1-9]\d{0,8})(\.\d{1,3})?$/.test(value))throw new Error("benchmark_minutes_invalid");const [whole,fraction=""]=value.split(".");return BigInt(whole!)*1000n+BigInt(fraction.padEnd(3,"0"));};
export type BenchmarkCostInput={arm:"baseline"|"candidate";totalItems:number;activityFingerprint:string;
 outcomes:Array<{state:BenchmarkAttempt["state"]|"not_started";hardPass:boolean|null;reviewDecision:"pass"|"fail"|"needs_review"|null}>;
 attempts:Array<Pick<BenchmarkAttempt,"id"|"modelCost">>;
 reviews:Array<{id:string;minutes:string;hourlyUsd:string|null}>;expense:BenchmarkExpense|null};
export function summarizeBenchmarkArmCost(input:BenchmarkCostInput):BenchmarkArmCost{
 if(input.outcomes.length!==input.totalItems)throw new Error("benchmark_fixed_denominator_invalid");
 let model=0n,human=0n,totalMinutes=0n,estimated=false,confirmed=0,possible=0,processing=0;
 const missing:string[]=[];
 for(const attempt of input.attempts){
  const cost=attempt.modelCost;confirmed+=cost.confirmedProviderCalls;possible+=cost.possibleProviderCalls;processing+=cost.localProcessingAttempts;
  if(cost.amountUsd===null||cost.source==="unknown")missing.push("尝试 "+attempt.id+" 的模型费用未知");else model+=usdUnits(cost.amountUsd);
  if(cost.source==="usage_estimate")estimated=true;
 }
 for(const review of input.reviews){const minutes=minutesUnits(review.minutes);totalMinutes+=minutes;if(minutes&&review.hourlyUsd===null)missing.push("核验 "+review.id+" 的人工费率未知");else if(review.hourlyUsd!==null)human+=rounded(minutes*usdUnits(review.hourlyUsd),60_000n);}
 const expense=input.expense;
 if(!expense||expense.activityFingerprint!==input.activityFingerprint)missing.push("存储与维护累计声明尚未覆盖当前全部尝试和核验");
 if(expense?.storageUsd==null)missing.push("存储费用未知");if(expense?.maintenanceUsd==null)missing.push("维护费用未知");
 const storage=expense?.storageUsd==null?0n:usdUnits(expense.storageUsd),maintenance=expense?.maintenanceUsd==null?0n:usdUnits(expense.maintenanceUsd);
 const qualified=input.outcomes.filter(row=>row.state==="completed"&&row.hardPass===true&&row.reviewDecision==="pass").length;
 const notRun=input.outcomes.filter(row=>row.state==="not_started").length;
 const pendingReview=input.outcomes.filter(row=>row.state==="completed"&&row.hardPass===true&&(!row.reviewDecision||row.reviewDecision==="needs_review")).length;
 if(pendingReview)missing.push("固定样本仍有待人工核验的结果");
 if(input.outcomes.some(row=>!["completed","failed","cancelled"].includes(row.state)))missing.push("固定样本仍有未运行或未终态结果");
 if(possible)missing.push("存在提供方提交结果尚未确认的尝试");
 const total=model+human+storage+maintenance,state=missing.length?"incomplete":estimated?"estimated":"complete";
 return BenchmarkArmCostSchema.parse({arm:input.arm,state,totalItems:input.totalItems,activityFingerprint:input.activityFingerprint,
  allAttempts:input.attempts.length,qualifiedItems:qualified,notRunItems:notRun,
  pendingReviewItems:pendingReview,
  hardFailedItems:input.outcomes.filter(row=>row.hardPass===false||row.state==="failed"||row.state==="cancelled").length,
  confirmedProviderCalls:confirmed,possibleProviderCalls:possible,localProcessingAttempts:processing,reviewMinutes:fixed(totalMinutes,3),
  modelKnownUsd:fixed(model,8),humanKnownUsd:fixed(human,8),storageKnownUsd:fixed(storage,8),maintenanceKnownUsd:fixed(maintenance,8),knownSubtotalUsd:fixed(total,8),
  totalUsd:state==="incomplete"?null:fixed(total,8),unitQualifiedCostUsd:state==="complete"&&qualified?fixed(rounded(total,BigInt(qualified)),8):null,
  estimatedUnitQualifiedCostUsd:state==="estimated"&&qualified?fixed(rounded(total,BigInt(qualified)),8):null,missing});
}
