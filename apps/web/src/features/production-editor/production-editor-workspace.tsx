"use client";

import { ProductionEditorDocumentSchema, ProductionEditorPreflightSchema, type ProductionEditorDocument, type ProductionEditorExportOptions, type ProductionEditorLayer, type ProductionEditorPoint, type ProductionEditorPreflight } from "@yummyai/contracts/pod/production-editor";
import { ProductionEditorDetailViewSchema, ProductionEditorFontViewSchema, ProductionEditorImageViewSchema, ProductionEditorRenderViewSchema, ProductionEditorWorkspaceViewSchema, type ProductionEditorDetailView, type ProductionEditorProjectView, type ProductionEditorRenderView } from "@yummyai/contracts/pod/production-editor-api";
import { AmazonReportDetailViewSchema } from "@yummyai/contracts/order/report";
import { ArrowDown, ArrowUp, Check, Download, Eye, EyeOff, FileImage, FolderOpen, Hand, History, ImagePlus, Layers, LoaderCircle, LockKeyhole, Maximize2, MousePointer2, PenTool, Plus, Redo2, RefreshCw, Ruler, Save, ShieldCheck, Trash2, Type, Undo2, UnlockKeyhole, Upload, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { commitEditorHistory, createEditorHistory, redoEditorHistory, safeEditorFileName, undoEditorHistory } from "./editor-history";
import { ProductionFabricCanvas, editorAssetUrl, type ContourMode } from "./production-fabric-canvas";
import { ProductionConfirmations, ProductionContourPanel, ProductionLayerPanel, ProductionProcessPanel } from "./production-editor-panels";
import { createProductionDocument, invalidateProductionEdit, moveProductionLayer, newProductionImage, newProductionText, scalePillowArtwork, type ProductionKind } from "./production-editor-model";
import { applyPillowOutline, pillowSubjectLongest, samplePillowImage, tracePillowOutline } from "./pillow-outline";
import { PillowPreparationPanel } from "./pillow-preparation-panel";
import { PillowSheetPreview } from "./pillow-sheet-preview";
import { ProductionCutoutEditor } from "./production-cutout-editor";
import { OrderRequirementsPanel } from "./order-requirements-panel";
import { applyOrderProductionRequirements, orderProductionRequirements, type OrderProductionRequirements } from "./order-production-requirements";
import { alignProductionLayer, duplicateProductionLayer, fitArcFontSize, fitProductionImage, nudgeProductionLayer, printableBounds, replaceProductionImage, rotateProductionLayer, type LayoutAction } from "./production-layout-tools";
import { createLayerMeasurement } from "./production-layer-measurement";
import { ProductionLayoutPanel, ProductionResolutionPanel, ProductionShortcutHelp } from "./production-layout-panel";

type Source = { reportLineId: string; reportVersionId: string; title: string; requirements: OrderProductionRequirements };
const emptyFonts = [{ id: "geist_regular", name: "Geist Regular", builtin: true, originalPath: "" }];

export type ProductionEditorNavigationState = { dirty: boolean; busy: boolean };
export function ProductionEditorWorkspace({ kind = "shaped_pillow", initialProjectId, reportLineId, scope, onNavigationStateChange }: {
  kind?: ProductionKind; initialProjectId?: string; reportLineId?: string; scope?: "project" | "order" | "templates";
  onNavigationStateChange?: (state: ProductionEditorNavigationState) => void;
}) {
  const [projects, setProjects] = useState<ProductionEditorProjectView[]>([]);
  const [detail, setDetail] = useState<ProductionEditorDetailView | null>(null);
  const [history, setHistory] = useState(() => createEditorHistory(createProductionDocument(kind)));
  const document = history.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(!initialProjectId);
  const [createKind, setCreateKind] = useState(kind);
  const [createName, setCreateName] = useState(kind === "shaped_pillow" ? "异形抱枕生产稿" : "圆形胎罩生产稿");
  const [source, setSource] = useState<Source | null>(null);
  const [useSource, setUseSource] = useState(!!reportLineId);
  const [sourceLoading, setSourceLoading] = useState(!!reportLineId);
  const [cutoutTarget, setCutoutTarget] = useState<{ layerId: string; imageId: string } | null>(null);
  const [cutoutState, setCutoutState] = useState({ dirty: false, busy: false });
  const updateCutoutState = useCallback((state: { dirty: boolean; busy: boolean }) => setCutoutState(state), []);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [zoom, setZoom] = useState(1);
  const [fitToken, setFitToken] = useState(0);
  const [canvasView, setCanvasView] = useState<"front" | "sheet">("front");
  const [contourMode, setContourMode] = useState<ContourMode>("off");
  const [draftPoints, setDraftPoints] = useState<ProductionEditorPoint[]>([]);
  const [inspector, setInspector] = useState<"layer" | "process" | "confirm">("process");
  const [format, setFormat] = useState<ProductionEditorExportOptions["format"]>("png");
  const [background, setBackground] = useState<ProductionEditorExportOptions["background"]>("transparent");
  const [preflight, setPreflight] = useState<ProductionEditorPreflight | null>(null);
  const [previewSignature, setPreviewSignature] = useState("");
  const context = useRef(0);
  const previewSnapshots = useRef(new Map<string, string>());
  const imageInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const workspaceElement = useRef<HTMLDivElement>(null);
  const measurements = useRef(createLayerMeasurement());
  const shortcutHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  shortcutHandler.current = handleShortcut;
  const dirty = !!detail && JSON.stringify(document) !== JSON.stringify(detail.version.document);
  const hasUnsavedWork = dirty || cutoutState.dirty || contourMode === "draw" && draftPoints.length > 0;
  const dirtyRef = useRef(hasUnsavedWork); dirtyRef.current = hasUnsavedWork;
  const busyRef = useRef(busy); busyRef.current = busy || loading || !!cutoutTarget;
  const mutatingRef = useRef(busy); mutatingRef.current = busy || cutoutState.busy;
  const documentRef = useRef(document); documentRef.current = document;
  const detailRef = useRef(detail); detailRef.current = detail;
  const selected = document.layers.find((layer) => layer.id === selectedId) ?? null;
  const activeRenders = useMemo(() => detail?.renders.filter((render) => render.status === "queued" || render.status === "processing") ?? [], [detail?.renders]);
  const matchingPreview = detail?.renders.find((render) => render.purpose === "preview" && render.status === "completed" && ((render.versionId === detail.version.id && visualSignature(detail.version.document) === visualSignature(document)) || previewSnapshots.current.get(render.id) === visualSignature(document)));
  const hasPreview = !!matchingPreview && previewSignature === visualSignature(document);
  const images = detail?.images ?? [];
  const traceImage = selected?.kind === "image" ? images.find((image) => image.id === selected.assetId && image.version === selected.assetVersion) : null;
  const canTrace = !!traceImage?.actualAlpha && !!selected?.visible && !selected?.locked && contourMode !== "draw";
  const traceHint = !selected || selected.kind !== "image" ? "先选中一张图片，用抠图与修边保留所需部位。" : selected.locked ? "请先解锁所选图片。" : !traceImage?.actualAlpha ? "所选图片没有透明区域，请先打开抠图与修边。" : "根据所选透明图生成初始轮廓，可撤销并手动修整。";

  useEffect(() => {
    onNavigationStateChange?.({ dirty: hasUnsavedWork, busy: busy || cutoutState.busy });
  }, [hasUnsavedWork, busy, cutoutState.busy, onNavigationStateChange]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const workspace = ProductionEditorWorkspaceViewSchema.parse(await editorRequest("projects", undefined, "GET", controller.signal));
        let currentSource: Source | null = null;
        if (reportLineId) {
          const response = await fetch(`/api/orders/reports/lines/${encodeURIComponent(reportLineId)}`, { cache: "no-store", signal: controller.signal });
          if (!response.ok) throw new Error("当前账号无法读取订单原图，请检查定制资料权限。");
          const report = AmazonReportDetailViewSchema.parse(await response.json());
          if (!report.versionId || !report.line.reviewed) throw new Error("订单定制版本尚未核对，请先在订单工作台中完成核对。");
          currentSource = { reportLineId, reportVersionId: report.versionId, title: report.line.title, requirements: orderProductionRequirements(report) };
        }
        if (controller.signal.aborted) return;
        setSource(currentSource);
        const available = workspace.projects.filter((project) => scope === "project" ? project.id === initialProjectId
          : scope === "order" ? project.source?.reportLineId === reportLineId && project.source?.reportVersionId === currentSource?.reportVersionId
          : scope === "templates" ? !project.source : true);
        setProjects(available);
        const resumeId = initialProjectId ?? (scope === "order" ? available[0]?.id : undefined);
        if (resumeId) await openProject(resumeId, undefined, false);
      } catch (cause) { if (!controller.signal.aborted) setError(editorError(cause)); }
      finally { if (!controller.signal.aborted) { setLoading(false); setSourceLoading(false); } }
    })();
    return () => { controller.abort(); context.current += 1; };
  }, [initialProjectId, reportLineId, scope]);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyRef.current) event.preventDefault(); }
    function linkClick(event: MouseEvent) {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download") || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const target = new URL(anchor.href, window.location.href);
      if (target.pathname === window.location.pathname && target.search === window.location.search) return;
      if (mutatingRef.current || dirtyRef.current && !window.confirm("生产稿还有未保存的改动，确定放弃改动并离开？")) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }
    function keys(event: KeyboardEvent) {
      if (busyRef.current) return;
      const element = event.target as HTMLElement;
      if (!workspaceElement.current?.contains(element) || event.defaultPrevented || event.isComposing || element.closest("input, textarea, select, [contenteditable=true]")) return;
      shortcutHandler.current(event);
    }
    window.addEventListener("beforeunload", beforeUnload); window.addEventListener("keydown", keys);
    window.document.addEventListener("click", linkClick, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("keydown", keys); window.document.removeEventListener("click", linkClick, true); };
  }, []);

  useEffect(() => {
    if (!detail || activeRenders.length === 0) return;
    const token = context.current;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      for (const job of activeRenders) {
        try {
          const result = ProductionEditorRenderViewSchema.parse(await editorRequest(`projects/${detail!.project.id}/renders/${job.id}`));
          if (cancelled || token !== context.current) return;
          setDetail((value) => value ? { ...value, renders: value.renders.map((render) => render.id === result.id ? result : render) } : value);
          if (result.status === "completed" && result.purpose === "preview") {
            const signature = previewSnapshots.current.get(result.id);
            if (signature) setPreviewSignature(signature);
          }
          const savedVersion = detailRef.current?.version;
          if (result.preflight && savedVersion?.id === result.versionId && JSON.stringify(documentRef.current) === JSON.stringify(savedVersion.document)) setPreflight(result.preflight);
        } catch { if (!cancelled) setNotice("后台任务仍保留，状态暂时无法读取。可刷新项目继续查看。"); }
      }
      if (!cancelled) timeout = setTimeout(() => void poll(), 2500);
    }
    timeout = setTimeout(() => void poll(), 1800);
    return () => { cancelled = true; if (timeout) clearTimeout(timeout); };
  }, [detail?.project.id, activeRenders]);

  function changeDocument(next: ProductionEditorDocument, invalidate = true) {
    setHistory((value) => commitEditorHistory(value, invalidate ? invalidateProductionEdit(value.present, next) : next));
    setPreflight(null);
  }
  function patchLayer(id: string, patch: Partial<ProductionEditorLayer>) { changeDocument({ ...document, layers: document.layers.map((layer) => layer.id === id ? { ...layer, ...patch } as ProductionEditorLayer : layer) }); }
  function applyDetail(value: ProductionEditorDetailView) {
    measurements.current.clear();
    setCutoutTarget(null); setCutoutState({ dirty: false, busy: false });
    setDetail(value); setHistory(createEditorHistory(value.version.document)); setSelectedId(null); setContourMode("off"); setDraftPoints([]); setPreflight(null); setZoom(1); setCanvasView("front"); setFitToken((value) => value + 1);
    const preview = value.renders.find((render) => render.purpose === "preview" && render.status === "completed" && render.versionId === value.version.id);
    setPreviewSignature(preview ? visualSignature(value.version.document) : "");
    setProjects((items) => [value.project, ...items.filter((item) => item.id !== value.project.id)]);
  }
  async function openProject(id: string, versionId?: string, ask = true) {
    if (ask && dirtyRef.current && !window.confirm("当前改动尚未保存。继续打开其他版本或项目？")) return;
    const token = ++context.current;
    setLoading(true); setError(""); setNotice("");
    try {
      const value = ProductionEditorDetailViewSchema.parse(await editorRequest(`projects/${id}${versionId ? `?versionId=${encodeURIComponent(versionId)}` : ""}`));
      let projectSource: Source | null = null;
      if (value.project.source) {
        const pinned = value.project.source;
        const response = await fetch(`/api/orders/reports/lines/${encodeURIComponent(pinned.reportLineId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("当前账号无法读取订单制作要求。");
        const report = AmazonReportDetailViewSchema.parse(await response.json());
        if (report.versionId !== pinned.reportVersionId || !report.line.reviewed) throw new Error("订单定制版本已变化，请返回订单重新核对。");
        projectSource = { ...pinned, title: report.line.title, requirements: orderProductionRequirements(report) };
      }
      if (token === context.current) { applyDetail(value); setShowCreate(false); if (projectSource || !reportLineId) setSource(projectSource); }
    }
    catch (cause) { if (token === context.current) setError(editorError(cause)); }
    finally { if (token === context.current) setLoading(false); }
  }
  async function perform(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(""); setNotice(""); try { await action(); } catch (cause) { setError(editorError(cause)); } finally { setBusy(false); } }
  function selectLayer(id: string) { setSelectedId(id); setInspector("layer"); setContourMode("off"); setCanvasView("front"); }
  function duplicateLayer() {
    if (!selected || selected.locked || document.layers.length >= 100) return;
    const id = `${selected.kind}_${crypto.randomUUID()}`;
    changeDocument(duplicateProductionLayer(document, selected.id, id)); selectLayer(id);
  }
  function deleteLayer() {
    if (!selected || selected.locked) return;
    changeDocument({ ...document, layers: document.layers.filter((layer) => layer.id !== selected.id) }); setSelectedId(null);
  }
  function saveCurrent() { void perform(async () => { const saved = await saveDocument(); setNotice(`已保存版本 V${saved.version.versionNumber}。`); }); }
  function handleShortcut(event: KeyboardEvent) {
    if (!detail || contourMode === "draw" || cutoutTarget || event.altKey) return;
    const key = event.key.toLowerCase(), command = event.ctrlKey || event.metaKey;
    if (command && ["s", "d", "z", "y"].includes(key)) {
      event.preventDefault(); if (event.repeat) return;
      if (key === "s") saveCurrent();
      if (key === "d" && contourMode === "off" && canvasView === "front") duplicateLayer();
      if (key === "z") { setHistory((value) => event.shiftKey ? redoEditorHistory(value) : undoEditorHistory(value)); setPreflight(null); }
      if (key === "y") { setHistory(redoEditorHistory); setPreflight(null); }
      return;
    }
    if (command || contourMode !== "off" || canvasView !== "front" || !selected || selected.locked) return;
    if (key === "delete") { event.preventDefault(); if (!event.repeat) deleteLayer(); }
    const directions: Record<string, [number, number]> = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    const direction = directions[key];
    if (direction) { event.preventDefault(); const step = event.shiftKey ? 10 : 1; patchLayer(selected.id, nudgeProductionLayer(selected, direction[0] * step, direction[1] * step)); }
  }
  async function layoutAction(action: LayoutAction) {
    if (!selected || selected.locked || !selected.visible || !detail) return;
    await perform(async () => {
      let next = selected;
      const target = printableBounds(document, action === "cover");
      if (action === "cover" && next.kind === "image") {
        const assetId = next.assetId;
        const image = images.find((item) => item.id === assetId);
        if (!image || image.actualAlpha) return;
        const scale = Math.max(target.width / image.width, target.height / image.height);
        next = { ...next, rotationDeg: 0, widthMm: image.width * scale, heightMm: image.height * scale, xMm: target.x + (target.width - image.width * scale) / 2, yMm: target.y + (target.height - image.height * scale) / 2 };
      } else if (action === "resetRatio" && next.kind === "image") {
        const assetId = next.assetId;
        const image = images.find((item) => item.id === assetId); if (!image) return;
        next = { ...replaceProductionImage(next, image), name: next.name };
      } else if (next.kind === "text" && (action === "arcText" || action === "straightText" || action === "fitArc")) {
        if (action === "arcText") next = { ...next, rotationDeg: 0, xMm: target.x + target.width / 2, yMm: target.y + target.height / 2, arc: { radiusMm: Math.min(target.width, target.height) * 0.35, startAngleDeg: -150, endAngleDeg: -30 } };
        else if (action === "straightText") {
          const oldBounds = await measurements.current.measure(detail.project.id, next);
          next = { ...next, arc: null };
          const bounds = await measurements.current.measure(detail.project.id, next);
          next = alignProductionLayer(alignProductionLayer(next, bounds, oldBounds, "centerX"), bounds, oldBounds, "centerY");
        } else {
          const font = await measurements.current.font(detail.project.id, next.fontId);
          const { productionTextMetrics } = await import("@yummyai/production-editor/text");
          next = fitArcFontSize(next, productionTextMetrics(font, next).advances.reduce((sum, n) => sum + n, 0));
        }
      } else {
        const bounds = await measurements.current.measure(detail.project.id, next);
        if (action === "rotateLeft" || action === "rotateRight") next = rotateProductionLayer(next, bounds, action === "rotateLeft" ? -90 : 90);
        else if (action === "fit" && next.kind === "image") next = fitProductionImage(next, bounds, target);
        else next = alignProductionLayer(next, bounds, target, action);
      }
      const nextDocument = { ...document, layers: document.layers.map((layer) => layer.id === next.id ? next : layer) };
      if (!ProductionEditorDocumentSchema.safeParse(nextDocument).success) throw new Error("图稿调整后超出尺寸范围，请先缩小图层或修改工艺尺寸。");
      changeDocument(nextDocument); setCanvasView("front"); setContourMode("off");
      setNotice(document.productType === "shaped_pillow" ? "排版已更新，可撤销。请核对主体与原轮廓是否贴合，必要时重新生成抱枕轮廓。" : "排版已更新，可撤销。请核对圆形边缘和开孔位置。");
    });
  }
  function replaceImage(imageId: string) {
    const image = images.find((item) => item.id === imageId);
    if (selected?.kind !== "image" || selected.locked || !image) return;
    patchLayer(selected.id, replaceProductionImage(selected, image));
    setNotice("所选图层已替换，原素材仍保留。请核对主体位置与轮廓，可撤销恢复。");
  }
  async function saveDocument(): Promise<ProductionEditorDetailView> {
    if (!detail) throw new Error("请先创建或打开项目。");
    const valid = ProductionEditorDocumentSchema.safeParse(document);
    if (!valid.success) throw new Error("图稿参数尚不完整，请检查名称、文字、轮廓和数值范围。");
    if (!dirty && detail.version.id === detail.project.currentVersionId) return detail;
    const saved = ProductionEditorDetailViewSchema.parse(await editorRequest(`projects/${detail.project.id}/versions`, { expectedVersionId: detail.project.currentVersionId, document: valid.data }));
    setDetail(saved); setHistory(createEditorHistory(saved.version.document)); setProjects((items) => [saved.project, ...items.filter((item) => item.id !== saved.project.id)]);
    return saved;
  }
  async function createProject() {
    if (dirtyRef.current && !window.confirm("当前改动尚未保存。继续新建项目？")) return;
    await perform(async () => {
      if (useSource && !source) throw new Error("订单原图尚未就绪，请先完成订单核对或取消使用订单来源。");
      let doc = createProductionDocument(createKind); doc.name = createName;
      if (useSource && source) doc = applyOrderProductionRequirements(doc, source.requirements);
      const payload = ProductionEditorDocumentSchema.safeParse(doc);
      if (!payload.success) throw new Error("请填写有效的项目名称。");
      const created = ProductionEditorDetailViewSchema.parse(await editorRequest("projects", { name: createName, document: payload.data, ...(useSource && source ? { source: { reportLineId: source.reportLineId, reportVersionId: source.reportVersionId } } : {}) }));
      context.current += 1; applyDetail(created); setShowCreate(false); setInspector("process");
      if (created.images[0]) { const layer = newProductionImage(created.version.document, created.images[0]); setHistory(commitEditorHistory(createEditorHistory(created.version.document), { ...created.version.document, layers: [layer] })); setSelectedId(layer.id); }
      setNotice("项目已创建。起始参数尚待确认，可以继续编辑并保存草稿。");
    });
  }
  function addImage(id: string) { const image = images.find((item) => item.id === id); if (!image) return; const layer = newProductionImage(document, image); changeDocument({ ...document, layers: [...document.layers, layer] }); setSelectedId(layer.id); setInspector("layer"); setContourMode("off"); setCanvasView("front"); }
  function addText(arc: boolean) { const layer = newProductionText(document, arc); changeDocument({ ...document, layers: [...document.layers, layer] }); setSelectedId(layer.id); setInspector("layer"); setContourMode("off"); setCanvasView("front"); }
  async function upload(file: File | undefined, type: "images" | "fonts", replacementId?: string) {
    if (!file || !detail) return;
    await perform(async () => {
      const max = type === "images" ? 64 : 10;
      if (!file.size || file.size > max * 1024 * 1024 || !(type === "images" ? /\.(png|jpe?g|tiff?)$/i : /\.(ttf|otf)$/i).test(file.name)) throw new Error(type === "images" ? "请选择不超过 64 MB 的 PNG、JPEG 或 TIFF 图片。" : "请选择不超过 10 MB 的 TTF 或 OTF 字体文件。");
      const value = await editorRequest(`projects/${detail.project.id}/${type}`, { name: file.name, contentBase64: await fileBase64(file) });
      if (type === "images") {
        const image = ProductionEditorImageViewSchema.parse(value);
        setDetail((current) => current ? { ...current, images: [...current.images.filter((item) => item.id !== image.id), image] } : current);
        const replacing = document.layers.find((layer) => layer.id === replacementId);
        const layer = replacing?.kind === "image" && !replacing.locked ? replaceProductionImage(replacing, image) : newProductionImage(document, image);
        changeDocument({ ...document, layers: replacing ? document.layers.map((item) => item.id === replacing.id ? layer : item) : [...document.layers, layer] }); selectLayer(layer.id);
        setNotice(replacing ? "已上传并替换所选图层，原素材仍保留。请核对主体位置与轮廓，可撤销恢复。" : image.actualAlpha ? "图片已加入画布，原件已单独保存。" : "图片已加入画布。这是压平图片，未检测到实际透明区域。");
      } else { const font = ProductionEditorFontViewSchema.parse(value); setDetail((current) => current ? { ...current, fonts: [...current.fonts.filter((item) => item.id !== font.id), font] } : current); setNotice("字体已加入此项目，可在文字图层中选择。"); }
    });
    if (imageInput.current) imageInput.current.value = ""; if (fontInput.current) fontInput.current.value = ""; if (replaceInput.current) replaceInput.current.value = "";
  }
  async function checkPreflight() { await perform(async () => { const saved = await saveDocument(); setPreflight(ProductionEditorPreflightSchema.parse(await editorRequest(`projects/${saved.project.id}/preflight`, { expectedVersionId: saved.version.id, format, background, purpose: "production" }))); setInspector("confirm"); }); }
  async function requestRender(purpose: "preview" | "production") {
    await perform(async () => {
      const saved = await saveDocument();
      const rendered = ProductionEditorRenderViewSchema.parse(await editorRequest(`projects/${saved.project.id}/renders`, { expectedVersionId: saved.version.id, format: purpose === "preview" ? "png" : format, background: purpose === "preview" ? "transparent" : background, purpose }));
      if (purpose === "preview") previewSnapshots.current.set(rendered.id, visualSignature(saved.version.document));
      setDetail((current) => current ? { ...current, renders: [rendered, ...current.renders.filter((item) => item.id !== rendered.id)] } : current);
      if (rendered.status === "completed" && purpose === "preview") setPreviewSignature(visualSignature(saved.version.document));
      if (rendered.preflight) setPreflight(rendered.preflight);
      setNotice(purpose === "preview" ? "后台校对预览已提交，完成后可在下方查看。" : "生产文件已提交后台生成。");
    });
  }
  async function approve() { await perform(async () => { if (!hasPreview || !document.confirmations.visualReview) throw new Error("请先查看当前图稿的后台预览并勾选视觉核对。"); const saved = await saveDocument(); const reviewed = ProductionEditorDetailViewSchema.parse(await editorRequest(`projects/${saved.project.id}/review`, { expectedVersionId: saved.version.id })); setDetail(reviewed); setHistory(createEditorHistory(reviewed.version.document)); setNotice("当前版本已确认。正式出图仍需生产预检通过。"); }); }
  async function removeProject() { if (!detail || !window.confirm(`删除项目“${detail.project.name}”及该项目的私有素材、版本和导出文件？`)) return; await perform(async () => { const id = detail.project.id; await editorRequest(`projects/${id}`, undefined, "DELETE"); context.current += 1; setDetail(null); setProjects((items) => items.filter((item) => item.id !== id)); setHistory(createEditorHistory(createProductionDocument(kind))); setSelectedId(null); setShowCreate(true); setNotice("项目已删除。"); }); }
  function contourPoints(points: ProductionEditorPoint[]) { if (contourMode === "draw") setDraftPoints(points); else if (document.productType === "shaped_pillow") changeDocument({ ...document, contour: points }); }
  function selectCanvasTool(mode: ContourMode) {
    if (contourMode === "draw" && draftPoints.length && mode !== "draw") { setNotice("请先完成轮廓或取消勾图，再切换工具；当前节点仍保留。"); return; }
    setContourMode(mode);
  }
  async function generatePillowOutline(fitToSize: boolean) {
    if (!detail || document.productType !== "shaped_pillow" || selected?.kind !== "image" || !canTrace) return;
    const token = context.current;
    await perform(async () => {
      const url = editorAssetUrl(detail.project.id, selected.assetId, "preview");
      let source = document;
      let mask = await samplePillowImage(url, selected, source.spec.whiteBorderMm);
      if (fitToSize && source.spec.declaredLongestMm) {
        const scaled = scalePillowArtwork(source, source.spec.declaredLongestMm / pillowSubjectLongest(mask));
        if (scaled.productType !== "shaped_pillow") return;
        source = scaled;
        const layer = source.layers.find((layer) => layer.id === selected.id);
        if (!layer || layer.kind !== "image") return;
        mask = await samplePillowImage(url, layer, source.spec.whiteBorderMm);
      }
      const next = applyPillowOutline(source, tracePillowOutline(mask, source.spec.whiteBorderMm));
      if (!ProductionEditorDocumentSchema.safeParse(next).success) throw new Error("图稿缩放后的尺寸超出允许范围，请调整图层后重试。");
      if (token !== context.current) return;
      changeDocument(next); setCanvasView("front"); setContourMode("edit"); setInspector("process"); setZoom(1); setFitToken((value) => value + 1);
      setNotice(`已生成 ${next.contour.length} 个节点的抱枕轮廓，条码位置已移到主体最下方。请检查细窄部位和白边，可撤销重做。`);
    });
  }

  return <div className="pe-workspace" ref={workspaceElement} tabIndex={-1}>
    {error && <p className="pe-alert" role="alert">{error}</p>}{notice && <p className="pe-notice" role="status">{notice}</p>}
    {source && <OrderRequirementsPanel requirements={source.requirements} document={document} disabled={busy || !!cutoutTarget} onApply={() => changeDocument(applyOrderProductionRequirements(document, source.requirements))} />}
    {detail && cutoutTarget && <ProductionCutoutEditor projectId={detail.project.id} imageId={cutoutTarget.imageId} expectedVersionId={detail.project.currentVersionId} headOnly={source?.requirements.subject === "head"} onStateChange={updateCutoutState} onCancel={() => { setCutoutTarget(null); setCutoutState({ dirty: false, busy: false }); }} onApply={(image) => {
      setDetail((current) => current ? { ...current, images: [...current.images.filter((item) => item.id !== image.id), image] } : current);
      changeDocument({ ...document, layers: document.layers.map((layer) => layer.id === cutoutTarget.layerId && layer.kind === "image" ? { ...layer, assetId: image.id, assetVersion: image.version, name: image.name } : layer) });
      setSelectedId(cutoutTarget.layerId); setCutoutTarget(null); setCutoutState({ dirty: false, busy: false }); setCanvasView("front"); setInspector("layer");
      setNotice("抠图已应用到所选图层，原件和修整记录已保留。请检查边缘，再生成抱枕轮廓并保存新版本。");
    }} />}
    <div className="pe-main-editor" hidden={!!cutoutTarget}>
    <div className="pe-project-bar"><label><FolderOpen size={15} /><select aria-label="打开生产项目" value={detail?.project.id ?? ""} disabled={busy || loading} onChange={(event) => { if (event.target.value) void openProject(event.target.value); }}><option value="">选择已保存项目</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.productType === "shaped_pillow" ? "抱枕" : "胎罩"} · {project.name} · V{project.versionNumber}</option>)}</select></label>{scope !== "project" && <button className="pe-button" disabled={busy || loading} onClick={() => setShowCreate((value) => !value)}><Plus size={15} />{scope === "order" ? "新建此订单生产稿" : "新建项目"}</button>}{detail && <><label className="pe-history-select"><History size={15} /><select aria-label="历史版本" value={detail.version.id} disabled={busy || loading} onChange={(event) => void openProject(detail.project.id, event.target.value)}>{detail.versions.map((version) => <option key={version.id} value={version.id}>V{version.versionNumber} · {version.reviewed ? "已确认" : "草稿"} · {formatDate(version.createdAt)}</option>)}</select></label><button className="pe-button" aria-label="刷新项目" disabled={busy || loading} onClick={() => void openProject(detail.project.id)}><RefreshCw size={15} /></button>{!scope && <button className="pe-button danger" disabled={busy || loading} onClick={() => void removeProject()}><Trash2 size={15} />删除项目</button>}</>}</div>
    {showCreate && <form className="pe-new-panel" onSubmit={(event) => { event.preventDefault(); void createProject(); }}><label>新项目名称<input value={createName} onChange={(event) => setCreateName(event.target.value)} maxLength={160} required /></label><label>产品类型<select value={createKind} onChange={(event) => setCreateKind(event.target.value as ProductionKind)}><option value="shaped_pillow">异形抱枕</option><option value="tire_cover">圆形胎罩</option></select></label>{reportLineId && <label className="pe-check"><input type="checkbox" checked={useSource} disabled={sourceLoading || scope === "order"} onChange={(event) => setUseSource(event.target.checked)} />{sourceLoading ? "正在读取订单来源…" : source ? `使用当前订单买家原图：${source.title}` : "使用当前订单买家原图（待就绪）"}</label>}<button className="pe-button primary" type="submit" disabled={busy || loading || (useSource && !source)}><Plus size={15} />创建生产草稿</button></form>}
    {loading && <div className="pe-empty" role="status"><LoaderCircle size={24} className="pe-spin" /><p>正在读取生产项目…</p></div>}
    {!detail && !loading && <div className="pe-empty"><FileImage size={30} /><h2>建立可继续编辑的生产稿</h2><p>选择产品并创建草稿，再加入订单原图或本地图片。原 PNG 会作为一个图片图层保留，文字和其他图层可以继续添加。</p></div>}
    {detail && !loading && <>
      <div className="pe-editor-toolbar" inert={busy}><label className="pe-document-name">图稿名称<input value={document.name} maxLength={160} onChange={(event) => changeDocument({ ...document, name: event.target.value }, false)} /></label><span className={`pe-save-state ${dirty ? "dirty" : ""}`}>{dirty ? "有未保存改动" : detail.version.reviewed ? `V${detail.version.versionNumber} 已确认` : `V${detail.version.versionNumber} 草稿`}</span><button className="pe-button" aria-label="撤销" disabled={busy || !history.past.length} onClick={() => setHistory(undoEditorHistory)}><Undo2 size={16} /></button><button className="pe-button" aria-label="重做" disabled={busy || !history.future.length} onClick={() => setHistory(redoEditorHistory)}><Redo2 size={16} /></button><button className="pe-button primary" disabled={busy || contourMode === "draw"} onClick={saveCurrent}><Save size={15} />{detail.version.id !== detail.project.currentVersionId ? "历史副本另存新版本" : "保存新版本"}</button></div>
      <ProductionShortcutHelp /><div className="pe-editor-grid" inert={busy || loading} aria-busy={busy || loading}>
        <aside className="pe-left-panel" inert={contourMode === "draw"}>
          <section className="pe-assets"><h2><ImagePlus size={15} />素材</h2><button className="pe-button" disabled={busy || document.layers.length >= 100} onClick={() => imageInput.current?.click()}><Upload size={15} />上传图片</button><input className="pe-file-input pe-image-input" ref={imageInput} type="file" accept=".png,.jpg,.jpeg,.tif,.tiff" aria-label="上传生产图片" onChange={(event) => void upload(event.target.files?.[0], "images")} />
            <button className="pe-button" disabled={busy || selected?.kind !== "image" || !selected.visible || selected.locked || contourMode === "draw"} onClick={() => { if (selected?.kind === "image") { setCutoutTarget({ layerId: selected.id, imageId: selected.assetId }); setNotice(""); setError(""); } }}><PenTool size={15} />抠图与修边</button>
            <p className="pe-hint">选中图片后，框选顾客需要的部位并抠图，可用套索、擦除和恢复修边。</p>
            {images.length ? <ul className="pe-asset-list">{images.map((image) => <li key={image.id}><button onClick={() => addImage(image.id)} aria-label={`添加 ${image.name} 到画布`} disabled={document.layers.length >= 100}><img src={editorAssetUrl(detail.project.id, image.id, "preview")} alt={image.name} loading="lazy" referrerPolicy="no-referrer" /><span>{image.name}<small>{image.width} × {image.height} px</small></span><Plus size={14} /></button></li>)}</ul> : <p className="pe-hint">暂无图片素材。</p>}
          </section>
          <section className="pe-layer-list"><h2><Layers size={15} />图层 <small>{document.layers.length}</small></h2><div className="pe-inline-buttons"><button className="pe-button" onClick={() => addText(false)} disabled={document.layers.length >= 100}><Type size={14} />添加文字</button>{document.productType === "tire_cover" && <button className="pe-button" onClick={() => addText(true)} disabled={document.layers.length >= 100}><Type size={14} />弧形文字</button>}</div><ol>{[...document.layers].reverse().map((layer) => <li className={selectedId === layer.id ? "selected" : ""} key={layer.id}><button className="pe-layer-name" onClick={() => { setSelectedId(layer.id); setInspector("layer"); setContourMode("off"); setCanvasView("front"); }}>{layer.kind === "image" ? <FileImage size={14} /> : <Type size={14} />}<span>{layer.name || "未命名图层"}</span></button><button className="pe-icon-button" aria-label={`${layer.visible ? "隐藏" : "显示"} ${layer.name}`} onClick={() => patchLayer(layer.id, { visible: !layer.visible })}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button><button className="pe-icon-button" aria-label={`${layer.locked ? "解锁" : "锁定"} ${layer.name}`} onClick={() => patchLayer(layer.id, { locked: !layer.locked })}>{layer.locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</button></li>)}</ol>{selected && <div className="pe-inline-buttons"><button className="pe-button" aria-label="上移图层" disabled={selected.locked || document.layers.at(-1)?.id === selected.id} onClick={() => changeDocument(moveProductionLayer(document, selected.id, 1))}><ArrowUp size={14} /></button><button className="pe-button" aria-label="下移图层" disabled={selected.locked || document.layers[0]?.id === selected.id} onClick={() => changeDocument(moveProductionLayer(document, selected.id, -1))}><ArrowDown size={14} /></button><button className="pe-button danger" aria-label="删除选中图层" disabled={selected.locked} onClick={deleteLayer}><Trash2 size={14} /></button></div>}</section>
          <button className="pe-button" disabled={busy} onClick={() => fontInput.current?.click()}><Upload size={14} />上传授权字体</button><input className="pe-file-input" ref={fontInput} type="file" accept=".ttf,.otf" aria-label="上传字体" onChange={(event) => void upload(event.target.files?.[0], "fonts")} /><p className="pe-hint">字体仅用于本项目。上传前请确认拥有对应使用许可。</p>
        </aside>
        <section className="pe-canvas-column">
          {document.productType === "shaped_pillow" && <PillowPreparationPanel document={document} canTrace={canTrace} traceHint={traceHint} onChange={changeDocument} onTrace={(fit) => void generatePillowOutline(fit)} />}
          {document.productType === "shaped_pillow" && <div className="pe-canvas-view-tabs" role="group" aria-label="抱枕画布视图"><button className="pe-button" aria-pressed={canvasView === "front"} onClick={() => setCanvasView("front")}>正面编辑</button><button className="pe-button" aria-pressed={canvasView === "sheet"} disabled={contourMode === "draw"} onClick={() => setCanvasView("sheet")}>正反片排版</button><span>预览与编辑共用当前图稿</span></div>}
          {canvasView === "sheet" && document.productType === "shaped_pillow" ? <PillowSheetPreview document={document} projectId={detail.project.id} /> : <>
            <div className="pe-canvas-toolbar">
              <button className={`pe-button ${contourMode === "off" ? "active" : ""}`} aria-label="选择图层工具" aria-pressed={contourMode === "off"} onClick={() => selectCanvasTool("off")}><MousePointer2 size={15} /></button>
              <button className={`pe-button ${contourMode === "pan" ? "active" : ""}`} aria-label="平移画布" aria-pressed={contourMode === "pan"} onClick={() => selectCanvasTool("pan")}><Hand size={15} /></button>
              {document.productType === "shaped_pillow" && <>
                <button className={`pe-button ${contourMode === "edit" ? "active" : ""}`} aria-pressed={contourMode === "edit"} onClick={() => selectCanvasTool("edit")}><PenTool size={14} />编辑轮廓</button>
                <button className="pe-button" disabled={contourMode === "draw"} onClick={() => { setDraftPoints([]); setContourMode("draw"); }}>重新勾轮廓</button>
                <button className={`pe-button ${contourMode === "measure" ? "active" : ""}`} aria-pressed={contourMode === "measure"} onClick={() => selectCanvasTool("measure")}><Ruler size={14} />测量细窄处</button>
                {contourMode === "draw" && <><button className="pe-button primary" disabled={draftPoints.length < 3} onClick={() => { changeDocument({ ...document, contour: draftPoints }); setDraftPoints([]); setContourMode("edit"); }}>完成轮廓（{draftPoints.length}）</button><button className="pe-button" onClick={() => { setDraftPoints([]); setContourMode("off"); }}>取消勾图</button></>}
              </>}
              <button className="pe-button" aria-label="缩小画布" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}><ZoomOut size={14} /></button><span className="pe-zoom-value">{Math.round(zoom * 100)}%</span><button className="pe-button" aria-label="放大画布" onClick={() => setZoom((value) => Math.min(4, value + 0.25))}><ZoomIn size={14} /></button><button className="pe-button" aria-label="适应画布" onClick={() => { setZoom(1); setFitToken((value) => value + 1); }}><Maximize2 size={14} /></button>
            </div>
            <ProductionFabricCanvas document={document} projectId={detail.project.id} images={detail.images} fonts={detail.fonts} selectedId={selectedId} zoom={zoom} fitToken={fitToken} contourMode={contourMode} draftPoints={draftPoints} onSelect={(id) => { setSelectedId(id); if (id) setInspector("layer"); }} onLayerChange={patchLayer} onPointChange={(index, point) => { const points = contourMode === "draw" ? draftPoints : document.contour; contourPoints(points.map((item, pointIndex) => pointIndex === index ? point : item)); }} onPointAdd={(point) => setDraftPoints((points) => points.length < 200 ? [...points, point] : points)} />
          </>}
          <ProductionOutputPanel projectId={detail.project.id} renders={detail.renders} previewId={matchingPreview?.id} selectedVersionId={dirty ? undefined : detail.version.id} versions={detail.versions} onError={setError} />
        </section>
        <aside className="pe-right-panel"><div className="pe-inspector-tabs" role="tablist" aria-label="图稿设置">{([['layer', '图层'], ['process', '工艺'], ['confirm', '预检确认']] as const).map(([key, name]) => <button role="tab" aria-selected={inspector === key} className={inspector === key ? "active" : ""} key={key} disabled={contourMode === "draw"} onClick={() => { setInspector(key); if (contourMode === "edit") setContourMode("off"); }}>{name}</button>)}</div>
          {document.productType === "shaped_pillow" && (contourMode === "draw" || contourMode === "edit") ? <ProductionContourPanel points={contourMode === "draw" ? draftPoints : document.contour} onChange={contourPoints} /> : inspector === "layer" ? <div className="pe-layer-inspector"><ProductionLayerPanel key={selected?.id} layer={selected} images={images} fonts={detail.fonts.length ? detail.fonts : emptyFonts} onChange={(patch) => { if (selected && !selected.locked) patchLayer(selected.id, patch); }} />{selected && <ProductionLayoutPanel key={`tools-${selected.id}`} document={document} layer={selected} images={images} onAction={(action) => void layoutAction(action)} onDuplicate={duplicateLayer} onReplace={replaceImage} onUpload={() => replaceInput.current?.click()} />}<input className="pe-file-input" ref={replaceInput} type="file" accept=".png,.jpg,.jpeg,.tif,.tiff" aria-label="上传并替换生产图片" onChange={(event) => void upload(event.target.files?.[0], "images", selected?.id)} /></div> : inspector === "process" ? <ProductionProcessPanel document={document} onChange={changeDocument} /> : <ProductionConfirmations document={document} hasPreview={hasPreview} onChange={(next) => changeDocument(next, false)} />}
          <section className="pe-inspector-section pe-export-controls"><h2><ShieldCheck size={15} />预检与出图</h2><ProductionResolutionPanel document={document} images={images} onSelect={selectLayer} /><div className="pe-fields-two"><label>生产文件格式<select value={format} onChange={(event) => { const next = event.target.value as ProductionEditorExportOptions["format"]; setFormat(next); if (next === "jpeg") setBackground("white"); }}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="tiff">TIFF</option></select></label><label>生产文件背景<select value={background} disabled={format === "jpeg"} onChange={(event) => setBackground(event.target.value as ProductionEditorExportOptions["background"])}><option value="transparent">透明</option><option value="white">白色</option></select></label></div>{format === "jpeg" && <p className="pe-hint">JPEG 不支持透明，圆形外部以白色保存。</p>}<button className="pe-button" disabled={busy || contourMode === "draw"} onClick={() => void checkPreflight()}><ShieldCheck size={14} />检查生产参数</button><button className="pe-button" disabled={busy || contourMode === "draw"} onClick={() => void requestRender("preview")}><Eye size={14} />生成后台校对预览</button><button className="pe-button" disabled={busy || !hasPreview || !document.confirmations.visualReview || contourMode === "draw"} onClick={() => void approve()}><Check size={14} />确认当前版本</button><button className="pe-button primary" disabled={busy || dirty || !detail.version.reviewed || detail.version.id !== detail.project.currentVersionId} onClick={() => void requestRender("production")}><Download size={14} />生成生产文件</button>{busy && <p className="pe-hint" role="status"><LoaderCircle size={14} className="pe-spin" />正在处理…</p>}
          {preflight && <div className={`pe-preflight ${preflight.productionReady ? "ready" : "pending"}`}><strong>{preflight.productionReady ? "当前参数通过生产预检" : "仍有项目需要处理或人工确认"}</strong><span>{preflight.widthPx} × {preflight.heightPx} px</span><ul>{preflight.issues.map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}><b>{issue.severity === "error" ? "需修正" : issue.severity === "manual" ? "待确认" : "提醒"}</b>{issue.message}{issue.layerId && <button className="pe-button" onClick={() => { selectLayer(issue.layerId!); window.requestAnimationFrame(() => workspaceElement.current?.querySelector(".pe-layer-inspector")?.scrollIntoView({ block: "nearest" })); }}>定位图层</button>}</li>)}</ul></div>}
          </section>
        </aside>
      </div>
    </>}
    </div>
  </div>;
}

export function ProductionOutputPanel({ projectId, renders, previewId, selectedVersionId, versions = [], onError }: { projectId: string; renders: ProductionEditorRenderView[]; previewId?: string; selectedVersionId?: string; versions?: ProductionEditorDetailView["versions"]; onError: (message: string) => void }) {
  const preview = renders.find((render) => render.id === previewId && render.status === "completed" && render.files.some((file) => file.mediaType.startsWith("image/")));
  return <section className="pe-output-panel"><h2>后台预览与文件</h2>
    {preview ? <div className="pe-server-preview"><img src={renderFileUrl(projectId, preview.id, preview.files.find((file) => file.mediaType.startsWith("image/"))!.key)} alt="当前图稿的后台裁剪轮廓校对预览" loading="lazy" referrerPolicy="no-referrer" /><p>当前图稿校对预览 · V{versions.find((version) => version.id === preview.versionId)?.versionNumber ?? "—"} · 请核对文字、正反面和裁剪轮廓</p></div> : <p className="pe-hint">当前图稿尚无匹配的后台预览。图稿改动后需要重新生成并核对。</p>}
    {renders.length ? <ul className="pe-render-list">{renders.slice(0, 12).map((render) => <li key={render.id}><div><strong>{render.purpose === "preview" ? "校对预览" : "生产文件"} · V{versions.find((version) => version.id === render.versionId)?.versionNumber ?? "—"}</strong><span>{({ queued: "排队中", processing: "生成中", completed: "已生成", failed: "生成失败" })[render.status]} · {formatDate(render.createdAt)}{(render.id === previewId || render.purpose === "production" && render.versionId === selectedVersionId) ? " · 当前图稿" : " · 历史记录"}</span>{render.errorCode && <p className="pe-hint">生成未完成，请检查预检提示并重试。</p>}</div>{render.files.map((file) => <button className="pe-button" key={file.key} onClick={() => void downloadEditorFile(renderFileUrl(projectId, render.id, file.key), file.name).catch((cause) => onError(editorError(cause)))}><Download size={14} />{file.name}</button>)}</li>)}</ul> : <p className="pe-hint">生成后台预览后，在这里核对实际排版。确认版本后再生成所需生产格式。</p>}
  </section>;
}

async function editorRequest(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`/api/production-editor/${path}`, { method, cache: "no-store", signal: signal ?? AbortSignal.timeout(120_000), ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请重新登录。" : response.status === 403 ? "当前账号没有操作此项目的权限。" : response.status === 409 ? "项目已更新，请刷新并核对最新版本后重试。" : response.status === 413 ? "文件超过允许的大小。" : response.status === 422 ? "文件或工艺参数未通过检查，请查看预检结果后修正。" : "操作未完成，请稍后重试。");
  return response.status === 204 ? null : response.json();
}
async function fileBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === "string" ? resolve(reader.result.slice(reader.result.indexOf(",") + 1)) : reject(new Error("文件读取失败。")); reader.onerror = () => reject(new Error("文件读取失败。")); reader.readAsDataURL(file); }); }
async function downloadEditorFile(url: string, fileName: string) { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error("文件暂时无法下载，请刷新项目后重试。"); const address = URL.createObjectURL(await response.blob()); const anchor = window.document.createElement("a"); anchor.href = address; anchor.download = safeEditorFileName(fileName); window.document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(address), 10_000); }
function renderFileUrl(projectId: string, renderId: string, key: string) { return `/api/production-editor/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(renderId)}/files/${encodeURIComponent(key)}`; }
function visualSignature(document: ProductionEditorDocument) { return JSON.stringify({ schemaVersion: document.schemaVersion, productType: document.productType, spec: document.spec, contour: document.contour, layers: document.layers }); }
function editorError(error: unknown) { return error instanceof Error && /^(登录|当前账号|项目已|文件|图稿|请选择|请先|请填写|订单|操作未)/.test(error.message) ? error.message : "操作未完成，请检查项目参数或稍后重试。"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(value)); }
