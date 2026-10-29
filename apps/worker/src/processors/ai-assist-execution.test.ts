import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistExecutionPolicy, assistFingerprint, assistHarness, assistPromptVersion, normalizeModelTokenUsage,
  type AssistContext, type ModelProvider, type ModelResponseCheckpoint, type ResolvedModelRequest, type SecretVault } from "@yummyai/ai-core";
import { ASSIST_ACCESS_POLICY_VERSION, requiredAssistPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CreateAssistSchema } from "@yummyai/contracts/ai/assist";
import { aiAssistRuns as runs, aiAssistExecutions as executions, aiBudgetLedger, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type * as DatabaseModule from "@yummyai/database";
import { DurableAssistExecution, assistResultReceipt } from "./ai-assist-execution.js";

vi.mock("@yummyai/database", async original => ({ ...await original<typeof DatabaseModule>(), withTenant: vi.fn() }));

type Query={from:(table:unknown)=>Query;where:()=>Query;for:()=>Query;innerJoin:()=>Query;then:Promise<unknown[]>["then"]};
describe("Assist original response usage capture",()=>{
  beforeEach(()=>{vi.mocked(withTenant).mockReset();});
  const usage=normalizeModelTokenUsage({input_tokens:12,output_tokens:4,total_tokens:16})!;
  function fixture(options:{unlimited?:boolean;cancel?:boolean;encryptionFailure?:boolean;duplicate?:boolean;conflict?:boolean}={}) {
    const context:TenantContext={tenantId:createEntityId(),userId:createEntityId(),permissions:[],dataScope:"tenant"};
    const request=CreateAssistSchema.parse({kind:"order_review",requestId:createEntityId(),modelId:createEntityId(),orderLineId:createEntityId(),expectedRevision:0,expectedSourceVersionId:null});
    if(request.kind!=="order_review")throw new Error("Synthetic request must stay order_review");
    const binding=assistHarness(request.kind,false,requiredAssistPermissions(request.kind,"run"),ASSIST_ACCESS_POLICY_VERSION,false);
    const input:AssistContext={request,...(options.unlimited?{outputTokenPolicy:"provider" as const}:{}),executionContract:binding.registry.pin(binding.skill),data:{},sources:[],checks:[],diagnostics:[],images:[],allowedArtworkIds:[],allowedSpecificationIds:[],allowMatches:false};
    const now=new Date(),policy=assistExecutionPolicy(false,false,true,!!options.unlimited);
    const run={id:createEntityId(),tenantId:context.tenantId,ownerId:context.userId,requestId:request.requestId,kind:request.kind,scope:`order:${request.orderLineId}`,
      benchmarkItemId:null,orderLineId:request.orderLineId,status:"queued",inputFingerprint:assistFingerprint(input),requestFingerprint:assistFingerprint(request),
      encryptedInput:JSON.stringify(input),encryptedOutput:null,modelSnapshot:{id:request.modelId,label:"Synthetic",providerLabel:"Synthetic",providerConfigId:createEntityId(),model:"synthetic-model",inputUsdPerMillion:1,outputUsdPerMillion:1,maxTaskCostUsd:1},
      promptVersion:assistPromptVersion(false,true),errorCode:null,inputTokens:null,outputTokens:null,tokenUsage:null,costUsd:null,reservedCostUsd:"1.000000",creationTransactionId:null,
      createdAt:now,startedAt:null,completedAt:null,expiresAt:new Date(now.getTime()+60_000)} satisfies typeof runs.$inferSelect;
    const storedRun:typeof runs.$inferSelect={...run};
    const execution:typeof executions.$inferSelect={runId:run.id,tenantId:context.tenantId,contractVersion:policy.contractVersion,inputFingerprint:run.inputFingerprint,policyChecksum:policy.checksum,
      phase:"pending",submissionState:"not_submitted",attemptCount:0,dispatchCount:0,lastDispatchedAt:null,leaseToken:null,leaseExpiresAt:null,encryptedResponse:null,responseChecksum:null,providerRequestId:null,submittedAt:null,receivedAt:null,responseReceiptTransactionId:null,nextAttemptAt:now,updatedAt:now};
    const patches:Array<{table:unknown;values:Record<string,unknown>}>=[];
    function select():Query {
      let table:unknown;
      const value:Query={from:next=>{table=next;return value;},where:()=>value,for:()=>value,innerJoin:()=>value,
        then:(resolve,reject)=>Promise.resolve(table===runs?[{...storedRun}]:table===executions?[{...execution}]:[]).then(resolve,reject)};
      return value;
    }
    const tx={select,execute:vi.fn(async()=>[{milliseconds:String(Date.now())}]),update:(table:unknown)=>({set:(values:Record<string,unknown>)=>({where:async()=>{
      patches.push({table,values});
      if(table===runs)Object.assign(storedRun,values);
      if(table===executions)Object.assign(execution,values,...(values.leaseExpiresAt&&!(values.leaseExpiresAt instanceof Date)?[{leaseExpiresAt:new Date(Date.now()+300_000)}]:[]));
    }})})};
    vi.mocked(withTenant).mockImplementation(async(_db,_context,operation)=>operation(tx as unknown as TenantTransaction));
    let afterCancel=0;
    const response:ModelResponseCheckpoint={version:"model-response-v1",providerId:"synthetic-provider",modelKey:"synthetic-model",providerRequestId:"synthetic-request",payload:{private:"invalid-analysis"},inputTokens:12,outputTokens:4,tokenUsage:usage,costUsd:0.04,receivedAt:now.toISOString()};
    const generate=vi.fn(async(supplied:ResolvedModelRequest<unknown>)=>{
      if(options.cancel){storedRun.status="cancelled";execution.phase="failed";execution.leaseToken=null;execution.leaseExpiresAt=null;afterCancel=patches.length;}
      await supplied.onResponseCheckpoint!(response);
      if(options.duplicate)await supplied.onResponseCheckpoint!(response);
      if(options.conflict)await supplied.onResponseCheckpoint!({...response,tokenUsage:{...usage,inputTokens:13,totalTokens:17}});
      throw new SyntaxError("synthetic invalid model result");
    });
    const model:ModelProvider={providerId:"synthetic-provider",generate:request=>generate(request),estimate:vi.fn(),healthCheck:vi.fn()};
    const vault={withSecret:<T>(raw:string,callback:(value:string)=>T):T=>callback(raw),encrypt:(raw:string)=>{
      if(options.encryptionFailure)throw new Error("synthetic encryption unavailable");return raw;
    }} as SecretVault;
    const processor=new DurableAssistExecution({database:{db:{}} as DatabaseConnection,contentVault:vault,provider:vi.fn(async()=>model),readImage:vi.fn()});
    return {processor,context,run:storedRun,execution,generate,patches,afterCancel:()=>afterCancel,response};
  }
  it("retains a cancellation's late usage and original response without reopening task or financial state",async()=>{
    const f=fixture({cancel:true,unlimited:true});
    expect(await f.processor.process(f.context,f.run.id,"analyze")).toMatchObject({disposition:"skipped"});
    expect(f.run).toMatchObject({status:"cancelled",tokenUsage:usage,inputTokens:null,outputTokens:null,costUsd:null});
    expect(f.execution).toMatchObject({phase:"failed",leaseToken:null,leaseExpiresAt:null,submissionState:"received",providerRequestId:"synthetic-request"});
    expect(JSON.parse(f.execution.encryptedResponse!).response).toMatchObject({tokenUsage:usage,costUsd:0.04});
    const late=f.patches.slice(f.afterCancel());
    expect(late.filter(patch=>patch.table===runs).map(patch=>patch.values)).toEqual([{tokenUsage:usage}]);
    expect(late.filter(patch=>patch.table===aiBudgetLedger)).toEqual([]);
    expect(late.filter(patch=>patch.table===executions).every(patch=>!("phase" in patch.values)&&!("leaseToken" in patch.values))).toBe(true);
    expect(f.generate).toHaveBeenCalledOnce();expect(f.generate.mock.calls[0]![0].maxOutputTokens).toBeNull();
  });
  it("records usage before failed private encryption and never submits it again",async()=>{
    const f=fixture({encryptionFailure:true});
    await f.processor.process(f.context,f.run.id,"analyze");
    expect(f.run).toMatchObject({status:"failed",tokenUsage:usage,inputTokens:12,outputTokens:4,costUsd:"0.040000"});
    expect(f.execution).toMatchObject({submissionState:"received",encryptedResponse:null});expect(f.execution.responseChecksum).toMatch(/^[a-f0-9]{64}$/);
    await f.processor.process(f.context,f.run.id,"analyze");expect(f.generate).toHaveBeenCalledOnce();
    expect(f.generate.mock.calls[0]![0].maxOutputTokens).toBe(6000);
  });
  it("preserves the bill when structured interpretation fails and handles identical receipt replay once",async()=>{
    const f=fixture({duplicate:true,unlimited:true});await f.processor.process(f.context,f.run.id,"analyze");
    expect(f.run).toMatchObject({status:"failed",errorCode:"assist_invalid_result",tokenUsage:usage,inputTokens:12,outputTokens:4});
    expect(f.execution).toMatchObject({phase:"failed",submissionState:"received"});
    expect(f.patches.filter(patch=>patch.table===runs&&"tokenUsage" in patch.values)).toHaveLength(1);expect(f.generate).toHaveBeenCalledOnce();
  });
  it("rejects a changed original receipt without replacing the first usage",async()=>{
    const f=fixture({conflict:true});await f.processor.process(f.context,f.run.id,"analyze");
    expect(f.run).toMatchObject({status:"failed",errorCode:"assist_response_changed",tokenUsage:usage});
    expect(JSON.parse(f.execution.encryptedResponse!).response.tokenUsage).toEqual(usage);expect(f.generate).toHaveBeenCalledOnce();
  });
  it("keeps a compatibility adapter's absent usage unknown instead of counting fallback zero tokens",()=>{
    const receipt=assistResultReceipt({providerId:"synthetic",modelKey:"synthetic",value:{},inputTokens:0,outputTokens:0,usageReported:false,costUsd:null,completedAt:new Date()});
    expect(receipt).toMatchObject({inputTokens:null,outputTokens:null,tokenUsage:null,costUsd:null});
  });
});
