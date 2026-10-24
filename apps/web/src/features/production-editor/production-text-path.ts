import type { ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import { buildProductionTextPaths } from "@yummyai/production-editor/text";
import type { TMat2D } from "fabric";
import type * as Fabric from "fabric";
import type { Font } from "opentype.js";

export function productionTextPath(font: Font, layer: ProductionEditorTextLayer, fabric: typeof Fabric): string {
  const util = fabric.util;
  return buildProductionTextPaths(font, layer).map((glyph) => {
    const radians = glyph.rotationDeg * Math.PI / 180;
    const matrix: TMat2D = [Math.cos(radians), Math.sin(radians), -Math.sin(radians), Math.cos(radians), glyph.xMm, glyph.yMm];
    return util.joinPath(util.transformPath(util.makePathSimpler(util.parsePath(glyph.path)), matrix, new fabric.Point(0, 0)));
  }).join(" ");
}
