import type { CaptureDraft } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  extractResearchClassificationCandidate,
  normalizeResearchProductType,
} from "./research-classification.service.js";

describe("research product type classification", () => {
  it("uses the deepest marketplace taxonomy before EHunt and Amazon rank evidence", () => {
    const candidate = extractResearchClassificationCandidate(
      draft({
        taxonomy: [
          { label: "Home & Living", url: "https://example.test/home" },
          { label: " Throw   Pillows ", url: "https://example.test/pillows" },
        ],
        ehuntAnalysis: ehunt(["Paper", "Gift Wrapping"]),
        productInformation: [bestSellerRank("#7 in Gift Wrap Tags")],
      }),
    );

    expect(candidate).toEqual({
      evidenceKey: "throw pillows",
      evidenceLabel: "Throw Pillows",
      evidenceSource: "marketplace_taxonomy",
    });
  });

  it("uses the deepest EHunt category when native taxonomy is unavailable", () => {
    expect(
      extractResearchClassificationCandidate(
        draft({ ehuntAnalysis: ehunt(["Paper & Party Supplies", "Gift Wrapping"]) }),
      ),
    ).toMatchObject({
      evidenceLabel: "Gift Wrapping",
      evidenceSource: "ehunt_category",
    });
  });

  it("cleans Amazon Best Sellers Rank and selects the most specific visible category", () => {
    expect(
      extractResearchClassificationCandidate(
        draft({
          productInformation: [
            bestSellerRank(
              "#2,281 in Arts, Crafts & Sewing #28 in Gift Wrap Tags",
              [
                {
                  label: "#2,281 in Arts, Crafts & Sewing",
                  url: "https://example.test/broad",
                },
                {
                  label: "#28 in Gift Wrap Tags",
                  url: "https://example.test/specific",
                },
              ],
            ),
          ],
        }),
      ),
    ).toEqual({
      evidenceKey: "gift wrap tags",
      evidenceLabel: "Gift Wrap Tags",
      evidenceSource: "amazon_bsr",
    });
  });

  it("normalizes with NFKC, trims and collapses whitespace without translating", () => {
    expect(normalizeResearchProductType("  Ｇｉｆｔ\u00a0  Tags  ")).toEqual({
      key: "gift tags",
      name: "Gift Tags",
    });
    expect(normalizeResearchProductType("Mugs")).toEqual({ key: "mugs", name: "Mugs" });
  });

  it("does not infer a type from title, tags, or EHunt product flags", () => {
    expect(
      extractResearchClassificationCandidate(
        draft({
          title: "Customizable Handmade Coffee Mug",
          ehuntAnalysis: ehunt([]),
        }),
      ),
    ).toBeNull();
  });
});

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    platform: "amazon",
    parserVersion: "amazon@1.0.0",
    extensionVersion: "0.0.0",
    marketplace: "www.amazon.com",
    sourceUrl: "https://www.amazon.com/dp/B000000001",
    externalId: "B000000001",
    title: "Sample Product",
    domain: "research",
    price: null,
    rating: null,
    reviewCount: null,
    taxonomy: [],
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
      updatedAt: "2026-07-31T00:00:00.000Z",
    },
    bullets: [],
    media: [],
    variants: [],
    productInformation: [],
    contentBlocks: [],
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete",
    capturedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

function ehunt(
  categoryPath: string[],
): NonNullable<CaptureDraft["ehuntAnalysis"]> {
  return {
    provider: "ehunt",
    sourceSelector: "#ehunt",
    listingPublishedAt: null,
    totalSales: null,
    salesDelta: null,
    totalRevenue: null,
    revenueDelta: null,
    viewCount: null,
    reviewCount: null,
    reviewDelta: null,
    favoriteCount: null,
    favoriteDelta: null,
    conversionRatePercent: null,
    reviewRatePercent: null,
    price: null,
    productTypes: ["Handmade", "Customizable"],
    shipsFrom: null,
    badges: [],
    inventoryCount: null,
    categoryPath,
    tags: [{ label: "mug", metricRaw: null, metricValue: null }],
    annualTrendUrl: null,
    shopName: null,
    shopRating: null,
    shopSalesCount: null,
    shopSalesDelta: null,
  };
}

function bestSellerRank(
  value: string,
  links: Array<{ label: string; url: string }> = [],
): CaptureDraft["productInformation"][number] {
  return {
    name: "Product information",
    items: [{ label: "Best Sellers Rank", value, links }],
  };
}
