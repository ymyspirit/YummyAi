import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { createQueue, QueueName } from "@yummyai/jobs";
import { afterAll, describe, expect, it } from "vitest";

import { RedisAmazonReportRetentionEnqueuer } from "./redis-amazon-report-retention-enqueuer.js";

describe("Amazon report retention scheduling", () => {
  const enqueuer = new RedisAmazonReportRetentionEnqueuer();
  const queue = createQueue(QueueName.AmazonOrderReportRetention);
  const batchId = createEntityId();

  afterAll(async () => {
    await (await queue.getJob(batchId))?.remove();
    await enqueuer.onModuleDestroy();
    await queue.close();
  });

  it("persists one delayed tenant job for a batch without storing buyer data", async () => {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: ["orders:write"], dataScope: "tenant" };
    const expiresAt = new Date(Date.now() + 30 * 86400_000);
    await enqueuer.schedule(context, batchId, expiresAt);
    await enqueuer.schedule(context, batchId, expiresAt);
    const stored = await queue.getJob(batchId);
    expect(stored?.id).toBe(batchId);
    expect(await stored?.getState()).toBe("delayed");
    expect(stored?.data.tenantId).toBe(context.tenantId);
    expect(stored?.data.requestedBy).toBe(context.userId);
    expect(stored?.data.payload).toEqual({ batchId });
    expect(stored?.opts.attempts).toBe(10);
    expect(stored?.delay).toBeGreaterThan(29 * 86400_000);
  });
});
