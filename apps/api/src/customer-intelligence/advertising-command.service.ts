import {BadRequestException,ConflictException,Inject,Injectable,NotFoundException,PayloadTooLargeException,UnprocessableEntityException} from "@nestjs/common";
import type {SecretVault} from "@yummyai/ai-core";
import {authorize,ForbiddenError,intersectPermissionContexts,Permission} from "@yummyai/authz";
import {createEntityId,TenantContextSchema,type TenantContext} from "@yummyai/contracts";
import {canonicalJson} from "@yummyai/contracts/common/canonical-json";
import {EntityIdSchema} from "@yummyai/contracts/common/ids";
import {AgentCommandBindingSchema,type AgentCommandBinding,type AgentCommandOwnerReference} from "@yummyai/contracts/ai/agent-command";
import {AD_COMMAND_CONTRACT,AD_COMMAND_MAX_CIPHERTEXT_BYTES,AD_COMMAND_MAX_PLAINTEXT_BYTES,AdCommandDetailSchema,AdCommandListSchema,
  AdCommandOriginalSchema,AdCommandQuerySchema,AdCommandResultSchema,AdCommandScopeSchema,AdCommandSummarySchema,PrepareAdCommandSchema,adCommandScopeKey,
  canonicalAdCommandOriginal,type AdCommandDetail,type PrepareAdCommand} from "@yummyai/contracts/advertising/command";
import {advertisingCommands as commands,advertisingOriginalWriteProofs,expireAdvertisingCommandInputs,withTenant,
  type DatabaseConnection,type TenantTransaction} from "@yummyai/database";
import {and,desc,eq,isNull,sql} from "drizzle-orm";
import {z} from "zod";
import {AuditService} from "../audit/audit.service.js";
import {retryDatabaseTimeRollback} from "../database-time-retry.js";
import {ADVERTISING_COMMAND_VAULT,DATABASE_CONNECTION} from "../platform.tokens.js";
import {advertisingContextAuthority,currentAdvertisingAuthority,requireAdvertisingAccount,requireAnyAdvertisingPermission} from "./advertising-authority.js";
import {AdvertisingCommandOwnerAdapter} from "./advertising-command-owner.js";
import {advertisingCommandChecksum,advertisingCommandPermission,AdvertisingCommandSettled,runAdvertisingCommand} from "./advertising-command-transaction.js";

type Command=typeof commands.$inferSelect;
type Metadata=Pick<Command,"id"|"tenantId"|"createdBy"|"accountId"|"kind"|"targetId"|"scopeKey"|"requestKey"|"requestChecksum"|
  "ownerInputChecksum"|"contractVersion"|"status"|"resultId"|"parentId"|"version"|"createdAt"|"expiresAt"|"completedAt"|"acknowledgedAt">&{originalRetained:boolean;inputDue:boolean};
type PrivateInput=Pick<Command,"authoritySnapshot"|"encryptedInput">;
const metadataColumns={id:commands.id,tenantId:commands.tenantId,createdBy:commands.createdBy,accountId:commands.accountId,kind:commands.kind,targetId:commands.targetId,
  scopeKey:commands.scopeKey,requestKey:commands.requestKey,requestChecksum:commands.requestChecksum,ownerInputChecksum:commands.ownerInputChecksum,contractVersion:commands.contractVersion,
  status:commands.status,resultId:commands.resultId,parentId:commands.parentId,version:commands.version,createdAt:commands.createdAt,expiresAt:commands.expiresAt,
  completedAt:commands.completedAt,acknowledgedAt:commands.acknowledgedAt,
  originalRetained:sql<boolean>`${commands.encryptedInput} is not null and ${commands.redactedAt} is null and ${commands.expiresAt}>advertising_command_now()`,inputDue:sql<boolean>`${commands.expiresAt}<=advertising_command_now()`};
const Id=EntityIdSchema.transform(value=>value.toLowerCase()),envelopeSchema=z.object({tenantId:Id,createdBy:Id,commandId:Id,original:PrepareAdCommandSchema}).strict();
function input<T>(schema:z.ZodType<T>,raw:unknown){const result=schema.safeParse(raw);if(!result.success)throw new BadRequestException({code:"advertising_command_input_invalid",message:"广告原提交填写或查询格式不正确"});return result.data;}
function conflict(code:string,message:string):never{throw new ConflictException({code,message});}
function missing():never{throw new NotFoundException({code:"advertising_command_not_found",message:"本人的广告原提交不存在或不可读取"});}
function tooLarge():never{throw new PayloadTooLargeException({code:"advertising_command_input_too_large",message:"完整原填写超过留存上限 本次不会裁剪报表"});}
class OriginalUnavailable extends Error{}

