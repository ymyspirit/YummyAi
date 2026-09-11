import { describe, expect, it } from "vitest";

import { ProductionEditorDocumentSchema } from "./production-editor.js";

const draft = {
  schemaVersion: 1, name: "Draft cover", productType: "tire_cover",
  spec: { diameterMm: 670, dpi: 300, safeInsetMm: 10, opening: null }, contour: [], layers: [],
  confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false },
};
describe("production editor document", () => {
  it("saves unconfirmed drafts without pretending their dimensions are approved", () => {
    const parsed = ProductionEditorDocumentSchema.parse(draft);
    expect(parsed.confirmations.physicalSize).toBe(false);
  });
  it("rejects arbitrary URLs, SVG, scripts and foreign product specifications", () => {
    expect(ProductionEditorDocumentSchema.safeParse({ ...draft, svg: "<script/>" }).success).toBe(false);
    expect(ProductionEditorDocumentSchema.safeParse({ ...draft, spec: { ...draft.spec, whiteBorderMm: 200 } }).success).toBe(false);
    expect(ProductionEditorDocumentSchema.safeParse({ ...draft, layers: [{ kind: "image", url: "https://example.test/image" }] }).success).toBe(false);
  });
  it("rejects reversed arc spans and duplicate layer identifiers", () => {
    const layer = { id: "title", name: "Title", kind: "text", text: "ABC", fontId: "geist_regular", fontSizeMm: 10, letterSpacingMm: 0, color: "#ffffff", xMm: 50, yMm: 50, rotationDeg: 0, opacity: 1, visible: true, arc: { radiusMm: 40, startAngleDeg: 10, endAngleDeg: -10 } };
    expect(ProductionEditorDocumentSchema.safeParse({ ...draft, layers: [layer] }).success).toBe(false);
    expect(ProductionEditorDocumentSchema.safeParse({ ...draft, layers: [{ ...layer, arc: null }, { ...layer, arc: null }] }).success).toBe(false);
  });
});
