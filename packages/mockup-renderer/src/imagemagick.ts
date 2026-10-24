import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { MockupTemplatePolicyError } from "./policy.js";

const execFileAsync = promisify(execFile);

export interface ImageMagickRunner {
  run(args: readonly string[], options?: { timeoutMs?: number; cwd?: string }): Promise<void>;
}

export class NativeImageMagickRunner implements ImageMagickRunner {
  constructor(
    private readonly executable = imageMagickExecutable(),
    private readonly defaultTimeoutMs = positiveInteger(process.env.POD_MOCKUP_RENDER_TIMEOUT_MS, 120_000),
  ) {}

  async run(args: readonly string[], options: { timeoutMs?: number; cwd?: string } = {}) {
    if (!args.length || args.some((argument) => argument.includes("\0"))) {
      throw new MockupTemplatePolicyError("MAGICK_ARGUMENT_INVALID", "ImageMagick requires non-empty, null-free arguments");
    }
    await execFileAsync(this.executable, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? this.defaultTimeoutMs,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        MAGICK_MEMORY_LIMIT: process.env.POD_MOCKUP_MAGICK_MEMORY_LIMIT || "512MiB",
        MAGICK_MAP_LIMIT: process.env.POD_MOCKUP_MAGICK_MAP_LIMIT || "1GiB",
        MAGICK_DISK_LIMIT: process.env.POD_MOCKUP_MAGICK_DISK_LIMIT || "2GiB",
        MAGICK_THREAD_LIMIT: process.env.POD_MOCKUP_MAGICK_THREAD_LIMIT || "2",
        MAGICK_FILE_LIMIT: process.env.POD_MOCKUP_MAGICK_FILE_LIMIT || "32",
        MAGICK_AREA_LIMIT: process.env.POD_MOCKUP_MAGICK_AREA_LIMIT || "100MP",
        MAGICK_WIDTH_LIMIT: process.env.POD_MOCKUP_MAGICK_WIDTH_LIMIT || "100KP",
        MAGICK_HEIGHT_LIMIT: process.env.POD_MOCKUP_MAGICK_HEIGHT_LIMIT || "100KP",
        MAGICK_TIME_LIMIT: process.env.POD_MOCKUP_MAGICK_TIME_LIMIT || String(Math.ceil((options.timeoutMs ?? this.defaultTimeoutMs) / 1_000)),
      },
    });
  }
}

/** Explicit server configuration wins; Windows may use the pinned project-local portable runtime. */
export function imageMagickExecutable() {
  const configured = process.env.POD_MOCKUP_MAGICK_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "win32" || process.arch !== "x64") return "magick";
  const root = new URL("../../../.artifacts/runtime-tools/imagemagick-7.1.2-34-q16-hdri-x64/", import.meta.url);
  const executable = fileURLToPath(new URL("magick.exe", root));
  if (!existsSync(executable)) return "magick";
  const lock = JSON.parse(readFileSync(new URL("../runtime-lock.json", import.meta.url), "utf8")) as { files?: Record<string, string> };
  if (!lock.files?.["magick.exe"]) throw new MockupTemplatePolicyError("MAGICK_RUNTIME_INTEGRITY", "Pinned ImageMagick runtime manifest is unavailable");
  for (const [name, checksum] of Object.entries(lock.files)) {
    if (name !== "magick.exe" && !name.endsWith(".xml") && !name.endsWith(".icc")) continue;
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(checksum)
      || createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex") !== checksum)
      throw new MockupTemplatePolicyError("MAGICK_RUNTIME_INTEGRITY", "Pinned ImageMagick runtime does not match its recorded files");
  }
  return executable;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD mockup renderer limits must be positive integers");
  return parsed;
}
