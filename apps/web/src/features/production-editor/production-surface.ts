import type { ProductionEditorDocument, ProductionEditorLayer } from "@yummyai/contracts/pod/production-editor";

/** Legacy layers print on both faces; explicitly bound layers print on one face. */
export function pillowSurfaceLayers(layers: ProductionEditorLayer[], surface: "front" | "back") {
  return layers.filter(layer => layer.surface !== (surface === "front" ? "back" : "front"));
}

/** The editing view never changes the saved document or its manufacturing pins. */
export function productionCanvasDocument(document: ProductionEditorDocument, surface: "front" | "back" | "sheet"): ProductionEditorDocument {
  if (document.productType !== "shaped_pillow" || surface === "sheet") return document;
  if (surface === "front") return { ...document, layers: pillowSurfaceLayers(document.layers, "front") };
  // Legacy mirror layers remain editable on the front. The sheet shows their back placement.
  return { ...document, layers: document.layers.filter(layer => layer.surface === "back"),
    contour: document.contour.map(point => ({ ...point, xMm: document.spec.widthMm - point.xMm })).reverse(),
    spec: { ...document.spec, barcodeTab: { ...document.spec.barcodeTab, centerXMm: document.spec.widthMm - document.spec.barcodeTab.centerXMm } } };
}
