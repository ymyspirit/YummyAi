import { describe, expect, it } from "vitest";
import { measurePillowSubject, planPillowSubjectPlacement, type PillowSubjectRaster } from "./pillow-subject.js";

function rectangle(width: number, height: number, bounds: { x: number; y: number; width: number; height: number }): PillowSubjectRaster {
  const alpha = new Uint8Array(width * height);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) alpha.fill(255, y * width + bounds.x, y * width + bounds.x + bounds.width);
  return { width, height, alpha };
}

describe("versioned pillow subject measurement", () => {
  it("uses inclusive alpha32 cells and preserves every RGBA byte including faint residue", () => {
    const rgba = new Uint8Array(12 * 8 * 4);
    for (let i = 0; i < 12 * 8; i++) rgba.set([23, 91, 175, 0], i * 4);
    rgba[3] = 31; rgba[(7 * 12 + 11) * 4 + 3] = 1;
    for (let y = 2; y <= 5; y++) for (let x = 3; x <= 8; x++) rgba[(y * 12 + x) * 4 + 3] = 32;
    const before = rgba.slice();
    expect(measurePillowSubject({ width: 12, height: 8, rgba })).toMatchObject({
      version: "pillow-subject-v1-2026-09-19", alphaThreshold: 32, fineDetailPolicy: "none", boundsRounding: "inclusive-pixel-cells",
      sourceWidthPx: 12, sourceHeightPx: 8, bounds: { x: 3, y: 2, width: 6, height: 4 }, visiblePixelCount: 24, ignoredLowAlphaPixelCount: 2,
    });
    expect(rgba).toEqual(before);
  });

  it.each([10, 12, 14, 16, 18, 20, 22, 24])("sizes the visible subject at exactly %i inches, excluding transparent padding and seam", inches => {
    const measured = measurePillowSubject(rectangle(3800, 2100, { x: 100, y: 50, width: 3600, height: 1800 }));
    const placed = planPillowSubjectPlacement(measured, { longestSideInches: inches });
    expect(placed.targetLongestPx).toBe(inches * 150);
    expect(placed.subjectWidthMm).toBeCloseTo(inches * 25.4, 10);
    expect(placed.subjectHeightMm / placed.subjectWidthMm).toBeCloseTo(0.5, 10);
    expect(placed.artworkWidthMm / placed.artworkHeightMm).toBeCloseTo(3800 / 2100, 10);
    expect(placed.effectivePpi).toBe(3600 / inches);
    expect(placed.requiresUpscale).toBe(false);
    expect(placed.artworkOffsetXMm).toBeCloseTo(-100 * placed.mmPerSourcePixel, 10);
  });

  it("uses vertical longest side and flags pixel deficits without rounding PPI or changing DPI metadata", () => {
    const measured = measurePillowSubject(rectangle(900, 1600, { x: 100, y: 50, width: 700, height: 1499 }));
    const placed = planPillowSubjectPlacement(measured, { longestSideInches: 10 });
    expect(placed.effectivePpi).toBe(149.9);
    expect(placed.requiresUpscale).toBe(true);
    expect(placed.subjectHeightMm).toBeCloseTo(254, 10);
    expect(placed.targetLongestPx).toBe(1500);
    expect(placed.requiredUpscaleFactor).toBeCloseTo(1500 / 1499, 10);
  });

  it("does not count a large transparent canvas as usable pixels", () => {
    const measured = measurePillowSubject(rectangle(2048, 2048, { x: 700, y: 900, width: 600, height: 200 }));
    expect(planPillowSubjectPlacement(measured, { longestSideInches: 24 })).toMatchObject({ effectivePpi: 25, requiresUpscale: true, requiredUpscaleFactor: 6 });
  });

  it("normalizes millimetre conversion noise to exact ordered production pixels", () => {
    const measurement = measurePillowSubject(rectangle(3600, 1800, { x: 0, y: 0, width: 3600, height: 1800 }));
    expect(planPillowSubjectPlacement(measurement, { longestSideInches: 609.5999999999999 / 25.4 })).toMatchObject({ longestSideInches: 24, targetLongestPx: 3600, effectivePpi: 150, requiresUpscale: false });
  });

  it("rejects empty, malformed and unsupported-size inputs", () => {
    expect(() => measurePillowSubject({ width: 2, height: 2, alpha: new Uint8Array([0, 31, 1, 0]) })).toThrow("pillow_subject_not_visible");
    expect(() => measurePillowSubject({ width: 2, height: 2, alpha: new Uint8Array(3) })).toThrow("pillow_subject_raster_length_invalid");
    expect(() => measurePillowSubject({ width: 1.5, height: 2, alpha: new Uint8Array(3) })).toThrow("pillow_subject_raster_dimensions_invalid");
    const measured = measurePillowSubject(rectangle(10, 10, { x: 1, y: 1, width: 8, height: 8 }));
    expect(() => planPillowSubjectPlacement(measured, { longestSideInches: 9 })).toThrow("pillow_subject_order_size_invalid");
    expect(() => planPillowSubjectPlacement(measured, { longestSideInches: 25 })).toThrow("pillow_subject_order_size_invalid");
  });
});
