import type { ProductionEditorDocument, ProductionEditorImageLayer, ProductionEditorLayer, ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import { sampleClosedContour } from "@yummyai/production-editor/geometry";

export type LayerBounds = { x: number; y: number; width: number; height: number };
export type LayoutAction = "left" | "centerX" | "right" | "top" | "centerY" | "bottom" | "fit" | "cover" | "rotateLeft" | "rotateRight" | "resetRatio" | "straightText" | "arcText" | "fitArc";
const round = (n: number) => Math.round(n * 10000) / 10000;
export function rotatePoint(x: number, y: number, angle: number) {
  const a = angle * Math.PI / 180;
  return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) };
}
export function transformedBounds(bounds: LayerBounds, layer: Pick<ProductionEditorLayer, "xMm" | "yMm" | "rotationDeg">): LayerBounds {
  const corners = [[bounds.x, bounds.y], [bounds.x + bounds.width, bounds.y], [bounds.x, bounds.y + bounds.height], [bounds.x + bounds.width, bounds.y + bounds.height]].map(([x, y]) => rotatePoint(x!, y!, layer.rotationDeg));
  const x = Math.min(...corners.map((p) => p.x)), y = Math.min(...corners.map((p) => p.y));
  return { x: x + layer.xMm, y: y + layer.yMm, width: Math.max(...corners.map((p) => p.x)) - x, height: Math.max(...corners.map((p) => p.y)) - y };
}
/** Fractional source bounds exclude transparent padding; flips happen inside the image frame. */
export function imageSubjectBounds(layer: ProductionEditorImageLayer, source: LayerBounds): LayerBounds {
  return transformedBounds({ x: (layer.flipX ? 1 - source.x - source.width : source.x) * layer.widthMm, y: (layer.flipY ? 1 - source.y - source.height : source.y) * layer.heightMm, width: source.width * layer.widthMm, height: source.height * layer.heightMm }, layer);
}
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number): LayerBounds {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]! > 8) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  if (right < left) throw new Error("图稿中的所选图片没有可见主体，请先恢复抠图区域。");
  return { x: left / width, y: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height };
}
/** Alignment uses the printable area's bounding rectangle, not the barcode extension. */
export function printableBounds(document: ProductionEditorDocument, fullBleed = false): LayerBounds {
  if (document.productType === "tire_cover") {
    const inset = fullBleed ? 0 : document.spec.safeInsetMm;
    return validBounds({ x: inset, y: inset, width: document.spec.diameterMm - 2 * inset, height: document.spec.diameterMm - 2 * inset });
  }
  const points = sampleClosedContour(document.contour);
  const left = Math.min(...points.map((p) => p[0])), top = Math.min(...points.map((p) => p[1]));
  const inset = document.spec.whiteBorderMm;
  return validBounds({ x: left + inset, y: top + inset, width: Math.max(...points.map((p) => p[0])) - left - 2 * inset, height: Math.max(...points.map((p) => p[1])) - top - 2 * inset });
}
function validBounds(bounds: LayerBounds) {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error("图稿的可排版区域为空，请先调整工艺尺寸或白边。");
  return bounds;
}
export function alignProductionLayer<T extends ProductionEditorLayer>(layer: T, bounds: LayerBounds, target: LayerBounds, action: LayoutAction): T {
  if (layer.locked) return layer;
  let dx = 0, dy = 0;
  if (action === "left") dx = target.x - bounds.x;
  if (action === "centerX") dx = target.x + target.width / 2 - bounds.x - bounds.width / 2;
  if (action === "right") dx = target.x + target.width - bounds.x - bounds.width;
  if (action === "top") dy = target.y - bounds.y;
  if (action === "centerY") dy = target.y + target.height / 2 - bounds.y - bounds.height / 2;
  if (action === "bottom") dy = target.y + target.height - bounds.y - bounds.height;
  return { ...layer, xMm: round(layer.xMm + dx), yMm: round(layer.yMm + dy) };
}
export function fitProductionImage(layer: ProductionEditorImageLayer, bounds: LayerBounds, target: LayerBounds): ProductionEditorImageLayer {
  if (layer.locked) return layer;
  validBounds(bounds); validBounds(target);
  const scale = Math.min(target.width / bounds.width, target.height / bounds.height);
  return { ...layer, widthMm: round(layer.widthMm * scale), heightMm: round(layer.heightMm * scale), xMm: round(target.x + (target.width - bounds.width * scale) / 2 - (bounds.x - layer.xMm) * scale), yMm: round(target.y + (target.height - bounds.height * scale) / 2 - (bounds.y - layer.yMm) * scale) };
}
export function rotateProductionLayer<T extends ProductionEditorLayer>(layer: T, bounds: LayerBounds, degrees: number): T {
  if (layer.locked) return layer;
  const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;
  const origin = rotatePoint(layer.xMm - cx, layer.yMm - cy, degrees);
  return { ...layer, xMm: round(cx + origin.x), yMm: round(cy + origin.y), rotationDeg: ((layer.rotationDeg + degrees + 540) % 360 + 360) % 360 - 180 };
}
export function resizeImageProportionally(layer: ProductionEditorImageLayer, axis: "widthMm" | "heightMm", value: number, proportional: boolean): ProductionEditorImageLayer {
  if (layer.locked) return layer;
  const other = axis === "widthMm" ? "heightMm" : "widthMm";
  const factor = proportional ? Math.min(value / layer[axis], 5000 / layer[other]) : 1;
  return { ...layer, [axis]: proportional ? layer[axis] * factor : value, ...(proportional ? { [other]: layer[other] * factor } : {}) };
}
export function replaceProductionImage(layer: ProductionEditorImageLayer, image: { id: string; version: number; name: string; width: number; height: number }): ProductionEditorImageLayer {
  if (layer.locked) return layer;
  const scale = Math.min(layer.widthMm / image.width, layer.heightMm / image.height);
  const widthMm = image.width * scale, heightMm = image.height * scale;
  const offset = rotatePoint((layer.widthMm - widthMm) / 2, (layer.heightMm - heightMm) / 2, layer.rotationDeg);
  return { ...layer, assetId: image.id, assetVersion: image.version, name: image.name, widthMm, heightMm, xMm: round(layer.xMm + offset.x), yMm: round(layer.yMm + offset.y) };
}
export function duplicateProductionLayer(document: ProductionEditorDocument, id: string, copyId: string): ProductionEditorDocument {
  const index = document.layers.findIndex((layer) => layer.id === id), layer = document.layers[index];
  if (!layer || layer.locked || document.layers.length >= 100) return document;
  const copy = { ...structuredClone(layer), id: copyId, name: `${layer.name.slice(0, 156)} 副本`, xMm: Math.min(10000, layer.xMm + 5), yMm: Math.min(10000, layer.yMm + 5) };
  return { ...document, layers: [...document.layers.slice(0, index + 1), copy, ...document.layers.slice(index + 1)] };
}
export function nudgeProductionLayer(layer: ProductionEditorLayer, dx: number, dy: number): ProductionEditorLayer {
  return layer.locked ? layer : { ...layer, xMm: Math.max(-10000, Math.min(10000, layer.xMm + dx)), yMm: Math.max(-10000, Math.min(10000, layer.yMm + dy)) };
}
export function imageEffectiveDpi(layer: ProductionEditorImageLayer, image: { width: number; height: number }) {
  return Math.min(image.width * 25.4 / layer.widthMm, image.height * 25.4 / layer.heightMm);
}
export function fitArcFontSize(layer: ProductionEditorTextLayer, advanceMm: number): ProductionEditorTextLayer {
  if (layer.locked || !layer.arc || advanceMm <= 0) return layer;
  const available = (layer.arc.endAngleDeg - layer.arc.startAngleDeg) * Math.PI / 180 * layer.arc.radiusMm * 0.94;
  const factor = Math.min(available / advanceMm, 500 / layer.fontSizeMm, layer.letterSpacingMm > 0 ? 100 / layer.letterSpacingMm : layer.letterSpacingMm < 0 ? -10 / layer.letterSpacingMm : Infinity);
  return { ...layer, fontSizeMm: layer.fontSizeMm * factor, letterSpacingMm: layer.letterSpacingMm * factor };
}
