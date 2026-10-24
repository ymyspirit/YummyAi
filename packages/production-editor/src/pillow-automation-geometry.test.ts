import { describe, expect, it } from "vitest";
import type { ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { createDefaultProductionDocument } from "./products.js";
import { buildPillowContour, getProductionLayout, sampleClosedContour } from "./geometry.js";
import { createPillowAutomationGeometry, recomputePillowAutomationGeometry, verifyPillowAutomationGeometry } from "./pillow-automation-geometry.js";
import { applyPillowOutline } from "./pillow-outline.js";

function document(): ShapedPillowDocument {
  const result = createDefaultProductionDocument("shaped_pillow") as ShapedPillowDocument;
  result.layers = [{ kind: "image", id: "photo", name: "Synthetic fixture", assetId: "019f0000-0000-7000-8000-000000000001", assetVersion: 3, xMm: 30, yMm: 30, widthMm: 220, heightMm: 220, rotationDeg: 0, flipX: false, flipY: false, opacity: 1, visible: true, locked: false }];
  return result;
}

function fixture(kind: "cat" | "person" | "fine" | "circle", size = 1800): { width: number; height: number; alpha: Uint8Array } {
  const width = size, height = size;
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / size, v = y / size;
    const ellipse = (cx: number, cy: number, rx: number, ry: number) => ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
    const body = kind === "circle" ? ellipse(0.5, 0.5, 0.44, 0.44)
      : kind === "cat" ? ellipse(0.5, 0.55, 0.40, 0.36) || (v > 0.09 && v < 0.42 && Math.abs(u - 0.22) < (v - 0.09) * 0.55) || (v > 0.09 && v < 0.42 && Math.abs(u - 0.78) < (v - 0.09) * 0.55)
      : ellipse(0.5, 0.18, 0.15, 0.14) || ellipse(0.5, 0.48, 0.19, 0.24) || ellipse(0.32, 0.50, 0.10, 0.21) || ellipse(0.68, 0.50, 0.10, 0.21) || ellipse(0.40, 0.79, 0.095, 0.17) || ellipse(0.60, 0.79, 0.095, 0.17);
    const detail = kind === "fine" && v > 0.40 && v < 0.44 && u > 0.12 && u < 0.32;
    if (body || detail) alpha[y * width + x] = 255;
  }
  return { width, height, alpha };
}

