import { ProductionEditorDocumentSchema, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import { buildPillowContour, sampleClosedContour } from "@yummyai/production-editor/geometry";
import { describe, expect, it } from "vitest";
import { createProductionDocument, newProductionImage, scalePillowArtwork, PILLOW_SIZES_IN } from "./production-editor-model";
import { applyPillowOutline, pillowSubjectLongest, tracePillowOutline, type PillowAlphaMask } from "./pillow-outline";

function mask(width = 160, height = 180): PillowAlphaMask { return { width, height, alpha: new Uint8Array(width * height), mmPerPixel: 0.5, originX: -10, originY: -15 }; }
function rectangle(target: PillowAlphaMask, x: number, y: number, width: number, height: number) {
  for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) target.alpha[row * target.width + column] = 255;
}
describe("pillow outline preparation", () => {
  it("adds a physical sewing border around actual alpha, independent of transparent file padding", () => {
    const target = mask(); rectangle(target, 45, 40, 70, 100);
    expect(pillowSubjectLongest(target)).toBe(50);
    const points = tracePillowOutline(target, 8);
    expect(points.length).toBeGreaterThan(8); expect(points.length).toBeLessThanOrEqual(180);
    expect(points.every((point) => point.smooth)).toBe(true);
    const width = Math.max(...points.map((point) => point.xMm)) - Math.min(...points.map((point) => point.xMm));
    expect(width).toBeGreaterThanOrEqual(51); expect(width).toBeLessThanOrEqual(54);
    const document = applyPillowOutline(createProductionDocument("shaped_pillow") as ShapedPillowDocument, points);
    expect(buildPillowContour(document).issues).toEqual([]);
    expect(ProductionEditorDocumentSchema.safeParse(document).success).toBe(true);
  });
  it("fills interior alpha holes but refuses to silently drop another disconnected subject", () => {
    const target = mask(); rectangle(target, 40, 40, 80, 100);
    for (let y = 70; y < 100; y++) for (let x = 60; x < 90; x++) target.alpha[y * target.width + x] = 0;
    expect(tracePillowOutline(target, 4).length).toBeGreaterThan(3);
    const separated = mask(300, 200); rectangle(separated, 30, 40, 40, 60); rectangle(separated, 220, 40, 40, 60);
    expect(() => tracePillowOutline(separated, 4)).toThrow("多个分离");
    expect(() => tracePillowOutline(mask(), 4)).toThrow("没有可识别");
  });
  it("moves all layers together when changing the coordinate origin and anchors the tab at the lowest body", () => {
    const document = createProductionDocument("shaped_pillow") as ShapedPillowDocument;
    const layer = newProductionImage(document, { id: "019f7600-0000-7000-8000-000000000001", name: "cutout", width: 600, height: 900 });
    document.layers = [layer]; document.spec.barcodeTab = { widthMm: 20, heightMm: 10, centerXMm: 5 };
    const points = [{ xMm: 10, yMm: 20, smooth: false }, { xMm: 110, yMm: 20, smooth: false }, { xMm: 100, yMm: 150, smooth: false }, { xMm: 50, yMm: 150, smooth: false }, { xMm: 10, yMm: 90, smooth: false }];
    const next = applyPillowOutline(document, points);
    expect(next.layers[0]).toMatchObject({ assetId: layer.assetId, assetVersion: 1, xMm: layer.xMm - 10, yMm: layer.yMm - 20 });
    expect(next.spec.barcodeTab.centerXMm).toBe(65);
    expect(buildPillowContour(next).issues).toEqual([]);
    expect(Math.max(...buildPillowContour(next).points.map(([, y]) => y))).toBeGreaterThan(Math.max(...sampleClosedContour(next.contour).map(([, y]) => y)));
  });
  it("supports exactly the eight supplied order sizes without distorting source aspect ratio", () => {
    expect(PILLOW_SIZES_IN).toEqual([10, 12, 14, 16, 18, 20, 22, 24]);
    const document = createProductionDocument("shaped_pillow") as ShapedPillowDocument;
    const layer = newProductionImage(document, { id: "019f7600-0000-7000-8000-000000000001", name: "portrait", width: 600, height: 900 }); document.layers = [layer];
    for (const size of PILLOW_SIZES_IN) {
      const next = scalePillowArtwork(document, size * 25.4 / layer.heightMm);
      const scaled = next.layers[0]!; if (scaled.kind !== "image") throw new Error("fixture");
      expect(scaled.heightMm).toBeCloseTo(size * 25.4); expect(scaled.widthMm / scaled.heightMm).toBeCloseTo(2 / 3);
      expect(next.productType === "shaped_pillow" && next.spec.whiteBorderMm).toBe(document.spec.whiteBorderMm);
    }
  });
});
