import { createHash } from "node:crypto";
import type { ProductionEditorDocument, ProductionEditorImageLayer, ShapedPillowDocument, TireCoverDocument } from "@yummyai/contracts/pod/production-editor";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { getBuiltinFont } from "./fonts.js";
import { getProductionLayout } from "./geometry.js";
import { renderProductionDocument } from "./renderer.js";

const approved = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
const photo: ProductionEditorImageLayer = { id: "photo", kind: "image", name: "Synthetic photo", assetId: "019f7600-0000-7000-8000-000000000001", assetVersion: 1, xMm: 0, yMm: 0, widthMm: 80, heightMm: 80, rotationDeg: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1 };
function pillow(): ShapedPillowDocument {
  return { schemaVersion: 1, name: "Legacy pillow", productType: "shaped_pillow", spec: { widthMm: 80, heightMm: 80, dpi: 150, sideMode: "single", declaredLongestMm: 80, sizeBasis: "cut_contour", whiteBorderMm: 5, cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 40 } }, contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 80, yMm: 0, smooth: false }, { xMm: 80, yMm: 80, smooth: false }, { xMm: 0, yMm: 80, smooth: false }], layers: [{ ...photo }], confirmations: { ...approved } };
}
function cover(): TireCoverDocument {
  return { schemaVersion: 1, name: "Legacy tire cover", productType: "tire_cover", spec: { diameterMm: 80, dpi: 150, safeInsetMm: 5, opening: null }, contour: [], layers: [{ ...photo }], confirmations: { ...approved } };
}
const cases: Array<{ name: string; document: ProductionEditorDocument; background?: "white" }> = [];
cases.push({ name: "pillow omitted clip and margin", document: pillow() });
const double = pillow(); double.spec.sideMode = "double";
double.layers.push({ id: "text", kind: "text", name: "Readable back text", text: "AB12", fontId: "geist_regular", fontSizeMm: 8, letterSpacingMm: 0, color: "#ffffff", xMm: 18, yMm: 32, rotationDeg: 12, visible: true, locked: false, opacity: 1, arc: null });
cases.push({ name: "pillow double side with fixed font", document: double });
const intact = pillow(); intact.spec.artworkClipMode = "none"; intact.spec.sideMode = "double";
cases.push({ name: "pillow intact artwork", document: intact });
const margin = pillow(); margin.spec.sheetMarginMm = 50 * 25.4 / 150; margin.spec.panelGapMm = 100 * 25.4 / 150;
cases.push({ name: "pillow explicit clear margins", document: margin, background: "white" });
cases.push({ name: "tire alpha circle", document: cover() });
const opening = cover(); opening.spec.opening = { xMm: 40, yMm: 40, diameterMm: 12 };
cases.push({ name: "tire circular opening", document: opening });

// Captured before introducing product adapters. Do not update these snapshots
// for a new product: changes here are changes to existing production output.
describe("V1 production pixel compatibility", () => {
  it.each(cases)("retains $name", async ({ document, background }) => {
    const original = structuredClone(document);
    const left = await sharp({ create: { width: 300, height: 600, channels: 4, background: "#ff0000" } }).png().toBuffer();
    const bytes = await sharp({ create: { width: 600, height: 600, channels: 4, background: "#0000ff" } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer();
    const result = await renderProductionDocument(document, { format: "png", background: background ?? "transparent", purpose: "production" }, { resolveAsset: async () => ({ bytes }), resolveFont: getBuiltinFont });
    const metadata = await sharp(result.bytes).metadata();
    const pixels = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    expect({ pixelSha256: createHash("sha256").update(pixels).digest("hex"), width: metadata.width, height: metadata.height, density: metadata.density, channels: metadata.channels, hasAlpha: metadata.hasAlpha, space: metadata.space, iccSha256: createHash("sha256").update(metadata.icc!).digest("hex"), layout: getProductionLayout(document), preflight: result.preflight }).toMatchSnapshot();
    expect(document).toEqual(original);
  });
});
