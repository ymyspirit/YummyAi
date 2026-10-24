"use client";

import { ProductionCutoutEditorViewSchema, ProductionEditorImageViewSchema, type ProductionEditorImageView } from "@yummyai/contracts/pod/production-editor-api";
import { ProductionCutoutRecipeSchema, SegmentProductionImageResultSchema, RefineProductionImageResultSchema, type CutoutRefineStroke, type CutoutBox, type CutoutOperation, type CutoutPoint, type ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";
import { cutoutMaskSvg } from "@yummyai/production-editor/cutout-svg";
import { BoxSelect, Brush, Check, Eraser, Feather, Lasso, LoaderCircle, Minus, MinusCircle, Plus, PlusCircle, Redo2, RotateCcw, Scissors, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { editorAssetUrl } from "./production-fabric-canvas";

type Tool = "box" | "keepPoint" | "removePoint" | "lasso" | "erase" | "restore" | "refine";
type View = ReturnType<typeof ProductionCutoutEditorViewSchema.parse>;
type Gesture = { start: CutoutPoint; points: CutoutPoint[] };
const emptyRecipe: ProductionCutoutRecipe = { schemaVersion: 1, maskPngBase64: null, operations: [] };

export function ProductionCutoutEditor({ projectId, imageId, expectedVersionId, headOnly, onApply, onCancel, onStateChange }: {
  projectId: string; imageId: string; expectedVersionId: string; headOnly: boolean;
  onApply: (image: ProductionEditorImageView) => void; onCancel: () => void;
  onStateChange: (state: { dirty: boolean; busy: boolean }) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [recipe, setRecipe] = useState(emptyRecipe);
  const [past, setPast] = useState<ProductionCutoutRecipe[]>([]), [future, setFuture] = useState<ProductionCutoutRecipe[]>([]);
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>("box");
  const [box, setBox] = useState<CutoutBox | null>(null);
  const [points, setPoints] = useState<Array<CutoutPoint & { keep: boolean }>>([]);
  const [lasso, setLasso] = useState<CutoutPoint[]>([]);
  const [gesture, setGesture] = useState<Gesture | null>(null), gestureRef = useRef<Gesture | null>(null);
  const [radius, setRadius] = useState(0.015), [softness, setSoftness] = useState(0.25);
  const [refineRadius, setRefineRadius] = useState(0.01), [strokes, setStrokes] = useState<CutoutRefineStroke[]>([]);
  const [cleanup, setCleanup] = useState(0.1);
  const [cursor, setCursor] = useState<CutoutPoint | null>(null);
  const [background, setBackground] = useState<"checker" | "white" | "black">("checker");
  const [original, setOriginal] = useState(false), [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false), [drawing, setDrawing] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lifecycle = useRef(new AbortController());
  const dirty = !!view && JSON.stringify(recipe) !== JSON.stringify(view.recipe);
  const pending = dirty || lasso.length > 0 || points.length > 0 || !!box || strokes.length > 0;
  const hasSelection = !!recipe.maskPngBase64 || recipe.operations.length > 0;
  const isBrush = tool === "erase" || tool === "restore" || tool === "refine";
  const displayWidth = photo ? Math.round(photo.naturalWidth * Math.min(1, 2048 / Math.max(photo.naturalWidth, photo.naturalHeight))) : 800;
  const displayHeight = photo ? Math.round(displayWidth * photo.naturalHeight / photo.naturalWidth) : 800;

  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    void (async () => {
      try {
        const data = ProductionCutoutEditorViewSchema.parse(await request(`projects/${projectId}/images/${imageId}/cutout`, undefined, controller.signal));
        const nativeFormat = ["image/png", "image/jpeg", "image/webp"].includes(data.source.mediaType);
        const image = await loadImage(editorAssetUrl(projectId, data.source.id, nativeFormat ? "original" : "preview"));
        if (controller.signal.aborted) return;
        setView(data); setRecipe(data.recipe); setPhoto(image);
      } catch { if (!controller.signal.aborted) setError("无法读取抠图素材，请关闭工具后重新打开。"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => controller.abort();
  }, [projectId, imageId]);

  useEffect(() => { onStateChange({ dirty: pending, busy: busy || loading }); }, [pending, busy, loading, onStateChange]);

  useEffect(() => {
    if (!photo) return;
    let cancelled = false;
    setDrawing(true);
    void (async () => {
      try {
        const maskImage = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(cutoutMaskSvg(recipe, displayWidth, displayHeight))}`);
        if (cancelled) return;
        const canvas = canvasRef.current, context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        canvas.width = displayWidth; canvas.height = displayHeight;
        context.clearRect(0, 0, displayWidth, displayHeight);
        context.drawImage(photo, 0, 0, displayWidth, displayHeight);
        if (!original) {
          const maskCanvas = window.document.createElement("canvas"); maskCanvas.width = displayWidth; maskCanvas.height = displayHeight;
          const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true })!;
          maskContext.drawImage(maskImage, 0, 0);
          const pixels = maskContext.getImageData(0, 0, displayWidth, displayHeight);
          for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i + 3] = pixels.data[i]!;
          maskContext.putImageData(pixels, 0, 0);
          context.globalCompositeOperation = "destination-in"; context.drawImage(maskCanvas, 0, 0); context.globalCompositeOperation = "source-over";
        }
      } catch { if (!cancelled) setError("抠图预览加载失败，请撤销最近操作或重新打开。"); }
      finally { if (!cancelled) setDrawing(false); }
    })();
    return () => { cancelled = true; };
  }, [photo, recipe, original, displayWidth, displayHeight]);

  function commit(next: ProductionCutoutRecipe) {
    const parsed = ProductionCutoutRecipeSchema.safeParse(next);
    if (!parsed.success) { setError("修整步骤过多，请先应用当前抠图结果。"); return; }
    setPast((values) => [...values.slice(-24), recipe]); setFuture([]); setRecipe(parsed.data); setError("");
  }
  function undo() { if (strokes.length) { setStrokes((values) => values.slice(0, -1)); return; } const previous = past.at(-1); if (!previous) return; setFuture((values) => [recipe, ...values]); setRecipe(previous); setPast((values) => values.slice(0, -1)); }
  function redo() { const next = future[0]; if (!next || strokes.length) return; setPast((values) => [...values, recipe]); setRecipe(next); setFuture((values) => values.slice(1)); }
  function addOperation(operation: CutoutOperation) { commit({ ...recipe, operations: [...recipe.operations, operation] }); }
  function finishLasso() { if (lasso.length < 3) return; addOperation({ kind: "polygon", mode: "keep", points: lasso }); setLasso([]); setNotice("已保留套索内区域，可用恢复画笔补回误删边缘。"); }
  function point(event: PointerEvent<SVGSVGElement>): CutoutPoint { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) }; }
  function down(event: PointerEvent<SVGSVGElement>) {
    if (busy || loading || !photo || event.button !== 0) return;
    const position = point(event);
    if (tool === "keepPoint" || tool === "removePoint") { if (points.length < 40) setPoints((values) => [...values, { ...position, keep: tool === "keepPoint" }]); return; }
    if (tool === "lasso") { if (lasso.length < 400) setLasso((values) => [...values, position]); return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    const next = { start: position, points: [position] }; gestureRef.current = next; setGesture(next);
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    setCursor(point(event));
    const current = gestureRef.current;
    if (!current || current.points.length >= 2000) return;
    const position = point(event), last = current.points.at(-1)!;
    if (Math.hypot(position.x - last.x, position.y - last.y) < 0.001) return;
    const next = { ...current, points: tool === "box" ? [current.start, position] : [...current.points, position] }; gestureRef.current = next; setGesture(next);
  }
  function up(event: PointerEvent<SVGSVGElement>) {
    const current = gestureRef.current; if (!current) return;
    const end = point(event); gestureRef.current = null; setGesture(null);
    if (tool === "box") {
      const selected = { x: Math.min(current.start.x, end.x), y: Math.min(current.start.y, end.y), width: Math.abs(current.start.x - end.x), height: Math.abs(current.start.y - end.y) };
      if (selected.width > 0.01 && selected.height > 0.01) { setBox(selected); setPoints([]); setNotice("范围已框选，可添加保留点和排除点，再生成选区。"); }
    } else if (tool === "refine") {
      if (strokes.length >= 80 || strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) + current.points.length + 1 > 8000) { setError("涂抹区域过多，请先细化当前区域。"); return; }
      setStrokes((values) => [...values, { radius, points: [...current.points.slice(0, 1999), end] }]);
    } else if (tool === "erase" || tool === "restore") addOperation({ kind: "brush", mode: tool, radius, softness, points: [...current.points.slice(0, 1999), end] });
  }
  async function segment() {
    if (!box || !view) return;
    setBusy(true); setError(""); setNotice("正在按框选范围生成选区…");
    try {
      const result = SegmentProductionImageResultSchema.parse(await request(`projects/${projectId}/images/${view.source.id}/segment`, { expectedVersionId, box, points }, lifecycle.current.signal));
      commit({ schemaVersion: 1, maskPngBase64: result.maskPngBase64, operations: [] }); setOriginal(false); setBox(null); setPoints([]);
      setNotice("主体选区已生成。毛发和胡须请继续用“毛发修复”；擦除／恢复适合修整明确的主体边界。");
    } catch (cause) { if (!lifecycle.current.signal.aborted) setError(cause instanceof Error ? cause.message : "自动选区失败，请用套索继续。"); }
    finally { if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  async function refine() {
    if (!view || !hasSelection || lasso.length) return;
    setBusy(true); setError(""); setNotice(strokes.length ? "正在从原图细化涂抹区域，通常需要几十秒…" : "正在细化整圈毛发边缘，通常需要几十秒…");
    try {
      const result = RefineProductionImageResultSchema.parse(await request(`projects/${projectId}/images/${view.source.id}/refine`, { expectedVersionId, recipe, radius: refineRadius, strokes }, lifecycle.current.signal));
      if (lifecycle.current.signal.aborted) return;
      commit({ schemaVersion: 1, maskPngBase64: result.maskPngBase64, operations: [] }); setStrokes([]); setOriginal(false); setBox(null); setPoints([]);
      setNotice("毛发细化完成，可撤销。请切换黑／白背景检查；遗漏的长胡须可用“毛发修复”沿原图再次涂抹。低对比度区域仍需人工核对。");
    } catch (cause) { if (!lifecycle.current.signal.aborted) { setNotice(""); setError(cause instanceof Error ? cause.message : "毛发细化失败，当前抠图仍保留。"); } }
    finally { if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  async function apply() {
    if (!view || lasso.length || strokes.length || !photo) return;
    setBusy(true); setError("");
    try {
      const image = ProductionEditorImageViewSchema.parse(await request(`projects/${projectId}/images/${view.source.id}/cutout`, { expectedVersionId, name: headOnly ? "头部抠图" : "主体抠图", recipe }, lifecycle.current.signal));
      if (!lifecycle.current.signal.aborted) onApply(image);
    } catch (cause) { if (!lifecycle.current.signal.aborted) setError(cause instanceof Error ? cause.message : "应用抠图失败。"); }
    finally { if (!lifecycle.current.signal.aborted) setBusy(false); }
  }
  const activeBox = tool === "box" && gesture ? { x: Math.min(gesture.start.x, gesture.points.at(-1)!.x), y: Math.min(gesture.start.y, gesture.points.at(-1)!.y), width: Math.abs(gesture.start.x - gesture.points.at(-1)!.x), height: Math.abs(gesture.start.y - gesture.points.at(-1)!.y) } : box;
  return <section className="pe-cutout-editor" aria-label="抠图与修边" onKeyDown={(event) => {
    if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); if (!busy) { if (event.shiftKey) redo(); else undo(); } }
    if (event.key === "Enter" && lasso.length >= 3 && !busy) { event.preventDefault(); finishLasso(); }
  }}>
    <header><div><h2><Scissors size={18} />抠图与修边</h2><p>{headOnly ? "仅保留完整头部：先框住头顶、双耳和下巴，排除身体。" : "框选顾客需要保留的主体，再检查并修整边缘。"}</p></div><button className="pe-button" disabled={busy} onClick={() => { if (!pending || window.confirm("抠图修改尚未应用，确定放弃并返回画布？")) onCancel(); }}><X size={15} />返回画布</button></header>
    {loading && <p role="status">正在读取保留的原图与修整记录…</p>}
    {error && <p className="pe-cutout-error" role="alert">{error}</p>}
    {view && <>
      <div className="pe-cutout-toolbar" role="toolbar" aria-label="抠图工具">
        {([{ id: "box", label: headOnly ? "框选头部" : "框选主体", Icon: BoxSelect }, { id: "keepPoint", label: "保留点", Icon: PlusCircle }, { id: "removePoint", label: "排除点", Icon: MinusCircle }, { id: "lasso", label: "套索保留", Icon: Lasso }, { id: "erase", label: "擦除", Icon: Eraser }, { id: "restore", label: "恢复", Icon: Brush }, { id: "refine", label: "毛发修复", Icon: Feather }] as const).map(({ id, label, Icon }) => <button className="pe-button" key={id} aria-pressed={tool === id} disabled={busy || lasso.length > 0 && id !== "lasso" || strokes.length > 0 && id !== "refine" || id === "refine" && (!hasSelection || !view.refinementAvailable)} onClick={() => { setTool(id); if (id === "refine") setOriginal(true); }}><Icon size={15} />{label}</button>)}
        <button className="pe-button" aria-label="撤销抠图步骤" disabled={busy || !past.length && !strokes.length} onClick={undo}><Undo2 size={16} /></button><button className="pe-button" aria-label="重做抠图步骤" disabled={busy || !future.length || strokes.length > 0} onClick={redo}><Redo2 size={16} /></button>
      </div>
      <div className="pe-cutout-options">
        {isBrush && <label>画笔直径<input aria-label="抠图画笔大小" type="range" min="0.001" max="0.15" step="0.001" disabled={busy} value={radius} onChange={(event) => setRadius(Number(event.target.value))} /><span>{Math.round(radius * Math.min(view.source.width, view.source.height) * 2)} 原图 px</span></label>}
        {(tool === "erase" || tool === "restore") && <label>边缘柔和度<input aria-label="抠图画笔柔和度" type="range" min="0" max="1" step="0.1" disabled={busy} value={softness} onChange={(event) => setSoftness(Number(event.target.value))} /></label>}
        {tool === "lasso" && <><span>沿要保留的边缘逐点点击，完成后闭合。</span><button className="pe-button" disabled={lasso.length < 3 || busy} onClick={finishLasso}>完成套索（{lasso.length}）</button><button className="pe-button" disabled={!lasso.length || busy} onClick={() => setLasso([])}>取消套索</button></>}
        <label>边缘检查背景<select aria-label="边缘检查背景" value={background} onChange={(event) => setBackground(event.target.value as typeof background)}><option value="checker">棋盘格</option><option value="white">白色</option><option value="black">黑色</option></select></label>
        <button className="pe-button" aria-pressed={original} onClick={() => setOriginal((value) => !value)}>{original ? "查看抠图结果" : "对照原图"}</button>
        <button className="pe-button" aria-label="缩小抠图预览" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value - 0.5))}><Minus size={15}/></button><span>视图 {zoom.toFixed(1)}×</span><button className="pe-button" aria-label="放大抠图预览" disabled={zoom >= 8} onClick={() => setZoom((value) => Math.min(8, value + 0.5))}><Plus size={15}/></button><button className="pe-button" disabled={zoom === 1} onClick={() => setZoom(1)}>适合窗口</button>
      </div>
      <div className="pe-cutout-actions"><button className="pe-button primary" disabled={busy || !box || !view.automaticAvailable || lasso.length > 0 || strokes.length > 0} onClick={() => void segment()}>{busy ? <LoaderCircle size={15} className="pe-spin"/> : <Scissors size={15}/>}生成所选部位抠图</button><button className="pe-button" disabled={busy || !points.length} onClick={() => setPoints([])}>清除提示点</button><button className="pe-button" disabled={busy} onClick={() => { commit(emptyRecipe); setPoints([]); setBox(null); setLasso([]); setStrokes([]); }}><RotateCcw size={15}/>恢复整张原图</button></div>
      <div className="pe-cutout-refine" role="group" aria-label="毛发边缘细化">
        <div><strong><Feather size={15}/>毛发边缘细化</strong><p>{strokes.length ? "紫色标记只限定待修复区域；计算后会从原图分离毛发与背景。" : "先细化整圈边缘；长胡须遗漏时，选择“毛发修复”，沿原图涂抹胡须及周围少量背景。"}</p></div>
        {!strokes.length && <label>边缘范围<select aria-label="毛发细化范围" disabled={busy} value={refineRadius} onChange={(event) => setRefineRadius(Number(event.target.value))}><option value="0.005">窄 · 细毛</option><option value="0.01">标准</option><option value="0.025">宽 · 粗选区</option></select></label>}
        <button className="pe-button" disabled={busy || drawing || !hasSelection || !view.refinementAvailable || lasso.length > 0} onClick={() => void refine()}><Feather size={15}/>{strokes.length ? `细化涂抹区域（${strokes.length}）` : "细化整圈边缘"}</button>
        {strokes.length > 0 && <button className="pe-button" disabled={busy} onClick={() => setStrokes([])}>清除涂抹</button>}
      </div>
      {hasSelection && <div className="pe-cutout-options"><label>残影清理<select aria-label="残影清理强度" value={cleanup} disabled={busy} onChange={(event) => setCleanup(Number(event.target.value))}><option value="0.05">轻度 · 5%</option><option value="0.1">标准 · 10%</option><option value="0.2">较强 · 20%</option><option value="0.3">强 · 30%</option></select></label><button className="pe-button" disabled={busy || drawing || strokes.length > 0 || lasso.length > 0} onClick={() => { addOperation({ kind: "clean-alpha", threshold: cleanup }); setOriginal(false); setNotice("已减淡半透明残影，可撤销。强度过大也会减淡细胡须，请对照原图检查。"); }}>清理半透明残影</button><span>只调整蒙版透明度；强度过大会损失细毛。</span></div>}
      {!view.automaticAvailable && <p className="pe-hint">自动选区服务尚未安装。套索、擦除和恢复仍可使用。</p>}
      {!view.refinementAvailable && <p className="pe-hint">毛发细化服务尚未安装。可继续使用手工修边，当前选区仍会保留。</p>}
      <p className="pe-cutout-status" role="status">{notice || "框选只限定处理范围；生成选区后，用画笔修整。套索保留可独立使用。"}{drawing && " 正在更新预览…"}</p>
      <div className={`pe-cutout-viewport ${background}`} aria-busy={busy}>
        <div className="pe-cutout-stage" style={{ width: `${zoom * 100}%`, maxWidth: `calc(60vh * ${displayWidth / displayHeight * zoom})` }}>
          <canvas ref={canvasRef} aria-label={original ? "抠图原始照片" : "当前抠图结果"} width={displayWidth} height={displayHeight}/>
          <svg viewBox={`0 0 ${displayWidth} ${displayHeight}`} role="img" aria-label="抠图选区操作区域" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => setCursor(null)} onPointerCancel={() => { gestureRef.current = null; setGesture(null); }}>
            {activeBox && <rect x={activeBox.x * displayWidth} y={activeBox.y * displayHeight} width={activeBox.width * displayWidth} height={activeBox.height * displayHeight} fill="none" stroke="#3b82f6" strokeWidth="3" strokeDasharray="8 4"/>}
            {points.map((p, index) => <g key={index}><circle cx={p.x * displayWidth} cy={p.y * displayHeight} r="10" fill={p.keep ? "#166534" : "#b91c1c"} stroke="white" strokeWidth="2"/><text x={p.x * displayWidth} y={p.y * displayHeight + 5} textAnchor="middle" fill="white" fontSize="18">{p.keep ? "+" : "−"}</text></g>)}
            {lasso.length > 0 && <polyline points={lasso.map((p) => `${p.x * displayWidth},${p.y * displayHeight}`).join(" ")} fill="#3b82f622" stroke="#2563eb" strokeWidth="3"/>}
            {strokes.map((stroke, index) => <polyline key={index} points={stroke.points.map((p) => `${p.x * displayWidth},${p.y * displayHeight}`).join(" ")} fill="none" stroke="#7c3aed70" strokeWidth={stroke.radius * Math.min(displayWidth, displayHeight) * 2} strokeLinecap="round" strokeLinejoin="round"/>)}
            {gesture && tool !== "box" && <polyline points={gesture.points.map((p) => `${p.x * displayWidth},${p.y * displayHeight}`).join(" ")} fill="none" stroke={tool === "refine" ? "#7c3aed70" : tool === "erase" ? "#ef444480" : "#22c55e80"} strokeWidth={radius * Math.min(displayWidth, displayHeight) * 2} strokeLinecap="round" strokeLinejoin="round"/>}
            {cursor && isBrush && !busy && <g pointerEvents="none"><circle cx={cursor.x * displayWidth} cy={cursor.y * displayHeight} r={radius * Math.min(displayWidth, displayHeight)} fill="none" stroke="white" strokeWidth="3" vectorEffect="non-scaling-stroke"/><circle cx={cursor.x * displayWidth} cy={cursor.y * displayHeight} r={radius * Math.min(displayWidth, displayHeight)} fill="none" stroke="#374151" strokeWidth="1" vectorEffect="non-scaling-stroke"/></g>}
          </svg>
        </div>
      </div>
      <footer><span>保留原件 {view.source.width} × {view.source.height} px · 修整 {recipe.operations.length} 步 · 原图对照{original ? "已开启" : "已关闭"} · 应用后仍可重新修边</span><button className="pe-button primary" disabled={busy || drawing || !dirty || lasso.length > 0 || strokes.length > 0} onClick={() => void apply()}><Check size={16}/>应用抠图并返回画布</button></footer>
    </>}
  </section>;
}

async function request(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/production-editor/${path}`, { method: body ? "POST" : "GET", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(110_000)]) : AbortSignal.timeout(110_000), ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 409 ? "订单或项目已更新，请重新打开后再抠图。" : response.status === 503 ? "抠图服务暂不可用或正在处理其他图片。当前修改仍保留，请稍后重试。" : response.status === 422 ? "需要同时保留主体和移除背景。请检查选区、蒙版及图片尺寸后重试。" : "抠图操作未完成，请检查素材访问权限后重试。");
  return response.json();
}
function loadImage(url: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("image_unavailable")); image.src = url; }); }
