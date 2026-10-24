import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { PillowUpscalePolicySchema } from "@yummyai/contracts/pod/design-automation";
import { OrderDesignError, PILLOW_REALESRGAN_ARCHIVE_SHA256, PILLOW_REALESRGAN_FILES,
  resolvePillowSuperResolutionRuntime, verifyPillowRuntimeFiles,
  type OrderDesignSuperResolutionGateway } from "@yummyai/order-design";
import sharp from "sharp";
import { runPillowUpscaleProcess, type PillowUpscaleProcessInput } from "./pillow-super-resolution-process.js";

const MAX_INPUT_PIXELS = 4_194_304;
const MAX_INPUT_DIMENSION = 2048;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_PIXELS = MAX_INPUT_PIXELS * 16;
// Shared across adapter instances in this worker. Bounded admission avoids a GPU/OOM pileup.
let running = false;
const waiting: Array<{ start: () => void; cancel: () => void }> = [];

function abort(signal?: AbortSignal) {
  if (signal?.aborted) throw new OrderDesignError("agent_upscale_cancelled");
}
async function acquire(signal?: AbortSignal): Promise<() => void> {
  abort(signal);
  const release = () => { const next = waiting.shift(); if (next) next.start(); else running = false; };
  if (!running) { running = true; return release; }
  if (waiting.length >= 8) throw new OrderDesignError("agent_upscale_busy");
  await new Promise<void>((resolveAdmission, reject) => {
    const entry = {
      start: () => { signal?.removeEventListener("abort", entry.cancel); resolveAdmission(); },
      cancel: () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        signal?.removeEventListener("abort", entry.cancel);
        reject(new OrderDesignError("agent_upscale_cancelled"));
      },
    };
    waiting.push(entry);
    signal?.addEventListener("abort", entry.cancel, { once: true });
    if (signal?.aborted) entry.cancel();
  });
  return release;
}
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function removePrivateDirectory(directory: string, root: string) {
  const target = resolve(directory), base = resolve(root);
  if (!target.startsWith(`${base}${sep}`) || !target.slice(base.length + 1).startsWith("yummyai-pillow-"))
    throw new OrderDesignError("agent_upscale_cleanup_invalid");
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    .catch(() => { throw new OrderDesignError("agent_upscale_cleanup_failed"); });
}

/** Only RGB under fully transparent pixels is filled. Alpha and visible RGB stay unchanged.
 * Manhattan-nearest propagation has stable row-major seeds and left/right/up/down ties.
 * This is color extension for neural inference, never segmentation or fur cleanup. */
export function extendTransparentRgb(rgba: Buffer, width: number, height: number) {
  const pixels = width * height;
  const rgb = Buffer.allocUnsafe(pixels * 3), alpha = Buffer.allocUnsafe(pixels);
  const visited = new Uint8Array(pixels), queue = new Int32Array(pixels);
  let read = 0, written = 0;
  for (let index = 0; index < pixels; index++) {
    alpha[index] = rgba[index * 4 + 3];
    rgba.copy(rgb, index * 3, index * 4, index * 4 + 3);
    if (alpha[index] > 0) { visited[index] = 1; queue[written++] = index; }
  }
  if (!written) throw new OrderDesignError("agent_upscale_alpha_empty");
  const visit = (to: number, from: number) => {
    if (visited[to]) return;
    visited[to] = 1; queue[written++] = to;
    rgb.copy(rgb, to * 3, from * 3, from * 3 + 3);
  };
  while (read < written) {
    const from = queue[read++], x = from % width;
    if (x > 0) visit(from - 1, from);
    if (x < width - 1) visit(from + 1, from);
    if (from >= width) visit(from - width, from);
    if (from + width < pixels) visit(from + width, from);
  }
  return { rgb, alpha };
}

export class LocalPillowSuperResolutionGateway implements OrderDesignSuperResolutionGateway {
  constructor(private readonly options: {
    runtimeDirectory?: string; tempRoot?: string; timeoutMs?: number;
    runProcess?: (input: PillowUpscaleProcessInput) => Promise<void>;
  } = {}) {}

