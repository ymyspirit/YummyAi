import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {FinanceFactViewSchema,FinanceStatementViewSchema,FinanceFxRateViewSchema,FinanceProfitMetricVersionViewSchema,
 FinanceProfitRunViewSchema,FinanceProfitContributionViewSchema} from "@yummyai/contracts/finance";
import {FinancePayableBillViewSchema,FinancePayablePaymentViewSchema,FinancePaymentAllocationViewSchema,
 FinanceAllocationReleaseViewSchema} from "@yummyai/contracts/finance/payables";
import {FinanceBillAdjustmentViewSchema,FinancePaymentAdjustmentViewSchema} from "@yummyai/contracts/finance/payables-adjustments";
import {FinanceCostAllocationPreviewViewSchema,FinanceCostAllocationVersionViewSchema,FinanceCostAllocationSourceSchema,
 FinanceCostAllocationShareSchema,FinanceAllocatedProfitRunViewSchema,FinanceAllocatedProfitSliceSchema} from "@yummyai/contracts/finance/cost-allocation";
import {FinanceCommandKindSchema,FinanceCommandResultSchema} from "@yummyai/contracts/finance/finance-command";

const Id=EntityIdSchema.transform(value=>value.toLowerCase()),Count=z.number().int().nonnegative().safe();
const Cursor=z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
export const FINANCE_COMMAND_RESULT_MAX_RESPONSE_BYTES=8*1024*1024;
export const FINANCE_COMMAND_RESULT_PAGE_MAX_RESPONSE_BYTES=4*1024*1024;
export const FinanceCommandResultSectionSchema=z.enum(["facts","contributions","allocations","cost_sources","cost_shares","slices"]);
export type FinanceCommandResultSection=z.infer<typeof FinanceCommandResultSectionSchema>;
export const financeCommandResultSections={statement_record:["facts"],fx_rate_record:[],metric_upsert:[],profit_calculate:["contributions"],
 bill_record:[],payment_record:[],payment_allocate:["allocations"],allocation_release:[],bill_adjustment_record:[],payment_adjustment_record:[],
 cost_version_approve:["cost_sources","cost_shares"],allocated_profit_calculate:["slices"]} as const;
export const FinanceCommandResultPageQuerySchema=z.object({section:FinanceCommandResultSectionSchema,
 limit:z.union([z.number().int().min(1).max(100),z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)]).default(25),cursor:Cursor.optional()}).strict();
export type FinanceCommandResultPageQuery=z.infer<typeof FinanceCommandResultPageQuerySchema>;
/** Bind transport positions to a single authorized immutable collection. This is not an authority token. */
export const FinanceCommandResultCursorSchema=z.object({v:z.literal(1),scope:z.string().regex(/^[a-f0-9]{64}$/),offset:Count.min(1),anchor:z.string().min(1).max(160)}).strict();
export function readFinanceCommandResultCursorPosition(raw:string):z.infer<typeof FinanceCommandResultCursorSchema>|null {
 if(!Cursor.safeParse(raw).success)return null;
 try{
  const binary=atob(raw.replaceAll("-","+").replaceAll("_","/"));
  if(btoa(binary).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"")!==raw)return null;
  const json=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(binary,part=>part.charCodeAt(0)));
  const parsed=FinanceCommandResultCursorSchema.safeParse(JSON.parse(json));
  return parsed.success&&JSON.stringify(parsed.data)===json?parsed.data:null;
 }catch{return null;}
}
export const FinanceCommandResultBillSchema=z.object({...FinancePayableBillViewSchema.shape}).pick({id:true,supplierId:true,kind:true,externalBillId:true,
 currency:true,amountMinor:true,issuedAt:true,dueAt:true,procurementInvoiceId:true,procurementProofId:true,recordedAt:true});
export const FinanceCommandResultPaymentSchema=z.object({...FinancePayablePaymentViewSchema.shape}).pick({id:true,supplierId:true,externalPaymentId:true,currency:true,
 amountMinor:true,paidAt:true,method:true,evidenceReference:true,evidenceStatus:true,recordedAt:true});
