import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import type { ImageMagickRunner } from "./imagemagick.js";
import { NativeImageMagickRunner } from "./imagemagick.js";
import { MockupRenderManifestSchema, MockupTemplatePolicyError, type MockupRenderManifest } from "./policy.js";

export interface CompiledMockupBundle {
  manifest: MockupRenderManifest;
  background: Uint8Array;
  foreground: Uint8Array;
  mask?: Uint8Array;
  preview: Uint8Array;
}

export async function renderCompiledMockup(
  artwork: Uint8Array,
  rawBundle: CompiledMockupBundle,
  runner: ImageMagickRunner = new NativeImageMagickRunner(),
) {
  const bundle = { ...rawBundle, manifest: MockupRenderManifestSchema.parse(rawBundle.manifest) };
  const metadata = await sharp(Buffer.from(artwork)).metadata();
  if (!metadata.width || !metadata.height) throw new MockupTemplatePolicyError("ARTWORK_DIMENSIONS_MISSING", "Artwork dimensions are required");
  const taskDirectory = await mkdtemp(join(tmpdir(), "yummyai-mockup-"));
  const artworkPath = join(taskDirectory, "artwork.png");
  const warpedPath = join(taskDirectory, "warped.png");
  try {
    await writeFile(artworkPath, artwork);
    const [x0, y0, x1, y1, x2, y2, x3, y3] = bundle.manifest.transform;
    const controlPoints = [
      `0,0 ${x0},${y0}`,
      `${metadata.width},0 ${x1},${y1}`,
      `${metadata.width},${metadata.height} ${x2},${y2}`,
      `0,${metadata.height} ${x3},${y3}`,
    ].join("  ");
    await runner.run([
      artworkPath,
      "-alpha", "set",
      "-virtual-pixel", "transparent",
      "-distort", "Perspective", controlPoints,
      "-crop", `${bundle.manifest.canvas.width}x${bundle.manifest.canvas.height}+0+0`,
      "+repage",
      warpedPath,
    ], { cwd: taskDirectory });
    let warped = await readFile(warpedPath);
    if (bundle.mask) {
      warped = await sharp(warped).composite([{ input: Buffer.from(bundle.mask), blend: "dest-in" }]).png().toBuffer();
    }
    const output = await sharp(Buffer.from(bundle.background))
      .composite([{ input: warped, left: 0, top: 0 }, { input: Buffer.from(bundle.foreground), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const maxOutputBytes = positiveInteger(process.env.POD_MOCKUP_MAX_OUTPUT_BYTES, 50 * 1024 * 1024);
    if (output.byteLength > maxOutputBytes) {
      throw new MockupTemplatePolicyError("MOCKUP_OUTPUT_LIMIT_EXCEEDED", "Rendered mockup exceeds the configured output byte limit");
    }
    const outputMetadata = await sharp(output).metadata();
    if (outputMetadata.width !== bundle.manifest.canvas.width || outputMetadata.height !== bundle.manifest.canvas.height) {
      throw new MockupTemplatePolicyError("MOCKUP_CANVAS_MISMATCH", "Rendered mockup does not match the compiled canvas");
    }
    return { bytes: new Uint8Array(output), width: outputMetadata.width, height: outputMetadata.height };
  } finally {
    await rm(taskDirectory, { recursive: true, force: true });
  }
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD_MOCKUP_MAX_OUTPUT_BYTES must be a positive integer");
  return parsed;
}
