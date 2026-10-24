import { describe, expect, it } from "vitest";
import { AssistListingCopySchema } from "@yummyai/contracts/ai/assist";
import type { ListingDraft } from "@yummyai/platform-rules";
import { adoptListingCopy } from "./listing-adoption";

const image = "019f0000-0000-7000-8000-000000000001";
const foreign = "019f0000-0000-7000-8000-000000000002";
const copy = AssistListingCopySchema.parse({
  title: "Suggested title",
  description: "Suggested description",
  bullets: ["One"],
  tags: ["pet gift"],
  personalizationInstructions: "Enter a name",
  imageDescriptions: [
    {
      assetId: image,
      text: "A pet illustration",
      evidence: [{ sourceId: image, detail: "visible" }],
    },
    {
      assetId: foreign,
      text: "Foreign image",
      evidence: [{ sourceId: foreign, detail: "visible" }],
    },
  ],
  evidence: [{ sourceId: image, detail: "visible" }],
});
const draft = (): ListingDraft => ({
  platform: "etsy",
  locale: "en-US",
  title: "Operator title",
  description: "Operator description",
  bullets: [],
  tags: ["old tag"],
  mainImageId: image,
  mediaAssetIds: [image],
  mediaDescriptions: { [image]: "Operator alt" },
  variants: [{ skuId: "sku", skuCode: "SKU", optionValues: { size: "Large" } }],
  attributes: { brand: "Verified" },
  compliance: { origin: "CN" },
  personalization: { enabled: true, instructions: "Old", required: true, maxAllowedCharacters: 40 },
});
describe("SKU copy adoption", () => {
  it("changes only selected copy fields and retains product facts, image identities and customization controls", () => {
    const source = draft();
    const result = adoptListingCopy(source, copy, [
      "description",
      "personalizationInstructions",
      "imageDescriptions",
      "bullets",
    ]);
    expect(result.title).toBe("Operator title");
    expect(result.description).toBe(copy.description);
    expect(result.tags).toEqual(source.tags);
    expect(result.bullets).toEqual([]);
    expect(result.variants).toEqual(source.variants);
    expect(result.attributes).toEqual(source.attributes);
    expect(result.compliance).toEqual(source.compliance);
    expect(result.mainImageId).toBe(image);
    expect(result.mediaDescriptions).toEqual({ [image]: "A pet illustration" });
    expect(result.personalization).toEqual({
      ...source.personalization,
      instructions: copy.personalizationInstructions,
    });
    expect(source.mediaDescriptions?.[image]).toBe("Operator alt");
  });
  it("never enables a new customization capability or adds images", () => {
    const source = draft();
    delete source.personalization;
    const result = adoptListingCopy(source, copy, [
      "personalizationInstructions",
      "imageDescriptions",
    ]);
    expect(result.personalization).toBeUndefined();
    expect(result.mediaAssetIds).toEqual([image]);
    expect(result.mediaDescriptions).not.toHaveProperty(foreign);
  });
});
