import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {canonicalJson} from "@yummyai/contracts/common/canonical-json";
import {RecordFinanceStatementInputSchema,RecordFinanceFxRateInputSchema,UpsertFinanceProfitMetricInputSchema,
  CalculateFinanceProfitInputSchema} from "@yummyai/contracts/finance";
import {RecordFinanceBillInputSchema,RecordFinancePaymentInputSchema,AllocateFinancePaymentInputSchema,
  ReleaseFinanceAllocationInputSchema} from "@yummyai/contracts/finance/payables";
import {RecordFinanceBillAdjustmentInputSchema,RecordFinancePaymentAdjustmentInputSchema} from "@yummyai/contracts/finance/payables-adjustments";
import {FinanceCostAllocationVersionInputSchema,CalculateFinanceAllocatedProfitInputSchema} from "@yummyai/contracts/finance/cost-allocation";

const Id=EntityIdSchema.transform(value=>value.toLowerCase());
export const FINANCE_COMMAND_CONTRACT="finance-command-v1" as const;
// Canonical defaults may expand a legal 28MiB HTTP input. Never truncate a report.
export const FINANCE_COMMAND_MAX_PLAINTEXT_BYTES=32*1024*1024;
export const FINANCE_COMMAND_MAX_CIPHERTEXT_BYTES=45*1024*1024;
export const FinanceCommandKindSchema=z.enum(["statement_record","fx_rate_record","metric_upsert","profit_calculate",
  "bill_record","payment_record","payment_allocate","allocation_release","bill_adjustment_record","payment_adjustment_record",
  "cost_version_approve","allocated_profit_calculate"]);
export type FinanceCommandKind=z.infer<typeof FinanceCommandKindSchema>;
export const FinanceCommandScopeSchema=z.object({kind:FinanceCommandKindSchema,targetId:Id.nullable()}).strict();
export type FinanceCommandScope=z.infer<typeof FinanceCommandScopeSchema>;
export const PrepareFinanceCommandSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("statement_record"),targetId:z.null(),input:RecordFinanceStatementInputSchema}).strict(),
  z.object({kind:z.literal("fx_rate_record"),targetId:z.null(),input:RecordFinanceFxRateInputSchema}).strict(),
  z.object({kind:z.literal("metric_upsert"),targetId:Id.nullable(),input:UpsertFinanceProfitMetricInputSchema}).strict(),
  z.object({kind:z.literal("profit_calculate"),targetId:Id,input:CalculateFinanceProfitInputSchema}).strict(),
  z.object({kind:z.literal("bill_record"),targetId:z.null(),input:RecordFinanceBillInputSchema}).strict(),
  z.object({kind:z.literal("payment_record"),targetId:z.null(),input:RecordFinancePaymentInputSchema}).strict(),
  z.object({kind:z.literal("payment_allocate"),targetId:Id,input:AllocateFinancePaymentInputSchema}).strict(),
  z.object({kind:z.literal("allocation_release"),targetId:Id,input:ReleaseFinanceAllocationInputSchema}).strict(),
  z.object({kind:z.literal("bill_adjustment_record"),targetId:Id,input:RecordFinanceBillAdjustmentInputSchema}).strict(),
  z.object({kind:z.literal("payment_adjustment_record"),targetId:Id,input:RecordFinancePaymentAdjustmentInputSchema}).strict(),
  z.object({kind:z.literal("cost_version_approve"),targetId:Id.nullable(),input:FinanceCostAllocationVersionInputSchema}).strict(),
  z.object({kind:z.literal("allocated_profit_calculate"),targetId:Id,input:CalculateFinanceAllocatedProfitInputSchema}).strict(),
]).superRefine((value,ctx)=>{
  const actual=value.kind==="metric_upsert"?value.input.metricId:value.kind==="profit_calculate"?value.input.metricId
    :value.kind==="payment_allocate"?value.input.paymentId:value.kind==="cost_version_approve"?value.input.allocationId
    :value.kind==="allocated_profit_calculate"?value.input.baseRunId:undefined;
  if(actual!==undefined&&(actual?.toLowerCase()??null)!==value.targetId)
    ctx.addIssue({code:"custom",path:["targetId"],message:"The original target must match its pinned input"});
});
export type PrepareFinanceCommand=z.infer<typeof PrepareFinanceCommandSchema>;
export function canonicalFinanceCommandOriginal(original:PrepareFinanceCommand){return canonicalJson(original);}
export const FinanceCommandEmptyBodySchema=z.object({}).strict();
export const FinanceCommandQuerySchema=z.object({kind:FinanceCommandKindSchema.optional(),targetId:z.union([Id,z.literal("root").transform(()=>null)]).optional(),before:Id.optional(),view:z.enum(["active","recorded"]).optional()}).strict();
export type FinanceCommandQuery=z.infer<typeof FinanceCommandQuerySchema>;
/** A small immutable receipt. id is the actual version/event/batch/run, never a mutable projection. */
export const FinanceCommandResultSchema=z.object({kind:FinanceCommandKindSchema,id:Id,parentId:Id.nullable(),version:z.number().int().positive().nullable()}).strict()
  .superRefine((value,ctx)=>{
    const versioned=value.kind==="metric_upsert"||value.kind==="cost_version_approve";
    if(versioned!==(value.parentId!==null&&value.version!==null)||!versioned&&(value.parentId!==null||value.version!==null))
      ctx.addIssue({code:"custom",message:"The receipt must retain its actual immutable version"});
  });
