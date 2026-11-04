import { describe, expect, it } from "vitest";
import type { ModelProviderHttpFailure } from "@yummyai/contracts/ai/provider-failure";
import { canRetryRateLimitedStep, orderProviderFailureCode, orderProviderRetryDelay } from "./provider-failure.js";

const failure:ModelProviderHttpFailure={version:1,status:429,kind:"rate_limit",code:"rate_limit_exceeded",providerRequestId:"synthetic-request",receivedAt:"2026-11-04T00:00:00Z",retryAfterMs:12_000};
describe("order model recovery policy",()=>{
  it("bounds automatic retries and never retries an uncertain or definitive non-temporary refusal",()=>{
    expect(orderProviderRetryDelay(failure,1)).toBe(12_000);
    expect(orderProviderRetryDelay({...failure,retryAfterMs:null},2)).toBe(10_000);
    expect(orderProviderRetryDelay(failure,3)).toBeNull();
    expect(orderProviderRetryDelay({...failure,retryAfterMs:300_001},1)).toBeNull();
    for(const kind of ["moderation","authentication","invalid_request","unavailable","unknown"] as const)
      expect(orderProviderRetryDelay({...failure,kind},1)).toBeNull();
    expect(orderProviderFailureCode({...failure,kind:"unavailable",status:503})).toBe("agent_model_submission_unknown");
    expect(orderProviderFailureCode({...failure,kind:"moderation",status:400})).toBe("agent_provider_moderation_blocked");
  });
  it("requires contiguous per-attempt rejection evidence and never resubmits a response checkpoint",()=>{
    const checkpoint={providerFailures:[{attempt:1,failure}],nextRetryAt:"2026-11-04T00:01:00Z"};
    expect(canRetryRateLimitedStep(checkpoint,1)).toBe(true);
    expect(canRetryRateLimitedStep(checkpoint,2)).toBe(false);
    expect(canRetryRateLimitedStep({...checkpoint,unsubmittedAttempts:[2]},2)).toBe(true);
    expect(canRetryRateLimitedStep({...checkpoint,unsubmittedAttempts:[1]},2)).toBe(false);
    expect(canRetryRateLimitedStep({...checkpoint,providerFailures:[{attempt:2,failure}]},1)).toBe(false);
    expect(canRetryRateLimitedStep({...checkpoint,nextRetryAt:undefined},1)).toBe(false);
    expect(canRetryRateLimitedStep({...checkpoint,providerFailures:[{attempt:1,failure:{...failure,kind:"unknown"}}]},1)).toBe(false);
    expect(canRetryRateLimitedStep({...checkpoint,responseReceipt:{version:1,requestId:"original",checksum:"a".repeat(64),byteSize:4,receivedAt:failure.receivedAt,quarantined:true}},1)).toBe(false);
  });
});
