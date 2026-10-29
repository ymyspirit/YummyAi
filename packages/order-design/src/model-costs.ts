import {and,eq,inArray,sql} from "drizzle-orm";
import {createEntityId,type TenantContext} from "@yummyai/contracts";
import {aiBudgetLedger,orderDesignAgentRuns as runs,orderDesignAgentSteps as steps,orderDesignModelCalls as calls,withTenant,type DatabaseConnection,type TenantTransaction} from "@yummyai/database";
import {lockWork,type DesignRun,type DesignStep} from "./repository.js";
import {OrderDesignError,OrderDesignSubmissionNotSentError,type OrderDesignModelResponseReceipt} from "./types.js";
import {modelBillingBudgetAmount} from "@yummyai/ai-core";
import {ModelTokenUsageSchema} from "@yummyai/contracts/ai/model-usage";
import {isDeepStrictEqual} from "node:util";

export function normalizeOrderModelCost(value:unknown):{state:"unknown"|"invalid"|"reported";amount:string|null}{
 if(value===undefined)return {state:"unknown",amount:null};
 if(typeof value!=="number"||!Number.isFinite(value)||value<0||value>1_000_000)return {state:"invalid",amount:null};
 const amount=value.toFixed(8);return Number(amount)===value?{state:"reported",amount}:{state:"invalid",amount:null};
}
export function sumOrderModelCosts(values:string[]):string{
 const total=values.reduce((sum,value)=>{if(!/^\d+(?:\.\d{1,8})?$/.test(value))throw new Error("ORDER_MODEL_COST_INVALID");const [whole,fraction=""]=value.split(".");return sum+BigInt(whole!)*100_000_000n+BigInt(fraction.padEnd(8,"0"));},0n);
 return `${total/100_000_000n}.${(total%100_000_000n).toString().padStart(8,"0")}`;
}
/** Budget rounding is conservative; a positive estimate must never reserve zero. */
export function orderModelBudgetAmount(value:number|string):string{
 if(typeof value==="number"&&(!Number.isFinite(value)||value<0))throw new Error("ORDER_MODEL_COST_INVALID");
 const exact=typeof value==="number"?value.toFixed(8):sumOrderModelCosts([value]);
 const amount=modelBillingBudgetAmount(exact);
 return typeof value==="number"&&value>0&&Number(amount)===0?"0.000001":amount;
}
async function budgetLock(tx:TenantTransaction,context:TenantContext){await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`},0))`);}

/** Called in the original guarded submission transaction, before provider I/O. */
export async function registerOrderModelSubmission(tx:TenantTransaction,context:TenantContext,run:DesignRun,step:DesignStep,token:string){
 await budgetLock(tx,context);
 const [active]=await tx.select({attempt:steps.attempt}).from(steps).where(and(eq(steps.id,step.id),eq(steps.status,"running"),eq(steps.requestId,step.requestId)));
 if(!active)throw new OrderDesignSubmissionNotSentError("agent_model_call_identity_invalid");
 const budgets=await tx.select().from(aiBudgetLedger).where(and(eq(aiBudgetLedger.requestId,step.requestId),eq(aiBudgetLedger.taskType,"order_design"),eq(aiBudgetLedger.state,"reserved")));
 if(budgets.length!==1)throw new OrderDesignSubmissionNotSentError("agent_model_budget_unavailable");
 await tx.insert(calls).values({id:createEntityId(),tenantId:context.tenantId,runId:run.id,stepId:step.id,requestId:step.requestId,attempt:active.attempt,claimToken:token,budgetLedgerId:budgets[0]!.id,requestedBy:context.userId}).onConflictDoNothing({target:[calls.tenantId,calls.stepId,calls.attempt]});
 const [original]=await tx.select().from(calls).where(and(eq(calls.stepId,step.id),eq(calls.attempt,active.attempt)));
 if(!original||original.runId!==run.id||original.requestId!==step.requestId||original.claimToken!==token||original.budgetLedgerId!==budgets[0]!.id)throw new OrderDesignSubmissionNotSentError("agent_model_call_identity_invalid");
}

