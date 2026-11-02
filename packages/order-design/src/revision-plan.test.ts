import {describe,it,expect} from "vitest";
import {createEntityId} from "@yummyai/contracts";
import {createDefaultProductionDocument} from "@yummyai/production-editor/products";
import {createPillowPipeline,DesignAutomationRecipeSchema} from "@yummyai/contracts/pod/design-automation";
import {buildOrderDesignRevisionPlan,selectOrderDesignRevisionSubject,orderDesignRevisionPrompt,revisionFeedbackView,mergeOrderDesignRevisionGeometry,resolveOrderDesignRevisionSource} from "./revision-plan.js";
import {paidTool} from "./repository.js";
import type {OrderDesignSnapshot,OrderDesignRevisionRequest} from "./types.js";

function snapshot(){
  const hash="a".repeat(64);
  const pipeline=createPillowPipeline({engine:"realesrgan-ncnn-vulkan",release:"20220424",model:"realesrgan-x4plus",scale:4,tileSize:256,threads:"1:1:1",
    alphaStrategy:"source-alpha-lanczos3-rgb-nearest-fill-v1",binarySha256:hash,modelBinSha256:hash,modelParamSha256:hash});
  const recipe=DesignAutomationRecipeSchema.parse({schemaVersion:1,workflow:"pillow_photo",imagePolicy:"faithful_enhancement",modelRouteId:createEntityId(),allowOrderImageTransfer:true,
    modelCallLimit:2,estimatedCostPerCallUsd:.04,maxEstimatedCostUsd:.2,pillowPipeline:pipeline});
  return {recipe,plan:{budget:{estimatedCostPerCallUsd:.04}}} as OrderDesignSnapshot;
}
describe("explicit candidate revision planning",()=>{
  it("plans one paid subject edit and ends at business review without template rebuilding",()=>{
    const source=snapshot(),before=structuredClone(source),id=createEntityId();
    const plan=buildOrderDesignRevisionPlan(source,id,"image_edit");
    expect(plan.steps.map(step=>step.tool)).toEqual(["revise_image","measure_subject","ensure_resolution","optimize_contour","preflight","render_proof","review_required"]);
    expect(plan.budget).toMatchObject({plannedModelCalls:1,estimatedCostUsd:.04,maxEstimatedCostUsd:.2});
    expect(plan.automaticProductionApproval).toBe(false);expect(source).toEqual(before);
  });
  it("keeps contour-only edits at zero calls even when no paid transfer or quote is available",()=>{
    const source=snapshot();source.recipe={...source.recipe,allowOrderImageTransfer:false,modelCallLimit:0,estimatedCostPerCallUsd:null};
    source.plan.budget.estimatedCostPerCallUsd=null;
    const plan=buildOrderDesignRevisionPlan(source,createEntityId(),"contour_only");
    expect(plan.status).toBe("ready");expect(plan.plannedModelCalls).toBe(0);expect(plan.budget.estimatedCostUsd).toBe(0);
    expect(plan.steps.map(step=>step.tool)).toEqual(["reuse_revision_subject","optimize_contour","preflight","render_proof","review_required"]);
    expect(plan.steps.some(step=>paidTool(step.tool))).toBe(false);
    expect(paidTool("revise_image")).toBe(true);
  });
  it("does not erase the original explicit cap or make unknown prices free",()=>{
    const source=snapshot();source.recipe.maxEstimatedCostUsd=.01;
    expect(buildOrderDesignRevisionPlan(source,createEntityId(),"image_edit").blockers).toContain("model_budget_exceeded");
    source.recipe={...source.recipe,maxEstimatedCostUsd:null,estimatedCostPerCallUsd:null,costPolicy:"unlimited"};source.plan.budget.estimatedCostPerCallUsd=null;
    expect(buildOrderDesignRevisionPlan(source,createEntityId(),"image_edit").budget).toMatchObject({allowed:true,estimatedCostUsd:null,actualCostUsd:null});
  });
  it("selects the existing subject and preserves distinct hidden reference and text layers",()=>{
    const document=createDefaultProductionDocument("shaped_pillow"),id=createEntityId(),hiddenId=createEntityId();
    document.layers=[{id:"subject",name:"subject",kind:"image",assetId:id,assetVersion:1,widthMm:200,heightMm:200,xMm:1,yMm:2,rotationDeg:0,opacity:1,visible:true,locked:true,flipX:false,flipY:false},
      {id:"reference",name:"reference",kind:"image",assetId:hiddenId,assetVersion:1,widthMm:30,heightMm:40,xMm:50,yMm:60,rotationDeg:12,opacity:.5,visible:false,locked:true,flipX:true,flipY:false},
      {id:"text",name:"text",kind:"text",text:"Buyer text",fontId:"geist_regular",fontSizeMm:4,letterSpacingMm:0,color:"#000000",arc:null,xMm:5,yMm:6,rotationDeg:0,opacity:1,visible:true,locked:false}];
    const before=structuredClone(document);
    expect(selectOrderDesignRevisionSubject(document,[{id,checksum:"a".repeat(64),metadata:{kind:"image",actualAlpha:true}}])).toEqual({targetImageId:id,targetImageChecksum:"a".repeat(64),targetLayerIds:["subject"]});
    expect(document).toEqual(before);
    document.layers[1]!.visible=true;
    expect(()=>selectOrderDesignRevisionSubject(document,[{id,checksum:"a".repeat(64),metadata:{kind:"image",actualAlpha:true}}])).toThrow("agent_revision_subject_ambiguous");
  });
  it("does not promote a buyer original or a screenshot to the production subject",()=>{
    const document=createDefaultProductionDocument("shaped_pillow"),id=createEntityId();
    document.layers=[{id:"subject",name:"subject",kind:"image",assetId:id,assetVersion:1,widthMm:200,heightMm:200,xMm:0,yMm:0,rotationDeg:0,opacity:1,visible:true,locked:true,flipX:false,flipY:false}];
    expect(()=>selectOrderDesignRevisionSubject(document,[{id,checksum:"a".repeat(64),metadata:{kind:"image",actualAlpha:true,buyerOriginal:true}}])).toThrow("agent_revision_subject_unavailable");
    const request={requestId:createEntityId(),parentRunId:createEntityId(),baseProjectId:createEntityId(),baseVersionId:createEntityId(),baseDocumentChecksum:"a".repeat(64),targetImageId:id,targetImageChecksum:"b".repeat(64),targetLayerIds:["subject"],reason:"Keep the ears",mode:"image_edit",feedbackImages:[{id:createEntityId(),name:"note.png",objectKey:"private/feedback",checksum:"c".repeat(64),byteSize:12,mediaType:"image/png",purpose:"operator_revision_feedback"}]} satisfies OrderDesignRevisionRequest;
    expect(orderDesignRevisionPrompt(request)).toContain("不是生产图");
    expect(revisionFeedbackView(request).attachments[0]).not.toHaveProperty("objectKey");
    expect(revisionFeedbackView(request).attachments[0]).not.toHaveProperty("checksum");
  });
  it("preserves artwork and text alignment when a new contour rebases the canvas origin",()=>{
    const document=createDefaultProductionDocument("shaped_pillow");
    if(document.productType!=="shaped_pillow")throw new Error("fixture");
    const layer={id:"subject",name:"subject",kind:"image" as const,assetId:createEntityId(),assetVersion:1,widthMm:200,heightMm:200,xMm:10,yMm:20,rotationDeg:7,opacity:1,visible:true,locked:true,flipX:false,flipY:false};
    const text={id:"text",name:"text",kind:"text" as const,text:"Exact buyer text",fontId:"geist_regular",fontSizeMm:4,letterSpacingMm:0,color:"#000000",arc:null,xMm:50,yMm:60,rotationDeg:0,opacity:1,visible:true,locked:false};
    document.layers=[layer,text];const before=structuredClone(document);
    const geometry={...document,layers:[{...layer,xMm:15,yMm:30}]};
    const merged=mergeOrderDesignRevisionGeometry(document,geometry,layer.id);
    expect(merged.layers[1]).toEqual({...text,xMm:55,yMm:70});
    expect(merged.layers[1]!.xMm-merged.layers[0]!.xMm).toBe(text.xMm-layer.xMm);
    expect(merged.layers[1]!.yMm-merged.layers[0]!.yMm).toBe(text.yMm-layer.yMm);
    expect(merged.layers[0]).toMatchObject({assetId:layer.assetId,widthMm:200,heightMm:200,rotationDeg:7});
    expect(document).toEqual(before);
  });
  it("keeps the normal double-sided pillow and refuses several visible image placements",()=>{
    const document=createDefaultProductionDocument("shaped_pillow"),id=createEntityId();
    if(document.productType!=="shaped_pillow")throw new Error("fixture");
    document.spec.sideMode="double";
    const layer={id:"subject",name:"subject",kind:"image" as const,assetId:id,assetVersion:1,widthMm:200,heightMm:200,xMm:10,yMm:20,rotationDeg:0,opacity:1,visible:true,locked:true,flipX:false,flipY:false};
    document.layers=[layer];const assets=[{id,checksum:"a".repeat(64),metadata:{kind:"image",actualAlpha:true}}];
    expect(selectOrderDesignRevisionSubject(document,assets).targetLayerIds).toEqual(["subject"]);
    document.layers.push({...layer,id:"separate_back",surface:"back"});
    expect(()=>selectOrderDesignRevisionSubject(document,assets)).toThrow("agent_revision_subject_ambiguous");
  });
  it("binds the explicit current submitted successor without relabelling the original candidate",()=>{
    const original=createEntityId(),current=createEntityId();
    const base={candidateVersionId:original,candidateVersionNumber:4,currentVersionId:current,currentVersionNumber:8,expectedVersionId:current,artwork:"in_review"};
    expect(resolveOrderDesignRevisionSource(base)).toBe("submitted_successor");
    expect(()=>resolveOrderDesignRevisionSource({...base,expectedVersionId:original})).toThrow("agent_revision_base_changed");
    expect(()=>resolveOrderDesignRevisionSource({...base,artwork:"in_progress"})).toThrow("agent_revision_successor_not_submitted");
    expect(()=>resolveOrderDesignRevisionSource({...base,currentVersionNumber:3})).toThrow("agent_revision_base_changed");
    expect(resolveOrderDesignRevisionSource({...base,currentVersionId:original,currentVersionNumber:4,expectedVersionId:original,artwork:"in_progress"})).toBe("agent_candidate");
  });
});