export type FinanceCommandResult=z.infer<typeof FinanceCommandResultSchema>;
export const FinanceCommandBlockReasonSchema=z.enum(["basis_changed","permission_denied","input_unavailable","expired"]);
export const FinanceCommandSummarySchema=z.object({id:Id,kind:FinanceCommandKindSchema,targetId:Id.nullable(),
  status:z.enum(["prepared","succeeded","cancelled","expired"]),requestKey:z.string().min(8).max(200),
  createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),completedAt:z.iso.datetime().nullable(),acknowledged:z.boolean(),
  originalRetained:z.boolean(),result:FinanceCommandResultSchema.nullable(),contextAuthority:z.string().min(1)}).strict()
  .superRefine((value,ctx)=>{
    if((value.status==="succeeded")!==(value.result!==null)||(value.status==="prepared")!==(value.completedAt===null)
      ||value.result&&value.result.kind!==value.kind||value.acknowledged&&(value.status==="prepared"||value.originalRetained))
      ctx.addIssue({code:"custom",message:"Finance original state and actual result disagree"});
  });
export type FinanceCommandSummary=z.infer<typeof FinanceCommandSummarySchema>;
// List and action responses never contain private input. Only /:id/original loads one body.
export const FinanceCommandDetailSchema=FinanceCommandSummarySchema.safeExtend({canExecute:z.boolean(),canCancel:z.boolean(),canAcknowledge:z.boolean(),
  blockReason:FinanceCommandBlockReasonSchema.nullable()}).superRefine((value,ctx)=>{
    if(value.canExecute&&(value.status!=="prepared"||!value.originalRetained||value.blockReason!==null||value.acknowledged)
      ||value.canCancel&&value.status!=="prepared"||value.canAcknowledge&&(value.status==="prepared"||value.acknowledged))
      ctx.addIssue({code:"custom",message:"Finance original actions disagree with its state"});
  });
export type FinanceCommandDetail=z.infer<typeof FinanceCommandDetailSchema>;
export const FinanceCommandListSchema=z.object({items:z.array(FinanceCommandSummarySchema).max(50),nextCursor:Id.nullable(),
  unavailableCount:z.number().int().min(0).max(50),contextAuthority:z.string().min(1)}).strict();
export type FinanceCommandList=z.infer<typeof FinanceCommandListSchema>;
export const FinanceCommandOriginalSchema=z.object({id:Id,original:PrepareFinanceCommandSchema.nullable(),
  blockReason:FinanceCommandBlockReasonSchema.nullable(),contextAuthority:z.string().min(1)}).strict();
export type FinanceCommandOriginal=z.infer<typeof FinanceCommandOriginalSchema>;
