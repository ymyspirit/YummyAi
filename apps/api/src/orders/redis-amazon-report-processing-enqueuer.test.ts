import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it, vi } from "vitest";

const { queued, close } = vi.hoisted(() => ({ queued: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock("@yummyai/jobs", async (original) => ({ ...await original<object>(), createQueue: () => ({ close }), enqueueJob: queued }));
import { RedisAmazonReportProcessingEnqueuer } from "./redis-amazon-report-processing-enqueuer.js";

describe("durable report attachment scheduling", () => {
  it("uses one initial batch identity and an explicit new identity for operator recovery", async () => {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: ["order:write", "order:pii:read"], dataScope: "tenant" };
    const batchId = createEntityId(), dispatchId = createEntityId();
    const enqueuer = new RedisAmazonReportProcessingEnqueuer();
    await enqueuer.schedule(context, batchId);
    expect(queued).toHaveBeenLastCalledWith(expect.anything(), "amazon-order-report.process", expect.objectContaining({ tenantId: context.tenantId, requestedBy: context.userId, idempotencyKey: batchId, payload: { batchId }, maxAttempts: 20 }), { delay: 1_000, backoff: { type: "provider-aware" } });
    await enqueuer.schedule(context, batchId, dispatchId);
    expect(queued).toHaveBeenLastCalledWith(expect.anything(), "amazon-order-report.process", expect.objectContaining({ idempotencyKey: dispatchId, payload: { batchId, dispatchId } }), expect.anything());
    await enqueuer.onModuleDestroy();
    expect(close).toHaveBeenCalledOnce();
  });
});
