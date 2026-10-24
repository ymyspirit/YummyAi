import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorImageLayer, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, getProductionLayout, sampleClosedContour } from "./geometry.js";
import { optimizePillowContour } from "./pillow-contour-optimizer.js";
import { applyPillowOutline, type PillowAlphaMask } from "./pillow-outline.js";
import { measurePillowSubject, pillowRasterAlpha, planPillowSubjectPlacement, PILLOW_SUBJECT_ALPHA_THRESHOLD, type PillowSubjectMeasurement, type PillowSubjectPlacement, type PillowSubjectRaster } from "./pillow-subject.js";

export const PILLOW_AUTOMATION_CONTOUR_VERSION = "pillow-independent-contour-v1-2026-09-19" as const;
export const PILLOW_AUTOMATION_CONTOUR_SETTINGS = { baseBorderPx: 200, maxExtraPx: 30, roundingPx: 20, fineDetailPx: 0 } as const;

export interface PillowAutomationGeometryOptions {
  artworkLayerId: string;
  longestSideInches: number;
  /** A bounded geometry-only retry may change this value, never the artwork. */
  roundingPx?: number;
}

export interface PillowAutomationGeometryResult {
  document: ShapedPillowDocument;
  measurement: PillowSubjectMeasurement;
  placement: PillowSubjectPlacement;
  qa: {
    version: typeof PILLOW_AUTOMATION_CONTOUR_VERSION;
    technicalPassed: boolean;
    manualReviewRequired: true;
    geometry: { baseBorderPx: 200; maxExtraPx: 30; roundingPx: number; fineDetailPx: 0; sampleMmPerPixel: number; minimumSeamPx: number | null; maximumSeamPx: number | null; widthPx: number; heightPx: number };
    checks: Array<{ code: string; status: "passed" | "failed" | "manual" }>;
  };
  diagnostics: string[];
}

export interface PillowAutomationGeometryVerification {
  technicalPassed: boolean;
  measurement: PillowSubjectMeasurement;
  placement: PillowSubjectPlacement;
  minimumSeamPx: number | null;
  maximumSeamPx: number | null;
  issues: string[];
}

/** Recheck the persisted path against the original pixels, without regenerating it. */
export function verifyPillowAutomationGeometry(document: ShapedPillowDocument, raster: PillowSubjectRaster, options: PillowAutomationGeometryOptions): PillowAutomationGeometryVerification {
  requireFactoryDocument(document);
  const artwork = requireArtwork(document, options.artworkLayerId);
  const measurement = measurePillowSubject(raster), placement = planPillowSubjectPlacement(measurement, options);
  const roundingPx = options.roundingPx ?? PILLOW_AUTOMATION_CONTOUR_SETTINGS.maxExtraPx;
  if (!Number.isFinite(roundingPx) || roundingPx < 10 || roundingPx > 30) throw new Error("pillow_contour_allowance_out_of_range");
  const issues: string[] = [];
  if (Math.abs(artwork.widthMm - placement.artworkWidthMm) > 1e-7 || Math.abs(artwork.heightMm - placement.artworkHeightMm) > 1e-7) {
    return { technicalPassed: false, measurement, placement, minimumSeamPx: null, maximumSeamPx: null, issues: ["pillow_locked_artwork_size_mismatch"] };
  }
  const radians = artwork.rotationDeg * Math.PI / 180;
  const localCurve = sampleClosedContour(document.contour).map(([worldX, worldY]) => {
    const dx = worldX - artwork.xMm, dy = worldY - artwork.yMm;
    let x = dx * Math.cos(radians) + dy * Math.sin(radians), y = -dx * Math.sin(radians) + dy * Math.cos(radians);
    if (artwork.flipX) x = artwork.widthMm - x;
    if (artwork.flipY) y = artwork.heightMm - y;
    return [x - measurement.bounds.x * placement.mmPerSourcePixel, y - measurement.bounds.y * placement.mmPerSourcePixel] as [number, number];
  });
  const seam = verifySourceSeamEnvelope(raster, measurement, placement, localCurve);
  if (seam.minimumSeamPx < 200 || seam.maximumSeamPx > 200 + roundingPx) issues.push("pillow_contour_seam_envelope_failed");
  if (!visibleSubjectInside(raster, measurement, placement, localCurve)) issues.push("pillow_visible_subject_outside_contour");
  issues.push(...buildPillowContour(document).issues);
  return { technicalPassed: issues.length === 0, measurement, placement, ...seam, issues };
}

