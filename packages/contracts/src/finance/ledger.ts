import { z } from "zod";
import { FinanceCurrencySchema } from "@yummyai/contracts/finance/monetary";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { FinanceFactViewSchema, FinanceFxRateViewSchema, FinanceProfitContributionViewSchema, FinanceProfitMetricVersionViewSchema,
  FinanceProfitMetricViewSchema, FinanceProfitRunViewSchema, FinanceStatementViewSchema } from "@yummyai/contracts/finance";
import { FinanceAllocationReleaseViewSchema, FinancePayableBillViewSchema, FinancePayablePaymentViewSchema,
  FinancePaymentAllocationBatchViewSchema, FinancePaymentAllocationViewSchema } from "@yummyai/contracts/finance/payables";
import { FinanceBillAdjustmentViewSchema, FinancePaymentAdjustmentViewSchema, FinanceProcurementAdjustmentDiagnosticSchema,
  FinanceProcurementAdjustmentOptionSchema } from "@yummyai/contracts/finance/payables-adjustments";

const Id = EntityIdSchema.transform(value => value.toLowerCase());
export const FinanceLedgerKindSchema = z.enum(["statements", "facts", "fx_rates", "metrics", "metric_versions", "profit_runs", "contributions",
  "bills", "payments", "allocation_batches", "allocations", "releases", "bill_adjustments", "payment_adjustments", "procurement_adjustments"]);
