import { describe, expect, it } from "vitest";
import { orderProductionRequirements, applyOrderProductionRequirements } from "./order-production-requirements";
import { createProductionDocument } from "./production-editor-model";

function report(fields: Array<[string, string]>) { return { surfaces: [{ key: "front", label: "Front", previewFileKey: null, buyerFileKeys: [], fields: fields.map(([label, value], i) => ({ key: String(i), label, value, kind: "choice" as const })) }] }; }
describe("customer production requirements", () => {
  it("maps the selected head, size and side options while keeping original wording", () => {
    const value = orderProductionRequirements(report([["Printing Style", "Only Face"], ["Size 10 / 12 / 14 / 16", "10 inch-Very Small"], ["Style", "Single-sided Printing"]]));
    expect(value).toMatchObject({ sizeInches: 10, subject: "head", sideMode: "single", warnings: [] });
    expect(value.fields[1]?.value).toBe("10 inch-Very Small");
    const before = createProductionDocument("shaped_pillow");
    const after = applyOrderProductionRequirements(before, value);
    expect(after.spec).toMatchObject({ declaredLongestMm: 254, sideMode: "single", barcodeTab: { widthMm: null, heightMm: null } });
    expect(after.contour).toEqual(before.contour);
    expect(after.layers).toEqual(before.layers);
    expect(Object.values(after.confirmations).some(Boolean)).toBe(false);
  });
  it("does not treat custom text or unknown options as a production instruction", () => {
    const value = orderProductionRequirements(report([["Text", "Only Face"], ["Name", "Double-sided Printing"], ["Size", "Extra Large"], ["Printing Style", "Custom special instructions"]]));
    expect(value).toMatchObject({ sizeInches: null, subject: null, sideMode: null });
    expect(value.warnings.length).toBeGreaterThan(0);
    expect(value.fields).toHaveLength(4);
  });
  it("keeps conflicting choices unresolved and leaves tire specifications alone", () => {
    const value = orderProductionRequirements(report([["Size", "12 inch"], ["Size", "16 inch"], ["Style", "Single-sided Printing"], ["Style", "Double-sided Printing"]]));
    expect(value).toMatchObject({ sizeInches: null, sideMode: null });
    expect(value.warnings.length).toBeGreaterThan(0);
    const tire = createProductionDocument("tire_cover");
    expect(applyOrderProductionRequirements(tire, value)).toBe(tire);
  });
});
