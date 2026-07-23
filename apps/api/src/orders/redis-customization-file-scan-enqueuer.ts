import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { CustomizationFileScanEnqueuer } from "./order-customization.service.js";

@Injectable()
export class RedisCustomizationFileScanEnqueuer implements CustomizationFileScanEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.CustomizationFileScan);

  async enqueue(input: { intakeId: string; requestedBy: string; tenantId: string }) {
    const jobId = createEntityId();
    await enqueueJob(this.queue, "customization-file.scan", {
      attempt: 0,
      correlationId: input.intakeId,
      idempotencyKey: jobId,
      jobId,
      maxAttempts: 3,
      payload: { intakeId: input.intakeId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
