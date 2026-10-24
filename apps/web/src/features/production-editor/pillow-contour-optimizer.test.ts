import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, getProductionLayout, sampleClosedContour } from "@yummyai/production-editor/geometry";
import { describe, expect, it } from "vitest";
import { applyOptimizedPillowContour, DEFAULT_PILLOW_CONTOUR_SETTINGS, optimizePillowContour, smoothExistingPillowContour } from "./pillow-contour-optimizer";
import { tracePillowOutline, type PillowAlphaMask } from "./pillow-outline";
import { createProductionDocument, invalidateProductionEdit, newProductionImage } from "./production-editor-model";
import { commitEditorHistory, createEditorHistory, undoEditorHistory } from "./editor-history";

const border = 200 * 25.4 / 150;
function catMask(): PillowAlphaMask {
  const width = 600, height = 620, alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const face = ((x - 300) / 140) ** 2 + ((y - 330) / 160) ** 2 <= 1;
    const ear = y >= 110 && y < 280 && ((x >= 190 - (y - 110) * 0.08 && x <= 190 + (y - 110) * 0.5) || (x <= 410 + (y - 110) * 0.08 && x >= 410 - (y - 110) * 0.5));
    const whisker = [300, 330, 360].includes(y) && (x >= 130 && x <= 215 || x >= 385 && x <= 470);
    if (face || ear || whisker) alpha[y * width + x] = 255;
  }
  return { alpha, width, height, mmPerPixel: 0.5, originX: -20, originY: -30 };
}

