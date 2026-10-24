import {z} from "zod";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {AdContextAuthoritySchema,AdImportViewSchema,AdGoalVersionSchema,AdObservationSchema,
 AdAnalysisRunSchema,AdActionViewSchema,AdExportViewSchema,AdActionStatusSchema} from "@yummyai/contracts/advertising";

export const AdHistoryKindSchema=z.enum(["imports","goals","observations","analyses","actions","exports","action_events","import_events"]);
export const AdHistoryAccessModeSchema=z.enum(["read","own_write","own_review"]);
export function adHistoryModeAllows(mode:z.infer<typeof AdHistoryAccessModeSchema>,kind:z.infer<typeof AdHistoryKindSchema>){
 return mode==="read"||(mode==="own_write"?["imports","observations","import_events"]:["goals","analyses","actions","exports","action_events"]).includes(kind);
}
const queryFields={accountId:EntityIdSchema,kind:AdHistoryKindSchema,parentId:EntityIdSchema.optional()};
function parentIssue(value:{kind:string;parentId?:string},context:z.RefinementCtx){
 if(value.kind.endsWith("_events")!==Boolean(value.parentId))context.addIssue({code:"custom",path:["parentId"],message:"事件历史必须固定父记录 其他记录不能指定父记录"});
}
export const AdHistoryQuerySchema=z.object({...queryFields,pageSize:z.coerce.number().int().min(1).max(100).default(25),
 cursor:z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional()}).strict().superRefine(parentIssue);
export const AdHistoryRecordQuerySchema=z.object(queryFields).strict().superRefine(parentIssue);
const Count=z.number().int().nonnegative().safe(),Minor=Count,Checksum=z.string().regex(/^[a-f0-9]{64}$/);
const Parent=EntityIdSchema.nullable(),Execution=z.object({campaignId:z.string().nullable(),adGroupId:z.string().nullable(),targetId:z.string().nullable()}).strict().nullable();
/** For events, ownership describes the authorized parent rather than the event author. */
export const AdHistoryRowSchema=z.object({id:EntityIdSchema,accountId:EntityIdSchema,kind:AdHistoryKindSchema,parentId:Parent,
 title:z.string().max(4000),status:z.string().max(100).nullable(),revision:Count.positive().nullable(),
 createdAt:z.iso.datetime(),ownedByCurrentActor:z.boolean(),periodStart:z.iso.date().nullable(),periodEnd:z.iso.date().nullable(),
 checksum:Checksum.nullable(),runId:EntityIdSchema.nullable()}).strict();
const Cursor=z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).nullable();
export const AdHistoryPageSchema=z.object({accountId:EntityIdSchema,kind:AdHistoryKindSchema,parentId:Parent,
 contextAuthority:AdContextAuthoritySchema,accessMode:AdHistoryAccessModeSchema,
 rows:z.array(AdHistoryRowSchema).max(100),count:Count,pageSize:Count.positive().max(100),
 requestCursor:Cursor,nextCursor:Cursor,hasMore:z.boolean(),upperBound:EntityIdSchema.nullable(),
 recordedBefore:z.iso.datetime(),order:z.literal("id_desc")}).strict().superRefine((value,context)=>{
 if(value.kind.endsWith("_events")!==Boolean(value.parentId))context.addIssue({code:"custom",path:["parentId"],message:"事件分页缺少原父对象"});
 if(value.rows.length>value.pageSize||value.rows.length>value.count||new Set(value.rows.map(row=>row.id)).size!==value.rows.length
  ||value.rows.some(row=>row.accountId!==value.accountId||row.kind!==value.kind||row.parentId!==value.parentId||value.upperBound!==null&&row.id>value.upperBound)
  ||value.rows.some((row,index)=>index>0&&value.rows[index-1]!.id<=row.id))context.addIssue({code:"custom",path:["rows"],message:"历史记录必须来自同一账户类型及父对象并严格按原ID降序"});
 if(value.accessMode!=="read"&&value.rows.some(row=>!row.ownedByCurrentActor))context.addIssue({code:"custom",path:["accessMode"],message:"自有恢复不能返回其他人的记录"});
 if(!adHistoryModeAllows(value.accessMode,value.kind))context.addIssue({code:"custom",path:["accessMode"],message:"自有恢复类型超出原操作权限"});
 if(value.rows.some(row=>Date.parse(row.createdAt)>Date.parse(value.recordedBefore)))context.addIssue({code:"custom",path:["rows"],message:"历史页不能加入创建截止后的新记录"});
 if(value.hasMore!==Boolean(value.nextCursor)||value.hasMore&&value.rows.length!==value.pageSize
  ||value.count===0&&(value.rows.length!==0||value.upperBound!==null)||value.count>0&&value.upperBound===null)
  context.addIssue({code:"custom",path:["nextCursor"],message:"完整历史分页状态不一致"});
});
export const AdActionEventRecordSchema=z.object({id:EntityIdSchema,actionId:EntityIdSchema,accountId:EntityIdSchema,
 status:AdActionStatusSchema,reason:z.string(),createdAt:z.iso.datetime(),expectedRevision:Count.positive().nullable(),expectedStatus:AdActionStatusSchema.nullable(),
 executedAt:z.iso.datetime().nullable(),actualBeforeMinor:Minor.nullable(),actualAfterMinor:Minor.nullable(),execution:Execution}).strict();
