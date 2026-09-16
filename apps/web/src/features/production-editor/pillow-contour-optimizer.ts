import type { ProductionEditorPoint, ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, sampleClosedContour } from "@yummyai/production-editor/geometry";
import { applyPillowOutline, squaredDistance, tracePillowMask, type PillowAlphaMask } from "./pillow-outline";

export interface PillowContourSettings {
  /** Width of fine protrusions excluded from the manufacturing silhouette only. */
  fineDetailPx: number;
  /** Additional local seam allowance available to round the cutting path. */
  roundingPx: number;
}
export const DEFAULT_PILLOW_CONTOUR_SETTINGS: PillowContourSettings = { fineDetailPx: 12, roundingPx: 20 };

/** Preserve the approved silhouette and add only a bounded, rounded exterior. */
export function smoothExistingPillowContour(document: ShapedPillowDocument, roundingPx: number): ProductionEditorPoint[] {
  if (!Number.isFinite(roundingPx) || roundingPx < 10 || roundingPx > 50) throw new Error("圆滑余量超出范围。");
  const source = sampleClosedContour(document.contour);
  const minX = Math.min(...source.map(([x]) => x)), minY = Math.min(...source.map(([, y]) => y));
  const maxX = Math.max(...source.map(([x]) => x)), maxY = Math.max(...source.map(([, y]) => y));
  if (buildPillowContour({ ...document, spec: { ...document.spec, barcodeTab: { ...document.spec.barcodeTab, widthMm: null, heightMm: null } } }).issues.length) throw new Error("当前刀线几何无效，请先修整节点或按主体重建轮廓。");
  const extraMm = roundingPx * 25.4 / 150;
  const mmPerPixel = Math.max(0.2, (Math.max(maxX - minX, maxY - minY) + extraMm * 2) / 950);
  const pad = extraMm + mmPerPixel * 8, originX = minX - pad, originY = minY - pad;
  const width = Math.ceil((maxX - minX + pad * 2) / mmPerPixel), height = Math.ceil((maxY - minY + pad * 2) / mmPerPixel);
  if (width * height > 1_200_000) throw new Error("刀线采样超限，请调整图稿尺寸。");
  const curve = source.map(([x, y]) => [(x - originX) / mmPerPixel, (y - originY) / mmPerPixel] as [number, number]);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const crossings = scanlineCrossings(curve, y + 0.5);
    for (let i = 0; i + 1 < crossings.length; i += 2) for (let x = Math.max(0, Math.ceil(crossings[i]! - 0.5)); x < Math.min(width, Math.ceil(crossings[i + 1]! - 0.5)); x++) alpha[y * width + x] = 1;
  }
  const radius = extraMm / mmPerPixel / 3;
  const rounded = dilate(erode(dilate(alpha, width, height, radius), width, height, radius), width, height, 2);
  const distance = distanceTo(alpha, width, height, 1);
  for (const sampling of [{ maxPoints: 120, smoothing: 0.25 }, { maxPoints: 180, smoothing: 0.125 }, { maxPoints: 180, smoothing: 0 }]) {
    const points = tracePillowMask({ alpha: rounded, width, height, mmPerPixel, originX, originY }, sampling);
    const candidate = sampleClosedContour(points).map(([x, y]) => [(x - originX) / mmPerPixel, (y - originY) / mmPerPixel] as [number, number]);
    if (candidate.some(([x, y]) => x < 0 || y < 0 || x >= width || y >= height || Math.sqrt(distance[Math.floor(y) * width + Math.floor(x)]!) + Math.SQRT2 > extraMm / mmPerPixel)) continue;
    if (!artworkInside(alpha, width, height, candidate)) continue;
    return points;
  }
  throw new Error("当前圆滑余量不足以保留原有造型，请增加余量或手动调整局部节点。");
}

