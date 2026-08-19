import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { PodExportEnqueuer } from "./pod-export.service.js";

@Injectable()
export class RedisPodExportEnqueuer implements PodExportEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.PodExport);

  async enqueue(input: { exportId: string; tenantId: string; requestedBy: string }) {
    await enqueueJob(this.queue, "pod-export.build", {
      attempt: 0,
      correlationId: input.exportId,
      idempotencyKey: input.exportId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: { exportId: input.exportId },
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
