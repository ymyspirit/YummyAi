import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ResearchTable } from "./research-table";
import { ResearchProductDossier, type ResearchSnapshotView } from "./snapshot-timeline";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("ResearchTable", () => {
  it("keeps product details collapsed outside the narrow summary cells", () => {
    const html = renderToStaticMarkup(
      <ResearchTable
        items={[{
          id: "item-1",
          platform: "amazon",
          marketplace: "amazon.com",
          normalizedUrl: "https://amazon.com/dp/B000000001",
          latestTitle: "Personalized Sample Product",
          shopName: "Sample Studio",
          latestStatus: "partial",
          lastCapturedAt: "2026-07-18T00:00:00.000Z",
          classification: {
            productType: { key: "throw pillows", name: "Throw Pillows" },
            status: "suggested",
            source: "marketplace_taxonomy",
            evidenceSource: "marketplace_taxonomy",
            evidenceLabel: "Throw Pillows",
            updatedAt: "2026-07-18T00:00:00.000Z",
          },
          snapshots: [
            { id: "snapshot-2", capturedAt: "2026-07-18T00:00:00.000Z", status: "partial", title: "Updated product" },
            { id: "snapshot-1", capturedAt: "2026-07-17T00:00:00.000Z", status: "complete", title: "Original product" },
          ],
        }]}
        nextPageHref={null}
        productTypes={[{
          key: "throw pillows",
          name: "Throw Pillows",
          suggested: 1,
          confirmed: 0,
          total: 1,
        }]}
      />,
    );

    expect(html).toContain("Personalized Sample Product");
    expect(html).toContain("Sample Studio");
    expect(html).toContain("查看详情");
    expect(html).toContain("Throw Pillows");
    expect(html).toContain("待复核");
    expect(html).toContain("批量归类");
    expect(html).not.toContain("Updated product");
    expect(html).not.toContain("Original product");
    expect(html).toContain("partial");
  });

  it("renders the main image, product evidence, and newest snapshot first", () => {
    const snapshots: ResearchSnapshotView[] = [
      {
        id: "snapshot-old",
        capturedAt: "2026-07-17T00:00:00.000Z",
        status: "complete",
        title: "Older evidence",
      },
      {
        id: "snapshot-new",
        capturedAt: "2026-07-19T00:00:00.000Z",
        status: "partial",
        title: "Newer evidence",
        draft: {
          platform: "etsy",
          parserVersion: "1.0.0",
          extensionVersion: "1.0.0",
          marketplace: "www.etsy.com",
          sourceUrl: "https://www.etsy.com/listing/123/sample",
          externalId: "123",
          title: "Personalized Name Pillow",
          domain: "research",
          price: { raw: "$16.00+", amount: 16, currency: "USD" },
          rating: null,
          reviewCount: 128,
          taxonomy: [
            { label: "Home & Living", url: "https://www.etsy.com/c/home-and-living" },
            { label: "Throw Pillows", url: "https://www.etsy.com/c/home-and-living/home-decor/decorative-pillows" },
          ],
          listingPublishedAt: "Jul 18, 2026",
          favoriteCount: 4034,
          shipping: {
            estimatedDelivery: "Aug 6-17",
            processingTime: "3-5 days",
            cost: { raw: "$5.00", amount: 5, currency: "USD" },
            shipsFrom: "United States",
            destination: "China",
            sourceSelector: "#shipping",
          },
          shop: {
            platform: "etsy",
            externalId: "sample-studio",
            name: "Sample Studio",
            sourceUrl: "https://www.etsy.com/shop/SampleStudio",
            location: null,
            ownerName: null,
            rating: 4.8,
            reviewCount: null,
            salesCount: null,
            activeListingCount: null,
            admirerCount: null,
            openedYear: null,
            yearsOnPlatform: null,
            badges: [],
          },
          reviewSummary: null,
          reviews: [],
          reviewCollection: {
            collectedCount: 12,
            reportedTotal: 128,
            pageCount: 2,
            status: "paused",
            updatedAt: "2026-07-19T00:00:00.000Z",
          },
          ehuntAnalysis: {
            provider: "ehunt",
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
              {
                label: "custom tissue paper",
                metricRaw: "5.0M",
                metricValue: 5_000_000,
              },
            ],
            annualTrendUrl: "https://ehunt.ai/product-detail/123",
            shopName: "Sample Studio",
            shopRating: 4.9,
            shopSalesCount: 174083,
            shopSalesDelta: 2048,
          },
          bullets: ["Punch needle embroidery", "Personalized nursery decor"],
          media: [{
            id: "image-1",
            kind: "image",
            sourceUrl: "https://i.etsystatic.com/sample.jpg",
            alt: "Pink personalized pillow",
            included: true,
          }],
          variants: [{ label: "Size", options: [{ label: "Select an option" }, { label: "16 × 16" }, { label: "18 × 18" }] }],
          productInformation: [],
          contentBlocks: [{
            kind: "description",
            text: "A custom pillow cover for nursery and dorm rooms. CARE INSTRUCTIONS Spot clean only. Please Select a size.",
            sourceSelector: "#description",
          }],
          missingFields: [],
          diagnostics: [],
          captureStatus: "partial",
          capturedAt: "2026-07-19T00:00:00.000Z",
        },
      },
    ];

    const html = renderToStaticMarkup(
      <ResearchProductDossier
        item={{
          platform: "etsy",
          marketplace: "www.etsy.com",
          normalizedUrl: "https://www.etsy.com/listing/123/sample",
          latestTitle: "Personalized Name Pillow",
        }}
        snapshots={snapshots}
        loading={false}
        error={null}
      />,
    );

    expect(html).toContain("https://i.etsystatic.com/sample.jpg");
    expect(html).toContain("Personalized Name Pillow");
    expect(html).toContain("Punch needle embroidery");
    expect(html).toContain("Aug 6-17");
    expect(html).toContain("Aug 6-17 · 约 18–29 天");
    expect(html).toContain("4,034");
    expect(html).toContain(">4.8<");
    expect(html).toContain(">CARE INSTRUCTIONS Spot clean only.<");
    expect(html).toContain("2 OPTIONS");
    expect(html).toContain('aria-label="Size选项"');
    expect(html).not.toContain("Select an option");
    expect(html).not.toContain("处理时间");
    expect(html).toContain("EHunt 商品分析");
    expect(html).toContain("custom tissue paper");
    expect(html).toContain("5.0M");
    expect(html).toContain("209,513.92");
    expect(html).toContain("https://ehunt.ai/product-detail/123");
    expect(html.indexOf("Newer evidence")).toBeLessThan(html.indexOf("Older evidence"));
  });

  it("labels Amazon shipper evidence and platform-unavailable fields accurately", () => {
    const html = renderToStaticMarkup(
      <ResearchProductDossier
        item={{
          platform: "amazon",
          marketplace: "www.amazon.com",
          normalizedUrl: "https://www.amazon.com/dp/B0FQNYXDVY",
          latestTitle: "Custom Hang Tags",
        }}
        snapshots={[
          {
            id: "amazon-snapshot",
            capturedAt: "2026-07-29T00:00:00.000Z",
            status: "complete",
            title: "Custom Hang Tags",
            draft: {
              platform: "amazon",
              parserVersion: "amazon@1.4.0",
              extensionVersion: "0.0.0",
              marketplace: "www.amazon.com",
              sourceUrl: "https://www.amazon.com/dp/B0FQNYXDVY",
              externalId: "B0FQNYXDVY",
              title: "Custom Hang Tags",
              domain: "research",
              price: { raw: "$9.99", amount: 9.99, currency: "USD" },
              rating: 4.5,
              reviewCount: 10,
              taxonomy: [],
              listingPublishedAt: null,
              favoriteCount: null,
              shipping: {
                estimatedDelivery: "August 7 - 17",
                processingTime: "Usually ships within 2 to 3 days.",
                cost: { raw: "$5.99", amount: 5.99, currency: "USD" },
                shipsFrom: "Tesfans Direct",
                destination: "New York 10001",
                sourceSelector:
                  "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
              },
              shop: null,
              reviewSummary: null,
              reviews: [],
              reviewCollection: {
                collectedCount: 0,
                reportedTotal: 10,
                pageCount: 0,
                status: "visible",
                updatedAt: "2026-07-29T00:00:00.000Z",
              },
              bullets: [],
              media: [
                {
                  id: "amazon-main",
                  kind: "image",
                  sourceUrl: "https://m.media-amazon.com/images/I/gallery-main.jpg",
                  included: true,
                },
              ],
              variants: [],
              productInformation: [
                {
                  name: "Item details",
                  items: [
                    { label: "Brand Name", value: "TESFANS", links: [] },
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
                {
                  name: "Customizations",
                  items: [{ label: "Image", value: "2 images", links: [] }],
                },
              ],
              contentBlocks: [],
              missingFields: [],
              diagnostics: [],
              captureStatus: "complete",
              capturedAt: "2026-07-29T00:00:00.000Z",
            },
          },
        ]}
        loading={false}
        error={null}
      />,
    );

    expect(html).toContain("发货方");
    expect(html).toContain("首次上架");
    expect(html).toContain("Tesfans Direct");
    expect(html).toContain("$5.99");
    expect(html).toContain("New York 10001");
    expect(html).toContain("产品参数");
    expect(html).toContain("Brand Name");
    expect(html).toContain("TESFANS");
    expect(html).toContain("Customizations");
    expect(html).toContain("2 images");
    expect(html).toContain("https://www.amazon.com/gp/bestsellers/hpc/723469011");
    expect(html).toContain("3 项");
    expect(html.match(/Amazon 未公开/g)).toHaveLength(2);
  });
});
