import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AmazonOrderReportProcessingJobPayloadSchema, createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

export abstract class AmazonReportProcessingEnqueuer {
  abstract schedule(context: TenantContext, batchId: string, dispatchId?: string): Promise<void>;
}

@Injectable()
export class RedisAmazonReportProcessingEnqueuer extends AmazonReportProcessingEnqueuer implements OnModuleDestroy {
  private readonly queue = createQueue(QueueName.AmazonOrderReportProcessing);

  async schedule(context: TenantContext, batchId: string, dispatchId?: string): Promise<void> {
    await enqueueJob(this.queue, "amazon-order-report.process", {
      attempt: 0, correlationId: batchId, idempotencyKey: dispatchId ?? batchId, jobId: createEntityId(), maxAttempts: 20,
      payload: AmazonOrderReportProcessingJobPayloadSchema.parse({ batchId, dispatchId }), requestedAt: new Date().toISOString(),
      requestedBy: context.userId, tenantId: context.tenantId, traceId: createTraceId(),
    }, { delay: 1_000, backoff: { type: "provider-aware" } });
  }

  async onModuleDestroy(): Promise<void> { await this.queue.close(); }
}