export const AdImportEventRecordSchema=z.object({id:EntityIdSchema,importId:EntityIdSchema,accountId:EntityIdSchema,
 status:z.literal("archived"),reason:z.string(),createdAt:z.iso.datetime()}).strict();
export const AdHistoryRecordSchema=z.discriminatedUnion("kind",[
 z.object({kind:z.literal("imports"),value:AdImportViewSchema}).strict(),
 z.object({kind:z.literal("goals"),value:AdGoalVersionSchema}).strict(),
 z.object({kind:z.literal("observations"),value:AdObservationSchema}).strict(),
 z.object({kind:z.literal("analyses"),value:AdAnalysisRunSchema}).strict(),
 z.object({kind:z.literal("actions"),value:AdActionViewSchema}).strict(),
 z.object({kind:z.literal("exports"),value:AdExportViewSchema}).strict(),
 z.object({kind:z.literal("action_events"),value:AdActionEventRecordSchema}).strict(),
 z.object({kind:z.literal("import_events"),value:AdImportEventRecordSchema}).strict(),
]);
export const AdHistoryActionContextSchema=z.object({goalVersionId:EntityIdSchema.nullable(),cooldownDays:z.number().int().min(1).max(90),
 source:z.enum(["saved_goal","legacy_default"]),reviewNotBefore:z.iso.datetime().nullable()}).strict();
export const AdHistoryRecordResultSchema=z.object({accountId:EntityIdSchema,recordId:EntityIdSchema,parentId:Parent,
 contextAuthority:AdContextAuthoritySchema,accessMode:AdHistoryAccessModeSchema,record:AdHistoryRecordSchema,
 actionContext:AdHistoryActionContextSchema.nullable()}).strict().superRefine((result,context)=>{
 const record=result.record,value=record.value;
 const account=record.kind==="goals"||record.kind==="observations"?record.value.scope.accountId
  :record.kind==="actions"?record.value.recommendation.accountId:record.kind==="exports"?record.value.payload.run.accountId
  :record.value.accountId;
 const parent=record.kind==="action_events"?record.value.actionId:record.kind==="import_events"?record.value.importId:null;
 if(value.id!==result.recordId||account!==result.accountId||parent!==result.parentId)
  context.addIssue({code:"custom",path:["record"],message:"原记录与账户 ID 类型及父对象不一致"});
 if(!adHistoryModeAllows(result.accessMode,record.kind))context.addIssue({code:"custom",path:["accessMode"],message:"记录类型超出原操作权限"});
 if(record.kind==="exports"&&record.value.runId!==record.value.payload.run.id)
  context.addIssue({code:"custom",path:["record"],message:"导出必须保留原封存分析 ID"});
 if(record.kind==="exports"&&(record.value.payload.sourcePins?.some(pin=>pin.accountId!==result.accountId)
  ||record.value.payload.actions.some(action=>action.recommendation.accountId!==result.accountId||action.runId!==record.value.runId
   &&!record.value.payload.run.result.recommendations.some(rec=>rec.key===action.recommendation.key))))
  context.addIssue({code:"custom",path:["record"],message:"原导出内的来源和动作必须属于同一账户及原推荐依据"});
 if(record.kind==="actions"){
  const action=result.actionContext;
  if(record.value.eventsComplete===false||!action||action.goalVersionId!==record.value.recommendation.goalVersionId
   ||action.source==="legacy_default"&&action.cooldownDays!==7||action.source==="saved_goal"&&action.goalVersionId===null
   ||action.reviewNotBefore!==(record.value.executedAt?new Date(Date.parse(record.value.executedAt)+action.cooldownDays*86400000).toISOString():null))
   context.addIssue({code:"custom",path:["actionContext"],message:"动作观察期必须来自服务器核对的原目标规则"});
 }else if(result.actionContext!==null)context.addIssue({code:"custom",path:["actionContext"],message:"其他历史类型不能携带动作规则"});
});
export type AdHistoryKind=z.infer<typeof AdHistoryKindSchema>;
export type AdHistoryAccessMode=z.infer<typeof AdHistoryAccessModeSchema>;
export type AdHistoryQuery=z.infer<typeof AdHistoryQuerySchema>;
export type AdHistoryRecordQuery=z.infer<typeof AdHistoryRecordQuerySchema>;
export type AdHistoryRow=z.infer<typeof AdHistoryRowSchema>;
export type AdHistoryPage=z.infer<typeof AdHistoryPageSchema>;
export type AdHistoryRecord=z.infer<typeof AdHistoryRecordSchema>;
export type AdHistoryRecordResult=z.infer<typeof AdHistoryRecordResultSchema>;
