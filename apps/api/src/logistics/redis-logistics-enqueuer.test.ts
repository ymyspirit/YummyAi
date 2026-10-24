import { describe, it, expect, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { randomUUID } from "node:crypto";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import type * as Jobs from "@yummyai/jobs";
const added=vi.hoisted(()=>vi.fn());
vi.mock("@yummyai/jobs",async importOriginal=>({...await importOriginal<typeof Jobs>(),createQueue:()=>({add:added,close:async()=>undefined})}));
import { RedisLogisticsEnqueuer } from "./redis-logistics-enqueuer.js";
describe("logistics queue boundary",()=>{
  it("accepts browser UUID request keys, deduplicates retries and separates procurement from reconciliation",async()=>{
    const queue=new RedisLogisticsEnqueuer(),input={taskId:createEntityId(),tenantId:createEntityId(),requestedBy:createEntityId(),mode:"purchase" as const,requestKey:randomUUID()};
    await queue.enqueue(input);await queue.enqueue(input);await queue.enqueue({...input,mode:"reconcile"});
    const calls=added.mock.calls;
    expect(calls).toHaveLength(3);
    calls.forEach(call=>expect(JobEnvelopeSchema.safeParse(call[1]).success).toBe(true));
    expect(calls[0]![2].jobId).toBe(calls[1]![2].jobId);
    expect(calls[0]![2].jobId).not.toBe(calls[2]![2].jobId);
    expect(calls[0]![2].jobId).not.toContain(":");
    await queue.onModuleDestroy();
  });
});
