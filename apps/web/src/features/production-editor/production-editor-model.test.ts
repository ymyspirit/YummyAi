import { ProductionEditorDocumentSchema } from "@yummyai/contracts/pod/production-editor";
import { describe, expect, it } from "vitest";

import { createProductionDocument, invalidateProductionEdit, moveProductionLayer, newProductionText, resizedProductionBody } from "./production-editor-model";

describe("production editor draft model", () => {
  it("keeps the sample specifications unconfirmed and barcode dimensions empty", () => {
    const pillow = createProductionDocument("shaped_pillow");
    expect(ProductionEditorDocumentSchema.safeParse(pillow).success).toBe(true);
    if (pillow.productType !== "shaped_pillow") throw new Error("wrong fixture");
    expect(pillow.spec.whiteBorderMm * 150 / 25.4).toBeCloseTo(200);
    expect(pillow.spec.cutLineMm * 150 / 25.4).toBeCloseTo(6);
    expect(pillow.spec.barcodeTab.widthMm).toBeNull();
    expect(pillow.spec.sizeBasis).toBe("unconfirmed");
    expect(Object.values(pillow.confirmations).every((value) => !value)).toBe(true);
    const tire = createProductionDocument("tire_cover");
    expect(ProductionEditorDocumentSchema.safeParse(tire).success).toBe(true);
    expect(tire.confirmations.physicalSize).toBe(false);
  });

  it("resizes the contour with its body and requires physical-size review again", () => {
    const pillow = createProductionDocument("shaped_pillow");
    pillow.confirmations.physicalSize = true;
    const next = resizedProductionBody(pillow, 150, 200);
    expect(next.contour[2]).toMatchObject({ xMm: 150, yMm: 200 });
    expect(next.confirmations.physicalSize).toBe(false);
    expect(next.confirmations.visualReview).toBe(false);
  });

  it("keeps layer identity while reordering and invalidates final visual review", () => {
    const tire = createProductionDocument("tire_cover");
    const first = newProductionText(tire, false), second = newProductionText(tire, true);
    tire.layers = [first, second]; tire.confirmations.visualReview = true;
    const moved = moveProductionLayer(tire, first.id, 1);
    expect(moved.layers.map((layer) => layer.id)).toEqual([second.id, first.id]);
    expect(moved.confirmations.visualReview).toBe(false);
    expect(ProductionEditorDocumentSchema.safeParse(moved).success).toBe(true);
  });

  it("invalidates all factory confirmations when a contour or process parameter changes", () => {
    for (const kind of ["shaped_pillow", "tire_cover"] as const) {
      const previous = createProductionDocument(kind);
      for (const key of Object.keys(previous.confirmations) as Array<keyof typeof previous.confirmations>) previous.confirmations[key] = true;
      const resized = resizedProductionBody(previous, 250, 350);
      expect(Object.values(resized.confirmations).every((value) => !value)).toBe(true);
      if (previous.productType === "shaped_pillow") {
        const contour = previous.contour.map((point, index) => index ? point : { ...point, xMm: 10 });
        expect(Object.values(invalidateProductionEdit(previous, { ...previous, contour }).confirmations).every((value) => !value)).toBe(true);
      }
    }
  });

  it("requires a new back-text review after a text change without discarding factory dimensions", () => {
    const previous = createProductionDocument("shaped_pillow");
    previous.confirmations.physicalSize = true; previous.confirmations.backText = true; previous.confirmations.visualReview = true;
    const next = invalidateProductionEdit(previous, { ...previous, layers: [newProductionText(previous, false)] });
    expect(next.confirmations).toMatchObject({ physicalSize: true, backText: false, visualReview: false });
  });
});
