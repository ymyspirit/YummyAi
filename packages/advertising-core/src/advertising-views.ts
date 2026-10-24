import { AdActionViewSchema,AdAnalysisRunSchema,AdExportViewSchema,AdGoalVersionSchema,AdImportViewSchema,AdObservationSchema } from "@yummyai/contracts/advertising";
import type { adActionEvents,adActions,adAnalysisRuns,adExports,adGoalVersions,adImports,adObservations,adProducts } from "@yummyai/database";
const iso=(value:string)=>new Date(value).toISOString();
export function importView(row:typeof adImports.$inferSelect){
 return AdImportViewSchema.parse({id:row.id,accountId:row.accountId,fileName:row.fileName,checksum:row.checksum,reportType:row.reportType,
  periodStart:row.periodStart,periodEnd:row.periodEnd,timezone:row.metadata.timezone,attributionWindowDays:row.metadata.attributionWindowDays,
  attributionBasis:row.metadata.attributionBasis,observedAt:iso(row.metadata.observedAt),recordedAt:row.createdAt.toISOString(),
  sourceRowCount:row.sourceRowCount,acceptedRowCount:row.acceptedRowCount,rejectedRowCount:row.rejectedRowCount,
  diagnostics:row.diagnostics,archivedAt:row.archivedAt?.toISOString()??null,...(row.metadata.measurement?{measurement:row.metadata.measurement}:{})});
}
export function runView(row:typeof adAnalysisRuns.$inferSelect){
 return AdAnalysisRunSchema.parse({id:row.id,accountId:row.accountId,periodStart:row.input.periodStart,periodEnd:row.input.periodEnd,
  marketplace:row.input.marketplace,currency:row.input.currency,evidenceCutoffAt:iso(row.input.evidenceCutoffAt),status:row.status,
  inputChecksum:row.inputChecksum,createdAt:row.createdAt.toISOString(),result:row.result});
}
export function goalView(goal:typeof adGoalVersions.$inferSelect,product:typeof adProducts.$inferSelect){
 return AdGoalVersionSchema.parse({id:goal.id,productId:product.id,revision:goal.revision,scope:{accountId:product.accountId,
  marketplace:product.marketplace,currency:product.currency,asin:product.asin},fields:goal.fields,checksum:goal.checksum,createdAt:goal.createdAt.toISOString()});
}
export function observationView(row:typeof adObservations.$inferSelect){
 return AdObservationSchema.parse({...row.data,id:row.id,createdAt:row.createdAt.toISOString()});
}
export function actionView(row:typeof adActions.$inferSelect,events:readonly (typeof adActionEvents.$inferSelect)[]){
 const own=events.filter(event=>event.actionId===row.id&&event.accountId===row.accountId),executed=own.find(event=>event.status==="executed");
 return AdActionViewSchema.parse({id:row.id,runId:row.runId,status:row.status,revision:row.revision,recommendation:row.recommendation,
  createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),executedAt:row.executedAt?.toISOString()??null,
  actualBeforeMinor:row.actualBeforeMinor===null?null:Number(row.actualBeforeMinor),actualAfterMinor:row.actualAfterMinor===null?null:Number(row.actualAfterMinor),
  execution:executed?{campaignId:typeof executed.data.executionCampaignId==="string"?executed.data.executionCampaignId:null,
   adGroupId:typeof executed.data.executionAdGroupId==="string"?executed.data.executionAdGroupId:null,
   targetId:typeof executed.data.executionTargetId==="string"?executed.data.executionTargetId:null}:null,
  events:own.map(event=>({id:event.id,status:event.status,reason:event.reason,at:event.createdAt.toISOString()}))});
}
export function exportView(row:typeof adExports.$inferSelect){
 return AdExportViewSchema.parse({id:row.id,runId:row.runId,checksum:row.checksum,createdAt:row.createdAt.toISOString(),reviewReason:row.reviewReason,payload:row.data});
}
