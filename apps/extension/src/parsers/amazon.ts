import type { AmazonCaptureDraft } from "@yummyai/contracts";

import { numberFromText, parsePrice, PublicPageReader, type MarketplaceParser } from "./parser.js";

export const amazonParser: MarketplaceParser = {
  supports(url) {
    return (
      /(^|\.)amazon\.[a-z.]+$/i.test(url.hostname) &&
      /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(url.pathname)
    );
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
    const shippingText = reader.text("shipping", [
      "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
      "#deliveryBlockMessage",
      "#ddmDeliveryMessage",
    ]);
    const shipsFrom = tableValue(document, "Ships from");
    const sellerLink = document.querySelector<HTMLAnchorElement>(
      "#sellerProfileTriggerId, #merchant-info a[href*='seller=']",
    );
    const sellerName = sellerLink?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const sellerUrl = sellerLink ? new URL(sellerLink.href, url).href : null;

    return reader.build({
      platform: "amazon",
      parserVersion: "amazon@1.1.0",
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
      taxonomy: [
        ...document.querySelectorAll<HTMLAnchorElement>("#wayfinding-breadcrumbs_feature_div a"),
      ]
        .map((link) => ({
          label: link.textContent?.replace(/\s+/g, " ").trim() ?? "",
          url: new URL(link.href, url).href,
        }))
        .filter((node) => node.label),
      listingPublishedAt: null,
      favoriteCount: null,
      shipping:
        shippingText || shipsFrom
          ? {
              estimatedDelivery: shippingText,
              processingTime: null,
              cost: /free/i.test(shippingText ?? "")
                ? { raw: "FREE", amount: 0, ...(currency ? { currency } : {}) }
                : null,
              shipsFrom,
              destination: null,
              sourceSelector: "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE",
            }
          : null,
      shop:
        sellerName && sellerUrl
          ? {
              platform: "amazon",
              externalId: new URL(sellerUrl).searchParams.get("seller"),
              name: sellerName,
              sourceUrl: sellerUrl,
              location: null,
              ownerName: null,
              rating: null,
              reviewCount: null,
              salesCount: null,
              activeListingCount: null,
              admirerCount: null,
              openedYear: null,
              yearsOnPlatform: null,
              badges: [],
            }
          : null,
      reviewSummary: null,
      reviews: [],
      reviewCollection: {
        collectedCount: 0,
        reportedTotal: numberFromText(reader.text("reviewCount", ["#acrCustomerReviewText"])),
        pageCount: 0,
        status: "visible",
        updatedAt: new Date().toISOString(),
      },
      bullets: reader.texts("bullets", ["#feature-bullets li .a-list-item"]),
      media,
      variants: reader.variants([
        "#variation_size_name select",
        "#variation_color_name select",
        '[id^="variation_"]',
      ]),
      contentBlocks: [...(aplus ? [aplus] : []), ...reviews],
      capturedAt: new Date().toISOString(),
    }) as AmazonCaptureDraft;
  },
};

function tableValue(document: Document, label: string): string | null {
  for (const row of document.querySelectorAll(
    "#tabular-buybox tr, #tabular-buybox .tabular-buybox-container",
  )) {
    const text = row.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!text.toLowerCase().startsWith(label.toLowerCase())) continue;
    return text.slice(label.length).replace(/^:\s*/, "").trim() || null;
  }
  return null;
}
