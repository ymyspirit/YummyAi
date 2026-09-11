"use client";

import type { ProductionEditorDocument, ProductionEditorImageLayer, ProductionEditorLayer, ProductionEditorPoint, ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import type { ProductionEditorFontView, ProductionEditorImageView } from "@yummyai/contracts/pod/production-editor-api";
import { buildPillowContour, polygonPath, sampleClosedContour } from "@yummyai/production-editor/geometry";
import type { Canvas, FabricObject } from "fabric";
import type { Font } from "opentype.js";
import { useEffect, useRef, useState } from "react";

import { editorViewport } from "./editor-history";
import { productionBodySize } from "./production-editor-model";
import { productionTextPath } from "./production-text-path";

export type ContourMode = "off" | "edit" | "draw" | "measure" | "pan";
type EditorObject = FabricObject & { editorLayerId?: string; editorPointIndex?: number; editorOffsetX?: number; editorOffsetY?: number };
interface CanvasProps {
  document: ProductionEditorDocument; projectId: string; images: ProductionEditorImageView[]; fonts: ProductionEditorFontView[];
  selectedId: string | null; zoom: number; contourMode: ContourMode; draftPoints: ProductionEditorPoint[];
  fitToken?: number;
  onSelect: (id: string | null) => void; onLayerChange: (id: string, patch: Partial<ProductionEditorLayer>) => void;
  onPointChange: (index: number, point: ProductionEditorPoint) => void; onPointAdd: (point: ProductionEditorPoint) => void;
}

export function ProductionFabricCanvas(props: CanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const element = useRef<HTMLCanvasElement>(null);
  const instance = useRef<Canvas | null>(null);
  const disposePending = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef(props); current.current = props;
  const rebuilding = useRef(false);
  const loadedImages = useRef(new Map<string, Promise<HTMLImageElement>>());
  const loadedFonts = useRef(new Map<string, Promise<Font>>());
  const [ready, setReady] = useState(0);
  const [availableWidth, setAvailableWidth] = useState(700);
  const [error, setError] = useState("");
  const [measurement, setMeasurement] = useState<ProductionEditorPoint[]>([]);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStart = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const size = productionBodySize(props.document);
  const heightMm = size.height + (props.document.productType === "shaped_pillow" ? props.document.spec.barcodeTab.heightMm ?? 0 : 0);
  const fitViewport = editorViewport(size.width, heightMm, availableWidth, props.zoom);
  const viewport = { ...fitViewport, left: fitViewport.left + pan.x, top: fitViewport.top + pan.y };
  const viewportRef = useRef(viewport); viewportRef.current = viewport;
  useEffect(() => { setPan({ x: 0, y: 0 }); }, [props.zoom, props.fitToken, props.projectId]);
  useEffect(() => { setMeasurement([]); }, [props.document, props.projectId]);

  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver((entries) => { const width = entries[0]?.contentRect.width; if (width) setAvailableWidth(width); });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let canvas: Canvas | null = null;
    void (async () => {
      await disposePending.current;
      const fabric = await import("fabric");
      if (cancelled || !element.current) return;
      canvas = new fabric.Canvas(element.current, { preserveObjectStacking: true, selection: false, enableRetinaScaling: false, stopContextMenu: true, fireMiddleClick: false, fireRightClick: false, uniformScaling: true, uniScaleKey: undefined });
      instance.current = canvas;
      canvas.on("selection:created", (event) => { if (!rebuilding.current) current.current.onSelect((event.selected[0] as EditorObject | undefined)?.editorLayerId ?? null); });
      canvas.on("selection:updated", (event) => { if (!rebuilding.current) current.current.onSelect((event.selected[0] as EditorObject | undefined)?.editorLayerId ?? null); });
      canvas.on("selection:cleared", () => { if (!rebuilding.current) current.current.onSelect(null); });
      canvas.on("object:modified", (event) => {
        const object = event.target as EditorObject;
        const state = current.current;
        if (object.editorPointIndex !== undefined) {
          const points = state.contourMode === "draw" ? state.draftPoints : state.document.contour;
          const point = points[object.editorPointIndex];
          if (point) state.onPointChange(object.editorPointIndex, { ...point, xMm: round(object.left), yMm: round(object.top) });
          return;
        }
        const layer = state.document.layers.find((item) => item.id === object.editorLayerId);
        if (!layer || layer.locked) return;
        const angle = normalizeAngle(object.angle);
        if (layer.kind === "image") {
          state.onLayerChange(layer.id, { xMm: round(object.left), yMm: round(object.top), widthMm: Math.max(0.1, round(object.width * object.scaleX)), heightMm: Math.max(0.1, round(object.height * object.scaleY)), rotationDeg: angle, flipX: object.flipX, flipY: object.flipY } as Partial<ProductionEditorImageLayer>);
        } else {
          const offset = rotate((object.editorOffsetX ?? 0) * object.scaleX, (object.editorOffsetY ?? 0) * object.scaleY, angle);
          state.onLayerChange(layer.id, { xMm: round(object.left - offset.x), yMm: round(object.top - offset.y), rotationDeg: angle, fontSizeMm: Math.max(0.1, round(layer.fontSizeMm * object.scaleX)), letterSpacingMm: round(layer.letterSpacingMm * object.scaleX), ...(layer.arc ? { arc: { ...layer.arc, radiusMm: round(layer.arc.radiusMm * object.scaleX) } } : {}) } as Partial<ProductionEditorTextLayer>);
        }
      });
      canvas.on("mouse:down", (event) => {
        if (current.current.contourMode === "pan") {
          const point = canvas!.getViewportPoint(event.e), transform = canvas!.viewportTransform;
          panStart.current = { x: point.x, y: point.y, left: transform[4], top: transform[5] }; return;
        }
        if (current.current.contourMode === "measure") {
          const point = canvas!.getScenePoint(event.e);
          setMeasurement((points) => points.length === 1 ? [...points, { xMm: round(point.x), yMm: round(point.y), smooth: false }] : [{ xMm: round(point.x), yMm: round(point.y), smooth: false }]); return;
        }
        if (current.current.contourMode !== "draw" || event.target) return;
        const point = canvas!.getScenePoint(event.e);
        current.current.onPointAdd({ xMm: round(point.x), yMm: round(point.y), smooth: true });
      });
      canvas.on("mouse:move", (event) => {
        const start = panStart.current;
        if (!start) return;
        const point = canvas!.getViewportPoint(event.e), transform = [...canvas!.viewportTransform] as [number, number, number, number, number, number];
        transform[4] = start.left + point.x - start.x; transform[5] = start.top + point.y - start.y;
        canvas!.setViewportTransform(transform); canvas!.requestRenderAll();
      });
      canvas.on("mouse:up", () => {
        if (!panStart.current) return;
        const transform = canvas!.viewportTransform, previous = viewportRef.current;
        setPan((value) => ({ x: value.x + transform[4] - previous.left, y: value.y + transform[5] - previous.top })); panStart.current = null;
      });
      setReady((value) => value + 1);
    })().catch(() => { if (!cancelled) setError("画布未能启动，请刷新页面重试。"); });
    return () => { cancelled = true; if (instance.current === canvas) instance.current = null; if (canvas) disposePending.current = canvas.dispose().catch(() => false); };
  }, []);

  useEffect(() => {
    const canvas = instance.current;
    if (!canvas) return;
    let cancelled = false;
    const controller = new AbortController();
    rebuilding.current = true;
    setError("");
    void (async () => {
      const fabric = await import("fabric");
      const doc = props.document;
      const drawing = props.contourMode === "draw";
      const controlMode = props.contourMode !== "off";
      const shapeDocument = doc.productType === "shaped_pillow" && drawing && props.draftPoints.length >= 3 ? { ...doc, contour: props.draftPoints } : doc;
      const finalPath = shapeDocument.productType === "shaped_pillow" ? buildPillowContour(shapeDocument).path : "";
      const bodyPath = shapeDocument.productType === "shaped_pillow" ? polygonPath(sampleClosedContour(shapeDocument.contour)) : "";
      const passive = { selectable: false, evented: false, originX: "left" as const, originY: "top" as const, objectCaching: false };
      const objects: EditorObject[] = [];
      const clip = () => doc.productType === "tire_cover" ? new fabric.Path(`${circlePath(doc.spec.diameterMm / 2, doc.spec.diameterMm / 2, doc.spec.diameterMm / 2)} ${doc.spec.opening ? circlePath(doc.spec.opening.xMm, doc.spec.opening.yMm, doc.spec.opening.diameterMm / 2) : ""}`, { ...passive, absolutePositioned: true, fill: "#000000", strokeWidth: 0, fillRule: "evenodd" }) : new fabric.Path(bodyPath, { ...passive, absolutePositioned: true, fill: "#000000", strokeWidth: 0 });
      if (doc.productType === "shaped_pillow" && !drawing) objects.push(new fabric.Path(finalPath, { ...passive, fill: "#ffffff", strokeWidth: 0 }));
      for (const layer of doc.layers) {
        if (!layer.visible) continue;
        let object: EditorObject;
        if (layer.kind === "image") {
          const asset = props.images.find((image) => image.id === layer.assetId && image.version === layer.assetVersion);
          if (!asset) throw new Error("missing-image");
          const key = `${props.projectId}:${asset.id}:${asset.version}`;
          if (!loadedImages.current.has(key)) loadedImages.current.set(key, loadImage(editorAssetUrl(props.projectId, asset.id, "preview")).catch((cause) => { loadedImages.current.delete(key); throw cause; }));
          const picture = await loadedImages.current.get(key)!;
          if (cancelled) return;
          object = new fabric.FabricImage(picture, { left: layer.xMm, top: layer.yMm, width: picture.naturalWidth, height: picture.naturalHeight, scaleX: layer.widthMm / picture.naturalWidth, scaleY: layer.heightMm / picture.naturalHeight, originX: "left", originY: "top", flipX: layer.flipX, flipY: layer.flipY });
        } else {
          const key = `${props.projectId}:${layer.fontId}`;
          if (!loadedFonts.current.has(key)) loadedFonts.current.set(key, loadFont(props.projectId, layer.fontId).catch((cause) => { loadedFonts.current.delete(key); throw cause; }));
          const font = await loadedFonts.current.get(key)!;
          if (cancelled) return;
          const path = productionTextPath(font, layer, fabric);
          object = new fabric.Path(path || "M0,0L0.001,0.001", { originX: "left", originY: "top", strokeWidth: 0, fill: layer.color, lockScalingFlip: true });
          object.editorOffsetX = object.left;
          object.editorOffsetY = object.top;
          const offset = rotate(object.left, object.top, layer.rotationDeg);
          object.set({ left: layer.xMm + offset.x, top: layer.yMm + offset.y });
          object.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
        }
        object.editorLayerId = layer.id;
        object.set({ angle: layer.rotationDeg, opacity: layer.opacity, selectable: !controlMode && !layer.locked, evented: !controlMode, lockMovementX: layer.locked, lockMovementY: layer.locked, lockScalingX: layer.locked, lockScalingY: layer.locked, lockRotation: layer.locked, borderColor: "#2563eb", cornerColor: "#ffffff", cornerStrokeColor: "#2563eb", transparentCorners: false, cornerSize: 10, padding: 2, objectCaching: false, ...(drawing ? {} : { clipPath: clip() }) });
        objects.push(object);
      }
      if (doc.productType === "shaped_pillow" && !drawing) {
        objects.push(new fabric.Path(bodyPath, { ...passive, fill: "transparent", stroke: "#ffffff", strokeWidth: doc.spec.whiteBorderMm * 2, strokeLineJoin: "round", clipPath: clip() }));
        objects.push(new fabric.Path(finalPath, { ...passive, fill: "transparent", stroke: "#000000", strokeWidth: doc.spec.cutLineMm, strokeLineJoin: "round" }));
      } else if (doc.productType === "tire_cover") {
        objects.push(new fabric.Circle({ ...passive, left: 0, top: 0, radius: size.width / 2, fill: "transparent", stroke: "#6b7a90", strokeWidth: 0.8 / viewport.scale }));
        objects.push(new fabric.Circle({ ...passive, left: doc.spec.safeInsetMm, top: doc.spec.safeInsetMm, radius: Math.max(0.1, size.width / 2 - doc.spec.safeInsetMm), fill: "transparent", stroke: "#d18c25", strokeWidth: 0.8 / viewport.scale, strokeDashArray: [4 / viewport.scale, 4 / viewport.scale] }));
        if (doc.spec.opening) objects.push(new fabric.Circle({ ...passive, left: doc.spec.opening.xMm - doc.spec.opening.diameterMm / 2, top: doc.spec.opening.yMm - doc.spec.opening.diameterMm / 2, radius: doc.spec.opening.diameterMm / 2, fill: "transparent", stroke: "#b42318", strokeWidth: 0.8 / viewport.scale, strokeDashArray: [4 / viewport.scale, 4 / viewport.scale] }));
      }
      if (doc.productType === "shaped_pillow" && (props.contourMode === "draw" || props.contourMode === "edit")) {
        const points = drawing ? props.draftPoints : doc.contour;
        if (points.length > 1) objects.push(new fabric.Polyline(points.map((point) => ({ x: point.xMm, y: point.yMm })), { ...passive, fill: "transparent", stroke: "#2563eb", strokeWidth: 1 / viewport.scale, strokeDashArray: [4 / viewport.scale, 4 / viewport.scale] }));
        points.forEach((point, index) => {
          const node = new fabric.Circle({ left: point.xMm, top: point.yMm, originX: "center", originY: "center", radius: 5 / viewport.scale, fill: point.smooth ? "#2563eb" : "#d18c25", stroke: "#ffffff", strokeWidth: 1.5 / viewport.scale, hasControls: false, hasBorders: false, objectCaching: false }) as EditorObject;
          node.editorPointIndex = index; objects.push(node);
        });
      }
      if (props.contourMode === "measure") {
        const distance = measurement.length === 2 ? Math.hypot(measurement[1]!.xMm - measurement[0]!.xMm, measurement[1]!.yMm - measurement[0]!.yMm) : null;
        const color = distance !== null && doc.productType === "shaped_pillow" && distance < doc.spec.minimumNeckMm ? "#b42318" : "#225be2";
        if (measurement.length === 2) objects.push(new fabric.Line([measurement[0]!.xMm, measurement[0]!.yMm, measurement[1]!.xMm, measurement[1]!.yMm], { ...passive, stroke: color, strokeWidth: 2 / viewport.scale }));
        for (const point of measurement) objects.push(new fabric.Circle({ ...passive, left: point.xMm, top: point.yMm, originX: "center", originY: "center", radius: 4 / viewport.scale, fill: color, stroke: "#ffffff", strokeWidth: 1 / viewport.scale }));
      }
      if (cancelled || instance.current !== canvas) return;
      canvas.discardActiveObject(); canvas.remove(...canvas.getObjects());
      canvas.setDimensions({ width: viewport.width, height: viewport.height });
      canvas.setViewportTransform([viewport.scale, 0, 0, viewport.scale, viewport.left, viewport.top]);
      canvas.defaultCursor = props.contourMode === "pan" ? "grab" : props.contourMode === "measure" || drawing ? "crosshair" : "default";
      canvas.add(...objects);
      const selected = objects.find((object) => object.editorLayerId === current.current.selectedId && object.selectable);
      if (selected) canvas.setActiveObject(selected);
      canvas.requestRenderAll();
    })().catch(() => { if (!cancelled) setError("部分图片或字体尚未加载。请检查素材权限，重新打开项目后重试。"); }).finally(() => { if (!cancelled) rebuilding.current = false; });
    return () => { cancelled = true; controller.abort(); };
  }, [ready, props.document, props.projectId, props.images, props.fonts, props.contourMode, props.draftPoints, viewport.width, viewport.height, viewport.scale, viewport.left, viewport.top, size.width, measurement]);

  useEffect(() => {
    const canvas = instance.current;
    if (!canvas || rebuilding.current) return;
    const selected = canvas.getObjects().find((object) => (object as EditorObject).editorLayerId === props.selectedId && object.selectable);
    if (selected && canvas.getActiveObject() !== selected) canvas.setActiveObject(selected);
    else if (!selected && canvas.getActiveObject()) canvas.discardActiveObject();
    canvas.requestRenderAll();
  }, [props.selectedId]);

  const measuredMm = measurement.length === 2 ? Math.hypot(measurement[1]!.xMm - measurement[0]!.xMm, measurement[1]!.yMm - measurement[0]!.yMm) : null;
  return <div className="pe-canvas-host" ref={host}><div className="pe-canvas-checker" style={{ minHeight: viewport.height }}><canvas ref={element} aria-label={props.document.productType === "shaped_pillow" ? "异形抱枕正面编辑画布" : "圆形胎罩编辑画布"} /></div>{error && <p className="pe-alert" role="alert">{error}</p>}{props.contourMode === "measure" && <p className={`pe-measurement ${measuredMm !== null && props.document.productType === "shaped_pillow" && measuredMm < props.document.spec.minimumNeckMm ? "short" : ""}`} role="status">{measuredMm === null ? measurement.length ? "已选起点，请点击终点。" : "依次点击两点，测量实际毫米距离。" : `测量：${measuredMm.toFixed(1)} mm（${(measuredMm / 10).toFixed(2)} cm）${props.document.productType === "shaped_pillow" && measuredMm < props.document.spec.minimumNeckMm ? " · 低于 5 cm，请检查细窄部位" : ""}`}<span>仅测量所选线段，不代表整张轮廓或缝制成品已合格；测量线不导出。</span></p>}<p className="pe-canvas-caption">{props.contourMode === "draw" ? "在图像周围逐点点击，至少 3 点后完成。节点可拖动。" : props.contourMode === "edit" ? "拖动蓝色平滑节点或黄色角点，右侧可输入精确位置。" : props.contourMode === "pan" ? "拖动平移画布；点击适应画布回到完整视图。" : props.contourMode === "measure" ? "再次点击可以开始下一次测量。" : "拖动移动，角点缩放，上方控制点旋转。"} 棋盘格表示透明区域。</p></div>;
}

