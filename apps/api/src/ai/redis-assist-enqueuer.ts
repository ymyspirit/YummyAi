import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { AssistEnqueuer } from "./assist.service.js";

@Injectable()
export class RedisAssistEnqueuer extends AssistEnqueuer implements OnModuleDestroy {
  private readonly queue = createQueue(QueueName.AiAssist);
  async enqueue(input: { id: string; tenantId: string; userId: string; expiresAt: Date }) {
    const common = {
      attempt: 0,
      correlationId: input.id,
      maxAttempts: 1,
      requestedAt: new Date().toISOString(),
      requestedBy: input.userId,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    };
    // Retention is queued first, including for failed submissions. Queue payloads contain IDs only.
    const expirationId = createEntityId();
    await enqueueJob(
      this.queue,
      "assist.expire",
      {
        ...common,
        jobId: expirationId,
        idempotencyKey: expirationId,
        payload: { runId: input.id, operation: "expire" },
      },
      { delay: Math.max(0, input.expiresAt.getTime() - Date.now()) },
    );
    await enqueueJob(this.queue, "assist.analyze", {
      ...common,
      jobId: input.id,
      idempotencyKey: input.id,
      payload: { runId: input.id, operation: "analyze" },
    });
  }
  async onModuleDestroy() {
    await this.queue.close();
  }
}