export type FinanceLedgerKind = z.infer<typeof FinanceLedgerKindSchema>;
export const financeLedgerParentKinds: Partial<Record<FinanceLedgerKind, FinanceLedgerKind | "suppliers">> = {
  facts:"statements", metric_versions:"metrics", profit_runs:"metrics", contributions:"profit_runs", bills:"suppliers", payments:"suppliers",
  allocation_batches:"payments", allocations:"bills", releases:"allocations", bill_adjustments:"bills", payment_adjustments:"payments", procurement_adjustments:"bills",
};
const Cursor = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/);
const CursorPosition = z.object({v:z.literal(1),scope:z.string().regex(/^[a-f0-9]{64}$/),upperId:Id,id:Id}).strict();
// A transport position only. Authority is checked independently by the API.
export function readFinanceLedgerCursorPosition(raw:string):z.infer<typeof CursorPosition>|null {
  if(!Cursor.safeParse(raw).success)return null;
  try{
    const original=atob(raw.replaceAll("-","+").replaceAll("_","/"));
    if(btoa(original).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"")!==raw)return null;
    const parsed=CursorPosition.safeParse(JSON.parse(original));
    if(!parsed.success||parsed.data.id>parsed.data.upperId||JSON.stringify(parsed.data)!==original)return null;
    return parsed.data;
  }catch{return null;}
}
export const FinanceLedgerListInputSchema = z.object({
  kind:FinanceLedgerKindSchema, parentId:Id.optional(),
  limit:z.union([z.number().int().min(1).max(100),z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number)]).default(25),
  cursor:Cursor.optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.parentId&&!financeLedgerParentKinds[value.kind])ctx.addIssue({code:"custom",path:["parentId"],message:"This ledger kind has no parent filter"});
  if(value.kind==="procurement_adjustments"&&!value.parentId)ctx.addIssue({code:"custom",path:["parentId"],message:"A procurement bill is required"});
});
export const FinanceLedgerDetailInputSchema = z.object({kind:FinanceLedgerKindSchema,id:Id,parentId:Id.optional()}).strict().superRefine((value,ctx)=>{
  if(value.parentId&&!financeLedgerParentKinds[value.kind])ctx.addIssue({code:"custom",path:["parentId"],message:"This ledger kind has no parent filter"});
  if(value.kind==="procurement_adjustments"&&!value.parentId)ctx.addIssue({code:"custom",path:["parentId"],message:"A procurement bill is required"});
});
export const FinanceLedgerSummarySchema = z.object({
  kind:FinanceLedgerKindSchema,id:Id,reference:z.string(),recordedAt:z.iso.datetime(),
  amountMinor:z.number().int().safe().nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),netAmountMinor:z.number().int().safe().nullable(),
  status:z.string().nullable(),supplierId:Id.nullable(),parentId:Id.nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.kind==="profit_runs"&&(value.amountMinor!==null||value.netAmountMinor!==null||value.status!==null))
    ctx.addIssue({code:"custom",message:"Profit verification and totals belong to the original detail owner"});
  if((value.amountMinor!==null||value.netAmountMinor!==null)&&value.currency===null)ctx.addIssue({code:"custom",message:"Money requires its actual currency"});
});
export const FinanceLedgerPageViewSchema = z.object({
  kind:FinanceLedgerKindSchema,parentId:Id.nullable(),limit:z.number().int().min(1).max(100),order:z.literal("id_desc"),consistency:z.literal("live"),
  upperBoundId:Id.nullable(),items:z.array(FinanceLedgerSummarySchema).max(100),hasMore:z.boolean(),nextCursor:Cursor.nullable(),
}).strict().superRefine((value,ctx)=>{
  if(value.items.length>value.limit||value.hasMore!==(value.nextCursor!==null)||value.hasMore&&value.items.length!==value.limit)
    ctx.addIssue({code:"custom",message:"Page size or continuation is inconsistent"});
  const ids=value.items.map(row=>row.id);
  if(new Set(ids).size!==ids.length||ids.some((id,index)=>index>0&&id>=ids[index-1]!))ctx.addIssue({code:"custom",message:"Ledger rows require strict descending IDs"});
  if(value.items.some(row=>row.kind!==value.kind||value.parentId!==null&&row.parentId!==value.parentId)||value.items.length>0&&value.upperBoundId===null
    ||ids.some(id=>value.upperBoundId!==null&&id>value.upperBoundId))ctx.addIssue({code:"custom",message:"Ledger rows disagree with their query or bound"});
});
export const FinanceLedgerStatementHeaderSchema = FinanceStatementViewSchema.omit({lines:true});
export const FinanceLedgerProfitRunHeaderSchema = FinanceProfitRunViewSchema.omit({contributions:true});
export const FinanceLedgerContributionSchema = FinanceProfitContributionViewSchema.extend({runId:Id});
const Child = z.object({kind:FinanceLedgerKindSchema,parentId:Id}).strict();
const common = {id:Id,children:z.array(Child).max(4)};
export const FinanceLedgerDetailViewSchema = z.discriminatedUnion("kind",[
  z.object({...common,kind:z.literal("statements"),record:FinanceLedgerStatementHeaderSchema}).strict(),
  z.object({...common,kind:z.literal("facts"),record:FinanceFactViewSchema}).strict(),
  z.object({...common,kind:z.literal("fx_rates"),record:FinanceFxRateViewSchema}).strict(),
  z.object({...common,kind:z.literal("metrics"),record:FinanceProfitMetricViewSchema}).strict(),
  z.object({...common,kind:z.literal("metric_versions"),record:FinanceProfitMetricVersionViewSchema}).strict(),
  z.object({...common,kind:z.literal("profit_runs"),record:FinanceLedgerProfitRunHeaderSchema}).strict(),
  z.object({...common,kind:z.literal("contributions"),record:FinanceLedgerContributionSchema}).strict(),
  z.object({...common,kind:z.literal("bills"),record:FinancePayableBillViewSchema}).strict(),
  z.object({...common,kind:z.literal("payments"),record:FinancePayablePaymentViewSchema}).strict(),
  z.object({...common,kind:z.literal("allocation_batches"),record:FinancePaymentAllocationBatchViewSchema}).strict(),
  z.object({...common,kind:z.literal("allocations"),record:FinancePaymentAllocationViewSchema}).strict(),
  z.object({...common,kind:z.literal("releases"),record:FinanceAllocationReleaseViewSchema}).strict(),
  z.object({...common,kind:z.literal("bill_adjustments"),record:FinanceBillAdjustmentViewSchema}).strict(),
  z.object({...common,kind:z.literal("payment_adjustments"),record:FinancePaymentAdjustmentViewSchema}).strict(),
  z.object({...common,kind:z.literal("procurement_adjustments"),billCurrency:FinanceCurrencySchema,
    record:z.union([FinanceProcurementAdjustmentOptionSchema,FinanceProcurementAdjustmentDiagnosticSchema])}).strict(),
]).superRefine((value,ctx)=>{
  const id=value.kind==="procurement_adjustments"?value.record.procurementAdjustmentId:value.record.id;
  if(value.id!==id)ctx.addIssue({code:"custom",message:"Detail identity disagrees with its original record"});
  const children:Partial<Record<FinanceLedgerKind,FinanceLedgerKind[]>>={statements:["facts"],metrics:["metric_versions","profit_runs"],
    profit_runs:["contributions"],bills:["allocations","bill_adjustments","procurement_adjustments"],payments:["allocation_batches","payment_adjustments"],allocations:["releases"]};
  const expected=(children[value.kind]??[]).filter(kind=>!(kind==="procurement_adjustments"&&value.kind==="bills"&&value.record.kind!=="procurement_invoice"));
  if(new Set(value.children.map(child=>child.kind)).size!==value.children.length||value.children.some(child=>child.parentId!==value.id||!expected.includes(child.kind))
    ||expected.some(kind=>!value.children.some(child=>child.kind===kind)))
    ctx.addIssue({code:"custom",message:"Detail children must use their real parent and relation"});
});
export type FinanceLedgerListInput = z.infer<typeof FinanceLedgerListInputSchema>;
export type FinanceLedgerDetailInput = z.infer<typeof FinanceLedgerDetailInputSchema>;
export type FinanceLedgerSummary = z.infer<typeof FinanceLedgerSummarySchema>;
export type FinanceLedgerPageView = z.infer<typeof FinanceLedgerPageViewSchema>;
export type FinanceLedgerDetailView = z.infer<typeof FinanceLedgerDetailViewSchema>;
export function financeLedgerDetailParentId(detail:FinanceLedgerDetailView):string|null {
  switch(detail.kind){
    case"facts":return detail.record.statementId;
    case"metric_versions":case"profit_runs":return detail.record.metricId;
    case"contributions":return detail.record.runId;
    case"bills":case"payments":return detail.record.supplierId;
    case"allocation_batches":return detail.record.paymentId;
    case"allocations":case"bill_adjustments":case"procurement_adjustments":return detail.record.billId;
    case"releases":return detail.record.allocationId;
    case"payment_adjustments":return detail.record.paymentId;
    default:return null;
  }
}
