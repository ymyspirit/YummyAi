import type { RectangularPrintDocument } from "@yummyai/contracts/pod/production-editor";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";

import { createDefaultProductionDocument } from "./products.js";
import { preflightProductionDocument, renderProductionDocument, type ProductionEditorResolvers } from "./renderer.js";

const options = { format: "png", background: "transparent", purpose: "production" } as const;
function document(): RectangularPrintDocument {
  const draft = createDefaultProductionDocument("rectangular_print") as RectangularPrintDocument;
  return { ...draft, spec: { widthMm: 101.6, heightMm: 50.8, dpi: 150, safeInsetMm: 5 }, layers: [{ id: "photo", kind: "image", name: "Synthetic photo", assetId: "019f7600-0000-7000-8000-000000000001", assetVersion: 1, xMm: 0, yMm: 0, widthMm: 101.6, heightMm: 50.8, rotationDeg: 0, flipX: false, flipY: false, visible: true, locked: false, opacity: 1 }], confirmations: { ...draft.confirmations, physicalSize: true, visualReview: true } };
}
let resolvers: ProductionEditorResolvers;
beforeAll(async () => {
  const bytes = await sharp({ create: { width: 600, height: 300, channels: 4, background: "#ff0000" } }).png().toBuffer();
  resolvers = { resolveAsset: async () => ({ bytes }), resolveFont: async () => { throw new Error("unused"); } };
});

describe("single rectangular print", () => {
  it("renders exact one-panel dimensions with no implicit bleed or mirrored back", async () => {
    const result = await renderProductionDocument(document(), options, resolvers);
    const metadata = await sharp(result.bytes).metadata();
    expect([metadata.width, metadata.height, metadata.density]).toEqual([600, 300, 150]);
    expect(result.preflight.productionReady).toBe(true);
    expect(metadata.icc?.length).toBeGreaterThan(0);
    const { data } = await sharp(result.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...data.subarray(data.length - 4)]).toEqual([255, 0, 0, 255]);
    const changed = document(); changed.spec.safeInsetMm = 10;
    expect((await renderProductionDocument(changed, options, resolvers)).bytes).toEqual(result.bytes);
  });

  it("preserves transparent output and supports an explicit white background", async () => {
    const draft = document(); draft.layers[0]!.xMm = 50.8;
    const transparent = await renderProductionDocument(draft, options, resolvers);
    const alpha = await sharp(transparent.bytes).ensureAlpha().raw().toBuffer();
    expect([...alpha.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    const white = await renderProductionDocument(draft, { ...options, background: "white" }, resolvers);
    const pixels = await sharp(white.bytes).ensureAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 4)]).toEqual([255, 255, 255, 255]);
    expect((await sharp(white.bytes).metadata()).hasAlpha).toBe(false);
  });

  it("requires review and actual resolution, and rejects an empty safety region", async () => {
    const draft = document(); draft.confirmations.visualReview = false;
    const preview = await renderProductionDocument(draft, { ...options, purpose: "preview" }, resolvers);
    expect(preview.preflight.productionReady).toBe(false);
    await expect(renderProductionDocument(draft, options, resolvers)).rejects.toMatchObject({ message: "production_preflight_failed" });
    draft.confirmations.visualReview = true; draft.spec.safeInsetMm = 25.4;
    expect((await preflightProductionDocument(draft, options, resolvers)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "safe_inset_too_large" })]));
    draft.spec.safeInsetMm = 5; draft.spec.dpi = 300;
    expect((await preflightProductionDocument(draft, options, resolvers)).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "insufficient_image_resolution" })]));
  });
});
