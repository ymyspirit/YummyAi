import { describe, expect, it } from "vitest";
import { CreateSupplyPurchaseInputSchema, SupplyTermsSchema } from "./product-supply.js";
import { createEntityId } from "../common/ids.js";

describe("supply terms validation", () => {
  const terms = { fulfillmentModes: ["custom_order"], unitCostMinor: 100, currency: "CNY", minimumOrderQuantity: 1, leadTimeDays: 0,
    validFrom: "2026-09-01T00:00:00.000Z", validUntil: null, status: "active", preference: "alternative", sampleStatus: "untested" };
  it("accepts an incomplete quotation before procurement and explicitly chosen fulfillment modes", () => {
    expect(SupplyTermsSchema.parse({ ...terms, unitCostMinor: null }).stockItemId).toBeNull();
    expect(SupplyTermsSchema.safeParse({ ...terms, fulfillmentModes: [] }).success).toBe(false);
  });
  it("rejects executable links, fractional prices, empty or inverted validity windows", () => {
    for (const override of [{ purchaseUrl: "javascript:alert(1)" }, { purchaseUrl: "file:///C:/private" }, { unitCostMinor: 0.5 },
      { minimumOrderQuantity: 0 }, { validUntil: "2026-08-01T00:00:00.000Z" }, { validUntil: terms.validFrom }, { validUntil: "2026-09-01T00:00:00Z" }]) {
      expect(SupplyTermsSchema.safeParse({ ...terms, ...override }).success).toBe(false);
    }
  });
  it("preserves explicit metric purchase units, decimal MOQ and price basis without changing old terms", () => {
    const parsed = SupplyTermsSchema.parse({ ...terms, minimumOrderQuantity: "0.125000000", purchaseUnit: "kilogram", priceBasisQuantity: "0.05" });
    expect(parsed).toMatchObject({ minimumOrderQuantity: "0.125", purchaseUnit: "kilogram", priceBasisQuantity: "0.05" });
    const old = SupplyTermsSchema.parse(terms);
    expect(old.minimumOrderQuantity).toBe(1);
    expect(old).not.toHaveProperty("purchaseUnit");
    expect(old).not.toHaveProperty("priceBasisQuantity");
  });
  it.each(["each", "pair", "set"] as const)("does not allow fractional %s MOQ or pricing basis", purchaseUnit => {
    expect(SupplyTermsSchema.safeParse({ ...terms, purchaseUnit, minimumOrderQuantity: "0.5" }).success).toBe(false);
    expect(SupplyTermsSchema.safeParse({ ...terms, purchaseUnit, priceBasisQuantity: "0.5" }).success).toBe(false);
    expect(SupplyTermsSchema.parse({ ...terms, purchaseUnit, minimumOrderQuantity: "2.000000000", priceBasisQuantity: 2 }))
      .toMatchObject({ minimumOrderQuantity: 2, priceBasisQuantity: 2 });
  });
  it("keeps a supply purchase quantity exact and leaves its unit and price to the pinned supply version", () => {
    const input = { purpose: "fba_replenishment", expectedVersion: 1, code: "SUPPLY-PRECISION",
      destinationLocationId: createEntityId(), quantity: "2147483646.000000001", expectedAt: "2026-10-21T00:00:00.000Z",
      idempotencyKey: "synthetic-supply-precision" };
    expect(CreateSupplyPurchaseInputSchema.parse(input).quantity).toBe("2147483646.000000001");
    expect(CreateSupplyPurchaseInputSchema.safeParse({ ...input, quantity: 0.25 }).success).toBe(false);
    expect(CreateSupplyPurchaseInputSchema.safeParse({ ...input, quantity: "0.0000000001" }).success).toBe(false);
    expect(CreateSupplyPurchaseInputSchema.safeParse({ ...input, purchaseUnit: "kilogram" }).success).toBe(false);
    expect(CreateSupplyPurchaseInputSchema.safeParse({ ...input, unitCostMinor: 1 }).success).toBe(false);
  });
});
