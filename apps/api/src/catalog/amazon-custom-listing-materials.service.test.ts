import { describe, expect, it } from "vitest";

import { evaluateListingMaterials } from "./amazon-custom-listing-materials.service.js";

describe("Amazon Custom listing materials readiness", () => {
  it("blocks handoff until every listing material group is complete", () => {
    const readiness = evaluateListingMaterials(
      {
        plan: {
          id: "019fb700-0000-7000-8000-000000000001",
          customization: { version: 1, fields: [] },
        },
        skuRows: [],
        listingDraft: {
          platform: "amazon",
          locale: "en-US",
          title: "",
          description: "",
          bullets: [],
          tags: [],
          mediaAssetIds: [],
          variants: [],
          attributes: {},
          compliance: {},
        },
        assets: [],
      } as never,
      new Date("2026-08-04T00:00:00.000Z"),
    );

    expect(readiness.status).toBe("blocked");
    expect(readiness.groups).toHaveLength(8);
    expect(readiness.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "missing_profile",
        "missing_sku",
        "missing_approved_listing",
        "incomplete_image_set",
        "missing_a_plus",
        "missing_custom_fields",
        "missing_print_template",
        "listing_validation_failed",
      ]),
    );
  });
});
