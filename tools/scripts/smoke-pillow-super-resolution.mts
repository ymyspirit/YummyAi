import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { inspectPillowSuperResolutionRuntime } from "../../packages/order-design/src/super-resolution-runtime.js";
import { LocalPillowSuperResolutionGateway } from "../../apps/worker/src/processors/pillow-super-resolution.js";

// Synthetic local-only input. No provider calls, business database access or buyer files.
const sharp = createRequire(new URL("../../apps/worker/package.json", import.meta.url))("sharp");
const capability = await inspectPillowSuperResolutionRuntime();
assert(capability.available && capability.upscale, capability.reason ?? "Runtime unavailable");
const directory = await mkdtemp(join(tmpdir(), "pillow-model-smoke-"));
try {
  const width = Number(process.argv[2] ?? 64), height = Number(process.argv[3] ?? 48);
  assert(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 2048 && height <= 2048);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 4;
    const radius = Math.hypot((x - width / 2) / (width * 0.33), (y - height / 2) / (height * 0.35));
    if (radius < 1) {
      rgba[index] = 100 + ((x * 19 + y * 7) % 140);
      rgba[index + 1] = 110 + ((x * 3 + y * 13) % 120);
      rgba[index + 2] = 90 + ((x * 5 + y * 11) % 150);
      rgba[index + 3] = radius > 0.85 ? 112 : 255;
    }
  }
  const bytes = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const originalDigest = createHash("sha256").update(bytes).digest("hex");
  const started = Date.now();
  const output = await new LocalPillowSuperResolutionGateway({ tempRoot: directory })
    .upscale({ bytes, policy: capability.upscale });
  const info = await sharp(output.bytes).metadata();
  assert.equal(info.width, width * 4); assert.equal(info.height, height * 4);
  assert.equal(info.hasAlpha, true); assert.equal(info.channels, 4);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), originalDigest);
  const sourceAlpha = await sharp(bytes).extractChannel("alpha").raw().toBuffer();
  const expectedAlpha = await sharp(sourceAlpha, { raw: { width, height, channels: 1 } })
    .resize(width * 4, height * 4, { kernel: "lanczos3", fit: "fill" }).toColourspace("b-w").raw().toBuffer();
  const alpha = await sharp(output.bytes).extractChannel("alpha").raw().toBuffer();
  assert(alpha.equals(expectedAlpha), "Alpha must match the pinned source-only resampling strategy");
  const interpolated = await sharp(bytes).resize(width * 4, height * 4, { kernel: "lanczos3" }).png().toBuffer();
  const modelRgb = await sharp(output.bytes).removeAlpha().raw().toBuffer();
  const interpolatedRgb = await sharp(interpolated).removeAlpha().raw().toBuffer();
  assert(!modelRgb.equals(interpolatedRgb), "Actual neural output must differ from ordinary interpolation");
  assert.deepEqual(await readdir(directory), []);
  process.stdout.write(`${JSON.stringify({ status: "passed", syntheticOnly: true, elapsedMs: Date.now() - started,
    alphaMatchesPinnedStrategy: true, sourceUnchanged: true, jobFilesCleaned: true, differsFromInterpolation: true,
    evidence: output.evidence }, null, 2)}\n`);
} finally {
  const target = resolve(directory), base = resolve(tmpdir());
  assert(target.startsWith(`${base}${sep}pillow-model-smoke-`), "Unexpected smoke cleanup target");
  await rm(target, { recursive: true, force: true });
}
