import { describe,expect,it } from "vitest";
import { harnessChecksum } from "@yummyai/ai-core";
import { createEntityId } from "@yummyai/contracts";
import { OrderDesignMethodSnapshotSchema,OrderDesignHarnessInputSchema,OrderDesignCompletionV1Schema } from "@yummyai/contracts/order/design-harness";
import { buildDesignAutomationPlan } from "@yummyai/production-editor/design-automation";
import { orderDesignHarness,registeredOrderDesignMethods,orderDesignInput,orderDesignInputChecksum } from "./harness.js";
import { fingerprint } from "./crypto.js";
import { readOrderDesignCompletion,sealOrderDesignEvidence } from "./completion.js";
import type { DesignRun } from "./repository.js";
import type { OrderDesignSnapshot } from "./types.js";

function fixture(){
  const recipe={schemaVersion:1,workflow:"template",imagePolicy:"preserve",modelRouteId:null,allowOrderImageTransfer:false,modelCallLimit:0,estimatedCostPerCallUsd:null,maxEstimatedCostUsd:null} as const;
  const snapshot={schemaVersion:1,workItemId:createEntityId(),workRevisionId:createEntityId(),sourceVersionId:null,templateVersionId:createEntityId(),templateChecksum:"a".repeat(64),recipe,plan:buildDesignAutomationPlan({recipe,imageIds:[createEntityId()]})} as OrderDesignSnapshot;
  const bundle=orderDesignHarness("template"),executionContract=bundle.registry.pin(bundle.skill);
  const method=OrderDesignMethodSnapshotSchema.parse({schemaVersion:"order-design-method-snapshot-v1",executionContract,methodSelection:{schemaVersion:"agent-method-selection-v1",mode:"builtin",methodKey:bundle.skill.key,contractChecksum:executionContract.checksum,withdrawalGeneration:0}});
  return {snapshot,bundle,method};
}
describe("order design native method boundary",()=>{
  it("registers both existing workflows with their own code-owned plan and unapproved completion",()=>{
    expect(registeredOrderDesignMethods()).toHaveLength(2);
    for(const method of registeredOrderDesignMethods()){
      expect(method.executionContract.executorKey).toBe("order_design");
      expect(method.tools[0]).toMatchObject({owner:"order_design_owner",inputSchemaKey:"order-design.pinned-plan-v1",outputSchemaKey:"order-design.completion-v1",approval:"owning_business_flow"});
      expect(method.instructions).toContain("不授予生产批准");
    }
  });
  it("keeps legacy fingerprints and binds native method pins independently of JSONB key order",()=>{
    const f=fixture();expect(orderDesignInputChecksum(f.snapshot)).toBe(fingerprint(f.snapshot));
    expect(orderDesignInputChecksum(f.snapshot,f.method)).not.toBe(fingerprint(f.snapshot));
    const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
    expect(orderDesignInputChecksum(f.snapshot,reorder(f.method) as typeof f.method)).toBe(orderDesignInputChecksum(f.snapshot,f.method));
    expect(orderDesignInputChecksum(f.snapshot,{...f.method,methodSelection:{...f.method.methodSelection,withdrawalGeneration:1}})).not.toBe(orderDesignInputChecksum(f.snapshot,f.method));
  });
  it("rejects mismatched recipes, another owner and client governance fields",()=>{
    const f=fixture(),input=orderDesignInput(f.snapshot);
    expect(OrderDesignHarnessInputSchema.safeParse(input).success).toBe(true);
    expect(OrderDesignHarnessInputSchema.safeParse({...input,workflow:"pillow_photo"}).success).toBe(false);
    expect(OrderDesignHarnessInputSchema.safeParse({...input,methodSnapshot:f.method}).success).toBe(false);
    expect(OrderDesignMethodSnapshotSchema.safeParse({...f.method,executionContract:{...f.method.executionContract,executorKey:"pod_artwork"}}).success).toBe(false);
    const other=orderDesignHarness("pillow_photo");expect(()=>other.registry.assertCurrent(f.method.executionContract,other.skill)).toThrow();
  });
  it("verifies the original handoff without promoting a proof to production or rewriting later history",()=>{
    const f=fixture(),projectId=createEntityId(),versionId=createEntityId();
    const evidence=OrderDesignCompletionV1Schema.parse({contractVersion:"order-design-completion-v1",runId:createEntityId(),workItemId:f.snapshot.workItemId,workRevisionId:f.snapshot.workRevisionId,inputChecksum:orderDesignInputChecksum(f.snapshot,f.method),methodContractChecksum:f.method.executionContract.checksum,projectId,editorVersionId:versionId,documentChecksum:"b".repeat(64),templateVersionId:f.snapshot.templateVersionId,templateChecksum:f.snapshot.templateChecksum,ruleSnapshotChecksum:null,qualityCheckChecksum:"c".repeat(64),resultState:"awaiting_review",steps:[{id:createEntityId(),key:"review_required",requestId:createEntityId(),inputChecksum:"d".repeat(64),outputAssetId:null,outputVersionId:versionId,responseChecksum:null}],proofs:[{renderId:createEntityId(),versionId,manifestChecksum:"e".repeat(64),files:[{key:"result",mediaType:"image/png",byteSize:20,checksumSha256:"f".repeat(64)}]}],requiresBusinessReview:true,automaticProductionApproval:false});
    const sealed=sealOrderDesignEvidence(f.snapshot,f.method,evidence);expect(sealed).toEqual({evidence,checksum:harnessChecksum(evidence)});
    const run={id:evidence.runId,workItemId:evidence.workItemId,workRevisionId:evidence.workRevisionId,inputChecksum:evidence.inputChecksum,methodSnapshot:f.method,projectId,currentEditorVersionId:versionId,status:"awaiting_review",completionEvidence:sealed.evidence,completionChecksum:sealed.checksum} as DesignRun;
    expect(readOrderDesignCompletion(run,f.snapshot)?.evidence).toEqual(evidence);
    expect(readOrderDesignCompletion({...run,status:"cancelled"},f.snapshot)?.evidence.resultState).toBe("awaiting_review");
    expect(()=>readOrderDesignCompletion({...run,completionChecksum:"0".repeat(64)},f.snapshot)).toThrow("agent_completion_invalid");
    expect(()=>readOrderDesignCompletion({...run,currentEditorVersionId:createEntityId()},f.snapshot)).toThrow("agent_completion_invalid");
    expect(OrderDesignCompletionV1Schema.safeParse({...evidence,automaticProductionApproval:true}).success).toBe(false);
    expect(OrderDesignCompletionV1Schema.safeParse({...evidence,objectKey:"private/original"}).success).toBe(false);
    expect(readOrderDesignCompletion({...run,methodSnapshot:null,completionEvidence:null,completionChecksum:null},f.snapshot)).toBeNull();
  });
});
