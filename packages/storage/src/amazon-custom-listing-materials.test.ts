import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import { buildAmazonCustomListingMaterialsPackage } from "./amazon-custom-listing-materials.js";
import { checksumSha256 } from "./checksum.js";

const PLAN_ID = "019fb700-0000-7000-8000-000000000001";
const LISTING_ID = "019fb700-0000-7000-8000-000000000002";
const VERSION_ID = "019fb700-0000-7000-8000-000000000003";
const TENANT_ID = "019fb700-0000-7000-8000-000000000004";
const USER_ID = "019fb700-0000-7000-8000-000000000005";
const ASSET_ID = "019fb700-0000-7000-8000-000000000006";

describe("Amazon Custom listing materials package", () => {
  it("builds a deterministic operator handoff with copy, config, checklist and media", async () => {
    const bytes = new TextEncoder().encode("owned-main-image");
    const result = await buildAmazonCustomListingMaterialsPackage({
      planId: PLAN_ID,
      listingId: LISTING_ID,
      listingVersionId: VERSION_ID,
      tenantId: TENANT_ID,
      targetMarketplace: "amazon.com",
      policyVersion: "test-policy",
      createdBy: USER_ID,
      createdAt: "2026-08-04T00:00:00.000Z",
      listingCopy: {
        marketplace: "amazon.com",
        locale: "en-US",
        productType: "CAKE_TOPPER",
        title: "Personalized Vintage Photo Birthday Cake Topper",
        bulletPoints: ["One", "Two", "Three", "Four", "Five"],
        description: "A personalized milestone cake topper.",
        searchTerms: ["birthday cake topper"],
        attributes: {
          brand: [{ value: "Example Brand" }],
          purchasable_offer: [{ currency: "USD", our_price: 19.99 }],
          fulfillment_availability: [{ quantity: 20 }],
          condition_type: [{ value: "new_new" }],
          merchant_shipping_group: [{ value: "Custom FBM" }],
        },
        offerAndFulfillment: {
          purchasable_offer: [{ currency: "USD", our_price: 19.99 }],
          fulfillment_availability: [{ quantity: 20 }],
          condition_type: [{ value: "new_new" }],
          merchant_shipping_group: [{ value: "Custom FBM" }],
        },
        compliance: { countryOfOrigin: "CN" },
      },
      variants: [{ skuId: VERSION_ID, skuCode: "TOPPER-1996", optionValues: {} }],
      customization: {
        schemaVersion: "1.0",
        definition: {
          version: 1,
          fields: [
            {
              key: "name",
              label: "Name",
              type: "short_text",
              required: true,
              validation: { maxLength: 24 },
            },
          ],
        },
        surfaces: [
          {
            key: "front",
            label: "Front",
            fieldKeys: ["name"],
            areaMm: { width: 80, height: 100 },
            source: "seller_provided",
            verificationStatus: "confirmed",
          },
        ],
      },
      claims: {
        verifiedClaims: [],
        provisionalClaims: [],
        prohibitedClaims: ["No unsupported claims"],
        evidenceNotes: [],
      },
      readiness: readyReadiness(),
      files: [
        {
          assetId: ASSET_ID,
          path: "listing-images/TOPPER-1996_MAIN.jpg",
          role: "main",
          sourceFileName: "main.jpg",
          mediaType: "image/jpeg",
          bytes,
          sha256: checksumSha256(bytes),
        },
      ],
    });
    const zip = await JSZip.loadAsync(result.bytes);
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "00-先看这里-README.txt",
        "listing/listing-copy.txt",
        "customizer/customizer-config.csv",
        "upload/upload-checklist.csv",
        "listing-images/TOPPER-1996_MAIN.jpg",
        "manifest.json",
      ]),
    );
    expect(await zip.file("listing/listing-copy.txt")!.async("string")).toContain(
      "[BULLET POINTS]",
    );
    expect(result.manifest.packageKind).toBe("amazon-custom-listing-materials");
  });

  it("refuses to export an incomplete package", async () => {
    await expect(
      buildAmazonCustomListingMaterialsPackage({
        planId: PLAN_ID,
        listingId: LISTING_ID,
        listingVersionId: VERSION_ID,
        tenantId: TENANT_ID,
        targetMarketplace: "amazon.com",
        policyVersion: "test-policy",
        createdBy: USER_ID,
        createdAt: "2026-08-04T00:00:00.000Z",
        listingCopy: {
          marketplace: "amazon.com",
          locale: "en-US",
          productType: "CAKE_TOPPER",
          title: "Title",
          bulletPoints: [],
          description: "Description",
          searchTerms: [],
          attributes: {},
          offerAndFulfillment: {},
          compliance: {},
        },
        variants: [{ skuId: VERSION_ID, skuCode: "TOPPER-1996", optionValues: {} }],
        customization: {
          schemaVersion: "1.0",
          definition: { version: 1, fields: [] },
          surfaces: [],
        },
        claims: {
          verifiedClaims: [],
          provisionalClaims: [],
          prohibitedClaims: [],
          evidenceNotes: [],
        },
        readiness: { ...readyReadiness(), status: "blocked" },
        files: [],
      }),
    ).rejects.toThrow(/readiness is ready/);
  });
});

function readyReadiness() {
  const groups = [
    ["product_facts", "产品事实"],
    ["sku", "SKU 与变体"],
    ["listing_copy", "Listing 文案"],
    ["listing_images", "9 张图片"],
    ["a_plus", "A+"],
    ["customizer", "定制配置"],
    ["production", "生产文件"],
    ["compliance", "合规"],
  ] as const;
  return {
    status: "ready" as const,
    score: 100,
    planId: PLAN_ID,
    listingId: LISTING_ID,
    listingVersionId: VERSION_ID,
    groups: groups.map(([key, label]) => ({
      key,
      label,
      status: "ready" as const,
      completed: 1,
      required: 1,
    })),
    issues: [],
    evaluatedAt: "2026-08-04T00:00:00.000Z",
  };
}
