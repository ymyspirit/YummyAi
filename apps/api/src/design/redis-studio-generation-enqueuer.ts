import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { StudioGenerationEnqueuer } from "./studio-generation.service.js";

@Injectable()
export class RedisStudioGenerationEnqueuer extends StudioGenerationEnqueuer implements OnModuleDestroy {
  private readonly queue = createQueue(QueueName.StudioGeneration);
  async enqueue(input: { id: string; tenantId: string; userId: string }) {
    await enqueueJob(this.queue, "studio.generate", { attempt: 0, correlationId: input.id, idempotencyKey: input.id, jobId: input.id, maxAttempts: 1, payload: { generationId: input.id }, requestedAt: new Date().toISOString(), requestedBy: input.userId, tenantId: input.tenantId, traceId: createTraceId() ?? createEntityId() });
  }
  async onModuleDestroy() { await this.queue.close(); }
}
