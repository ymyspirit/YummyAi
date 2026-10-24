import type { JobEnvelope } from "@yummyai/jobs";
import { LogisticsJobPayloadSchema } from "@yummyai/jobs";
import { Permission } from "@yummyai/authz";
import type { LogisticsExecutor } from "@yummyai/logistics";
export class LogisticsProcessor {
  constructor(private readonly executor: LogisticsExecutor) {}
  process(envelope: JobEnvelope) {
    const payload=LogisticsJobPayloadSchema.parse(envelope.payload);
    const context={tenantId:envelope.tenantId,userId:envelope.requestedBy,dataScope:"tenant" as const,permissions:[Permission.OrderRead,Permission.OrderPiiRead,Permission.AssetRead]};
    return payload.mode==="retention"?this.executor.purge(context,payload.taskId):this.executor.run(context,payload.taskId,payload.mode);
  }
}
