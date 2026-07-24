import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { WebhookDeliveryEnqueuer } from "./integration.service.js";

@Injectable()
export class RedisWebhookDeliveryEnqueuer implements WebhookDeliveryEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.WebhookDelivery);
  async enqueue(input: { deliveryId: string; tenantId: string; requestedBy: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "webhook-delivery.execute", {
      attempt: 0, correlationId: input.deliveryId, idempotencyKey: input.deliveryId, jobId: createEntityId(), maxAttempts: input.maxAttempts,
      payload: { deliveryId: input.deliveryId }, requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }
  async onModuleDestroy() { await this.queue.close(); }
}
