import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument, type ProductionEditorExportOptions, type ProductionProductType, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";

export interface ProductionProductDefinition {
  readonly productType: ProductionProductType;
  readonly label: string;
  readonly shortLabel: string;
  readonly draftName: string;
  readonly canvasLabel: string;
  /** Fixed implementation identity; existing documents never resolve to latest. */
  readonly implementationId: `${ProductionProductType}/v1`;
  readonly capabilities: Readonly<{ contourEditing: boolean; mirroredBack: boolean; arcText: boolean; coverImage: boolean }>;
}

// Browser-safe metadata only: do not import the server renderer or package root.
const definitions = {
  shaped_pillow: { productType: "shaped_pillow", label: "异形抱枕", shortLabel: "抱枕", draftName: "异形抱枕生产稿", canvasLabel: "异形抱枕正面编辑画布", implementationId: "shaped_pillow/v1", capabilities: { contourEditing: true, mirroredBack: true, arcText: false, coverImage: false } },
  tire_cover: { productType: "tire_cover", label: "圆形胎罩", shortLabel: "胎罩", draftName: "圆形胎罩生产稿", canvasLabel: "圆形胎罩编辑画布", implementationId: "tire_cover/v1", capabilities: { contourEditing: false, mirroredBack: false, arcText: true, coverImage: true } },
  rectangular_print: { productType: "rectangular_print", label: "矩形平面打印", shortLabel: "矩形打印", draftName: "矩形打印生产稿", canvasLabel: "矩形平面打印编辑画布", implementationId: "rectangular_print/v1", capabilities: { contourEditing: false, mirroredBack: false, arcText: false, coverImage: true } },
} as const satisfies Record<ProductionProductType, ProductionProductDefinition>;

export function getProductionProductDefinition(type: ProductionProductType): ProductionProductDefinition {
  return definitions[type];
}
export const PRODUCTION_PRODUCT_DEFINITIONS: readonly ProductionProductDefinition[] = Object.values(definitions);

export function productionExportDefaults(document: ProductionEditorDocument): Pick<ProductionEditorExportOptions, "format" | "background"> {
  return document.productType === "shaped_pillow"
    ? { format: "jpeg", background: "white" }
    : { format: "png", background: document.exportBackground ?? "transparent" };
}

/** Explicit draft operation: keeps artwork and contour intact and revokes review. */
export function applyPillowFactoryStandard(document: ShapedPillowDocument): ShapedPillowDocument {
  const rule = SHAPED_PILLOW_FACTORY_STANDARD;
  const mm = (px: number) => px * 25.4 / rule.dpi;
  return { ...document, exportBackground: rule.background, spec: {
    ...document.spec, factoryStandardId: rule.id, dpi: rule.dpi, sizeBasis: "artwork",
    whiteBorderMm: mm(rule.whiteBorderPx), cutLineMm: mm(rule.cutLinePx),
    panelGapMm: mm(rule.panelGapPx), sheetMarginMm: mm(rule.sheetMarginPx),
    minimumNeckMm: rule.minimumNeckMm, minimumNeckBasis: "cut_contour", artworkClipMode: "none",
    barcodeTab: { ...document.spec.barcodeTab, widthMm: mm(rule.barcodeWidthPx), heightMm: mm(rule.barcodeHeightPx) },
  }, confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
}

/** Examples remain unapproved; callers must pin a real supplier specification. */
export function createDefaultProductionDocument(kind: ProductionProductType): ProductionEditorDocument {
  const common = { schemaVersion: 1 as const, name: getProductionProductDefinition(kind).draftName, exportBackground: kind === "shaped_pillow" ? "white" as const : "transparent" as const, layers: [], confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
  switch (kind) {
    case "shaped_pillow": return applyPillowFactoryStandard({
      ...common, productType: "shaped_pillow", spec: { widthMm: 300, heightMm: 400, dpi: 150, sideMode: "single", declaredLongestMm: null, sizeBasis: "unconfirmed", whiteBorderMm: 200 * 25.4 / 150, cutLineMm: 6 * 25.4 / 150, minimumNeckMm: 50, minimumNeckBasis: "unconfirmed", panelGapMm: 100 * 25.4 / 150, sheetMarginMm: 50 * 25.4 / 150, barcodeTab: { widthMm: null, heightMm: null, centerXMm: 150 } },
      contour: [{ xMm: 0, yMm: 0, smooth: false }, { xMm: 300, yMm: 0, smooth: false }, { xMm: 300, yMm: 400, smooth: false }, { xMm: 0, yMm: 400, smooth: false }],
    });
    case "tire_cover": return { ...common, productType: "tire_cover", spec: { diameterMm: 670, dpi: 300, safeInsetMm: 15, opening: null }, contour: [] };
    case "rectangular_print": return { ...common, productType: "rectangular_print", spec: { widthMm: 200, heightMm: 300, dpi: 150, safeInsetMm: 5 }, contour: [] };
  }
}
