import { createEntityId } from "@yummyai/contracts";
import { afterAll, describe, expect, it } from "vitest";

import { createQueue, enqueueJob, QueueName } from "./index.js";

describe("job queue", () => {
  const queue = createQueue(QueueName.Media);

  afterAll(async () => {
    await queue.close();
  });

  it("enqueues a validated idempotent tenant job in Redis", async () => {
    const idempotencyKey = createEntityId();
    const envelope = {
      jobId: createEntityId(),
      tenantId: createEntityId(),
      requestedBy: createEntityId(),
      correlationId: createEntityId(),
      idempotencyKey,
      requestedAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      payload: { assetId: createEntityId() },
    };

    const queued = await enqueueJob(queue, "asset.process", envelope);
    const stored = await queue.getJob(idempotencyKey);
    expect(queued.id).toBe(idempotencyKey);
    expect(stored?.data).toEqual(envelope);
    await stored?.remove();
  });
});
