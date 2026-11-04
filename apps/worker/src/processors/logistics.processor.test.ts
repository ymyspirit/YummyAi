import { describe,it,expect,vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { JobEnvelopeSchema,type JobEnvelope } from "@yummyai/jobs";
import type { LogisticsExecutor } from "@yummyai/logistics";
import { LogisticsProcessor,logisticsFollowupEnvelope } from "./logistics.processor.js";

function envelope(){const id=createEntityId();return JobEnvelopeSchema.parse({jobId:createEntityId(),idempotencyKey:createEntityId(),tenantId:createEntityId(),requestedBy:createEntityId(),correlationId:id,payload:{taskId:id,mode:"purchase"}});}
describe("logistics label polling",()=>{
  it("schedules only reconciliation with a stable retry identity and the original authority",async()=>{
    const input=envelope(),followup=vi.fn<(envelope:JobEnvelope,delay:number)=>Promise<void>>().mockResolvedValue(undefined),run=vi.fn(async()=>({status:"label_requesting",retryAfterMs:30000}));
    const processor=new LogisticsProcessor({run} as unknown as LogisticsExecutor,followup);
    await processor.process(input);
    const next=JobEnvelopeSchema.parse(followup.mock.calls[0]![0]);
    expect(next).toMatchObject({tenantId:input.tenantId,requestedBy:input.requestedBy,correlationId:input.correlationId,payload:{taskId:input.correlationId,mode:"reconcile"}});
    expect(followup.mock.calls[0]![1]).toBe(30000);expect(next.idempotencyKey).toBe(logisticsFollowupEnvelope(input).idempotencyKey);
    expect(logisticsFollowupEnvelope(next).idempotencyKey).not.toBe(next.idempotencyKey);
  });
  it("never reschedules a lost issuance response or a completed task",async()=>{
    for(const status of ["reconciliation_required","completed","ignored"]){
      const followup=vi.fn(),processor=new LogisticsProcessor({run:async()=>({status})} as unknown as LogisticsExecutor,followup);
      await processor.process(envelope());expect(followup).not.toHaveBeenCalled();
    }
  });
});
