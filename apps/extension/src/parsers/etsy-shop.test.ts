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
  });

  it("only supports public Etsy shop pages", () => {
    expect(etsyShopParser.supports(new URL("https://www.etsy.com/shop/Sample"))).toBe(true);
    expect(etsyShopParser.supports(new URL("https://www.etsy.com/listing/123/item"))).toBe(false);
  });
});
