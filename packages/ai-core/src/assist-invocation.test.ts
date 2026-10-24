import { describe, expect, it } from "vitest";
import { assistInvocationView } from "./assist-invocation.js";

const id="019f0000-0000-7000-8000-000000000001",at=new Date("2026-10-16T00:00:00Z");
const run={id,status:"completed" as const,startedAt:at,completedAt:at,costUsd:"0.001234",inputTokens:120,outputTokens:300,modelSnapshot:{model:"synthetic-model",inputUsdPerMillion:1,outputUsdPerMillion:2}};
const execution={phase:"completed",submissionState:"received",attemptCount:3,dispatchCount:4,submittedAt:at,receivedAt:at,providerRequestId:"synthetic-request",responseChecksum:"a".repeat(64)};
describe("owner-derived invocation evidence",()=>{
  it("keeps processing attempts separate from one stored response and estimated billing",()=>{
    const view=assistInvocationView(run,execution,{state:"committed",amountUsd:"0.001234"},null);
    expect(view).toMatchObject({processingAttempts:3,dispatches:4,boundary:"received",providerRequestId:"synthetic-request",billing:{basis:"configured_rate",amountUsd:"0.00123400",needsProviderEvidence:true}});
    expect(JSON.stringify(view)).not.toContain("externalRequestCount");
  });
  it("does not invent submission evidence or a zero cost for legacy and uncertain tasks",()=>{
    expect(assistInvocationView({...run,costUsd:null},null,null,null)).toMatchObject({boundary:"legacy_missing",submittedAt:null,receivedAt:null,billing:{basis:"unknown",amountUsd:null,needsProviderEvidence:true},issues:expect.arrayContaining(["legacy_execution_missing"])});
    expect(assistInvocationView({...run,status:"failed",costUsd:null},{...execution,phase:"uncertain",submissionState:"submitted",receivedAt:null,responseChecksum:null}, {state:"reserved",amountUsd:"0.04"},null)).toMatchObject({state:"uncertain",boundary:"submitted",billing:{basis:"unknown",amountUsd:null,budgetState:"reserved",budgetAmountUsd:"0.04000000"}});
  });
  it("distinguishes released reservations and ambiguous ledgers without declaring a provider invoice",()=>{
    expect(assistInvocationView({...run,costUsd:null},{...execution,submissionState:"not_submitted",submittedAt:null,receivedAt:null,responseChecksum:null}, {state:"released",amountUsd:"0.04"},null)).toMatchObject({billing:{basis:"not_submitted",amountUsd:null,budgetState:"released",needsProviderEvidence:false}});
    expect(assistInvocationView(run,execution,{state:"committed",amountUsd:"0.001234"},null,true)).toMatchObject({billing:{budgetState:null,budgetAmountUsd:null},issues:expect.arrayContaining(["ambiguous_budget"])});
  });
});
