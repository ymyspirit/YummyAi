import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { etsyShopParser } from "./etsy-shop.js";

function loadFixture(): Document {
  const fixture = new URL("../../../../tools/fixtures/etsy/shop-full.html", import.meta.url);
  return new JSDOM(readFileSync(fixture, "utf8")).window.document;
}

describe("etsyShopParser", () => {
  it("extracts public shop identity, operating metrics and profile evidence", () => {
    const result = etsyShopParser.parse(
      loadFixture(),
      new URL("https://www.etsy.com/shop/ThePineTroveGifts"),
    );

    expect(result).toMatchObject({
      name: "ThePineTroveGifts",
      externalId: "ThePineTroveGifts",
      location: "South Surrey, Canada",
      rating: 4.8,
      reviewCount: 9800,
      salesCount: 71138,
      activeListingCount: 427,
      admirerCount: 5721,
      openedYear: 2022,
      yearsOnPlatform: 3,
      ownerName: "Kirti Verma Panwar",
      captureStatus: "complete",
    });
    expect(result.badges).toContain("Star Seller");
    expect(result.members).toHaveLength(2);
    expect(result.productionPartners[0]).toContain("manufacturing partner");
    expect(result.shopSections).toEqual([]);
    expect(result.missingFields).toContain("shopSections");
    expect(result.ehuntAnalysis).toBeUndefined();
    expect(result.diagnostics.some((item) => item.field.startsWith("ehunt"))).toBe(false);
  });

  it("only supports public Etsy shop pages", () => {
    expect(etsyShopParser.supports(new URL("https://www.etsy.com/shop/Sample"))).toBe(true);
    expect(etsyShopParser.supports(new URL("https://www.etsy.com/listing/123/item"))).toBe(false);
  });

  it("extracts rating and country-only location from the current Etsy shop header", () => {
    const document = new JSDOM(`
      <main>
        <h1>AnnieGardenBoutique</h1>
        <p class="sb-shop-location">United States</p>
        <div data-highlight="rating">
          <div data-review-ratings-count data-rating="4.9">
            <button aria-label="Rating information"></button>
            <span class="rating-and-reviews-count__avg-rating">4.9</span>
          </div>
          <a href="#reviews">(492)</a>
        </div>
        <div data-highlight="sales">3.3k Sales</div>
        <input aria-label="Search all 8 items" />
      </main>
      <section id="about">Sales 3,324 · On Etsy since 2025</section>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/AnnieGardenBoutique"),
    );

    expect(result).toMatchObject({
      name: "AnnieGardenBoutique",
      location: "United States",
      rating: 4.9,
      reviewCount: 492,
      salesCount: 3324,
      activeListingCount: 8,
      captureStatus: "complete",
    });
    expect(result.missingFields).not.toContain("rating");
    expect(result.missingFields).not.toContain("location");
  });

  it("does not infer a shop location when Etsy omits it from the public shop header", () => {
    const document = new JSDOM(`
      <main>
        <div class="shop-header__info">
          <div>
            <h1 class="shop-name">TheHelloBabyCo</h1>
          </div>
          <div class="shop-details"></div>
          <div class="highlights__container">
            <div data-highlight="rating" data-review-ratings-count data-rating="4.8">
              <a href="#reviews">(50.6k)</a>
            </div>
            <div data-highlight="sales">280.7k sales</div>
            <div data-highlight="on_etsy">6 years on Etsy</div>
          </div>
        </div>
        <input aria-label="Search all 65 items" />
      </main>
      <footer>
        <p>United States | English (US) | $ (USD)</p>
      </footer>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL(
        "https://www.etsy.com/shop/TheHelloBabyCo?ref=shop_profile&listing_id=1445186936",
      ),
    );

    expect(result.location).toBeNull();
    expect(result.missingFields).toContain("location");
    expect(result.diagnostics).toContainEqual({
      field: "location",
      code: "missing",
      message: "The public shop page did not expose location.",
      severity: "warning",
    });
  });

  it("preserves Etsy fractional tenure", () => {
    const document = new JSDOM(`
      <main>
        <h1>JingCustomDesign</h1>
        <p class="sb-shop-location">United States</p>
        <div data-review-ratings-count data-rating="4.8">
          <a href="#reviews">(269)</a>
        </div>
        <div>1.5 years on Etsy</div>
        <a href="/shop/JingCustomDesign/sold">2,276 Sales</a>
        <input aria-label="Search all 64 items" />
      </main>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL(
        "https://www.etsy.com/shop/JingCustomDesign?ref=shop_profile&listing_id=4407674460",
      ),
    );

    expect(result.yearsOnPlatform).toBe(1.5);
    expect(result.parserVersion).toBe("etsy-shop@1.2.0");
    expect(result.captureStatus).toBe("complete");
  });

  it("extracts all Etsy shop tabs in page order and deduplicates repeated section ids", () => {
    const document = new JSDOM(`
      <main>
        <h1>ThePineTroveGifts</h1>
        <div role="tablist">
          ${shopTab("0", "All", "426")}
          ${shopTab("1", "On sale", "426")}
          ${shopTab("39890899", "Punch Needle", "262")}
          ${shopTab("39881570", "Two sided Custom Pillows", "36")}
          ${shopTab("39881594", "Monograms", "21")}
          ${shopTab("39881598", "Organic Baby Products", "6")}
          ${shopTab("40173773", "Ring Bearer Pillows", "20")}
          ${shopTab("39881582", "Baby Sweaters", "19")}
          ${shopTab("39890879", "Baby Blankets", "3")}
          ${shopTab("39890863", "Beaded Custom", "2")}
          ${shopTab("39890873", "Father's Day", "3")}
          ${shopTab("39890881", "Grandparents, Family", "1")}
          ${shopTab("39890885", "Moving, Miss You", "13")}
          ${shopTab("39881596", "Holiday & Seasonal", "34")}
          ${shopTab("39890899", "Punch Needle duplicate", "262")}
        </div>
      </main>
      <section id="about">Sales 71,888</section>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/ThePineTroveGifts?ref=shop_profile#items"),
    );

    expect(result.parserVersion).toBe("etsy-shop@1.2.0");
    expect(result.activeListingCount).toBe(426);
    expect(result.shopSections).toHaveLength(14);
    expect(result.shopSections.slice(0, 3)).toEqual([
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
    ]);
  });

  it("preserves a long section label and diagnoses a missing section count", () => {
    const longName =
      "Personalized heirloom pillows for grandparents, family reunions, and seasonal gifts";
    const document = new JSDOM(`
      <main>
        <h1>LongLabelShop</h1>
        <div role="tablist">
          ${shopTab("0", "All", "12")}
          ${shopTab("987654", longName, "")}
        </div>
      </main>
      <section id="about">Sales 120</section>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/LongLabelShop"),
    );

    expect(result.shopSections[1]).toMatchObject({
      externalId: "987654",
      name: longName,
      listingCount: null,
    });
    expect(result.missingFields).toContain("shopSections.987654.listingCount");
  });

  it("reads the count beside a translated section label without duplicating the name", () => {
    const document = new JSDOM(`
      <main>
        <h1>HappyNapkinsShop</h1>
        <div role="tablist">
          ${shopTab("0", "All", "456")}
          <li role="tab" data-wt-tab data-section-id="56292715">
            <span class="wt-break-word">
              <span data-shop-pretranslations-translation="section-56292715">
                Wedding Napkins
              </span>
              <span
                class="wt-display-none"
                aria-hidden="true"
                data-shop-pretranslations-original="section-56292715"
              >
                Wedding Napkins
              </span>
            </span>
            <span class="wt-mr-md-2">94</span>
          </li>
        </div>
      </main>
      <section id="about">Sales 120</section>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/HappyNapkinsShop"),
    );

    expect(result.shopSections[1]).toMatchObject({
      externalId: "56292715",
      name: "Wedding Napkins",
      listingCount: 94,
    });
    expect(result.missingFields).not.toContain("shopSections.56292715.listingCount");
  });

  it("captures EHunt shop summary values, payments and the active hot-products tab", () => {
    const document = ehuntShopDocument(
      "热销商品",
      `
        <div class="eh-product-box-new">
          <div class="eh-product-box-new-item">
            <img src="https://i.etsystatic.com/1/item.jpg" />
            <div>
              <a class="eh-product-item-title" href="https://ehunt.ai/product-detail/4536973166">
                Personalized embroidered pillowcase
              </a>
              <div class="eh-product-item-sales">总销量: 267</div>
              <div class="eh-product-item-sales">价格: $30.59</div>
            </div>
          </div>
        </div>
      `,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis).toMatchObject({
      provider: "ehunt",
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
      paymentMethods: ["Paypal", "Visa"],
      activeSection: {
        kind: "hot_products",
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
    });
    expect(result.ehuntAnalysis?.weeklyRevenue).not.toHaveProperty("currency");
    expect(result.captureStatus).toBe("complete");
    expect(result.diagnostics.some((item) => item.field.startsWith("ehunt"))).toBe(false);
  });

  it.each([
    ["上新选品", "new_products"],
    ["下架选品", "delisted_products"],
  ] as const)("maps the active %s product tab without visiting another tab", (label, kind) => {
    const document = ehuntShopDocument(
      label,
      `
        <div class="eh-product-box-new">
          <div class="eh-product-box-new-item">
            <a class="eh-product-item-title">Visible current-tab item</a>
            <div class="eh-product-item-sales">总销量: 0</div>
          </div>
        </div>
      `,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis?.activeSection).toMatchObject({
      kind,
      label,
      items: [{ title: "Visible current-tab item", totalSales: { raw: "0", value: 0 } }],
    });
  });

  it("captures abbreviated metrics from the active common-tags tab", () => {
    const document = ehuntShopDocument(
      "常用标签",
      `
        <div class="eh-product-box-new">
          <div class="eh-product-box-new-label">
            <div class="eh-product-item-title"></div>
            <div>
              <div class="is-click">baby shower gift</div>
              <div class="item item-both">频次: 50</div>
              <div class="item item-both">竞争度: 2.0M</div>
              <div class="item item-double-data">浏览量: 54.6M ↑ 17.5M</div>
              <div class="item item-double-data">收藏量: 1.5M ↑ 35.1K</div>
              <div class="item item-double-data">销售: 1.1M ↑ 56.5K</div>
            </div>
          </div>
        </div>
      `,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis?.activeSection).toEqual({
      kind: "common_tags",
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
    });
  });

  it("captures category paths and shares from the active popular-categories tab", () => {
    const document = ehuntShopDocument(
      "热门类目",
      `
        <div class="eh-product-box-new">
          <div><div>
            <div>
              <span class="is-click">Home &amp; Living</span> &gt;
              <span class="is-click">Home Decor</span> &gt;
              <span class="is-click">Wall Decor</span> (50%)
            </div>
            <div>
              <span class="is-click">Weddings</span> &gt;
              <span class="is-click">Gifts</span> (31%)
            </div>
          </div></div>
        </div>
      `,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis?.activeSection).toEqual({
      kind: "popular_categories",
      label: "热门类目",
      items: [
        {
          path: ["Home & Living", "Home Decor", "Wall Decor"],
          sharePercent: 50,
          raw: "Home & Living > Home Decor > Wall Decor (50%)",
        },
        {
          path: ["Weddings", "Gifts"],
          sharePercent: 31,
          raw: "Weddings > Gifts (31%)",
        },
      ],
    });
  });

  it("captures history points only when the active trend tab exposes readable DOM values", () => {
    const document = ehuntShopDocument(
      "历史趋势",
      `
        <div class="eh-product-box-new">
          <div id="history-trend">
            <table>
              <thead><tr><th>周期</th><th>周销量</th><th>周销售额</th></tr></thead>
              <tbody>
                <tr><td>2026-07</td><td>231</td><td>5.4K</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      `,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis?.activeSection).toEqual({
      kind: "history_trend",
      label: "历史趋势",
      points: [
        {
          period: "2026-07",
          values: [
            { label: "周销量", metric: { raw: "231", value: 231 } },
            { label: "周销售额", metric: { raw: "5.4K", value: 5400 } },
          ],
        },
      ],
    });
  });

  it("does not fabricate history points from an opaque canvas chart", () => {
    const document = ehuntShopDocument(
      "历史趋势",
      `<div class="eh-product-box-new"><div id="history-trend"><canvas></canvas></div></div>`,
    );

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/Benzosshopofitems"),
    );

    expect(result.ehuntAnalysis?.activeSection).toBeNull();
    expect(result.ehuntAnalysis?.weeklySales).toEqual({ raw: "231", value: 231 });
  });

  it("omits an empty EHunt mount without changing Etsy diagnostics", () => {
    const document = new JSDOM(`
      <main>
        <h1>EmptyEhuntShop</h1>
        <p class="sb-shop-location">United States</p>
        <div>10 Sales</div>
        <input aria-label="Search all 4 items" />
      </main>
      <div id="etsy-rank-tool-store-table"><div class="eh-store-detail"></div></div>
    `).window.document;

    const result = etsyShopParser.parse(
      document,
      new URL("https://www.etsy.com/shop/EmptyEhuntShop"),
    );

    expect(result.ehuntAnalysis).toBeUndefined();
    expect(result.captureStatus).toBe("complete");
    expect(result.diagnostics.some((item) => item.field.startsWith("ehunt"))).toBe(false);
  });
});

