import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { ShipmentWritebackEnqueuer } from "./order-shipment.service.js";

@Injectable()
export class RedisShipmentWritebackEnqueuer implements ShipmentWritebackEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.ShipmentWriteback);

  async enqueue(input: { writebackRequestId: string; requestedBy: string; tenantId: string }) {
    await enqueueJob(this.queue, "shipment-writeback.execute", {
      attempt: 0, correlationId: input.writebackRequestId, idempotencyKey: input.writebackRequestId,
      jobId: createEntityId(), maxAttempts: 2, payload: { writebackRequestId: input.writebackRequestId },
      requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }

  async onModuleDestroy() { await this.queue.close(); }
}
