import { createEntityId } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";
import { OrderDesignQueueProcessor } from "./order-design.processor.js";

describe("private design queue boundary", () => {
  it("rejects buyer data and caller-selected tenant metadata before execution", async () => {
    const process = vi.fn(async () => ({ disposition: "processed" }));
    const worker = new OrderDesignQueueProcessor({ process });
    const job: JobEnvelope = { jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(),
      correlationId: createEntityId(), idempotencyKey: createEntityId(), requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3,
      payload: { runId: createEntityId() } };
    await worker.process(job);
    expect(process).toHaveBeenCalledWith({ tenantId: job.tenantId, requestedBy: job.requestedBy, runId: (job.payload as { runId: string }).runId });
    for (const extra of [{ prompt: "private" }, { bytes: "private" }, { tenantId: createEntityId() }, { modelRouteId: createEntityId() }])
      expect(() => worker.process({ ...job, payload: { ...(job.payload as object), ...extra } })).toThrow();
    expect(process).toHaveBeenCalledTimes(1);
  });
});
