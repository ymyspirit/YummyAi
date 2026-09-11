import type { ProductionEditorDocument, ProductionEditorPoint, ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import polygonClipping from "polygon-clipping";

export const MAX_PRODUCTION_PIXELS = 100_000_000;
export const mmToPixels = (mm: number, dpi: number) => Math.max(1, Math.round(mm * dpi / 25.4));
export function layoutArcGlyphs(advancesMm: number[], arc: { radiusMm: number; startAngleDeg: number; endAngleDeg: number }) {
  const radians = Math.PI / 180;
  const availableMm = (arc.endAngleDeg - arc.startAngleDeg) * radians * arc.radiusMm;
  const totalMm = advancesMm.reduce((sum, advance) => sum + advance, 0);
  let cursor = (availableMm - totalMm) / 2;
  const glyphs = advancesMm.map((advance) => {
    const angle = arc.startAngleDeg * radians + (cursor + advance / 2) / arc.radiusMm;
    cursor += advance;
    return { xMm: Math.cos(angle) * arc.radiusMm, yMm: Math.sin(angle) * arc.radiusMm, rotationDeg: angle / radians + 90, advanceMm: advance };
  });
  return { glyphs, totalMm, availableMm, overflow: totalMm > availableMm + 0.001 };
}
export function getProductionLayout(document: ProductionEditorDocument) {
  if (document.productType === "tire_cover") {
    const diameter = document.spec.diameterMm;
    return { widthMm: diameter, heightMm: diameter, widthPx: mmToPixels(diameter, document.spec.dpi), heightPx: mmToPixels(diameter, document.spec.dpi), panelWidthMm: diameter, panelHeightMm: diameter, marginMm: 0, backOffsetMm: 0 };
  }
  const { widthMm, heightMm, cutLineMm, panelGapMm, barcodeTab, dpi } = document.spec;
  const marginMm = cutLineMm / 2 + 1;
  const panelWidthMm = widthMm + marginMm * 2;
  const panelHeightMm = heightMm + (barcodeTab.heightMm ?? 0) + marginMm * 2;
  const sheetWidth = panelWidthMm * 2 + panelGapMm;
  return { widthMm: sheetWidth, heightMm: panelHeightMm, widthPx: mmToPixels(sheetWidth, dpi), heightPx: mmToPixels(panelHeightMm, dpi), panelWidthMm, panelHeightMm, marginMm, backOffsetMm: panelWidthMm + panelGapMm };
}

/** Catmull-Rom is sampled before polygon union so the tab has one external boundary. */
export function sampleClosedContour(points: ProductionEditorPoint[]): [number, number][] {
  const result: [number, number][] = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const p0 = points[(i + count - 1) % count], p1 = points[i], p2 = points[(i + 1) % count], p3 = points[(i + 2) % count];
    const distance = Math.hypot(p2.xMm - p1.xMm, p2.yMm - p1.yMm);
    const steps = p1.smooth || p2.smooth ? Math.min(256, Math.floor(8000 / count), Math.max(8, Math.ceil(distance / 0.15))) : 1;
    const c1 = p1.smooth ? [p1.xMm + (p2.xMm - p0.xMm) / 6, p1.yMm + (p2.yMm - p0.yMm) / 6] : [p1.xMm, p1.yMm];
    const c2 = p2.smooth ? [p2.xMm - (p3.xMm - p1.xMm) / 6, p2.yMm - (p3.yMm - p1.yMm) / 6] : [p2.xMm, p2.yMm];
    for (let step = 0; step < steps; step++) {
      const t = step / steps, u = 1 - t;
      result.push([u ** 3 * p1.xMm + 3 * u ** 2 * t * c1[0] + 3 * u * t ** 2 * c2[0] + t ** 3 * p2.xMm, u ** 3 * p1.yMm + 3 * u ** 2 * t * c1[1] + 3 * u * t ** 2 * c2[1] + t ** 3 * p2.yMm]);
    }
  }
  return result;
}

export function polygonPath(points: [number, number][]) {
  return points.length ? `M${points.map(([x, y]) => `${round(x)},${round(y)}`).join("L")}Z` : "";
}
function round(value: number) { return Number(value.toFixed(5)); }

/** Horizontal anchor of the lowest part of the body; the tab never attaches to a side. */
export function pillowBottomCenter(document: ShapedPillowDocument) {
  const points = sampleClosedContour(document.contour);
  const bottom = Math.max(...points.map(([, y]) => y));
  const lowest = points.filter(([, y]) => bottom - y < 0.1);
  const middle = document.spec.widthMm / 2;
  // A flat bottom uses its middle. Multiple separate low points use the nearest actual point.
  const horizontal = points.flatMap((a, index) => {
    const b = points[(index + 1) % points.length]!;
    return bottom - a[1] < 0.1 && bottom - b[1] < 0.1 ? [(a[0] + b[0]) / 2] : [];
  });
  return (horizontal.length ? horizontal : lowest.map(([x]) => x)).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0] ?? middle;
}

