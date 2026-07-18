import type {
  CaptureShipping,
  CapturedReview,
  CapturedShopSummary,
  EtsyCaptureDraft,
} from "@yummyai/contracts";

import {
  numberFromText,
  parsePrice,
  PublicPageReader,
  type MarketplaceParser,
  type ParserOptions,
} from "./parser.js";

export const etsyParser: MarketplaceParser = {
  supports(url) {
    return /(^|\.)etsy\.com$/i.test(url.hostname) && /^\/listing\/\d+/i.test(url.pathname);
  },

  parse(document, url, options: ParserOptions = {}): EtsyCaptureDraft {
    const reader = new PublicPageReader(document);
    const includeReviews = options.includeReviews ?? true;
    const externalId =
      url.pathname.match(/^\/listing\/(\d+)/i)?.[1] ??
      reader.attribute("externalId", ['input[name="listing_id"]'], "value") ??
      reader.attribute("externalId", ['meta[property="product:retailer_item_id"]'], "content");
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
    const description =
      reader.contentBlock("description", '#product_details [data-id="description-text"]') ??
      reader.contentBlock("description", '#listing-page-cart [data-id="description-text"]') ??
      reader.contentBlock("description", '[data-id="description-text"]');
    const personalization = reader.contentBlock(
      "personalization",
      "[data-personalization-wrapper]",
    );
    const reviews = includeReviews
      ? reader.contentBlocks("review", [
          '#reviews [data-review-region="review"]',
          "[data-review-text]",
        ])
      : [];
    const bullets = reader.texts("bullets", [
      "#product_details ul.show-icons > li",
      '#product_details [data-id="highlights"] li',
      '[data-selector="listing-page-highlights"] li',
      '[data-id="description-text"] li',
    ]);
    const shipping = extractEtsyShipping(document, currency);
    const shop = extractEtsyShopSummary(document, url);
    const taxonomy = extractEtsyTaxonomy(document, url);
    const listingPublishedAt = extractListingPublishedAt(document);
    const favoriteCount = extractFavoriteCount(document);
    if (!listingPublishedAt) reader.missing("listingPublishedAt");
    if (favoriteCount === null) reader.missing("favoriteCount");
    const capturedReviews = includeReviews ? extractEtsyReviews(document) : [];
    const reviewSummary = includeReviews ? extractEtsyReviewSummary(document) : null;

    return reader.build({
      platform: "etsy",
      parserVersion: "etsy@1.3.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      sourceUrl: url.href,
      externalId: externalId ?? null,
      title,
      domain: "research",
      price: parsePrice(priceRaw, currency),
      rating: null,
      reviewCount: null,
      taxonomy,
      listingPublishedAt,
      favoriteCount,
      shipping,
      shop,
      reviewSummary,
      reviews: capturedReviews,
      reviewCollection: {
        collectedCount: capturedReviews.length,
        reportedTotal: reviewSummary?.reviewCount ?? null,
        pageCount: capturedReviews.length > 0 ? 1 : 0,
        status: "visible",
        updatedAt: new Date().toISOString(),
      },
      bullets,
      media: reader.media(
        [
          '[data-component="listing-page-image-carousel"] .carousel-pane img.carousel-image',
          '[data-component="listing-page-image-carousel"] .carousel-pane video',
          "img[data-carousel-image]",
          "[data-carousel-container] video",
        ],
        { identity: etsyMediaIdentity },
      ),
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

export function extractEtsyReviews(document: Document): CapturedReview[] {
  const nodes = [
    ...document.querySelectorAll<HTMLElement>(
      '#reviews [data-review-region], [role="dialog"] [data-review-region], #reviews [id^="review-text-width-"]',
    ),
  ];
  const unique = new Map<string, CapturedReview>();
  for (const node of nodes) {
    const rawText = normalizeText(node.innerText || node.textContent);
    if (!rawText) continue;
    const stableRegion = node.getAttribute("data-review-region");
    const externalId = stableRegion ?? `visible-${stableTextId(rawText)}`;
    const paragraphTexts = [...node.querySelectorAll("p")]
      .map((paragraph) => normalizeText(paragraph.innerText || paragraph.textContent))
      .filter(Boolean);
    const reviewText = paragraphTexts.at(-1) ?? rawText;
    const rating = numberFromText(
      node.querySelector<HTMLInputElement>('input[name="rating"]')?.value ??
        node.querySelector("[data-stars-svg-container]")?.textContent ??
        rawText,
    );
    const author =
      normalizeText(node.querySelector<HTMLAnchorElement>('a[href*="/people/"]')?.textContent) ||
      null;
    const publishedAt =
      rawText.match(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/,
      )?.[0] ?? null;
    const variants = [...node.querySelectorAll("li")]
      .map((item) => normalizeText(item.textContent))
      .filter((value) => value.includes(":"));
    unique.set(externalId, {
      externalId,
      rating: rating === null ? null : Math.min(rating, 5),
      recommends: /\bRecommends\b/i.test(rawText) ? true : null,
      author,
      publishedAt,
      text: reviewText,
      variants,
      sourceSelector: stableRegion ? `[data-review-region="${stableRegion}"]` : `#${node.id}`,
    });
  }
  return [...unique.values()];
}

function extractEtsyReviewSummary(document: Document) {
  const container = document.querySelector<HTMLElement>("[data-reviews-feature-tags]");
  const reviewsRoot = document.querySelector<HTMLElement>("#reviews");
  if (!container || !reviewsRoot) return null;
  const rootText = normalizeText(reviewsRoot.innerText || reviewsRoot.textContent);
  const tags = [...container.querySelectorAll<HTMLElement>("[data-tag]")]
    .map((tag) => ({
      label: tag.getAttribute("data-tag")?.trim() || normalizeText(tag.textContent),
      category: tag.getAttribute("data-tag-type")?.trim() || null,
    }))
    .filter((tag) => tag.label);
  return {
    label: "What buyers say, summarized by AI",
    tags,
    itemAverage: metricFromText(rootText, "Item average"),
    itemQuality: metricFromText(rootText, "Item quality"),
    shipping: metricFromText(rootText, "Shipping"),
    customerService: metricFromText(rootText, "Customer service"),
    recommendPercent: numberBeforeLabel(rootText, "Buyers recommend"),
    reviewCount: numberFromText(rootText.match(/\(([\d,.]+)\s+reviews?\)/i)?.[1] ?? null),
    sourceSelector: "[data-reviews-feature-tags]",
  };
}

function extractEtsyTaxonomy(document: Document, pageUrl: URL) {
  return [...document.querySelectorAll<HTMLAnchorElement>('main a[href*="catnav_breadcrumb"]')]
    .map((link) => ({
      label: normalizeText(link.textContent),
      url: new URL(link.href, pageUrl).href,
    }))
    .filter((node) => node.label && node.label.toLowerCase() !== "homepage");
}

function extractListingPublishedAt(document: Document): string | null {
  const dateTime = document
    .querySelector<HTMLElement>(
      "[data-listing-date] time[datetime], #product_details time[datetime]",
    )
    ?.getAttribute("datetime");
  if (dateTime) return dateTime;
  const metadataText = extractListingMetadataText(document);
  const metadataDate = metadataText
    .match(/Listed on\s+(.+?)(?=\s+[\d,.]+\s+favou?rites?\b|$)/i)?.[1]
    ?.trim();
  if (metadataDate) return metadataDate;
  const details = normalizeText(document.querySelector("#product_details")?.textContent);
  return (
    details.match(/Listed on\s+([^|]+?)(?=\s+(?:Ships from|Favorites|$))/i)?.[1]?.trim() ?? null
  );
}

function extractFavoriteCount(document: Document): number | null {
  const favoriteLink = document.querySelector<HTMLAnchorElement>('main a[href*="/favoriters"]');
  const linkedCount = numberFromText(normalizeText(favoriteLink?.textContent));
  if (linkedCount !== null) return linkedCount;
  const metadataText = extractListingMetadataText(document);
  const metadataCount = numberFromText(
    metadataText.match(/([\d,.]+)\s+favou?rites?/i)?.[1] ?? null,
  );
  if (metadataCount !== null) return metadataCount;
  const details = normalizeText(document.querySelector("#product_details")?.textContent);
  return numberFromText(details.match(/([\d,.]+)\s+(?:favorites|favourites)/i)?.[1] ?? null);
}

function extractListingMetadataText(document: Document): string {
  const favoriteLink = document.querySelector<HTMLAnchorElement>('main a[href*="/favoriters"]');
  const linkedContainer = favoriteLink?.parentElement?.parentElement;
  const linkedText = normalizeText(linkedContainer?.textContent);
  if (/Listed on/i.test(linkedText)) return linkedText;

  const dateNode = [...document.querySelectorAll<HTMLElement>("main .wt-text-caption")].find(
    (node) => /^Listed on\s+/i.test(normalizeText(node.textContent)),
  );
  return normalizeText(dateNode?.textContent);
}

function metricFromText(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return numberFromText(text.match(new RegExp(`(\\d(?:\\.\\d)?)\\s*${escaped}`, "i"))?.[1] ?? null);
}

function numberBeforeLabel(text: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return numberFromText(
    text.match(new RegExp(`(\\d+(?:\\.\\d+)?)%?\\s*${escaped}`, "i"))?.[1] ?? null,
  );
}

function stableTextId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function extractEtsyShipping(
  document: Document,
  productCurrency: string | null,
): CaptureShipping | null {
  const selector = "#shipping-and-returns-div";
  const container =
    document.querySelector(selector) ?? document.querySelector("[data-shipping-and-returns-div]");
  if (!container) return null;

  const text = normalizeText(container.textContent);
  const estimatedDelivery =
    normalizeText(
      container.querySelector("[data-shipping-estimated-delivery] strong")?.textContent,
    ) ||
    text
      .match(
        /(?:get by|arrives? by|delivery(?: date)?[:\s]+)\s*([^|]+?)(?=\s+(?:Returns|Cost to ship|Ships from|Deliver to)|$)/i,
      )?.[1]
      ?.trim() ||
    null;
  const processingTime =
    normalizeText(container.querySelector("[data-processing-time]")?.textContent).replace(
      /^processing time:\s*/i,
      "",
    ) ||
    text
      .match(/processing time:\s*([^|]+?)(?=\s+(?:Cost to ship|Ships from|Deliver to)|$)/i)?.[1]
      ?.trim() ||
    null;
  const symbol = normalizeText(container.querySelector(".currency-symbol")?.textContent);
  const value = normalizeText(container.querySelector(".currency-value")?.textContent);
  const costMatch = text
    .match(/Cost to ship:\s*([^|]+?)(?=\s+Ships from|\s+Deliver to|$)/i)?.[1]
    ?.trim();
  const costRaw = symbol && value ? `${symbol}${value}` : (costMatch ?? null);
  const shipsFrom = text.match(/Ships from:\s*([^|]+?)(?=\s+Deliver to|$)/i)?.[1]?.trim() ?? null;
  const destination =
    normalizeText(
      container.querySelector("[data-calculate-shipping-cost] button")?.textContent,
    ).replace(/^Deliver to\s*/i, "") ||
    text.match(/Deliver to\s+(.+)$/i)?.[1]?.trim() ||
    null;

  return {
    estimatedDelivery,
    processingTime,
    cost: parsePrice(costRaw, productCurrency ?? currencyFromSymbol(symbol)),
    shipsFrom,
    destination,
    sourceSelector: selector,
  };
}

function extractEtsyShopSummary(document: Document, pageUrl: URL): CapturedShopSummary | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/shop/"]')];
  const link = links.find((candidate) => normalizeText(candidate.textContent)) ?? links[0];
  if (!link) return null;

  const sourceUrl = new URL(link.href, pageUrl).href;
  const externalId = new URL(sourceUrl).pathname.match(/\/shop\/([^/]+)/i)?.[1] ?? null;
  const ownerContainer = document.querySelector("#shop_owners_content_toggle");
  const ownerName =
    [...(ownerContainer?.querySelectorAll("p") ?? [])]
      .map((node) => normalizeText(node.textContent))
      .find((value) => value && !/owner of|following|message|responds/i.test(value)) ?? null;
  const location =
    [...document.querySelectorAll("main p, #shop_owners p")]
      .map((node) => normalizeText(node.textContent))
      .find(
        (value) =>
          value && /,\s*(?:Canada|United States|United Kingdom|Australia|India)$/i.test(value),
      ) ?? null;
  const ratingLabel =
    document.querySelector<HTMLAnchorElement>('a[href="#reviews"]')?.getAttribute("aria-label") ??
    document.querySelector<HTMLAnchorElement>('a[href="#reviews"]')?.textContent ??
    null;
  const documentText = normalizeText(document.querySelector("main")?.textContent);

  return {
    platform: "etsy",
    externalId,
    name: normalizeText(link.textContent) ?? externalId ?? "Etsy shop",
    sourceUrl,
    location,
    ownerName,
    rating: numberFromText(ratingLabel),
    reviewCount: null,
    salesCount: null,
    activeListingCount: null,
    admirerCount: null,
    openedYear: null,
    yearsOnPlatform: null,
    badges: /Star Seller/i.test(documentText) ? ["Star Seller"] : [],
  };
}

function currencyFromSymbol(symbol: string | null): string | null {
  return symbol === "$" ? "USD" : symbol === "£" ? "GBP" : symbol === "€" ? "EUR" : null;
}

function normalizeText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function etsyMediaIdentity(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  if (url.hostname === "i.etsystatic.com" || url.hostname.endsWith(".i.etsystatic.com")) {
    url.search = "";
    url.pathname = url.pathname.replace(/\/il_[^/.]+\.(?=\d)/, "/il_SIZE.");
  }
  return url.href;
}