/** Minimal billing capture is independent of private keys and current output-adoption authority. */
export async function recordOrderModelResponse(database:DatabaseConnection,context:TenantContext,run:DesignRun,step:DesignStep,token:string,receipt:OrderDesignModelResponseReceipt){
 const report=normalizeOrderModelCost(receipt.actualCostUsd);
 const parsed=receipt.tokenUsage==null?null:ModelTokenUsageSchema.safeParse(receipt.tokenUsage);
 if(parsed&&!parsed.success)throw new OrderDesignError("agent_model_usage_invalid");
 const tokenUsage=parsed?.success?parsed.data:null;
 return withTenant(database.db,context,async tx=>{
  await lockWork(tx,run.workItemId);
  const [owner]=await tx.select().from(runs).where(eq(runs.id,run.id)).for("update");
  if(!owner||owner.requestedBy!==context.userId||receipt.requestId!==step.requestId)throw new OrderDesignError("agent_model_call_identity_invalid");
  await budgetLock(tx,context);
  const [original]=await tx.select().from(calls).where(and(eq(calls.runId,run.id),eq(calls.stepId,step.id),eq(calls.requestId,step.requestId),eq(calls.claimToken,token))).for("update");
  // Existing encrypted checkpoints keep their original evidence; do not invent a past submission.
  if(!original){const [registered]=await tx.select({id:calls.id}).from(calls).where(and(eq(calls.runId,run.id),eq(calls.stepId,step.id))).limit(1);if(registered)throw new OrderDesignError("agent_model_call_identity_invalid");return {recorded:false,state:report.state};}
  if(original.receivedAt){
   // A legacy/local byte checkpoint may omit billing; it never replaces known provider evidence.
   if(receipt.actualCostUsd!==undefined&&(original.costReportState!==report.state||original.reportedCostUsd!==report.amount))throw new OrderDesignError("agent_model_cost_conflict");
   if(receipt.tokenUsage!==undefined&&!isDeepStrictEqual(original.tokenUsage??null,tokenUsage))throw new OrderDesignError("agent_model_usage_conflict");
   return {recorded:true,state:original.costReportState};
  }
  else await tx.update(calls).set({receivedAt:sql`clock_timestamp()`,costReportState:report.state,reportedCostUsd:report.amount,tokenUsage}).where(eq(calls.id,original.id));
  const paid=await tx.select({id:steps.id}).from(steps).where(and(eq(steps.runId,run.id),sql`${steps.key} ~ '^(enhance_image|cutout_subject)(_|$)'`));
  const projection=await readOrderModelCostProjection(tx,run.id,paid.length);
  // Fees can change after cancellation; never change task state, lease or production outcome here.
  await tx.update(runs).set({...projection,updatedAt:new Date()}).where(eq(runs.id,run.id));
  return {recorded:true,state:report.state};
 });
}

export async function readOrderModelCostProjection(tx:TenantTransaction,runId:string,planned:number){
 const rows=await tx.select({state:aiBudgetLedger.state,amount:aiBudgetLedger.amountUsd,callId:calls.id,reportState:calls.costReportState,reported:calls.reportedCostUsd}).from(aiBudgetLedger)
  .innerJoin(steps,eq(steps.requestId,aiBudgetLedger.requestId)).leftJoin(calls,eq(calls.budgetLedgerId,aiBudgetLedger.id))
  .where(and(eq(steps.runId,runId),inArray(aiBudgetLedger.state,["reserved","committed"])));
 const complete=(rows.length>0||planned===0)&&rows.every(row=>row.state==="committed"&&(!row.callId||row.reportState==="reported"));
 return {costStatus:complete?"reported" as const:"unknown" as const,actualCostUsd:complete?sumOrderModelCosts(rows.map(row=>row.reported??row.amount)):null};
}
