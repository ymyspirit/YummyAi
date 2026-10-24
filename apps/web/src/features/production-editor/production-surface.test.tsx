import type { ProductionEditorImageLayer } from "@yummyai/contracts/pod/production-editor";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createProductionDocument } from "./production-editor-model";
import { PillowSheetPreview } from "./pillow-sheet-preview";
import { pillowSurfaceLayers, productionCanvasDocument } from "./production-surface";

const image = (id: string, surface?: "front" | "back"): ProductionEditorImageLayer => ({ id, kind: "image", name: id, assetId: id, assetVersion: 1, widthMm: 100, heightMm: 80, xMm: 40, yMm: 50, rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false, ...(surface ? { surface } : {}) });
function pillow() {
  const document = createProductionDocument("shaped_pillow");
  if (document.productType !== "shaped_pillow") throw new Error("Expected pillow fixture");
  return document;
}

describe("pillow surface editing and sheet preview", () => {
  it("keeps distinct prints on their own faces without mirroring the explicit back image", () => {
    const document = pillow();
    document.spec.sideMode = "double"; document.layers = [image("front-art", "front"), image("back-art", "back")];
    const html = renderToStaticMarkup(<PillowSheetPreview document={document} projectId="project" />);
    const [front, back] = html.split('data-preview-surface="back"');
    expect(front).toContain('data-layer-id="front-art"'); expect(front).not.toContain('data-layer-id="back-art"');
    expect(back).toContain('data-layer-id="back-art"'); expect(back).not.toContain('data-layer-id="front-art"');
    expect(back).toContain('data-layer-id="back-art"><g');
    expect(html).toContain("背面 · 独立印花");
  });

  it("retains mirrored legacy artwork on the back and leaves a single-sided back blank", () => {
    const document = pillow();
    document.spec.sideMode = "double"; document.layers = [image("legacy-art")];
    const html = renderToStaticMarkup(<PillowSheetPreview document={document} projectId="project" />);
    expect(html.match(/data-layer-id="legacy-art"/g)).toHaveLength(2);
    expect(html.split('data-preview-surface="back"')[1]).toContain(`data-layer-id="legacy-art" transform="translate(${document.spec.widthMm} 0) scale(-1 1)"`);
    document.spec.sideMode = "single";
    expect(renderToStaticMarkup(<PillowSheetPreview document={document} projectId="project" />).split('data-preview-surface="back"')[1]).not.toContain("data-layer-id");
  });

  it("mirrors only the editing outline and barcode tab while preserving the original document", () => {
    const document = pillow();
    document.layers = [image("front-art", "front"), image("back-art", "back"), image("legacy-art")];
    document.spec.barcodeTab.centerXMm = 70;
    const original = structuredClone(document);
    const front = productionCanvasDocument(document, "front"), back = productionCanvasDocument(document, "back");
    expect(front.layers.map(layer => layer.id)).toEqual(["front-art", "legacy-art"]);
    expect(back.layers.map(layer => layer.id)).toEqual(["back-art"]);
    if (back.productType !== "shaped_pillow") throw new Error("Expected pillow editing view");
    expect(back.contour).toEqual(original.contour.map(point => ({ ...point, xMm: original.spec.widthMm - point.xMm })).reverse());
    expect(back.spec.barcodeTab.centerXMm).toBe(document.spec.widthMm - 70);
    expect(document).toEqual(original);
    expect(pillowSurfaceLayers(document.layers, "back").map(layer => layer.id)).toEqual(["back-art", "legacy-art"]);
  });
});
