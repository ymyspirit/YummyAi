import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { compileControlledPsd } from "./compiler.js";
import type { ImageMagickRunner } from "./imagemagick.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/controlled-canvas.psd");

class IdentityPerspectiveRunner implements ImageMagickRunner {
  async run(args: readonly string[]) {
    await copyFile(args[0]!, args.at(-1)!);
  }
}

class GoldenMismatchRunner implements ImageMagickRunner {
  async run(args: readonly string[]) {
    await writeFile(args.at(-1)!, await sharp({ create: { width: 32, height: 32, channels: 4, background: "#000" } }).png().toBuffer());
  }
}

describe("controlled PSD compiler", () => {
  it("compiles the repository PSD fixture and verifies its saved composite", async () => {
    const result = await compileControlledPsd(new Uint8Array(await readFile(fixture)), "main", new IdentityPerspectiveRunner());
    expect(result.manifest.compilerVersion).toBe("controlled-psd-v1");
    expect(result.manifest.transform).toEqual([0, 0, 32, 0, 32, 32, 0, 32]);
    expect(result.ssimPermille).toBe(1_000);
  });

  it("rejects a slot whose controlled root group is missing", async () => {
    await expect(compileControlledPsd(new Uint8Array(await readFile(fixture)), "hero", new IdentityPerspectiveRunner()))
      .rejects.toMatchObject({ code: "PSD_ROOT_GROUPS_INVALID" });
  });

  it("blocks approval when the golden render differs from the saved PSD composite", async () => {
    await expect(compileControlledPsd(new Uint8Array(await readFile(fixture)), "main", new GoldenMismatchRunner()))
      .rejects.toMatchObject({ code: "PSD_GOLDEN_MISMATCH" });
  });
});
