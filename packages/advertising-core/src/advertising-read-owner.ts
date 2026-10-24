import { authorize } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { AdHistoryQuerySchema,AdHistoryRecordQuerySchema,type AdHistoryQuery,type AdHistoryRecordQuery } from "@yummyai/contracts/advertising/history";
import { marketplaceAccounts,withTenant,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { and,eq,isNull } from "drizzle-orm";
import { advertisingAccess,currentAdvertisingAuthority,requireAnyAdvertisingPermission,type AdvertisingOperation } from "./advertising-authority.js";
import { listAdvertisingHistory,readAdvertisingHistory } from "./advertising-history.js";
export async function readAdvertisingAccounts(tx:TenantTransaction,current:TenantContext){
      const candidates = await tx
        .select()
        .from(marketplaceAccounts)
        .where(and(eq(marketplaceAccounts.platform, "amazon"), isNull(marketplaceAccounts.deletedAt)))
        .orderBy(marketplaceAccounts.displayName);
      const accounts = candidates.map((row) => ({ row, access: advertisingAccess(current, row.createdBy) }))
        .filter(({ access }) => Object.values(access).some(Boolean));

return accounts;}
export class AdvertisingReadOwner{
constructor(private readonly database:DatabaseConnection){}
private withCurrent<T>(context: TenantContext, operation: AdvertisingOperation | null,
    apply: (tx: TenantTransaction, current: TenantContext) => Promise<T>, immutableRead = false) {
    return withTenant(this.database.db, context, async (tx) => {
      const current = await currentAdvertisingAuthority(tx, context);
      if (operation) authorize(current, operation);
      else requireAnyAdvertisingPermission(current);
      return apply(tx, current);
    }, immutableRead ? { isolationLevel: "repeatable read", accessMode: "read write" } : undefined);
  }
async accounts(context:TenantContext){return this.withCurrent(context,null,async(tx,current)=>(await readAdvertisingAccounts(tx,current)).map(({row:a,access})=>({id:a.id,name:a.displayName,marketplaceIds:a.marketplaceIds,status:a.status,access})),true);}
async history(context:TenantContext,raw:AdHistoryQuery){
    const query=AdHistoryQuerySchema.parse(raw);
    return this.withCurrent(context,null,(tx,current)=>listAdvertisingHistory(tx,current,query),true);
  }
async record(context:TenantContext,id:string,raw:AdHistoryRecordQuery){
    const query=AdHistoryRecordQuerySchema.parse(raw);
    return this.withCurrent(context,null,(tx,current)=>readAdvertisingHistory(tx,current,id,query),true);
  }
}
