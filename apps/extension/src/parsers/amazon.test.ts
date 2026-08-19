import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { amazonParser } from "./amazon.js";

function loadFixture(): Document {
  const fixture = new URL("../../../../tools/fixtures/amazon/product-basic.html", import.meta.url);
  return new JSDOM(readFileSync(fixture, "utf8")).window.document;
}

describe("amazonParser", () => {
  it("extracts title, ASIN, bullets, images, variants and A+ blocks", () => {
    const result = amazonParser.parse(
      loadFixture(),
      new URL("https://www.amazon.com/dp/B000000001"),
    );

    expect(result.platform).toBe("amazon");
    expect(result.externalId).toBe("B000000001");
    expect(result.title).toBe("Personalized Sample Product");
    expect(result.bullets).toHaveLength(3);
    expect(result.media.length).toBeGreaterThan(1);
    expect(result.variants).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "Size" })]),
    );
    expect(result.contentBlocks.some((block) => block.kind === "aplus")).toBe(true);
    expect(result.contentBlocks.filter((block) => block.kind === "review")).toHaveLength(2);
    expect(result.parserVersion).toBe("amazon@1.4.0");
  });

  it("reports missing fields explicitly instead of throwing", () => {
    const document = new JSDOM("<html><body></body></html>").window.document;
    const result = amazonParser.parse(document, new URL("https://www.amazon.com/dp/B000000001"));

    expect(result.captureStatus).toBe("partial");
    expect(result.missingFields).toEqual(expect.arrayContaining(["title", "media"]));
  });

  it("keeps only the current ASIN gallery and parses structured delivery evidence", () => {
    const document = new JSDOM(`
      <html>
        <head><meta name="currency" content="USD"></head>
        <body>
          <input id="ASIN" value="B0FQNYXDVY">
          <span id="productTitle">Custom Hang Tags</span>
          <div id="corePrice_feature_div">
            <span class="a-price"><span class="a-offscreen">$9.99</span></span>
          </div>
          <img id="landingImage" src="https://m.media-amazon.com/images/I/main._AC_SX679_.jpg">
          <div id="altImages">
            <img alt="Product Image" src="https://m.media-amazon.com/images/I/thumb._AC_US40_.jpg">
          </div>
          <div id="aplus">
            <img src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/unrelated.jpg">
          </div>
          <div class="a-carousel">
            <img src="https://images-na.ssl-images-amazon.com/images/I/recommended._AC_UL330_.jpg">
          </div>
          <script>
            P.when('A').register("ImageBlockATF", function(A) {
              var data = {
                'colorImages': { 'initial': [
                  {
                    "hiRes": "https://m.media-amazon.com/images/I/gallery-main._AC_SL1500_.jpg",
                    "thumb": "https://m.media-amazon.com/images/I/thumb-main._AC_US40_.jpg",
                    "variant": "MAIN",
                    "physicalIdForMedia": "gallery-main"
                  },
                  {
                    "hiRes": "https://m.media-amazon.com/images/I/gallery-side._AC_SL1500_.jpg",
                    "thumb": "https://m.media-amazon.com/images/I/thumb-side._AC_US40_.jpg",
                    "variant": "PT01",
                    "physicalIdForMedia": "gallery-side"
                  },
                  {
                    "hiRes": "https://m.media-amazon.com/images/I/gallery-main._AC_SL1500_.jpg",
                    "variant": "PT02"
                  },
                  {
                    "hiRes": "https://m.media-amazon.com/images/I/gallery-main-alternate._AC_SL1000_.jpg",
                    "variant": "PT03",
                    "physicalIdForMedia": "gallery-main"
                  }
                ]}
              };
            });
          </script>
          <div id="mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE">
            <span
              data-csa-c-delivery-price="$5.99"
              data-csa-c-delivery-time="August 7 - 17"
            >$5.99 delivery <span class="a-text-bold">August 7 - 17</span>. Details</span>
          </div>
          <div id="contextualIngressPtLabel_deliveryShortLine">
            Deliver to New York 10001
          </div>
          <div id="availability">In stock. Usually ships within 2 to 3 days.</div>
          <table id="productDetails_detailBullets_sections1">
            <tr>
              <th>Date First Available</th>
              <td>September 11, 2025</td>
            </tr>
          </table>
          <div id="merchantInfoFeature_feature_div">
            <div offer-display-feature-name="desktop-merchant-info">
              <span>Shipper / Seller</span>
            </div>
            <div offer-display-feature-name="desktop-merchant-info">
              <a
                id="sellerProfileTriggerId"
                class="offer-display-feature-text-message"
                href="/gp/help/seller/at-a-glance.html?seller=A3D67GY7IY0ZVD"
              >Tesfans Direct</a>
            </div>
          </div>
        </body>
      </html>
    `, { url: "https://www.amazon.com/dp/B0FQNYXDVY" }).window.document;

    const result = amazonParser.parse(
      document,
      new URL("https://www.amazon.com/dp/B0FQNYXDVY"),
      { includeReviews: false },
    );

    expect(result.media).toHaveLength(3);
    expect(result.media.map((item) => item.sourceUrl)).toEqual([
      "https://m.media-amazon.com/images/I/gallery-main.jpg",
      "https://m.media-amazon.com/images/I/gallery-side.jpg",
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/unrelated.jpg",
    ]);
    expect(result.media.some((item) => /recommended/i.test(item.sourceUrl))).toBe(false);
    expect(result.media.filter((item) => /aplus/i.test(item.sourceUrl))).toHaveLength(1);
    expect(new Set(result.media.map((item) => item.sourceUrl)).size).toBe(result.media.length);
    expect(result.media.every((item) => !/_AC_|US40|thumb/i.test(item.sourceUrl))).toBe(true);
    expect(result.shipping).toEqual({
      estimatedDelivery: "August 7 - 17",
      processingTime: "Usually ships within 2 to 3 days.",
      cost: { raw: "$5.99", amount: 5.99, currency: "USD" },
      shipsFrom: "Tesfans Direct",
      destination: "New York 10001",
      sourceSelector: "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
    });
    expect(result.listingPublishedAt).toBe("September 11, 2025");
  });

  it("extracts and deduplicates high-resolution Basic and Premium A+ images", () => {
    const document = new JSDOM(`
      <html>
        <body>
          <input id="ASIN" value="B000000001">
          <span id="productTitle">A+ Sample Product</span>
          <script>
            P.when('A').register("ImageBlockATF", function(A) {
              var data = {
                'colorImages': { 'initial': [{
                  "hiRes": "https://m.media-amazon.com/images/I/gallery-main._AC_SL1500_.jpg",
                  "physicalIdForMedia": "gallery-main"
                }]}
              };
            });
          </script>

          <div id="aplus_feature_div">
            <div id="aplus" class="aplus-v2">
              <section class="apm-module">
                <img
                  alt="Standard detail"
                  src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-detail.__CR0,0,970,600_PT0_SX970_V1___.jpg"
                >
                <picture>
                  <source
                    srcset="
                      https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-feature._AC_SL600_.jpg 600w,
                      https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-feature._AC_SL1600_.jpg 1600w
                    "
                  >
                  <img
                    alt="Responsive standard feature"
                    data-srcset="https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-feature._AC_SL1600_.jpg 2x"
                    src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-feature._AC_SL400_.jpg"
                  >
                </picture>
                <img
                  alt="Lazy placeholder"
                  src="https://m.media-amazon.com/images/G/01/transparent-pixel.gif"
                >
              </section>
            </div>
          </div>

          <div id="aplusPremium_feature_div">
            <div class="premium-aplus premium-aplus-module">
              <img
                alt="Premium hero"
                data-src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/premium-hero._AC_SL1800_.jpg"
                src="https://m.media-amazon.com/images/G/01/grey-pixel.gif"
              >
              <div
                aria-label="Premium hotspot"
                style="background-image: url('https://m.media-amazon.com/images/S/aplus-media-library-service-media/premium-hotspot._AC_SL1600_.jpg')"
              ></div>
              <img
                alt="Repeated standard detail"
                src="https://images-na.ssl-images-amazon.com/images/S/aplus-media-library-service-media/regular-detail._AC_SL1200_.jpg"
              >
            </div>
          </div>

          <div id="aplusBrandStory_feature_div">
            <div id="aplus" class="aplus-v2">
              <img
                alt="Brand story image"
                src="https://m.media-amazon.com/images/S/aplus-media-library-service-media/brand-story._AC_SL1600_.jpg"
              >
            </div>
          </div>

          <div class="a-carousel">
            <img src="https://m.media-amazon.com/images/I/recommended._AC_UL330_.jpg">
          </div>
        </body>
      </html>
    `, { url: "https://www.amazon.com/dp/B000000001" }).window.document;

    const result = amazonParser.parse(
      document,
      new URL("https://www.amazon.com/dp/B000000001"),
      { includeReviews: false },
    );

    expect(result.media.map((item) => item.sourceUrl)).toEqual([
      "https://m.media-amazon.com/images/I/gallery-main.jpg",
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-detail.jpg",
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/regular-feature.jpg",
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/premium-hero.jpg",
      "https://m.media-amazon.com/images/S/aplus-media-library-service-media/premium-hotspot.jpg",
    ]);
    expect(result.media.slice(1).every((item) => item.alt?.startsWith("Amazon A+ ·"))).toBe(true);
    expect(result.media.some((item) => /pixel|recommended|brand-story/i.test(item.sourceUrl))).toBe(
      false,
    );
    expect(new Set(result.media.map((item) => item.sourceUrl)).size).toBe(result.media.length);
  });

  it("preserves ordered, category-specific Product information parameters and links", () => {
    const document = new JSDOM(`
      <html>
        <body>
          <input id="ASIN" value="B0FQNYXDVY">
          <span id="productTitle">Custom Hang Tags</span>
          <img
            id="landingImage"
            data-old-hires="https://m.media-amazon.com/images/I/gallery-main._AC_SL1500_.jpg"
          >
          <div id="productDetails_feature_div">
            <h1>Product information</h1>
            <section class="a-expander-container a-expander-section-container">
              <span class="a-expander-prompt">Item details</span>
              <table class="prodDetTable">
                <tr><th>Brand Name</th><td>TESFANS</td></tr>
                <tr><th>Unit Count</th><td>1 Count</td></tr>
                <tr>
                  <th>Best Sellers Rank</th>
                  <td>
                    #50,856 in Health &amp; Household
                    (<a href="/gp/bestsellers/hpc">See Top 100 in Health &amp; Household</a>)
                    <a href="/gp/bestsellers/hpc/723469011">#28 in Gift Wrap Tags</a>
                  </td>
                </tr>
                <tr><th>ASIN</th><td>B0FQNYXDVY</td></tr>
                <tr>
                  <th>Customer Reviews</th>
                  <td>4.7 out of 5 stars (403)<script>window.noise = "ignore me";</script></td>
                </tr>
              </table>
            </section>
            <section class="a-expander-container a-expander-section-container">
              <span class="a-expander-prompt">Style</span>
              <table class="prodDetTable">
                <tr><th>Color</th><td>Black</td></tr>
                <tr><th>Pattern</th><td>Customizable</td></tr>
                <tr><th>Style</th><td>Clothes Tag</td></tr>
              </table>
            </section>
            <section class="a-expander-container a-expander-section-container">
              <span class="a-expander-prompt">Measurements</span>
              <table class="prodDetTable">
                <tr><th>Size</th><td>Small</td></tr>
                <tr><th>Number of Labels</th><td>100</td></tr>
              </table>
            </section>
            <section class="a-expander-container a-expander-section-container">
              <span class="a-expander-prompt">Customizations</span>
              <table class="prodDetTable">
                <tr><th>Color</th><td>Black, Blue, Green, Light Green, and more</td></tr>
                <tr><th>Material</th><td>Gloss (Waterproof), Matte (Writable)</td></tr>
                <tr><th>Item Shape</th><td>Circle, Rectangle, Rounded Rectangle</td></tr>
                <tr><th>Text</th><td>5 text inputs</td></tr>
                <tr><th>Image</th><td>2 images</td></tr>
              </table>
            </section>
          </div>
        </body>
      </html>
    `, { url: "https://www.amazon.com/dp/B0FQNYXDVY" }).window.document;

    const result = amazonParser.parse(
      document,
      new URL("https://www.amazon.com/dp/B0FQNYXDVY"),
      { includeReviews: false },
    );

    expect(result.productInformation.map((section) => section.name)).toEqual([
      "Item details",
      "Style",
      "Measurements",
      "Customizations",
    ]);
    expect(result.productInformation.map((section) => section.items.length)).toEqual([5, 3, 2, 5]);
    expect(result.productInformation[0]?.items[0]).toEqual({
      label: "Brand Name",
      value: "TESFANS",
      links: [],
    });
    expect(result.productInformation[0]?.items[2]?.links).toEqual([
      {
        label: "See Top 100 in Health & Household",
        url: "https://www.amazon.com/gp/bestsellers/hpc",
      },
      {
        label: "#28 in Gift Wrap Tags",
        url: "https://www.amazon.com/gp/bestsellers/hpc/723469011",
      },
    ]);
    expect(result.productInformation[0]?.items[4]?.value).toBe("4.7 out of 5 stars (403)");
    expect(
      result.productInformation.flatMap((section) => section.items).some(
        (item) => /ignore me|window\.noise/.test(item.value),
      ),
    ).toBe(false);
  });

  it("falls back to legacy specification tables and detail bullets", () => {
    const document = new JSDOM(`
      <html>
        <body>
          <input id="ASIN" value="B000000001">
          <span id="productTitle">Legacy Product</span>
          <img
            id="landingImage"
            data-old-hires="https://m.media-amazon.com/images/I/legacy-main.jpg"
          >
          <table id="productDetails_techSpec_section_1">
            <tr><th>Product Dimensions</th><td>10 x 8 x 2 inches</td></tr>
            <tr><th>Material</th><td>Cast iron</td></tr>
          </table>
          <table id="productDetails_detailBullets_sections1">
            <tr><th>Date First Available</th><td>January 2, 2024</td></tr>
          </table>
          <div id="detailBullets_feature_div">
            <h2>Product details</h2>
            <ul>
              <li>
                <span class="a-text-bold">Country of Origin :</span>
                USA
              </li>
            </ul>
          </div>
        </body>
      </html>
    `, { url: "https://www.amazon.com/dp/B000000001" }).window.document;

    const result = amazonParser.parse(
      document,
      new URL("https://www.amazon.com/dp/B000000001"),
      { includeReviews: false },
    );

    expect(result.productInformation).toEqual([
      {
        name: "Technical details",
        items: [
          { label: "Product Dimensions", value: "10 x 8 x 2 inches", links: [] },
          { label: "Material", value: "Cast iron", links: [] },
        ],
      },
      {
        name: "Additional information",
        items: [{ label: "Date First Available", value: "January 2, 2024", links: [] }],
      },
      {
        name: "Product details",
        items: [{ label: "Country of Origin", value: "USA", links: [] }],
      },
    ]);
    expect(result.listingPublishedAt).toBe("January 2, 2024");
  });
});
