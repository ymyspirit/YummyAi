import { SHAPED_PILLOW_FACTORY_STANDARD, type ProductionEditorDocument, type ShapedPillowDocument } from "@yummyai/contracts/pod/production-editor";
import type { OrderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
export { orderProductionRequirements, type OrderProductionRequirements } from "@yummyai/contracts/order/production-requirements";

/** An explicit current factory pin defines the size basis; legacy pins keep theirs. */
export function pinnedPillowSizeBasis(spec: { factoryStandardId?: string; sizeBasis: ShapedPillowDocument["spec"]["sizeBasis"] }) {
  return spec.factoryStandardId === SHAPED_PILLOW_FACTORY_STANDARD.id ? "artwork" : spec.sizeBasis;
}

export function applyOrderProductionRequirements(document: ProductionEditorDocument, requirements: OrderProductionRequirements): ProductionEditorDocument {
  if (document.productType !== "shaped_pillow") return document;
  return { ...document, spec: { ...document.spec,
    ...(requirements.sizeInches && !requirements.warnings.length ? { declaredLongestMm: requirements.sizeInches * 25.4, sizeBasis: pinnedPillowSizeBasis(document.spec) } : {}),
    ...(requirements.sideMode ? { sideMode: requirements.sideMode } : {}),
  }, confirmations: { ...document.confirmations, physicalSize: false, backText: false, visualReview: false } };
}
