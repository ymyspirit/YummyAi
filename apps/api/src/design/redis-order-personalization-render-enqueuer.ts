import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { OrderPersonalizationRenderEnqueuer } from "./order-personalization-render.service.js";

@Injectable()
export class RedisOrderPersonalizationRenderEnqueuer implements OrderPersonalizationRenderEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.OrderPersonalizationRender);

  async enqueue(input: { renderTaskId: string; tenantId: string; requestedBy: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "pod.order_personalization.render", {
      attempt: 0,
      correlationId: input.renderTaskId,
      idempotencyKey: input.renderTaskId,
      jobId: createEntityId(),
      maxAttempts: input.maxAttempts,
      payload: { renderTaskId: input.renderTaskId },
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
