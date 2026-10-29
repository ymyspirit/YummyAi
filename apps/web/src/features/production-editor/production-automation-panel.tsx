"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { createPillowPipelineForModel, PILLOW_CONTOUR_GRAPH_VERSION, PillowImageModelSchema, PillowRuntimeCapabilitySchema, type DesignAutomationRecipe, type PillowRuntimeCapability, type PillowUpscalePolicy } from "@yummyai/contracts/pod/design-automation";
import { assertStudioCurrent, studioRpc, useStudioAccessFence, type StudioRequestContext } from "../creative-studio/studio-api";

type ImageModel = { id: string; label: string; capability: string; model: string };
const initialRecipe = (): DesignAutomationRecipe => ({ schemaVersion: 1, workflow: "template", imagePolicy: "preserve", modelRouteId: null,
  allowOrderImageTransfer: false, modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null });

/** Consent, spending policy and the model pin belong to the selected provider route. */
export function changeAutomationModelRoute(recipe: DesignAutomationRecipe, modelRouteId: string | null): DesignAutomationRecipe {
  if (recipe.modelRouteId === modelRouteId) return recipe;
  const next = { ...recipe, modelRouteId, allowOrderImageTransfer: false, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };
  delete next.costPolicy;
  delete next.pillowPipeline;
  return next;
}

export function setAutomationUnlimitedCost(recipe: DesignAutomationRecipe, unlimited: boolean): DesignAutomationRecipe {
  if (unlimited) return { ...recipe, costPolicy: "unlimited", maxEstimatedCostUsd: null };
  const next = { ...recipe };
  delete next.costPolicy;
  return next;
}

