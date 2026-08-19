import type {
  CustomProductPackageAsset,
  CustomProductProfileV1,
} from "@yummyai/contracts/catalog/custom-product-package";
import { describe, expect, it } from "vitest";

import {
  evaluateCompleteness,
  normalizeCompetitorOptionLabel,
} from "./custom-product-package.service.js";

describe("Amazon Custom package completeness", () => {
  it("removes competitor prices from editable size facts", () => {
    expect(normalizeCompetitorOptionLabel('6"x6" (recommend) ($14.39)')).toBe('6"x6" (recommend)');
  });

  it("allows a draft assessment but blocks release readiness for competitor-only facts", () => {
    const result = evaluateCompleteness(profile(), [
      {
        id: "reference:1",
        fileName: "competitor.jpg",
        role: "competitor_reference",
        rightsStatus: "reference_only",
        usePolicy: "analysis_only",
        mediaType: "image/jpeg",
        includedInPackage: false,
      },
    ]);

    expect(result.status).toBe("blocked");
    expect(result.unverifiedFactCount).toBeGreaterThan(0);
    expect(result.issues.map((issue) => issue.code)).toContain("missing_authorized_assets");
  });

  it("becomes ready after seller confirmation and an approved product asset", () => {
    const confirmed = profile();
    for (const fact of allFacts(confirmed)) {
      fact.source = "seller_provided";
      fact.verificationStatus = "confirmed";
    }
    const asset: CustomProductPackageAsset = {
      id: "019fb6f5-0985-74b0-88d2-f4c6cf22555e",
      fileName: "topper.jpg",
      role: "real_product",
      rightsStatus: "owned",
      usePolicy: "generation_allowed",
      mediaType: "image/jpeg",
      includedInPackage: true,
    };

    expect(evaluateCompleteness(confirmed, [asset]).status).toBe("ready");
  });
});

function profile(): CustomProductProfileV1 {
  const fact = (value: string) => ({
    value,
    source: "competitor_reference" as const,
    verificationStatus: "unverified" as const,
  });
  return {
    schemaVersion: "1.0",
    sku: fact("TOPPER-001"),
    targetMarketplace: fact("amazon.com"),
    productType: fact("Cake Toppers"),
    brand: fact("Yummy"),
    materials: [fact("Acrylic")],
    colors: [],
    sizeOptions: [fact("6 x 6 in")],
    packageQuantity: {
      value: 1,
      source: "competitor_reference",
      verificationStatus: "unverified",
    },
    packageContents: [fact("1 cake topper")],
    manufacturingProcess: fact("Single-sided printing"),
    targetAudiences: [],
    sellingPoints: [],
    surfaces: [
      {
        key: "front",
        label: "Front",
        fieldKeys: ["photo_upload"],
        areaMm: { width: 120, height: 120 },
        source: "competitor_reference",
        verificationStatus: "unverified",
      },
    ],
    approvedClaims: [],
    prohibitedClaims: [],
    prohibitedElements: [],
    researchItemIds: [],
    assetAssignments: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}

function allFacts(profile: CustomProductProfileV1) {
  return [
    profile.sku,
    profile.targetMarketplace,
    profile.productType,
    profile.brand,
    ...profile.materials,
    ...profile.colors,
    ...profile.sizeOptions,
    profile.packageQuantity,
    ...profile.packageContents,
    profile.manufacturingProcess,
    ...profile.targetAudiences,
    ...profile.sellingPoints,
    ...profile.surfaces,
  ].filter(Boolean) as Array<
    NonNullable<
      | CustomProductProfileV1["sku"]
      | CustomProductProfileV1["packageQuantity"]
      | CustomProductProfileV1["surfaces"][number]
    >
  >;
}
