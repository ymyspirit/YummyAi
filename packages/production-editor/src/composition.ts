import type { PrintBinding } from "@yummyai/contracts/catalog/composition";
import type { ProductionEditorDocument, ProductionEditorImageLayer } from "@yummyai/contracts/pod/production-editor";

export function printCompositionLayer(document: ProductionEditorDocument, binding: PrintBinding, image: { id: string; version: number; width: number; height: number }, name: string): ProductionEditorImageLayer {
  if (binding.surface === "back" && (document.productType !== "shaped_pillow" || document.spec.sideMode !== "double")) throw new Error("反面印花需要供应商双面工艺模板");
  const width = document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.widthMm;
  const height = document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.heightMm;
  const boxWidth = width * binding.area.widthPercent / 100, boxHeight = height * binding.area.heightPercent / 100;
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  return { id: `print_${binding.key}`, name: name.slice(0, 160), kind: "image", surface: binding.surface,
    assetId: image.id, assetVersion: image.version, widthMm: image.width * scale, heightMm: image.height * scale,
    xMm: width * binding.area.xPercent / 100 + (boxWidth - image.width * scale) / 2,
    yMm: height * binding.area.yPercent / 100 + (boxHeight - image.height * scale) / 2,
    rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false };
}