/** Explicit new-pipeline entry point. It measures and places the entire asset once. */
export function createPillowAutomationGeometry(document: ShapedPillowDocument, raster: PillowSubjectRaster, options: PillowAutomationGeometryOptions): PillowAutomationGeometryResult {
  requireFactoryDocument(document);
  const artwork = requireArtwork(document, options.artworkLayerId);
  const measurement = measurePillowSubject(raster);
  const placement = planPillowSubjectPlacement(measurement, options);
  const placed: ShapedPillowDocument = {
    ...document,
    spec: { ...document.spec, declaredLongestMm: options.longestSideInches * 25.4 },
    layers: document.layers.map(layer => layer.id === artwork.id ? {
      ...artwork, widthMm: placement.artworkWidthMm, heightMm: placement.artworkHeightMm,
      xMm: placement.artworkOffsetXMm, yMm: placement.artworkOffsetYMm, locked: true,
    } : { ...layer }),
  };
  return buildGeometry(placed, raster, options, measurement, placement);
}

/** Geometry retries preserve all source pixels, source references, size, angle and flips. */
export function recomputePillowAutomationGeometry(document: ShapedPillowDocument, raster: PillowSubjectRaster, options: PillowAutomationGeometryOptions): PillowAutomationGeometryResult {
  requireFactoryDocument(document);
  const artwork = requireArtwork(document, options.artworkLayerId);
  if (!artwork.locked) throw new Error("pillow_artwork_not_locked");
  const measurement = measurePillowSubject(raster);
  const placement = planPillowSubjectPlacement(measurement, options);
  if (Math.abs(artwork.widthMm - placement.artworkWidthMm) > 1e-7 || Math.abs(artwork.heightMm - placement.artworkHeightMm) > 1e-7 || Math.abs((document.spec.declaredLongestMm ?? 0) - options.longestSideInches * 25.4) > 1e-7) throw new Error("pillow_locked_artwork_size_mismatch");
  return buildGeometry(document, raster, options, measurement, placement);
}

