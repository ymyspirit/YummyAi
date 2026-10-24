import {Injectable,type OnModuleDestroy}from"@nestjs/common";
import {createEntityId}from"@yummyai/contracts";
import {createQueue,createTraceId,enqueueJob,QueueName}from"@yummyai/jobs";
import {AgentPlanDispatcher}from"./agent-plan.service.js";
@Injectable()
export class RedisAgentPlanDispatcher extends AgentPlanDispatcher implements OnModuleDestroy{
 private readonly queue=createQueue(QueueName.AgentPlan);
 async enqueue(input:{id:string;tenantId:string;userId:string;expiresAt:Date}){
  const common={attempt:0,correlationId:input.id,maxAttempts:1,requestedAt:new Date().toISOString(),requestedBy:input.userId,tenantId:input.tenantId,traceId:createTraceId()};
  const expirationId=createEntityId();
  await enqueueJob(this.queue,"agent-plan.expire",{...common,jobId:expirationId,idempotencyKey:expirationId,payload:{runId:input.id,operation:"expire"}},{delay:Math.max(0,input.expiresAt.getTime()-Date.now())});
  await enqueueJob(this.queue,"agent-plan.execute",{...common,jobId:input.id,idempotencyKey:input.id,payload:{runId:input.id,operation:"execute"}});
 }
 async onModuleDestroy(){await this.queue.close();}
}