export const FinanceCommandResultAllocationSchema=FinancePaymentAllocationViewSchema.omit({released:true});
export const FinanceCommandResultSourceSchema=z.object({...FinanceCostAllocationSourceSchema.shape}).omit({shares:true});
export const FinanceCommandResultShareSchema=z.object({sourceIndex:Count,shareIndex:Count,source:FinanceCommandResultSourceSchema,share:FinanceCostAllocationShareSchema}).strict();
const PreviewHeader=z.object({...FinanceCostAllocationPreviewViewSchema.shape}).omit({sources:true});
const CostVersion=z.object({...FinanceCostAllocationVersionViewSchema.shape}).omit({preview:true,basisProblems:true}).extend({preview:PreviewHeader,sourceCount:Count,shareCount:Count});
const AllocatedRun=z.object({...FinanceAllocatedProfitRunViewSchema.shape}).omit({basisProblems:true});
const SavedProfit=FinanceProfitRunViewSchema.omit({contributions:true,breakdowns:true});
export const FinanceCommandRecordedRecordSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("statement_record"),record:FinanceStatementViewSchema.omit({lines:true})}).strict(),
 z.object({kind:z.literal("fx_rate_record"),record:FinanceFxRateViewSchema}).strict(),
 z.object({kind:z.literal("metric_upsert"),record:FinanceProfitMetricVersionViewSchema.extend({name:z.string().nullable()})}).strict(),
 z.object({kind:z.literal("profit_calculate"),record:SavedProfit}).strict(),
 z.object({kind:z.literal("bill_record"),record:FinanceCommandResultBillSchema,balanceSnapshot:z.literal("not_saved")}).strict(),
 z.object({kind:z.literal("payment_record"),record:FinanceCommandResultPaymentSchema,balanceSnapshot:z.literal("not_saved")}).strict(),
 z.object({kind:z.literal("payment_allocate"),record:z.object({id:Id,paymentId:Id,recordedAt:z.iso.datetime(),allocationCount:Count}).strict(),balanceSnapshot:z.literal("not_saved")}).strict(),
 z.object({kind:z.literal("allocation_release"),record:FinanceAllocationReleaseViewSchema.extend({allocation:FinanceCommandResultAllocationSchema}),balanceSnapshot:z.literal("not_saved")}).strict(),
 z.object({kind:z.literal("bill_adjustment_record"),record:FinanceBillAdjustmentViewSchema,balanceSnapshot:z.literal("saved_on_event")}).strict(),
 z.object({kind:z.literal("payment_adjustment_record"),record:FinancePaymentAdjustmentViewSchema,balanceSnapshot:z.literal("saved_on_event")}).strict(),
 z.object({kind:z.literal("cost_version_approve"),record:CostVersion}).strict(),
 z.object({kind:z.literal("allocated_profit_calculate"),record:AllocatedRun}).strict(),
]);
export const FinanceCommandResultVerificationSchema=z.object({verified:z.boolean(),checkedAt:z.iso.datetime(),
 problems:z.array(z.enum(["source_changed","target_changed","rule_superseded","base_unavailable","financial_evidence_unverified"]))}).strict();
