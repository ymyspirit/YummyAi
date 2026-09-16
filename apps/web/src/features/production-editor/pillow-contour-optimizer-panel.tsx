"use client";

import { ProductionEditorDocumentSchema, type ProductionEditorImageLayer, type ProductionEditorPoint, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, getProductionLayout, polygonPath, sampleClosedContour } from "@yummyai/production-editor/geometry";
import { LoaderCircle, ScanLine, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { applyOptimizedPillowContour, DEFAULT_PILLOW_CONTOUR_SETTINGS, type PillowContourSettings } from "./pillow-contour-optimizer";
import { samplePillowImage } from "./pillow-outline";
import { NumberField } from "./production-editor-panels";
import { editorAssetUrl } from "./production-fabric-canvas";
import { PillowSheetPreview } from "./pillow-sheet-preview";

export function PillowContourOptimizerPanel({ document, image, projectId, disabledReason, onApply }: { document: ShapedPillowDocument; image: ProductionEditorImageLayer | null; projectId: string; disabledReason: string; onApply: (document: ShapedPillowDocument) => void }) {
  const [open, setOpen] = useState(false);
  // A project/version update invalidates the entire candidate, including a job
  // still sampling an image. It must never be applied to a different document.
  useEffect(() => setOpen(false), [document, projectId, image?.id]);
  return <section className="pe-contour-entry" aria-label="工艺轮廓优化">
    <button className="pe-button" disabled={!!disabledReason} title={disabledReason || undefined} onClick={() => setOpen(true)}><ScanLine size={15} />优化工艺轮廓</button>
    <span>{disabledReason || "保持图案不变 · 独立调整刀线 · 先预览再应用"}</span>
    {open && image && <PillowContourDialog document={document} image={image} projectId={projectId} onClose={() => setOpen(false)} onApply={onApply} />}
  </section>;
}

function PillowContourDialog({ document, image, projectId, onClose, onApply }: { document: ShapedPillowDocument; image: ProductionEditorImageLayer; projectId: string; onClose: () => void; onApply: (document: ShapedPillowDocument) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0), worker = useRef<Worker | null>(null), timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [settings, setSettings] = useState<PillowContourSettings>({ ...DEFAULT_PILLOW_CONTOUR_SETTINGS });
  const [mode, setMode] = useState<"current" | "subject">(document.contour.length > 4 ? "current" : "subject");
  const [candidate, setCandidate] = useState<ShapedPillowDocument | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [view, setView] = useState<"compare" | "sheet">("compare");
  useEffect(() => {
    dialog.current?.showModal();
    return () => { generation.current++; worker.current?.terminate(); if (timeout.current) clearTimeout(timeout.current); };
  }, []);
  function stop() { generation.current++; worker.current?.terminate(); worker.current = null; if (timeout.current) clearTimeout(timeout.current); timeout.current = null; setBusy(false); }
  function updateSettings(patch: Partial<PillowContourSettings>) { stop(); setSettings(value => ({ ...value, ...patch })); setCandidate(null); setError(""); }
  async function preview() {
    stop(); const token = generation.current;
    setBusy(true); setError(""); setCandidate(null);
    timeout.current = setTimeout(() => { if (generation.current === token) { stop(); setError("轮廓计算超时，请重试。"); } }, 30_000);
    try {
      const mask = mode === "subject" ? await samplePillowImage(editorAssetUrl(projectId, image.assetId, "preview"), image, document.spec.whiteBorderMm + settings.roundingPx * 25.4 / 150) : null;
      if (token !== generation.current) return;
      const task = new Worker(new URL("./pillow-contour.worker.ts", import.meta.url), { type: "module" }); worker.current = task;
      task.onmessage = (event: MessageEvent<{ points?: ProductionEditorPoint[]; error?: string }>) => {
        if (token !== generation.current) return;
        try {
          if (event.data.error || !event.data.points) throw new Error(event.data.error || "轮廓计算未返回结果。");
          const next = applyOptimizedPillowContour(document, event.data.points);
          ProductionEditorDocumentSchema.parse(next);
          setCandidate(next);
        } catch (cause) { setError(cause instanceof Error ? cause.message : "轮廓无法应用，请调整参数后重试。"); }
        finally { stop(); }
      };
      task.onerror = () => { if (token === generation.current) { stop(); setError("轮廓计算未完成，请重新预览。"); } };
      if (mask) task.postMessage({ mode: "subject", mask, whiteBorderMm: document.spec.whiteBorderMm, settings }, [mask.alpha.buffer]);
      else task.postMessage({ mode: "current", document, settings });
    } catch (cause) { if (token === generation.current) { stop(); setError(cause instanceof Error ? cause.message : "图片读取失败，请重试。"); } }
  }
  const layout = candidate ? getProductionLayout(candidate) : null;
  return <dialog className="pe-contour-dialog" ref={dialog} aria-label="工艺轮廓预览" onCancel={onClose} onClose={onClose} onKeyDown={event => { event.stopPropagation(); if ((event.ctrlKey || event.metaKey) && ["s", "z", "y"].includes(event.key.toLowerCase()) && !(event.target as HTMLElement).closest("input, textarea")) event.preventDefault(); }}>
    <header><div><h2>优化工艺轮廓</h2><p>只调整刀线，图片的尺寸、颜色和内容保持不变。</p></div><button className="pe-button" aria-label="关闭轮廓预览" onClick={onClose}><X size={16} /></button></header>
    <div className="pe-contour-dialog-body">
      <aside>
        <label>优化方式<select value={mode} disabled={busy} onChange={event => { updateSettings({}); setMode(event.target.value as "current" | "subject"); }}><option value="current">沿当前刀线圆滑 · 保留造型</option><option value="subject">按图片主体重建 · 过滤细线</option></select></label>
        {mode === "subject" && <><NumberField label="忽略细线宽度（px）" value={settings.fineDetailPx} min={0} max={30} integer disabled={busy} onChange={value => updateSettings({ fineDetailPx: value! })} />
        <p className="pe-hint">减少胡须、碎毛对刀线的影响。0 表示沿用完整主体边界；图片里的胡须会完整保留。</p></>}
        <NumberField label="圆滑余量（px）" value={settings.roundingPx} min={10} max={50} integer disabled={busy} onChange={value => updateSettings({ roundingPx: value! })} />
        <p className="pe-hint">{mode === "current" ? "沿现有刀线向外做有限圆滑，保留已核对的造型和白边。" : `以 ${Math.round(document.spec.whiteBorderMm * 150 / 25.4)}px 白边为基础，允许局部增加余量，使裁剪线更平顺。`}耳朵、凹口和细窄处仍需核对。</p>
        <button className="pe-button primary pe-tool-wide" disabled={busy} onClick={() => void preview()}>{busy ? <LoaderCircle size={15} className="pe-spin" /> : <ScanLine size={15} />}{busy ? "正在计算轮廓…" : "预览优化效果"}</button>
        {busy && <button className="pe-button pe-tool-wide" onClick={stop}>取消计算</button>}
        <button className="pe-button pe-tool-wide" disabled={busy} onClick={() => updateSettings(DEFAULT_PILLOW_CONTOUR_SETTINGS)}>恢复默认参数</button>
        {candidate && <dl className="pe-spec-note"><div><dt>轮廓节点</dt><dd>{document.contour.length} → {candidate.contour.length}</dd></div><div><dt>整张文件</dt><dd>{layout!.widthPx} × {layout!.heightPx}px</dd></div><div><dt>外边距 / 正反片间距</dt><dd>50px / 100px</dd></div><div><dt>条码框</dt><dd>{candidate.spec.barcodeTab.widthMm && candidate.spec.barcodeTab.heightMm ? "随主体移至最下方" : "宽高待填写"}</dd></div></dl>}
      </aside>
      <section className="pe-contour-preview" aria-label="轮廓比较结果">
        {error && <p className="pe-alert" role="alert">{error}</p>}
        {candidate ? <><div className="pe-canvas-view-tabs" role="group" aria-label="轮廓预览方式"><button className="pe-button" aria-pressed={view === "compare"} onClick={() => setView("compare")}>刀线前后对比</button><button className="pe-button" aria-pressed={view === "sheet"} onClick={() => setView("sheet")}>正反片排版效果</button></div>{view === "compare" ? <ContourComparison original={document} candidate={candidate} image={image} projectId={projectId} /> : <PillowSheetPreview document={candidate} projectId={projectId} />}</> : <p className="pe-contour-placeholder" role="status">{busy ? "正在计算候选刀线，可随时取消。" : "点击「预览优化效果」，对比刀线与正反片排版。当前图稿尚未改动。"}</p>}
      </section>
    </div>
    <footer><p>应用后可撤销。保存会创建新版本，生产审核需重新确认。</p><button className="pe-button" onClick={onClose}>取消</button><button className="pe-button primary" disabled={!candidate || busy} onClick={() => { if (candidate) { onApply(candidate); onClose(); } }}>应用新刀线</button></footer>
  </dialog>;
}

function ContourComparison({ original, candidate, image, projectId }: { original: ShapedPillowDocument; candidate: ShapedPillowDocument; image: ProductionEditorImageLayer; projectId: string }) {
  const layer = candidate.layers.find(item => item.id === image.id) as ProductionEditorImageLayer;
  const dx = layer.xMm - image.xMm, dy = layer.yMm - image.yMm;
  const oldPoints = buildPillowContour(original).points.map(([x, y]) => [x + dx, y + dy] as [number, number]);
  const next = buildPillowContour(candidate), all = [...oldPoints, ...next.points, ...sampleClosedContour(candidate.contour)];
  const padding = 10, minX = Math.min(...all.map(([x]) => x)) - padding, minY = Math.min(...all.map(([, y]) => y)) - padding;
  const width = Math.max(...all.map(([x]) => x)) - minX + padding, height = Math.max(...all.map(([, y]) => y)) - minY + padding;
  return <div className="pe-contour-comparison"><svg role="img" aria-label="原刀线与优化刀线叠加对比" viewBox={`${minX} ${minY} ${width} ${height}`}>
    <g opacity={layer.opacity} transform={`translate(${layer.xMm} ${layer.yMm}) rotate(${layer.rotationDeg})`}><image href={editorAssetUrl(projectId, layer.assetId, "preview")} width={layer.widthMm} height={layer.heightMm} preserveAspectRatio="none" transform={`translate(${layer.flipX ? layer.widthMm : 0} ${layer.flipY ? layer.heightMm : 0}) scale(${layer.flipX ? -1 : 1} ${layer.flipY ? -1 : 1})`} /></g>
    <path d={polygonPath(oldPoints)} fill="none" stroke="#627da2" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
    <path d={next.path} fill="none" stroke="black" strokeWidth={candidate.spec.cutLineMm} strokeLinejoin="round" />
  </svg><p><span className="pe-contour-original-key">虚线：当前刀线</span><span>黑线：候选刀线</span></p></div>;
}
