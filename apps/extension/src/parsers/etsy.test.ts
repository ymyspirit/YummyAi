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
    expect(result.parserVersion).toBe("etsy@1.3.0");
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
    expect(result.reviews).toHaveLength(1);
    expect(result.missingFields).not.toEqual(
      expect.arrayContaining(["listingPublishedAt", "favoriteCount"]),
    );
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
});
