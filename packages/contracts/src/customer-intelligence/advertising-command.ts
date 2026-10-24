import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {canonicalJson} from "@yummyai/contracts/common/canonical-json";
import {AdContextAuthoritySchema,AdCommitImportSchema,AdSaveGoalInputSchema,AdObservationInputSchema,AdAnalysisInputSchema,
  AdActionEventInputSchema,AdArchiveInputSchema,AdExportInputSchema} from "@yummyai/contracts/advertising";

const Id=EntityIdSchema.transform(value=>value.toLowerCase());
export const AD_COMMAND_CONTRACT="advertising-command-v1" as const;
export const AD_COMMAND_MAX_PLAINTEXT_BYTES=32*1024*1024;
export const AD_COMMAND_MAX_CIPHERTEXT_BYTES=45*1024*1024;
export const AdCommandKindSchema=z.enum(["import_commit","goal_save","observation_record","analysis_run","action_transition","import_archive","export_seal"]);
export type AdCommandKind=z.infer<typeof AdCommandKindSchema>;
export const AdCommandScopeSchema=z.object({kind:AdCommandKindSchema,accountId:Id,targetId:Id.nullable()}).strict();
export type AdCommandScope=z.infer<typeof AdCommandScopeSchema>;
export function isAdExecutionTimeExact(value:string){
  const fraction=/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return !fraction||!/[1-9]/.test(fraction.slice(3));
}
export const PrepareAdCommandSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("import_commit"),accountId:Id,targetId:z.null(),input:AdCommitImportSchema}).strict(),
  z.object({kind:z.literal("goal_save"),accountId:Id,targetId:z.null(),input:AdSaveGoalInputSchema}).strict(),
  z.object({kind:z.literal("observation_record"),accountId:Id,targetId:z.null(),input:AdObservationInputSchema}).strict(),
  z.object({kind:z.literal("analysis_run"),accountId:Id,targetId:z.null(),input:AdAnalysisInputSchema}).strict(),
  z.object({kind:z.literal("action_transition"),accountId:Id,targetId:Id,input:AdActionEventInputSchema}).strict(),
  z.object({kind:z.literal("import_archive"),accountId:Id,targetId:Id,input:AdArchiveInputSchema}).strict(),
  z.object({kind:z.literal("export_seal"),accountId:Id,targetId:Id,input:AdExportInputSchema}).strict(),
]).superRefine((value,context)=>{
  const account=value.kind==="import_commit"||value.kind==="analysis_run"?value.input.accountId
    :value.kind==="goal_save"||value.kind==="observation_record"?value.input.scope.accountId:null;
  if(account&&account.toLowerCase()!==value.accountId)context.addIssue({code:"custom",path:["accountId"],message:"原提交必须绑定填写中的同一账户"});
  if(value.kind==="export_seal"&&value.input.runId.toLowerCase()!==value.targetId)
    context.addIssue({code:"custom",path:["targetId"],message:"封存目标必须是原分析ID"});
  if(/^(?:generated|invalidate):/.test(value.input.idempotencyKey))context.addIssue({code:"custom",path:["input","idempotencyKey"],message:"原提交不能使用系统派生事件键"});
  if(value.kind==="action_transition"&&value.input.executedAt&&!isAdExecutionTimeExact(value.input.executedAt))
    context.addIssue({code:"custom",path:["input","executedAt"],message:"执行时间必须能精确保存到毫秒 请核对原时间后重新填写"});
}).transform(value=>{
  if(value.kind==="import_commit"||value.kind==="analysis_run")value.input.accountId=value.accountId;
  if(value.kind==="goal_save"||value.kind==="observation_record")value.input.scope.accountId=value.accountId;
  if(value.kind==="export_seal"){value.input.runId=value.targetId;value.input.actionIds=value.input.actionIds.map(id=>id.toLowerCase());}
  if(value.kind==="import_commit"||value.kind==="observation_record")value.input.observedAt=new Date(value.input.observedAt).toISOString();
  if(value.kind==="analysis_run")value.input.evidenceCutoffAt=new Date(value.input.evidenceCutoffAt).toISOString();
  return value;
}).superRefine((value,context)=>{
  if(value.kind==="export_seal"&&new Set(value.input.actionIds).size!==value.input.actionIds.length)
    context.addIssue({code:"custom",path:["input","actionIds"],message:"不能重复选择同一个原动作"});
});
export type PrepareAdCommand=z.infer<typeof PrepareAdCommandSchema>;
export function canonicalAdCommandOriginal(original:PrepareAdCommand){return canonicalJson(original);}
export function adCommandScopeKey(original:PrepareAdCommand){
  if(original.kind==="goal_save"||original.kind==="observation_record"){
    const scope=original.input.scope;return `product:${scope.marketplace}:${scope.currency}:${scope.asin}`;
  }
  return original.targetId??"root";
}
export const AdCommandEmptyBodySchema=z.object({}).strict();
export const AdCommandAccountQuerySchema=z.object({accountId:Id}).strict();
export const AdCommandQuerySchema=z.object({accountId:Id,kind:AdCommandKindSchema.optional(),
  targetId:z.union([Id,z.literal("root").transform(()=>null)]).optional(),before:Id.optional(),view:z.enum(["active","recorded"]).optional()}).strict();
