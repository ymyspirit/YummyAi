import type { EtsyCaptureDraft } from "@yummyai/contracts";

import { parsePrice, PublicPageReader, type MarketplaceParser } from "./parser.js";

export const etsyParser: MarketplaceParser = {
  supports(url) {
    return /(^|\.)etsy\.com$/i.test(url.hostname) && /^\/listing\/\d+/i.test(url.pathname);
  },

  parse(document, url): EtsyCaptureDraft {
    const reader = new PublicPageReader(document);
    const externalId =
      url.pathname.match(/^\/listing\/(\d+)/i)?.[1] ??
      reader.attribute("externalId", ['input[name="listing_id"]'], "value") ??
      reader.attribute(
        "externalId",
        ['meta[property="product:retailer_item_id"]'],
        "content",
      );
    if (!externalId) reader.missing("externalId");

    const title = reader.text(
      "title",
      ["h1[data-buy-box-listing-title]", 'h1[data-selector="listing-page-title"]', "h1"],
      true,
    );
    const priceRaw = reader.text("price", [
      '[data-buy-box-region="price"] p',
      '[data-buy-box-region="price"]',
      '[data-selector="price-only"]',
    ]);
    const currency = reader.attribute(
      "price.currency",
      ['meta[property="product:price:currency"]'],
      "content",
    );
    const description = reader.contentBlock(
      "description",
      '#listing-page-cart [data-id="description-text"]',
    );
    const personalization = reader.contentBlock(
      "personalization",
      "[data-personalization-wrapper]",
    );
    const reviews = reader.contentBlocks("review", [
      '#reviews [data-review-region="review"]',
      '[data-review-text]',
    ]);

    return reader.build({
      platform: "etsy",
      parserVersion: "etsy@1.0.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      sourceUrl: url.href,
      externalId: externalId ?? null,
      title,
      domain: "research",
      price: parsePrice(priceRaw, currency),
      rating: null,
      reviewCount: null,
      bullets: [],
      media: reader.media([
        "img[data-carousel-image]",
        '[data-listing-card-listing-image] img',
        '[data-component="listing-page-image-carousel"] img',
      ]),
      variants: reader.variants([
        '[data-selector="listing-page-variations"] select',
        '[data-buy-box-region="variations"] select',
      ]),
      contentBlocks: [
        ...[description, personalization].filter(
          (block): block is NonNullable<typeof block> => block !== null,
        ),
        ...reviews,
      ],
      capturedAt: new Date().toISOString(),
    }) as EtsyCaptureDraft;
  },
};
