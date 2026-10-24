import { createEntityId } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { AmazonReportBatchProcessor } from "@yummyai/order-intake";
import { describe, expect, it, vi } from "vitest";
import { AmazonOrderReportProcessingProcessor } from "./amazon-order-report-processing.processor.js";

const envelope = (): JobEnvelope => ({ jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(), correlationId: createEntityId(), idempotencyKey: createEntityId(), requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 20, payload: { batchId: createEntityId() } });
describe("Amazon attachment job boundary", () => {
  it("derives tenant scope from the trusted job envelope and accepts identifiers only", async () => {
    const runner = new AmazonReportBatchProcessor({ read: async () => ({ exists: false, importing: false, tasks: [] }), retire: async () => undefined }, { process: async () => undefined });
    const run = vi.spyOn(runner, "process");
    const worker = new AmazonOrderReportProcessingProcessor(runner);
    const job = envelope();
    await worker.process(job);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: job.tenantId, userId: job.requestedBy }), (job.payload as { batchId: string }).batchId, undefined);
    for (const extra of [{ sourceUrl: "private" }, { customer: "private" }, { tenantId: createEntityId() }]) {
      expect(() => worker.process({ ...job, payload: { ...(job.payload as object), ...extra } })).toThrow();
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
});
