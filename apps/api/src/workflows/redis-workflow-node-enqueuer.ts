import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createEntityId } from "@yummyai/contracts";
import { QueueName, createQueue, createTraceId, enqueueJob } from "@yummyai/jobs";

import type { WorkflowNodeEnqueuer } from "./workflow-node.executor.js";

@Injectable()
export class RedisWorkflowNodeEnqueuer implements WorkflowNodeEnqueuer, OnModuleDestroy {
  private readonly queue = createQueue(QueueName.WorkflowNode);

  async enqueue(input: {
    tenantId: string;
    runId: string;
    nodeRunId: string;
    attemptId: string;
    requestedBy: string;
  }) {
    await enqueueJob(
      this.queue,
      "workflow-node.execute",
      {
        attempt: 0,
        correlationId: input.runId,
        idempotencyKey: input.attemptId,
        jobId: createEntityId(),
        maxAttempts: 3,
        payload: { runId: input.runId, nodeRunId: input.nodeRunId, attemptId: input.attemptId },
        requestedAt: new Date().toISOString(),
        requestedBy: input.requestedBy,
        tenantId: input.tenantId,
        traceId: createTraceId(),
      },
      { backoff: { type: "exponential", delay: 5_000 } },
    );
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
