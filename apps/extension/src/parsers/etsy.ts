import type {
  CaptureEhuntAnalysis,
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
      reader.contentBlock(
        "description",
        "[data-product-details-description-text-content]",
      ) ??
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
    if (!shipping) {
      reader.missing("shipping");
    } else {
      if (!shipping.estimatedDelivery) reader.missing("shipping.estimatedDelivery");
      if (!shipping.cost) reader.missing("shipping.cost");
      if (!shipping.shipsFrom) reader.missing("shipping.shipsFrom");
      if (!shipping.destination) reader.missing("shipping.destination");
    }
    if (!shop) reader.missing("shop");
    const capturedReviews = includeReviews ? extractEtsyReviews(document) : [];
    const reviewSummary = extractEtsyReviewSummary(document);
    const rating = reviewSummary?.itemAverage ?? shop?.rating ?? null;
    const reviewCount = reviewSummary?.reviewCount ?? shop?.reviewCount ?? null;
    const ehuntAnalysis = extractEhuntProductAnalysis(document);

    return reader.build({
      platform: "etsy",
      parserVersion: "etsy@1.6.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      sourceUrl: url.href,
      externalId: externalId ?? null,
      title,
      domain: "research",
      price: parsePrice(priceRaw, currency),
      rating,
      reviewCount,
      taxonomy,
      listingPublishedAt,
      favoriteCount,
      shipping,
      shop,
      reviewSummary,
      reviews: capturedReviews,
      reviewCollection: {
        collectedCount: capturedReviews.length,
        reportedTotal: reviewCount,
        pageCount: capturedReviews.length > 0 ? 1 : 0,
        status: "visible",
        updatedAt: new Date().toISOString(),
      },
      ...(ehuntAnalysis ? { ehuntAnalysis } : {}),
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
      productInformation: [],
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

export function extractEhuntProductAnalysis(
  document: Document,
): CaptureEhuntAnalysis | null {
  const sourceSelector = "#etsy-rank-tool-product-table";
  const root = document.querySelector<HTMLElement>(
    `${sourceSelector} .eh-product-detail`,
  );
  if (!root) return null;

  const listingPublishedAt = ehuntValue(root, ["上架时间", "Listing date"]);
  const totalSalesCell = ehuntValueCell(root, ["总销量", "Total sales"]);
  const totalRevenueCell = ehuntValueCell(root, ["总销售额", "Total revenue"]);
  const viewCountCell = ehuntValueCell(root, ["总浏览量", "Total views"]);
  const reviewCountCell = ehuntValueCell(root, ["总评论数", "Total reviews"]);
  const favoriteCountCell = ehuntValueCell(root, ["总收藏", "Total favorites"]);
  const conversionRateCell = ehuntValueCell(root, [
    "平均转化率",
    "Average conversion rate",
  ]);
  const reviewRateCell = ehuntValueCell(root, ["评论率", "Review rate"]);
  const priceCell = ehuntValueCell(root, ["价格", "Price"]);
  const productTypeCell = ehuntValueCell(root, ["商品类型", "Product type"]);
  const shipsFrom = ehuntValue(root, ["发货地", "Ships from"]);
  const otherDataCell = ehuntValueCell(root, ["其它数据", "Other data"]);
  const categoryCell = ehuntValueCell(root, ["类目", "Category"]);
  const tagsCell = ehuntValueCell(root, ["商品标签", "Product tags", "Tags"]);
  const shopNameCell = ehuntValueCell(root, ["店铺名称", "Shop name"]);
  const shopSalesCell = ehuntValueCell(root, ["店铺销量", "Shop sales"]);

  const productTypes = productTypeCell
    ? [...productTypeCell.querySelectorAll<HTMLElement>(":scope > span")]
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean)
    : [];
  const otherValues = otherDataCell
    ? [...otherDataCell.querySelectorAll<HTMLElement>(".eh-etsy-icon > div")]
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean)
    : [];
  const inventoryText = otherValues.find((value) => /(?:库存数|inventory)/i.test(value));
  const categoryPath = categoryCell
    ? [...categoryCell.querySelectorAll<HTMLElement>(":scope > .is-click")]
        .map((node) => normalizeText(node.childNodes[0]?.textContent))
        .filter(Boolean)
    : [];
  const tags = tagsCell
    ? [...tagsCell.querySelectorAll<HTMLElement>(".eh-exe-tags-list-item")]
        .map((node) => {
          const label = normalizeText(
            node.querySelector<HTMLElement>(".el-tooltip__trigger")?.textContent,
          );
          const metricRaw =
            normalizeText(
              node.querySelector<HTMLElement>(".eh-exe-tags-list-item-value")
                ?.textContent,
            ).replace(/^\(|\)$/g, "") || null;
          return label
            ? {
                label,
                metricRaw,
                metricValue: parseAbbreviatedNumber(metricRaw),
              }
            : null;
        })
        .filter((tag): tag is NonNullable<typeof tag> => tag !== null)
    : [];
  const annualTrendUrl =
    root
      .querySelector<HTMLAnchorElement>('a[href*="ehunt.ai/product-detail/"]')
      ?.href.trim() || null;
  const shopName =
    normalizeText(
      shopNameCell?.querySelector<HTMLAnchorElement>('a[href*="ehunt.ai/store-detail/"]')
        ?.textContent,
    ) || ehuntMainValue(shopNameCell);
  const shopRating = numberFromText(
    shopNameCell
      ?.querySelector<HTMLElement>('[aria-label="rating"][aria-valuenow]')
      ?.getAttribute("aria-valuenow") ?? null,
  );
  const priceRaw = ehuntMainValue(priceCell);
  const revenueRaw = ehuntMainValue(totalRevenueCell);
  const revenueDeltaRaw = ehuntGrowthValue(totalRevenueCell);

  const analysis: CaptureEhuntAnalysis = {
    provider: "ehunt",
    sourceSelector,
    listingPublishedAt: listingPublishedAt || null,
    totalSales: numberFromText(ehuntMainValue(totalSalesCell)),
    salesDelta: numberFromText(ehuntGrowthValue(totalSalesCell)),
    totalRevenue: parsePrice(revenueRaw, currencyFromVisibleMoney(priceRaw)),
    revenueDelta: parsePrice(revenueDeltaRaw, currencyFromVisibleMoney(priceRaw)),
    viewCount: numberFromText(ehuntMainValue(viewCountCell)),
    reviewCount: numberFromText(ehuntMainValue(reviewCountCell)),
    reviewDelta: numberFromText(ehuntGrowthValue(reviewCountCell)),
    favoriteCount: numberFromText(ehuntMainValue(favoriteCountCell)),
    favoriteDelta: numberFromText(ehuntGrowthValue(favoriteCountCell)),
    conversionRatePercent: numberFromText(ehuntMainValue(conversionRateCell)),
    reviewRatePercent: numberFromText(ehuntMainValue(reviewRateCell)),
    price: parsePrice(priceRaw, currencyFromVisibleMoney(priceRaw)),
    productTypes,
    shipsFrom: shipsFrom || null,
    badges: otherValues.filter((value) => value !== inventoryText),
    inventoryCount: numberFromText(inventoryText ?? null),
    categoryPath,
    tags,
    annualTrendUrl,
    shopName: shopName || null,
    shopRating,
    shopSalesCount: numberFromText(ehuntMainValue(shopSalesCell)),
    shopSalesDelta: numberFromText(ehuntGrowthValue(shopSalesCell)),
  };

  const hasVisibleEvidence =
    analysis.totalSales !== null ||
    analysis.viewCount !== null ||
    analysis.tags.length > 0 ||
    analysis.shopName !== null;
  return hasVisibleEvidence ? analysis : null;
}

function ehuntValue(root: HTMLElement, labels: readonly string[]): string {
  return ehuntMainValue(ehuntValueCell(root, labels)) ?? "";
}

function ehuntValueCell(
  root: HTMLElement,
  labels: readonly string[],
): HTMLElement | null {
  const normalizedLabels = labels.map((label) => label.toLocaleLowerCase());
  const labelCell = [
    ...root.querySelectorAll<HTMLElement>(".eh-product-detail-content-label"),
  ].find((node) =>
    normalizedLabels.includes(normalizeText(node.textContent).toLocaleLowerCase()),
  );
  return (labelCell?.nextElementSibling as HTMLElement | null | undefined) ?? null;
}

function ehuntMainValue(cell: HTMLElement | null): string | null {
  if (!cell) return null;
  const clone = cell.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      ".eh-product-detail-content-value-growth, .review-analysis-btn, svg, img, button",
    )
    .forEach((node) => node.remove());
  return normalizeText(clone.textContent) || null;
}

