import { z } from "zod";

export const MOCKUP_COMPILER_VERSION = "controlled-psd-v1";
export const MAX_PSD_BYTES = 250 * 1024 * 1024;
export const MAX_CANVAS_PIXELS = 100_000_000;
export const MAX_PSD_LAYERS = 500;
export const MIN_GOLDEN_SSIM = 0.99;

export const MockupRenderManifestSchema = z.object({
  compilerVersion: z.literal(MOCKUP_COMPILER_VERSION),
  slotKey: z.string().trim().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
  canvas: z.object({ width: z.int().positive(), height: z.int().positive() }).strict(),
  transform: z.array(z.number().finite()).length(8),
  source: z.object({ byteSize: z.int().positive(), layerCount: z.int().min(3).max(MAX_PSD_LAYERS) }).strict(),
  files: z.object({
    background: z.literal("background.png"),
    foreground: z.literal("foreground.png"),
    mask: z.literal("mask.png").optional(),
    preview: z.literal("preview.png"),
  }).strict(),
}).strict();

export type MockupRenderManifest = z.infer<typeof MockupRenderManifestSchema>;

export class MockupTemplatePolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MockupTemplatePolicyError";
  }
}

export function assertPsdHeader(bytes: Uint8Array) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PSD_BYTES) {
    throw new MockupTemplatePolicyError("PSD_SIZE_INVALID", `PSD source must contain 1-${MAX_PSD_BYTES} bytes`);
  }
  if (bytes.byteLength < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== "8BPS") {
    throw new MockupTemplatePolicyError("PSD_SIGNATURE_INVALID", "Template source is not a Photoshop document");
  }
  const version = (bytes[4] << 8) | bytes[5];
  if (version !== 1) throw new MockupTemplatePolicyError("PSB_UNSUPPORTED", "Only PSD v1 files are supported; convert PSB before import");
}
