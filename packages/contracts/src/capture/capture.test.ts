import { describe, expect, it } from "vitest";

import { CaptureDraftSchema, CompetitorShopDraftSchema } from "./capture.js";

describe("CaptureDraftSchema product information", () => {
  it("accepts ordered, grouped marketplace parameters and evidence links", () => {
    const parsed = CaptureDraftSchema.parse({
      ...captureDraft(),
      productInformation: [
        {
          name: "Item details",
          items: [
            {
              label: "Best Sellers Rank",
              value: "#28 in Gift Wrap Tags",
              links: [
                {
                  label: "#28 in Gift Wrap Tags",
                  url: "https://www.amazon.com/gp/bestsellers/hpc/723469011",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(parsed.productInformation[0]?.items[0]?.label).toBe("Best Sellers Rank");
  });

  it("defaults product information for older extension payloads", () => {
    expect(CaptureDraftSchema.parse(captureDraft()).productInformation).toEqual([]);
  });

  it("preserves optional EHunt evidence without adding it to older payloads", () => {
    const parsed = CaptureDraftSchema.parse({
      ...captureDraft(),
      platform: "etsy",
      ehuntAnalysis: ehuntAnalysis(),
    });

    expect(parsed.ehuntAnalysis?.tags[0]).toEqual({
      label: "custom tissue paper",
      metricRaw: "5.0M",
      metricValue: 5_000_000,
    });
    expect(CaptureDraftSchema.parse(captureDraft()).ehuntAnalysis).toBeUndefined();
  });
});

describe("CompetitorShopDraftSchema", () => {
  it("preserves fractional Etsy tenure", () => {
    const parsed = CompetitorShopDraftSchema.parse({
      ...shopDraft(),
      yearsOnPlatform: 1.5,
    });

    expect(parsed.yearsOnPlatform).toBe(1.5);
  });

  it("accepts ordered shop sections with stable and unavailable links", () => {
    const parsed = CompetitorShopDraftSchema.parse({
      ...shopDraft(),
      shopSections: [
        {
          kind: "all",
          externalId: "0",
          name: "All",
          listingCount: 426,
          sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
        },
        {
          kind: "sale",
          externalId: "1",
          name: "On sale",
          listingCount: 426,
          sourceUrl: null,
        },
        {
          kind: "category",
          externalId: "39890899",
          name: "Punch Needle",
          listingCount: 262,
          sourceUrl:
            "https://www.etsy.com/shop/ThePineTroveGifts?section_id=39890899",
        },
      ],
    });

    expect(parsed.shopSections.map((section) => section.kind)).toEqual([
      "all",
      "sale",
      "category",
    ]);
  });

  it("defaults missing shop sections for older extension payloads", () => {
    expect(CompetitorShopDraftSchema.parse(shopDraft()).shopSections).toEqual([]);
  });

  it.each([
    {
      kind: "hot_products" as const,
      label: "热销商品",
      items: [
        {
          title: "Personalized embroidered pillowcase",
          detailUrl: "https://ehunt.ai/product-detail/4536973166",
          imageUrl: "https://i.etsystatic.com/1/item.jpg",
          totalSales: { raw: "267", value: 267 },
          price: { raw: "$30.59", amount: 30.59 },
        },
      ],
    },
    {
      kind: "new_products" as const,
      label: "上新选品",
      items: [
        {
          title: "New nursery keepsake",
          detailUrl: null,
          imageUrl: null,
          totalSales: { raw: "0", value: 0 },
          price: null,
        },
      ],
    },
    {
      kind: "delisted_products" as const,
      label: "下架选品",
      items: [
        {
          title: "Delisted custom gift",
          detailUrl: null,
          imageUrl: null,
          totalSales: null,
          price: null,
        },
      ],
    },
    {
      kind: "history_trend" as const,
      label: "历史趋势",
      points: [
        {
          period: "2026-07",
          values: [{ label: "周销量", metric: { raw: "231", value: 231 } }],
        },
      ],
    },
    {
      kind: "common_tags" as const,
      label: "常用标签",
      items: [
        {
          label: "baby shower gift",
          frequency: { raw: "50", value: 50 },
          competition: { raw: "2.0M", value: 2_000_000 },
          views: { raw: "54.6M", value: 54_600_000 },
          viewDelta: { raw: "17.5M", value: 17_500_000 },
          favorites: { raw: "1.5M", value: 1_500_000 },
          favoriteDelta: { raw: "35.1K", value: 35_100 },
          sales: { raw: "1.1M", value: 1_100_000 },
          salesDelta: { raw: "56.5K", value: 56_500 },
        },
      ],
    },
    {
      kind: "popular_categories" as const,
      label: "热门类目",
      items: [
        {
          path: ["Home & Living", "Home Decor", "Wall Decor"],
          sharePercent: 50,
          raw: "Home & Living > Home Decor > Wall Decor (50%)",
        },
      ],
    },
  ])("accepts optional EHunt shop evidence for $kind", (activeSection) => {
    const parsed = CompetitorShopDraftSchema.parse({
      ...shopDraft(),
      ehuntAnalysis: {
        ...ehuntShopAnalysis(),
        activeSection,
      },
    });

    expect(parsed.ehuntAnalysis?.activeSection?.kind).toBe(activeSection.kind);
    expect(CompetitorShopDraftSchema.parse(shopDraft()).ehuntAnalysis).toBeUndefined();
  });
});

function shopDraft() {
  return {
    platform: "etsy" as const,
    externalId: "ThePineTroveGifts",
    name: "ThePineTroveGifts",
    sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
    location: "South Surrey, Canada",
    ownerName: "Kirti",
    rating: 4.8,
    reviewCount: 9800,
    salesCount: 71138,
    activeListingCount: 426,
    admirerCount: 5721,
    openedYear: 2022,
    yearsOnPlatform: 3,
    badges: ["Star Seller"],
    parserVersion: "etsy-shop@1.1.0",
    extensionVersion: "0.0.0",
    marketplace: "www.etsy.com",
    announcement: null,
    about: null,
    policies: null,
    members: [],
    productionPartners: [],
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete" as const,
    capturedAt: "2026-07-29T00:00:00.000Z",
  };
}

function captureDraft() {
  return {
    platform: "amazon" as const,
    parserVersion: "amazon@1.4.0",
    extensionVersion: "0.0.0",
    marketplace: "www.amazon.com",
    sourceUrl: "https://www.amazon.com/dp/B0FQNYXDVY",
    externalId: "B0FQNYXDVY",
    title: "Custom Hang Tags",
    domain: "research" as const,
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
      status: "visible" as const,
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
    bullets: [],
    media: [],
    variants: [],
    contentBlocks: [],
    missingFields: ["media"],
    diagnostics: [],
    captureStatus: "partial" as const,
    capturedAt: "2026-07-29T00:00:00.000Z",
  };
}

function ehuntAnalysis() {
  return {
    provider: "ehunt" as const,
    sourceSelector: "#etsy-rank-tool-product-table",
    listingPublishedAt: "2021-06-24",
    totalSales: 12368,
    salesDelta: 47,
    totalRevenue: { raw: "209,513.92", amount: 209513.92, currency: "USD" },
    revenueDelta: { raw: "796.18", amount: 796.18, currency: "USD" },
    viewCount: 255481,
    reviewCount: 1800,
    reviewDelta: 2,
    favoriteCount: 11930,
    favoriteDelta: 44,
    conversionRatePercent: 4.84,
    reviewRatePercent: 14.55,
    price: { raw: "$ 16.94+", amount: 16.94, currency: "USD" },
    productTypes: ["Handmade", "Customizable"],
    shipsFrom: "美国",
    badges: ["BestSeller"],
    inventoryCount: 991,
    categoryPath: ["Paper & Party Supplies", "Paper", "Gift Wrapping"],
    tags: [
      { label: "custom tissue paper", metricRaw: "5.0M", metricValue: 5_000_000 },
    ],
    annualTrendUrl: "https://ehunt.ai/product-detail/1041388929",
    shopName: "CoacoUSA",
    shopRating: 4.9,
    shopSalesCount: 174083,
    shopSalesDelta: 2048,
  };
}

function ehuntShopAnalysis() {
  return {
    provider: "ehunt" as const,
    sourceSelector: "#etsy-rank-tool-store-table .eh-store-detail",
    openedAt: "2026-06-25",
    primaryCategory: null,
    country: "美国",
    weeklySales: { raw: "231", value: 231 },
    weeklyRevenue: { raw: "5,430.81", amount: 5430.81 },
    weeklyReviews: { raw: "0", value: 0 },
    totalSales: { raw: "347", value: 347 },
    totalRevenue: { raw: "8,157.97", amount: 8157.97 },
    totalReviews: { raw: "0", value: 0 },
    weeklyFavorites: { raw: "100", value: 100 },
    listingCount: { raw: "58", value: 58 },
    rating: 0,
    totalFavorites: { raw: "146", value: 146 },
    starSeller: false,
    socialMedia: [],
    paymentMethods: ["Paypal", "Visa"],
    activeSection: null,
  };
}
