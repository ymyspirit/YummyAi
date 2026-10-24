import type {Permission} from "@yummyai/authz";
import {agentFinanceCommandPermission} from "@yummyai/workflow-core";
import type {TenantContext} from "@yummyai/contracts";
import type {FinanceCommandKind} from "@yummyai/contracts/finance/finance-command";
import type {TenantTransaction} from "@yummyai/database";
import {financeCommands} from "@yummyai/database";
import {and,eq,sql} from "drizzle-orm";
import {ConflictException} from "@nestjs/common";

export function financeCommandPermission(kind:FinanceCommandKind):Permission {
  return agentFinanceCommandPermission(kind);
}
/** First lock for both raw transports and retained originals, before business locks. */
export async function financeCommandKeyLock(tx:TenantTransaction,context:TenantContext,kind:FinanceCommandKind,key:string){
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`finance-original:${context.tenantId}:${kind}:${key}`},0))`);
}

/** A retained key belongs to its command even after cancellation or confirmation. */
export async function financeCommandOwnerLock(tx:TenantTransaction,context:TenantContext,kind:FinanceCommandKind,key:string){
  await financeCommandKeyLock(tx,context,kind,key);
  const [row]=await tx.select({id:financeCommands.id,actor:financeCommands.createdBy,status:financeCommands.status,
    available:sql<boolean>`${financeCommands.encryptedInput} is not null and ${financeCommands.expiresAt}>clock_timestamp()`})
    .from(financeCommands).where(and(eq(financeCommands.kind,kind),eq(financeCommands.requestKey,key))).limit(1);
  const [setting]=await tx.execute<{id:string|null}>(sql`select nullif(current_setting('app.finance_command_id',true),'') as id`);
  if(row&&(row.id!==setting?.id||row.actor!==context.userId||row.status!=="prepared"||!row.available)||!row&&setting?.id)
    throw new ConflictException({code:"finance_original_transport_required",message:"原请求键已绑定财务原提交 请恢复同一记录核对结果"});
}
