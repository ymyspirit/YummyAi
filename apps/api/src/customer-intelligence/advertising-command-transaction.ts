import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";
import {ConflictException} from "@nestjs/common";
import {authorize,intersectPermissionContexts} from "@yummyai/authz";
import {TenantContextSchema,type TenantContext} from "@yummyai/contracts";
import {canonicalAdCommandOriginal,type PrepareAdCommand,type AdCommandKind} from "@yummyai/contracts/advertising/command";
import {advertisingCommands,advertisingOriginalWriteProofs,type TenantTransaction} from "@yummyai/database";
import {and,eq,sql} from "drizzle-orm";
import type {AuditService} from "../audit/audit.service.js";
import {requireAdvertisingAccount} from "./advertising-authority.js";
import {agentAdvertisingCommandPermission} from "@yummyai/workflow-core";

const execution=new AsyncLocalStorage<{id:string;requestChecksum:string}>();
export class AdvertisingCommandSettled extends Error{}
export function runAdvertisingCommand<T>(id:string,requestChecksum:string,apply:()=>Promise<T>){return execution.run({id,requestChecksum},apply);}
export const advertisingCommandChecksum=(original:PrepareAdCommand)=>createHash("sha256").update(canonicalAdCommandOriginal(original)).digest("hex");
export function advertisingCommandPermission(kind:AdCommandKind){return agentAdvertisingCommandPermission(kind);}
export async function advertisingCommandKeyLock(tx:TenantTransaction,original:Pick<PrepareAdCommand,"kind"|"accountId"|"targetId"|"input">){
  await tx.execute(sql`select ad_command_key_lock(${original.kind},${original.accountId}::uuid,${original.targetId}::uuid,${original.input.idempotencyKey})`);
}
/** Also used around import I/O checks. These short transactions never finish a command. */
export async function advertisingCommandAuthority(tx:TenantTransaction,current:TenantContext,original:PrepareAdCommand){
  await advertisingCommandKeyLock(tx,original);
  const pending=execution.getStore();
  if(pending){
    const [row]=await tx.select({id:advertisingCommands.id,tenantId:advertisingCommands.tenantId,createdBy:advertisingCommands.createdBy,
      accountId:advertisingCommands.accountId,kind:advertisingCommands.kind,targetId:advertisingCommands.targetId,status:advertisingCommands.status,
      requestChecksum:advertisingCommands.requestChecksum,authority:advertisingCommands.authoritySnapshot,
      available:sql<boolean>`${advertisingCommands.encryptedInput} is not null and ${advertisingCommands.redactedAt} is null and ${advertisingCommands.expiresAt}>advertising_command_now()`})
      .from(advertisingCommands).where(eq(advertisingCommands.id,pending.id)).for("update").limit(1);
    if(!row||row.tenantId!==current.tenantId||row.createdBy!==current.userId||row.accountId!==original.accountId||row.kind!==original.kind
      ||row.targetId!==original.targetId||row.requestChecksum!==pending.requestChecksum||advertisingCommandChecksum(original)!==pending.requestChecksum)
      throw new ConflictException({code:"advertising_command_original_mismatch",message:"原提交与固定账户或填写不一致"});
    if(row.status!=="prepared")throw new AdvertisingCommandSettled();
    if(!row.available)throw new ConflictException({code:"advertising_command_expired",message:"原填写已到期 请读取原状态核对"});
    const authority=TenantContextSchema.parse(row.authority);
    if(authority.tenantId!==current.tenantId||authority.userId!==current.userId)throw new ConflictException("原提交权限依据不可用");
    current=intersectPermissionContexts(authority,current);
    authorize(current,advertisingCommandPermission(original.kind));
    await tx.execute(sql`select set_config('app.advertising_command_id',${row.id},true)`);
  }
  try{await tx.execute(sql`select ad_command_assert_request(${original.kind},${original.accountId}::uuid,${original.targetId}::uuid,${original.input.idempotencyKey})`);}
  catch(error){
    const seen=new Set<unknown>();
    for(let cursor:unknown=error;cursor&&typeof cursor==="object"&&!seen.has(cursor);){
      seen.add(cursor);const value=cursor as {code?:unknown;message?:unknown;cause?:unknown};
      if(value.code==="23514"&&value.message==="advertising_original_owner_admission_invalid")
        throw new ConflictException({code:"advertising_command_transport_required",message:"原请求键已绑定原提交 请读取同一记录核对结果"});
      cursor=value.cause;
    }
    throw error;
  }
  await requireAdvertisingAccount(tx,current,original.accountId,advertisingCommandPermission(original.kind),["action_transition","import_archive","export_seal"].includes(original.kind));
  return current;
}
/** Existing owners keep their algorithms. Real owner evidence and both audits commit with success. */
export async function advertisingCommandWrite<T>(tx:TenantTransaction,current:TenantContext,original:PrepareAdCommand,apply:(ceiling:TenantContext)=>Promise<T>,audit:AuditService){
  const ceiling=await advertisingCommandAuthority(tx,current,original),result=await apply(ceiling),pending=execution.getStore();
  if(!pending)return result;
  const [proof]=await tx.select().from(advertisingOriginalWriteProofs).where(and(eq(advertisingOriginalWriteProofs.commandId,pending.id),eq(advertisingOriginalWriteProofs.kind,original.kind))).limit(1);
  const [transaction]=await tx.execute<{id:string}>(sql`select pg_current_xact_id()::text as id`);
  if(!proof||proof.creationTransactionId!==transaction?.id||proof.actorId!==ceiling.userId||proof.accountId!==original.accountId)
    throw new ConflictException({code:"advertising_command_actual_result_missing",message:"没有核对到本事务真实原写入结果"});
  const [binding]=await tx.execute<{value:{ownerInputChecksum:string}}>(sql`select ad_command_result_binding(${original.kind},${proof.resultId}::uuid) as value`);
  const [command]=await tx.select({checksum:advertisingCommands.ownerInputChecksum}).from(advertisingCommands).where(eq(advertisingCommands.id,pending.id)).limit(1);
  if(!binding?.value||binding.value.ownerInputChecksum!==command?.checksum)throw new ConflictException({code:"advertising_command_basis_changed",message:"实际写入与准备时固定依据不一致 本次未提交"});
  const [saved]=await tx.update(advertisingCommands).set({status:"succeeded",resultId:proof.resultId,parentId:proof.parentId,version:proof.version,completedAt:sql`advertising_command_now()`})
    .where(and(eq(advertisingCommands.id,pending.id),eq(advertisingCommands.status,"prepared"))).returning({id:advertisingCommands.id});
  if(!saved)throw new ConflictException("原提交状态已变化");
  await audit.recordInTransaction(tx,ceiling,{action:"advertising.command.execute",resourceType:"advertising_command",resourceId:pending.id,result:"success",
    metadata:{kind:original.kind,resultId:proof.resultId}});
  return result;
}
