import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { OrderPersonalizationBatchEnqueuer } from "./order-personalization-batch.service.js";

@Injectable()
export class RedisOrderPersonalizationBatchEnqueuer implements OrderPersonalizationBatchEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.OrderPersonalizationBatch);

  async enqueue(input: { batchId: string; tenantId: string; requestedBy: string }) {
    await enqueueJob(this.queue, "pod.order_personalization.prepare", {
      attempt: 0,
      correlationId: input.batchId,
      idempotencyKey: input.batchId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: { batchId: input.batchId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
