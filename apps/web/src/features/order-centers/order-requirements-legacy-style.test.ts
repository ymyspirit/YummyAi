import { expect, it } from "vitest";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { OrderRequirementSourceSchema } from "@yummyai/contracts/order/requirement-interpretation";
import { orderRequirementTextGroups, orderRequirementWithStyle } from "./order-requirements-model";

it("retains historical manual styles as unverified values and confirms only the explicitly edited attribute", () => {
  const source = OrderRequirementSourceSchema.parse({ sourceFieldKey: "manual-text", groupKey: "operator:manual-text", surfaceKey: "operator",
    origin: "operator", jsonPointer: "", role: "text", label: "Synthetic manual text", value: "Synthetic original name",
    requestedFont: null, colorLabel: null, colorHex: null, targetTextKey: null });
  const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: null, fields: [{ key: source.sourceFieldKey,
    label: source.label, kind: "text", value: source.value, font: "Synthetic legacy font", color: "#2468ac" }],
    images: [], instructions: "", customerApprovalRequired: false, dueAt: null });
  const original = structuredClone(draft);
  for (const origin of ["operator", "legacy_unresolved"] as const) {
    expect(orderRequirementTextGroups([{ ...source, origin }], draft)[0]).toMatchObject({ font: null, colorHex: null,
      legacyFont: "Synthetic legacy font", legacyColor: "#2468ac", needsPrinting: true });
  }
  expect(draft).toEqual(original);
  expect(draft.fields[0]!.styleOverride).toBeUndefined();
  const fontOnly = orderRequirementWithStyle(draft, source.sourceFieldKey, "Synthetic explicitly confirmed font", "");
  expect(orderRequirementTextGroups([source], fontOnly)[0]).toMatchObject({ font: "Synthetic explicitly confirmed font",
    legacyFont: null, colorHex: null, legacyColor: "#2468ac" });
  expect(fontOnly.fields[0]!.styleOverride).toEqual({ source: "operator", font: "Synthetic explicitly confirmed font" });
  const colorOnly = orderRequirementWithStyle(draft, source.sourceFieldKey, "", "#13579b");
  expect(orderRequirementTextGroups([source], colorOnly)[0]).toMatchObject({ font: null,
    legacyFont: "Synthetic legacy font", colorHex: "#13579b", legacyColor: null });
  expect(colorOnly.fields[0]!.styleOverride).toEqual({ source: "operator", colorHex: "#13579b" });
  const selector = { ...draft, fields: draft.fields.map(field => ({ ...field, color: "CustomColor" })) };
  expect(orderRequirementTextGroups([source], selector)[0]).toMatchObject({ colorHex: null, legacyColor: "CustomColor" });
  expect(draft).toEqual(original);
});
