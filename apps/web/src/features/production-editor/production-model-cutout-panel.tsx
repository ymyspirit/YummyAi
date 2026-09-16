"use client";

import { createEntityId } from "@yummyai/contracts/common/ids";
import { ORDER_IMAGE_ENHANCEMENT_INSTRUCTION } from "@yummyai/contracts/order/workspace";
import { ProductionEditorImageViewSchema, ProductionEditorRenderViewSchema, type ProductionEditorImageView, type ProductionEditorRenderView } from "@yummyai/contracts/pod/production-editor-api";
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { studioRpc } from "../creative-studio/studio-api";

type ImageModel = { id: string; label: string; capability: string; isDefault: boolean };
export function OrderImageEnhancementPanel({ projectId, versionId, renders, disabled, onQueue }: {
  projectId: string; versionId: string; renders: ProductionEditorRenderView[]; disabled: boolean;
  onQueue: (render: ProductionEditorRenderView) => void;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const request = useRef<{ versionId: string; id: string } | null>(null);
  const job = renders.find(render => render.purpose === "order_image_enhancement");
  if (!job) return null;
  async function retry() {
    setPending(true); setError("");
    if (request.current?.versionId !== versionId || request.current.id === job?.id && job?.status === "failed") request.current = { versionId, id: createEntityId() };
    try {
      const response = await fetch(`/api/production-editor/projects/${projectId}/enhance-order-images`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersionId: versionId, requestId: request.current.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "美化任务未提交，请检查默认图像模型。");
      const queued = ProductionEditorRenderViewSchema.parse(result); onQueue(queued);
      if (queued.status === "failed") request.current = null;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "美化任务暂不可用"); }
    finally { setPending(false); }
  }
  return <section className="pe-inspector-section" aria-label="顾客图片保真美化">
    <strong>顾客图片保真美化</strong>
    <p className="pe-hint" role="status">{job.status === "completed" ? "已完成，保留顾客原图，使用美化后的图片继续制作并交运营审核。" : job.status === "failed" ? "美化未完成，尚不能提交生产图审核。请核对默认图像模型后重试。" : "正在后台美化所有选定的顾客图片，完成后自动更新草稿。"}</p>
    <p className="pe-hint">无论顾客是否选择美化，统一优化清晰度、曝光和色彩，保留外貌与特征。</p>
    {job.status === "failed" && <button className="pe-button" disabled={disabled || pending} onClick={() => void retry()}>{pending ? "正在提交…" : "重试图片美化"}</button>}
    {error && <p className="pe-hint" role="alert">{error}</p>}
  </section>;
}
export function ProductionModelCutoutPanel({ projectId, versionId, images, renders, subject, disabled, onQueue, onImage }: {
  projectId: string; versionId: string; images: ProductionEditorImageView[]; renders: ProductionEditorRenderView[];
  subject?: "head" | "body" | null; disabled: boolean; onQueue: (render: ProductionEditorRenderView) => void; onImage: (image: ProductionEditorImageView) => void;
}) {
  const [models, setModels] = useState<ImageModel[]>([]), [modelId, setModelId] = useState("");
  const [sourceId, setSourceId] = useState(""), [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void studioRpc<ImageModel[]>("unassigned", { operation: "models" }, controller.signal).then(value => {
      const choices = value.filter(model => model.capability === "image"); setModels(choices); setModelId(choices.find(model => model.isDefault)?.id ?? choices[0]?.id ?? "");
    }).catch(() => { if (!controller.signal.aborted) setMessage("图像模型读取失败，请刷新页面。"); });
    return () => controller.abort();
  }, []);
  const sourceImageId = sourceId || images.find(image => image.name.startsWith("保真美化 · "))?.id || images.find(image => image.name.startsWith("buyer_photo"))?.id || images[0]?.id || "";
  const enhanced = images.find(image => image.id === sourceImageId)?.name.startsWith("保真美化 · ");
  const defaultPrompt = `${enhanced ? "输入图片已完成保真美化，保留图案不变，只做精确抠图。" : ORDER_IMAGE_ENHANCEMENT_INSTRUCTION + "先美化再精确抠图。"}${subject === "head" ? "仅保留完整头部，包含头顶、双耳和下巴，去掉颈部、身体和环境。" : subject === "body" ? "保留完整主体全身，去掉环境。" : "保留顾客指定主体，去掉环境。"}保持原貌、姿态、五官、毛发和颜色。输出真正有 alpha 透明通道的 PNG，透明区不能画成白底或棋盘格。主体尽量占满画面但不得裁掉边缘。不加缝边、描边、阴影、文字和条码框。`;
  const jobs = renders.filter(render => render.purpose === "image_edit" && render.versionId === versionId);
  const active = jobs.some(render => render.status === "queued" || render.status === "processing");
  async function call(path: string, body: unknown) {
    const response = await fetch(`/api/production-editor/projects/${projectId}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.message ?? "操作未完成，请刷新查看任务状态。"); return result;
  }
  async function generate() {
    setPending(true); setMessage("");
    try {
      const parameters = { expectedVersionId: versionId, modelId, prompt: prompt.trim() || defaultPrompt, size: "2048x2048" };
      const signature = JSON.stringify({ sourceImageId, ...parameters });
      if (attempt.current?.signature !== signature) attempt.current = { signature, id: createEntityId() };
      const render = ProductionEditorRenderViewSchema.parse(await call(`images/${sourceImageId}/model-cutout`, { ...parameters, requestId: attempt.current.id }));
      onQueue(render); setMessage("已提交所选图像模型，完成后检查结果并加入素材。");
      if (render.status === "failed") attempt.current = null;
    } catch (error) { setMessage(error instanceof Error ? error.message : "提交失败，请刷新查看任务状态。"); }
    finally { setPending(false); }
  }
  async function apply(renderId: string) {
    setPending(true); setMessage("");
    try { onImage(ProductionEditorImageViewSchema.parse(await call(`renders/${renderId}/apply-image`, { expectedVersionId: versionId }))); setMessage("AI 抠图已加入本项目素材，请选择图片放入画布并核对尺寸。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "结果无法应用。"); }
    finally { setPending(false); }
  }
  return <details className="pe-inspector-section"><summary><Sparkles size={14} /> AI 模型抠图</summary>
    <label>抠图模型<select value={modelId} onChange={event => setModelId(event.target.value)} disabled={pending || active}>{!models.length && <option value="">暂无已配置图像模型</option>}{models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
    <label>处理原图<select value={sourceImageId} onChange={event => setSourceId(event.target.value)} disabled={pending || active}>{images.map(image => <option key={image.id} value={image.id}>{image.name}</option>)}</select></label>
    <label>抠图要求<textarea value={prompt || defaultPrompt} onChange={event => setPrompt(event.target.value)} rows={6} disabled={pending || active} /></label>
    <button className="pe-button" disabled={disabled || pending || active || !modelId || !sourceImageId} onClick={() => void generate()}><Sparkles size={14} />{active ? "模型正在抠图…" : "用所选模型抠图"}</button>
    {disabled && <p className="pe-hint">先保存当前图稿版本，再提交模型处理。</p>}
    {message && <p className="pe-hint" role="status">{message}</p>}
    {jobs.slice(0, 3).map(job => <div key={job.id}>{job.status === "completed" ? <>
      {job.preflight && <p className="pe-hint">实际图片：{job.preflight.widthPx} × {job.preflight.heightPx} px。加入画布后按放置尺寸核验清晰度。</p>}
      <img src={`/api/production-editor/projects/${projectId}/renders/${job.id}/files/result`} alt="AI 模型抠图结果" style={{ maxWidth: "100%", height: "auto" }} referrerPolicy="no-referrer" />
      <button className="pe-button" disabled={disabled || pending || job.preflight?.issues.some(issue => issue.severity === "error")} onClick={() => void apply(job.id)}>将 AI 结果加入素材</button>
      {job.preflight?.issues.filter(issue => issue.severity !== "manual").map(issue => <p className="pe-hint" key={issue.code}>{issue.message}</p>)}
    </> : <p className="pe-hint">{job.status === "failed" ? "模型处理未完成；请检查渠道或模型参数。系统不会自动改用其他抠图方式。" : "后台处理中，可稍后刷新查看。"}</p>}</div>)}
  </details>;
}
