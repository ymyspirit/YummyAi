import type { ProductionEditorImageLayer, ProductionEditorPoint, ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, pillowBottomCenter, polygonArea, sampleClosedContour } from "@yummyai/production-editor/geometry";

type Point = [number, number];
export interface PillowAlphaMask { alpha: Uint8Array; width: number; height: number; mmPerPixel: number; originX: number; originY: number }

export function pillowSubjectLongest(mask: PillowAlphaMask): number {
  let minX = mask.width, minY = mask.height, maxX = -1, maxY = -1;
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) if (mask.alpha[y * mask.width + x]! >= 32) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  if (maxX < minX) throw new Error("图稿没有可识别的可见主体，请检查图片透明度。");
  return Math.max(maxX - minX + 1, maxY - minY + 1) * mask.mmPerPixel;
}

/** Generate a draft cut boundary from the placed image's alpha, never its RGB background. */
export function tracePillowOutline(mask: PillowAlphaMask, whiteBorderMm: number): ProductionEditorPoint[] {
  const { width, height, alpha, mmPerPixel, originX, originY } = mask;
  if (width < 3 || height < 3 || width * height > 1_200_000 || alpha.length !== width * height || !Number.isFinite(mmPerPixel) || mmPerPixel <= 0) throw new Error("图稿轮廓采样超限，请缩小图片后重试。");
  if (!alpha.some((value) => value >= 32)) throw new Error("图稿没有可识别的可见主体，请检查图片透明度。");
  // Two extra sample cells protect the subject against raster and simplification error.
  const radius = whiteBorderMm / mmPerPixel + 2;
  const distance = new Float64Array(width * height);
  const line = new Float64Array(Math.max(width, height));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) line[x] = alpha[y * width + x]! >= 32 ? 0 : 1e12;
    const row = squaredDistance(line.subarray(0, width));
    distance.set(row, y * width);
  }
  const expanded = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) line[y] = distance[y * width + x]!;
    const column = squaredDistance(line.subarray(0, height));
    for (let y = 0; y < height; y++) expanded[y * width + x] = column[y]! <= radius * radius ? 1 : 0;
  }
  const loops = boundaryLoops(expanded, width, height).filter((points) => polygonArea(points) > 0);
  if (loops.length !== 1) throw new Error("图稿有多个分离的主体，请手动连接轮廓，或调整主体间距后重新生成。");
  const loop = loops[0]!;
  if (loop.some(([x, y]) => x === 0 || y === 0 || x === width || y === height)) throw new Error("图稿轮廓超出采样边界，请缩小白边或图片后重试。");
  // Split a closed ring at its farthest vertex. Final bounds are measured after smoothing.
  let farthest = 1;
  for (let i = 2; i < loop.length; i++) if (squaredLength(loop[0]!, loop[i]!) > squaredLength(loop[0]!, loop[farthest]!)) farthest = i;
  let simplified: Point[] = [];
  for (let tolerance = 0.75; tolerance <= 2.01; tolerance += 0.25) {
    simplified = [...simplify(loop.slice(0, farthest + 1), tolerance).slice(0, -1), ...simplify([...loop.slice(farthest), loop[0]!], tolerance).slice(0, -1)];
    if (simplified.length <= 180) break;
  }
  if (simplified.length > 180 || simplified.length < 3) throw new Error("图稿轮廓细节过多，请使用更干净的抠图或手动勾轮廓。");
  return simplified.map(([x, y]) => ({ xMm: originX + x * mmPerPixel, yMm: originY + y * mmPerPixel, smooth: true }));
}

export function applyPillowOutline(document: ShapedPillowDocument, points: ProductionEditorPoint[]): ShapedPillowDocument {
  const sampled = sampleClosedContour(points);
  const minX = Math.min(...sampled.map(([x]) => x)), minY = Math.min(...sampled.map(([, y]) => y));
  const widthMm = Math.max(...sampled.map(([x]) => x)) - minX, heightMm = Math.max(...sampled.map(([, y]) => y)) - minY;
  if (Math.min(widthMm, heightMm) < 10 || Math.max(widthMm, heightMm) > 5000) throw new Error("图稿轮廓尺寸超出范围，请调整图片尺寸。");
  const next: ShapedPillowDocument = {
    ...document,
    spec: { ...document.spec, widthMm, heightMm, barcodeTab: { ...document.spec.barcodeTab } },
    contour: points.map((point) => ({ ...point, xMm: point.xMm - minX, yMm: point.yMm - minY })),
    layers: document.layers.map((layer) => ({ ...layer, xMm: layer.xMm - minX, yMm: layer.yMm - minY })),
  };
  next.spec.barcodeTab.centerXMm = pillowBottomCenter(next);
  if (buildPillowContour({ ...next, spec: { ...next.spec, barcodeTab: { ...next.spec.barcodeTab, widthMm: null, heightMm: null } } }).issues.length) throw new Error("图稿轮廓无法闭合，请手动修整后重试。");
  return next;
}

