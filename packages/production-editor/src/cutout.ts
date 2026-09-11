import sharp from "sharp";
import { ProductionCutoutRecipeSchema, type ProductionCutoutRecipe } from "@yummyai/contracts/pod/production-cutout";
import { cutoutMaskSvg } from "./cutout-svg.js";

export async function renderProductionCutout(original: Uint8Array, input: ProductionCutoutRecipe) {
  const recipe = await validateMask(input);
  const { data, info } = await sharp(original, { limitInputPixels: 40_000_000 }).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = await renderMask(recipe, info.width, info.height).raw().toBuffer();
  let visible = false;
  for (let i = 0; i < mask.length; i++) { data[i * 4 + 3] = Math.round(data[i * 4 + 3]! * mask[i]! / 255); if (data[i * 4 + 3]! > 16) visible = true; }
  if (!visible) throw new Error("empty_cutout");
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Both inputs share EXIF-oriented coordinates. Lossless pixels avoid JPEG damage to fine hair. */
export async function prepareProductionMatting(original: Uint8Array, input: ProductionCutoutRecipe) {
  const recipe = await validateMask(input);
  const { data: image, info } = await sharp(original, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).toColourspace("srgb").flatten({ background: "white" }).png().toBuffer({ resolveWithObject: true });
  if (Math.min(info.width, info.height) < 2) throw new Error("invalid_matting_dimensions");
  const rawMask = await renderMask(recipe, info.width, info.height).raw().toBuffer();
  if (!rawMask.some((value) => value >= 250) || !rawMask.some((value) => value <= 5)) throw new Error("matting_requires_selection");
  const mask = await sharp(rawMask, { raw: { width: info.width, height: info.height, channels: 1 } }).png().toBuffer();
  return { image, mask, width: info.width, height: info.height };
}

function renderMask(recipe: ProductionCutoutRecipe, width: number, height: number) {
  return sharp(Buffer.from(cutoutMaskSvg(recipe, width, height)), { limitInputPixels: 40_000_000 }).flatten({ background: "black" }).greyscale();
}

async function validateMask(input: ProductionCutoutRecipe) {
  const recipe = ProductionCutoutRecipeSchema.parse(input);
  if (recipe.maskPngBase64) {
    const bytes = Buffer.from(recipe.maskPngBase64, "base64");
    if (bytes.toString("base64") !== recipe.maskPngBase64 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("invalid_cutout_mask");
    const info = await sharp(bytes, { limitInputPixels: 2048 * 2048 }).metadata();
    if (info.format !== "png" || !info.width || !info.height || info.width > 2048 || info.height > 2048 || (info.pages ?? 1) !== 1) throw new Error("invalid_cutout_mask");
  }
  return recipe;
}