export function editorAssetUrl(projectId: string, imageId: string, kind: "preview" | "original") { return `/api/production-editor/projects/${encodeURIComponent(projectId)}/images/${encodeURIComponent(imageId)}?kind=${kind}`; }
async function loadImage(url: string) { return new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("image-load")); image.referrerPolicy = "no-referrer"; image.src = url; }); }
async function loadFont(projectId: string, fontId: string): Promise<Font> { const response = await fetch(`/api/production-editor/projects/${encodeURIComponent(projectId)}/fonts/${encodeURIComponent(fontId)}`, { cache: "no-store" }); if (!response.ok) throw new Error("font-load"); const library = await import("@yummyai/production-editor/text"); return library.parseProductionFont(await response.arrayBuffer()); }
function rotate(x: number, y: number, degrees: number) { const radians = degrees * Math.PI / 180; return { x: x * Math.cos(radians) - y * Math.sin(radians), y: x * Math.sin(radians) + y * Math.cos(radians) }; }
function round(value: number) { return Math.round(value * 1000) / 1000; }
function normalizeAngle(value: number) { return ((round(value) + 360) % 720) - 360; }

function circlePath(x: number, y: number, radius: number) { return `M ${x + radius} ${y} A ${radius} ${radius} 0 1 0 ${x - radius} ${y} A ${radius} ${radius} 0 1 0 ${x + radius} ${y} Z`; }