export const FinanceCommandRecordedResultSchema=z.object({commandId:Id,kind:FinanceCommandKindSchema,targetId:Id.nullable(),result:FinanceCommandResultSchema,
 executedAt:z.iso.datetime(),recorded:FinanceCommandRecordedRecordSchema,currentVerification:FinanceCommandResultVerificationSchema.nullable(),
 collections:z.array(z.object({section:FinanceCommandResultSectionSchema,total:Count}).strict()).max(2),contextAuthority:z.string().min(1),
 consistency:z.literal("immutable_execution")}).strict().superRefine((value,ctx)=>{
 const expected=financeCommandResultSections[value.kind] as readonly string[];
 if(value.recorded.kind!==value.kind||value.result.kind!==value.kind||value.recorded.record.id!==value.result.id
  ||value.collections.length!==expected.length||new Set(value.collections.map(row=>row.section)).size!==value.collections.length
  ||value.collections.some(row=>!expected.includes(row.section)))ctx.addIssue({code:"custom",message:"A recorded result must match the command and every immutable collection"});
 if(value.recorded.kind==="metric_upsert"&&(value.recorded.record.metricId!==value.result.parentId||value.recorded.record.versionNumber!==value.result.version)
  ||value.recorded.kind==="cost_version_approve"&&(value.recorded.record.allocationId!==value.result.parentId||value.recorded.record.versionNumber!==value.result.version))
  ctx.addIssue({code:"custom",message:"The recorded version must match its original proof"});
 if(value.currentVerification&&value.currentVerification.verified!==(value.currentVerification.problems.length===0))ctx.addIssue({code:"custom",message:"Current verification cannot hide its problems"});
 const originalTarget=value.recorded.kind==="profit_calculate"?value.recorded.record.metricId:value.recorded.kind==="payment_allocate"?value.recorded.record.paymentId
  :value.recorded.kind==="allocation_release"?value.recorded.record.allocationId:value.recorded.kind==="bill_adjustment_record"?value.recorded.record.billId
  :value.recorded.kind==="payment_adjustment_record"?value.recorded.record.paymentId:value.recorded.kind==="allocated_profit_calculate"?value.recorded.record.baseRunId:undefined;
 if(originalTarget!==undefined&&originalTarget!==value.targetId||["statement_record","fx_rate_record","bill_record","payment_record"].includes(value.kind)&&value.targetId!==null
  ||value.kind==="metric_upsert"&&value.targetId!==null&&value.targetId!==value.result.parentId
  ||value.recorded.kind==="cost_version_approve"&&(value.recorded.record.preview.allocationId!==value.targetId||value.recorded.record.preview.expectedVersion!==(value.result.version===1?null:value.result.version!-1))
  ||value.recorded.kind==="allocation_release"&&value.recorded.record.allocation.id!==value.recorded.record.allocationId)
  ctx.addIssue({code:"custom",message:"Historical result identities must retain the original target"});
 const requiresCurrent=["profit_calculate","cost_version_approve","allocated_profit_calculate"].includes(value.kind);
 if(requiresCurrent!==(value.currentVerification!==null))ctx.addIssue({code:"custom",message:"Saved calculations and approvals require a separate current verification"});
 if(value.recorded.kind==="metric_upsert"&&value.targetId===null&&value.result.version!==1
  ||value.recorded.kind==="payment_allocate"&&value.collections.find(row=>row.section==="allocations")?.total!==value.recorded.record.allocationCount
  ||value.recorded.kind==="cost_version_approve"&&(value.collections.find(row=>row.section==="cost_sources")?.total!==value.recorded.record.sourceCount
   ||value.collections.find(row=>row.section==="cost_shares")?.total!==value.recorded.record.shareCount))
  ctx.addIssue({code:"custom",message:"The recorded header must conserve its original version and collection counts"});
});
export type FinanceCommandRecordedResult=z.infer<typeof FinanceCommandRecordedResultSchema>;
const commonPage={commandId:Id,result:FinanceCommandResultSchema,limit:z.number().int().min(1).max(100),offset:Count,total:Count,
 hasMore:z.boolean(),nextCursor:Cursor.nullable(),contextAuthority:z.string().min(1),consistency:z.literal("immutable_execution")};
export const FinanceCommandResultPageSchema=z.discriminatedUnion("section",[
 z.object({...commonPage,section:z.literal("facts"),items:z.array(FinanceFactViewSchema).max(100)}).strict(),
 z.object({...commonPage,section:z.literal("contributions"),items:z.array(FinanceProfitContributionViewSchema).max(100)}).strict(),
 z.object({...commonPage,section:z.literal("allocations"),items:z.array(FinanceCommandResultAllocationSchema).max(100)}).strict(),
 z.object({...commonPage,section:z.literal("cost_sources"),items:z.array(FinanceCommandResultSourceSchema).max(100)}).strict(),
 z.object({...commonPage,section:z.literal("cost_shares"),items:z.array(FinanceCommandResultShareSchema).max(100)}).strict(),
 z.object({...commonPage,section:z.literal("slices"),items:z.array(FinanceAllocatedProfitSliceSchema).max(100)}).strict(),
]).superRefine((value,ctx)=>{
 const sections=financeCommandResultSections[value.result.kind] as readonly string[];
 if(!sections.includes(value.section)||value.items.length>value.limit||value.offset+value.items.length>value.total
  ||value.hasMore!==(value.offset+value.items.length<value.total)||value.hasMore!==(value.nextCursor!==null)
  ||value.hasMore&&value.items.length!==value.limit)ctx.addIssue({code:"custom",message:"The immutable page must retain its exact result, count and continuation"});
 if(value.section==="facts"&&value.items.some(row=>row.statementId!==value.result.id)
  ||value.section==="allocations"&&value.items.some(row=>row.batchId!==value.result.id)
  ||value.section==="slices"&&value.items.some(row=>row.runId!==value.result.id))ctx.addIssue({code:"custom",message:"Rows must belong to this command's original result"});
 const keys=value.items.map(row=>"id"in row?row.id:"sourceIndex"in row?`${row.sourceIndex}:${row.shareIndex}`:row.contributionId);
 if(new Set(keys).size!==keys.length)ctx.addIssue({code:"custom",message:"Immutable page rows must be distinct"});
});
export type FinanceCommandResultPage=z.infer<typeof FinanceCommandResultPageSchema>;
