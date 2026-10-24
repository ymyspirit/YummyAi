import { describe, expect, it } from "vitest";
import { CaptureDraftSchema, createEntityId } from "@yummyai/contracts";
import { provisionalProfile } from "./custom-product-package.js";

describe("provisional product evidence boundaries", () => {
  it("does not label an unrelated product as a birthday cake topper or invent audiences and selling points", () => {
    const { plan, evidence } = fixture();
    const profile = provisionalProfile(plan, evidence, "amazon.com");
    expect(profile.productType).toBeUndefined();
    expect(profile.targetAudiences).toEqual([]);
    expect(profile.sellingPoints).toEqual([]);
    expect(profile.materials).toEqual([]);
    expect(profile.manufacturingProcess).toBeUndefined();
    expect(JSON.stringify(profile)).not.toMatch(/cake|birthday|nostalgic|copperplate/i);
    expect(profile.approvedClaims).toEqual([]);
  });
  it("preserves an explicit research classification as unverified and quotes the supported process without extra material claims", () => {
    const { plan, evidence } = fixture();
    evidence.item.productTypeName = "Personalized Mugs";
    evidence.draft.contentBlocks = [
      { kind: "description", text: "Single-side printed mug", sourceSelector: "#description" },
    ];
    const profile = provisionalProfile(plan, evidence, "amazon.com");
    expect(profile.productType).toMatchObject({
      value: "Personalized Mugs",
      verificationStatus: "unverified",
    });
    expect(profile.manufacturingProcess).toMatchObject({
      value: "Single-side printed",
      source: "competitor_reference",
      verificationStatus: "unverified",
    });
    expect(profile.manufacturingProcess?.value).not.toContain("copperplate");
    expect(profile.surfaces[0]).toMatchObject({
      source: "seller_provided",
      verificationStatus: "unverified",
      evidencePath: "productPlan.customization.fields",
    });
    expect(profile.surfaces[0]?.areaMm).toBeUndefined();
  });
});

function fixture() {
  const draft = CaptureDraftSchema.parse({
    platform: "amazon",
    marketplace: "www.amazon.com",
    sourceUrl: "https://www.amazon.com/dp/B000000MUG",
    title: "Custom Mug",
    parserVersion: "fixture-v1",
    extensionVersion: "0.0.0",
    domain: "research",
    taxonomy: [],
    bullets: [],
    media: [],
    variants: [],
    contentBlocks: [],
    externalId: "B000000MUG",
    price: null,
    rating: null,
    reviewCount: null,
    listingPublishedAt: null,
    favoriteCount: null,
    shipping: null,
    shop: null,
    reviewSummary: null,
    reviews: [],
    reviewCollection: {
      collectedCount: 0,
      reportedTotal: null,
      pageCount: 0,
      status: "visible",
      updatedAt: new Date().toISOString(),
    },
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete",
    capturedAt: new Date().toISOString(),
  });
  return {
    plan: { customization: { version: 1, fields: [] } } as unknown as Parameters<
      typeof provisionalProfile
    >[0],
    evidence: {
      item: { id: createEntityId(), normalizedUrl: draft.sourceUrl, productTypeName: null },
      snapshot: { id: createEntityId() },
      draft,
    } as unknown as Parameters<typeof provisionalProfile>[1],
  };
}
