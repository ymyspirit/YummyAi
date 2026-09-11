"use client";

import type { ProductionEditorLayer, ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, getProductionLayout, polygonPath, sampleClosedContour } from "@yummyai/production-editor/geometry";
import { buildProductionTextPaths, mirrorProductionTextLayer, parseProductionFont } from "@yummyai/production-editor/text";
import type { Font } from "opentype.js";
import { useEffect, useId, useState } from "react";
import { editorAssetUrl } from "./production-fabric-canvas";

/** Immediate editing aid. Production approval still requires the worker's original-pixel preview. */
export function PillowSheetPreview({ document, projectId }: { document: ShapedPillowDocument; projectId: string }) {
  const id = useId().replace(/:/g, ""), maskId = `${id}-print`, backMaskId = `${id}-back`;
  const [fonts, setFonts] = useState<Map<string, Font>>(new Map());
  const [error, setError] = useState("");
  const fontIds = [...new Set(document.layers.flatMap((layer) => layer.kind === "text" && layer.visible ? [layer.fontId] : []))].sort().join(",");
  useEffect(() => {
    const controller = new AbortController(); setError(""); setFonts(new Map());
    void Promise.all((fontIds ? fontIds.split(",") : []).map(async (fontId) => {
      const response = await fetch(`/api/production-editor/projects/${encodeURIComponent(projectId)}/fonts/${encodeURIComponent(fontId)}`, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error("font-load");
      return [fontId, parseProductionFont(await response.arrayBuffer())] as const;
    })).then((entries) => { if (!controller.signal.aborted) setFonts(new Map(entries)); }).catch(() => { if (!controller.signal.aborted) setError("部分字体未能读取，文字预览不完整，请刷新后重试。"); });
    return () => controller.abort();
  }, [projectId, fontIds]);
  const layout = getProductionLayout(document), spec = document.spec;
  const shape = buildPillowContour(document), body = polygonPath(sampleClosedContour(document.contour));
  const mirror = `translate(${spec.widthMm} 0) scale(-1 1)`;
  const pendingFonts = fontIds && fontIds.split(",").some((fontId) => !fonts.has(fontId));
  function layerView(source: ProductionEditorLayer, back = false) {
    if (!source.visible) return null;
    const font = source.kind === "text" ? fonts.get(source.fontId) : null;
    const layer = source.kind === "text" && back && font ? mirrorProductionTextLayer(source, font, spec.widthMm) : source;
    const content = layer.kind === "image" ? <image href={editorAssetUrl(projectId, layer.assetId, "preview")} width={layer.widthMm} height={layer.heightMm} preserveAspectRatio="none" transform={`translate(${layer.flipX ? layer.widthMm : 0} ${layer.flipY ? layer.heightMm : 0}) scale(${layer.flipX ? -1 : 1} ${layer.flipY ? -1 : 1})`} onError={() => setError("部分图片尚未读取，排版预览不完整，请刷新项目后重试。")} /> : font ? <g fill={layer.color}>{buildProductionTextPaths(font, layer).map((glyph, index) => <path key={index} d={glyph.path} transform={`translate(${glyph.xMm} ${glyph.yMm}) rotate(${glyph.rotationDeg})`} />)}</g> : null;
    return <g key={layer.id} data-preview-layer={layer.kind} transform={back && layer.kind === "image" ? mirror : undefined}><g opacity={layer.opacity} transform={`translate(${layer.xMm} ${layer.yMm}) rotate(${layer.rotationDeg})`}>{content}</g></g>;
  }
  const printMask = <path d={body} fill="white" stroke="black" strokeWidth={spec.whiteBorderMm * 2} strokeLinejoin="round" />;
  return <div className="pe-pillow-sheet">
    <div className="pe-sheet-labels"><strong>正面</strong><strong>{spec.sideMode === "single" ? "背面 · 镜像轮廓留白" : "背面 · 图像镜像 / 文字正读"}</strong></div>
    <div className="pe-canvas-checker">
      <svg role="img" aria-label="抱枕正反片实时排版预览" viewBox={`0 0 ${layout.widthMm} ${layout.heightMm}`}>
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={spec.widthMm} height={spec.heightMm}><rect width={spec.widthMm} height={spec.heightMm} fill="black" />{printMask}</mask>
          <mask id={backMaskId} maskUnits="userSpaceOnUse" x={0} y={0} width={spec.widthMm} height={spec.heightMm}><rect width={spec.widthMm} height={spec.heightMm} fill="black" /><g transform={mirror}>{printMask}</g></mask>
        </defs>
        <g transform={`translate(${layout.marginMm} ${layout.marginMm})`}><path d={shape.path} fill="white" /><g mask={`url(#${maskId})`}>{document.layers.map((layer) => layerView(layer))}</g><path d={shape.path} fill="none" stroke="black" strokeWidth={spec.cutLineMm} /></g>
        <g transform={`translate(${layout.backOffsetMm + layout.marginMm} ${layout.marginMm})`}><path d={shape.path} fill="white" transform={mirror} />{spec.sideMode === "double" && <g mask={`url(#${backMaskId})`}>{document.layers.map((layer) => layerView(layer, true))}</g>}<path d={shape.path} fill="none" stroke="black" strokeWidth={spec.cutLineMm} transform={mirror} /></g>
      </svg>
    </div>
    {error && <p className="pe-alert" role="alert">{error}</p>}
    {pendingFonts && !error && <p className="pe-hint" role="status">正在读取文字轮廓…</p>}
    {shape.issues.length > 0 && <p className="pe-alert">轮廓或条码位置需要修正，当前排版尚不能生产。</p>}
    <p className="pe-canvas-caption">实时排版用于检查构图，正式出图仍需核对下方后台预览。图片中已有的文字会随图片镜像，需要美工单独处理。</p>
  </div>;
}
