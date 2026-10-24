import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { SalesPlanFieldsSchema } from "./sales-plan.js";

describe("sales plan business modes", () => {
  it.each([
    ["custom", "fbm"],
    ["standard", "fba"],
    ["standard", "fbm"],
  ])("accepts %s with %s as an incomplete draft", (mode, fulfillment) => {
    const draft = SalesPlanFieldsSchema.parse({ name: "同一 SPU 的销售方向", mode, fulfillment });
    expect(draft.title).toBe("");
    expect(draft.mediaAssetIds).toEqual([]);
  });
  it("rejects Custom FBA and unsupported main-image or option-image bindings", () => {
    expect(
      SalesPlanFieldsSchema.safeParse({ name: "定制", mode: "custom", fulfillment: "fba" }).success,
    ).toBe(false);
    expect(
      SalesPlanFieldsSchema.safeParse({
        name: "标品",
        mode: "standard",
        fulfillment: "fba",
        mainImageId: createEntityId(),
      }).success,
    ).toBe(false);
    expect(
      SalesPlanFieldsSchema.safeParse({
        name: "定制",
        mode: "custom",
        fulfillment: "fbm",
        customMaterials: [{ label: "选项图", fieldKey: "missing", assetId: createEntityId() }],
      }).success,
    ).toBe(false);
  });
  it("requires evidence for manual Custom page verification", () => {
    expect(
      SalesPlanFieldsSchema.safeParse({
        name: "定制",
        mode: "custom",
        fulfillment: "fbm",
        customPage: { status: "verified", evidence: "" },
      }).success,
    ).toBe(false);
  });
});
