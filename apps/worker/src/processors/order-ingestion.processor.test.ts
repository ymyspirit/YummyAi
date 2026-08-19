import { createEntityId } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import { OrderIngestionProcessor, type OrderIngestionRepository } from "./order-ingestion.processor.js";

describe("order ingestion processor boundary", () => {
  it("passes only tenant and identifier context to the order materializer", async () => {
    const snapshotId = createEntityId(); const accountId = createEntityId(); const orderId = createEntityId();
    const repository: OrderIngestionRepository = { materialize: vi.fn(async () => ({ orderId, replayed: false })) };
    await expect(new OrderIngestionProcessor(repository).process(envelope({ snapshotId, accountId }))).resolves.toEqual({ orderId, replayed: false });
    expect(repository.materialize).toHaveBeenCalledWith(expect.objectContaining({ dataScope: "tenant" }), snapshotId, accountId);
  });

  it("rejects payloads containing protected customer fields", async () => {
    const repository: OrderIngestionRepository = { materialize: vi.fn(async () => ({ orderId: createEntityId(), replayed: false })) };
    await expect(new OrderIngestionProcessor(repository).process(envelope({ snapshotId: createEntityId(), accountId: createEntityId(), buyerEmail: "buyer@example.test" }))).rejects.toThrow();
    expect(repository.materialize).not.toHaveBeenCalled();
  });
});

function envelope(payload: Record<string, unknown>): JobEnvelope {
  const correlationId = createEntityId();
  return { jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(), correlationId, idempotencyKey: correlationId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3, payload };
}