@Injectable()
export class AdvertisingCommandService{
  constructor(@Inject(DATABASE_CONNECTION)private readonly database:DatabaseConnection,@Inject(ADVERTISING_COMMAND_VAULT)private readonly vault:SecretVault,
    @Inject(AdvertisingCommandOwnerAdapter)private readonly owner:AdvertisingCommandOwnerAdapter,@Inject(AuditService)private readonly audit:AuditService){}

  locateForAgent(context:TenantContext,raw:AgentCommandBinding):Promise<AgentCommandOwnerReference|null>{
    const binding=input(AgentCommandBindingSchema,raw);
    if(binding.domain!=="advertising"||binding.accountId===null)throw new BadRequestException("广告原命令定位范围不正确");
    const scope=input(AdCommandScopeSchema,{kind:binding.kind,targetId:binding.targetId,accountId:binding.accountId});
    return this.withCurrent(context,async(tx,current)=>{
      const [row]=await tx.select({id:commands.id,kind:commands.kind,accountId:commands.accountId}).from(commands).where(and(
        eq(commands.tenantId,current.tenantId),eq(commands.createdBy,current.userId),eq(commands.kind,scope.kind),eq(commands.accountId,scope.accountId),
        scope.targetId===null?isNull(commands.targetId):eq(commands.targetId,scope.targetId),eq(commands.requestChecksum,binding.ownerRequestChecksum),
        sql`encode(sha256(convert_to(${commands.requestKey},'UTF8')),'hex')=${binding.requestKeyHash}`,
      )).limit(1);
      if(!row)return null;
      await this.readAuthority(tx,current,row);
      return {domain:"advertising",commandId:row.id,accountId:row.accountId};
    });
  }

