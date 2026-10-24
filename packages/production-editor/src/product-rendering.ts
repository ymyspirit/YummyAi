import type { ProductionEditorDocument, ProductionEditorLayer, RectangularPrintDocument, ShapedPillowDocument, TireCoverDocument } from "@yummyai/contracts/pod/production-editor";
import type opentype from "opentype.js";
import { buildPillowContour, polygonPath, sampleClosedContour, type getProductionLayout } from "./geometry.js";
import { mirrorProductionTextLayer } from "./text.js";

interface ProductRenderContext { layout: ReturnType<typeof getProductionLayout>; layers: ProductionEditorLayer[]; normalizedAssets: Map<string, string>; fonts: Map<string, opentype.Font>; renderLayer: (layer: ProductionEditorLayer, assets: Map<string, string>, fonts: Map<string, opentype.Font>) => string }

/** Existing V1 products keep their SVG composition exactly unchanged. */
export function renderProductionProductBody(document: ProductionEditorDocument, context: ProductRenderContext): string {
  switch (document.productType) {
    case "tire_cover": return renderTireCoverV1(document, context);
    case "shaped_pillow": return renderPillowV1(document, context);
    case "rectangular_print": return renderRectangularPrintV1(document, context);
  }
}

function renderTireCoverV1(document: TireCoverDocument, { layout, layers, normalizedAssets, fonts, renderLayer }: ProductRenderContext) {
    const radius = document.spec.diameterMm / 2, opening = document.spec.opening;
    const hole = opening ? `<circle cx="${opening.xMm}" cy="${opening.yMm}" r="${opening.diameterMm / 2}" fill="black"/>` : "";
    return `<defs><mask id="cover" maskUnits="userSpaceOnUse" x="0" y="0" width="${layout.widthMm}" height="${layout.heightMm}"><rect width="100%" height="100%" fill="black"/><circle cx="${radius}" cy="${radius}" r="${radius}" fill="white"/>${hole}</mask></defs><g mask="url(#cover)">${layers.map((layer) => renderLayer(layer, normalizedAssets, fonts)).join("")}</g>`;
}

function renderPillowV1(document: ShapedPillowDocument, { layout, layers, normalizedAssets, fonts, renderLayer }: ProductRenderContext) {
    const outline = buildPillowContour(document).path;
    const rawBody = polygonPath(sampleClosedContour(document.contour));
    const spec = document.spec;
    const maskPath = `<path d="${rawBody}" fill="white" stroke="black" stroke-width="${spec.whiteBorderMm * 2}" stroke-linejoin="round"/>`;
    const mask = `<defs><mask id="print" maskUnits="userSpaceOnUse" x="0" y="0" width="${spec.widthMm}" height="${spec.heightMm}"><rect width="100%" height="100%" fill="black"/>${maskPath}</mask><mask id="printBack" maskUnits="userSpaceOnUse" x="0" y="0" width="${spec.widthMm}" height="${spec.heightMm}"><rect width="100%" height="100%" fill="black"/><g transform="translate(${spec.widthMm} 0) scale(-1 1)">${maskPath}</g></mask></defs>`;
    const front = `<path d="${outline}" fill="white"/><g${spec.artworkClipMode === "none" ? "" : ' mask="url(#print)"'}>${layers.filter(layer => layer.surface !== "back").map((layer) => renderLayer(layer, normalizedAssets, fonts)).join("")}</g><path d="${outline}" fill="none" stroke="black" stroke-width="${spec.cutLineMm}" stroke-linejoin="round"/>`;
    const backLayers = layers.filter(layer => layer.surface !== "front").map((layer) => layer.surface === "back" ? renderLayer(layer, normalizedAssets, fonts) : layer.kind === "image" ? `<g transform="translate(${spec.widthMm} 0) scale(-1 1)">${renderLayer(layer, normalizedAssets, fonts)}</g>` : renderLayer(mirrorProductionTextLayer(layer, fonts.get(layer.fontId)!, spec.widthMm), normalizedAssets, fonts)).join("");
    const backArt = spec.sideMode === "double" ? `<g${spec.artworkClipMode === "none" ? "" : ' mask="url(#printBack)"'}>${backLayers}</g>` : "";
    const back = `<g transform="translate(${spec.widthMm} 0) scale(-1 1)"><path d="${outline}" fill="white"/></g>${backArt}<g transform="translate(${spec.widthMm} 0) scale(-1 1)"><path d="${outline}" fill="none" stroke="black" stroke-width="${spec.cutLineMm}" stroke-linejoin="round"/></g>`;
    return `${mask}<g transform="translate(${layout.marginMm} ${layout.marginMm})">${front}</g><g transform="translate(${layout.backOffsetMm + layout.marginMm} ${layout.marginMm})">${back}</g>`;
}

function renderRectangularPrintV1(document: RectangularPrintDocument, { layers, normalizedAssets, fonts, renderLayer }: ProductRenderContext) {
  return `<defs><clipPath id="rectangle"><rect x="0" y="0" width="${document.spec.widthMm}" height="${document.spec.heightMm}"/></clipPath></defs><g clip-path="url(#rectangle)">${layers.map((layer) => renderLayer(layer, normalizedAssets, fonts)).join("")}</g>`;
}
