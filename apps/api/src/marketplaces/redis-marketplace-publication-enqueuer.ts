import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { MarketplacePublicationEnqueuer } from "./marketplace-publication.service.js";

@Injectable()
export class RedisMarketplacePublicationEnqueuer implements MarketplacePublicationEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.Publication);

  async enqueue(input: { delayMs: number; publicationRequestId: string; requestedBy: string; tenantId: string }) {
    await enqueueJob(this.queue, "marketplace-publication.execute", {
      attempt: 0,
      correlationId: input.publicationRequestId,
      idempotencyKey: input.publicationRequestId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: { publicationRequestId: input.publicationRequestId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "provider-aware", delay: 5_000 }, delay: input.delayMs });
  }

  async cancel(publicationRequestId: string) {
    const job = await this.queue.getJob(publicationRequestId);
    await job?.remove();
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
