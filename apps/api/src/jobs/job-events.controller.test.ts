import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";

import { createJobEventStream, type JobEventRepository, type JobProgressEvent } from "./job-events.controller.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("job event stream", () => {
  it("resumes after Last-Event-ID and streams a failed job", async () => {
    const previous = createEntityId(); const failed = event("failed", 64); const repository = new MemoryEvents(previous, failed);
    const messages = await firstValueFrom(createJobEventStream(repository, context, previous, { pollMs: 60_000, heartbeatMs: 60_000 }).pipe(take(1), toArray()));
    expect(repository.lastId).toBe(previous);
    expect(messages[0]).toMatchObject({ id: failed.id, type: "job-progress", data: { state: "failed", progress: 64 } });
  });

  it("emits a heartbeat for quiet connections", async () => {
    const repository: JobEventRepository = { listAfter: async () => [] };
    const message = await firstValueFrom(createJobEventStream(repository, context, undefined, { pollMs: 60_000, heartbeatMs: 5 }).pipe(take(1)));
    expect(message.type).toBe("heartbeat");
  });
});

class MemoryEvents implements JobEventRepository {
  lastId?: string;
  constructor(private readonly previous: string, private readonly next: JobProgressEvent) {}
  async listAfter(_context: TenantContext, lastEventId?: string) { this.lastId = lastEventId; return lastEventId === this.previous ? [this.next] : []; }
}
function event(state: JobProgressEvent["state"], progress: number): JobProgressEvent { return { id: createEntityId(), jobId: createEntityId(), state, progress, message: "Provider timed out", occurredAt: new Date().toISOString() }; }
