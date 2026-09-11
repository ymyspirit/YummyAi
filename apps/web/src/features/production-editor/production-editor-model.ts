import type { ProductionEditorDocument, ProductionEditorImageLayer, ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";

export type ProductionKind = ProductionEditorDocument["productType"];
export const PILLOW_SIZES_IN = [10, 12, 14, 16, 18, 20, 22, 24] as const;

/** Uniform artwork scaling keeps source identity, relative placement and readable text intact. */
export function scalePillowArtwork(document: ProductionEditorDocument, scale: number): ProductionEditorDocument {
  if (document.productType !== "shaped_pillow" || !Number.isFinite(scale) || scale <= 0) return document;
  return { ...document, layers: document.layers.map((layer) => ({
    ...layer, xMm: layer.xMm * scale, yMm: layer.yMm * scale,
    ...(layer.kind === "image" ? { widthMm: layer.widthMm * scale, heightMm: layer.heightMm * scale } : {
      fontSizeMm: layer.fontSizeMm * scale, letterSpacingMm: layer.letterSpacingMm * scale,
      arc: layer.arc ? { ...layer.arc, radiusMm: layer.arc.radiusMm * scale } : null,
    }),
  })) };
}

export function createProductionDocument(kind: ProductionKind): ProductionEditorDocument {
  const common = { schemaVersion: 1 as const, name: kind === "shaped_pillow" ? "异形抱枕生产稿" : "圆形胎罩生产稿", layers: [], confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
  return kind === "shaped_pillow" ? {
    ...common, productType: "shaped_pillow", spec: { widthMm: 300, heightMm: 400, dpi: 150, sideMode: "single", declaredLongestMm: null, sizeBasis: "unconfirmed", whiteBorderMm: 200 * 25.4 / 150, cutLineMm: 6 * 25.4 / 150, minimumNeckMm: 50, minimumNeckBasis: "unconfirmed", panelGapMm: 20, barcodeTab: { widthMm: null, heightMm: null, centerXMm: 150 } },
    contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 300, yMm: 0, smooth: false }, { xMm: 300, yMm: 400, smooth: false }, { xMm: 0, yMm: 400, smooth: false }],
  } : { ...common, productType: "tire_cover", spec: { diameterMm: 670, dpi: 300, safeInsetMm: 15, opening: null }, contour: [] };
}

export function productionBodySize(document: ProductionEditorDocument) {
  return document.productType === "shaped_pillow" ? { width: document.spec.widthMm, height: document.spec.heightMm } : { width: document.spec.diameterMm, height: document.spec.diameterMm };
}

export function newProductionImage(document: ProductionEditorDocument, image: { id: string; version?: number; name: string; width: number; height: number }): ProductionEditorImageLayer {
  const size = productionBodySize(document);
  const ratio = Math.min(size.width * 0.68 / image.width, size.height * 0.68 / image.height);
  return { id: `image_${crypto.randomUUID()}`, kind: "image", name: image.name.slice(0, 160), assetId: image.id, assetVersion: image.version ?? 1, xMm: (size.width - image.width * ratio) / 2, yMm: (size.height - image.height * ratio) / 2, widthMm: image.width * ratio, heightMm: image.height * ratio, rotationDeg: 0, flipX: false, flipY: false, opacity: 1, visible: true, locked: false };
}

export function newProductionText(document: ProductionEditorDocument, arc: boolean): ProductionEditorTextLayer {
  const size = productionBodySize(document);
  return { id: `text_${crypto.randomUUID()}`, kind: "text", name: arc ? "弧形文字" : "文字", text: "YOUR TEXT", fontId: "geist_regular", fontSizeMm: size.width * 0.055, letterSpacingMm: 0, color: "#111111", xMm: arc ? size.width / 2 : size.width * 0.18, yMm: arc ? size.height / 2 : size.height * 0.3, rotationDeg: 0, opacity: 1, visible: true, locked: false, arc: arc ? { radiusMm: size.width * 0.35, startAngleDeg: -150, endAngleDeg: -30 } : null };
}

export function invalidateProductionReview(document: ProductionEditorDocument): ProductionEditorDocument {
  return { ...document, confirmations: { ...document.confirmations, visualReview: false } };
}

export function invalidateProductionEdit(previous: ProductionEditorDocument, next: ProductionEditorDocument): ProductionEditorDocument {
  const processChanged = previous.productType !== next.productType || JSON.stringify(previous.spec) !== JSON.stringify(next.spec) || JSON.stringify(previous.contour) !== JSON.stringify(next.contour);
  if (processChanged) return { ...next, confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
  const artworkChanged = JSON.stringify(previous.layers) !== JSON.stringify(next.layers);
  return { ...next, confirmations: { ...next.confirmations, visualReview: false, ...(artworkChanged ? { backText: false } : {}) } };
}

export function moveProductionLayer(document: ProductionEditorDocument, id: string, direction: -1 | 1): ProductionEditorDocument {
  const index = document.layers.findIndex((layer) => layer.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= document.layers.length) return document;
  const layers = [...document.layers];
  [layers[index], layers[target]] = [layers[target]!, layers[index]!];
  return invalidateProductionReview({ ...document, layers });
}

export function resizedProductionBody(document: ProductionEditorDocument, width: number, height: number): ProductionEditorDocument {
  if (document.productType === "tire_cover") return invalidateProductionEdit(document, { ...document, spec: { ...document.spec, diameterMm: width } });
  const sx = width / document.spec.widthMm;
  const sy = height / document.spec.heightMm;
  return invalidateProductionEdit(document, { ...document, spec: { ...document.spec, widthMm: width, heightMm: height, barcodeTab: { ...document.spec.barcodeTab, centerXMm: document.spec.barcodeTab.centerXMm * sx } }, contour: document.contour.map((point) => ({ ...point, xMm: point.xMm * sx, yMm: point.yMm * sy })) });
}
