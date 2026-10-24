import { describe, expect, it } from "vitest";

import { createProductionDocument, invalidateProductionEdit, newProductionImage, newProductionText } from "./production-editor-model";
import { alignProductionLayer, alphaBounds, duplicateProductionLayer, fitArcFontSize, fitProductionImage, imageEffectiveDpi, imageSubjectBounds, nudgeProductionLayer, printableBounds, replaceProductionImage, resizeImageProportionally, rotateProductionLayer } from "./production-layout-tools";

const document = createProductionDocument("shaped_pillow");
const image = { ...newProductionImage(document, { id: "asset", name: "subject", width: 1000, height: 2000 }), xMm: 10, yMm: 20, widthMm: 100, heightMm: 200 };
const source = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
const center = (b: { x: number; y: number; width: number; height: number }) => [b.x + b.width / 2, b.y + b.height / 2];

describe("production layout geometry", () => {
  it("ignores transparent padding and reports an empty cutout instead of centering an invisible frame", () => {
    const pixels = new Uint8ClampedArray(10 * 10 * 4);
    for (let y = 1; y < 5; y++) for (let x = 2; x < 5; x++) pixels[(y * 10 + x) * 4 + 3] = 255;
    expect(alphaBounds(pixels, 10, 10)).toEqual(source);
    expect(() => alphaBounds(new Uint8ClampedArray(400), 10, 10)).toThrow("没有可见主体");
  });
  it("centers the visible subject after flip and rotation, not the full source frame", () => {
    expect(imageSubjectBounds(image, source)).toEqual({ x: 30, y: 40, width: 30, height: 80 });
    const layer = { ...image, flipX: true, rotationDeg: 90 };
    const before = imageSubjectBounds(layer, source);
    expect(before.x).toBeCloseTo(-90); expect(before.y).toBeCloseTo(70);
    expect(before.width).toBeCloseTo(80); expect(before.height).toBeCloseTo(30);
    const aligned = alignProductionLayer(layer, before, { x: 0, y: 0, width: 100, height: 100 }, "centerX");
    expect(center(imageSubjectBounds(aligned, source))[0]).toBeCloseTo(50);
    expect(aligned.assetId).toBe(image.assetId);
  });
  it("fits the visible subject proportionally and preserves its center when rotating", () => {
    const fitted = fitProductionImage(image, imageSubjectBounds(image, source), { x: 0, y: 0, width: 100, height: 100 });
    const bounds = imageSubjectBounds(fitted, source);
    expect(bounds.height).toBeCloseTo(100); expect(bounds.width).toBeCloseTo(37.5);
    expect(center(bounds)).toEqual([50, 50]); expect(fitted.widthMm / fitted.heightMm).toBe(0.5);
    const rotated = rotateProductionLayer(fitted, bounds, 90);
    expect(center(imageSubjectBounds(rotated, source))[0]).toBeCloseTo(50);
    expect(center(imageSubjectBounds(rotated, source))[1]).toBeCloseTo(50);
  });
  it("excludes the bottom barcode and respects white margins and tire safety inset", () => {
    if (document.productType !== "shaped_pillow") throw new Error("fixture");
    const bounds = printableBounds(document);
    expect(bounds.x).toBeCloseTo(200 * 25.4 / 150);
    expect(printableBounds({ ...document, spec: { ...document.spec, barcodeTab: { widthMm: 60, heightMm: 150, centerXMm: 150 } } })).toEqual(bounds);
    const tire = createProductionDocument("tire_cover");
    expect(printableBounds(tire)).toEqual({ x: 15, y: 15, width: 640, height: 640 });
    expect(printableBounds(tire, true)).toEqual({ x: 0, y: 0, width: 670, height: 670 });
  });
  it("keeps proportions within dimension limits and can explicitly unlock nonuniform sizing", () => {
    const resized = resizeImageProportionally(image, "widthMm", 4000, true);
    expect(resized.widthMm).toBe(2500); expect(resized.heightMm).toBe(5000);
    expect(resizeImageProportionally(image, "widthMm", 60, false).heightMm).toBe(200);
    expect(imageEffectiveDpi(image, { width: 1000, height: 2000 })).toBe(254);
  });
  it("replaces a rotated layer without distortion, losing its center or mutating its old source", () => {
    const before = { ...image, rotationDeg: 90, flipX: true, opacity: 0.7 };
    const replacement = replaceProductionImage(before, { id: "new-asset", version: 2, name: "new", width: 2000, height: 1000 });
    expect(replacement.widthMm / replacement.heightMm).toBe(2);
    expect(center(imageSubjectBounds(replacement, { x: 0, y: 0, width: 1, height: 1 }))).toEqual(center(imageSubjectBounds(before, { x: 0, y: 0, width: 1, height: 1 })));
    expect(replacement).toMatchObject({ id: image.id, assetId: "new-asset", assetVersion: 2, rotationDeg: 90, flipX: true, opacity: 0.7 });
    expect(before.assetId).toBe("asset");
  });
  it("copies editable text independently, limits layers and invalidates review without changing factory specs", () => {
    const text = newProductionText(document, true), original = { ...document, layers: [text], confirmations: { ...document.confirmations, visualReview: true, backText: true, physicalSize: true } };
    const copied = duplicateProductionLayer(original, text.id, "copy");
    expect(copied.layers).toHaveLength(2); expect(copied.layers[1]!.id).toBe("copy");
    const copy = copied.layers[1]!; if (copy.kind !== "text" || !copy.arc) throw new Error("fixture");
    copy.arc.radiusMm += 100; expect(text.arc!.radiusMm).not.toBe(copy.arc.radiusMm);
    const updated = invalidateProductionEdit(original, copied);
    expect(updated.spec).toEqual(original.spec);
    expect(updated.confirmations).toMatchObject({ visualReview: false, backText: false, physicalSize: true });
    const full = { ...document, layers: Array.from({ length: 100 }, (_, i) => ({ ...image, id: String(i) })) };
    expect(duplicateProductionLayer(full, "0", "copy")).toBe(full);
  });
  it("respects locked layers and clamps keyboard movement to supported coordinates", () => {
    const locked = { ...image, locked: true }, bounds = imageSubjectBounds(image, source);
    expect(alignProductionLayer(locked, bounds, bounds, "centerX")).toBe(locked);
    expect(rotateProductionLayer(locked, bounds, 90)).toBe(locked);
    expect(fitProductionImage(locked, bounds, bounds)).toBe(locked);
    expect(nudgeProductionLayer(locked, 1, 10)).toBe(locked);
    expect(nudgeProductionLayer({ ...image, xMm: 9999 }, 10, 0).xMm).toBe(10000);
  });
  it("fits arc text by scaling font and spacing together, with headroom and schema limits", () => {
    const text = { ...newProductionText(document, true), fontSizeMm: 10, letterSpacingMm: 1, arc: { radiusMm: 50, startAngleDeg: -150, endAngleDeg: -30 } };
    const fitted = fitArcFontSize(text, 200);
    expect(fitted.fontSizeMm).toBeLessThan(text.fontSizeMm);
    expect(200 * fitted.fontSizeMm / text.fontSizeMm).toBeCloseTo(50 * Math.PI * 2 / 3 * 0.94);
    expect(fitted.letterSpacingMm / fitted.fontSizeMm).toBeCloseTo(0.1);
    expect(fitted.arc).toEqual(text.arc);
  });
});
