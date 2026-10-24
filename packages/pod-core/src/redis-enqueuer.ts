import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import type { PodArtworkEnqueuer } from "./artwork-task.js";

export class RedisPodArtworkDispatcher implements PodArtworkEnqueuer {
  private readonly queue = createQueue(QueueName.PodArtwork);
  async enqueue(input: {
    taskId: string;
    tenantId: string;
    requestedBy: string;
    maxAttempts: number;
  }) {
    // A queued task can need delivery again after a paused delivery was acknowledged.
    // The database task remains the business identity and fences duplicate claims.
    const deliveryId = createEntityId();
    await enqueueJob(
      this.queue,
      "pod-artwork.execute",
      {
        attempt: 0,
        correlationId: input.taskId,
        idempotencyKey: deliveryId,
        jobId: deliveryId,
        maxAttempts: input.maxAttempts,
        payload: { taskId: input.taskId },
        requestedAt: new Date().toISOString(),
        requestedBy: input.requestedBy,
        tenantId: input.tenantId,
        traceId: createTraceId(),
      },
      { backoff: { type: "provider-aware", delay: 5_000 } },
    );
  }
  async close() {
    await this.queue.close();
  }
  async onModuleDestroy() {
    await this.close();
  }
}
