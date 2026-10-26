import { describe, expect, it } from "vitest";
import type { CustomizationDefinition } from "@yummyai/contracts";
import type { SpecificationView } from "@yummyai/contracts/catalog/development";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { resolveOrderPillowIntakeControls } from "./order-pillow-intake-controls.js";

const specification: Pick<SpecificationView, "code" | "attributes" | "spuCode" | "productType"> = {
  code: "SIZE-10IN", attributes: { Size: "10 inch" }, spuCode: "CUSTOM-SHAPED-PILLOW", productType: "shaped_pillow",
};
const customization: CustomizationDefinition = { version: 1, fields: [
  { key: "crop_scope", label: "Crop scope", type: "short_text", required: true },
] };
function draft(label = "Size", value = "10 inch-Mini Keepsake") {
  return OrderWorkDraftSchema.parse({ fields: [
    { key: "provider-size", label, kind: "choice", value },
    { key: "crop_scope", label: "Crop scope", kind: "text", value: "head" },
    { key: "provider-font", label: "Font", kind: "text", value: "Synthetic font request" },
  ], images: [{ origin: "report", key: "synthetic-original", usage: "buyer_photo" }],
  instructions: "Synthetic review note", customerApprovalRequired: false, dueAt: null, printProfileVersionId: null });
}

describe("photo-only pillow specification controls", () => {
  it.each(["Size", "Pillow Size", "Size (Most Popular)"])("routes one exact %s control without changing any original", label => {
    const input = draft(label), before = structuredClone(input), specBefore = structuredClone(specification), artBefore = structuredClone(customization);
    const result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.issues).toEqual([]);
    expect(result.routingFields).toEqual([input.fields[0]]);
    expect(result.productionDraft).toEqual({ ...input, fields: input.fields.slice(1) });
    expect(result.productionDraft.images).toEqual(input.images);
    expect(result.routingFields[0]).not.toBe(input.fields[0]);
    expect(input).toEqual(before);
    expect(specification).toEqual(specBefore);
    expect(customization).toEqual(artBefore);
  });

  it("keeps a different selected size visible with a specification action", () => {
    const input = draft("Size", "12 inches"), result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.routingFields).toEqual([]);
    expect(result.productionDraft).toEqual(input);
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_value", action: expect.stringContaining("核对本单规格") })]);
  });

  it.each(["10–24 inches", "10 inch or 12 inch", "", "unknown"])("does not hide an unresolved size %s", value => {
    const input = draft("Size", value), result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.routingFields).toEqual([]);
    expect(result.productionDraft).toEqual(input);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
  });

  it.each(["10 inches", "12 inches"])("refuses multiple size fields even when a second value is %s", value => {
    const input = draft();
    input.fields.push({ key: "second-size", label: "Pillow Size", kind: "choice", value });
    const result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.productionDraft).toEqual(input);
    expect(result.routingFields).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "duplicate_value" }));
  });

  it.each([
    { spuCode: "OTHER-SPU", productType: "shaped_pillow" as const },
    { spuCode: "custom-shaped-pillow", productType: "shaped_pillow" as const },
    { spuCode: "CUSTOM-SHAPED-PILLOW", productType: "tire_cover" as const },
    { spuCode: "CUSTOM-SHAPED-PILLOW", productType: null },
  ])("preserves fields outside the exact SPU/product gate $spuCode/$productType", gate => {
    const input = draft(), result = resolveOrderPillowIntakeControls(input, { ...specification, ...gate }, customization);
    expect(result).toEqual({ productionDraft: input, routingFields: [], issues: [] });
  });

  it.each([{ font: "Synthetic font" }, { color: "#000000" }])("keeps a size field with printable styling $font/$color", style => {
    const input = draft();
    Object.assign(input.fields[0]!, style);
    const result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.productionDraft).toEqual(input);
    expect(result.routingFields).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
  });

  it.each([
    { key: "printable-size", label: "Size" },
    { key: "size", label: "Printed label" },
    { key: "provider-size", label: "Other actual artwork field" },
  ])("does not hide a conflicting real artwork field $key/$label", target => {
    const definition: CustomizationDefinition = { version: 1, fields: [{ ...target, type: "short_text", required: true }] };
    const input = draft(), result = resolveOrderPillowIntakeControls(input, specification, definition);
    expect(result.productionDraft).toEqual(input);
    expect(result.routingFields).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "ambiguous_field" }));
  });

  it.each(["Font Size", "Size guide", "Pillow Size (guide)"])("does not classify the unrelated label %s", label => {
    const input = draft(label), result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result).toEqual({ productionDraft: input, routingFields: [], issues: [] });
  });

  it.each([
    { code: "10IN", attributes: { Size: "10 inch" } },
    { code: "SIZE-10IN", attributes: { Size: "12 inch" } },
    { code: "SIZE-10IN", attributes: { Size: "10–24 inches" } },
  ])("requires the original canonical specification identity $code/$attributes.Size", basis => {
    const input = draft(), result = resolveOrderPillowIntakeControls(input, { ...specification, ...basis }, customization);
    expect(result.productionDraft).toEqual(input);
    expect(result.routingFields).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
  });

  it("never treats an image marker as a numeric specification control", () => {
    const input = draft();
    input.fields[0]!.kind = "image";
    const before = structuredClone(input), result = resolveOrderPillowIntakeControls(input, specification, customization);
    expect(result.productionDraft).toEqual(before);
    expect(result.routingFields).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_value" }));
    expect(input).toEqual(before);
  });
});
