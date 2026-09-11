import { randomFillSync } from "node:crypto";
import type { ProductionEditorDocument, ProductionEditorImageLayer, ProductionEditorTextLayer, ShapedPillowDocument, TireCoverDocument } from "@yummyai/contracts/pod/production-editor";
import opentype from "opentype.js";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { buildPillowContour, getProductionLayout, layoutArcGlyphs, pillowBottomCenter } from "./geometry.js";
import { getBuiltinFont } from "./fonts.js";
import { preflightProductionDocument, ProductionEditorRenderError, renderProductionDocument, type ProductionEditorResolvers } from "./renderer.js";
import { buildProductionTextPaths, inspectProductionFont, mirrorProductionTextLayer, parseProductionFont, productionTextMetrics } from "./text.js";

const assetId = "019f7600-0000-7000-8000-000000000001";
const confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
function imageLayer(widthMm = 100): ProductionEditorImageLayer { return { id: "photo", kind: "image", name: "Photo", assetId, assetVersion: 1, xMm: 0, yMm: 0, widthMm, heightMm: widthMm, rotationDeg: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1 }; }
function cover(): TireCoverDocument { return { schemaVersion: 1, name: "Round cover", productType: "tire_cover", spec: { diameterMm: 100, dpi: 72, safeInsetMm: 5, opening: null }, contour: [], layers: [imageLayer()], confirmations: { ...confirmations } }; }
function pillow(): ShapedPillowDocument { return { schemaVersion: 1, name: "Pillow", productType: "shaped_pillow", spec: { widthMm: 80, heightMm: 80, dpi: 150, sideMode: "single", declaredLongestMm: 80, sizeBasis: "cut_contour", whiteBorderMm: 5, cutLineMm: 1.016, minimumNeckMm: 50, minimumNeckBasis: "cut_contour", panelGapMm: 10, barcodeTab: { widthMm: 20, heightMm: 10, centerXMm: 40 } }, contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 80, yMm: 0, smooth: false }, { xMm: 80, yMm: 80, smooth: false }, { xMm: 0, yMm: 80, smooth: false }], layers: [imageLayer(80)], confirmations: { ...confirmations } }; }
function textLayer(): ProductionEditorTextLayer { return { id: "title", kind: "text", name: "Title", text: "AB", fontId: "fixture", fontSizeMm: 10, letterSpacingMm: 0.4, color: "#ffffff", xMm: 50, yMm: 50, rotationDeg: 0, visible: true, locked: false, opacity: 1, arc: { radiusMm: 30, startAngleDeg: -160, endAngleDeg: -20 } }; }
let photo: Buffer, fontBytes: Uint8Array;
let resolvers: ProductionEditorResolvers;
beforeAll(async () => {
  const left = await sharp({ create: { width: 300, height: 600, channels: 4, background: "#ff0000" } }).png().toBuffer();
  photo = await sharp({ create: { width: 600, height: 600, channels: 4, background: "#0000ff" } }).composite([{ input: left, left: 0, top: 0 }]).png().toBuffer();
  const pathA = new opentype.Path(); pathA.moveTo(0, 0); pathA.lineTo(500, 0); pathA.lineTo(0, 700); pathA.close();
  const pathB = new opentype.Path(); pathB.moveTo(0, 0); pathB.lineTo(300, 0); pathB.lineTo(300, 700); pathB.lineTo(0, 700); pathB.close();
  fontBytes = new Uint8Array(new opentype.Font({ familyName: "Test face", styleName: "Regular", unitsPerEm: 1000, ascender: 800, descender: -200, glyphs: [new opentype.Glyph({ name: ".notdef", advanceWidth: 500, path: new opentype.Path() }), new opentype.Glyph({ name: "space", unicode: 32, advanceWidth: 300, path: new opentype.Path() }), new opentype.Glyph({ name: "A", unicode: 65, advanceWidth: 550, path: pathA }), new opentype.Glyph({ name: "B", unicode: 66, advanceWidth: 400, path: pathB })] }).toArrayBuffer());
  resolvers = { resolveAsset: async () => ({ bytes: photo }), resolveFont: async () => ({ bytes: fontBytes }) };
});
const options = { format: "png", background: "transparent", purpose: "production" } as const;
async function pixel(bytes: Buffer, x: number, y: number) { return [...await sharp(bytes).ensureAlpha().extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer()]; }
describe("deterministic production renderer", () => {
  it("renders large photographic PNGs without truncating embedded image data", async () => {
    const bytes = await sharp(randomFillSync(Buffer.alloc(2048 * 2048 * 3)), { raw: { width: 2048, height: 2048, channels: 3 } }).png().toBuffer();
    expect(bytes.byteLength).toBeGreaterThan(10 * 1024 * 1024);
    const largeResolvers = { ...resolvers, resolveAsset: async () => ({ bytes }) };
    for (const purpose of ["preview", "production"] as const) {
      const rendered = await renderProductionDocument(cover(), { ...options, purpose }, largeResolvers);
      expect((await sharp(rendered.bytes).metadata()).width).toBe(283);
      expect((await pixel(rendered.bytes, 141, 141))[3]).toBe(255);
      expect((await pixel(rendered.bytes, 0, 0))[3]).toBe(0);
    }
    const repeated = cover();
    repeated.layers = Array.from({ length: 9 }, (_, index) => ({ ...imageLayer(), id: `photo-${index}` }));
    await expect(renderProductionDocument(repeated, { ...options, purpose: "preview" }, largeResolvers)).rejects.toMatchObject({
      preflight: { productionReady: false, issues: expect.arrayContaining([expect.objectContaining({ code: "render_asset_limit" })]) },
    });
  }, 20_000);
  it("writes a true circular alpha mask, sRGB and physical density", async () => {
    const rendered = await renderProductionDocument(cover(), options, resolvers);
    const metadata = await sharp(rendered.bytes).metadata();
    expect([metadata.width, metadata.height, metadata.density]).toEqual([283, 283, 72]);
    expect(metadata.space).toBe("srgb");
    expect(metadata.icc?.length).toBeGreaterThan(0);
    expect((await pixel(rendered.bytes, 0, 0))[3]).toBe(0);
    expect((await pixel(rendered.bytes, 141, 141))[3]).toBe(255);
  });
  it("keeps optional openings transparent and rejects holes outside the cover", async () => {
    const document = cover(); document.spec.opening = { xMm: 50, yMm: 50, diameterMm: 10 };
    const rendered = await renderProductionDocument(document, options, resolvers);
    expect((await pixel(rendered.bytes, 141, 141))[3]).toBe(0);
    document.spec.opening.xMm = 0;
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).toContain("opening_outside_cover");
  });
  it("allows the supplied 670mm/300PPI class below the 100MP ceiling but blocks oversized production", async () => {
    const document = cover(); document.spec.diameterMm = 670; document.spec.dpi = 300;
    expect(getProductionLayout(document).widthPx).toBe(7913);
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).not.toContain("pixel_limit");
    document.spec.diameterMm = 2000;
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).toContain("pixel_limit");
  });
  it("requires production confirmation while allowing a visibly unapproved draft preview", async () => {
    const document = cover(); document.confirmations.physicalSize = false;
    await expect(renderProductionDocument(document, options, resolvers)).rejects.toBeInstanceOf(ProductionEditorRenderError);
    const preview = await renderProductionDocument(document, { ...options, purpose: "preview" }, resolvers);
    expect(preview.preflight.productionReady).toBe(false);
  });
  it("rejects JPEG transparency and produces explicit white JPEG plus density-tagged TIFF", async () => {
    await expect(renderProductionDocument(cover(), { ...options, format: "jpeg" }, resolvers)).rejects.toBeInstanceOf(ProductionEditorRenderError);
    const jpeg = await renderProductionDocument(cover(), { ...options, format: "jpeg", background: "white" }, resolvers);
    expect((await pixel(jpeg.bytes, 0, 0)).slice(0, 3)).toEqual([255, 255, 255]);
    const tiff = await renderProductionDocument(cover(), { ...options, format: "tiff" }, resolvers);
    expect((await sharp(tiff.bytes).metadata()).density).toBe(72);
    expect((await pixel(tiff.bytes, 0, 0))[3]).toBe(0);
  });
  it("generates a white mirrored single-side back and a barcode tab without an internal seam", async () => {
    const document = pillow(); const layout = getProductionLayout(document);
    const rendered = await renderProductionDocument(document, options, resolvers);
    const px = (mm: number) => Math.round(mm * 150 / 25.4);
    expect((await pixel(rendered.bytes, px(layout.marginMm + 2), px(layout.marginMm + 40))).slice(0, 3)).toEqual([255, 255, 255]);
    expect((await pixel(rendered.bytes, px(layout.marginMm + 20), px(layout.marginMm + 40))).slice(0, 3)).toEqual([255, 0, 0]);
    expect((await pixel(rendered.bytes, px(layout.marginMm + 40), px(layout.marginMm + 80))).slice(0, 3).every((channel) => channel >= 253)).toBe(true);
    expect((await pixel(rendered.bytes, px(layout.backOffsetMm + layout.marginMm + 20), px(layout.marginMm + 40))).slice(0, 3)).toEqual([255, 255, 255]);
  });
  it("mirrors double-side photographic content and preserves document layer order", async () => {
    const document = pillow(); document.spec.sideMode = "double";
    const layout = getProductionLayout(document), px = (mm: number) => Math.round(mm * 150 / 25.4);
    const rendered = await renderProductionDocument(document, options, resolvers);
    expect((await pixel(rendered.bytes, px(layout.backOffsetMm + layout.marginMm + 20), px(layout.marginMm + 40))).slice(0, 3)).toEqual([0, 0, 255]);
  });
  it("blocks missing barcode dimensions, unknown measurement rules and bad contour geometry", async () => {
    const document = pillow(); document.spec.barcodeTab.widthMm = null; document.spec.sizeBasis = "unconfirmed"; document.spec.minimumNeckBasis = "unconfirmed";
    const preflight = await preflightProductionDocument(document, options, resolvers);
    expect(preflight.productionReady).toBe(false);
    expect(preflight.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["barcode_dimensions_missing", "size_basis_unconfirmed", "narrow_parts_unconfirmed"]));
    document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 80, yMm: 80, smooth: false }, { xMm: 80, yMm: 0, smooth: false }, { xMm: 0, yMm: 80, smooth: false }];
    expect(buildPillowContour(document).issues).toContain("contour_self_intersection");
  });
  it("rejects asset resolver failures and SVG disguised as an uploaded picture", async () => {
    const broken = { ...resolvers, resolveAsset: async () => ({ bytes: Buffer.from('<svg><image href="http://internal"/></svg>') }) };
    const preflight = await preflightProductionDocument(cover(), options, broken);
    expect(preflight.issues.map((issue) => issue.code)).toContain("asset_unavailable");
  });
  it("blocks a barcode attached high on the side and accepts its lowest-body anchor", async () => {
    const document = pillow();
    document.contour = [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 80, yMm: 0, smooth: false }, { xMm: 80, yMm: 45, smooth: false }, { xMm: 50, yMm: 80, smooth: false }, { xMm: 30, yMm: 80, smooth: false }, { xMm: 0, yMm: 45, smooth: false }];
    document.spec.barcodeTab.centerXMm = 12;
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).toContain("barcode_not_at_bottom");
    await expect(renderProductionDocument(document, { ...options, purpose: "preview" }, resolvers)).rejects.toBeInstanceOf(ProductionEditorRenderError);
    document.spec.barcodeTab.centerXMm = pillowBottomCenter(document);
    expect(document.spec.barcodeTab.centerXMm).toBe(40);
    const output = await renderProductionDocument(document, options, resolvers);
    const layout = getProductionLayout(document), px = (mm: number) => Math.round(mm * 150 / 25.4);
    expect((await pixel(output.bytes, px(layout.marginMm + 40), px(layout.marginMm + 85))).slice(0, 3)).toEqual([255, 255, 255]);
    expect((await sharp(output.bytes).metadata()).density).toBe(150);
  });
  it("uses real image dimensions to reject insufficient resolution", async () => {
    const low = await sharp({ create: { width: 10, height: 10, channels: 4, background: "red" } }).png().toBuffer();
    const preflight = await preflightProductionDocument(cover(), options, { ...resolvers, resolveAsset: async () => ({ bytes: low }) });
    expect(preflight.issues.map((issue) => issue.code)).toContain("insufficient_image_resolution");
  });
  it("converts the same fixed font to deterministic shared arc paths and refuses missing glyphs", async () => {
    const document: ProductionEditorDocument = cover(); document.layers.push(textLayer());
    expect(inspectProductionFont(fontBytes).family).toBe("Test face");
    const font = parseProductionFont(fontBytes);
    const paths = buildProductionTextPaths(font, textLayer());
    expect(paths).toHaveLength(2);
    expect(paths[0].xMm).toBeLessThan(paths[1].xMm);
    const first = await renderProductionDocument(document, options, resolvers);
    const second = await renderProductionDocument(document, options, resolvers);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    (document.layers[1] as ProductionEditorTextLayer).text = "未知";
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).toContain("unsupported_glyph");
  });
  it("flags arc overflow without silently squeezing type", () => {
    expect(layoutArcGlyphs([20, 20, 20], { radiusMm: 10, startAngleDeg: -90, endAngleDeg: 0 }).overflow).toBe(true);
  });
  it("renders the actual 7913-pixel production size with true alpha and 300PPI", async () => {
    const document = cover(); document.spec.diameterMm = 670; document.spec.dpi = 300; document.layers = [imageLayer(670)];
    const large = await sharp({ create: { width: 7913, height: 7913, channels: 4, background: "#286c9f" } }).png().toBuffer();
    const output = await renderProductionDocument(document, options, { ...resolvers, resolveAsset: async () => ({ bytes: large }) });
    expect([output.widthPx, output.heightPx]).toEqual([7913, 7913]);
    const metadata = await sharp(output.bytes).metadata();
    expect([metadata.width, metadata.height, metadata.density]).toEqual([7913, 7913, 300]);
    expect((await pixel(output.bytes, 0, 0))[3]).toBe(0);
    expect((await pixel(output.bytes, 3956, 3956))[3]).toBe(255);
  }, 30_000);
  it("keeps the reflected baseline of rotated back text while leaving glyphs readable", () => {
    const layer = { ...textLayer(), arc: null, rotationDeg: 35, xMm: 20, yMm: 25 };
    const font = parseProductionFont(fontBytes);
    const width = productionTextMetrics(font, layer).advances.reduce((sum, advance) => sum + advance, 0);
    const back = mirrorProductionTextLayer(layer, font, 80);
    const radians = 35 * Math.PI / 180;
    // New readable baseline starts at the geometric reflection of the original endpoint.
    expect(back.xMm).toBeCloseTo(80 - 20 - width * Math.cos(radians), 8);
    expect(back.yMm).toBeCloseTo(25 + width * Math.sin(radians), 8);
    expect(back.rotationDeg).toBe(-35);
    expect(buildProductionTextPaths(font, back).map((glyph) => glyph.path)).toEqual(buildProductionTextPaths(font, layer).map((glyph) => glyph.path));
  });
  it("measures the actual body contour rather than the page or the tab for a declared cut size", async () => {
    const document = pillow(); document.contour[1].xMm = 60; document.contour[2] = { xMm: 60, yMm: 60, smooth: false }; document.contour[3].yMm = 60;
    const preflight = await preflightProductionDocument(document, options, resolvers);
    expect(preflight.issues.map((issue) => issue.code)).toContain("cut_size_mismatch");
    document.spec.declaredLongestMm = 60;
    expect((await preflightProductionDocument(document, options, resolvers)).issues.map((issue) => issue.code)).not.toContain("cut_size_mismatch");
  });
  it("rejects unsafe geometry even for a draft preview", async () => {
    const document = pillow(); document.contour[0].xMm = -9999;
    await expect(renderProductionDocument(document, { ...options, purpose: "preview" }, resolvers)).rejects.toBeInstanceOf(ProductionEditorRenderError);
  });
  it("loads the bundled fixed font without depending on system fonts or cwd", async () => {
    const fixed = await getBuiltinFont("geist_regular");
    const inspection = inspectProductionFont(fixed.bytes);
    expect(inspection.family).toMatch(/Geist/i);
    expect(inspection.glyphCount).toBeGreaterThan(100);
    expect(buildProductionTextPaths(parseProductionFont(fixed.bytes), { ...textLayer(), fontId: "geist_regular" })).toHaveLength(2);
    await expect(getBuiltinFont("C:/Windows/Fonts/arial.ttf")).rejects.toThrow("unknown_builtin_font");
  });
  it("uses the same local top-left image rotation anchor as the editing canvas", async () => {
    const document = cover();
    document.layers = [{ ...imageLayer(20), xMm: 60, yMm: 30, widthMm: 20, heightMm: 10, rotationDeg: 90 }];
    const result = await renderProductionDocument(document, options, resolvers);
    const px = (mm: number) => Math.round(mm * 72 / 25.4);
    // A 90-degree turn occupies x50..60/y30..50, rather than rotating about its centre.
    expect((await pixel(result.bytes, px(55), px(35)))[3]).toBe(255);
    expect((await pixel(result.bytes, px(70), px(35)))[3]).toBe(0);
  });
});