export async function samplePillowImage(url: string, layer: ProductionEditorImageLayer, whiteBorderMm: number): Promise<PillowAlphaMask> {
  const image = new Image(); image.referrerPolicy = "no-referrer";
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("图稿原图预览读取失败，请刷新项目后重试。")); image.src = url; });
  const radians = layer.rotationDeg * Math.PI / 180;
  const corners = [[0, 0], [layer.widthMm, 0], [layer.widthMm, layer.heightMm], [0, layer.heightMm]].map(([x, y]) => [layer.xMm + x! * Math.cos(radians) - y! * Math.sin(radians), layer.yMm + x! * Math.sin(radians) + y! * Math.cos(radians)]);
  const minX = Math.min(...corners.map(([x]) => x!)), maxX = Math.max(...corners.map(([x]) => x!));
  const minY = Math.min(...corners.map(([, y]) => y!)), maxY = Math.max(...corners.map(([, y]) => y!));
  const mmPerPixel = Math.max(0.2, (Math.max(maxX - minX, maxY - minY) + whiteBorderMm * 2) / 980);
  const pad = whiteBorderMm + mmPerPixel * 8;
  const originX = minX - pad, originY = minY - pad;
  const width = Math.ceil((maxX - minX + pad * 2) / mmPerPixel), height = Math.ceil((maxY - minY + pad * 2) / mmPerPixel);
  const canvas = window.document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("图稿采样画布无法启动。");
  context.scale(1 / mmPerPixel, 1 / mmPerPixel);
  context.translate(layer.xMm - originX, layer.yMm - originY); context.rotate(radians);
  context.translate(layer.flipX ? layer.widthMm : 0, layer.flipY ? layer.heightMm : 0); context.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
  context.drawImage(image, 0, 0, layer.widthMm, layer.heightMm);
  const rgba = context.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3]!;
  return { alpha, width, height, mmPerPixel, originX, originY };
}

function squaredDistance(values: Float64Array): Float64Array {
  const length = values.length, result = new Float64Array(length), sites = new Int32Array(length), edges = new Float64Array(length + 1);
  let k = 0; sites[0] = 0; edges[0] = -Infinity; edges[1] = Infinity;
  for (let q = 1; q < length; q++) {
    let s = 0;
    do { const v = sites[k]!; s = ((values[q]! + q * q) - (values[v]! + v * v)) / (2 * (q - v)); if (s <= edges[k]!) k--; else break; } while (k >= 0);
    k++; sites[k] = q; edges[k] = s; edges[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < length; q++) { while (edges[k + 1]! < q) k++; result[q] = (q - sites[k]!) ** 2 + values[sites[k]!]!; }
  return result;
}

function boundaryLoops(mask: Uint8Array, width: number, height: number): Point[][] {
  const edges = new Map<number, number[]>(), stride = width + 1;
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  const add = (x: number, y: number, toX: number, toY: number) => { const id = y * stride + x; edges.set(id, [...edges.get(id) ?? [], toY * stride + toX]); };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (filled(x, y)) {
    if (!filled(x, y - 1)) add(x, y, x + 1, y);
    if (!filled(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!filled(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!filled(x - 1, y)) add(x, y + 1, x, y);
  }
  const loops: Point[][] = [];
  while (edges.size) {
    const start = edges.keys().next().value!; let cursor = start;
    const points: Point[] = [];
    do {
      points.push([cursor % stride, Math.floor(cursor / stride)]);
      const choices = edges.get(cursor);
      if (!choices?.length || choices.length > 1) throw new Error("图稿轮廓存在点接触，请修整抠图后重试。");
      const next = choices[0]!; edges.delete(cursor); cursor = next;
    } while (cursor !== start);
    loops.push(points);
  }
  return loops;
}

function squaredLength(a: Point, b: Point) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
function simplify(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) return points;
  const keep = new Set([0, points.length - 1]), stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!, a = points[start]!, b = points[end]!;
    let furthest = -1, maximum = tolerance * tolerance;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!, length = squaredLength(a, b), t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / length)) : 0;
      const distance = squaredLength(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      if (distance > maximum) { maximum = distance; furthest = i; }
    }
    if (furthest !== -1) { keep.add(furthest); stack.push([start, furthest], [furthest, end]); }
  }
  return [...keep].sort((a, b) => a - b).map((index) => points[index]!);
}
