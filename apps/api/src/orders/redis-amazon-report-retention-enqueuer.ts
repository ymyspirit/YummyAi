import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AmazonOrderReportRetentionJobPayloadSchema, createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

export abstract class AmazonReportRetentionEnqueuer {
  abstract schedule(context: TenantContext, batchId: string, expiresAt: Date): Promise<void>;
}

@Injectable()
export class RedisAmazonReportRetentionEnqueuer extends AmazonReportRetentionEnqueuer implements OnModuleDestroy {
  private readonly queue = createQueue(QueueName.AmazonOrderReportRetention);

  async schedule(context: TenantContext, batchId: string, expiresAt: Date): Promise<void> {
    if (Number.isNaN(expiresAt.getTime())) throw new TypeError("A valid retention expiry is required");
    const payload = AmazonOrderReportRetentionJobPayloadSchema.parse({ batchId });
    await enqueueJob(this.queue, "amazon-order-report.retention", {
      attempt: 0, correlationId: batchId, idempotencyKey: batchId, jobId: createEntityId(), maxAttempts: 10,
      payload, requestedAt: new Date().toISOString(), requestedBy: context.userId, tenantId: context.tenantId, traceId: createTraceId(),
    }, { delay: Math.max(0, expiresAt.getTime() - Date.now()), backoff: { type: "provider-aware" } });
  }

  async onModuleDestroy(): Promise<void> { await this.queue.close(); }
}
