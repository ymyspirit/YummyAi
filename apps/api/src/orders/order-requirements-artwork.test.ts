import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CustomizationSchema } from "@yummyai/contracts";
import { ArtworkLayoutSchema } from "@yummyai/contracts/catalog/artwork";
import { orderRequirementDraftInput } from "@yummyai/contracts/order/requirement-interpretation";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { interpretOrderRequirements } from "@yummyai/order-intake";
import { assertAutomaticArtwork } from "../../../../packages/order-design/src/order-artwork-layout.js";

describe("legacy order styles remain production constraints after requirement interpretation", () => {
  it("retains unverified manual font and color and still rejects automatic substitution", () => {
    const customization = CustomizationSchema.parse({ version: 1, fields: [
      { key: "name", label: "Name", type: "short_text", required: true },
    ] });
    const layout = ArtworkLayoutSchema.parse([
      { fieldKey: "name", xPercent: 10, yPercent: 10, widthPercent: 80, heightPercent: 20 },
    ]);
    const draft = OrderWorkDraftSchema.parse({
      printProfileVersionId: null, images: [], instructions: "", customerApprovalRequired: false, dueAt: null,
      fields: [{ key: "name", label: "Name", kind: "text", value: "Synthetic Alice", font: "Synthetic Customer Font", color: "#2468ac" }],
    });
    const original = structuredClone(draft);
    const result = interpretOrderRequirements({ sources: [], draft, basis: {
      orderLineId: "019f0000-0000-7000-8000-000000000001", revision: 1, projectionVersion: 1,
      sourceVersionId: null, artworkVersionId: null, specificationVersionId: null,
      printProfileVersionId: null, templateVersionId: null,
      draftChecksum: createHash("sha256").update(orderRequirementDraftInput(draft)).digest("hex"),
    } });
    expect(draft).toEqual(original);
    expect(result.normalizedDraft.fields[0]).toMatchObject({ font: "Synthetic Customer Font", color: "#2468ac" });
    expect(result.normalizedDraft.fields[0]?.styleOverride).toBeUndefined();
    expect(result.interpretation.texts[0]).toMatchObject({
      font: { requested: null, sourceFieldKey: null }, color: { hex: null, sourceFieldKey: null },
    });
    expect(result.interpretation.unresolved.some(issue => issue.code === "legacy_group_missing")).toBe(true);
    expect(() => assertAutomaticArtwork(customization, layout, result.normalizedDraft)).toThrow("指定字体或颜色需美工核对");
  });
});