type PillowImageModel = NonNullable<DesignAutomationRecipe["pillowPipeline"]>["requiredModel"];
export function setPillowPipeline(recipe: DesignAutomationRecipe, upscale: PillowUpscalePolicy | null, model?: PillowImageModel): DesignAutomationRecipe {
  if (upscale) {
    if (!model || !recipe.modelRouteId) return recipe;
    return { ...recipe, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", pillowPipeline: createPillowPipelineForModel(upscale, model) };
  }
  const legacy = { ...recipe };
  delete legacy.pillowPipeline;
  return legacy;
}

/** Selecting the parent recipe never opts an operator into this pilot. */
export function setPillowContourWorkflow(recipe: DesignAutomationRecipe, enabled: boolean): DesignAutomationRecipe {
  if (!recipe.pillowPipeline) return recipe;
  const contour = { ...recipe.pillowPipeline.contour };
  if (enabled) contour.workflow = PILLOW_CONTOUR_GRAPH_VERSION;
  else delete contour.workflow;
  return { ...recipe, pillowPipeline: { ...recipe.pillowPipeline, contour } };
}

function runtimeStatusMessage(reason?: string): string {
  if (reason === "agent_upscale_platform_unsupported") return "当前服务环境不支持已固定的超分工具，不能派发新版抱枕链。";
  if (reason === "agent_upscale_runtime_integrity_failed") return "超分工具或模型文件校验失败，需修复配置后再派发。";
  if (reason?.startsWith("agent_upscale_")) return "超分工具尚未就绪，请完成配置并刷新状态后再派发。";
  return reason ?? "超分运行环境尚未验证，不能派发。";
}

/** Display only; dispatch verifies route, provider and runtime again server-side. */
export function pillowPipelineBlockers(recipe: DesignAutomationRecipe, models: ImageModel[], runtime: PillowRuntimeCapability | undefined): string[] {
  if (!recipe.pillowPipeline) return [];
  const messages: string[] = [];
  if (!recipe.modelRouteId) messages.push("尚未选择已验证的抱枕图像模型，不能派发。");
  else if (models.find(model => model.id === recipe.modelRouteId)?.model !== recipe.pillowPipeline.requiredModel) messages.push(`当前模型尚未验证为已固定的 ${recipe.pillowPipeline.requiredModel}，不能派发。`);
  if (!runtime?.available || !runtime.upscale) messages.push(runtimeStatusMessage(runtime?.reason));
  else if (Object.entries(recipe.pillowPipeline.upscale).some(([key, value]) => runtime.upscale?.[key as keyof PillowUpscalePolicy] !== value)) messages.push("超分工具或模型指纹已变化；需重新核对并启用新版配方，保存审核后再派发。");
  return messages;
}

export function ProductionAutomationPanel({ document, onChange, readOnly = false, disabled = false }: {
  document: ProductionEditorDocument; onChange: (next: ProductionEditorDocument) => void; readOnly?: boolean; disabled?: boolean;
}) {
  const studio = useStudioAccessFence("production-automation"), { capture } = studio;
  const recipe = document.automation;
  const [models, setModels] = useState<ImageModel[]>([]), [error, setError] = useState("");
  const [runtime, setRuntime] = useState<PillowRuntimeCapability>();
  const [refresh, setRefresh] = useState(0);
  useLayoutEffect(() => { setModels([]); setRuntime(undefined); }, [studio.key, studio.available]);
  useEffect(() => {
    if (!recipe || readOnly || !studio.available) return;
    const abort = new AbortController();
    let context: StudioRequestContext; try { context = capture(abort.signal); } catch { return; }
    setError("");
    void studioRpc<ImageModel[]>("unassigned", { operation: "models" }, abort.signal, context)
      .then(value => { assertStudioCurrent(context); setModels(value.filter(model => model.capability === "image")); })
      .catch(() => { if (!context.signal.aborted && context.isCurrent()) setError("图像模型暂时无法读取，请刷新或到模型设置核对。"); });
    return () => abort.abort();
  }, [!!recipe, readOnly, refresh, capture, studio.available]);
  useEffect(() => {
    if (!recipe || readOnly || document.productType !== "shaped_pillow" || !studio.available) return;
    const abort = new AbortController();
    let context: StudioRequestContext; try { context = capture(abort.signal); } catch { return; }
    setRuntime(undefined);
    void studioRpc<unknown>("unassigned", { operation: "pillow-runtime" }, abort.signal, context)
      .then(value => { assertStudioCurrent(context); setRuntime(PillowRuntimeCapabilitySchema.parse(value)); })
      .catch(() => { if (!context.signal.aborted && context.isCurrent()) setRuntime({ available: false, upscale: null, reason: "超分运行环境读取失败，请刷新后核对配置。" }); });
    return () => abort.abort();
  }, [!!recipe, document.productType, readOnly, refresh, capture, studio.available]);
  function replaceRecipe(next: DesignAutomationRecipe) {
    if (readOnly || disabled || !recipe) return;
    onChange({ ...document, automation: next });
  }
  function update(patch: Partial<DesignAutomationRecipe>) {
    if (recipe) replaceRecipe({ ...recipe, ...patch });
  }
  const modelRequired = recipe?.workflow === "pillow_photo" || recipe?.imagePolicy === "faithful_enhancement";
  const selectedPillowModel = PillowImageModelSchema.safeParse(models.find(model => model.id === recipe?.modelRouteId)?.model);
  const unlimitedCost = recipe?.costPolicy === "unlimited";
  const pipelineBlockers = recipe && !readOnly ? pillowPipelineBlockers(recipe, models, runtime) : [];
  if (recipe?.pillowPipeline && !readOnly && (document.productType !== "shaped_pillow" || document.spec.factoryStandardId !== recipe.pillowPipeline.factoryStandard)) {
    pipelineBlockers.push("工艺底稿尚未采用 ps-pillow-2026-09-17 工厂标准，不能派发新版抱枕链。");
  }
  const nullableAmount = (value: string) => value === "" ? null : Math.max(0, Math.min(1_000_000, Number(value)));
  return <section className="pe-inspector-section" aria-label="自动制图配方">
    <h2>自动制图配方</h2>
    {!recipe ? <>
      <p className="pe-hint">当前沿用已有制图与图片处理流程。配置配方后，新的派发任务将按固定步骤在后台制作，并保留执行进度。</p>
      {!readOnly && <button type="button" className="pe-button" disabled={disabled} onClick={() => onChange({ ...document, automation: initialRecipe() })}>配置可恢复的自动制图</button>}
    </> : <>
      <p className="pe-hint">{readOnly ? "此任务使用已固定的配方。修改通用底稿不会改变当前订单。" : "保存并审核底稿后供新订单使用。已派发订单保持原配方，自动制作完成后仍需审核。"}</p>
      <fieldset disabled={readOnly || disabled} className="pe-automation-fields">
        <label>制作流程<select value={recipe.workflow} onChange={event => {
          const workflow = event.target.value as DesignAutomationRecipe["workflow"];
          onChange({ ...document, automation: { ...(workflow === "template" ? setPillowPipeline(recipe, null) : recipe), workflow } });
        }}>
          <option value="template">固定模板排版</option>
          {document.productType === "shaped_pillow" && <option value="pillow_photo">来图抱枕：抠图、轮廓与正背片</option>}
        </select></label>
        <label>买家图片处理<select value={recipe.imagePolicy} disabled={!!recipe.pillowPipeline} onChange={event => update({ imagePolicy: event.target.value as DesignAutomationRecipe["imagePolicy"] })}>
          <option value="preserve">保留原图，不进行增强</option><option value="faithful_enhancement">先进行保真增强，再核对原图</option>
        </select></label>
        {recipe.workflow === "pillow_photo" && <p className="pe-hint">仅接受一张已绑定的买家照片，头部 / 全身与单 / 双面从已核对订单读取。抠图结果仍需核对主体和边缘。</p>}
        {document.productType === "shaped_pillow" && recipe.workflow === "pillow_photo" && <>
          <label className="pe-check"><input type="checkbox" checked={!!recipe.pillowPipeline} disabled={!recipe.pillowPipeline && (!runtime?.available || !selectedPillowModel.success)}
            onChange={event => replaceRecipe(setPillowPipeline(recipe, event.target.checked ? runtime?.upscale ?? null : null, selectedPillowModel.success ? selectedPillowModel.data : undefined))} />启用新版抱枕链：主体测量与按需超分</label>
          <p className="pe-hint">先保真美化，由配方固定的图像模型抠图并处理外伸长胡须；按可见主体测量和补足像素后，仅调整独立裁线。200 px 缝边，最多 30 px 圆滑余量，输出完整 JPG 待审稿。</p>
          {!recipe.pillowPipeline && !selectedPillowModel.success && <p className="pe-hint">请先选择已验证的 gpt-image-2.5、gpt-image-2.5-flare 或 gpt-image-2.5-sunburst 路由 再明确启用新版配方</p>}
          {recipe.pillowPipeline && <p className="pe-hint">已固定配方 {recipe.pillowPipeline.version} · {recipe.pillowPipeline.requiredModel}；Real-ESRGAN 20220424、x4plus 4×。保存并审核后仅供新任务使用。</p>}
          <label className="pe-check"><input type="checkbox" checked={recipe.pillowPipeline?.contour.workflow === PILLOW_CONTOUR_GRAPH_VERSION} disabled={!recipe.pillowPipeline}
            onChange={event => onChange({ ...document, automation: setPillowContourWorkflow(recipe, event.target.checked) })} />试用裁线检查与有限修正流程</label>
          <p className="pe-hint">需先启用新版抱枕链。保存并审核后仅供新任务使用；沿用固定工艺标准，只调整独立裁线，保持已锁定图案不变。通过技术检查后仍需人工审核。</p>
          {!readOnly && !runtime?.available && <p role="status" className="pe-hint">{runtime ? runtimeStatusMessage(runtime.reason) : "正在核对超分运行环境；状态未知时不能启用或派发新版抱枕链。"}</p>}
          {!readOnly && <button type="button" className="pe-button" onClick={() => setRefresh(value => value + 1)}>刷新模型与超分状态</button>}
        </>}
        {modelRequired && <>
          <label>固定图像模型<select value={recipe.modelRouteId ?? ""} onChange={event => replaceRecipe(changeAutomationModelRoute(recipe, event.target.value || null))}>
            <option value="">请选择获准处理订单图片的模型</option>
            {recipe.modelRouteId && !models.some(model => model.id === recipe.modelRouteId) && <option value={recipe.modelRouteId}>已固定模型（可用性待核对）</option>}
            {models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
          </select></label>
          <p className="pe-hint">更换模型后需重新核对提供方授权 费用模式与预估费用；新版抱枕链需重新明确启用。</p>
          <label className="pe-check"><input type="checkbox" checked={recipe.allowOrderImageTransfer} onChange={event => update({ allowOrderImageTransfer: event.target.checked })} />已核对所选提供方，允许用于本配方的订单图片处理</label>
          <label>每单模型调用次数上限<input type="number" min={0} max={100} step={1} value={recipe.modelCallLimit} onChange={event => update({ modelCallLimit: Math.max(0, Math.min(100, Math.trunc(Number(event.target.value)))) })} /></label>
          <label>费用模式<select value={unlimitedCost ? "unlimited" : "limited"} onChange={event => replaceRecipe(setAutomationUnlimitedCost(recipe, event.target.value === "unlimited"))}>
            <option value="limited">按预估费用限额</option><option value="unlimited">不限费用 记录实际用量</option>
          </select></label>
          <label>每次调用预估费用（USD）<input type="number" min={0} max={1_000_000} step="any" required={!unlimitedCost} value={recipe.estimatedCostPerCallUsd ?? ""} onChange={event => update({ estimatedCostPerCallUsd: nullableAmount(event.target.value) })} /></label>
          <label>每单预估费用上限（USD）<input type="number" min={0} max={1_000_000} step="any" disabled={unlimitedCost} required={!unlimitedCost} value={recipe.maxEstimatedCostUsd ?? ""} onChange={event => update({ maxEstimatedCostUsd: nullableAmount(event.target.value) })} /></label>
          <p className="pe-hint">{unlimitedCost ? "不限费用 记录实际用量 预估单价可不填；实际费用以渠道账单为准，组织余额与预算由服务器核对。" : "限额模式必须填写每次调用预估费用和每单预估费用上限。以上是配置的估算，不是提供方账单；未计价、缺少额度或预计超限时停止派发。"}多张图片逐张计次；请求结果不确定时不会自动再付费提交。</p>
        </>}
      </fieldset>
      {pipelineBlockers.length > 0 && <ul className="pe-error" aria-label="新版抱枕配方待处理">{pipelineBlockers.map(message => <li key={message}>{message}</li>)}</ul>}
      {error && <p role="alert" className="pe-error">{error} <button type="button" className="pe-button" disabled={disabled} onClick={() => setRefresh(value => value + 1)}>刷新模型</button></p>}
    </>}
  </section>;
}
