import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  createQueue,
  createTraceId,
  enqueueJob,
  MarketplacePublicationReconciliationJobPayloadSchema,
  QueueName,
  type JobEnvelope,
} from "@yummyai/jobs";

import type {
  MarketplacePublicationProcessor,
  MarketplacePublicationReconciliationScheduler,
  PublicationExecutionRepository,
} from "./marketplace-publication.processor.js";

const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1_000;
const RECONCILIATION_MAX_ATTEMPTS = 20;

export class RedisMarketplacePublicationReconciliationScheduler
implements MarketplacePublicationReconciliationScheduler {
  private readonly queue = createQueue(QueueName.PublicationReconciliation);

  async schedule(context: TenantContext, publicationRequestId: string): Promise<void> {
    await enqueueJob(this.queue, "marketplace-publication.reconcile", {
      attempt: 0,
      correlationId: publicationRequestId,
      idempotencyKey: publicationRequestId,
      jobId: createEntityId(),
      maxAttempts: RECONCILIATION_MAX_ATTEMPTS,
      payload: { publicationRequestId },
      requestedAt: new Date().toISOString(),
      requestedBy: context.userId,
      tenantId: context.tenantId,
      traceId: createTraceId(),
    }, {
      backoff: { type: "fixed", delay: RECONCILIATION_INTERVAL_MS },
      delay: RECONCILIATION_INTERVAL_MS,
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class MarketplacePublicationReconciliationProcessor {
  constructor(
    private readonly publication: Pick<MarketplacePublicationProcessor, "process">,
    private readonly repository: PublicationExecutionRepository,
  ) {}

  async process(envelope: JobEnvelope): Promise<{ requestId: string; status: string }> {
    const payload = MarketplacePublicationReconciliationJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };

    try {
      // Keep safe reads retryable on the final BullMQ attempt so exhaustion is
      // recorded as reconciliation evidence instead of a generic failure.
      return await this.publication.process({ ...envelope, maxAttempts: envelope.maxAttempts + 1 });
    } catch (error) {
      if (envelope.attempt + 1 < envelope.maxAttempts) throw error;
      await this.repository.fail(context, payload.publicationRequestId, {
        status: "reconciliation_required",
        code: "PUBLICATION_RECONCILIATION_EXHAUSTED",
        message: "Marketplace status did not converge within the background reconciliation window; manual reconciliation is required",
        retryable: false,
      });
      return { requestId: payload.publicationRequestId, status: "reconciliation_required" };
    }
  }
}