function buildGeometry(document: ShapedPillowDocument, raster: PillowSubjectRaster, options: PillowAutomationGeometryOptions, measurement: PillowSubjectMeasurement, placement: PillowSubjectPlacement): PillowAutomationGeometryResult {
  const roundingPx = options.roundingPx ?? PILLOW_AUTOMATION_CONTOUR_SETTINGS.roundingPx;
  if (!Number.isFinite(roundingPx) || roundingPx < 10 || roundingPx > PILLOW_AUTOMATION_CONTOUR_SETTINGS.maxExtraPx) throw new Error("pillow_contour_allowance_out_of_range");
  const artwork = requireArtwork(document, options.artworkLayerId);
  const mask = subjectSamplingMask(raster, measurement, placement);
  // The manufacturing reference is the SAME alpha>=32 mask as the ruler. The
  // source pixels (including low-alpha residue) remain in the original asset.
  let localContour;
  try { localContour = optimizePillowContour(mask, pxToMm(200), { fineDetailPx: 0, roundingPx }); }
  catch { return contourFailure(document, measurement, placement, mask, roundingPx); }
  const seam = verifySourceSeamEnvelope(raster, measurement, placement, sampleClosedContour(localContour));
  // The sampling mask is conservative. Independently check the resulting path
  // against ORIGINAL visible pixel cells so sampling cannot silently add margin.
  const seamPassed = seam.minimumSeamPx >= 200 && seam.maximumSeamPx <= 200 + roundingPx;
  const radians = artwork.rotationDeg * Math.PI / 180;
  const points = localContour.map(point => {
    let x = point.xMm + measurement.bounds.x * placement.mmPerSourcePixel;
    let y = point.yMm + measurement.bounds.y * placement.mmPerSourcePixel;
    if (artwork.flipX) x = artwork.widthMm - x;
    if (artwork.flipY) y = artwork.heightMm - y;
    return { ...point, xMm: artwork.xMm + x * Math.cos(radians) - y * Math.sin(radians), yMm: artwork.yMm + x * Math.sin(radians) + y * Math.cos(radians) };
  });
  const next = applyPillowOutline(document, points);
  next.spec = { ...next.spec, sizeBasis: "artwork", artworkClipMode: "none", whiteBorderMm: pxToMm(200), cutLineMm: pxToMm(6), panelGapMm: pxToMm(100), sheetMarginMm: pxToMm(50), barcodeTab: { ...next.spec.barcodeTab, widthMm: pxToMm(600), heightMm: pxToMm(200) } };
  next.exportBackground = "white";
  next.confirmations = { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false };
  const issues = buildPillowContour(next).issues;
  const layout = getProductionLayout(next);
  const checks: PillowAutomationGeometryResult["qa"]["checks"] = [
    { code: "pillow_subject_alpha32", status: "passed" },
    { code: "pillow_actual_subject_resolution", status: placement.requiresUpscale ? "failed" : "passed" },
    { code: "pillow_independent_bounded_contour", status: seamPassed ? "passed" : "failed" },
    { code: "pillow_factory_contour_union", status: issues.length ? "failed" : "passed" },
    { code: "pillow_visual_review", status: "manual" },
    { code: "pillow_finished_narrow_parts", status: "manual" },
    { code: "pillow_factory_acceptance", status: "manual" },
  ];
  return {
    document: next, measurement, placement,
    qa: { version: PILLOW_AUTOMATION_CONTOUR_VERSION, technicalPassed: !checks.some(check => check.status === "failed"), manualReviewRequired: true, geometry: { ...PILLOW_AUTOMATION_CONTOUR_SETTINGS, roundingPx, sampleMmPerPixel: mask.mmPerPixel, ...seam, widthPx: layout.widthPx, heightPx: layout.heightPx }, checks },
    diagnostics: [...(placement.requiresUpscale ? ["pillow_actual_subject_resolution_insufficient"] : []), ...(seamPassed ? [] : ["pillow_contour_seam_envelope_failed"]), ...issues, "pillow_visual_review_required", "pillow_finished_narrow_parts_manual", "pillow_factory_acceptance_required"],
  };
}

function contourFailure(document: ShapedPillowDocument, measurement: PillowSubjectMeasurement, placement: PillowSubjectPlacement, mask: PillowAlphaMask, roundingPx: number): PillowAutomationGeometryResult {
  const layout = getProductionLayout(document);
  return {
    document: { ...document, confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } },
    measurement, placement,
    qa: { version: PILLOW_AUTOMATION_CONTOUR_VERSION, technicalPassed: false, manualReviewRequired: true,
      geometry: { ...PILLOW_AUTOMATION_CONTOUR_SETTINGS, roundingPx, sampleMmPerPixel: mask.mmPerPixel, minimumSeamPx: null, maximumSeamPx: null, widthPx: layout.widthPx, heightPx: layout.heightPx },
      checks: [{ code: "pillow_contour_generation", status: "failed" }, { code: "pillow_actual_subject_resolution", status: placement.requiresUpscale ? "failed" : "passed" }, { code: "pillow_visual_review", status: "manual" }, { code: "pillow_finished_narrow_parts", status: "manual" }, { code: "pillow_factory_acceptance", status: "manual" }] },
    diagnostics: ["pillow_contour_generation_failed", ...(placement.requiresUpscale ? ["pillow_actual_subject_resolution_insufficient"] : []), "pillow_visual_review_required", "pillow_finished_narrow_parts_manual", "pillow_factory_acceptance_required"],
  };
}

