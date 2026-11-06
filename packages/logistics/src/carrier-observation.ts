import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { YunexpressHandoverSchema, YunexpressPackageStatusSchema, type LogisticsCarrierObservation } from "@yummyai/contracts/logistics";
import { logisticsEvents, type TenantTransaction } from "@yummyai/database";

export const HANDOVER_POLL_MS = 30 * 60_000;
export function trackingCheckDue(observation:LogisticsCarrierObservation|null) {
  if (!observation) return true;
  if (observation.status==="D" && observation.proof || observation.status==="R" || observation.status==="C") return false;
  return Date.now()-Date.parse(observation.checkedAt)>=HANDOVER_POLL_MS;
}
export function trackingIdentity(task: {id:string; connectionVersionId:string; externalReference:string; providerOrderId:string|null; trackingNumbers:string[]}) {
  return createHash("sha256").update(JSON.stringify([task.id,task.connectionVersionId,task.externalReference,task.providerOrderId,...task.trackingNumbers])).digest("hex");
}
export async function readCarrierObservation(tx:TenantTransaction, taskId:string, identity:string):Promise<LogisticsCarrierObservation|null> {
  const rows=await tx.selectDistinctOn([logisticsEvents.action],{action:logisticsEvents.action,data:logisticsEvents.data,date:logisticsEvents.createdAt})
    .from(logisticsEvents).where(and(eq(logisticsEvents.taskId,taskId),sql`${logisticsEvents.data}->>'identity'=${identity}`,
      inArray(logisticsEvents.action,["tracking.check","tracking.result","tracking.handover","tracking.unavailable"])))
    .orderBy(asc(logisticsEvents.action),desc(logisticsEvents.createdAt),desc(logisticsEvents.id));
  const check=rows.find(row=>row.action==="tracking.check");
  if (!check) return null;
  const proof=rows.find(row=>row.action==="tracking.handover"), result=rows.find(row=>row.action==="tracking.result"), failure=rows.find(row=>row.action==="tracking.unavailable");
  return {checkedAt:check.date.toISOString(),verifiedAt:result?.date.toISOString()??null,status:result?YunexpressPackageStatusSchema.parse(result.data.status):null,
    proof:proof?YunexpressHandoverSchema.parse(proof.data.proof):null,diagnostic:failure && (!result || failure.date>=result.date)?"unavailable":null};
}
