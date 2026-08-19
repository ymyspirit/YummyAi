import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { FulfillmentAutomationEnqueuer } from "./fulfillment-automation.service.js";

@Injectable()
export class RedisFulfillmentAutomationEnqueuer implements FulfillmentAutomationEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.FulfillmentAutomation);
  async enqueue(input: { taskId: string; deliveryId: string; tenantId: string; requestedBy: string; runAt: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "fulfillment-automation.execute", {
      attempt: 0, correlationId: input.taskId, idempotencyKey: input.deliveryId, jobId: createEntityId(), maxAttempts: input.maxAttempts,
      payload: { taskId: input.taskId }, requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId(),
    }, { delay: Math.max(0, new Date(input.runAt).getTime() - Date.now()), backoff: { type: "exponential", delay: 5_000 } });
  }
  async onModuleDestroy() { await this.queue.close(); }
}
