import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { PersonalizationTemplateSourceInspectionEnqueuer } from "./pod-personalization.service.js";

@Injectable()
export class RedisPersonalizationTemplateSourceInspectionEnqueuer
implements PersonalizationTemplateSourceInspectionEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.PersonalizationTemplateSourceInspection);

  async enqueue(input: { inspectionId: string; tenantId: string; requestedBy: string; maxAttempts: number }) {
    await enqueueJob(this.queue, "pod.personalization_template_source.inspect", {
      attempt: 0,
      correlationId: input.inspectionId,
      idempotencyKey: input.inspectionId,
      jobId: createEntityId(),
      maxAttempts: input.maxAttempts,
      payload: { inspectionId: input.inspectionId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "provider-aware", delay: 5_000 } });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
