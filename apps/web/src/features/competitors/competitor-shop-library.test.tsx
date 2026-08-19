import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CompetitorShopLibrary,
  filterCompetitorShops,
  type CompetitorShopView,
} from "./competitor-shop-library";

describe("CompetitorShopLibrary", () => {
  it("renders stable shop-section links and keeps sale as plain evidence", () => {
    const html = renderToStaticMarkup(
      <CompetitorShopLibrary items={[shopView(sections())]} />,
    );

    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("店铺标签");
    expect(html).toContain("3 个 · 全部 426");
    expect(html).toContain("Punch Needle");
    expect(html).toContain(
      'href="https://www.etsy.com/shop/ThePineTroveGifts?section_id=39890899"',
    );
    expect(html).toContain("On sale");
    expect(html.match(/<a /g)).toHaveLength(3);
    expect(html).toContain("未逐条访问商品链接");
  });

  it("renders an explicit empty state for historical snapshots", () => {
    const html = renderToStaticMarkup(
      <CompetitorShopLibrary items={[shopView([])]} />,
    );

    expect(html).toContain("此快照未包含店铺标签");
    expect(html).toContain("使用最新扩展重新采集后显示");
    expect(html).not.toContain("EHunt 店铺分析");
  });

  it("renders optional EHunt shop evidence and the captured active tab", () => {
    const shop = shopView(sections());
    shop.latestSnapshot!.draft = {
      platform: "etsy",
      externalId: "ThePineTroveGifts",
      name: "ThePineTroveGifts",
      sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
      location: "South Surrey, Canada",
      ownerName: "Kirti",
      rating: 4.8,
      reviewCount: 9900,
      salesCount: 71888,
      activeListingCount: 426,
      admirerCount: 5721,
      openedYear: 2022,
      yearsOnPlatform: 3,
      badges: ["Star Seller"],
      parserVersion: "etsy-shop@1.2.0",
      extensionVersion: "0.0.0",
      marketplace: "www.etsy.com",
      announcement: null,
      about: null,
      policies: null,
      members: [],
      productionPartners: [],
      shopSections: sections(),
      ehuntAnalysis: {
        provider: "ehunt",
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
        activeSection: {
          kind: "common_tags",
          label: "常用标签",
          items: [
            {
              label:
                "personalized baby shower gift with an intentionally long descriptive keyword",
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
      },
      missingFields: [],
      diagnostics: [],
      captureStatus: "complete",
      capturedAt: "2026-07-29T00:00:00.000Z",
    };

    const html = renderToStaticMarkup(<CompetitorShopLibrary items={[shop]} />);

    expect(html).toContain("THIRD-PARTY EVIDENCE");
    expect(html).toContain("EHunt 店铺分析");
    expect(html).toContain("5,430.81");
    expect(html).toContain("Paypal");
    expect(html).toContain("常用标签");
    expect(html).toContain("personalized baby shower gift");
    expect(html).toContain("未自动切换页签");
  });

  it("removes Etsy seller helper text from the positioning signal", () => {
    const shop = shopView([]);
    shop.latestSnapshot!.about =
      "Learn more about the seller Handmade gifts from our family studio.";

    const html = renderToStaticMarkup(
      <CompetitorShopLibrary items={[shop]} />,
    );

    expect(html).not.toContain("Learn more about the seller");
    expect(html).toContain("Handmade gifts from our family studio.");
  });

  it("offers Amazon and Etsy filters with real platform counts", () => {
    const etsy = shopView([]);
    const amazon: CompetitorShopView = {
      ...shopView([]),
      id: "019fab00-0000-7000-8000-000000000002",
      platform: "amazon",
      shopName: "Amazon Studio",
    };

    const html = renderToStaticMarkup(
      <CompetitorShopLibrary items={[etsy, amazon]} />,
    );

    expect(html).toContain('aria-label="按平台筛选"');
    expect(html).toContain("Amazon");
    expect(html).toContain("Etsy");
    expect(html).toContain("2 / 2 SHOP RECORDS");
    expect(filterCompetitorShops([etsy, amazon], "amazon")).toEqual([amazon]);
    expect(filterCompetitorShops([etsy, amazon], "etsy")).toEqual([etsy]);
    expect(filterCompetitorShops([etsy, amazon], "all")).toEqual([etsy, amazon]);
  });

  it("excludes marketplace helper text captured as a shop name", () => {
    const etsy = shopView([]);
    const helperTextShop: CompetitorShopView = {
      ...shopView([]),
      id: "019fab00-0000-7000-8000-000000000003",
      platform: "amazon",
      shopName: "Learn more about the seller",
    };

    const html = renderToStaticMarkup(
      <CompetitorShopLibrary items={[etsy, helperTextShop]} />,
    );

    expect(html).not.toContain("Learn more about the seller");
    expect(html).toContain("1 / 1 SHOP RECORDS");
    expect(filterCompetitorShops([etsy, helperTextShop], "all")).toEqual([etsy]);
  });
});

function shopView(
  shopSections: NonNullable<CompetitorShopView["latestSnapshot"]>["shopSections"],
): CompetitorShopView {
  return {
    externalId: "ThePineTroveGifts",
    id: "019fab00-0000-7000-8000-000000000001",
    lastCapturedAt: "2026-07-29T00:00:00.000Z",
    latestStatus: "complete",
    marketplace: "www.etsy.com",
    normalizedUrl: "https://etsy.com/shop/ThePineTroveGifts",
    platform: "etsy",
    shopName: "ThePineTroveGifts",
    latestSnapshot: {
      about: null,
      activeListingCount: 426,
      admirerCount: 5721,
      announcement: null,
      badges: ["Star Seller"],
      capturedAt: "2026-07-29T00:00:00.000Z",
      location: "South Surrey, Canada",
      openedYear: 2022,
      ownerName: "Kirti",
      policies: null,
      productionPartners: [],
      rating: "4.80",
      reviewCount: 9900,
      salesCount: 71888,
      shopSections,
      snapshotKind: "shop",
      sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
      yearsOnPlatform: 3,
    },
  };
}

function sections(): NonNullable<
  CompetitorShopView["latestSnapshot"]
>["shopSections"] {
  return [
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
      sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts?section_id=39890899",
    },
  ];
}
