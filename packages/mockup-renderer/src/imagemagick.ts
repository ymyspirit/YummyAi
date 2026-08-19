import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { MockupTemplatePolicyError } from "./policy.js";

const execFileAsync = promisify(execFile);

export interface ImageMagickRunner {
  run(args: readonly string[], options?: { timeoutMs?: number; cwd?: string }): Promise<void>;
}

export class NativeImageMagickRunner implements ImageMagickRunner {
  constructor(
    private readonly executable = process.env.POD_MOCKUP_MAGICK_PATH?.trim() || "magick",
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

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD mockup renderer limits must be positive integers");
  return parsed;
}
