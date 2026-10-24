/** Browser/server-safe measurement. This module never edits or resamples artwork. */
export const PILLOW_SUBJECT_MEASUREMENT_VERSION = "pillow-subject-v1-2026-09-19" as const;
export const PILLOW_SUBJECT_ALPHA_THRESHOLD = 32 as const;
export const PILLOW_PRODUCTION_DPI = 150 as const;

export type PillowSubjectRaster = { width: number; height: number } & (
  | { alpha: Uint8Array; rgba?: never }
  | { rgba: Uint8Array | Uint8ClampedArray; alpha?: never }
);

export interface PillowSubjectMeasurement {
  version: typeof PILLOW_SUBJECT_MEASUREMENT_VERSION;
  alphaThreshold: typeof PILLOW_SUBJECT_ALPHA_THRESHOLD;
  /** No automatic removal of ears, fingers, fur or other visible fine features. */
  fineDetailPolicy: "none";
  boundsRounding: "inclusive-pixel-cells";
  sourceWidthPx: number;
  sourceHeightPx: number;
  bounds: { x: number; y: number; width: number; height: number };
  visiblePixelCount: number;
  ignoredLowAlphaPixelCount: number;
}

export interface PillowSubjectPlacement {
  measurementVersion: typeof PILLOW_SUBJECT_MEASUREMENT_VERSION;
  dpi: typeof PILLOW_PRODUCTION_DPI;
  longestSideInches: number;
  targetLongestPx: number;
  subjectWidthMm: number;
  subjectHeightMm: number;
  /** Full uncropped asset dimensions; transparent padding remains in the layer. */
  artworkWidthMm: number;
  artworkHeightMm: number;
  /** Place the measured subject's top-left at (0, 0), without cropping the asset. */
  artworkOffsetXMm: number;
  artworkOffsetYMm: number;
  mmPerSourcePixel: number;
  effectivePpi: number;
  requiresUpscale: boolean;
  requiredUpscaleFactor: number;
}

export function validatePillowSubjectRaster(raster: PillowSubjectRaster): void {
  const { width, height } = raster;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 100_000_000) throw new Error("pillow_subject_raster_dimensions_invalid");
  const length = "rgba" in raster && raster.rgba ? raster.rgba.length : raster.alpha?.length;
  const channels = "rgba" in raster && raster.rgba ? 4 : 1;
  if (length !== width * height * channels) throw new Error("pillow_subject_raster_length_invalid");
}

export function pillowRasterAlpha(raster: PillowSubjectRaster, pixelIndex: number): number {
  return raster.rgba ? raster.rgba[pixelIndex * 4 + 3]! : raster.alpha![pixelIndex]!;
}

export function measurePillowSubject(raster: PillowSubjectRaster): PillowSubjectMeasurement {
  validatePillowSubjectRaster(raster);
  let minX = raster.width, minY = raster.height, maxX = -1, maxY = -1;
  let visiblePixelCount = 0, ignoredLowAlphaPixelCount = 0;
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const alpha = pillowRasterAlpha(raster, y * raster.width + x);
    if (alpha >= PILLOW_SUBJECT_ALPHA_THRESHOLD) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      visiblePixelCount++;
    } else if (alpha > 0) ignoredLowAlphaPixelCount++;
  }
  if (!visiblePixelCount) throw new Error("pillow_subject_not_visible");
  return {
    version: PILLOW_SUBJECT_MEASUREMENT_VERSION, alphaThreshold: PILLOW_SUBJECT_ALPHA_THRESHOLD,
    fineDetailPolicy: "none", boundsRounding: "inclusive-pixel-cells",
    sourceWidthPx: raster.width, sourceHeightPx: raster.height,
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    visiblePixelCount, ignoredLowAlphaPixelCount,
  };
}

export function planPillowSubjectPlacement(measurement: PillowSubjectMeasurement, options: { longestSideInches: number }): PillowSubjectPlacement {
  // A stored 609.5999999999999 mm order is still exactly the 24-inch size.
  // Normalize only floating-point conversion noise, never source pixel counts.
  const roundedInches = Math.round(options.longestSideInches);
  const longestSideInches = Math.abs(options.longestSideInches - roundedInches) < 1e-10 ? roundedInches : options.longestSideInches;
  if (!Number.isFinite(longestSideInches) || longestSideInches < 10 || longestSideInches > 24) throw new Error("pillow_subject_order_size_invalid");
  const { bounds } = measurement;
  if (measurement.version !== PILLOW_SUBJECT_MEASUREMENT_VERSION || measurement.alphaThreshold !== 32 || ![bounds.x, bounds.y, bounds.width, bounds.height, measurement.sourceWidthPx, measurement.sourceHeightPx].every(Number.isSafeInteger)
    || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x + bounds.width > measurement.sourceWidthPx || bounds.y + bounds.height > measurement.sourceHeightPx) throw new Error("pillow_subject_measurement_invalid");
  // Do not round millimetres or round PPI up across the 150-PPI acceptance gate.
  const longestSourcePx = Math.max(bounds.width, bounds.height);
  const mmPerSourcePixel = longestSideInches * 25.4 / longestSourcePx;
  const effectivePpi = longestSourcePx / longestSideInches;
  return {
    measurementVersion: PILLOW_SUBJECT_MEASUREMENT_VERSION, dpi: PILLOW_PRODUCTION_DPI,
    longestSideInches, targetLongestPx: longestSideInches * PILLOW_PRODUCTION_DPI,
    subjectWidthMm: bounds.width * mmPerSourcePixel, subjectHeightMm: bounds.height * mmPerSourcePixel,
    artworkWidthMm: measurement.sourceWidthPx * mmPerSourcePixel,
    artworkHeightMm: measurement.sourceHeightPx * mmPerSourcePixel,
    artworkOffsetXMm: -bounds.x * mmPerSourcePixel, artworkOffsetYMm: -bounds.y * mmPerSourcePixel,
    mmPerSourcePixel, effectivePpi, requiresUpscale: effectivePpi < PILLOW_PRODUCTION_DPI,
    requiredUpscaleFactor: Math.max(1, PILLOW_PRODUCTION_DPI / effectivePpi),
  };
}
