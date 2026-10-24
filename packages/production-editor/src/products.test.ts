import { ProductionEditorDocumentSchema, ProductionProductTypeSchema } from "@yummyai/contracts/pod/production-editor";
import { describe, expect, it } from "vitest";

import { getProductionBodySize, getProductionLayout, getProductionPrintableBounds } from "./geometry.js";
import { createDefaultProductionDocument, getProductionProductDefinition, PRODUCTION_PRODUCT_DEFINITIONS } from "./products.js";

describe("production product definitions", () => {
  it("covers every supported type with a valid unapproved document and stable implementation identity", () => {
    expect(PRODUCTION_PRODUCT_DEFINITIONS.map((definition) => definition.productType)).toEqual(ProductionProductTypeSchema.options);
    for (const type of ProductionProductTypeSchema.options) {
      const document = createDefaultProductionDocument(type);
      expect(ProductionEditorDocumentSchema.parse(document)).toEqual(document);
      expect(getProductionProductDefinition(type).implementationId).toBe(`${type}/v1`);
      expect(Object.values(document.confirmations).every((value) => !value)).toBe(true);
    }
  });

  it("keeps rectangle output dimensions independent of the safety guide", () => {
    const document = createDefaultProductionDocument("rectangular_print");
    if (document.productType !== "rectangular_print") throw new Error("fixture");
    document.spec = { widthMm: 101.6, heightMm: 50.8, dpi: 150, safeInsetMm: 5 };
    expect(getProductionBodySize(document)).toEqual({ width: 101.6, height: 50.8 });
    expect(getProductionLayout(document)).toMatchObject({ widthPx: 600, heightPx: 300, marginMm: 0, backOffsetMm: 0 });
    expect(getProductionPrintableBounds(document)).toEqual({ x: 5, y: 5, width: 91.6, height: 40.8 });
    expect(getProductionPrintableBounds(document, true)).toEqual({ x: 0, y: 0, width: 101.6, height: 50.8 });
    document.spec.safeInsetMm = 25.4;
    expect(() => getProductionPrintableBounds(document)).toThrow("可排版区域为空");
    expect(getProductionLayout(document)).toMatchObject({ widthPx: 600, heightPx: 300 });
  });
});
