import type { AmazonCaptureDraft } from "@yummyai/contracts";

import {
  numberFromText,
  parsePrice,
  PublicPageReader,
  type MarketplaceParser,
} from "./parser.js";

export const amazonParser: MarketplaceParser = {
  supports(url) {
    return /(^|\.)amazon\.[a-z.]+$/i.test(url.hostname) && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(url.pathname);
  },

  parse(document, url): AmazonCaptureDraft {
    const reader = new PublicPageReader(document);
    const externalId =
      reader.attribute("externalId", ["#ASIN", 'input[name="ASIN"]'], "value") ??
      url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] ??
      null;
    if (!externalId) reader.missing("externalId");

    const title = reader.text("title", ["#productTitle", "#title span"], true);
    const priceRaw = reader.text("price", [
      "#corePrice_feature_div .a-price .a-offscreen",
      "#priceblock_ourprice",
      ".priceToPay .a-offscreen",
    ]);
    const currency = reader.attribute("price.currency", ['meta[name="currency"]'], "content");
    const media = reader.media([
      "#landingImage",
      "#altImages img",
      "#aplus img",
      ".a-carousel img",
    ]);
    const aplus = reader.contentBlock("aplus", "#aplus");
    const reviews = reader.contentBlocks("review", [
      '#cm-cr-dp-review-list [data-hook="review"]',
      '[data-hook="review-collapsed"]',
    ]);

    return reader.build({
      platform: "amazon",
      parserVersion: "amazon@1.0.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      sourceUrl: url.href,
      externalId,
      title,
      domain: "research",
      price: parsePrice(priceRaw, currency),
      rating: numberFromText(
        reader.attribute("rating", ["#acrPopover"], "title") ??
          reader.text("rating", ["#acrPopover .a-icon-alt"]),
      ),
      reviewCount: numberFromText(reader.text("reviewCount", ["#acrCustomerReviewText"])),
      bullets: reader.texts("bullets", ["#feature-bullets li .a-list-item"]),
      media,
      variants: reader.variants([
        '#variation_size_name select',
        '#variation_color_name select',
        '[id^="variation_"]',
      ]),
      contentBlocks: [...(aplus ? [aplus] : []), ...reviews],
      capturedAt: new Date().toISOString(),
    }) as AmazonCaptureDraft;
  },
};
