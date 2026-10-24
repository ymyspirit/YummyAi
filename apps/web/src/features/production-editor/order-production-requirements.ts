import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import type { OrderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
export { orderProductionRequirements, type OrderProductionRequirements } from "@yummyai/contracts/order/production-requirements";
export function applyOrderProductionRequirements(document: ProductionEditorDocument, requirements: OrderProductionRequirements): ProductionEditorDocument {
  if (document.productType !== "shaped_pillow") return document;
  return { ...document, spec: { ...document.spec,
    ...(requirements.sizeInches && !requirements.warnings.length ? { declaredLongestMm: requirements.sizeInches * 25.4, sizeBasis: "finished" as const } : {}),
    ...(requirements.sideMode ? { sideMode: requirements.sideMode } : {}),
  }, confirmations: { ...document.confirmations, physicalSize: false, backText: false, visualReview: false } };
}
