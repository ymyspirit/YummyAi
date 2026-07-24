import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import { MarketplacePublicationReconciliationProcessor } from "./marketplace-publication-reconciliation.processor.js";
import type { PublicationExecutionRepository } from "./marketplace-publication.processor.js";

describe("marketplace publication reconciliation processor", () => {
  it("rethrows a pending safe read while the bounded window remains", async () => {
    const error = new Error("status pending");
    const publication = { process: vi.fn(async () => { throw error; }) };
    const repository = fakeRepository();
    await expect(new MarketplacePublicationReconciliationProcessor(publication, repository).process(envelope(3, 20)))
      .rejects.toBe(error);
    expect(publication.process).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3, maxAttempts: 21 }));
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records manual reconciliation when the bounded window is exhausted", async () => {
    const publication = { process: vi.fn(async () => { throw new Error("status pending"); }) };
    const repository = fakeRepository();
    const input = envelope(19, 20);
    await expect(new MarketplacePublicationReconciliationProcessor(publication, repository).process(input))
      .resolves.toEqual({ requestId: input.payload.publicationRequestId, status: "reconciliation_required" });
    expect(repository.fail).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: input.tenantId, userId: input.requestedBy }),
      input.payload.publicationRequestId,
      {
        status: "reconciliation_required",
        code: "PUBLICATION_RECONCILIATION_EXHAUSTED",
        message: "Marketplace status did not converge within the background reconciliation window; manual reconciliation is required",
        retryable: false,
      },
    );
  });

  it("passes through a conclusive provider status", async () => {
    const input = envelope(1, 20);
    const result = { requestId: input.payload.publicationRequestId, status: "published" };
    const publication = { process: vi.fn(async () => result) };
    const repository = fakeRepository();
    await expect(new MarketplacePublicationReconciliationProcessor(publication, repository).process(input))
      .resolves.toEqual(result);
    expect(repository.fail).not.toHaveBeenCalled();
  });
});

function fakeRepository(): PublicationExecutionRepository {
  const fail = vi.fn(async () => undefined);
  return {
    async withAccountLease<T>(
      _context: TenantContext,
      _requestId: string,
      operation: () => Promise<T>,
    ): Promise<T> {
      return operation();
    },
    claim: vi.fn(async () => undefined),
    withCredential: vi.fn(async () => { throw new Error("Unexpected credential read"); }),
    readMedia: vi.fn(async () => []),
    complete: vi.fn(async () => undefined),
    fail,
  };
}

function envelope(attempt: number, maxAttempts: number): JobEnvelope & {
  payload: { publicationRequestId: string };
} {
  const publicationRequestId = createEntityId();
  return {
    jobId: createEntityId(),
    tenantId: createEntityId(),
    requestedBy: createEntityId(),
    traceId: createTraceId(),
    correlationId: publicationRequestId,
    idempotencyKey: publicationRequestId,
    requestedAt: new Date().toISOString(),
    attempt,
    maxAttempts,
    payload: { publicationRequestId },
  };
}