export type AdCommandQuery=z.infer<typeof AdCommandQuerySchema>;
export const AdCommandResultSchema=z.object({kind:AdCommandKindSchema,id:Id,parentId:Id.nullable(),version:z.number().int().positive().nullable()}).strict()
  .superRefine((value,context)=>{
    const parented=["goal_save","action_transition","import_archive","export_seal"].includes(value.kind);
    const versioned=value.kind==="goal_save"||value.kind==="action_transition";
    if(parented!==(value.parentId!==null)||versioned!==(value.version!==null))
      context.addIssue({code:"custom",message:"结果必须保留实际原版本或父事件对象"});
  });
export type AdCommandResult=z.infer<typeof AdCommandResultSchema>;
export const AdCommandBlockReasonSchema=z.enum(["basis_changed","permission_denied","input_unavailable","expired"]);
export const AdCommandSummarySchema=z.object({id:Id,kind:AdCommandKindSchema,accountId:Id,targetId:Id.nullable(),scopeKey:z.string().min(1).max(200),
  status:z.enum(["prepared","succeeded","cancelled","expired"]),requestKey:z.string().min(8).max(200),
  createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),completedAt:z.iso.datetime().nullable(),acknowledged:z.boolean(),
  originalRetained:z.boolean(),result:AdCommandResultSchema.nullable(),contextAuthority:AdContextAuthoritySchema}).strict()
  .superRefine((value,context)=>{
    const targeted=["action_transition","import_archive","export_seal"].includes(value.kind);
    if(targeted!==(value.targetId!==null)||(value.status==="succeeded")!==(value.result!==null)
      ||(value.status==="prepared")!==(value.completedAt===null)||value.result&&value.result.kind!==value.kind
      ||value.result&&targeted&&value.result.parentId!==value.targetId||value.acknowledged&&(value.status==="prepared"||value.originalRetained)
      ||["cancelled","expired"].includes(value.status)&&value.originalRetained)
      context.addIssue({code:"custom",message:"广告原提交状态与实际结果或留存不一致"});
    if(value.scopeKey!==(value.targetId??"root")&&(!["goal_save","observation_record"].includes(value.kind)||!/^product:[A-Z]{2}:[A-Z]{3}:[A-Z0-9]{10}$/.test(value.scopeKey)))
      context.addIssue({code:"custom",path:["scopeKey"],message:"原目标槽必须匹配固定对象或产品范围"});
    if(["goal_save","observation_record"].includes(value.kind)&&!value.scopeKey.startsWith("product:"))
      context.addIssue({code:"custom",path:["scopeKey"],message:"产品原提交必须绑定原产品范围"});
    if(Date.parse(value.expiresAt)!==Date.parse(value.createdAt)+7*86400000||value.completedAt&&Date.parse(value.completedAt)<Date.parse(value.createdAt))
      context.addIssue({code:"custom",message:"原提交留存窗口或实际完成时间不正确"});
  });
export type AdCommandSummary=z.infer<typeof AdCommandSummarySchema>;
export const AdCommandDetailSchema=AdCommandSummarySchema.safeExtend({canExecute:z.boolean(),canCancel:z.boolean(),canAcknowledge:z.boolean(),
  blockReason:AdCommandBlockReasonSchema.nullable()}).superRefine((value,context)=>{
    if(value.canExecute&&(value.status!=="prepared"||!value.originalRetained||value.blockReason!==null||value.acknowledged)
      ||value.canCancel&&value.status!=="prepared"||value.canAcknowledge&&(value.status==="prepared"||value.acknowledged))
      context.addIssue({code:"custom",message:"广告原提交可执行动作与实际状态不一致"});
  });
export type AdCommandDetail=z.infer<typeof AdCommandDetailSchema>;
export const AdCommandListSchema=z.object({accountId:Id,items:z.array(AdCommandSummarySchema).max(50),nextCursor:Id.nullable(),
  unavailableCount:z.number().int().min(0).max(50),contextAuthority:AdContextAuthoritySchema}).strict().superRefine((value,context)=>{
    if(value.items.some(item=>item.accountId!==value.accountId||item.contextAuthority!==value.contextAuthority)
      ||new Set(value.items.map(item=>item.id)).size!==value.items.length||value.items.length+value.unavailableCount>50
      ||value.items.some((item,index)=>index>0&&value.items[index-1]!.id<=item.id)
      ||value.nextCursor!==null&&value.items.length>0&&value.nextCursor>value.items.at(-1)!.id)
      context.addIssue({code:"custom",message:"本人原提交列表与账户或当前身份不一致"});
  });
export type AdCommandList=z.infer<typeof AdCommandListSchema>;
export const AdCommandOriginalSchema=z.object({id:Id,accountId:Id,original:PrepareAdCommandSchema.nullable(),
  blockReason:AdCommandBlockReasonSchema.nullable(),contextAuthority:AdContextAuthoritySchema}).strict().superRefine((value,context)=>{
    if(value.original&&value.original.accountId!==value.accountId||(value.original===null)!==(value.blockReason!==null))
      context.addIssue({code:"custom",message:"原填写必须属于该账户且仍可完整读取"});
  });
export type AdCommandOriginal=z.infer<typeof AdCommandOriginalSchema>;
