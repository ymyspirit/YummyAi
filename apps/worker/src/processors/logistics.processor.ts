import type { JobEnvelope } from "@yummyai/jobs";
import { createHash } from "node:crypto";
import { LogisticsJobPayloadSchema } from "@yummyai/jobs";
import { Permission } from "@yummyai/authz";
import type { LogisticsExecutor } from "@yummyai/logistics";
export class LogisticsProcessor {
  constructor(private readonly executor: LogisticsExecutor,private readonly followup?:(envelope:JobEnvelope,delayMs:number)=>Promise<void>) {}
  async process(envelope: JobEnvelope) {
    const payload=LogisticsJobPayloadSchema.parse(envelope.payload);
    const context={tenantId:envelope.tenantId,userId:envelope.requestedBy,dataScope:"tenant" as const,permissions:[Permission.OrderRead,Permission.OrderPiiRead,Permission.AssetRead]};
    if(payload.mode==="retention")return this.executor.purge(context,payload.taskId);
    const result=await this.executor.run(context,payload.taskId,payload.mode);
    if("retryAfterMs" in result&&result.retryAfterMs&&this.followup)await this.followup(logisticsFollowupEnvelope(envelope),result.retryAfterMs);
    return result;
  }
}
export function logisticsFollowupEnvelope(envelope:JobEnvelope):JobEnvelope{
  const digest=createHash("sha256").update(`${envelope.tenantId}:${envelope.idempotencyKey}:label-poll`).digest("hex");
  const hex=`${envelope.jobId.replaceAll("-","").slice(0,12)}7${digest.slice(0,3)}8${digest.slice(3,18)}`;
  const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const payload=LogisticsJobPayloadSchema.parse(envelope.payload);
  return {...envelope,jobId:id,idempotencyKey:id,attempt:0,requestedAt:new Date().toISOString(),payload:{taskId:payload.taskId,mode:"reconcile"}};
}
