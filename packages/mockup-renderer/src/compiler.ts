import { initializeCanvas, readPsd, type Layer, type PixelData, type Psd } from "ag-psd";
import sharp from "sharp";
import { ssim } from "ssim.js";

import { renderCompiledMockup, type CompiledMockupBundle } from "./renderer.js";
import type { ImageMagickRunner } from "./imagemagick.js";
import {
  MAX_CANVAS_PIXELS,
  MAX_PSD_LAYERS,
  MIN_GOLDEN_SSIM,
  MOCKUP_COMPILER_VERSION,
  MockupRenderManifestSchema,
  MockupTemplatePolicyError,
  assertPsdHeader,
} from "./policy.js";

initializeCanvas(
  () => { throw new Error("Controlled PSD compilation does not use canvas-backed decoding"); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
);

type PsdLayer = Layer & { children?: PsdLayer[]; imageData?: PixelData; placedLayer?: { id: string; transform?: number[]; nonAffineTransform?: number[]; type?: string } };

export interface CompiledMockupTemplate extends CompiledMockupBundle {
  placeholder: Uint8Array;
  manifestBytes: Uint8Array;
  ssimPermille: number;
  warnings: Array<{ code: string; message: string }>;
}

export async function compileControlledPsd(bytes: Uint8Array, expectedSlotKey: string, runner: ImageMagickRunner): Promise<CompiledMockupTemplate> {
  assertPsdHeader(bytes);
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true }) as Psd & { imageData?: PixelData; children?: PsdLayer[] };
  if (psd.colorMode !== 3 || psd.bitsPerChannel !== 8) throw new MockupTemplatePolicyError("PSD_COLOR_MODE_UNSUPPORTED", "Controlled templates require RGB 8-bit PSD files");
  if (!psd.width || !psd.height || psd.width * psd.height > MAX_CANVAS_PIXELS) throw new MockupTemplatePolicyError("PSD_CANVAS_LIMIT_EXCEEDED", "PSD canvas exceeds the configured pixel limit");
  const children = psd.children ?? [];
  const layerCount = countLayers(children);
  if (layerCount > MAX_PSD_LAYERS) throw new MockupTemplatePolicyError("PSD_LAYER_LIMIT_EXCEEDED", `PSD contains more than ${MAX_PSD_LAYERS} layers`);
  const names = children.map((layer) => layer.name);
  const expectedNames = ["@background", `@slot:${expectedSlotKey}`, "@foreground"];
  if (names.length !== expectedNames.length || expectedNames.some((name) => !names.includes(name))) {
    throw new MockupTemplatePolicyError("PSD_ROOT_GROUPS_INVALID", `PSD root groups must be exactly ${expectedNames.join(", ")}`);
  }
  const backgroundGroup = requireGroup(children, "@background");
  const slotGroup = requireGroup(children, `@slot:${expectedSlotKey}`);
  const foregroundGroup = requireGroup(children, "@foreground");
  validateRasterGroup(backgroundGroup);
  validateRasterGroup(foregroundGroup);
  const slotLayers = flatten(slotGroup.children ?? []).filter((layer) => layer.placedLayer);
  if (slotLayers.length !== 1) throw new MockupTemplatePolicyError("PSD_SMART_OBJECT_COUNT_INVALID", "A scene requires exactly one embedded smart object");
  const smartObject = slotLayers[0];
  const placed = smartObject.placedLayer!;
  const linked = psd.linkedFiles?.find((file) => file.id === placed.id);
  if (!linked?.data) throw new MockupTemplatePolicyError("PSD_LINKED_OBJECT_FORBIDDEN", "Smart objects must be embedded and include their pinned raster bytes");
  if (linked.name && !/\.(png|jpe?g|webp)$/i.test(linked.name)) throw new MockupTemplatePolicyError("PSD_SMART_OBJECT_MEDIA_UNSUPPORTED", "Embedded smart objects must be PNG, JPEG, or WebP rasters");
  const transform = placed.nonAffineTransform ?? placed.transform;
  if (!transform || transform.length !== 8 || transform.some((value) => !Number.isFinite(value))) {
    throw new MockupTemplatePolicyError("PSD_SMART_OBJECT_TRANSFORM_INVALID", "Smart object requires four finite transform corners");
  }
  const background = await renderGroup(backgroundGroup, psd.width, psd.height);
  const foreground = await renderGroup(foregroundGroup, psd.width, psd.height);
  const mask = smartObject.mask?.imageData ? await imageDataAtCanvas(smartObject.mask.imageData, smartObject.mask.left ?? smartObject.left ?? 0, smartObject.mask.top ?? smartObject.top ?? 0, psd.width, psd.height) : undefined;
  if (!psd.imageData) throw new MockupTemplatePolicyError("PSD_COMPOSITE_MISSING", "PSD must include a saved composite preview for golden verification");
  const preview = await rawImageDataToPng(psd.imageData);
  const manifest = MockupRenderManifestSchema.parse({
    compilerVersion: MOCKUP_COMPILER_VERSION,
    slotKey: expectedSlotKey,
    canvas: { width: psd.width, height: psd.height },
    transform,
    source: { byteSize: bytes.byteLength, layerCount },
    files: { background: "background.png", foreground: "foreground.png", ...(mask ? { mask: "mask.png" } : {}), preview: "preview.png" },
  });
  const baseBundle = { manifest, background, foreground, ...(mask ? { mask } : {}), preview };
  const golden = await renderCompiledMockup(linked.data, baseBundle, runner);
  const score = await imageSsim(preview, golden.bytes);
  if (score < MIN_GOLDEN_SSIM) throw new MockupTemplatePolicyError("PSD_GOLDEN_MISMATCH", `Compiled template SSIM ${score.toFixed(4)} is below ${MIN_GOLDEN_SSIM}`);
  return {
    ...baseBundle,
    placeholder: linked.data,
    manifestBytes: new TextEncoder().encode(JSON.stringify(manifest)),
    ssimPermille: Math.floor(score * 1_000),
    warnings: [],
  };
}