function ehuntGrowthValue(cell: HTMLElement | null): string | null {
  return (
    normalizeText(
      cell?.querySelector<HTMLElement>(".eh-product-detail-content-value-growth")
        ?.textContent,
    ) || null
  );
}

function parseAbbreviatedNumber(value: string | null): number | null {
  if (!value) return null;
  const match = value.replaceAll(",", "").match(/(\d+(?:\.\d+)?)\s*([KMB])?/i);
  if (!match) return null;
  const multiplier =
    { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[
      match[2]?.toUpperCase() as "K" | "M" | "B"
    ] ?? 1;
  return Number(match[1]) * multiplier;
}

function currencyFromVisibleMoney(value: string | null): string | null {
  if (!value) return null;
  if (value.includes("$")) return "USD";
  if (value.includes("€")) return "EUR";
  if (value.includes("£")) return "GBP";
  if (value.includes("¥")) return "JPY";
  return null;
}

function extractEtsyReviewSummary(document: Document) {
  const container = document.querySelector<HTMLElement>("[data-reviews-feature-tags]");
  const reviewsRoot = document.querySelector<HTMLElement>("#reviews");
  if (!reviewsRoot) return null;
  const rootText = normalizeText(reviewsRoot.innerText || reviewsRoot.textContent);
  const tags = [...(container?.querySelectorAll<HTMLElement>("[data-tag]") ?? [])]
    .map((tag) => ({
      label: tag.getAttribute("data-tag")?.trim() || normalizeText(tag.textContent),
      category: tag.getAttribute("data-tag-type")?.trim() || null,
    }))
    .filter((tag) => tag.label);
  return {
    label: container ? "What buyers say, summarized by AI" : "Public review summary",
    tags,
    itemAverage: metricFromText(rootText, "Item average"),
    itemQuality: metricFromText(rootText, "Item quality"),
    shipping: metricFromText(rootText, "Shipping"),
    customerService: metricFromText(rootText, "Customer service"),
    recommendPercent: numberBeforeLabel(rootText, "Buyers recommend"),
    reviewCount: numberFromText(rootText.match(/\(([\d,.]+)\s+reviews?\)/i)?.[1] ?? null),
    sourceSelector: container ? "[data-reviews-feature-tags]" : "#reviews",
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
  const primarySelector = "#shipping-and-returns-div";
  const shippingHighlights = document.querySelector('[data-selector="shipping-highlights"]');
  const container =
    document.querySelector(primarySelector) ??
    document.querySelector("[data-shipping-and-returns-div]") ??
    shippingHighlights?.closest("#shipping_and_returns") ??
    shippingHighlights;
  if (!container) return null;

  const text = normalizeText(container.textContent);
  const estimatedDelivery =
    normalizeText(
      container.querySelector("[data-shipping-estimated-delivery] strong")?.textContent,
    ) ||
    text.match(
      /(?:get by|arrives? by|delivery(?: date)?[:\s]+)\s*((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*[-–—]\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?\d{1,2})?(?:,\s*\d{4})?)/i,
    )?.[1]?.trim() ||
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
  const freeShipping =
    /\bfree\s+(?:standard\s+)?(?:shipping|delivery)\b/i.test(text) ||
    /\b(?:shipping|delivery)\s*:\s*free\b/i.test(text);
  const costCurrency = productCurrency ?? currencyFromSymbol(symbol);
  const shipsFrom =
    text
      .match(/Ships from:\s*([^|]+?)(?=\s+(?:Deliver to|There was|Country|Returns)|$)/i)?.[1]
      ?.trim() ?? null;
  const destination =
    normalizeText(
      container.querySelector("[data-calculate-shipping-cost] button")?.textContent,
    ).replace(/^Deliver to\s*/i, "") ||
    normalizeText(
      container.querySelector(
        '[data-content-toggle-uid="data-estimated-shipping-form-fields"]',
      )?.textContent,
    ).replace(/^Deliver to\s*/i, "") ||
    text
      .match(/Deliver to\s+(.+?)(?=\s+(?:There was|Country|Zip code|Submit|Loading)|$)/i)?.[1]
      ?.trim() ||
    null;

  return {
    estimatedDelivery,
    processingTime,
    cost: freeShipping
      ? {
          raw: "Free shipping",
          amount: 0,
          ...(costCurrency ? { currency: costCurrency } : {}),
        }
      : parsePrice(costRaw, costCurrency),
    shipsFrom,
    destination,
    sourceSelector: container.id ? `#${container.id}` : '[data-selector="shipping-highlights"]',
  };
}

function extractEtsyShopSummary(document: Document, pageUrl: URL): CapturedShopSummary | null {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/shop/"]')];
  const link =
    links.find(
      (candidate) =>
        /[?&]ref=shop-header-name(?:&|$)/i.test(candidate.href) &&
        normalizeText(candidate.textContent),
    ) ??
    links.find((candidate) => {
      const externalId = new URL(candidate.href, pageUrl).pathname.match(/\/shop\/([^/]+)/i)?.[1];
      return Boolean(externalId && normalizeText(candidate.textContent) === externalId);
    }) ??
    links.find((candidate) => normalizeText(candidate.textContent)) ??
    links[0];
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
    name: externalId ?? normalizeText(link.textContent) ?? "Etsy shop",
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