describe("versioned independent pillow geometry", () => {
  it.each(["cat", "person", "fine"] as const)("makes a connected smooth %s outline using the measured subject without touching source pixels", kind => {
    const raster = fixture(kind);
    const before = raster.alpha!.slice();
    const original = document();
    const result = createPillowAutomationGeometry(original, raster, { artworkLayerId: "photo", longestSideInches: 10 });
    expect(buildPillowContour(result.document).issues).toEqual([]);
    expect(result.document.contour.every(point => point.smooth)).toBe(true);
    expect(result.document.layers[0]).toMatchObject({ assetId: original.layers[0]!.kind === "image" && original.layers[0]!.assetId, assetVersion: 3, locked: true });
    expect(result.document.confirmations).toEqual({ physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false });
    expect(result.document.spec.artworkClipMode).toBe("none");
    expect(result.qa.technicalPassed).toBe(true);
    expect(result.qa.manualReviewRequired).toBe(true);
    expect(result.qa.geometry).toMatchObject({ baseBorderPx: 200, maxExtraPx: 30, fineDetailPx: 0 });
    expect(raster.alpha.every((value, index) => value === before[index])).toBe(true);
    expect(original.layers[0]).toMatchObject({ widthMm: 220, heightMm: 220, locked: false });
  });

  it("uses exact factory tab, line, clear margins and panel gap on both sales-size extremes", () => {
    for (const inches of [10, 24]) {
      const result = createPillowAutomationGeometry(document(), fixture("circle", 4100), { artworkLayerId: "photo", longestSideInches: inches });
      const spec = result.document.spec, px = (mm: number) => mm * 150 / 25.4;
      expect(px(spec.barcodeTab.widthMm!)).toBeCloseTo(600, 10);
      expect(px(spec.barcodeTab.heightMm!)).toBeCloseTo(200, 10);
      expect(px(spec.cutLineMm)).toBeCloseTo(6, 10);
      expect(px(spec.panelGapMm)).toBeCloseTo(100, 10);
      expect(px(spec.sheetMarginMm!)).toBeCloseTo(50, 10);
      expect(result.placement.targetLongestPx).toBe(inches * 150);
      expect(result.qa.geometry.minimumSeamPx).toBeGreaterThanOrEqual(200);
      expect(result.qa.geometry.maximumSeamPx).toBeLessThanOrEqual(230);
      const contour = sampleClosedContour(result.document.contour);
      const bodyLongestPx = Math.max(Math.max(...contour.map(p => p[0])) - Math.min(...contour.map(p => p[0])), Math.max(...contour.map(p => p[1])) - Math.min(...contour.map(p => p[1]))) * 150 / 25.4;
      expect(bodyLongestPx).toBeGreaterThanOrEqual(inches * 150 + 400);
      expect(bodyLongestPx).toBeLessThanOrEqual(inches * 150 + 460);
      const layout = getProductionLayout(result.document);
      expect(px(layout.widthMm - 2 * layout.panelWidthMm)).toBeCloseTo(200, 8);
      expect(px(layout.heightMm - layout.panelHeightMm)).toBeCloseTo(100, 8);
    }
  }, 15_000);

  it("ignores distant alpha31 residue in geometry as well as measurement and retains the original alpha", () => {
    const clean = fixture("cat");
    const residue = { ...clean, alpha: clean.alpha!.slice() };
    residue.alpha[0] = 31; residue.alpha[residue.alpha.length - 1] = 1;
    const options = { artworkLayerId: "photo", longestSideInches: 10 };
    const a = createPillowAutomationGeometry(document(), clean, options), b = createPillowAutomationGeometry(document(), residue, options);
    expect(b.measurement.bounds).toEqual(a.measurement.bounds);
    expect(b.document.contour).toEqual(a.document.contour);
    expect(b.document.layers).toEqual(a.document.layers);
    expect(residue.alpha[0]).toBe(31);
  });

  it("limits geometry retries to independent contour changes and translation, preserving locked aspect, source and angle", () => {
    const raster = fixture("cat");
    const original = document(); original.layers[0]!.rotationDeg = 7;
    const first = createPillowAutomationGeometry(original, raster, { artworkLayerId: "photo", longestSideInches: 10 });
    const before = structuredClone(first.document);
    const next = recomputePillowAutomationGeometry(first.document, raster, { artworkLayerId: "photo", longestSideInches: 10, roundingPx: 30 });
    const { xMm: oldX, yMm: oldY, ...oldAsset } = first.document.layers[0]!;
    const { xMm: newX, yMm: newY, ...newAsset } = next.document.layers[0]!;
    expect([oldX, oldY, newX, newY].every(Number.isFinite)).toBe(true);
    expect(newAsset).toEqual(oldAsset);
    expect(first.document).toEqual(before);
    expect(() => recomputePillowAutomationGeometry(first.document, raster, { artworkLayerId: "photo", longestSideInches: 12 })).toThrow("pillow_locked_artwork_size_mismatch");
    expect(() => recomputePillowAutomationGeometry(first.document, raster, { artworkLayerId: "photo", longestSideInches: 10, roundingPx: 31 })).toThrow("pillow_contour_allowance_out_of_range");
  });

  it("records actual output PPI failure and never fabricates visual or factory approval", () => {
    const result = createPillowAutomationGeometry(document(), fixture("circle", 800), { artworkLayerId: "photo", longestSideInches: 10 });
    expect(result.qa.technicalPassed).toBe(false);
    expect(result.qa.checks).toContainEqual({ code: "pillow_actual_subject_resolution", status: "failed" });
    expect(result.document.confirmations.visualReview).toBe(false);
    expect(result.document.confirmations.narrowParts).toBe(false);
  });

  it("returns recoverable geometry QA so a bounded retry can reuse the locked source", () => {
    const raster = fixture("circle", 800);
    const options = { artworkLayerId: "photo", longestSideInches: 24 };
    const first = createPillowAutomationGeometry(document(), raster, { ...options, roundingPx: 20 });
    expect(first.qa.technicalPassed).toBe(false);
    expect(first.diagnostics).toContain("pillow_contour_generation_failed");
    expect(first.document.layers[0]!.locked).toBe(true);
    const retry = recomputePillowAutomationGeometry(first.document, raster, { ...options, roundingPx: 30 });
    const firstLayer = first.document.layers[0] as { widthMm: number; heightMm: number };
    expect(retry.document.layers[0]).toMatchObject({ widthMm: firstLayer.widthMm, heightMm: firstLayer.heightMm });
    expect(retry.qa.geometry.roundingPx).toBe(30);
    // Even when geometry is recoverable, resolution failure is never waived.
    expect(retry.qa.technicalPassed).toBe(false);
    expect(retry.qa.checks).toContainEqual({ code: "pillow_actual_subject_resolution", status: "failed" });
  });

  it("rejects unpinned factory settings and multiple visible artwork layers", () => {
    const legacy = document(); delete legacy.spec.factoryStandardId;
    expect(() => createPillowAutomationGeometry(legacy, fixture("cat", 100), { artworkLayerId: "photo", longestSideInches: 10 })).toThrow("pillow_pinned_factory_standard_required");
    const multiple = document(); multiple.layers.push({ ...multiple.layers[0]!, id: "other" });
    expect(() => createPillowAutomationGeometry(multiple, fixture("cat", 100), { artworkLayerId: "photo", longestSideInches: 10 })).toThrow("pillow_single_artwork_layer_required");
  });

  it.each([{ flipX: false, flipY: false, rotationDeg: 17 }, { flipX: true, flipY: false, rotationDeg: -13 }, { flipX: true, flipY: true, rotationDeg: 31 }])("server verifier correctly reverses image transforms %j", transform => {
    const raster = fixture("cat");
    const value = document(); Object.assign(value.layers[0]!, transform);
    const options = { artworkLayerId: "photo", longestSideInches: 10 };
    const result = createPillowAutomationGeometry(value, raster, options);
    const before = structuredClone(result.document), alphaBefore = raster.alpha.slice();
    const checked = verifyPillowAutomationGeometry(result.document, raster, options);
    expect(checked.issues).toEqual([]);
    expect(checked.technicalPassed).toBe(true);
    expect(result.document).toEqual(before);
    expect(raster.alpha.every((value, index) => value === alphaBefore[index])).toBe(true);
  });

  it.each([0.94, 1.15])("rejects a separately saved contour scaled by %s despite unchanged 200px spec", factor => {
    const raster = fixture("cat"), options = { artworkLayerId: "photo", longestSideInches: 10 };
    const result = createPillowAutomationGeometry(document(), raster, options);
    const centerX = result.document.spec.widthMm / 2, centerY = result.document.spec.heightMm / 2;
    const altered = applyPillowOutline(result.document, result.document.contour.map(point => ({ ...point, xMm: centerX + (point.xMm - centerX) * factor, yMm: centerY + (point.yMm - centerY) * factor })));
    expect(buildPillowContour(altered).issues).toEqual([]);
    expect(altered.spec.whiteBorderMm).toBe(result.document.spec.whiteBorderMm);
    const checked = verifyPillowAutomationGeometry(altered, raster, options);
    expect(checked.technicalPassed).toBe(false);
    expect(checked.issues).toContain("pillow_contour_seam_envelope_failed");
  });
});