function countLayers(layers: PsdLayer[]): number {
  return layers.reduce((count, layer) => count + 1 + countLayers(layer.children ?? []), 0);
}

function flatten(layers: PsdLayer[]): PsdLayer[] {
  return layers.flatMap((layer) => [layer, ...flatten(layer.children ?? [])]);
}

function requireGroup(layers: PsdLayer[], name: string) {
  const layer = layers.find((candidate) => candidate.name === name);
  if (!layer?.children) throw new MockupTemplatePolicyError("PSD_GROUP_MISSING", `PSD group ${name} is missing`);
  return layer;
}

function validateRasterGroup(group: PsdLayer) {
  for (const layer of flatten(group.children ?? [])) {
    if (layer.children) continue;
    if (layer.text || layer.adjustment || layer.placedLayer || layer.vectorMask || layer.mask) {
      throw new MockupTemplatePolicyError("PSD_LAYER_UNSUPPORTED", `Layer ${layer.name || "unnamed"} must be rasterized before import`);
    }
    if (layer.blendMode && layer.blendMode !== "normal") throw new MockupTemplatePolicyError("PSD_BLEND_MODE_UNSUPPORTED", `Layer ${layer.name || "unnamed"} uses an unsupported blend mode`);
    if (layer.opacity !== undefined && layer.opacity !== 1) throw new MockupTemplatePolicyError("PSD_OPACITY_UNSUPPORTED", `Layer ${layer.name || "unnamed"} must use 100% opacity`);
  }
}

async function renderGroup(group: PsdLayer, width: number, height: number) {
  const inputs = flatten(group.children ?? []).filter((layer) => !layer.children && layer.imageData && !layer.hidden).reverse();
  let canvas = sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const composites = await Promise.all(inputs.map(async (layer) => ({
    input: Buffer.from(await rawImageDataToPng(layer.imageData!)),
    left: layer.left ?? 0,
    top: layer.top ?? 0,
  })));
  canvas = canvas.composite(composites);
  return new Uint8Array(await canvas.png().toBuffer());
}

async function rawImageDataToPng(image: PixelData) {
  return new Uint8Array(await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  }).png().toBuffer());
}

async function imageDataAtCanvas(image: PixelData, left: number, top: number, width: number, height: number) {
  const input = await rawImageDataToPng(image);
  return new Uint8Array(await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: Buffer.from(input), left, top }]).png().toBuffer());
}

async function imageSsim(left: Uint8Array, right: Uint8Array) {
  const [leftRaw, rightRaw] = await Promise.all([
    sharp(left).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (leftRaw.info.width !== rightRaw.info.width || leftRaw.info.height !== rightRaw.info.height) return 0;
  return ssim(
    { data: new Uint8ClampedArray(leftRaw.data), width: leftRaw.info.width, height: leftRaw.info.height },
    { data: new Uint8ClampedArray(rightRaw.data), width: rightRaw.info.width, height: rightRaw.info.height },
  ).mssim;
}
