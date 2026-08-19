import type { TenantContext } from "@yummyai/contracts";
import { OrderIngestionJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";

export interface OrderIngestionResult {
  orderId: string;
  replayed: boolean;
}

export interface OrderIngestionRepository {
  materialize(context: TenantContext, snapshotId: string, accountId: string): Promise<OrderIngestionResult>;
}

export class OrderIngestionProcessor {
  constructor(private readonly repository: OrderIngestionRepository) {}

  async process(envelope: JobEnvelope): Promise<OrderIngestionResult> {
    const payload = OrderIngestionJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };
    return this.repository.materialize(context, payload.snapshotId, payload.accountId);
  }
}
