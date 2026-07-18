import { describe, expect, it } from "vitest";

import { etsyRules } from "./etsy.js";
import { validateListing } from "./validate.js";
import type { ListingDraft } from "./types.js";

describe("Etsy listing rules", () => {
  it("blocks export when tag count exceeds 13", () => {
    const result = validateListing(etsyRules, draft({ tags: Array.from({ length: 14 }, (_, index) => `tag-${index}`) }));
    expect(result.blockers).toContainEqual(expect.objectContaining({ path: "tags", ruleVersion: etsyRules.version }));
  });

  it("requires instructions for enabled personalization", () => {
    const result = validateListing(etsyRules, draft({ personalization: { enabled: true, instructions: "" } }));
    expect(result.blockers).toContainEqual(expect.objectContaining({ path: "personalization.instructions" }));
  });

  it("allows 20 photos and blocks the twenty-first", () => {
    expect(validateListing(etsyRules, draft({ mediaAssetIds: Array.from({ length: 20 }, (_, index) => `asset-${index}`) })).blockers)
      .not.toContainEqual(expect.objectContaining({ path: "mediaAssetIds" }));
    expect(validateListing(etsyRules, draft({ mediaAssetIds: Array.from({ length: 21 }, (_, index) => `asset-${index}`) })).blockers)
      .toContainEqual(expect.objectContaining({ path: "mediaAssetIds" }));
  });
});

function draft(patch: Partial<ListingDraft>): ListingDraft {
  return { platform: "etsy", locale: "en-US", title: "Personalized travel mug", description: "Gift-ready mug", bullets: [], tags: ["travel mug"], mainImageId: "asset-1", mediaAssetIds: ["asset-1"], variants: [{ skuId: "sku-1", skuCode: "MUG-1", optionValues: {} }], attributes: {}, compliance: {}, ...patch };
}
