import { describe, expect, it } from "vitest";
import { createEntityId } from "../index.js";
import { ProductionManufacturingSelectionSchema, ProductionProductConfirmationSchema, ProductionManufacturingPinSchema } from "./production-manufacturing.js";

describe("explicit manufacturing selection and immutable production lineage", () => {
  it("requires the operator to confirm the finished-SKU quantity basis without inventing a conversion", () => {
    const versionId = createEntityId();
    expect(ProductionManufacturingSelectionSchema.safeParse({ versionId }).success).toBe(false);
    expect(ProductionManufacturingSelectionSchema.safeParse({ versionId, orderUnitConfirmed: false }).success).toBe(false);
    expect(ProductionManufacturingSelectionSchema.parse({ versionId, orderUnitConfirmed: true })).toEqual({ versionId, orderUnitConfirmed: true });
    expect(ProductionManufacturingSelectionSchema.safeParse({ versionId, orderUnitConfirmed: true, conversion: 2 }).success).toBe(false);
  });
  it("requires an explicit specification and reason for a new product assignment", () => {
    const specificationVersionId = createEntityId();
    expect(ProductionProductConfirmationSchema.safeParse({ specificationVersionId, note: " " }).success).toBe(false);
    expect(ProductionProductConfirmationSchema.parse({ specificationVersionId, note: " Synthetic explicit product assignment " }))
      .toEqual({ specificationVersionId, note: "Synthetic explicit product assignment" });
    expect(ProductionProductConfirmationSchema.safeParse({ specificationVersionId, note: "Synthetic", tenantId: createEntityId() }).success).toBe(false);
  });
  it("keeps quantity, approval and source identifiers explicit and omits private confirmation notes", () => {
    const id = () => createEntityId();
    const pin = { id: id(), bindingVersion: 1, productionOrderId: id(), productionVersionId: id(), recipeId: id(), versionId: id(), reviewId: id(), versionNumber: 1,
      code: "BOM", name: "Synthetic final SKU", spuId: id(), skuId: null, specificationId: id(), specificationVersionId: id(), processProfileVersionId: id(), canvasPrintSpecVersionId: null,
      source: "approved_product_confirmation", workRevisionId: null, originalBindingId: null, quantity: 3, unit: "set", quantityBasis: "ordered_sku_units",
      contentChecksum: "a".repeat(64), createdAt: "2026-10-19T00:00:00.000Z" };
    expect(ProductionManufacturingPinSchema.safeParse(pin).success).toBe(true);
    expect(ProductionManufacturingPinSchema.safeParse({ ...pin, quantity: 0 }).success).toBe(false);
    expect(ProductionManufacturingPinSchema.safeParse({ ...pin, source: "order_work_revision" }).success).toBe(false);
    expect(ProductionManufacturingPinSchema.safeParse({ ...pin, encryptedConfirmationNote: "private" }).success).toBe(false);
  });
});
