import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { etsyParser } from "./etsy.js";

function loadFixture(): Document {
  const fixture = new URL("../../../../tools/fixtures/etsy/product-personalized.html", import.meta.url);
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
    expect(result.media).toHaveLength(3);
    expect(result.variants[0]).toMatchObject({ label: "Cover material" });
    expect(result.contentBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "personalization" })]),
    );
    expect(result.contentBlocks).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "review" })]),
    );
  });

  it("only supports public Etsy listing pages", () => {
    expect(
      etsyParser.supports(new URL("https://www.etsy.com/listing/1729000001/sample"), loadFixture()),
    ).toBe(true);
    expect(
      etsyParser.supports(new URL("https://www.etsy.com/your/shops/me/tools/listings"), loadFixture()),
    ).toBe(false);
  });
});