describe("manufacturing contour optimization", () => {
  it("smooths an existing silhouette outward within the selected allowance, without changing its artwork", () => {
    const original = applyOptimizedPillowContour(createProductionDocument("shaped_pillow") as ShapedPillowDocument, optimizePillowContour(catMask(), border, DEFAULT_PILLOW_CONTOUR_SETTINGS));
    const snapshot = structuredClone(original);
    const points = smoothExistingPillowContour(original, 20);
    const next = applyOptimizedPillowContour(original, points);
    expect(original).toEqual(snapshot);
    expect(buildPillowContour(next).issues).toEqual([]);
    const before = sampleClosedContour(original.contour), after = sampleClosedContour(points);
    for (const point of before.filter((_, index) => index % 20 === 0)) {
      let inside = false;
      for (let i = 0; i < after.length; i++) {
        const a = after[i]!, b = after[(i + 1) % after.length]!;
        if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
      }
      expect(inside).toBe(true);
    }
    for (const point of after.filter((_, index) => index % 20 === 0)) {
      const nearest = Math.min(...before.map((a, i) => {
        const b = before[(i + 1) % before.length]!, dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
      }));
      expect(nearest).toBeLessThanOrEqual(20 * 25.4 / 150);
    }
  });

  it("removes whisker lobes from the cutting path while retaining both ears and source alpha byte for byte", () => {
    const mask = catMask(), snapshot = mask.alpha.slice();
    const before = sampleClosedContour(tracePillowOutline(mask, border));
    const points = optimizePillowContour(mask, border, DEFAULT_PILLOW_CONTOUR_SETTINGS);
    const after = sampleClosedContour(points);
    expect(mask.alpha).toEqual(snapshot);
    expect(points.length).toBeLessThanOrEqual(180);
    expect(points.every(point => point.smooth)).toBe(true);
    const bounds = (values: [number, number][]) => Math.max(...values.map(([x]) => x)) - Math.min(...values.map(([x]) => x));
    expect(bounds(before) - bounds(after)).toBeGreaterThan(15);
    const forehead = after.filter(([x]) => Math.abs(x - 130) < 5);
    const leftEar = after.filter(([x]) => Math.abs(x - 75) < 5);
    expect(Math.min(...forehead.map(([, y]) => y)) - Math.min(...leftEar.map(([, y]) => y))).toBeGreaterThan(15);
    const next = applyOptimizedPillowContour(createProductionDocument("shaped_pillow") as ShapedPillowDocument, points);
    expect(buildPillowContour(next).issues).toEqual([]);
  });

  it("refuses an outline that would cut off even faint long whiskers instead of modifying the artwork", () => {
    const mask = catMask();
    for (let x = 40; x < 180; x++) mask.alpha[330 * mask.width + x] = 3;
    expect(() => optimizePillowContour(mask, border, DEFAULT_PILLOW_CONTOUR_SETTINGS)).toThrow("部分图案超出候选刀线");
  });

  it("preserves relative placement, transform, source version and barcode size; invalidates approval only when applied and supports undo", () => {
    const original = createProductionDocument("shaped_pillow") as ShapedPillowDocument;
    const image = newProductionImage(original, { id: "019f7600-0000-7000-8000-000000000001", name: "cutout", version: 3, width: 600, height: 620 });
    original.layers = [{ ...image, rotationDeg: 15, flipX: true, opacity: 0.85, locked: true }];
    original.spec.barcodeTab = { widthMm: 500 * 25.4 / 150, heightMm: 180 * 25.4 / 150, centerXMm: 3 };
    original.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const snapshot = structuredClone(original);
    const next = applyOptimizedPillowContour(original, optimizePillowContour(catMask(), border, DEFAULT_PILLOW_CONTOUR_SETTINGS));
    const stripPosition = (layer: typeof image) => ({ ...layer, xMm: 0, yMm: 0 });
    expect(stripPosition(next.layers[0] as typeof image)).toEqual(stripPosition(original.layers[0] as typeof image));
    expect(original).toEqual(snapshot);
    expect(next.spec.barcodeTab.widthMm).toBe(original.spec.barcodeTab.widthMm);
    expect(next.spec.barcodeTab.heightMm).toBe(original.spec.barcodeTab.heightMm);
    expect(next.spec.artworkClipMode).toBe("none");
    const layout = getProductionLayout(next), px = 150 / 25.4;
    expect((layout.marginMm - next.spec.cutLineMm / 2) * px).toBeCloseTo(50);
    expect((layout.backOffsetMm - layout.panelWidthMm) * px).toBeCloseTo(100);
    const bottom = Math.max(...buildPillowContour(next).points.map(([, y]) => y));
    expect(bottom).toBeCloseTo(next.spec.heightMm + next.spec.barcodeTab.heightMm!);
    expect((layout.heightMm - layout.marginMm - bottom - next.spec.cutLineMm / 2) * px).toBeGreaterThanOrEqual(50 - 1e-8);
    const history = commitEditorHistory(createEditorHistory(original), invalidateProductionEdit(original, next));
    expect(Object.values(history.present.confirmations).every(value => !value)).toBe(true);
    expect(undoEditorHistory(history).present).toEqual(original);
  });

  it("rejects empty input, disconnected bodies, invalid settings and excessive silhouette removal", () => {
    const mask = catMask(); mask.alpha.fill(0);
    expect(() => optimizePillowContour(mask, border, DEFAULT_PILLOW_CONTOUR_SETTINGS)).toThrow("没有可识别");
    for (let y = 120; y < 250; y++) for (let x = 80; x < 160; x++) { mask.alpha[y * mask.width + x] = 255; mask.alpha[y * mask.width + x + 350] = 255; }
    expect(() => optimizePillowContour(mask, 5, DEFAULT_PILLOW_CONTOUR_SETTINGS)).toThrow("多个分离");
    expect(() => optimizePillowContour(catMask(), border, { fineDetailPx: NaN, roundingPx: 20 })).toThrow("参数");
    mask.alpha.fill(0); for (let x = 150; x < 450; x++) mask.alpha[300 * mask.width + x] = 255;
    expect(() => optimizePillowContour(mask, border, DEFAULT_PILLOW_CONTOUR_SETTINGS)).toThrow("影响了较多主体");
  });
});