  async validatePolicy(policy: Parameters<OrderDesignSuperResolutionGateway["validatePolicy"]>[0]) {
    const parsed = PillowUpscalePolicySchema.safeParse(policy);
    if (!parsed.success) throw new OrderDesignError("agent_upscale_policy_unsupported");
    const runtime = await resolvePillowSuperResolutionRuntime({ directory: this.options.runtimeDirectory });
    if (Object.entries(runtime.policy).some(([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value))
      throw new OrderDesignError("agent_upscale_runtime_changed");
  }

  async upscale(input: Parameters<OrderDesignSuperResolutionGateway["upscale"]>[0]) {
    const release = await acquire(input.signal);
    let directory: string | undefined;
    try {
      abort(input.signal);
      const parsed = PillowUpscalePolicySchema.safeParse(input.policy);
      if (!parsed.success) throw new OrderDesignError("agent_upscale_policy_unsupported");
      const runtime = await resolvePillowSuperResolutionRuntime({ directory: this.options.runtimeDirectory });
      if (Object.entries(runtime.policy).some(([key, value]) => parsed.data[key as keyof typeof parsed.data] !== value))
        throw new OrderDesignError("agent_upscale_runtime_changed");
      if (!input.bytes.length || input.bytes.length > MAX_BYTES) throw new OrderDesignError("agent_upscale_input_invalid");
      const metadata = await sharp(input.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" }).metadata();
      if (!metadata.width || !metadata.height || metadata.width > MAX_INPUT_DIMENSION || metadata.height > MAX_INPUT_DIMENSION
        || (metadata.pages ?? 1) !== 1 || metadata.format !== "png" || !metadata.hasAlpha
        || (metadata.orientation !== undefined && metadata.orientation !== 1))
        throw new OrderDesignError("agent_upscale_input_invalid");
      const source = await sharp(input.bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning" })
        .toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const { width, height } = source.info;
      const prepared = extendTransparentRgb(source.data, width, height);
      const outputWidth = width * 4, outputHeight = height * 4;
      abort(input.signal);
      const root = resolve(this.options.tempRoot ?? tmpdir());
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(root, "yummyai-pillow-"));
      await chmod(directory, 0o700);
      // Copy immutable, verified runtime files into the private job directory and rehash.
      for (const file of PILLOW_REALESRGAN_FILES) {
        const target = join(directory, file.name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await copyFile(join(runtime.directory, file.name), target);
      }
      await verifyPillowRuntimeFiles(directory);
      const sourcePath = join(directory, "source-rgb.png"), outputPath = join(directory, "output-rgb.png");
      const sourceRgb = await sharp(prepared.rgb, { raw: { width, height, channels: 3 } }).png().toBuffer();
      await writeFile(sourcePath, sourceRgb, { mode: 0o600, flag: "wx" });
      abort(input.signal);
      const timeoutMs = Math.min(300_000, Math.max(1, this.options.timeoutMs ?? 180_000));
      await (this.options.runProcess ?? runPillowUpscaleProcess)({
        executable: join(directory, "realesrgan-ncnn-vulkan.exe"), cwd: directory, signal: input.signal, timeoutMs,
        args: ["-i", sourcePath, "-o", outputPath, "-m", join(directory, "models"), "-n", parsed.data.model,
          "-s", "4", "-t", "256", "-j", "1:1:1", "-f", "png"],
      });
      abort(input.signal);
      const outputStat = await stat(outputPath);
      if (!outputStat.isFile() || outputStat.size < 1 || outputStat.size > MAX_BYTES) throw new OrderDesignError("agent_upscale_output_invalid");
      const inferred = await readFile(outputPath);
      const result = await sharp(inferred, { limitInputPixels: MAX_OUTPUT_PIXELS, failOn: "warning" }).metadata();
      if (result.format !== "png" || result.width !== outputWidth || result.height !== outputHeight || (result.pages ?? 1) !== 1)
        throw new OrderDesignError("agent_upscale_output_invalid");
      const alpha = await sharp(prepared.alpha, { raw: { width, height, channels: 1 } })
        .resize(outputWidth, outputHeight, { kernel: "lanczos3", fit: "fill" }).toColourspace("b-w").raw().toBuffer();
      // Finish removeAlpha in a separate pipeline: Sharp otherwise applies it after joinChannel.
      const inferredRgb = await sharp(inferred, { limitInputPixels: MAX_OUTPUT_PIXELS, failOn: "warning" })
        .toColourspace("srgb").removeAlpha().raw().toBuffer();
      const bytes = await sharp(inferredRgb, { raw: { width: outputWidth, height: outputHeight, channels: 3 } })
        .joinChannel(alpha, { raw: { width: outputWidth, height: outputHeight, channels: 1 } }).withIccProfile("srgb").png().toBuffer();
      if (bytes.length > MAX_BYTES) throw new OrderDesignError("agent_upscale_output_invalid");
      const finalInfo = await sharp(bytes, { limitInputPixels: MAX_OUTPUT_PIXELS, failOn: "warning" }).metadata();
      if (!finalInfo.hasAlpha || finalInfo.channels !== 4 || finalInfo.width !== outputWidth || finalInfo.height !== outputHeight)
        throw new OrderDesignError("agent_upscale_output_invalid");
      abort(input.signal);
      return { bytes, evidence: {
        engine: parsed.data.engine, release: parsed.data.release, model: parsed.data.model, policy: parsed.data,
        archiveSha256: PILLOW_REALESRGAN_ARCHIVE_SHA256,
        runtimeFiles: PILLOW_REALESRGAN_FILES.map(file => ({ name: file.name, sha256: file.sha256 })),
        input: { sha256: checksum(input.bytes), width, height, hasAlpha: true },
        output: { sha256: checksum(bytes), width: outputWidth, height: outputHeight, hasAlpha: true },
        rgbProcessing: "neural-model-inference", alphaStrategy: parsed.data.alphaStrategy,
        alphaKernel: "lanczos3", nativeDetailClaim: false,
      } };
    } catch (error) {
      if (error instanceof OrderDesignError) throw error;
      throw new OrderDesignError(input.signal?.aborted ? "agent_upscale_cancelled" : "agent_upscale_execution_failed");
    } finally {
      try {
        if (directory) await removePrivateDirectory(directory, this.options.tempRoot ?? tmpdir());
      } finally { release(); }
    }
  }
}
