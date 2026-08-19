import type {
  CustomProductPackageCompleteness,
  CustomProductPackageProduct,
} from "@yummyai/contracts/catalog/custom-product-package";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
  buildCustomProductPackage,
  inspectCustomProductPackage,
  type BuildCustomProductPackageInput,
} from "./custom-product-package.js";

const planId = "019fb6f5-0985-74b0-88d2-f4c6cf22555b";
const tenantId = "019fb6f5-0985-74b0-88d2-f4c6cf22555c";
const userId = "019fb6f5-0985-74b0-88d2-f4c6cf22555d";

describe("CustomProductPackageV1 ZIP", () => {
  it("builds and inspects a deterministic Amazon Studio handoff", async () => {
    const built = await buildCustomProductPackage(input());
    const inspected = await inspectCustomProductPackage(built.bytes);

    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(inspected.manifest.mode).toBe("draft");
    expect(inspected.product.profile.materials[0]?.source).toBe("competitor_reference");
    expect(inspected.competitors[0]?.sourceUrl).toContain("etsy.com/listing/4451179943");
    expect(inspected.assets[0]).toMatchObject({
      includedInPackage: false,
      rightsStatus: "reference_only",
      usePolicy: "analysis_only",
    });
    const zip = await JSZip.loadAsync(built.bytes);
    expect(Object.values(zip.files).filter((entry) => entry.dir)).toEqual([]);
  });

  it("rejects credential-like file names before creating a ZIP", async () => {
    await expect(
      buildCustomProductPackage({
        ...input(),
        assetFiles: [
          {
            path: "assets/real-product/access-token.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    ).rejects.toThrow(/Credential-like file names/);
  });

  it("rejects ZIP entries whose original path escapes the package", async () => {
    const zip = new JSZip();
    zip.file("../outside.json", "{}");
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(inspectCustomProductPackage(bytes)).rejects.toThrow(/Unsafe package path/);
  });
});

function input(): BuildCustomProductPackageInput {
  const completeness: CustomProductPackageCompleteness = {
    status: "blocked",
    score: 55,
    issues: [
      {
        code: "unverified_facts",
        severity: "warning",
        path: "product.profile",
        message: "Competitor-derived facts still require seller confirmation.",
      },
    ],
    confirmedFactCount: 0,
    unverifiedFactCount: 3,
    authorizedAssetCount: 0,
    referenceOnlyAssetCount: 1,
    evaluatedAt: "2026-07-31T00:00:00.000Z",
  };
  const product: CustomProductPackageProduct = {
    planId,
    name: "Vintage Photo Birthday Cake Topper",
    profile: {
      schemaVersion: "1.0",
      sku: fact("DRAFT-4451179943", "inferred_from_research"),
      targetMarketplace: fact("amazon.com", "seller_provided"),
      productType: fact("Cake Toppers", "inferred_from_research"),
      materials: [fact("3mm wood and acrylic", "competitor_reference")],
      colors: [],
      sizeOptions: [],
      packageContents: [],
      targetAudiences: [],
      sellingPoints: [],
      surfaces: [],
      approvedClaims: [],
      prohibitedClaims: [],
      prohibitedElements: [],
      researchItemIds: [],
      assetAssignments: [],
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
  };
  return {
    mode: "draft",
    planId,
    tenantId,
    targetMarketplace: "amazon.com",
    policyVersion: "amazon-custom-product-package-2026-07-31",
    createdBy: userId,
    createdAt: "2026-07-31T00:00:00.000Z",
    product,
    customization: {
      schemaVersion: "1.0",
      definition: { version: 1, fields: [] },
      surfaces: [],
    },
    competitors: [
      {
        researchItemId: "019fb6ba-fa80-7c6c-afb5-1c9594cc0d8c",
        snapshotId: "019fb6ba-fa82-70af-867d-7ce13d800f3f",
        platform: "etsy",
        marketplace: "US",
        sourceUrl: "https://www.etsy.com/listing/4451179943/example",
        title: "Custom Vintage Photo Birthday Cake Topper",
        capturedAt: "2026-07-31T00:00:00.000Z",
        captureStatus: "partial",
        tags: ["birthday cake topper"],
      },
    ],
    reviewInsights: {
      status: "unavailable",
      collectedReviewCount: 0,
      purchaseMotivations: [],
      painPoints: [],
      notes: ["No review text was captured."],
    },
    brandStyle: {
      status: "missing",
      styleKeywords: [],
      colors: [],
      prohibitedElements: ["Competitor artwork"],
    },
    claims: {
      verifiedClaims: [],
      provisionalClaims: ["3mm wood and acrylic"],
      prohibitedClaims: [],
      evidenceNotes: ["Competitor facts are draft-only."],
    },
    completeness,
    assets: [
      {
        id: "reference:1",
        fileName: "competitor-01.jpg",
        role: "competitor_reference",
        rightsStatus: "reference_only",
        usePolicy: "analysis_only",
        mediaType: "image/jpeg",
        sourceUrl: "https://i.etsystatic.com/example.jpg",
        includedInPackage: false,
      },
    ],
  };
}

function fact(
  value: string,
  source: "seller_provided" | "competitor_reference" | "inferred_from_research",
) {
  return { value, source, verificationStatus: "unverified" as const };
}