  prepare(context:TenantContext,raw:unknown){
    const original=input(PrepareAdCommandSchema,raw);
    if(Buffer.byteLength(canonicalAdCommandOriginal(original),"utf8")>AD_COMMAND_MAX_PLAINTEXT_BYTES)tooLarge();
    const identity={requestKey:original.input.idempotencyKey,requestChecksum:advertisingCommandChecksum(original),scopeKey:adCommandScopeKey(original)};
    return this.withCurrent(context,async(tx,current)=>{
      authorize(current,advertisingCommandPermission(original.kind));
      await requireAdvertisingAccount(tx,current,original.accountId,advertisingCommandPermission(original.kind),["action_transition","import_archive","export_seal"].includes(original.kind));
      await keyLock(tx,original.kind,original.accountId,original.targetId,identity.requestKey);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`advertising-command-slot:${current.tenantId}:${current.userId}:${original.accountId}:${original.kind}:${identity.scopeKey}`},0))`);
      const [old]=await tx.select(metadataColumns).from(commands).where(and(eq(commands.accountId,original.accountId),eq(commands.kind,original.kind),
        eq(commands.requestKey,identity.requestKey),["action_transition","import_archive"].includes(original.kind)?eq(commands.targetId,original.targetId!):undefined)).for("update").limit(1);
      if(old){
        if(old.createdBy!==current.userId||old.targetId!==original.targetId||old.scopeKey!==identity.scopeKey||old.requestChecksum!==identity.requestChecksum)
          conflict("advertising_command_request_mismatch","原请求已绑定原操作者、目标和填写 请恢复原记录");
        await expireAdvertisingCommandInputs(tx,{actorId:current.userId,commandId:old.id,limit:1});
        return this.detail(tx,current,await this.row(tx,current,old.id,original.accountId));
      }
      const [pending]=await tx.select({id:commands.id}).from(commands).where(and(eq(commands.accountId,original.accountId),eq(commands.createdBy,current.userId),
        eq(commands.kind,original.kind),eq(commands.scopeKey,identity.scopeKey),isNull(commands.acknowledgedAt))).limit(1);
      if(pending)conflict("advertising_command_unacknowledged","请先恢复并确认同一目标的上一笔原提交结果");
      const binding=this.owner.binding(original);await this.owner.validateInTransaction(tx,current,original);
      const id=createEntityId(),plaintext=canonicalJson({tenantId:current.tenantId,createdBy:current.userId,commandId:id,original});
      if(Buffer.byteLength(plaintext,"utf8")>AD_COMMAND_MAX_PLAINTEXT_BYTES)tooLarge();
      const encryptedInput=this.vault.encrypt(plaintext);if(Buffer.byteLength(encryptedInput,"utf8")>AD_COMMAND_MAX_CIPHERTEXT_BYTES)tooLarge();
      await tx.insert(commands).values({id,tenantId:current.tenantId,createdBy:current.userId,accountId:original.accountId,kind:original.kind,targetId:original.targetId,
        ...binding,authoritySnapshot:current,encryptedInput,contractVersion:AD_COMMAND_CONTRACT,expiresAt:sql`advertising_command_now()+interval '7 days'`});
      const saved=await this.row(tx,current,id,original.accountId);await this.record(tx,current,saved,"prepare");
      return this.detail(tx,current,saved,{original,authority:current});
    });
  }
  list(context:TenantContext,raw:unknown){
    const query=input(AdCommandQuerySchema,raw);
    return this.withCurrent(context,async(tx,current)=>{
      await requireAdvertisingAccount(tx,current,query.accountId,null,true);
      const rows=await tx.select(metadataColumns).from(commands).where(and(eq(commands.accountId,query.accountId),eq(commands.createdBy,current.userId),
        query.view==="recorded"?eq(commands.status,"succeeded"):isNull(commands.acknowledgedAt),query.kind?eq(commands.kind,query.kind):undefined,
        query.targetId===undefined?undefined:query.targetId===null?isNull(commands.targetId):eq(commands.targetId,query.targetId),
        query.before?sql`${commands.id}<${query.before}::uuid`:undefined)).orderBy(desc(commands.id)).limit(51);
      const items=[];let unavailableCount=0;
      for(const before of rows.slice(0,50))try{
        const row=before.inputDue?await this.currentRow(tx,current,before.id,query.accountId):before;
        items.push(await this.summary(tx,current,row));
      }catch(error){if(error instanceof ForbiddenError||error instanceof NotFoundException)unavailableCount++;else throw error;}
      return AdCommandListSchema.parse({accountId:query.accountId,items,unavailableCount,nextCursor:rows.length>50?rows[49]!.id:null,contextAuthority:advertisingContextAuthority(current)});
    });
  }
  get(context:TenantContext,rawId:string,rawAccountId:string){const id=input(Id,rawId),accountId=input(Id,rawAccountId);return this.withCurrent(context,async(tx,current)=>this.detail(tx,current,await this.currentRow(tx,current,id,accountId)));}
  original(context:TenantContext,rawId:string,rawAccountId:string){
    const id=input(Id,rawId),accountId=input(Id,rawAccountId);
    return this.withCurrent(context,async(tx,current)=>{
      const row=await this.currentRow(tx,current,id,accountId);await this.readAuthority(tx,current,row);
      let original:PrepareAdCommand|null=null,blockReason:AdCommandDetail["blockReason"]=row.status==="expired"?"expired":"input_unavailable";
      if(row.originalRetained)try{original=await this.decrypt(row,await this.privateInput(tx,current,id,accountId));blockReason=null;}
      catch(error){if(!(error instanceof OriginalUnavailable))throw error;}
      return AdCommandOriginalSchema.parse({id,accountId,original,blockReason,contextAuthority:advertisingContextAuthority(current)});
    });
  }
  async execute(context:TenantContext,rawId:string,rawAccountId:string){
    const id=input(Id,rawId),accountId=input(Id,rawAccountId);
    const saved=await this.withCurrent(context,async(tx,current)=>{
      const row=await this.currentRow(tx,current,id,accountId);await this.readAuthority(tx,current,row);if(row.status!=="prepared")return null;
      const retained=await this.privateInput(tx,current,id,accountId);
      let original:PrepareAdCommand,ceiling:TenantContext;
      try{ceiling=intersectPermissionContexts(this.authority(row,retained),current);authorize(ceiling,advertisingCommandPermission(row.kind));original=await this.decrypt(row,retained);}
      catch(error){if(error instanceof OriginalUnavailable)conflict("advertising_command_input_unavailable","原填写暂不可用 请读取原状态或明确取消 本次未执行");throw error;}
      if(this.owner.binding(original).ownerInputChecksum!==row.ownerInputChecksum)conflict("advertising_command_basis_changed","准备时的固定依据已变化 请核对原提交");
      await this.owner.validateInTransaction(tx,ceiling,original);
      return {original,ceiling,checksum:row.requestChecksum};
    });
    if(saved)try{await runAdvertisingCommand(id,saved.checksum,()=>this.owner.execute(saved.ceiling,saved.original));}
    catch(error){if(!(error instanceof AdvertisingCommandSettled))throw error;}
    return this.get(context,id,accountId);
  }
  cancel(context:TenantContext,rawId:string,rawAccountId:string){
    const id=input(Id,rawId),accountId=input(Id,rawAccountId);
    return this.withCurrent(context,async(tx,current)=>{
      const row=await this.currentRow(tx,current,id,accountId);await this.readAuthority(tx,current,row);if(row.status!=="prepared")return this.detail(tx,current,row);
      const [saved]=await tx.update(commands).set({status:"cancelled",encryptedInput:null,completedAt:sql`advertising_command_now()`,redactedAt:sql`advertising_command_now()`})
        .where(eq(commands.id,id)).returning(metadataColumns);if(!saved)missing();await this.record(tx,current,saved,"cancel");return this.detail(tx,current,saved);
    });
  }
  acknowledge(context:TenantContext,rawId:string,rawAccountId:string){
    const id=input(Id,rawId),accountId=input(Id,rawAccountId);
    return this.withCurrent(context,async(tx,current)=>{
      const row=await this.currentRow(tx,current,id,accountId);await this.readAuthority(tx,current,row);
      if(row.status==="prepared")conflict("advertising_command_pending","原提交仍待处理 请先核对执行结果或明确取消");
      if(row.acknowledgedAt)return this.detail(tx,current,row);
      const [saved]=await tx.update(commands).set({acknowledgedAt:sql`advertising_command_now()`,encryptedInput:null,redactedAt:sql`coalesce(${commands.redactedAt},advertising_command_now())`})
        .where(eq(commands.id,id)).returning(metadataColumns);if(!saved)missing();await this.record(tx,current,saved,"acknowledge");return this.detail(tx,current,saved);
    });
  }
  private async readAuthority(tx:TenantTransaction,current:TenantContext,row:Pick<Metadata,"kind"|"accountId">){
    try{await requireAdvertisingAccount(tx,current,row.accountId,Permission.CustomerIntelligenceRead,true);}
    catch(error){if(!(error instanceof NotFoundException||error instanceof ForbiddenError))throw error;await requireAdvertisingAccount(tx,current,row.accountId,advertisingCommandPermission(row.kind),true);}
  }
  private async summary(tx:TenantTransaction,current:TenantContext,row:Metadata){
    await this.readAuthority(tx,current,row);let result=null;
    if(row.status==="succeeded"){
      const [proof]=await tx.select({id:advertisingOriginalWriteProofs.resultId,parentId:advertisingOriginalWriteProofs.parentId,version:advertisingOriginalWriteProofs.version,
        actor:advertisingOriginalWriteProofs.actorId,accountId:advertisingOriginalWriteProofs.accountId}).from(advertisingOriginalWriteProofs)
        .where(and(eq(advertisingOriginalWriteProofs.commandId,row.id),eq(advertisingOriginalWriteProofs.kind,row.kind),eq(advertisingOriginalWriteProofs.resultId,row.resultId!))).limit(1);
      if(!proof||proof.actor!==current.userId||proof.accountId!==row.accountId||proof.parentId!==row.parentId||proof.version!==row.version)
        conflict("advertising_command_result_unavailable","真实原结果凭据暂不可核对 不会补造成功");
      result=AdCommandResultSchema.parse({kind:row.kind,id:proof.id,parentId:proof.parentId,version:proof.version});
    }
    return AdCommandSummarySchema.parse({id:row.id,accountId:row.accountId,kind:row.kind,targetId:row.targetId,scopeKey:row.scopeKey,status:row.status,requestKey:row.requestKey,
      createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),completedAt:row.completedAt?.toISOString()??null,acknowledged:Boolean(row.acknowledgedAt),
      originalRetained:row.originalRetained,result,contextAuthority:advertisingContextAuthority(current)});
  }
  private async detail(tx:TenantTransaction,current:TenantContext,row:Metadata,known?:{original:PrepareAdCommand;authority:TenantContext}){
    const summary=await this.summary(tx,current,row);let blockReason:AdCommandDetail["blockReason"]=row.status==="expired"?"expired":null;
    if(row.status==="prepared")try{
      if(!row.originalRetained)throw new OriginalUnavailable();
      const retained=known?null:await this.privateInput(tx,current,row.id,row.accountId),authority=known?.authority??this.authority(row,retained!);
      const ceiling=intersectPermissionContexts(authority,current);authorize(ceiling,advertisingCommandPermission(row.kind));
      const original=known?.original??await this.decrypt(row,retained!);
      if(this.owner.binding(original).ownerInputChecksum!==row.ownerInputChecksum)throw new ConflictException("原准备依据已变化");
      await this.owner.validateInTransaction(tx,ceiling,original);
    }catch(error){if(error instanceof OriginalUnavailable)blockReason="input_unavailable";else if(error instanceof ForbiddenError)blockReason="permission_denied";
      else if(error instanceof ConflictException||error instanceof NotFoundException||error instanceof UnprocessableEntityException)blockReason="basis_changed";else throw error;}
    return AdCommandDetailSchema.parse({...summary,blockReason,canExecute:row.status==="prepared"&&row.originalRetained&&blockReason===null,
      canCancel:row.status==="prepared",canAcknowledge:row.status!=="prepared"&&!row.acknowledgedAt});
  }
  private authority(row:Metadata,retained:PrivateInput){const result=TenantContextSchema.safeParse(retained.authoritySnapshot);if(!result.success||result.data.tenantId!==row.tenantId||result.data.userId!==row.createdBy)throw new OriginalUnavailable();return result.data;}
  private async decrypt(row:Metadata,retained:PrivateInput){
    if(!row.originalRetained||!retained.encryptedInput||row.contractVersion!==AD_COMMAND_CONTRACT)throw new OriginalUnavailable();this.authority(row,retained);
    let envelope:z.infer<typeof envelopeSchema>;
    try{envelope=this.vault.withSecret(retained.encryptedInput,value=>{if(Buffer.byteLength(value,"utf8")>AD_COMMAND_MAX_PLAINTEXT_BYTES)throw new OriginalUnavailable();return envelopeSchema.parse(JSON.parse(value));});}
    catch{throw new OriginalUnavailable();}
    const original=envelope.original;
    if(envelope.tenantId!==row.tenantId||envelope.createdBy!==row.createdBy||envelope.commandId!==row.id||original.kind!==row.kind||original.accountId!==row.accountId
      ||original.targetId!==row.targetId||adCommandScopeKey(original)!==row.scopeKey||original.input.idempotencyKey!==row.requestKey||advertisingCommandChecksum(original)!==row.requestChecksum)throw new OriginalUnavailable();
    return original;
  }
  private async privateInput(tx:TenantTransaction,current:TenantContext,id:string,accountId:string):Promise<PrivateInput>{
    const [row]=await tx.select({authoritySnapshot:commands.authoritySnapshot,encryptedInput:commands.encryptedInput}).from(commands)
      .where(and(eq(commands.id,id),eq(commands.accountId,accountId),eq(commands.createdBy,current.userId))).limit(1);if(!row)missing();return row;
  }
  private async currentRow(tx:TenantTransaction,current:TenantContext,id:string,accountId:string){
    const [before]=await tx.select(metadataColumns).from(commands).where(and(eq(commands.id,id),eq(commands.accountId,accountId),eq(commands.createdBy,current.userId))).limit(1);if(!before)missing();
    await keyLock(tx,before.kind,before.accountId,before.targetId,before.requestKey);await this.row(tx,current,id,accountId);
    await expireAdvertisingCommandInputs(tx,{actorId:current.userId,commandId:id,limit:1});return this.row(tx,current,id,accountId);
  }
  private async row(tx:TenantTransaction,current:TenantContext,id:string,accountId:string):Promise<Metadata>{
    const [row]=await tx.select(metadataColumns).from(commands).where(and(eq(commands.id,id),eq(commands.accountId,accountId),eq(commands.createdBy,current.userId))).for("update").limit(1);if(!row)missing();return row;
  }
  private withCurrent<T>(context:TenantContext,apply:(tx:TenantTransaction,current:TenantContext)=>Promise<T>){
    return retryDatabaseTimeRollback(()=>withTenant(this.database.db,context,async tx=>{const current=await currentAdvertisingAuthority(tx,context);requireAnyAdvertisingPermission(current);return apply(tx,current);}),"advertising_commands_time");
  }
  private record(tx:TenantTransaction,current:TenantContext,row:Metadata,action:"prepare"|"cancel"|"acknowledge"){
    return this.audit.recordInTransaction(tx,current,{action:`advertising.command.${action}`,resourceType:"advertising_command",resourceId:row.id,result:"success",metadata:{kind:row.kind,resultId:row.resultId}});
  }
}
async function keyLock(tx:TenantTransaction,kind:string,accountId:string,targetId:string|null,key:string){await tx.execute(sql`select ad_command_key_lock(${kind},${accountId}::uuid,${targetId}::uuid,${key})`);}
