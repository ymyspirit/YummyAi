import { describe, expect, it } from "vitest";

import { amazonRules } from "./amazon.js";
import { validateListing } from "./validate.js";
import type { ListingDraft } from "./types.js";

describe("Amazon listing rules", () => {
  it("blocks export when the main image or required title is missing", () => {
    const result = validateListing(amazonRules, draft({ title: "", mainImageId: undefined }));
    expect(result.blockers.map((issue) => issue.path)).toEqual(expect.arrayContaining(["title", "mainImageId"]));
    expect(result.blockers.every((issue) => issue.ruleVersion === amazonRules.version)).toBe(true);
  });

  it("reports A+ as a warning and calculates required-field completeness", () => {
    const result = validateListing(amazonRules, draft({}));
    expect(result.completeness).toBe(100);
    expect(result.warnings).toContainEqual(expect.objectContaining({ path: "aPlusModules" }));
  });

  it("blocks title characters prohibited by current Amazon policy", () => {
    expect(validateListing(amazonRules, draft({ title: "Travel Mug!" })).blockers)
      .toContainEqual(expect.objectContaining({ code: "amazon.title.characters", path: "title" }));
  });
});

function draft(patch: Partial<ListingDraft>): ListingDraft {
  return { platform: "amazon", locale: "en-US", title: "Personalized travel mug", description: "Gift-ready mug", bullets: ["Laser engraved"], tags: [], mainImageId: "asset-1", mediaAssetIds: ["asset-1"], variants: [{ skuId: "sku-1", skuCode: "MUG-1", optionValues: {} }], attributes: { brand: "Yummy" }, compliance: { countryOfOrigin: "CN" }, ...patch };
}
