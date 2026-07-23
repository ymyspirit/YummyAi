import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResearchTable } from "./research-table";
import { ResearchProductDossier, type ResearchSnapshotView } from "./snapshot-timeline";

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
          snapshots: [
            { id: "snapshot-2", capturedAt: "2026-07-18T00:00:00.000Z", status: "partial", title: "Updated product" },
            { id: "snapshot-1", capturedAt: "2026-07-17T00:00:00.000Z", status: "complete", title: "Original product" },
          ],
        }]}
        nextCursor={null}
      />,
    );

    expect(html).toContain("Personalized Sample Product");
    expect(html).toContain("Sample Studio");
    expect(html).toContain("查看详情");
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
          bullets: ["Punch needle embroidery", "Personalized nursery decor"],
          media: [{
            id: "image-1",
            kind: "image",
            sourceUrl: "https://i.etsystatic.com/sample.jpg",
            alt: "Pink personalized pillow",
            included: true,
          }],
          variants: [{ label: "Size", options: [{ label: "Select an option" }, { label: "16 × 16" }, { label: "18 × 18" }] }],
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
    expect(html.indexOf("Newer evidence")).toBeLessThan(html.indexOf("Older evidence"));
  });
});
