import type { SecretVault } from "@yummyai/ai-core";
import { createEntityId, ProductionEditorDocumentSchema, type ProductionEditorDocument, type ProductionEditorPreflight, type TenantContext } from "@yummyai/contracts";
import { ORDER_IMAGE_ENHANCEMENT_INSTRUCTION, ORDER_IMAGE_ENHANCEMENT_POLICY } from "@yummyai/contracts/order/design-policy";
import { productionEditorProjects as projects, productionEditorVersions as versions, productionEditorImages as images, orderDesignAgentSteps as steps,
  orderWorkAssets,orderWorkItems,amazonOrderReportVersions,assetFiles,withTenant,type DatabaseConnection } from "@yummyai/database";
import { getBuiltinFont,inspectProductionFont,decryptProductionBytes,encryptProductionBytes,preflightProductionDocument,renderProductionDocument } from "@yummyai/production-editor";
import { getProductionBodySize } from "@yummyai/production-editor/geometry";
import { productionExportDefaults } from "@yummyai/production-editor/products";
import { optimizePillowContour,applyOptimizedPillowContour,DEFAULT_PILLOW_CONTOUR_SETTINGS } from "@yummyai/production-editor/pillow-contour-optimizer";
import { buildDesignQualityReport } from "@yummyai/production-editor/design-automation";
import { measurePillowSubject,planPillowSubjectPlacement } from "@yummyai/production-editor/pillow-subject";
import { createPillowAutomationGeometry,recomputePillowAutomationGeometry } from "@yummyai/production-editor/pillow-automation-geometry";
import { PillowPipelineSchema, PILLOW_CONTOUR_GRAPH_VERSION, PillowContourEvidenceSchema } from "@yummyai/contracts/pod/design-automation";
import type { OrderDesignResponseRecoveryEvidence } from "@yummyai/contracts/order/design-agent";
import type { ClamAvScanner, Storage } from "@yummyai/storage";
import { and,eq } from "drizzle-orm";
import sharp from "sharp";
import { composeOrderArtwork } from "./order-artwork-layout.js";
import { fingerprint,seal,open } from "./crypto.js";
import { pinnedRuleDiagnostics } from "./rules.js";
import { pillowCutoutPrompt } from "./pillow-cutout-prompt.js";
import { runPillowContourWorkflow } from "./pillow-contour-workflow.js";
import type { DesignRun,DesignStep } from "./repository.js";
import { OrderDesignError,type DesignStepInput,type OrderDesignSnapshot,type OrderDesignAssetPin,type OrderDesignImageGateway,type OrderDesignSuperResolutionGateway,type OrderDesignResponseReceipt,type OrderDesignResponseCheckpoint } from "./types.js";

type AssetMetadata={kind:"image"|"font";name:string;mediaType:string;width:number;height:number;hasAlpha:boolean;actualAlpha:boolean;scan:{result:string;signatureVersion:string};buyerOriginal?:boolean;operatorRecovery?:OrderDesignResponseRecoveryEvidence;modelEdit?:{renderId:string;sourceImageId:string;model:string;operation:string;enhancementPolicy?:string;promptVersion?:string;subjectPromptVersion?:string};superResolution?:Record<string,unknown>;sourcePinKey?:string;sourceWidth?:number;sourceHeight?:number};
export type StepResult={assets?:Array<typeof images.$inferInsert>;document?:ProductionEditorDocument;output?:unknown;outputAssetId?:string;actualCostUsd?:number;
  qualityDiagnostics?:Array<{code:string;severity:"error"|"warning"|"manual";message:string}>;
  proof?:{files:Array<{key:string;name:string;mediaType:string;byteSize:number;objectKey:string;checksumSha256:string}>;preflight:ProductionEditorPreflight};proofBackground?:"transparent"|"white";proofFormat?:"png"|"jpeg"};
type Execution={context:TenantContext;run:DesignRun;step:DesignStep;input:DesignStepInput;snapshot:OrderDesignSnapshot;signal:AbortSignal;
  responseCheckpoint?:OrderDesignResponseCheckpoint;responseRecovery?:OrderDesignResponseRecoveryEvidence;assertActive:()=>Promise<void>;markSubmitted:()=>Promise<void>;
  markReceived:(receipt:OrderDesignResponseReceipt)=>Promise<void>;checkpointResponse:(checkpoint:OrderDesignResponseCheckpoint)=>Promise<void>};

/** Narrow tool registry: recipe steps select deterministic operations, never code
 * or arbitrary manufacturing instructions supplied by a model. */
