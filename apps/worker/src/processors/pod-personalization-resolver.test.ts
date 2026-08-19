import { createEntityId, type TemplateSlot } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { InvalidTemplateSlotMappingError, resolveTemplateSlots } from "./pod-personalization-resolver.js";

describe("POD personalization slot resolver", () => {
  it("reuses one customer image for slots with the same reuse label", () => {
    const assetId = createEntityId();
    const result = resolveTemplateSlots({
      slots: [slot("portrait.front", "image", "pet-photo"), slot("portrait.back", "image", "pet-photo")],
      mapping: { slotFieldMap: { "portrait.front": "pet_image", "portrait.back": "pet_image" } },
      values: {},
      files: [{ fieldKey: "pet_image", ...assetSnapshot(assetId) }],
    });
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.kind === "image" && entry.assetId === assetId)).toBe(true);
  });

  it("keeps differently named slot groups independent", () => {
    expect(() => resolveTemplateSlots({
      slots: [slot("portrait.front", "image"), slot("portrait.back", "image")],
      mapping: { slotFieldMap: { "portrait.front": "pet_image", "portrait.back": "pet_image" } },
      values: {},
      files: [{ fieldKey: "pet_image", ...assetSnapshot(createEntityId()) }],
    })).toThrow(InvalidTemplateSlotMappingError);
  });

  it("never fills an unmapped replaceable text slot", () => {
    expect(() => resolveTemplateSlots({
      slots: [slot("customer.name", "text")],
      mapping: { slotFieldMap: {} },
      values: { customer_name: "Private value" },
      files: [],
    })).toThrow("is not mapped");
  });
});

function slot(stableKey: string, kind: TemplateSlot["kind"], reuseLabel?: string): TemplateSlot {
  return {
    id: createEntityId(),
    templateVersionId: createEntityId(),
    stableKey,
    name: stableKey,
    kind,
    geometry: { x: 0, y: 0, width: 100, height: 100, rotationDegrees: 0 },
    fillMode: kind === "text" ? "none" : "cover",
    validationSnapshot: { required: true },
    replaceable: true,
    ...(reuseLabel ? { reuseLabel } : {}),
  };
}

function assetSnapshot(assetId: string) {
  return {
    assetId,
    assetVersion: 1,
    checksumSha256: "a".repeat(64),
    mediaType: "image/png",
  };
}
