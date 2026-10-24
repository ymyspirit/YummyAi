import {createHash} from "node:crypto";
import {ConflictException,Inject,Injectable,NotFoundException} from "@nestjs/common";
import {authorize} from "@yummyai/authz";
import type {TenantContext} from "@yummyai/contracts";
import {canonicalJson} from "@yummyai/contracts/common/canonical-json";
import {adCommandScopeKey,type AdCommandKind,type PrepareAdCommand} from "@yummyai/contracts/advertising/command";
import {adActions,adAnalysisRuns,adImports,adImportBatches,adProducts,type TenantTransaction} from "@yummyai/database";
import {and,eq,inArray,sql} from "drizzle-orm";
import {AdvertisingService} from "./advertising.service.js";
import {validAdTransition} from "./ad-analysis.js";
import {requireAdvertisingAccount} from "./advertising-authority.js";
import {advertisingCommandChecksum,advertisingCommandPermission} from "./advertising-command-transaction.js";
const tables:Record<AdCommandKind,string>={import_commit:"ad_import_batches",goal_save:"ad_goal_versions",observation_record:"ad_observations",
  analysis_run:"ad_analysis_runs",action_transition:"ad_action_events",import_archive:"ad_import_events",export_seal:"ad_exports"};
function conflict():never{throw new ConflictException({code:"advertising_command_existing_fact",message:"原请求或同一业务凭据已存在 请核对原记录 不能追认为新提交"});}
@Injectable()
export class AdvertisingCommandOwnerAdapter{
  constructor(@Inject(AdvertisingService)private readonly advertising:AdvertisingService){}
  binding(original:PrepareAdCommand){
    const scopeKey=adCommandScopeKey(original),projection=this.advertising.commandProjection(original);
    return {requestKey:original.input.idempotencyKey,requestChecksum:advertisingCommandChecksum(original),scopeKey,
      ownerInputChecksum:createHash("sha256").update(canonicalJson({kind:original.kind,accountId:original.accountId,targetId:original.targetId,scopeKey,projection})).digest("hex")};
  }
  async validateInTransaction(tx:TenantTransaction,current:TenantContext,original:PrepareAdCommand){
    authorize(current,advertisingCommandPermission(original.kind));
    await requireAdvertisingAccount(tx,current,original.accountId,advertisingCommandPermission(original.kind),["action_transition","import_archive","export_seal"].includes(original.kind));
    const parentColumn=original.kind==="action_transition"?"action_id":original.kind==="import_archive"?"import_id":null;
    const existing=await tx.execute(sql`select id from ${sql.raw(tables[original.kind])} where account_id=${original.accountId}::uuid
      and idempotency_key=${original.input.idempotencyKey} ${parentColumn?sql`and ${sql.raw(parentColumn)}=${original.targetId}::uuid`:sql``} limit 1`);
    if(existing.length)conflict();
    const projection=this.advertising.commandProjection(original);
    if(original.kind==="import_commit"){
      const value=projection as {batchInputChecksum:string};
      if((await tx.select({id:adImportBatches.id}).from(adImportBatches).where(and(eq(adImportBatches.accountId,original.accountId),eq(adImportBatches.inputChecksum,value.batchInputChecksum))).limit(1)).length)conflict();
    }else if(original.kind==="goal_save"){
      const scope=original.input.scope;
      const [product]=await tx.select({revision:adProducts.revision}).from(adProducts).where(and(eq(adProducts.accountId,original.accountId),
        eq(adProducts.marketplace,scope.marketplace),eq(adProducts.currency,scope.currency),eq(adProducts.asin,scope.asin))).limit(1);
      if((product?.revision??0)!==original.input.expectedRevision)throw new ConflictException("原产品目标版本已变化");
    }else if(original.kind==="action_transition"){
      const [action]=await tx.select({accountId:adActions.accountId,runId:adActions.runId,revision:adActions.revision,status:adActions.status}).from(adActions).where(eq(adActions.id,original.targetId)).limit(1);
      if(!action||action.accountId!==original.accountId)throw new NotFoundException("原动作不存在或不可访问");
      const [run]=await tx.select({accountId:adAnalysisRuns.accountId}).from(adAnalysisRuns).where(eq(adAnalysisRuns.id,action.runId)).limit(1);
      if(!run||run.accountId!==original.accountId)throw new NotFoundException("原动作分析不存在或不可访问");
      if(action.revision!==original.input.expectedRevision||action.status!==original.input.expectedStatus)throw new ConflictException("原动作状态已变化");
      if(!validAdTransition(action.status,original.input.status))throw new ConflictException("不能跳过审阅、执行或观察步骤");
    }else if(original.kind==="import_archive"){
      const [source]=await tx.select({accountId:adImports.accountId,archivedAt:adImports.archivedAt}).from(adImports).where(eq(adImports.id,original.targetId)).limit(1);
      if(!source||source.accountId!==original.accountId)throw new NotFoundException("原来源不存在或不可访问");
      if(source.archivedAt)throw new ConflictException("原来源已归档");
    }else if(original.kind==="export_seal"){
      const [run]=await tx.select({accountId:adAnalysisRuns.accountId}).from(adAnalysisRuns).where(eq(adAnalysisRuns.id,original.targetId)).limit(1);
      if(!run||run.accountId!==original.accountId)throw new NotFoundException("原分析不存在或不可访问");
      const actions=await tx.select({id:adActions.id}).from(adActions).where(and(eq(adActions.accountId,original.accountId),inArray(adActions.id,original.input.actionIds)));
      if(actions.length!==original.input.actionIds.length)throw new NotFoundException("原调整记录不存在或不可访问");
    }
  }
  async execute(context:TenantContext,original:PrepareAdCommand):Promise<unknown>{
    switch(original.kind){
      case "import_commit":return this.advertising.commit(context,original.input);
      case "goal_save":return this.advertising.saveGoal(context,original.input);
      case "observation_record":return this.advertising.recordObservation(context,original.input);
      case "analysis_run":return this.advertising.analyze(context,original.input);
      case "action_transition":return this.advertising.transition(context,original.targetId,original.input);
      case "import_archive":return this.advertising.archive(context,original.targetId,original.input);
      case "export_seal":return this.advertising.sealExport(context,original.input);
    }
  }
}
