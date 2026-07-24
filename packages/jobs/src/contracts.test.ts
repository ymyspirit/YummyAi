import { describe, expect, it } from "vitest";

import { CustomizationFileScanJobPayloadSchema, FulfillmentAutomationJobPayloadSchema, JobEnvelopeSchema, MarketplacePublicationBatchJobPayloadSchema, MarketplacePublicationReconciliationJobPayloadSchema, OrderIngestionJobPayloadSchema, QueueName, ShipmentWritebackJobPayloadSchema } from "./index.js";

const id = "019b0000-0000-7000-8000-000000000001";

describe("job contracts", () => {
  it("accepts a retryable tenant-scoped envelope", () => {
    expect(
      JobEnvelopeSchema.parse({
        jobId: id,
        tenantId: id,
        requestedBy: id,
        traceId: "0123456789abcdef0123456789abcdef",
        correlationId: id,
        idempotencyKey: id,
        attempt: 1,
        maxAttempts: 3,
        payload: { assetId: id },
      }),
    ).toMatchObject({ traceId: "0123456789abcdef0123456789abcdef", attempt: 1, maxAttempts: 3 });
  });

  it("rejects a retry attempt beyond the configured maximum", () => {
    expect(
      JobEnvelopeSchema.safeParse({
        jobId: id,
        tenantId: id,
        requestedBy: id,
        traceId: "0123456789abcdef0123456789abcdef",
        correlationId: id,
        idempotencyKey: id,
        attempt: 4,
        maxAttempts: 3,
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("creates a W3C-compatible trace ID when an enqueue boundary omits one", () => {
    const parsed = JobEnvelopeSchema.parse({ jobId: id, tenantId: id, requestedBy: id, correlationId: id, idempotencyKey: id, payload: {} });
    expect(parsed.traceId).toMatch(/^[a-f0-9]{32}$/);
  });

  it("exposes stable queue names", () => {
    expect(QueueName.Capture).toBe("capture");
    expect(QueueName.AiAnalysis).toBe("ai-analysis");
    expect(QueueName.Publication).toBe("publication");
    expect(QueueName.PublicationBatch).toBe("publication-batch");
    expect(QueueName.PublicationReconciliation).toBe("publication-reconciliation");
    expect(QueueName.OrderIngestion).toBe("order-ingestion");
    expect(QueueName.CustomizationFileScan).toBe("customization-file-scan");
    expect(QueueName.ShipmentWriteback).toBe("shipment-writeback");
    expect(QueueName.FulfillmentAutomation).toBe("fulfillment-automation");
  });

  it("keeps order ingestion jobs identifier-only", () => {
    expect(OrderIngestionJobPayloadSchema.safeParse({ snapshotId: id, accountId: id }).success).toBe(true);
    expect(OrderIngestionJobPayloadSchema.safeParse({ snapshotId: id, accountId: id, buyer: { email: "buyer@example.test" }, shippingAddress: "secret" }).success).toBe(false);
  });

  it("keeps customization scan jobs identifier-only", () => {
    expect(CustomizationFileScanJobPayloadSchema.safeParse({ intakeId: id }).success).toBe(true);
    expect(CustomizationFileScanJobPayloadSchema.safeParse({ intakeId: id, objectKey: "private/key", fileName: "buyer.png" }).success).toBe(false);
  });

  it("keeps shipment writeback jobs identifier-only", () => {
    expect(ShipmentWritebackJobPayloadSchema.safeParse({ writebackRequestId: id }).success).toBe(true);
    expect(ShipmentWritebackJobPayloadSchema.safeParse({ writebackRequestId: id, trackingNumber: "secret" }).success).toBe(false);
  });

  it("keeps fulfillment automation jobs identifier-only", () => {
    expect(FulfillmentAutomationJobPayloadSchema.safeParse({ taskId: id }).success).toBe(true);
    expect(FulfillmentAutomationJobPayloadSchema.safeParse({ taskId: id, reason: "private customer message" }).success).toBe(false);
  });

  it("keeps publication reconciliation jobs identifier-only", () => {
    expect(MarketplacePublicationReconciliationJobPayloadSchema.safeParse({ publicationRequestId: id }).success).toBe(true);
    expect(MarketplacePublicationReconciliationJobPayloadSchema.safeParse({ publicationRequestId: id, externalListingId: "secret" }).success).toBe(false);
  });

  it("keeps publication batch jobs identifier-only", () => {
    expect(MarketplacePublicationBatchJobPayloadSchema.safeParse({ publicationBatchId: id }).success).toBe(true);
    expect(MarketplacePublicationBatchJobPayloadSchema.safeParse({ publicationBatchId: id, items: [{ sku: "secret" }] }).success).toBe(false);
  });
});
