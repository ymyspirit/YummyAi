import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import { AmazonOrderReportRetentionProcessor, type AmazonOrderReportRetentionRepository } from "./amazon-order-report-retention.processor.js";

function envelope(): JobEnvelope {
  return { jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(), correlationId: createEntityId(), idempotencyKey: createEntityId(), requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 10, payload: { batchId: createEntityId() } };
}

function repository(expiresAt?: Date): AmazonOrderReportRetentionRepository {
  return { expiry: vi.fn(async () => expiresAt), purge: vi.fn(async () => undefined) };
}

describe("Amazon order report retention processor", () => {
  it("uses the trusted job tenant to resolve a batch and ignores invisible batches", async () => {
    const repo = repository();
    const job = envelope();
    expect(await new AmazonOrderReportRetentionProcessor(repo).process(job)).toEqual({ status: "ignored" });
    expect(repo.expiry).toHaveBeenCalledWith({ tenantId: job.tenantId, userId: job.requestedBy, permissions: [], dataScope: "tenant" } satisfies TenantContext, (job.payload as { batchId: string }).batchId);
    expect(repo.purge).not.toHaveBeenCalled();
  });

  it("does not erase before the persisted expiry and supplies retry timing", async () => {
    const repo = repository(new Date("2026-10-01T01:00:00Z"));
    await expect(new AmazonOrderReportRetentionProcessor(repo).process(envelope(), new Date("2026-10-01T00:00:00Z"))).rejects.toMatchObject({ message: "Amazon report retention is not due", retryAfterMs: 3_600_000 });
    expect(repo.purge).not.toHaveBeenCalled();
  });

  it("purges due evidence without requiring plaintext or user permission payloads", async () => {
    const now = new Date("2026-10-01T00:00:00Z");
    const repo = repository(now);
    const job = envelope();
    expect(await new AmazonOrderReportRetentionProcessor(repo).process(job, now)).toEqual({ status: "completed" });
    expect(repo.purge).toHaveBeenCalledWith({ tenantId: job.tenantId, userId: job.requestedBy, permissions: [], dataScope: "tenant" }, now);
  });

  it("rejects extra sensitive job payload fields before consulting the database", async () => {
    const repo = repository();
    await expect(new AmazonOrderReportRetentionProcessor(repo).process({ ...envelope(), payload: { batchId: createEntityId(), content: "private" } })).rejects.toThrow();
    expect(repo.expiry).not.toHaveBeenCalled();
    expect(repo.purge).not.toHaveBeenCalled();
  });
});
