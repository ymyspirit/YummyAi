import { describe, expect, it } from "vitest";
import { SupplyTermsSchema } from "./product-supply.js";

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
});
