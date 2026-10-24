import type { ProductionEditorTextLayer } from "@yummyai/contracts/pod/production-editor";
import * as opentype from "opentype.js";

import { layoutArcGlyphs } from "@yummyai/production-editor/geometry";

export interface ProductionGlyphPath { path: string; xMm: number; yMm: number; rotationDeg: number }
export function parseProductionFont(bytes: Uint8Array | ArrayBuffer): opentype.Font {
  const array = bytes instanceof Uint8Array ? Uint8Array.from(bytes).buffer : bytes.slice(0);
  // The package's browser entry is ESM; Node resolves its CommonJS entry.
  // Resolve both without a static default import that Turbopack cannot bundle.
  const runtime = (Reflect.get(opentype, "default") ?? opentype) as typeof opentype;
  return runtime.parse(array);
}
export function inspectProductionFont(bytes: Uint8Array) {
  const font = parseProductionFont(bytes);
  const names = font.names as unknown as Record<string, unknown>;
  const pickName = (record: unknown): string | undefined => {
    if (!record || typeof record !== "object") return undefined;
    const group = record as Record<string, unknown>;
    for (const key of ["fontFamily", "fullName"]) {
      const localized = group[key];
      if (localized && typeof localized === "object") {
        const values = localized as Record<string, unknown>;
        const preferred = values.en ?? Object.values(values).find((value) => typeof value === "string");
        if (typeof preferred === "string") return preferred.slice(0, 160);
      }
    }
    return undefined;
  };
  return { family: pickName(names) ?? pickName(names.windows) ?? pickName(names.unicode) ?? pickName(names.macintosh) ?? "Uploaded font", glyphCount: font.numGlyphs };
}
export function productionTextMetrics(font: opentype.Font, layer: ProductionEditorTextLayer) {
  const glyphs = font.stringToGlyphs(layer.text);
  const scale = layer.fontSizeMm / font.unitsPerEm;
  const advances = glyphs.map((glyph, i) => ((glyph.advanceWidth ?? 0) + (i < glyphs.length - 1 ? font.getKerningValue(glyph, glyphs[i + 1]) : 0)) * scale + (i < glyphs.length - 1 ? layer.letterSpacingMm : 0));
  return { glyphs, advances };
}
/** Coordinates are local to layer x/y; both browser and production use these exact glyph outlines. */
export function buildProductionTextPaths(font: opentype.Font, layer: ProductionEditorTextLayer): ProductionGlyphPath[] {
  const { glyphs, advances } = productionTextMetrics(font, layer);
  if (layer.arc) {
    const layout = layoutArcGlyphs(advances, layer.arc);
    return glyphs.map((glyph, index) => {
      const placement = layout.glyphs[index];
      return { path: glyph.getPath(-placement.advanceMm / 2, 0, layer.fontSizeMm).toPathData(5), xMm: placement.xMm, yMm: placement.yMm, rotationDeg: placement.rotationDeg };
    });
  }
  let cursor = 0;
  return glyphs.map((glyph, index) => {
    const path = glyph.getPath(cursor, 0, layer.fontSizeMm).toPathData(5);
    cursor += advances[index];
    return { path, xMm: 0, yMm: 0, rotationDeg: 0 };
  });
}
export function mirrorProductionTextLayer(layer: ProductionEditorTextLayer, font: opentype.Font, bodyWidthMm: number): ProductionEditorTextLayer {
  const advance = productionTextMetrics(font, layer).advances.reduce((sum, item) => sum + item, 0);
  const radians = layer.rotationDeg * Math.PI / 180;
  return {
    ...layer,
    xMm: bodyWidthMm - layer.xMm - (layer.arc ? 0 : advance * Math.cos(radians)),
    yMm: layer.yMm + (layer.arc ? 0 : advance * Math.sin(radians)),
    rotationDeg: -layer.rotationDeg,
    arc: layer.arc ? { ...layer.arc, startAngleDeg: 180 - layer.arc.endAngleDeg, endAngleDeg: 180 - layer.arc.startAngleDeg } : null,
  };
}