export class OrderDesignExecutor {
  constructor(private readonly database:DatabaseConnection,private readonly storage:Storage,private readonly vault:SecretVault,private readonly gateway:OrderDesignImageGateway,private readonly scanner:Pick<ClamAvScanner,"scan">,private readonly superResolution?:OrderDesignSuperResolutionGateway){}
  async execute(job:Execution):Promise<StepResult> {
    await job.assertActive();
    const data=await withTenant(this.database.db,job.context,async tx=>{
      const [project]=await tx.select().from(projects).where(eq(projects.id,job.run.projectId!));
      const [version]=await tx.select().from(versions).where(eq(versions.id,job.run.currentEditorVersionId!));
      return {project,version,assets:await tx.select().from(images).where(eq(images.projectId,job.run.projectId!))};
    });
    if(!data.project?.encryptedDataKey || !data.version) throw new OrderDesignError("agent_project_unavailable");
    const key=this.key(data.project.encryptedDataKey);
    try {
      const rawDocument=open<unknown>(key,data.version.encryptedDocument);
      if(fingerprint(rawDocument)!==data.version.checksum) throw new OrderDesignError("agent_editor_checksum_invalid");
      let document=ProductionEditorDocumentSchema.parse(rawDocument);
      const metadata=new Map(data.assets.map(row=>[row.id,open<AssetMetadata>(key,row.encryptedMetadata)]));
      const read=async(id:string)=>{
        const row=data.assets.find(asset=>asset.id===id);if(!row) throw new OrderDesignError("agent_asset_unavailable");
        const bytes=decryptProductionBytes(key,await this.storage.readPrivate(job.context,{id:row.id,tenantId:job.context.tenantId,assetDomain:"order",objectKey:row.originalObjectKey},{requiredDomain:"order"}));
        if(fingerprint(bytes)!==row.checksum) throw new OrderDesignError("agent_asset_checksum_invalid");return bytes;
      };
      const resolvers={resolveAsset:async(id:string,version:number)=>{if(version!==1)throw new OrderDesignError("agent_asset_version_invalid");return {bytes:await read(id)};},resolveFont:async(id:string)=>id==="geist_regular"?getBuiltinFont(id):{bytes:await read(id)}};
      const completedAsset=async(stepKey:string)=>{
        const [dependency]=await withTenant(this.database.db,job.context,tx=>tx.select({id:steps.outputAssetId}).from(steps).where(and(eq(steps.runId,job.run.id),eq(steps.key,stepKey),eq(steps.status,"completed"))));
        if(!dependency?.id || !metadata.has(dependency.id))throw new OrderDesignError("agent_step_dependency_invalid");return dependency.id;
      };
      const pipeline=job.snapshot.recipe.pillowPipeline;
      switch(job.input.tool) {
        case "validate_inputs": {
          if(pinnedRuleDiagnostics(job.snapshot).some(issue=>issue.severity==="error"))throw new OrderDesignError("agent_rule_conflict");
          if(pipeline) {
            if(!PillowPipelineSchema.safeParse(pipeline).success || job.snapshot.recipe.imagePolicy!=="faithful_enhancement" || job.snapshot.recipe.workflow!=="pillow_photo" || job.snapshot.model?.model!==pipeline.requiredModel)throw new OrderDesignError("agent_pillow_pipeline_invalid");
            if(document.productType!=="shaped_pillow" || document.spec.factoryStandardId!==pipeline.factoryStandard || document.spec.dpi!==150 || !document.spec.declaredLongestMm)throw new OrderDesignError("agent_pillow_factory_pin_invalid");
            if(!this.superResolution)throw new OrderDesignError("agent_pillow_runtime_unavailable");
            await this.superResolution.validatePolicy(pipeline.upscale);
          }
          const [template]=await withTenant(this.database.db,job.context,tx=>tx.select().from(versions).where(and(eq(versions.id,job.snapshot.templateVersionId),eq(versions.projectId,job.snapshot.templateProjectId))));
          if(!template || template.checksum!==job.snapshot.templateChecksum)throw new OrderDesignError("agent_template_changed");
          const prepared:Array<typeof images.$inferInsert>=[];
          for(const pin of job.snapshot.assets) {
            await job.assertActive();
            const bytes=await this.readPin(job,pin);
            prepared.push(await this.prepareAsset(job,key,pin.key,pin.name,bytes,pin.kind,{...(pin.buyerOriginal?{buyerOriginal:true}:{}),sourcePinKey:pin.key}));
          }
          document=structuredClone(job.snapshot.document);
          document.layers=document.layers.map(layer=>layer.kind==="image"?{...layer,assetId:job.snapshot.templateAssetKeys[layer.assetId]??layer.assetId}:{...layer,fontId:job.snapshot.templateAssetKeys[layer.fontId]??layer.fontId});
          if(job.snapshot.masterAssetKey) {
            const source=prepared.find(asset=>asset.id===job.snapshot.masterAssetKey)!;const info=open<AssetMetadata>(key,source.encryptedMetadata);
            const body=getProductionBodySize(document);const ratio=Math.min(body.width/info.width,body.height/info.height);
            const master={id:"catalog_artwork",kind:"image" as const,name:"印花主稿",assetId:source.id!,assetVersion:1,widthMm:info.width*ratio,heightMm:info.height*ratio,xMm:(body.width-info.width*ratio)/2,yMm:(body.height-info.height*ratio)/2,rotationDeg:0,opacity:1,visible:true,locked:false,flipX:false,flipY:false};
            document.layers=document.layers.some(layer=>layer.id==="catalog_artwork")?document.layers.map(layer=>layer.id==="catalog_artwork"?master:layer):[master];
          }
          return {assets:prepared,document,output:{assetCount:prepared.length,ruleSnapshot:job.snapshot.ruleSnapshot??null}};
        }
        case "compose_template": {
          const selected=job.snapshot.assets.filter(pin=>pin.buyerOriginal).map(pin=>{const info=metadata.get(pin.key)!;if(!info)throw new OrderDesignError("agent_asset_unavailable");return {id:pin.key,version:1,usage:pin.usage!,width:info.width,height:info.height};});
          document=await composeOrderArtwork(document,job.snapshot.layout,job.snapshot.customization,job.snapshot.draft,selected,job.snapshot.photoOnlyPillow,job.snapshot.requirements);
          return {document,output:{layerCount:document.layers.length}};
        }
        case "enhance_image":
        case "cutout_subject": {
          if(!job.snapshot.model) throw new OrderDesignError("agent_model_unavailable");
          const originalId=job.input.sourceImageId;
          let sourceId=originalId;
          if(job.input.tool==="cutout_subject" && job.input.enhancedStepId) {
            const [enhanced]=await withTenant(this.database.db,job.context,tx=>tx.select({id:steps.outputAssetId}).from(steps).where(and(eq(steps.runId,job.run.id),eq(steps.key,job.input.tool==="cutout_subject"?job.input.enhancedStepId!:""),eq(steps.status,"completed"))));
            if(!enhanced?.id) throw new OrderDesignError("agent_step_dependency_invalid");sourceId=enhanced.id;
          }
          const source=await read(sourceId),sourceInfo=metadata.get(sourceId)!;
          const cutout=job.input.tool==="cutout_subject";
          if(pipeline && job.snapshot.model.model!==pipeline.requiredModel)throw new OrderDesignError("agent_pillow_model_mismatch");
          const prompt=job.input.tool==="cutout_subject"?pillowCutoutPrompt(job.input,pipeline,job.snapshot.requirements)
            :`${ORDER_IMAGE_ENHANCEMENT_INSTRUCTION}只做照片保真美化，保留整张画面的主体、背景、边缘和已有透明区域；不抠图，不加描边、裁剪线、条码或装饰。`;
          await job.assertActive();
          let result:{bytes:Buffer;actualCostUsd?:number};
          let responseCheckpoint=job.responseCheckpoint;
          if(responseCheckpoint) {
            const checkpoint=responseCheckpoint;
            const encrypted=await this.storage.readPrivate(job.context,
              {id:job.step.id,tenantId:job.context.tenantId,assetDomain:"order",objectKey:checkpoint.objectKey},{requiredDomain:"order"})
              .catch(()=>{throw new OrderDesignError("agent_asset_storage_unavailable");});
            try {
              const bytes=decryptProductionBytes(key,encrypted);
              if(checkpoint.requestId!==job.step.requestId || checkpoint.quarantined!==true || bytes.length!==checkpoint.byteSize || fingerprint(bytes)!==checkpoint.checksum)
                throw new OrderDesignError("agent_model_response_checkpoint_invalid");
              result={bytes,...(checkpoint.actualCostUsd!==undefined?{actualCostUsd:checkpoint.actualCostUsd}:{})};
            } catch(error) {
              if(error instanceof OrderDesignError)throw error;
              throw new OrderDesignError("agent_model_response_checkpoint_invalid");
            }
          } else {
            await job.markSubmitted();
            result=await this.gateway.generate({context:job.context,requestId:job.step.requestId,model:job.snapshot.model,prompt,bytes:source,
              size:sourceInfo.width/sourceInfo.height>1.25?"1536x1024":sourceInfo.height/sourceInfo.width>1.25?"1024x1536":"2048x2048",transparent:cutout || sourceInfo.actualAlpha,signal:job.signal});
            // Persist receipt before scanning/decoding. A known response must never be sent again.
            const receipt:OrderDesignResponseReceipt={version:1,requestId:job.step.requestId,checksum:fingerprint(result.bytes),byteSize:result.bytes.length,
              receivedAt:new Date().toISOString(),quarantined:true,...(result.actualCostUsd!==undefined?{actualCostUsd:result.actualCostUsd}:{})};
            try {
              try{await job.markReceived(receipt);}catch(error){result.bytes.fill(0);throw error;}
              if(!result.bytes.length || result.bytes.length>64*1024*1024)throw new OrderDesignError("agent_asset_size_invalid");
              const stored=await this.storage.putPrivate(job.context,{body:encryptProductionBytes(key,result.bytes),domain:"order",
                fileName:`${job.step.requestId}-response-quarantine.pe`,mediaType:"application/octet-stream"});
              responseCheckpoint={...receipt,objectKey:stored.objectKey};
              await job.checkpointResponse(responseCheckpoint);
            } catch(error) {
              if(error instanceof OrderDesignError&&["agent_source_expired","agent_claim_lost","agent_model_cost_report_invalid","agent_model_cost_conflict","agent_model_call_identity_invalid"].includes(error.code))throw error;
              throw new OrderDesignError("agent_model_response_uncheckpointed");
            }
          }
          await job.assertActive();
          const outputId=createEntityId();
          const asset=await this.prepareAsset(job,key,outputId,cutout?"主体抠图":"保真美化",result.bytes,"image",{...(job.responseRecovery?{operatorRecovery:job.responseRecovery}:{}),modelEdit:{renderId:job.step.requestId,sourceImageId:originalId,model:job.snapshot.model.model,operation:cutout?"cutout":"enhance",...(cutout && pipeline?{promptVersion:pipeline.cutoutPromptVersion}:{}),...(job.input.tool==="cutout_subject" && job.input.subjectPromptVersion?{subjectPromptVersion:job.input.subjectPromptVersion}:{}),...(job.snapshot.recipe.imagePolicy==="faithful_enhancement"?{enhancementPolicy:ORDER_IMAGE_ENHANCEMENT_POLICY}:{})},sourceWidth:metadata.get(originalId)?.width,sourceHeight:metadata.get(originalId)?.height},responseCheckpoint?.objectKey);
          const info=open<AssetMetadata>(key,asset.encryptedMetadata);
          if((cutout || sourceInfo.actualAlpha) && !info.actualAlpha)return {assets:[asset],outputAssetId:outputId,actualCostUsd:result.actualCostUsd,
            output:{sourceImageId:originalId,outputAssetId:outputId,providerReturnedImage:true,applied:false,actualCostUsd:result.actualCostUsd??null},
            qualityDiagnostics:[{code:"agent_alpha_missing",severity:"error",message:"模型返回图片未保留所需透明区域，已保存结果供核对，未替换图稿。"}]};
          document.layers=document.layers.map(layer=>{
            if(layer.kind!=="image")return layer;
            const meta=metadata.get(layer.assetId);
            if(layer.assetId!==originalId && meta?.modelEdit?.sourceImageId!==originalId)return layer;
            const scale=Math.min(layer.widthMm/info.width,layer.heightMm/info.height);
            const widthMm=info.width*scale,heightMm=info.height*scale;
            return {...layer,assetId:outputId,assetVersion:1,widthMm,heightMm,xMm:layer.xMm+(layer.widthMm-widthMm)/2,yMm:layer.yMm+(layer.heightMm-heightMm)/2};
          });
          return {assets:[asset],document,outputAssetId:outputId,actualCostUsd:result.actualCostUsd,output:{sourceImageId:originalId,outputAssetId:outputId,actualCostUsd:result.actualCostUsd??null}};
        }
        case "measure_subject": {
          if(!pipeline || document.productType!=="shaped_pillow" || !document.spec.declaredLongestMm)throw new OrderDesignError("agent_pillow_pipeline_invalid");
          const sourceId=await completedAsset(job.input.sourceStepId),bytes=await read(sourceId);
          if(!metadata.get(sourceId)?.actualAlpha)throw new OrderDesignError("agent_alpha_missing");
          const measurement=measurePillowSubject(await pillowRaster(bytes));
          const placement=planPillowSubjectPlacement(measurement,{longestSideInches:document.spec.declaredLongestMm/25.4});
          return {outputAssetId:sourceId,output:{sourceAssetId:sourceId,sourceChecksum:fingerprint(bytes),measurement,placement,nativeDetailVerified:false}};
        }
        case "ensure_resolution": {
          if(!pipeline || document.productType!=="shaped_pillow" || !document.spec.declaredLongestMm || !this.superResolution)throw new OrderDesignError("agent_pillow_pipeline_invalid");
          const sourceId=await completedAsset(job.input.sourceStepId);
          if(await completedAsset(job.input.measurementStepId)!==sourceId)throw new OrderDesignError("agent_step_dependency_invalid");
          const bytes=await read(sourceId),sourceInfo=metadata.get(sourceId)!;
          const measurement=measurePillowSubject(await pillowRaster(bytes));
          const options={longestSideInches:document.spec.declaredLongestMm/25.4};
          const placement=planPillowSubjectPlacement(measurement,options);
          if(!placement.requiresUpscale)return {outputAssetId:sourceId,output:{sourceAssetId:sourceId,sourceChecksum:fingerprint(bytes),action:"kept_sufficient_actual_pixels",measurement,placement,nativeDetailVerified:false}};
          if(placement.requiredUpscaleFactor>pipeline.upscale.scale)throw new OrderDesignError("agent_pillow_source_resolution_too_low");
          await job.assertActive();
          const result=await this.superResolution.upscale({bytes,policy:pipeline.upscale,signal:job.signal});
          await job.assertActive();
          const raster=await pillowRaster(result.bytes),after=measurePillowSubject(raster),afterPlacement=planPillowSubjectPlacement(after,options);
          if(raster.width!==measurement.sourceWidthPx*4 || raster.height!==measurement.sourceHeightPx*4 || afterPlacement.requiresUpscale)throw new OrderDesignError("agent_pillow_upscale_dimensions_invalid");
          const outputId=createEntityId();
          const evidence={...result.evidence,sourceAssetId:sourceId,sourceChecksum:fingerprint(bytes),outputChecksum:fingerprint(result.bytes),policy:pipeline.upscale,measurementBefore:measurement,measurementAfter:after,ppiBefore:placement.effectivePpi,ppiAfter:afterPlacement.effectivePpi,nativeDetailVerified:false};
          const asset=await this.prepareAsset(job,key,outputId,"主体高清补强",result.bytes,"image",{operatorRecovery:sourceInfo.operatorRecovery,modelEdit:sourceInfo.modelEdit,sourceWidth:sourceInfo.sourceWidth,sourceHeight:sourceInfo.sourceHeight,superResolution:evidence});
          if(!open<AssetMetadata>(key,asset.encryptedMetadata).actualAlpha)throw new OrderDesignError("agent_alpha_missing");
          document.layers=document.layers.map(layer=>layer.kind==="image" && layer.assetId===sourceId?{...layer,assetId:outputId,assetVersion:1}:layer);
          return {assets:[asset],document,outputAssetId:outputId,output:evidence};
        }
        case "optimize_contour": {
          if(document.productType!=="shaped_pillow")throw new OrderDesignError("agent_product_incompatible");
          if(pipeline) {
            const sourceId=await completedAsset(job.input.sourceStepId),bytes=await read(sourceId);
            const layer=document.layers.find(layer=>layer.kind==="image" && layer.assetId===sourceId);
            if(!layer || !metadata.get(sourceId)?.actualAlpha || !document.spec.declaredLongestMm)throw new OrderDesignError("agent_contour_source_invalid");
            const raster=await pillowRaster(bytes),options={artworkLayerId:layer.id,longestSideInches:document.spec.declaredLongestMm/25.4};
            if(pipeline.contour.workflow!==undefined) {
              if(pipeline.contour.workflow!==PILLOW_CONTOUR_GRAPH_VERSION || !PillowPipelineSchema.safeParse(pipeline).success)throw new OrderDesignError("agent_contour_workflow_invalid");
              const sourceChecksum=fingerprint(bytes),pixelChecksum=fingerprint(raster.rgba);
              const {result,attempts}=await runPillowContourWorkflow({document,raster,options,assertActive:job.assertActive,signal:job.signal});
              if(fingerprint(bytes)!==sourceChecksum || fingerprint(raster.rgba)!==pixelChecksum)throw new OrderDesignError("agent_contour_artwork_changed");
              const contourEvidence=PillowContourEvidenceSchema.parse({workflowVersion:pipeline.contour.workflow,engine:"langgraph",
                status:result.qa.technicalPassed?"passed":"needs_attention",sourceAssetId:sourceId,sourceChecksum,outputChecksum:fingerprint(bytes),
                artworkUnchanged:true,manualReviewRequired:true,attempts:attempts.map(attempt=>({roundingPx:attempt.roundingPx,technicalPassed:attempt.qa.technicalPassed,checks:attempt.qa.checks}))});
              return {document:result.document,outputAssetId:sourceId,output:{sourceAssetId:sourceId,sourceChecksum,measurement:result.measurement,placement:result.placement,attempts,qa:result.qa,artworkLocked:true,contourEvidence},
                qualityDiagnostics:result.qa.technicalPassed?[]:[{code:"agent_pillow_geometry_invalid",severity:"error",message:"轮廓在允许的局部修正范围内仍未通过，原稿已保留，需要人工核对。"}]};
            }
            let result=createPillowAutomationGeometry(document,raster,{...options,roundingPx:pipeline.contour.roundingPx});
            const attempts=[{roundingPx:pipeline.contour.roundingPx as number,qa:result.qa}];
            for(const roundingPx of [25,30]) {
              if(result.qa.technicalPassed)break;
              await job.assertActive();
              result=recomputePillowAutomationGeometry(result.document,raster,{...options,roundingPx});
              attempts.push({roundingPx,qa:result.qa});
            }
            return {document:result.document,outputAssetId:sourceId,output:{sourceAssetId:sourceId,sourceChecksum:fingerprint(bytes),measurement:result.measurement,placement:result.placement,attempts,qa:result.qa,artworkLocked:true},
              qualityDiagnostics:result.qa.technicalPassed?[]:[{code:"agent_pillow_geometry_invalid",severity:"error",message:"轮廓在允许的局部修正范围内仍未通过，原稿已保留，需要人工核对。"}]};
          }
          const [cut]=await withTenant(this.database.db,job.context,tx=>tx.select({id:steps.outputAssetId}).from(steps).where(and(eq(steps.runId,job.run.id),eq(steps.key,job.input.tool==="optimize_contour"?job.input.sourceStepId:""))));
          const layer=document.layers.find(layer=>layer.kind==="image" && layer.assetId===cut?.id);
          if(!layer || layer.kind!=="image" || !metadata.get(layer.assetId)?.actualAlpha)throw new OrderDesignError("agent_contour_source_invalid");
          const bytes=await read(layer.assetId);const info=metadata.get(layer.assetId)!;
          const longest=document.spec.declaredLongestMm??Math.max(layer.widthMm,layer.heightMm);
          const prepared=await sharp(bytes).rotate().ensureAlpha().trim({background:"#00000000",threshold:0}).png().toBuffer({resolveWithObject:true});
          const scale=longest/Math.max(prepared.info.width,prepared.info.height);
          const widthMm=info.width*scale,heightMm=info.height*scale;
          document.layers=document.layers.map(item=>item.id===layer.id?{...item,widthMm,heightMm}:item);
          const sample=await sharp(bytes).rotate().ensureAlpha().resize({width:800,height:800,fit:"inside"}).raw().toBuffer({resolveWithObject:true});
          const mmPerPixel=widthMm/sample.info.width;const padding=Math.ceil((document.spec.whiteBorderMm+8)/mmPerPixel)+5;
          const width=sample.info.width+padding*2,height=sample.info.height+padding*2;
          if(width*height>1_200_000)throw new OrderDesignError("agent_contour_too_large");
          const alpha=new Uint8Array(width*height);
          for(let y=0;y<sample.info.height;y++)for(let x=0;x<sample.info.width;x++)alpha[(y+padding)*width+x+padding]=sample.data[(y*sample.info.width+x)*sample.info.channels+sample.info.channels-1]!;
          const points=optimizePillowContour({alpha,width,height,mmPerPixel,originX:layer.xMm-padding*mmPerPixel,originY:layer.yMm-padding*mmPerPixel},document.spec.whiteBorderMm,DEFAULT_PILLOW_CONTOUR_SETTINGS);
          return {document:applyOptimizedPillowContour(document,points),output:{pointCount:points.length}};
        }
        case "preflight": {
          const preflight=await preflightProductionDocument(document,{purpose:"production",...productionExportDefaults(document)},resolvers);
          const qualityImages=[];
          for(const layer of document.layers) {
            if(layer.kind!=="image")continue;const info=metadata.get(layer.assetId);if(!info)continue;
            const originalId=info.buyerOriginal?layer.assetId:info.modelEdit?.sourceImageId;
            if(!originalId)continue;const original=data.assets.find(row=>row.id===originalId)!;const originalInfo=metadata.get(originalId)!;
            const actual=await read(originalId);const output=data.assets.find(row=>row.id===layer.assetId)!;
            qualityImages.push({sourceImageId:originalId,expectedSourceChecksum:original.checksum,sourceChecksum:fingerprint(actual),outputChecksum:output.checksum,
              sourceWidthPx:info.modelEdit?.operation==="cutout"?null:originalInfo.width,sourceHeightPx:info.modelEdit?.operation==="cutout"?null:originalInfo.height,
              outputWidthPx:info.width,outputHeightPx:info.height,placedWidthMm:layer.widthMm,placedHeightMm:layer.heightMm,minimumPpi:document.spec.dpi,
              sourceHasAlpha:originalInfo.actualAlpha,outputHasAlpha:info.actualAlpha,requiresAlpha:job.snapshot.recipe.workflow==="pillow_photo",scan:info.scan.result==="clean"?"clean" as const:"unavailable" as const,modelEdited:!!info.modelEdit});
          }
          const texts=job.snapshot.customization.fields.flatMap(definition=>{
            if(definition.type==="image" || (job.snapshot.photoOnlyPillow && !job.snapshot.layout.some(placement=>placement.fieldKey===definition.key)))return [];
            const supplied=job.snapshot.draft.fields.filter(field=>field.key===definition.key || field.label===definition.label);
            if(!supplied.length || !supplied[0]!.value.trim())return [];
            const rendered=document.layers.filter(layer=>layer.kind==="text" && layer.id===`custom_${definition.key}` && layer.visible);
            return [{fieldId:definition.key,expected:supplied[0]!.value,actual:rendered.length===1 && rendered[0]!.kind==="text"?rendered[0]!.text:""}];
          });
          const quality=buildDesignQualityReport({images:qualityImages,texts,preflight:{productionReady:preflight.productionReady,issues:preflight.issues.map(({code,severity})=>({code,severity}))}});
          const diagnostics=preflight.issues.map(issue=>({code:issue.code,severity:issue.severity,message:qualityMessage(issue.code)}));
          if(quality.checks.some(check=>check.status==="failed"))diagnostics.push({code:"agent_quality_evidence_failed",severity:"error",message:"素材来源、文字或图片技术检查未通过，请人工核对。"});
          if(qualityImages.some(image=>image.modelEdited))diagnostics.push({code:"agent_identity_review",severity:"manual",message:"模型处理结果必须对照顾客原图核对身份与内容。"});
          if(job.snapshot.requirements?.notes.some(note=>note.original.trim()) || job.snapshot.requirements?.instructions.trim())
            diagnostics.push({code:"agent_customer_requirements_review",severity:"manual",message:"已将本单顾客备注和制作说明固定到模型请求；运营仍须对照原文与实际稿件逐项审核，模型完成不表示要求已获人工确认。"});
          return {output:{quality,preflight},qualityDiagnostics:[...diagnostics,...pinnedRuleDiagnostics({...job.snapshot,document})]};
        }
        case "render_proof": {
          const { format, background }=productionExportDefaults(document);
          const result=await renderProductionDocument(document,{purpose:"preview",format,background,previewFullResolution:true},resolvers);
          const object=await this.storage.putPrivate(job.context,{body:encryptProductionBytes(key,result.bytes),domain:"order",fileName:`${job.step.requestId}-proof.pe`,mediaType:"application/octet-stream"});
          const persisted=decryptProductionBytes(key,await this.storage.readPrivate(job.context,{id:job.step.requestId,tenantId:job.context.tenantId,assetDomain:"order",objectKey:object.objectKey},{requiredDomain:"order"}));
          if(fingerprint(persisted)!==fingerprint(result.bytes))throw new OrderDesignError("agent_proof_storage_invalid");
          return {proof:{files:[{key:"result",name:`proof-${job.step.requestId}.${format === "jpeg" ? "jpg" : "png"}`,mediaType:result.mediaType,byteSize:persisted.byteLength,objectKey:object.objectKey,checksumSha256:fingerprint(persisted)}],preflight:result.preflight},proofBackground:background,proofFormat:format === "jpeg" ? "jpeg" : "png",output:{renderId:job.step.requestId}};
        }
        case "review_required":return {output:{automaticProductionApproval:false}};
      }
    } finally {key.fill(0);}
  }
  private async prepareAsset(job:Execution,key:Buffer,id:string,name:string,bytes:Uint8Array,kind:"image"|"font",extra:Partial<AssetMetadata>={},stagedOriginalObjectKey?:string) {
    if(!bytes.byteLength || bytes.byteLength>(kind==="font"?10:64)*1024*1024)throw new OrderDesignError("agent_asset_size_invalid");
    const scan=await this.scanner.scan({body:bytes,fileName:kind==="font"?"font.ttf":"image.png",mediaType:"application/octet-stream"})
      .catch(()=>{throw new OrderDesignError("agent_scan_unavailable");});
    if(scan.result==="infected")throw new OrderDesignError("agent_scan_rejected");
    if(scan.result!=="clean" || scan.signatureVersion==="unavailable")throw new OrderDesignError("agent_scan_unavailable");
    let metadata:AssetMetadata,preview:Uint8Array;
    if(kind==="font") {inspectProductionFont(bytes);metadata={kind,name,mediaType:"font/ttf",width:0,height:0,hasAlpha:false,actualAlpha:false,scan,...extra};preview=bytes;}
    else {const info=await sharp(bytes,{limitInputPixels:100_000_000,failOn:"warning"}).metadata();if(!info.width || !info.height || (info.pages??1)>1 || !["png","jpeg","tiff","webp"].includes(info.format??""))throw new OrderDesignError("agent_asset_invalid");
      // stats() observes the input, not preceding extractChannel operations; decode the selected channel first.
      const alphaPixels=info.hasAlpha?await sharp(bytes).extractChannel("alpha").raw().toBuffer():null;const rotated=[5,6,7,8].includes(info.orientation??1);
      metadata={kind,name,mediaType:`image/${info.format}`,width:rotated?info.height:info.width,height:rotated?info.width:info.height,hasAlpha:!!info.hasAlpha,actualAlpha:!!alphaPixels && alphaPixels.some(value=>value<255),scan,...extra};
      preview=await sharp(bytes).rotate().resize({width:2400,height:2400,fit:"inside",withoutEnlargement:true}).png().toBuffer()
        .catch(()=>{throw new OrderDesignError("agent_asset_preview_failed");});}
    // A response checkpoint becomes an asset source only after the scan and decode above pass.
    const original=stagedOriginalObjectKey?{objectKey:stagedOriginalObjectKey}:await this.storage.putPrivate(job.context,{body:encryptProductionBytes(key,bytes),domain:"order",fileName:`${id}-source.pe`,mediaType:"application/octet-stream"})
      .catch(()=>{throw new OrderDesignError("agent_asset_storage_unavailable");});
    const thumbnail=kind==="font"?original:await this.storage.putPrivate(job.context,{body:encryptProductionBytes(key,preview),domain:"order",fileName:`${id}-preview.pe`,mediaType:"application/octet-stream"})
      .catch(()=>{throw new OrderDesignError("agent_asset_storage_unavailable");});
    return {id,tenantId:job.context.tenantId,projectId:job.run.projectId!,encryptedMetadata:seal(key,metadata),originalObjectKey:original.objectKey,previewObjectKey:thumbnail.objectKey,checksum:fingerprint(bytes),byteSize:bytes.byteLength};
  }
  private async readPin(job:Execution,pin:OrderDesignAssetPin):Promise<Buffer> {
    let bytes:Buffer;
    if(pin.origin==="report") {
      const [row]=await withTenant(this.database.db,job.context,tx=>tx.select().from(amazonOrderReportVersions).where(and(eq(amazonOrderReportVersions.id,pin.reportVersionId!),eq(amazonOrderReportVersions.reportLineId,pin.reportLineId!))));
      if(!row?.encryptedDocument)throw new OrderDesignError("agent_source_unavailable");
      bytes=this.vault.withSecret(row.encryptedDocument,value=>{
        const document=JSON.parse(value) as {files:Array<{key:string;originalFileKey?:string;contentBase64:string}>};
        const display=document.files.find(file=>file.key===pin.fileKey),source=display?.originalFileKey?document.files.find(file=>file.key===display.originalFileKey):display;
        if(!source)throw new OrderDesignError("agent_source_unavailable");return Buffer.from(source.contentBase64,"base64");});
    } else if(pin.origin==="editor") {
      const data=await withTenant(this.database.db,job.context,async tx=>{const [project]=await tx.select().from(projects).where(eq(projects.id,pin.projectId!));const [asset]=await tx.select().from(images).where(and(eq(images.id,pin.assetId!),eq(images.projectId,pin.projectId!)));return {project,asset};});
      if(!data.project?.encryptedDataKey || data.project.status!=="active" || data.project.sourceWorkItemId || data.project.sourceReportLineId || !data.asset)throw new OrderDesignError("agent_template_invalid");
      const key=this.key(data.project.encryptedDataKey);try {bytes=decryptProductionBytes(key,await this.storage.readPrivate(job.context,{id:data.asset.id,tenantId:job.context.tenantId,assetDomain:"authorized",objectKey:data.asset.originalObjectKey},{requiredDomain:"authorized"}));}finally{key.fill(0);}
      if(fingerprint(bytes)!==data.asset.checksum)throw new OrderDesignError("agent_asset_checksum_invalid");
    } else if(pin.origin==="work") {
      const data=await withTenant(this.database.db,job.context,async tx=>{const [work]=await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id,job.run.workItemId));const [asset]=await tx.select().from(orderWorkAssets).where(and(eq(orderWorkAssets.id,pin.assetId!),eq(orderWorkAssets.workItemId,job.run.workItemId)));return {work,asset};});
      if(!data.work?.encryptedDataKey || !data.asset)throw new OrderDesignError("agent_source_unavailable");const key=this.key(data.work.encryptedDataKey);
      try {bytes=decryptProductionBytes(key,await this.storage.readPrivate(job.context,{id:data.asset.id,tenantId:job.context.tenantId,assetDomain:"order",objectKey:data.asset.objectKey},{requiredDomain:"order"}));}finally{key.fill(0);}
      if(fingerprint(bytes)!==data.asset.checksum)throw new OrderDesignError("agent_asset_checksum_invalid");
    } else {
      const [asset]=await withTenant(this.database.db,job.context,tx=>tx.select().from(assetFiles).where(eq(assetFiles.id,pin.assetId!)));
      if(!asset || asset.assetDomain!=="authorized")throw new OrderDesignError("agent_asset_domain_invalid");
      bytes=Buffer.from(await this.storage.readPrivate(job.context,{...asset,assetDomain:"authorized"},{requiredDomain:"authorized"}));
      if(fingerprint(bytes)!==asset.checksumSha256)throw new OrderDesignError("agent_asset_checksum_invalid");
    }
    if(pin.checksum && fingerprint(bytes)!==pin.checksum)throw new OrderDesignError("agent_asset_checksum_invalid");return bytes;
  }
  private key(encrypted:string){return this.vault.withSecret(encrypted,value=>Buffer.from(value,"base64"));}
}
function qualityMessage(code:string){return code==="visual_review_required"?"图稿需要人工目视核对。":`生产检查：${code}`;}

async function pillowRaster(bytes:Buffer) {
  const result=await sharp(bytes,{limitInputPixels:100_000_000,failOn:"warning"}).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({resolveWithObject:true});
  return {width:result.info.width,height:result.info.height,rgba:result.data};
}
