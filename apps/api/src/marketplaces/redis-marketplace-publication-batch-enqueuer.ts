import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { MarketplacePublicationBatchEnqueuer } from "./marketplace-publication-batch.service.js";

@Injectable()
export class RedisMarketplacePublicationBatchEnqueuer implements MarketplacePublicationBatchEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.PublicationBatch);

  async enqueue(input: { delayMs: number; publicationBatchId: string; requestedBy: string; tenantId: string }) {
    await enqueueJob(this.queue, "marketplace-publication-batch.execute", {
      attempt: 0,
      correlationId: input.publicationBatchId,
      idempotencyKey: input.publicationBatchId,
      jobId: createEntityId(),
      maxAttempts: 21,
      payload: { publicationBatchId: input.publicationBatchId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "provider-aware", delay: 15 * 60 * 1_000 }, delay: input.delayMs });
  }

  async cancel(publicationBatchId: string) {
    const job = await this.queue.getJob(publicationBatchId);
    await job?.remove();
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
