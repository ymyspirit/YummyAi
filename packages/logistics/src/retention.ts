import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { logisticsTasks as tasks,logisticsLabels as labels,orders,withTenant,type DatabaseConnection } from "@yummyai/database";
import { and,eq,lte,ne,or } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
/** Erase private delivery data while preserving the immutable commercial index. */
export async function purgeLogisticsTasks(database:DatabaseConnection,context:TenantContext,storage:Storage,now=new Date(),taskId?:string) {
  const expired=await withTenant(database.db,context,async tx=>{
    const rows=await tx.select({id:tasks.id}).from(tasks).innerJoin(orders,eq(orders.id,tasks.orderId)).where(and(taskId?eq(tasks.id,taskId):undefined,or(lte(tasks.expiresAt,now),ne(orders.addressStatus,"protected"))));
    for(const row of rows)await tx.update(tasks).set({encryptedSnapshot:null,trackingNumbers:[],processingRunId:null,leaseUntil:null,updatedAt:now}).where(eq(tasks.id,row.id));
    return rows;
  });
  const maintenance={...context,permissions:[...context.permissions,Permission.AssetRead]};
  for(const task of expired){
    const files=await withTenant(database.db,context,tx=>tx.select().from(labels).where(eq(labels.taskId,task.id)));
    for(const file of files){await storage.discardLogisticsLabel(maintenance,task.id,file.objectKey);await withTenant(database.db,context,tx=>tx.delete(labels).where(and(eq(labels.id,file.id),eq(labels.taskId,task.id))));}
  }
  return {purgedTaskIds:expired.map(t=>t.id)};
}
