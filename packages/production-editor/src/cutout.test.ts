import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";
import { renderProductionCutout, prepareProductionMatting } from "./cutout.js";

const empty: ProductionCutoutRecipe = { schemaVersion: 1, maskPngBase64: null, operations: [] };
const square = [{ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.25 }, { x: 0.75, y: 0.75 }, { x: 0.25, y: 0.75 }];
const picture = () => sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 37, g: 121, b: 209, alpha: 1 } } }).png().toBuffer();
async function pixel(bytes: Uint8Array, x: number, y: number) { return [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()]; }

describe("production cutout pixels", () => {
  it("cleans low-alpha residue without a binary cutoff or changing the original RGB", async () => {
    const maskPixels = Buffer.from([0, 20, 128, 255]);
    const mask = await sharp(maskPixels, { raw: { width: 4, height: 1, channels: 1 } }).png().toBuffer();
    const source = await sharp({ create: { width: 4, height: 1, channels: 4, background: { r: 37, g: 121, b: 209, alpha: 1 } } }).png().toBuffer();
    const output = await renderProductionCutout(source, { ...empty, maskPngBase64: mask.toString("base64"), operations: [{ kind: "clean-alpha", threshold: 0.1 }] });
    expect(await pixel(output, 0, 0)).toEqual([37, 121, 209, 0]);
    expect(await pixel(output, 1, 0)).toEqual([37, 121, 209, 0]);
    expect((await pixel(output, 2, 0))[3]).toBeCloseTo(114, 0);
    expect(await pixel(output, 3, 0)).toEqual([37, 121, 209, 255]);
  });
  it("retains fractional matting alpha and original colors after saving and a later restore stroke", async () => {
    const source = await picture();
    const mask = await sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
    const recipe = { ...empty, maskPngBase64: mask.toString("base64") };
    const output = await renderProductionCutout(source, recipe);
    expect(await pixel(output, 60, 40)).toEqual([37, 121, 209, 128]);
    const restored = await renderProductionCutout(source, { ...recipe, operations: [{ kind: "brush", mode: "restore", radius: 0.05, softness: 0, points: [{ x: 0.5, y: 0.5 }] }] });
    expect(await pixel(restored, 60, 40)).toEqual([37, 121, 209, 255]);
    expect(await pixel(restored, 10, 10)).toEqual([37, 121, 209, 128]);
  });
  it("prepares lossless EXIF-aligned matting input from the complete editing recipe", async () => {
    const source = await sharp(await picture()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const prepared = await prepareProductionMatting(source, { ...empty, operations: [{ kind: "polygon", mode: "keep", points: square }] });
    expect(prepared).toMatchObject({ width: 80, height: 120 });
    expect(await sharp(prepared.image).metadata()).toMatchObject({ width: 80, height: 120, format: "png" });
    const mask = await sharp(prepared.mask).greyscale().raw().toBuffer();
    expect(mask[60 * 80 + 40]).toBe(255); expect(mask[0]).toBe(0);
    await expect(prepareProductionMatting(source, empty)).rejects.toThrow("matting_requires_selection");
  });
  it("keeps original dimensions and RGB while lasso, erase and restore change alpha in order", async () => {
    const source = await picture();
    const recipe: ProductionCutoutRecipe = { ...empty, operations: [
      { kind: "polygon", mode: "keep", points: square },
      { kind: "brush", mode: "erase", radius: 0.15, softness: 0, points: [{ x: 0.5, y: 0.5 }] },
      { kind: "brush", mode: "restore", radius: 0.04, softness: 0, points: [{ x: 0.5, y: 0.5 }] },
      { kind: "brush", mode: "restore", radius: 0.04, softness: 0, points: [{ x: 0.1, y: 0.1 }] },
    ] };
    const result = await renderProductionCutout(source, recipe);
    expect(await sharp(result).metadata()).toMatchObject({ width: 120, height: 80, format: "png", hasAlpha: true });
    expect(await pixel(result, 60, 40)).toEqual([37, 121, 209, 255]);
    expect((await pixel(result, 66, 40))[3]).toBe(0);
    expect(await pixel(result, 12, 8)).toEqual([37, 121, 209, 255]);
    expect((await pixel(result, 0, 0))[3]).toBe(0);
    expect((await pixel(source, 0, 0))[3]).toBe(255);
  });
  it("scales the automatic mask to original pixels and preserves alpha already in the original", async () => {
    const source = await sharp({ create: { width: 120, height: 80, channels: 4, background: { r: 50, g: 80, b: 110, alpha: 0.5 } } }).png().toBuffer();
    const mask = await sharp({ create: { width: 12, height: 8, channels: 3, background: "black" } }).composite([{ input: Buffer.from('<svg width="6" height="8"><rect width="6" height="8" fill="white"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
    const output = await renderProductionCutout(source, { ...empty, maskPngBase64: mask.toString("base64") });
    expect((await pixel(output, 10, 40))[3]).toBe(128);
    expect((await pixel(output, 110, 40))[3]).toBe(0);
  });
  it("renders a soft brush click and horizontal stroke with nonempty filter bounds", async () => {
    const source = await picture();
    const result = await renderProductionCutout(source, { ...empty, operations: [
      { kind: "brush", mode: "erase", radius: 0.1, softness: 0.25, points: [{ x: 0.3, y: 0.5 }, { x: 0.3, y: 0.5 }] },
      { kind: "brush", mode: "erase", radius: 0.1, softness: 0.25, points: [{ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 }] },
    ] });
    expect((await pixel(result, 36, 40))[3]).toBe(0);
    expect((await pixel(result, 72, 40))[3]).toBe(0);
    expect((await pixel(result, 72, 10))[3]).toBe(255);
  });
  it("uses EXIF-oriented coordinates without reducing the original pixel count", async () => {
    const source = await sharp(await picture()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const output = await renderProductionCutout(source, { ...empty, operations: [{ kind: "polygon", mode: "keep", points: square }] });
    expect(await sharp(output).metadata()).toMatchObject({ width: 80, height: 120 });
    expect((await pixel(output, 40, 60))[3]).toBe(255);
    expect((await pixel(output, 2, 2))[3]).toBe(0);
  });
  it("rejects empty selections, foreign image payloads, and oversized masks", async () => {
    const source = await picture();
    await expect(renderProductionCutout(source, { ...empty, operations: [{ kind: "polygon", mode: "erase", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }] })).rejects.toThrow("empty_cutout");
    const jpeg = await sharp(source).jpeg().toBuffer();
    await expect(renderProductionCutout(source, { ...empty, maskPngBase64: jpeg.toString("base64") })).rejects.toThrow("invalid_cutout_mask");
    const large = await sharp({ create: { width: 2049, height: 1, channels: 3, background: "white" } }).png().toBuffer();
    await expect(renderProductionCutout(source, { ...empty, maskPngBase64: large.toString("base64") })).rejects.toThrow("invalid_cutout_mask");
  });
});
