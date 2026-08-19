import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { PodArtworkEnqueuer } from "./pod-artwork-task.service.js";

@Injectable()
export class RedisPodArtworkEnqueuer implements PodArtworkEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.PodArtwork);

  async enqueue(input: { taskId: string; tenantId: string; requestedBy: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "pod-artwork.execute", {
      attempt: 0,
      correlationId: input.taskId,
      idempotencyKey: input.taskId,
      jobId: createEntityId(),
      maxAttempts: input.maxAttempts,
      payload: { taskId: input.taskId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "provider-aware", delay: 5_000 } });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
