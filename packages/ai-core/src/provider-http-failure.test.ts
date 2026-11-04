import { describe, expect, it } from "vitest";
import { parseModelProviderHttpFailure } from "./provider-http-failure.js";

const failure = (status:number, error:unknown, headers?:HeadersInit) => parseModelProviderHttpFailure(new Response(JSON.stringify({error}),{status,headers}));

describe("safe provider HTTP failure evidence",()=>{
  it("preserves a definite moderation rejection without provider messages or arbitrary codes",async()=>{
    const error=await failure(400,{type:"image_generation_user_error",code:"moderation_blocked",message:"secret prompt and customer bytes"},{"x-request-id":"req_safe-42"});
    expect(error.message).toBe("studio_provider_http_400");
    expect(error.failure).toMatchObject({status:400,kind:"moderation",code:"moderation_blocked",providerRequestId:"req_safe-42",retryAfterMs:null});
    expect(JSON.stringify(error)).not.toMatch(/secret|customer/);
    const injected=await failure(400,{type:"anything",code:"customer_private_value",message:"sk-private"},{"x-request-id":"Bearer private"});
    expect(injected.failure).toMatchObject({kind:"unknown",code:null,providerRequestId:null});
  });

  it("keeps 5xx, HTML proxies, conflicting statuses and oversized bodies uncertain",async()=>{
    expect((await failure(503,{type:"image_generation_user_error",code:"moderation_blocked"})).failure.kind).toBe("unavailable");
    expect((await failure(429,{type:"anything",code:"moderation_blocked"})).failure.kind).toBe("unknown");
    expect((await parseModelProviderHttpFailure(new Response("<html>proxy failure</html>",{status:400}))).failure.kind).toBe("unknown");
    let cancelled=false;
    const oversized=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode("x".repeat(32_769)));},cancel(){cancelled=true;}});
    expect((await parseModelProviderHttpFailure(new Response(oversized,{status:429}))).failure.kind).toBe("unknown");
    expect(cancelled).toBe(true);
  });

  it("honors numeric, millisecond and date Retry-After only for explicit temporary limits",async()=>{
    for(const [headers,expected] of [[{"retry-after":"12"},12_000],[{"retry-after-ms":"2500"},2500]] as const)
      expect((await failure(429,{type:"rate_limit_error",code:"rate_limit_exceeded"},headers)).failure).toMatchObject({kind:"rate_limit",retryAfterMs:expected});
    const later=new Date(Date.now()+60_000).toUTCString();
    const parsed=await failure(429,{type:"rate_limit_error"},{"retry-after":later});
    expect(parsed.failure.retryAfterMs).toBeGreaterThan(58_000);
    expect(parsed.failure.retryAfterMs).toBeLessThanOrEqual(60_000);
    for(const code of ["insufficient_quota","billing_hard_limit_reached"])
      expect((await failure(429,{type:"rate_limit_error",code},{"retry-after":"1"})).failure).toMatchObject({kind:"authentication",retryAfterMs:null});
    expect((await failure(429,{type:"rate_limit_error"},{"retry-after":"999999999999999999999"})).failure.retryAfterMs).toBe(86_400_000);
  });

  it("does not turn a truncated error body into a definite provider rejection",async()=>{
    const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('{"error":{"code":"moderation_blocked"'));controller.error(new Error("network ended"));}});
    expect((await parseModelProviderHttpFailure(new Response(stream,{status:400}))).failure.kind).toBe("unknown");
  });
});
