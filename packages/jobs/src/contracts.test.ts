import { describe, expect, it } from "vitest";

import { JobEnvelopeSchema, QueueName } from "./index.js";

const id = "019b0000-0000-7000-8000-000000000001";

describe("job contracts", () => {
  it("accepts a retryable tenant-scoped envelope", () => {
    expect(
      JobEnvelopeSchema.parse({
        jobId: id,
        tenantId: id,
        requestedBy: id,
        correlationId: id,
        idempotencyKey: id,
        attempt: 1,
        maxAttempts: 3,
        payload: { assetId: id },
      }),
    ).toMatchObject({ attempt: 1, maxAttempts: 3 });
  });

  it("rejects a retry attempt beyond the configured maximum", () => {
    expect(
      JobEnvelopeSchema.safeParse({
        jobId: id,
        tenantId: id,
        requestedBy: id,
        correlationId: id,
        idempotencyKey: id,
        attempt: 4,
        maxAttempts: 3,
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("exposes stable queue names", () => {
    expect(QueueName.Capture).toBe("capture");
    expect(QueueName.AiAnalysis).toBe("ai-analysis");
  });
});
