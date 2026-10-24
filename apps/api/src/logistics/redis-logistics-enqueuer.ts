import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { LogisticsEnqueuer } from "./logistics.service.js";
@Injectable()
export class RedisLogisticsEnqueuer extends LogisticsEnqueuer implements OnModuleDestroy {
  private readonly queue=createQueue(QueueName.Logistics);
  async enqueue(input: {taskId:string;tenantId:string;requestedBy:string;mode:"quote"|"purchase"|"reconcile"|"retention";requestKey:string;delayMs?:number}) {
    await enqueueJob(this.queue,"logistics.execute",{attempt:0,correlationId:input.taskId,idempotencyKey:logisticsJobKey(input),jobId:createEntityId(),maxAttempts:3,payload:{taskId:input.taskId,mode:input.mode},requestedAt:new Date().toISOString(),requestedBy:input.requestedBy,tenantId:input.tenantId,traceId:createTraceId()},{delay:input.delayMs});
  }
  async onModuleDestroy() {await this.queue.close();}
}
// Preserve the task's UUIDv7 timestamp while deriving a stable queue identity.
export function logisticsJobKey(input: {taskId:string;tenantId:string;mode:string;requestKey:string}) {
  const digest=createHash("sha256").update(JSON.stringify([input.tenantId,input.taskId,input.mode,input.requestKey])).digest("hex");
  const hex=`${input.taskId.replaceAll("-","").slice(0,12)}7${digest.slice(0,3)}8${digest.slice(3,18)}`;
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
