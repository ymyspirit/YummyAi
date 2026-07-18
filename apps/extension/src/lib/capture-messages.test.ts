import { readFileSync } from "node:fs";

import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

import { capturePublicPage } from "./capture-messages.js";

function loadFixture(): Document {
  const fixture = new URL(
    "../../../../tools/fixtures/etsy/product-personalized.html",
    import.meta.url,
  );
  return new JSDOM(readFileSync(fixture, "utf8")).window.document;
}

const listingUrl = new URL(
  "https://www.etsy.com/listing/1729000001/custom-botanical-recipe-journal",
);

describe("capturePublicPage review inclusion", () => {
  it("excludes all review evidence when the optional review switch is off", () => {
    const response = capturePublicPage(loadFixture(), listingUrl, "test", {
      includeReviews: false,
    });

    expect(response.ok).toBe(true);
    if (!response.ok || response.kind !== "product") return;
    expect(response.draft.reviewSummary).toBeNull();
    expect(response.draft.reviews).toEqual([]);
    expect(response.draft.reviewCollection).toMatchObject({
      collectedCount: 0,
      reportedTotal: null,
      pageCount: 0,
    });
    expect(response.draft.contentBlocks.some((block) => block.kind === "review")).toBe(false);
    expect(response.draft.contentBlocks.some((block) => block.kind === "description")).toBe(true);
  });

  it("keeps review evidence when the user opts in", () => {
    const response = capturePublicPage(loadFixture(), listingUrl, "test", {
      includeReviews: true,
    });

    expect(response.ok).toBe(true);
    if (!response.ok || response.kind !== "product") return;
    expect(response.draft.reviewSummary).not.toBeNull();
    expect(response.draft.reviews).toHaveLength(1);
    expect(response.draft.contentBlocks.some((block) => block.kind === "review")).toBe(true);
  });
});
