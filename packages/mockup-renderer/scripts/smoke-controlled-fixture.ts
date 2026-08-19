import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

import { compileControlledPsd } from "../src/compiler.js";
import type { ImageMagickRunner } from "../src/imagemagick.js";
import { renderCompiledMockup } from "../src/renderer.js";

const execFileAsync = promisify(execFile);
const image = process.env.POD_MOCKUP_SMOKE_IMAGE || "dpokidov/imagemagick:7.1.1-47";

class DockerImageMagickRunner implements ImageMagickRunner {
  async run(args: readonly string[], options: { timeoutMs?: number; cwd?: string } = {}) {
    if (!options.cwd) throw new Error("Docker smoke runner requires the isolated task directory");
    const mapped = args.map((argument) => {
      if (!isAbsolute(argument)) return argument;
      const within = relative(options.cwd!, argument);
      if (within.startsWith("..") || isAbsolute(within)) throw new Error("ImageMagick argument escaped the isolated task directory");
      return `/work/${basename(argument)}`;
    });
    await execFileAsync("docker", [
      "run", "--rm", "--network", "none", "--cpus", "1", "--memory", "768m", "--pids-limit", "64",
      "-e", "MAGICK_MEMORY_LIMIT=512MiB", "-e", "MAGICK_MAP_LIMIT=512MiB", "-e", "MAGICK_DISK_LIMIT=1GiB",
      "-e", "MAGICK_THREAD_LIMIT=2", "-e", "MAGICK_FILE_LIMIT=32", "-e", "MAGICK_TIME_LIMIT=60",
      "-v", `${options.cwd}:/work`, "-w", "/work", image, ...mapped,
    ], { timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, "../fixtures/controlled-canvas.psd");
const runner = new DockerImageMagickRunner();
const compiled = await compileControlledPsd(new Uint8Array(await readFile(fixture)), "main", runner);
if (compiled.ssimPermille < 990) throw new Error(`Golden comparison failed: ${compiled.ssimPermille}`);

const artwork = new Uint8Array(await sharp({
  create: { width: 48, height: 32, channels: 4, background: { r: 26, g: 112, b: 148, alpha: 1 } },
}).png().toBuffer());
const rendered = await renderCompiledMockup(artwork, compiled, runner);
if (rendered.width !== 32 || rendered.height !== 32 || rendered.bytes.byteLength === 0) {
  throw new Error("Rendered smoke output has invalid dimensions or content");
}

process.stdout.write(JSON.stringify({
  fixture: basename(fixture),
  image,
  compilerVersion: compiled.manifest.compilerVersion,
  ssim: compiled.ssimPermille / 1_000,
  output: { width: rendered.width, height: rendered.height, bytes: rendered.bytes.byteLength },
}) + "\n");
