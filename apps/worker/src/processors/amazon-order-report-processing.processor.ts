import { AmazonOrderReportProcessingJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { Permission } from "@yummyai/authz";
import type { AmazonReportBatchProcessor } from "@yummyai/order-intake";

export class AmazonOrderReportProcessingProcessor {
  constructor(private readonly processor: AmazonReportBatchProcessor) {}
  process(envelope: JobEnvelope) {
    const payload = AmazonOrderReportProcessingJobPayloadSchema.parse(envelope.payload);
    // An operation ceiling, never a membership grant. The shared archive claim
    // reloads the persisted requester before decrypting, downloading or adopting.
    return this.processor.process({ tenantId: envelope.tenantId, userId: envelope.requestedBy,
      permissions: [Permission.OrderWrite, Permission.OrderPiiRead], dataScope: "tenant",
    }, payload.batchId, payload.dispatchId);
  }
}
