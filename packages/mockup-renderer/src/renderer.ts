import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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
  const source = sharp(Buffer.from(artwork), { limitInputPixels: 64_000_000, failOn: "error" });
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) throw new MockupTemplatePolicyError("ARTWORK_DIMENSIONS_MISSING", "Artwork dimensions are required");
  if ((metadata.pages ?? 1) !== 1) throw new MockupTemplatePolicyError("ARTWORK_MULTIPAGE_UNSUPPORTED", "Mockup artwork must be one fixed image");
  const taskRoot = await realpath(tmpdir());
  const taskDirectory = await mkdtemp(join(taskRoot, "yummyai-mockup-"));
  const artworkPath = join(taskDirectory, "artwork.png");
  const warpedPath = join(taskDirectory, "warped.png");
  try {
    // The external renderer receives an actual PNG rather than relying on a filename to select its decoder.
    await writeFile(artworkPath, await source.png().toBuffer());
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
    await removeTemporaryRender(taskRoot, taskDirectory);
  }
}

async function removeTemporaryRender(taskRoot: string, taskDirectory: string) {
  const target = resolve(taskDirectory);
  if (dirname(target) !== resolve(taskRoot) || !basename(target).startsWith("yummyai-mockup-") || (await lstat(target)).isSymbolicLink())
    throw new MockupTemplatePolicyError("MOCKUP_CLEANUP_PATH_INVALID", "Temporary render cleanup escaped its original directory");
  await rm(target, { recursive: true, force: true });
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD_MOCKUP_MAX_OUTPUT_BYTES must be a positive integer");
  return parsed;
}
