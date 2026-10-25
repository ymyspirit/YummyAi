import { describe, expect, it } from "vitest";
import { orderProductionRequirements, applyOrderProductionRequirements, pinnedPillowSizeBasis } from "./order-production-requirements";
import { createProductionDocument, invalidateProductionEdit } from "./production-editor-model";

function report(fields: Array<[string, string]>) { return { surfaces: [{ key: "front", label: "Front", previewFileKey: null, buyerFileKeys: [], fields: fields.map(([label, value], i) => ({ key: String(i), label, value, kind: "choice" as const })) }] }; }
describe("customer production requirements", () => {
  it("maps the selected head, size and side options while keeping original wording", () => {
    const value = orderProductionRequirements(report([["Printing Style", "Only Face"], ["Size 10 / 12 / 14 / 16", "10 inch-Very Small"], ["Style", "Single-sided Printing"]]));
    expect(value).toMatchObject({ sizeInches: 10, subject: "head", sideMode: "single", warnings: [] });
    expect(value.fields[1]?.value).toBe("10 inch-Very Small");
    const before = createProductionDocument("shaped_pillow");
    if (before.productType !== "shaped_pillow") throw new Error("wrong fixture");
    const after = applyOrderProductionRequirements(before, value);
    expect(after.spec).toMatchObject({ declaredLongestMm: 254, sideMode: "single", barcodeTab: before.spec.barcodeTab });
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
  it.each(["Half Body", "half_body", "half-body", "半身", "上半身"])("keeps the explicit half-body choice distinct in operator requirements: %s", crop => {
    const value = orderProductionRequirements(report([["Printing Style", crop], ["Size", "12 inch"], ["Style", "Double-sided Printing"]]));
    expect(value).toMatchObject({ subject: "half_body", sizeInches: 12, sideMode: "double", warnings: [] });
    expect(value.fields[0]?.value).toBe(crop);
    expect(orderProductionRequirements(report([["Customer text", crop]])).subject).toBeNull();
  });
  it("does not guess between half-body and whole-body choices", () => {
    const value = orderProductionRequirements(report([["Printing Style", "Half Body"], ["Printing Style", "Whole Body"]]));
    expect(value.subject).toBeNull();
    expect(value.warnings).toContain("多个定制选项存在冲突，请按当前商品确认。");
  });
  it("keeps conflicting choices unresolved and leaves tire specifications alone", () => {
    const value = orderProductionRequirements(report([["Size", "12 inch"], ["Size", "16 inch"], ["Style", "Single-sided Printing"], ["Style", "Double-sided Printing"]]));
    expect(value).toMatchObject({ sizeInches: null, sideMode: null });
    expect(value.warnings.length).toBeGreaterThan(0);
    const tire = createProductionDocument("tire_cover");
    expect(applyOrderProductionRequirements(tire, value)).toBe(tire);
  });
  it("uses the pinned current factory artwork basis for an explicit 16 inch order application without modifying its source", () => {
    const before = createProductionDocument("shaped_pillow");
    if (before.productType !== "shaped_pillow") throw new Error("wrong fixture");
    before.spec.sizeBasis = "finished";
    before.spec.declaredLongestMm = 254;
    before.confirmations = { physicalSize: true, whiteBorderRule: true, narrowParts: true, barcodeTab: true, backText: true, visualReview: true };
    const snapshot = structuredClone(before);
    const requirements = orderProductionRequirements(report([["Size", "16 inch"], ["Style", "Double-sided Printing"]]));
    const after = applyOrderProductionRequirements(before, requirements);
    expect(after.productType).toBe("shaped_pillow");
    if (after.productType !== "shaped_pillow") throw new Error("wrong result");
    expect(after.spec).toMatchObject({ factoryStandardId: "ps-pillow-2026-09-17", sizeBasis: "artwork", declaredLongestMm: 406.4, sideMode: "double" });
    expect(after.layers).toBe(before.layers);
    expect(after.contour).toBe(before.contour);
    expect(before).toEqual(snapshot);
    expect(Object.values(invalidateProductionEdit(before, after).confirmations).every(value => value === false)).toBe(true);
  });
  it.each(["unconfirmed", "artwork", "cut_contour", "finished"] as const)("preserves an existing legacy %s basis when applying a declared order size", basis => {
    const before = createProductionDocument("shaped_pillow");
    if (before.productType !== "shaped_pillow") throw new Error("wrong fixture");
    before.spec.factoryStandardId = undefined;
    before.spec.sizeBasis = basis;
    const snapshot = structuredClone(before);
    const after = applyOrderProductionRequirements(before, orderProductionRequirements(report([["Size", "16 inch"]])));
    if (after.productType !== "shaped_pillow") throw new Error("wrong result");
    expect(after.spec).toMatchObject({ declaredLongestMm: 406.4, sizeBasis: basis });
    expect(after.spec.factoryStandardId).toBeUndefined();
    expect(before).toEqual(snapshot);
  });
  it.each([undefined, "legacy-pillow-standard", "unrecognized-pillow-standard"])("does not treat an absent or unrecognized factory pin as the current standard: %s", factoryStandardId => {
    expect(pinnedPillowSizeBasis({ factoryStandardId, sizeBasis: "cut_contour" })).toBe("cut_contour");
    expect(pinnedPillowSizeBasis({ factoryStandardId, sizeBasis: "unconfirmed" })).toBe("unconfirmed");
  });
  it.each([
    { fields: [["Size", "Extra Large"]] },
    { fields: [["Size", "12 inch"], ["Size", "16 inch"]] },
    { fields: [["Size", "12 inch or 16 inch"]] },
  ] as Array<{ fields: Array<[string, string]> }>)("does not change a size or its basis for unknown or conflicting order size evidence: $fields", ({ fields }) => {
    const before = createProductionDocument("shaped_pillow");
    if (before.productType !== "shaped_pillow") throw new Error("wrong fixture");
    before.spec.declaredLongestMm = 254;
    before.spec.sizeBasis = "finished";
    const snapshot = structuredClone(before);
    const after = applyOrderProductionRequirements(before, orderProductionRequirements(report(fields)));
    expect(after.spec).toEqual(before.spec);
    expect(before).toEqual(snapshot);
  });
});
