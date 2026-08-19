import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";

import type { PodBatchWorkflowEnqueuer } from "./pod-batch-workflow.service.js";

@Injectable()
export class RedisPodBatchWorkflowEnqueuer implements PodBatchWorkflowEnqueuer, OnModuleDestroy {
  private readonly creativeDesignQueue = createQueue(QueueName.CreativeDesign);
  private readonly adaptationQueue = createQueue(QueueName.CreativeDesignAdaptation);
  private readonly templateCompileQueue = createQueue(QueueName.MockupTemplateCompile);
  private readonly mockupRenderQueue = createQueue(QueueName.MockupRender);

  enqueueCreativeCandidate(input: { candidateId: string; tenantId: string; requestedBy: string }) {
    return this.enqueue(this.creativeDesignQueue, "creative-design.generate", input.candidateId, input);
  }

  enqueueCreativeAdaptation(input: { creativeDesignVersionId: string; tenantId: string; requestedBy: string }) {
    return this.enqueue(this.adaptationQueue, "creative-design.adapt", input.creativeDesignVersionId, input);
  }

  enqueueTemplateCompile(input: { inspectionId: string; tenantId: string; requestedBy: string }) {
    return this.enqueue(this.templateCompileQueue, "mockup-template.compile", input.inspectionId, input);
  }

  enqueueMockupRender(input: { itemId: string; tenantId: string; requestedBy: string }) {
    return this.enqueue(this.mockupRenderQueue, "mockup.render", input.itemId, input);
  }

  async onModuleDestroy() {
    await Promise.all([
      this.creativeDesignQueue.close(),
      this.adaptationQueue.close(),
      this.templateCompileQueue.close(),
      this.mockupRenderQueue.close(),
    ]);
  }

  private async enqueue(
    queue: ReturnType<typeof createQueue>,
    jobName: string,
    entityId: string,
    input: { tenantId: string; requestedBy: string },
  ) {
    const payloadKey = jobName === "creative-design.generate" ? "candidateId"
      : jobName === "creative-design.adapt" ? "creativeDesignVersionId"
        : jobName === "mockup-template.compile" ? "inspectionId"
          : "itemId";
    await enqueueJob(queue, jobName, {
      attempt: 0,
      correlationId: entityId,
      idempotencyKey: entityId,
      jobId: createEntityId(),
      maxAttempts: 3,
      payload: { [payloadKey]: entityId },
      requestedAt: new Date().toISOString(),
      requestedBy: input.requestedBy,
      tenantId: input.tenantId,
      traceId: createTraceId(),
    }, { backoff: { type: "exponential", delay: 5_000 } });
  }
}
