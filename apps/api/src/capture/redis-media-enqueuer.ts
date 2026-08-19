import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { CaptureMediaEnqueuer } from "./capture.service.js";

@Injectable()
export class RedisMediaEnqueuer implements CaptureMediaEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.Media);

  async enqueue(input: {
    mediaId: string;
    requestedBy: string;
    snapshotId: string;
    sourceUrl: string;
    tenantId: string;
  }) {
    await enqueueJob(this.queue, "capture-media.archive", {
      attempt: 0,
      correlationId: createEntityId(),
      idempotencyKey: input.mediaId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: input,
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
