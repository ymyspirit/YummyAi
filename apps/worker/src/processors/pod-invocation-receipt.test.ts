import { describe, expect, it } from "vitest";
import { podInvocationReceipt, podResultChecksum } from "./pod-invocation-receipt.js";

describe("bounded POD response receipt",()=>{
  it("binds parsed result metadata and output bytes in non-HTTP response evidence",()=>{
    const first={modelKey:"model",modelVersion:"v1",costUsd:0.01,outputs:[{bytes:Buffer.from("synthetic"),fileName:"result.png"}]};
    const changedPrice={...first,costUsd:0.02};
    expect(podResultChecksum(first)).not.toBe(podResultChecksum(changedPrice));
    expect(podResultChecksum(first)).not.toBe(podResultChecksum({...first,outputs:[{...first.outputs[0]!,bytes:Buffer.from("different")}]}));
  });
  it("keeps a valid charge when artwork metadata is invalid and omits content",()=>{
    const receipt=podInvocationReceipt({modelKey:"valid",modelVersion:17,costUsd:0.01234567,prompt:"private-secret",outputs:[{dataBase64:"private-pixels"}]},"a".repeat(64),"request-1");
    expect(receipt).toMatchObject({costUsd:"0.01234567",metadataValid:false,modelKey:"valid",modelVersion:null,providerRequestId:"request-1"});
    expect(JSON.stringify(receipt)).not.toMatch(/private-secret|private-pixels|outputs|prompt/);
  });
  it.each([undefined,NaN,Infinity,-1,"0.1",1e12,1e-12])("does not turn invalid or absent cost %s into zero",cost=>{
    const receipt=podInvocationReceipt({modelKey:"model",modelVersion:"v1",costUsd:cost},"b".repeat(64));
    expect(receipt.costUsd).toBeNull();
    expect(receipt.metadataValid).toBe(cost===undefined);
  });
  it("preserves explicit zero and small charges and rejects control characters in references",()=>{
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1",costUsd:0},"a".repeat(64)).costUsd).toBe("0.00000000");
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1",costUsd:0.0000004},"a".repeat(64)).costUsd).toBe("0.00000040");
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1"},"a".repeat(64),"unsafe\nreference")).toMatchObject({providerRequestId:null,metadataValid:false});
  });
  it("keeps reported token components separate from cached, image and reasoning subsets",()=>{
    const receipt=podInvocationReceipt({modelKey:"model",modelVersion:"v1",usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130,
      prompt_tokens_details:{cached_tokens:20,image_tokens:80,text_tokens:20},completion_tokens_details:{reasoning_tokens:10}},prompt:"private"},"a".repeat(64));
    expect(receipt.tokenUsage).toMatchObject({version:"model-token-usage-v1",inputTokens:100,outputTokens:30,cachedInputTokens:20,totalTokens:130,
      totalTokensBasis:"provider",inputImageTokens:80,inputTextTokens:20,reasoningTokens:10});
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1"},"a".repeat(64)).tokenUsage).toBeNull();
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1",usage:{input_tokens:-1,output_tokens:"30"}},"a".repeat(64)).tokenUsage).toBeNull();
    expect(podInvocationReceipt({modelKey:"model",modelVersion:"v1",tokenUsage:receipt.tokenUsage},"a".repeat(64)).tokenUsage).toEqual(receipt.tokenUsage);
  });
});