function subjectSamplingMask(raster: PillowSubjectRaster, measurement: PillowSubjectMeasurement, placement: PillowSubjectPlacement): PillowAlphaMask {
  const maxAllowanceMm = pxToMm(200 + 30);
  const mmPerPixel = Math.max(pxToMm(1), (Math.max(placement.subjectWidthMm, placement.subjectHeightMm) + maxAllowanceMm * 2) / 900);
  const padMm = maxAllowanceMm + mmPerPixel * 8;
  const width = Math.ceil((placement.subjectWidthMm + padMm * 2) / mmPerPixel), height = Math.ceil((placement.subjectHeightMm + padMm * 2) / mmPerPixel);
  if (width * height > 1_200_000) throw new Error("pillow_contour_sampling_limit");
  const alpha = new Uint8Array(width * height);
  const { bounds } = measurement;
  // Conservative pixel-cell coverage avoids dropping fingers/ears when reducing
  // only this independent geometry mask. It does not resize the source image.
  const ratio = placement.mmPerSourcePixel / mmPerPixel, pad = padMm / mmPerPixel;
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    if (pillowRasterAlpha(raster, y * raster.width + x) < PILLOW_SUBJECT_ALPHA_THRESHOLD) continue;
    const left = Math.floor((x - bounds.x) * ratio + pad), right = Math.ceil((x - bounds.x + 1) * ratio + pad);
    const top = Math.floor((y - bounds.y) * ratio + pad), bottom = Math.ceil((y - bounds.y + 1) * ratio + pad);
    for (let iy = top; iy < bottom; iy++) for (let ix = left; ix < right; ix++) alpha[iy * width + ix] = 255;
  }
  return { alpha, width, height, mmPerPixel, originX: -padMm, originY: -padMm };
}

function requireFactoryDocument(document: ShapedPillowDocument): void {
  if (document.spec.factoryStandardId !== SHAPED_PILLOW_FACTORY_STANDARD.id || document.spec.dpi !== 150) throw new Error("pillow_pinned_factory_standard_required");
}

function requireArtwork(document: ShapedPillowDocument, id: string): ProductionEditorImageLayer {
  const artwork = document.layers.find(layer => layer.id === id);
  if (!artwork || artwork.kind !== "image" || !artwork.visible || artwork.opacity !== 1) throw new Error("pillow_visible_opaque_artwork_required");
  if (document.layers.some(layer => layer.id !== id && layer.visible)) throw new Error("pillow_single_artwork_layer_required");
  return artwork;
}

function pxToMm(px: number): number { return px * 25.4 / 150; }

type BoundaryPoint = [number, number];
interface BoundaryTree { point: BoundaryPoint; axis: 0 | 1; left: BoundaryTree | null; right: BoundaryTree | null }