/** Geometry only: the supplied alpha and every source asset remain untouched. */
export function optimizePillowContour(mask: PillowAlphaMask, whiteBorderMm: number, settings: PillowContourSettings): ProductionEditorPoint[] {
  const { width, height, alpha, mmPerPixel } = mask;
  if (width < 3 || height < 3 || width * height > 1_200_000 || alpha.length !== width * height || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) throw new Error("轮廓采样超限，请调整图片尺寸后重试。");
  if (!Number.isFinite(whiteBorderMm) || whiteBorderMm < 0 || whiteBorderMm > 200 || !Number.isFinite(settings.fineDetailPx) || settings.fineDetailPx < 0 || settings.fineDetailPx > 30 || !Number.isFinite(settings.roundingPx) || settings.roundingPx < 10 || settings.roundingPx > 50) throw new Error("轮廓参数超出范围。");
  const pixelMm = 25.4 / 150;
  const original = alpha.map(value => value >= 32 ? 1 : 0);
  const count = original.reduce((total, value) => total + value, 0);
  if (!count) throw new Error("图片没有可识别的透明主体，请先完成模型抠图。");
  // Opening removes narrow whiskers from the reference silhouette. It does not
  // alter the image, and large concavities (e.g. between ears) remain intact.
  const detailRadius = settings.fineDetailPx * pixelMm / mmPerPixel / 2;
  const core = detailRadius > 0 ? dilate(erode(original, width, height, detailRadius), width, height, detailRadius) : original;
  if (core.reduce((total, value) => total + value, 0) < count * 0.9) throw new Error("细节过滤影响了较多主体，请减小忽略细线宽度，避免丢失耳朵、手脚等形状。");
  const coreDistance = distanceTo(core, width, height, 1);
  const allowance = settings.roundingPx * pixelMm / mmPerPixel;
  // Two sample cells compensate for rasterization and curve interpolation.
  const baseRadius = whiteBorderMm / mmPerPixel + 2;
  const expanded = coreDistance.map(value => value <= baseRadius ** 2 ? 1 : 0);
  const rounded = erode(dilate(Uint8Array.from(expanded), width, height, allowance / 2), width, height, allowance / 2);
  // Check the actual interpolated curve, not just its control points. The
  // conservative cell-diagonal allowance includes sampling uncertainty.
  const maximumDistance = whiteBorderMm / mmPerPixel + allowance;
  // Prefer fewer, gently filtered knots. Keep more knots at a deep concavity
  // when stronger smoothing would exceed the allowed manufacturing envelope.
  let shortBorder = false;
  for (const sampling of [{ maxPoints: 120, smoothing: 0.25 }, { maxPoints: 180, smoothing: 0.125 }, { maxPoints: 180, smoothing: 0 }]) {
    const points = tracePillowMask({ ...mask, alpha: rounded }, sampling);
    const curve = sampleClosedContour(points).map(([x, y]) => [(x - mask.originX) / mmPerPixel, (y - mask.originY) / mmPerPixel] as [number, number]);
    if (curve.some(([x, y]) => {
      const ix = Math.floor(x), iy = Math.floor(y);
      return ix < 0 || iy < 0 || ix >= width || iy >= height || Math.sqrt(coreDistance[iy * width + ix]!) + Math.SQRT2 > maximumDistance;
    })) continue;
    shortBorder = curve.some(([x, y]) => Math.sqrt(coreDistance[Math.floor(y) * width + Math.floor(x)]!) + 0.5 < whiteBorderMm / mmPerPixel);
    if (shortBorder) continue;
    assertArtworkInside(alpha, width, height, curve);
    return points;
  }
  throw new Error(shortBorder ? "圆滑处理使局部白边不足，请使用手动刀线保留该处缝边。" : "当前圆滑余量不足以保留平顺刀线，请增加圆滑余量后重新预览。");
}

export function applyOptimizedPillowContour(document: ShapedPillowDocument, points: ProductionEditorPoint[]): ShapedPillowDocument {
  const next = applyPillowOutline(document, points);
  next.spec = { ...next.spec, artworkClipMode: "none", sheetMarginMm: 50 * 25.4 / 150, panelGapMm: 100 * 25.4 / 150 };
  const issues = buildPillowContour(next).issues;
  if (issues.length) throw new Error("新刀线与底部条码框不能形成有效外轮廓，请调整条码宽度或手动修整刀线。");
  return next;
}

function distanceTo(mask: Uint8Array, width: number, height: number, target: 0 | 1): Float64Array {
  const result = new Float64Array(width * height), line = new Float64Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = mask[y * width + x] === target ? 0 : 1e12;
    result.set(squaredDistance(line.subarray(0, width)), y * width);
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = result[y * width + x]!;
    const column = squaredDistance(line.subarray(0, height));
    for (let y = 0; y < height; y++) result[y * width + x] = column[y]!;
  }
  return result;
}
function dilate(mask: Uint8Array, width: number, height: number, radius: number) { return Uint8Array.from(distanceTo(mask, width, height, 1), value => value <= radius * radius ? 1 : 0); }
function erode(mask: Uint8Array, width: number, height: number, radius: number) { return Uint8Array.from(distanceTo(mask, width, height, 0), value => value > radius * radius ? 1 : 0); }

function assertArtworkInside(alpha: Uint8Array, width: number, height: number, curve: [number, number][]) {
  if (!artworkInside(alpha, width, height, curve)) throw new Error("部分图案超出候选刀线。请减小忽略细线宽度或手动调整刀线；系统不会裁去原图。");
}
function artworkInside(alpha: Uint8Array, width: number, height: number, curve: [number, number][]) {
  // Scanline containment is bounded by sample height, rather than testing every
  // pixel against every segment. Even faint source pixels must survive.
  for (let y = 0; y < height; y++) {
    const crossings = scanlineCrossings(curve, y + 0.5);
    let crossing = 0;
    for (let x = 0; x < width; x++) {
      while (crossing < crossings.length && crossings[crossing]! < x + 0.5) crossing++;
      if (alpha[y * width + x]! > 0 && crossing % 2 === 0) return false;
    }
  }
  return true;
}
function scanlineCrossings(curve: [number, number][], y: number): number[] {
  const crossings: number[] = [];
  for (let i = 0; i < curve.length; i++) {
    const a = curve[i]!, b = curve[(i + 1) % curve.length]!;
    if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
  }
  return crossings.sort((a, b) => a - b);
}
