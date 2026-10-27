import { ConflictException } from "@nestjs/common";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import type { OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import { DesignAutomationRecipeSchema } from "@yummyai/contracts/pod/design-automation";
import { orderWorkRevisions,productionEditorImages,productionEditorVersions,modelRoutes,modelProviderConfigs,withTenant,type DatabaseConnection } from "@yummyai/database";
import { buildDesignAutomationPlan } from "@yummyai/production-editor/design-automation";
import { assertAutomaticArtwork,orderPillowPhotoPlan,isPhotoOnlyPillowArtwork,inspectPillowSuperResolutionRuntime,OrderArtworkLayoutError,type OrderDesignSnapshot,type OrderDesignAssetPin } from "@yummyai/order-design";
import { and,eq } from "drizzle-orm";
import type { ProductionEditorService } from "../design/production-editor.service.js";
import { validateOrderSalesBasis } from "../catalog/order-sales-basis.js";
import { resolveOrderRules } from "../rules/rule-center.service.js";
import { OrderRequirementInterpretationSchema, orderRequirementDraftInput } from "@yummyai/contracts/order/requirement-interpretation";
import { createHash } from "node:crypto";

function safePreparationDiagnostic(error: OrderArtworkLayoutError, requirements: OrderDesignSnapshot["requirements"]) {
  const messages: Record<string,string> = {
    font_group_conflict:"本组有互相冲突的字体要求，请核对原始分组并明确采用的真实字体。",
    color_group_conflict:"本组提供了不同色值，请核对原始分组并明确采用的真实色值。",
    color_value_missing:"实际印字缺少真实色值，请核对原始预览并填写 #RRGGBB，不能默认黑色。",
    legacy_group_missing:"旧资料缺少可核对的文字分组来源，请核对原始定制资料，不按相邻字段猜测字体或颜色。",
    source_text_not_selected:"原始非空文案尚未纳入制作草稿，请保留原文并核对印字字段。",
  };
  const pending=requirements?.unresolved.find(issue=>messages[issue.code]);
  if(pending)return {code:`agent_${pending.code}`,severity:"manual" as const,message:messages[pending.code]!};
  if(error.message.startsWith("本单包含实际印字要求"))return {code:"agent_print_layout_required",severity:"manual" as const,
    message:"本单有实际印字；当前来图工艺未配置可执行的文字区域与指定字体，请补齐本单文字制作参数，不能暗用默认字体或黑色。"};
  if(error.message.includes("指定字体") || error.message.includes("字体或颜色"))return {code:"agent_text_style_required",severity:"manual" as const,
    message:"实际印字指定了字体或颜色，请配置本单可用的授权字体文件与真实色值，再核对文字区域。"};
  if(error.message.includes("定制区域"))return {code:"agent_text_region_required",severity:"manual" as const,
    message:"已填内容缺少可执行的定制区域，请为本单固定印花配置并审核对应文字或图片区域。"};
  if(error.message.includes("裁切范围") || error.message.includes("印刷面数"))return {code:"agent_pillow_options_required",severity:"manual" as const,
    message:"裁切范围或单双面参数尚不能唯一识别，请对照原始选项明确本次制作参数，顾客原文继续保留。"};
  return {code:"agent_input_configuration_required",severity:"manual" as const,
    message:"自动制作所需的字段、区域或固定规则尚未齐备，请核对本单制作准备；审单保存不表示已完成制图。"};
}

/** Pins metadata only; copying/scanning large private images happens in Worker. */
export async function prepareOrderDesignSnapshot(database:DatabaseConnection,editor:ProductionEditorService,context:TenantContext,detail:OrderWorkDetail):Promise<OrderDesignSnapshot|null> {
  if(!detail.profile)throw new ConflictException("缺少固定工艺模板");
  const basis=await withTenant(database.db,context,tx=>validateOrderSalesBasis(tx,detail.draft));
  if(!basis)return null;
  const template=await editor.get(context,basis.recipe?.editorProjectId??detail.profile.projectId,basis.recipe?.editorVersionId??detail.profile.sourceVersionId);
  if(!template.version.document.automation)return null;
  if(template.project.source || template.project.workSource)throw new ConflictException("顾客私有素材不能用作通用模板");
  const [revision]=await withTenant(database.db,context,tx=>tx.select().from(orderWorkRevisions).where(and(eq(orderWorkRevisions.workItemId,detail.line.id),eq(orderWorkRevisions.revision,detail.line.revision))));
  if(!revision)throw new ConflictException("审单版本不可用");
  const [templateVersion]=await withTenant(database.db,context,tx=>tx.select({checksum:productionEditorVersions.checksum,createdAt:productionEditorVersions.createdAt}).from(productionEditorVersions).where(eq(productionEditorVersions.id,template.version.id)));
  if(!templateVersion)throw new ConflictException("工艺模板版本不可用");
  const document=structuredClone(template.version.document);
  const requirements=detail.requirementInterpretation?OrderRequirementInterpretationSchema.parse({
    ...detail.requirementInterpretation,basis:{...detail.requirementInterpretation.basis,templateVersionId:template.version.id},
  }):undefined;
  if(requirements && (requirements.basis.orderLineId!==detail.line.id || requirements.basis.revision!==detail.line.revision ||
    requirements.basis.sourceVersionId!==revision.sourceVersionId ||
    requirements.basis.draftChecksum!==createHash("sha256").update(orderRequirementDraftInput(detail.draft)).digest("hex")))
    throw new ConflictException("定制要求解释与已保存制作依据不一致，请刷新后核对");
  const photoOnlyPillow=isPhotoOnlyPillowArtwork(basis.artwork);
  const blockers:string[]=[];
  const preparationDiagnostics:NonNullable<OrderDesignSnapshot["preparationDiagnostics"]>=[];
  let pillow:ReturnType<typeof orderPillowPhotoPlan>=null;
  try {assertAutomaticArtwork(basis.artwork.customization,basis.artwork.layout,detail.draft,document.productType,photoOnlyPillow,requirements);
    pillow=photoOnlyPillow?orderPillowPhotoPlan(document.productType,basis.artwork.customization,basis.artwork.layout,detail.draft,requirements):null;
  } catch(error) {
    blockers.push(requirements?"agent_requirements_need_resolution":"agent_inputs_require_manual");
    if(error instanceof OrderArtworkLayoutError)preparationDiagnostics.push(safePreparationDiagnostic(error,requirements));
  }
  const recipe=DesignAutomationRecipeSchema.parse(document.automation??{schemaVersion:1,workflow:pillow?"pillow_photo":"template",imagePolicy:"preserve",modelRouteId:null,allowOrderImageTransfer:false,modelCallLimit:0,estimatedCostPerCallUsd:null,maxEstimatedCostUsd:null});
  if(!document.automation)blockers.push("agent_recipe_missing");
  if((recipe.workflow==="pillow_photo")!==!!pillow)blockers.push("agent_recipe_product_mismatch");
  if(recipe.pillowPipeline) {
    if(!template.version.reviewed)blockers.push("agent_template_review_required");
    if(document.productType!=="shaped_pillow" || document.spec.factoryStandardId!==recipe.pillowPipeline.factoryStandard)blockers.push("agent_pillow_factory_mismatch");
  }
  const assets:OrderDesignAssetPin[]=[];const templateAssetKeys:Record<string,string>={};
  if(!basis.asset)document.layers=[];
  for(const layer of document.layers) {
    const assetId=layer.kind==="image"?layer.assetId:layer.fontId;
    if(assetId==="geist_regular" || templateAssetKeys[assetId])continue;
    const [asset]=await withTenant(database.db,context,tx=>tx.select().from(productionEditorImages).where(and(eq(productionEditorImages.projectId,template.project.id),eq(productionEditorImages.id,assetId))));
    if(!asset)throw new ConflictException("模板素材版本不可用");
    const key=createEntityId();templateAssetKeys[assetId]=key;
    assets.push({key,origin:"editor",kind:layer.kind==="image"?"image":"font",name:layer.kind==="image"?"模板图片":"模板字体",projectId:template.project.id,assetId,checksum:asset.checksum});
  }
  let masterAssetKey:string|null=null;
  for(const pin of basis.artwork.materials.filter(material=>material.role!=="reference")) {
    const kind=pin.mediaType.startsWith("image/")?"image":pin.role==="font"?"font":null;if(!kind)continue;
    const key=createEntityId();assets.push({key,origin:"authorized",assetId:pin.assetId,checksum:pin.checksumSha256,kind,name:pin.fileName});
    if(pin.role==="master")masterAssetKey=key;
  }
  for(const image of detail.draft.images)assets.push({key:createEntityId(),origin:image.origin==="upload"?"work":"report",kind:"image",name:`顾客原图 · ${image.usage}`,usage:image.usage,buyerOriginal:true,
    ...(image.origin==="upload"?{assetId:image.key}:{reportLineId:detail.line.reportLineId??undefined,reportVersionId:revision.sourceVersionId??undefined,fileKey:image.key})});
  const imageIds=assets.filter(asset=>asset.buyerOriginal).map(asset=>asset.key);
  const plannedModelCalls=(recipe.imagePolicy==="faithful_enhancement"?imageIds.length:0)+(recipe.workflow==="pillow_photo"?1:0);
  let model:OrderDesignSnapshot["model"]=null;
  if(plannedModelCalls>0 && recipe.modelRouteId) {
    model=await withTenant(database.db,context,async tx=>{
      const [route]=await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id,recipe.modelRouteId!),eq(modelRoutes.taskType,"studio_image"),eq(modelRoutes.status,"enabled")));
      const target=route?.targets.length===1?route.targets[0]:null;if(!target)return null;
      const [provider]=await tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id,target.providerConfigId),eq(modelProviderConfigs.status,"enabled")));
      if(!provider || !["openai","openai-compatible"].includes(provider.provider))return null;
      if(route!.updatedAt>templateVersion.createdAt || provider.updatedAt>templateVersion.createdAt){blockers.push("agent_model_configuration_changed");return null;}
      return {routeId:route!.id,providerConfigId:provider.id,model:target.providerModel,endpoint:provider.endpoint};
    });
    if(!model)blockers.push("agent_model_unavailable");
  }
  const runtime=recipe.pillowPipeline?await inspectPillowSuperResolutionRuntime():null;
  const plan=buildDesignAutomationPlan({recipe,imageIds,...(pillow?{pillowSubject:pillow.subject}:{}),
    ...(recipe.pillowPipeline?{configuredModel:model?.model??null,pillowRuntime:runtime?.available?runtime.upscale??null:null}:{})});
  const ruleSnapshot=await withTenant(database.db,context,tx=>resolveOrderRules(tx,document.productType,basis.specification.spuId));
  // This is a new capture only. Persist the actual template capability now;
  // never reinterpret an already pinned legacy/manual execution label later.
  if(!recipe.pillowPipeline)ruleSnapshot.rules=ruleSnapshot.rules.map(rule=>rule.binding==="pillow_pipeline_v1"
    ?{...rule,execution:"manual" as const,executionLocation:"当前固定模板未显式启用新版抱枕链，保留原流程并人工核验"}:rule);
  return {schemaVersion:1,ruleSnapshot,workItemId:detail.line.id,workRevisionId:revision.id,sourceVersionId:revision.sourceVersionId,
    templateProjectId:template.project.id,templateVersionId:template.version.id,templateChecksum:templateVersion.checksum,
    document,assets,templateAssetKeys,masterAssetKey,layout:basis.artwork.layout,customization:basis.artwork.customization,draft:detail.draft,photoOnlyPillow,recipe,plan,model,blockers,...(requirements?{requirements}:{}),...(preparationDiagnostics.length?{preparationDiagnostics}:{})};
}
