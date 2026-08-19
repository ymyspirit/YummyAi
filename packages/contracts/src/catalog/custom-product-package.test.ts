import { describe, expect, it } from "vitest";

import {
  CustomProductPackageManifestV1Schema,
  CustomProductProfileV1Schema,
} from "./custom-product-package.js";

const planId = "019fb6f5-0985-74b0-88d2-f4c6cf22555b";
const tenantId = "019fb6f5-0985-74b0-88d2-f4c6cf22555c";
const userId = "019fb6f5-0985-74b0-88d2-f4c6cf22555d";

describe("Amazon Custom product package contracts", () => {
  it("accepts editable competitor-derived facts without treating them as confirmed", () => {
    const profile = CustomProductProfileV1Schema.parse({
      schemaVersion: "1.0",
      sku: {
        value: "DRAFT-4451179943",
        source: "inferred_from_research",
        verificationStatus: "unverified",
      },
      materials: [
        {
          value: "3mm wood and acrylic",
          source: "competitor_reference",
          verificationStatus: "unverified",
          sourceUrl: "https://www.etsy.com/listing/4451179943/example",
        },
      ],
      surfaces: [
        {
          key: "front",
          label: "Front",
          fieldKeys: ["photo_upload"],
          source: "inferred_from_research",
          verificationStatus: "unverified",
        },
      ],
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(profile.materials[0]?.source).toBe("competitor_reference");
    expect(profile.materials[0]?.verificationStatus).toBe("unverified");
  });

  it("enforces the five-surface Amazon Custom policy boundary", () => {
    const result = CustomProductProfileV1Schema.safeParse({
      schemaVersion: "1.0",
      surfaces: Array.from({ length: 6 }, (_, index) => ({
        key: `surface_${index}`,
        label: `Surface ${index}`,
        fieldKeys: [],
        source: "seller_provided",
        verificationStatus: "confirmed",
      })),
      updatedAt: "2026-07-31T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("requires a manifest with hashed package files and an explicit draft or release mode", () => {
    const manifest = CustomProductPackageManifestV1Schema.parse({
      packageKind: "amazon-custom-product",
      packageVersion: "1.0",
      mode: "draft",
      planId,
      tenantId,
      targetMarketplace: "amazon.com",
      files: [
        {
          path: "product.json",
          role: "product",
          mediaType: "application/json",
          byteSize: 42,
          sha256: "a".repeat(64),
        },
      ],
      completeness: {
        status: "blocked",
        score: 50,
        issues: [],
        confirmedFactCount: 0,
        unverifiedFactCount: 1,
        authorizedAssetCount: 0,
        referenceOnlyAssetCount: 8,
        evaluatedAt: "2026-07-31T00:00:00.000Z",
      },
      policyVersion: "amazon-custom-product-package-2026-07-31",
      createdBy: userId,
      createdAt: "2026-07-31T00:00:00.000Z",
    });

    expect(manifest.mode).toBe("draft");
    expect(manifest.files[0]?.sha256).toHaveLength(64);
  });
});