/** Conservative bounds also cover the chord segments used by the factory renderer. */
function verifySourceSeamEnvelope(raster: PillowSubjectRaster, measurement: PillowSubjectMeasurement, placement: PillowSubjectPlacement, curveMm: [number, number][]): { minimumSeamPx: number; maximumSeamPx: number } {
  const { bounds } = measurement;
  const sourceScale = placement.mmPerSourcePixel / pxToMm(1);
  const visible = (x: number, y: number) => x >= 0 && y >= 0 && x < raster.width && y < raster.height && pillowRasterAlpha(raster, y * raster.width + x) >= PILLOW_SUBJECT_ALPHA_THRESHOLD;
  const boundary: BoundaryPoint[] = [];
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
    if (visible(x, y) && (!visible(x - 1, y) || !visible(x + 1, y) || !visible(x, y - 1) || !visible(x, y + 1))) boundary.push([(x - bounds.x + 0.5) * sourceScale, (y - bounds.y + 0.5) * sourceScale]);
  }
  const tree = boundaryTree(boundary, 0);
  if (!tree) throw new Error("pillow_subject_boundary_missing");
  const polygon = curveMm.map(([x, y]) => [x / pxToMm(1), y / pxToMm(1)] as BoundaryPoint);
  const curve: BoundaryPoint[] = [];
  // Existing/manual contours can contain long straight edges. Sample those
  // chords independently too; sparse control points are not a seam proof.
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index]!, b = polygon[(index + 1) % polygon.length]!;
    const segments = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let step = 0; step < segments; step++) curve.push([a[0] + (b[0] - a[0]) * step / segments, a[1] + (b[1] - a[1]) * step / segments]);
  }
  const cellRadius = Math.SQRT1_2 * sourceScale;
  let minimumSeamPx = Infinity, maximumSeamPx = 0;
  for (let i = 0; i < curve.length; i++) {
    const point = curve[i]!, previous = curve[(i + curve.length - 1) % curve.length]!, next = curve[(i + 1) % curve.length]!;
    const segmentRadius = Math.max(Math.hypot(point[0] - previous[0], point[1] - previous[1]), Math.hypot(point[0] - next[0], point[1] - next[1])) / 2;
    const distance = Math.sqrt(nearestBoundarySquared(tree, point, Infinity));
    minimumSeamPx = Math.min(minimumSeamPx, distance - cellRadius - segmentRadius);
    maximumSeamPx = Math.max(maximumSeamPx, distance + cellRadius + segmentRadius);
  }
  return { minimumSeamPx, maximumSeamPx };
}

function boundaryTree(points: BoundaryPoint[], depth: number): BoundaryTree | null {
  if (!points.length) return null;
  const axis = depth % 2 as 0 | 1;
  points.sort((a, b) => a[axis] - b[axis]);
  const middle = Math.floor(points.length / 2);
  return { point: points[middle]!, axis, left: boundaryTree(points.slice(0, middle), depth + 1), right: boundaryTree(points.slice(middle + 1), depth + 1) };
}

function nearestBoundarySquared(tree: BoundaryTree | null, point: BoundaryPoint, best: number): number {
  if (!tree) return best;
  best = Math.min(best, (point[0] - tree.point[0]) ** 2 + (point[1] - tree.point[1]) ** 2);
  const difference = point[tree.axis] - tree.point[tree.axis];
  best = nearestBoundarySquared(difference < 0 ? tree.left : tree.right, point, best);
  if (difference ** 2 < best) best = nearestBoundarySquared(difference < 0 ? tree.right : tree.left, point, best);
  return best;
}

function visibleSubjectInside(raster: PillowSubjectRaster, measurement: PillowSubjectMeasurement, placement: PillowSubjectPlacement, localCurve: [number, number][]): boolean {
  const { bounds } = measurement;
  const curve = localCurve.map(([x, y]) => [x / placement.mmPerSourcePixel + bounds.x, y / placement.mmPerSourcePixel + bounds.y] as BoundaryPoint);
  for (let y = bounds.y; y < bounds.y + bounds.height; y++) {
    const crossings: number[] = [], scanY = y + 0.5;
    for (let index = 0; index < curve.length; index++) {
      const a = curve[index]!, b = curve[(index + 1) % curve.length]!;
      if ((a[1] > scanY) !== (b[1] > scanY)) crossings.push(a[0] + (scanY - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
    }
    crossings.sort((a, b) => a - b);
    let crossing = 0;
    for (let x = bounds.x; x < bounds.x + bounds.width; x++) {
      while (crossing < crossings.length && crossings[crossing]! < x + 0.5) crossing++;
      if (crossing % 2 === 0 && pillowRasterAlpha(raster, y * raster.width + x) >= PILLOW_SUBJECT_ALPHA_THRESHOLD) return false;
    }
  }
  return true;
}
