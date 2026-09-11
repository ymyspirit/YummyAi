import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { ProductionEditorRenderEnqueuer } from "./production-editor.service.js";

@Injectable()
export class RedisProductionEditorRenderEnqueuer extends ProductionEditorRenderEnqueuer implements OnModuleDestroy {
  private readonly queue = createQueue(QueueName.ProductionEditorRender);
  async enqueue(input: { renderId: string; tenantId: string; requestedBy: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "production-editor.render", { attempt: 0, correlationId: input.renderId, idempotencyKey: input.renderId, jobId: createEntityId(), maxAttempts: input.maxAttempts, payload: { renderId: input.renderId }, requestedAt: new Date().toISOString(), requestedBy: input.requestedBy, tenantId: input.tenantId, traceId: createTraceId() }, { backoff: { type: "exponential", delay: 5000 } });
  }
  async onModuleDestroy() { await this.queue.close(); }
}
