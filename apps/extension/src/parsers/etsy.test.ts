import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { etsyParser } from "./etsy.js";

function loadFixture(): Document {
  const fixture = new URL(
    "../../../../tools/fixtures/etsy/product-personalized.html",
    import.meta.url,
  );
  return new JSDOM(readFileSync(fixture, "utf8")).window.document;
}

describe("etsyParser", () => {
  it("extracts listing identity, media, variants and personalization", () => {
    const result = etsyParser.parse(
      loadFixture(),
      new URL("https://www.etsy.com/listing/1729000001/custom-botanical-recipe-journal"),
    );

    expect(result.platform).toBe("etsy");
    expect(result.externalId).toBe("1729000001");
    expect(result.title).toBe("Custom Botanical Recipe Journal");
    expect(result.parserVersion).toBe("etsy@1.6.0");
    expect(result.ehuntAnalysis).toBeUndefined();
    expect(result.media).toHaveLength(4);
    expect(result.media.filter((item) => item.kind === "image")).toHaveLength(3);
    expect(result.media.filter((item) => item.kind === "video")).toHaveLength(1);
    expect(result.media.every((item) => !item.sourceUrl.includes("75x75"))).toBe(true);
    expect(result.bullets).toEqual([
      "Designed by BotanicalBookCo",
      "Materials: Natural linen and recycled paper",
    ]);
    expect(result.variants[0]).toMatchObject({ label: "Cover material" });
    expect(result.contentBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "personalization" })]),
    );
    expect(result.contentBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "review" })]),
    );
    expect(result.shipping).toEqual({
      estimatedDelivery: "Aug 6-17",
      processingTime: null,
      cost: { raw: "$5.99", amount: 5.99, currency: "USD" },
      shipsFrom: "Troy, MI",
      destination: "United States, 90060",
      sourceSelector: "#shipping-and-returns-div",
    });
    expect(result.shop).toMatchObject({
      externalId: "BotanicalBookCo",
      name: "BotanicalBookCo",
      ownerName: "Lin",
    });
    expect(result.taxonomy.map((node) => node.label)).toEqual([
      "Home & Living",
      "Home Decor",
      "Throw Pillows",
    ]);
    expect(result.listingPublishedAt).toBe("Jul 18, 2026");
    expect(result.favoriteCount).toBe(4034);
    expect(result.reviewSummary).toMatchObject({
      tags: [{ label: "Great quality", category: "Quality" }],
      itemAverage: 4.8,
      recommendPercent: 95,
      reviewCount: 12,
    });
    expect(result.rating).toBe(4.8);
    expect(result.reviewCount).toBe(12);
    expect(result.reviews).toHaveLength(1);
    expect(result.missingFields).not.toEqual(
      expect.arrayContaining(["listingPublishedAt", "favoriteCount"]),
    );
  });

  it("keeps public rating and review totals when full review collection is disabled", () => {
    const result = etsyParser.parse(
      loadFixture(),
      new URL("https://www.etsy.com/listing/1729000001/custom-botanical-recipe-journal"),
      { includeReviews: false },
    );

    expect(result.rating).toBe(4.8);
    expect(result.reviewCount).toBe(12);
    expect(result.reviewCollection).toMatchObject({ collectedCount: 0, reportedTotal: 12 });
    expect(result.reviews).toHaveLength(0);
  });

  it("captures a visible EHunt product analysis panel when present", () => {
    const document = new JSDOM(`
      <main>
        <h1 data-buy-box-listing-title>Custom Logo Tissue Paper</h1>
        <div data-buy-box-region="price"><p>$16.94+</p></div>
        <div id="etsy-rank-tool-product-table">
          <div class="eh-product-detail">
            <a href="https://ehunt.ai?utm_source=chrome">EHunt - Etsy Rank Tool</a>
            <table class="eh-product-detail-content">
              <tr>
                <td class="eh-product-detail-content-label">上架时间</td>
                <td class="eh-product-detail-content-value">2021-06-24</td>
                <td class="eh-product-detail-content-label">总销量</td>
                <td class="eh-product-detail-content-value">
                  <span class="el-tooltip__trigger">12,368</span>
                  <span class="eh-product-detail-content-value-growth">47</span>
                </td>
                <td class="eh-product-detail-content-label">总销售额</td>
                <td class="eh-product-detail-content-value">
                  <span class="el-tooltip__trigger">209,513.92</span>
                  <span class="eh-product-detail-content-value-growth">796.18</span>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">总浏览量</td>
                <td class="eh-product-detail-content-value">255,481</td>
                <td class="eh-product-detail-content-label">总评论数</td>
                <td class="eh-product-detail-content-value">
                  <span class="el-tooltip__trigger">1,800</span>
                  <span class="eh-product-detail-content-value-growth">2</span>
                  <span class="review-analysis-btn">AI评论分析</span>
                </td>
                <td class="eh-product-detail-content-label">总收藏</td>
                <td class="eh-product-detail-content-value">
                  <span class="el-tooltip__trigger">11,930</span>
                  <span class="eh-product-detail-content-value-growth">44</span>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">平均转化率</td>
                <td class="eh-product-detail-content-value">4.84%</td>
                <td class="eh-product-detail-content-label">评论率</td>
                <td class="eh-product-detail-content-value">14.55%</td>
                <td class="eh-product-detail-content-label">价格</td>
                <td class="eh-product-detail-content-value">$ 16.94+</td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">商品类型</td>
                <td class="eh-product-detail-content-value">
                  <span>Handmade</span><span>Customizable</span>
                </td>
                <td class="eh-product-detail-content-label">发货地</td>
                <td class="eh-product-detail-content-value">美国</td>
                <td class="eh-product-detail-content-label">其它数据</td>
                <td class="eh-product-detail-content-value">
                  <div class="eh-etsy-icon">
                    <div class="icon-is-click">BestSeller</div>
                    <div class="green-icon">库存数 : 991</div>
                  </div>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">类目</td>
                <td class="eh-product-detail-content-value">
                  <span class="is-click">Paper &amp; Party Supplies<span> &gt; </span></span>
                  <span class="is-click">Paper<span> &gt; </span></span>
                  <span class="is-click">Gift Wrapping</span>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">历史趋势</td>
                <td class="eh-product-detail-content-value">
                  <a href="https://ehunt.ai/product-detail/1041388929?utm_source=chrome">查看年度历史趋势</a>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">商品标签</td>
                <td class="eh-product-detail-content-value">
                  <div class="eh-exe-tags-list">
                    <div class="eh-exe-tags-list-item">
                      <div class="el-tooltip__trigger">custom tissue paper</div>
                      <div class="eh-exe-tags-list-item-value">(5.0M)</div>
                    </div>
                    <div class="eh-exe-tags-list-item">
                      <div class="el-tooltip__trigger">custom logo wrapping</div>
                      <div class="eh-exe-tags-list-item-value">(22.1M)</div>
                    </div>
                  </div>
                </td>
              </tr>
              <tr>
                <td class="eh-product-detail-content-label">店铺名称</td>
                <td class="eh-product-detail-content-value">
                  <a href="https://ehunt.ai/store-detail/CoacoUSA">CoacoUSA</a>
                  <div aria-label="rating" aria-valuenow="4.9"></div>
                </td>
                <td class="eh-product-detail-content-label">店铺销量</td>
                <td class="eh-product-detail-content-value">
                  <span>174,083</span>
                  <span class="eh-product-detail-content-value-growth">2,048</span>
                </td>
              </tr>
            </table>
          </div>
        </div>
      </main>
    `, {
      url: "https://www.etsy.com/listing/1041388929/personalized-tissue-paper-custom-logo",
    }).window.document;

    const result = etsyParser.parse(
      document,
      new URL(
        "https://www.etsy.com/listing/1041388929/personalized-tissue-paper-custom-logo",
      ),
      { includeReviews: false },
    );

    expect(result.ehuntAnalysis).toMatchObject({
      provider: "ehunt",
      listingPublishedAt: "2021-06-24",
      totalSales: 12368,
      salesDelta: 47,
      totalRevenue: { amount: 209513.92, currency: "USD" },
      revenueDelta: { amount: 796.18, currency: "USD" },
      viewCount: 255481,
      reviewCount: 1800,
      reviewDelta: 2,
      favoriteCount: 11930,
      favoriteDelta: 44,
      conversionRatePercent: 4.84,
      reviewRatePercent: 14.55,
      price: { amount: 16.94, currency: "USD" },
      productTypes: ["Handmade", "Customizable"],
      shipsFrom: "美国",
      badges: ["BestSeller"],
      inventoryCount: 991,
      categoryPath: ["Paper & Party Supplies", "Paper", "Gift Wrapping"],
      tags: [
        { label: "custom tissue paper", metricRaw: "5.0M", metricValue: 5000000 },
        { label: "custom logo wrapping", metricRaw: "22.1M", metricValue: 22100000 },
      ],
      shopName: "CoacoUSA",
      shopRating: 4.9,
      shopSalesCount: 174083,
      shopSalesDelta: 2048,
    });
  });

  it("only supports public Etsy listing pages", () => {
    expect(
      etsyParser.supports(new URL("https://www.etsy.com/listing/1729000001/sample"), loadFixture()),
    ).toBe(true);
    expect(
      etsyParser.supports(
        new URL("https://www.etsy.com/your/shops/me/tools/listings"),
        loadFixture(),
      ),
    ).toBe(false);
  });

  it("preserves public description structure and removes variant placeholders", () => {
    const document = new JSDOM(`
      <main>
        <h1 data-buy-box-listing-title>Custom Design Napkins</h1>
        <div data-buy-box-region="price"><p>Price: $3.39+</p></div>
        <div id="product_details">
          <div data-id="description-text">
            <p data-product-details-description-text-content>
              Intro line<br><br>PLEASE NOTE:<br>Keep the safe zone.<br><br>
              SIZES:<br>Cocktail: 4.75 inches<br>Luncheon: 6.5 inches
            </p>
            <button>Less</button>
          </div>
        </div>
        <div data-selector="listing-page-variations">
          <label for="size-select">Size</label>
          <select id="size-select">
            <option value="">Select an option</option>
            <option value="5507674033">Cocktail ($3.39 - $585.00)</option>
            <option value="5507674079">Luncheon ($3.49 - $735.00)</option>
          </select>
        </div>
        <div data-component="listing-page-image-carousel">
          <div class="carousel-pane">
            <img class="carousel-image" src="https://i.etsystatic.com/123/il_794xN.456.jpg">
          </div>
        </div>
      </main>
    `, { url: "https://www.etsy.com/listing/4326952894/custom-design-napkins" }).window.document;

    const result = etsyParser.parse(
      document,
      new URL("https://www.etsy.com/listing/4326952894/custom-design-napkins"),
      { includeReviews: false },
    );

    expect(
      result.contentBlocks.find((block) => block.kind === "description")?.text,
    ).toBe(
      [
        "Intro line",
        "",
        "PLEASE NOTE:",
        "Keep the safe zone.",
        "",
        "SIZES:",
        "Cocktail: 4.75 inches",
        "Luncheon: 6.5 inches",
      ].join("\n"),
    );
    expect(
      result.contentBlocks.find((block) => block.kind === "description")?.text,
    ).not.toContain("Less");
    expect(result.variants).toEqual([
      {
        label: "Size",
        options: [
          {
            externalId: "5507674033",
            label: "Cocktail ($3.39 - $585.00)",
          },
          {
            externalId: "5507674079",
            label: "Luncheon ($3.49 - $735.00)",
          },
        ],
      },
    ]);
  });

  it("records explicit free shipping as zero cost without a missing-field warning", () => {
    const document = new JSDOM(`
      <head>
        <meta property="product:price:currency" content="USD">
      </head>
      <main>
        <h1 data-buy-box-listing-title>Round Hang Tag</h1>
        <div data-buy-box-region="price"><p>$37.00</p></div>
        <div id="shipping-and-returns-div">
          <div data-selector="shipping-highlights">
            <div data-shipping-estimated-delivery><strong>Aug 3-8</strong></div>
            <div>Free shipping</div>
            <div>Ships from: Pelham, AL</div>
            <button data-calculate-shipping-cost>Deliver to United States, 90001</button>
          </div>
        </div>
        <div data-component="listing-page-image-carousel">
          <div class="carousel-pane">
            <img class="carousel-image" src="https://i.etsystatic.com/123/il_794xN.789.jpg">
          </div>
        </div>
      </main>
    `, { url: "https://www.etsy.com/listing/1577307459/round-hang-tag" }).window.document;

    const result = etsyParser.parse(
      document,
      new URL("https://www.etsy.com/listing/1577307459/round-hang-tag"),
      { includeReviews: false },
    );

    expect(result.shipping?.cost).toEqual({
      raw: "Free shipping",
      amount: 0,
      currency: "USD",
    });
    expect(result.missingFields).not.toContain("shipping.cost");
  });
});
