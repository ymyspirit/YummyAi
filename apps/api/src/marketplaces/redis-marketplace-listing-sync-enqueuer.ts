import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { MarketplaceListingSyncEnqueuer } from "./marketplace-listing-sync.service.js";

@Injectable()
export class RedisMarketplaceListingSyncEnqueuer implements MarketplaceListingSyncEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.ListingSync);

  async enqueue(input: { syncRequestId: string; requestedBy: string; tenantId: string }) {
    await enqueueJob(this.queue, "marketplace-listing-sync.execute", {
      attempt: 0,
      correlationId: input.syncRequestId,
      idempotencyKey: input.syncRequestId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: { syncRequestId: input.syncRequestId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