export function buildPillowContour(document: ShapedPillowDocument) {
  const points = sampleClosedContour(document.contour);
  const issues: string[] = [];
  const { widthMm, heightMm, barcodeTab } = document.spec;
  const outside = points.some(([x, y]) => x < -0.001 || y < -0.001 || x > widthMm + 0.001 || y > heightMm + 0.001);
  if (outside) issues.push("contour_outside_body");
  if (!outside && hasSelfIntersection(points)) issues.push("contour_self_intersection");
  if (Math.abs(polygonArea(points)) < 1) issues.push("contour_too_small");
  if (!barcodeTab.widthMm || !barcodeTab.heightMm) return { path: polygonPath(points), points, issues };
  const x1 = barcodeTab.centerXMm - barcodeTab.widthMm / 2;
  const x2 = barcodeTab.centerXMm + barcodeTab.widthMm / 2;
  if (x1 < 0 || x2 > widthMm) issues.push("barcode_outside_body");
  const lowestY = Math.max(...points.map(([, y]) => y));
  const crossesBottom = points.some(([x, y], index) => {
    const next = points[(index + 1) % points.length]!;
    return Math.abs(y - lowestY) < 0.1 && (x >= x1 && x <= x2 || Math.abs(next[1] - lowestY) < 0.1 && Math.max(x, next[0]) >= x1 && Math.min(x, next[0]) <= x2);
  });
  if (!crossesBottom) issues.push("barcode_not_at_bottom");
  // The tab overlaps the existing body to eliminate its internal top border.
  const bottomLeft = bottomIntersection(points, x1), bottomRight = bottomIntersection(points, x2);
  if (bottomLeft === undefined || bottomRight === undefined) {
    issues.push("barcode_not_connected");
    return { path: polygonPath(points), points, issues };
  }
  const top = Math.min(bottomLeft, bottomRight) - 0.01;
  const bottom = heightMm + barcodeTab.heightMm;
  try {
    const union = polygonClipping.union([points], [[[x1, top], [x2, top], [x2, bottom], [x1, bottom], [x1, top]]]);
    if (union.length !== 1 || union[0].length !== 1) issues.push("barcode_union_invalid");
    const merged = (union[0]?.[0] ?? points) as [number, number][];
    return { path: polygonPath(merged), points: merged, issues };
  } catch {
    issues.push("contour_union_failed");
    return { path: polygonPath(points), points, issues };
  }
}

export function bottomIntersection(points: [number, number][], x: number) {
  const intersections: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (x >= Math.min(a[0], b[0]) && x <= Math.max(a[0], b[0])) {
      if (Math.abs(a[0] - b[0]) < 1e-9) intersections.push(a[1], b[1]);
      else intersections.push(a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0])));
    }
  }
  return intersections.length ? Math.max(...intersections) : undefined;
}
export function polygonArea(points: [number, number][]) { return points.reduce((sum, a, i) => { const b = points[(i + 1) % points.length]; return sum + a[0] * b[1] - b[0] * a[1]; }, 0) / 2; }
function hasSelfIntersection(points: [number, number][]) {
  // Spatial cells bound segment comparisons for dense smooth contours.
  const cells = new Map<string, number[]>();
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const cellSize = Math.max(1, (Math.max(...xs) - Math.min(...xs)) / 20, (Math.max(...ys) - Math.min(...ys)) / 20);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const checked = new Set<number>();
    for (let x = Math.floor(Math.min(a[0], b[0]) / cellSize); x <= Math.floor(Math.max(a[0], b[0]) / cellSize); x++) for (let y = Math.floor(Math.min(a[1], b[1]) / cellSize); y <= Math.floor(Math.max(a[1], b[1]) / cellSize); y++) {
      const key = `${x}:${y}`, previous = cells.get(key) ?? [];
      for (const j of previous) {
        if (checked.has(j) || j === i - 1 || (i === points.length - 1 && j === 0)) continue;
        checked.add(j);
        if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return true;
      }
      previous.push(i); cells.set(key, previous);
    }
  }
  return false;
}
function segmentsIntersect(a: number[], b: number[], c: number[], d: number[]) {
  const cross = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < -1e-10 && cross(c, d, a) * cross(c, d, b) < -1e-10;
}
