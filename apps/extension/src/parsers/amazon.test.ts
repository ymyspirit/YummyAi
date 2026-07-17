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
    expect(result.parserVersion).toBe("amazon@1.0.0");
  });

  it("reports missing fields explicitly instead of throwing", () => {
    const document = new JSDOM("<html><body></body></html>").window.document;
    const result = amazonParser.parse(document, new URL("https://www.amazon.com/dp/B000000001"));

    expect(result.captureStatus).toBe("partial");
    expect(result.missingFields).toEqual(expect.arrayContaining(["title", "media"]));
  });
});
