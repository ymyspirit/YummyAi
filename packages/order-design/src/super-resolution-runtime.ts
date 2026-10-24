import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PillowRuntimeCapability, PillowUpscalePolicy } from "@yummyai/contracts/pod/design-automation";
import { OrderDesignError } from "./types.js";

/** Derived from the official Windows archive, verified before extraction. */
export const PILLOW_REALESRGAN_ARCHIVE_SHA256 = "abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d";
export const PILLOW_REALESRGAN_POLICY: Readonly<PillowUpscalePolicy> = Object.freeze({
  engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus",
  scale: 4, tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1",
  binarySha256: "07e49f7cbb4ede01ae4dd4c399d3a7e5846e3d2085c3128eff881e55cb7b1a0c",
  modelBinSha256: "713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf",
  modelParamSha256: "35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86",
});
export const PILLOW_REALESRGAN_FILES = Object.freeze([
  { name: "realesrgan-ncnn-vulkan.exe", sha256: PILLOW_REALESRGAN_POLICY.binarySha256 },
  { name: "models/realesrgan-x4plus.bin", sha256: PILLOW_REALESRGAN_POLICY.modelBinSha256 },
  { name: "models/realesrgan-x4plus.param", sha256: PILLOW_REALESRGAN_POLICY.modelParamSha256 },
  { name: "vcomp140.dll", sha256: "8f72ef2e483465444b2059fc6744d6cb22cd8d8a27f6fa56befd2a42dcd0f78b" },
  { name: "vcomp140d.dll", sha256: "34980f5a28002967d4f2659b10a417b1b9a242e240195947c89195083d146c53" },
]);

export type PillowSuperResolutionRuntime = { directory: string; policy: PillowUpscalePolicy };
export type PillowRuntimeOptions = { directory?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform };

export async function verifyPillowRuntimeFiles(directory: string): Promise<void> {
  for (const file of PILLOW_REALESRGAN_FILES) {
    const path = join(directory, file.name);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024 * 1024)
      throw new OrderDesignError("agent_upscale_runtime_integrity_failed");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path)) digest.update(chunk);
    if (digest.digest("hex") !== file.sha256) throw new OrderDesignError("agent_upscale_runtime_integrity_failed");
  }
}

/** Server-internal paths. Never return this object through an API response. */
export async function resolvePillowSuperResolutionRuntime(options: PillowRuntimeOptions = {}): Promise<PillowSuperResolutionRuntime> {
  const environment = options.environment ?? process.env;
  if ((options.platform ?? process.platform) !== "win32") throw new OrderDesignError("agent_upscale_platform_unsupported");
  const directory = options.directory ?? environment.PILLOW_REALESRGAN_DIR ??
    (environment.NODE_ENV !== "production" && environment.LOCALAPPDATA
      ? join(environment.LOCALAPPDATA, "YummyAI", "tools", "realesrgan-ncnn-vulkan-20220424") : undefined);
  if (!directory || !isAbsolute(directory)) throw new OrderDesignError("agent_upscale_runtime_unconfigured");
  try {
    const resolved = await realpath(directory);
    await verifyPillowRuntimeFiles(resolved);
    return { directory: resolved, policy: { ...PILLOW_REALESRGAN_POLICY } };
  } catch (error) {
    if (error instanceof OrderDesignError) throw error;
    throw new OrderDesignError("agent_upscale_runtime_unavailable");
  }
}

/** Read-only file-integrity capability; GPU execution is verified by the smoke command. */
export async function inspectPillowSuperResolutionRuntime(options: PillowRuntimeOptions = {}): Promise<PillowRuntimeCapability> {
  try {
    const runtime = await resolvePillowSuperResolutionRuntime(options);
    return { available: true, upscale: runtime.policy };
  } catch (error) {
    return { available: false, upscale: null,
      reason: error instanceof OrderDesignError ? error.code : "agent_upscale_runtime_unavailable" };
  }
}