function shopTab(externalId: string, name: string, count: string): string {
  return `
    <li role="tab" data-wt-tab data-section-id="${externalId}">
      <span>${name}</span>
      <span>${count}</span>
    </li>
  `;
}

function ehuntShopDocument(activeTab: string, activeContent: string): Document {
  return new JSDOM(`
    <main>
      <h1>Benzosshopofitems</h1>
      <p class="sb-shop-location">United States</p>
      <div data-review-ratings-count data-rating="4.8"><a href="#reviews">(12)</a></div>
      <div>347 Sales</div>
      <input aria-label="Search all 58 items" />
    </main>
    <div id="etsy-rank-tool-store-table">
      <div class="eh-store-detail">
        ${ehuntValue("开店时间", "2026-06-25")}
        ${ehuntValue("主营类目", "")}
        ${ehuntValue("国家", "美国")}
        ${ehuntValue("周销量", "231")}
        ${ehuntValue("周销售额", "5,430.81")}
        ${ehuntValue("周评论", "0")}
        ${ehuntValue("总销量", "347")}
        ${ehuntValue("总销售额", "8,157.97")}
        ${ehuntValue("总评论", "0")}
        ${ehuntValue("周收藏", "100")}
        ${ehuntValue("商品总数", "58")}
        ${ehuntValue("评星", "0")}
        ${ehuntValue("总收藏", "146")}
        ${ehuntValue("Star Seller", "否")}
        ${ehuntValue("社媒信息", "")}
        <div class="eh-store-detail-content-label">支付方式</div>
        <div class="eh-store-detail-content-value">
          <img src="https://ehunt.ai/icons/payment/Paypal.png" />
          <img src="https://ehunt.ai/icons/payment/Visa.png" />
        </div>
        <label class="el-radio-button is-active">
          <input class="el-radio-button__original-radio" checked />
          <span class="el-radio-button__inner">${activeTab}</span>
        </label>
        ${activeContent}
      </div>
    </div>
  `, { url: "https://www.etsy.com/shop/Benzosshopofitems" }).window.document;
}

function ehuntValue(label: string, value: string): string {
  return `
    <div class="eh-store-detail-content-label">${label}</div>
    <div class="eh-store-detail-content-value">${value}</div>
  `;
}
