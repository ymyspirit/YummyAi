import type {
  AmazonCaptureDraft,
  CaptureProductInformationSection,
  CaptureShipping,
} from "@yummyai/contracts";

import {
  numberFromText,
  parsePrice,
  PublicPageReader,
  type MarketplaceParser,
  type ParserOptions,
} from "./parser.js";

export const amazonParser: MarketplaceParser = {
  supports(url) {
    return (
      /(^|\.)amazon\.[a-z.]+$/i.test(url.hostname) &&
      /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(url.pathname)
    );
  },

  parse(document, url, options: ParserOptions = {}): AmazonCaptureDraft {
    const reader = new PublicPageReader(document);
    const includeReviews = options.includeReviews ?? true;
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
    const galleryMedia = extractAmazonGalleryMedia(document, title);
    const aplusMedia = extractAmazonAPlusMedia(document);
    const media =
      galleryMedia.length > 0 || aplusMedia.length > 0
        ? dedupeAmazonMedia([...galleryMedia, ...aplusMedia])
        : reader.media(["#landingImage", "#altImages img"]);
    const aplus = reader.contentBlock("aplus", AMAZON_APLUS_ROOT_SELECTOR);
    const reviews = includeReviews
      ? reader.contentBlocks("review", [
          '#cm-cr-dp-review-list [data-hook="review"]',
          '[data-hook="review-collapsed"]',
        ])
      : [];
    const rating = includeReviews
      ? numberFromText(
          reader.attribute("rating", ["#acrPopover"], "title") ??
            reader.text("rating", ["#acrPopover .a-icon-alt"]),
        )
      : null;
    const reviewCount = includeReviews
      ? numberFromText(reader.text("reviewCount", ["#acrCustomerReviewText"]))
      : null;
    const sellerLink = document.querySelector<HTMLAnchorElement>(
      "#sellerProfileTriggerId, #merchant-info a[href*='seller=']",
    );
    const sellerName = sellerLink?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const sellerUrl = sellerLink ? new URL(sellerLink.href, url).href : null;
    const shipping = extractAmazonShipping(document, currency, sellerName);
    const productInformation = extractAmazonProductInformation(document, url);
    const listingPublishedAt =
      amazonDetailValue(document, "Date First Available") ??
      productInformation
        .flatMap((section) => section.items)
        .find((item) => item.label.toLowerCase() === "date first available")
        ?.value ??
      null;

    return reader.build({
      platform: "amazon",
      parserVersion: "amazon@1.4.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      sourceUrl: url.href,
      externalId,
      title,
      domain: "research",
      price: parsePrice(priceRaw, currency),
      rating,
      reviewCount,
      taxonomy: [
        ...document.querySelectorAll<HTMLAnchorElement>("#wayfinding-breadcrumbs_feature_div a"),
      ]
        .map((link) => ({
          label: link.textContent?.replace(/\s+/g, " ").trim() ?? "",
          url: new URL(link.href, url).href,
        }))
        .filter((node) => node.label),
      listingPublishedAt,
      favoriteCount: null,
      shipping,
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
        reportedTotal: reviewCount,
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
      productInformation,
      contentBlocks: [...(aplus ? [aplus] : []), ...reviews],
      capturedAt: new Date().toISOString(),
    }) as AmazonCaptureDraft;
  },
};

interface AmazonGalleryImage {
  altText?: unknown;
  hiRes?: unknown;
  large?: unknown;
  main?: unknown;
  physicalIdForMedia?: unknown;
  thumb?: unknown;
  variant?: unknown;
}

const AMAZON_APLUS_ROOT_SELECTOR =
  "#aplus, #aplus_feature_div, #aplusPremium_feature_div";
const AMAZON_BRAND_STORY_SELECTOR =
  "#aplusBrandStory_feature_div, #brandStory_feature_div";

function extractAmazonGalleryMedia(
  document: Document,
  title: string | null,
): AmazonCaptureDraft["media"] {
  const scriptedImages = extractInitialGalleryImages(document);
  const candidates =
    scriptedImages.length > 0
      ? scriptedImages.map((image, index) => ({
          sourceUrl:
            stringValue(image.hiRes) ??
            largestImageUrl(image.main),
          alt:
            stringValue(image.altText) ??
            `${title ?? "Amazon product"} · ${stringValue(image.variant) ?? index + 1}`,
          physicalId: stringValue(image.physicalIdForMedia),
        }))
      : [
          ...document.querySelectorAll<HTMLImageElement>("#landingImage, #altImages img"),
        ].map((image, index) => ({
          sourceUrl:
            image.getAttribute("data-old-hires") ??
            largestDynamicImageUrl(image.getAttribute("data-a-dynamic-image")),
          alt: image.getAttribute("alt")?.trim() || `${title ?? "Amazon product"} · ${index + 1}`,
          physicalId: null,
        }));

  const unique = new Map<string, AmazonCaptureDraft["media"][number]>();
  const seenPhysicalIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.sourceUrl) continue;
    let sourceUrl: string;
    try {
      sourceUrl = normalizeAmazonImageUrl(new URL(candidate.sourceUrl, document.baseURI).href);
    } catch {
      continue;
    }
    if (
      !/^https?:\/\//i.test(sourceUrl) ||
      unique.has(sourceUrl) ||
      (candidate.physicalId ? seenPhysicalIds.has(candidate.physicalId) : false)
    ) {
      continue;
    }
    if (candidate.physicalId) seenPhysicalIds.add(candidate.physicalId);
    unique.set(sourceUrl, {
      id: candidate.physicalId
        ? `amazon-${candidate.physicalId}`
        : stableAmazonMediaId(sourceUrl),
      kind: "image",
      sourceUrl,
      ...(candidate.alt ? { alt: candidate.alt } : {}),
      included: true,
    });
  }
  return [...unique.values()];
}

function extractAmazonAPlusMedia(document: Document): AmazonCaptureDraft["media"] {
  const roots = [...document.querySelectorAll(AMAZON_APLUS_ROOT_SELECTOR)].filter(
    (root) => !root.closest(AMAZON_BRAND_STORY_SELECTOR),
  );
  const nodes = new Set<Element>();
  for (const root of roots) {
    if (root.matches("img, source, video, [data-image-url], [data-background-image]")) {
      nodes.add(root);
    }
    for (const node of root.querySelectorAll(
      [
        "img",
        "source[srcset]",
        "source[data-srcset]",
        "video[poster]",
        "[data-image-url]",
        "[data-background-image]",
        '[style*="background-image"]',
      ].join(", "),
    )) {
      nodes.add(node);
    }
  }

  const media: AmazonCaptureDraft["media"] = [];
  for (const [index, node] of [...nodes].entries()) {
    const rawUrl = amazonAPlusImageUrl(node);
    if (!rawUrl || isAmazonPlaceholderImage(rawUrl)) continue;
    let sourceUrl: string;
    try {
      sourceUrl = normalizeAmazonImageUrl(new URL(rawUrl, document.baseURI).href);
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(sourceUrl) || isAmazonPlaceholderImage(sourceUrl)) continue;
    const alt =
      node.getAttribute("alt")?.trim() ??
      node.closest("figure")?.querySelector("figcaption")?.textContent?.replace(/\s+/g, " ").trim() ??
      `Amazon A+ · ${index + 1}`;
    media.push({
      id: `amazon-aplus-${stableAmazonMediaHash(sourceUrl)}`,
      kind: "image",
      sourceUrl,
      ...(alt ? { alt: alt.startsWith("Amazon A+") ? alt : `Amazon A+ · ${alt}` } : {}),
      included: true,
    });
  }
  return dedupeAmazonMedia(media);
}

function amazonAPlusImageUrl(node: Element): string | null {
  if (node.tagName === "IMG") {
    const image = node as HTMLImageElement;
    return (
      image.getAttribute("data-old-hires") ??
      image.getAttribute("data-a-hires") ??
      image.getAttribute("data-src") ??
      largestDynamicImageUrl(image.getAttribute("data-a-dynamic-image")) ??
      largestSrcsetUrl(image.getAttribute("data-srcset")) ??
      largestSrcsetUrl(image.getAttribute("srcset")) ??
      stringValue(image.currentSrc) ??
      image.getAttribute("src")
    );
  }
  if (node.tagName === "SOURCE") {
    return (
      largestSrcsetUrl(node.getAttribute("data-srcset")) ??
      largestSrcsetUrl(node.getAttribute("srcset"))
    );
  }
  if (node.tagName === "VIDEO") return node.getAttribute("poster");
  return (
    node.getAttribute("data-image-url") ??
    node.getAttribute("data-background-image") ??
    backgroundImageUrl(node.getAttribute("style"))
  );
}

function largestSrcsetUrl(value: string | null): string | null {
  if (!value) return null;
  return value
    .split(",")
    .map((candidate) => {
      const [url, descriptor = "1x"] = candidate.trim().split(/\s+/, 2);
      const numeric = Number.parseFloat(descriptor);
      const score = Number.isFinite(numeric) ? numeric : 1;
      return { url, score };
    })
    .filter((candidate) => Boolean(candidate.url))
    .sort((left, right) => right.score - left.score)[0]?.url ?? null;
}

function backgroundImageUrl(value: string | null): string | null {
  if (!value) return null;
  return value.match(/background-image\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/i)?.[2]?.trim() ?? null;
}

function isAmazonPlaceholderImage(value: string): boolean {
  return (
    /^data:/i.test(value) ||
    /(?:transparent|grey|gray|clear|loading|loader|spinner|sprite|pixel)[-_.]/i.test(value)
  );
}

function dedupeAmazonMedia(
  media: AmazonCaptureDraft["media"],
): AmazonCaptureDraft["media"] {
  const unique = new Map<string, AmazonCaptureDraft["media"][number]>();
  for (const item of media) {
    const identity = amazonImageIdentity(item.sourceUrl);
    if (!unique.has(identity)) unique.set(identity, item);
  }
  return [...unique.values()];
}

function amazonImageIdentity(value: string): string {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).toLowerCase();
    const mediaId = path.match(
      /\/(?:images\/i|aplus-media-library-service-media)\/([^/]+?)(?:\.[a-z0-9]+)?$/i,
    )?.[1];
    return mediaId ? `amazon:${mediaId}` : `${url.hostname.toLowerCase()}${path}`;
  } catch {
    return value;
  }
}

function extractInitialGalleryImages(document: Document): AmazonGalleryImage[] {
  for (const script of document.scripts) {
    const source = script.textContent ?? "";
    if (!source.includes("ImageBlockATF") || !source.includes("colorImages")) continue;
    const marker = /['"]colorImages['"]\s*:\s*\{\s*['"]initial['"]\s*:\s*/g.exec(source);
    if (!marker) continue;
    const start = source.indexOf("[", marker.index + marker[0].length);
    const json = start >= 0 ? balancedJsonArray(source, start) : null;
    if (!json) continue;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isAmazonGalleryImage);
    } catch {
      // A changed public image payload falls back to the visible gallery DOM.
    }
  }
  return [];
}

function balancedJsonArray(source: string, start: number): string | null {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[") depth += 1;
    if (character === "]" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

function isAmazonGalleryImage(value: unknown): value is AmazonGalleryImage {
  return typeof value === "object" && value !== null;
}

function largestImageUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.entries(value)
    .map(([url, dimensions]) => ({
      url,
      area: Array.isArray(dimensions)
        ? Number(dimensions[0] ?? 0) * Number(dimensions[1] ?? 0)
        : 0,
    }))
    .sort((left, right) => right.area - left.area)[0]?.url ?? null;
}

function largestDynamicImageUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return largestImageUrl(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function normalizeAmazonImageUrl(value: string): string {
  const url = new URL(value);
  if (
    /(?:^|\.)media-amazon\.com$/i.test(url.hostname) ||
    /(?:^|\.)ssl-images-amazon\.com$/i.test(url.hostname)
  ) {
    url.pathname = url.pathname.replace(
      /\._[^/]+(?=\.(?:avif|gif|jpe?g|png|webp)$)/i,
      "",
    );
  }
  return url.href;
}

function stableAmazonMediaId(value: string): string {
  return `amazon-${stableAmazonMediaHash(value)}`;
}

function stableAmazonMediaHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractAmazonProductInformation(
  document: Document,
  pageUrl: URL,
): CaptureProductInformationSection[] {
  const sections: CaptureProductInformationSection[] = [];
  const seenRows = new Set<Element>();
  const seenItems = new Set<string>();

  const addSection = (
    name: string | null,
    items: CaptureProductInformationSection["items"],
  ) => {
    const uniqueItems = items.filter((item) => {
      const identity = `${item.label.toLowerCase()}\u0000${item.value.toLowerCase()}`;
      if (seenItems.has(identity)) return false;
      seenItems.add(identity);
      return true;
    });
    if (uniqueItems.length === 0) return;
    const sectionName = name || "Product information";
    const existing = sections.find(
      (section) => section.name.toLowerCase() === sectionName.toLowerCase(),
    );
    if (existing) existing.items.push(...uniqueItems);
    else sections.push({ name: sectionName, items: uniqueItems });
  };

  const roots = [
    ...document.querySelectorAll(
      "#productDetails_feature_div, #productFactsDesktopExpander, #productFactsMobileExpander",
    ),
  ];
  for (const root of roots) {
    const expanders = [
      ...root.querySelectorAll<HTMLElement>(
        ".a-expander-container.a-expander-section-container",
      ),
    ];
    for (const expander of expanders) {
      const name = visibleElementText(
        expander.querySelector(".a-expander-header .a-expander-prompt, .a-expander-prompt"),
      );
      addSection(name, productInformationRows(expander, pageUrl, seenRows));
    }
  }

  for (const table of document.querySelectorAll<HTMLTableElement>(
    [
      "#productDetails_feature_div table.prodDetTable",
      "#productFactsDesktopExpander table",
      "#productFactsMobileExpander table",
      "#productDetails_detailBullets_sections1",
      "#productDetails_detailBullets_sections2",
      "#productDetails_techSpec_section_1",
      "#productDetails_techSpec_section_2",
    ].join(", "),
  )) {
    addSection(
      productInformationSectionName(table),
      productInformationRows(table, pageUrl, seenRows),
    );
  }

  const detailBullets = document.querySelector("#detailBullets_feature_div");
  if (detailBullets) {
    const items: CaptureProductInformationSection["items"] = [];
    for (const item of detailBullets.querySelectorAll("li")) {
      const labelNode = item.querySelector(".a-text-bold");
      const label = normalizeProductInformationLabel(visibleElementText(labelNode));
      if (!label) continue;
      const value = visibleElementTextWithout(item, labelNode);
      if (!value) continue;
      items.push({
        label,
        value: value.replace(/^:\s*/, ""),
        links: productInformationLinks(item, pageUrl),
      });
    }
    addSection(
      visibleElementText(detailBullets.querySelector("h2")) || "Product details",
      items,
    );
  }

  return sections;
}

function productInformationRows(
  container: Element,
  pageUrl: URL,
  seenRows: Set<Element>,
): CaptureProductInformationSection["items"] {
  const items: CaptureProductInformationSection["items"] = [];
  for (const row of container.querySelectorAll("tr")) {
    if (seenRows.has(row)) continue;
    const labelNode = row.querySelector("th");
    const valueNode = row.querySelector("td");
    const label = normalizeProductInformationLabel(visibleElementText(labelNode));
    const value = visibleElementText(valueNode);
    if (!label || !value) continue;
    seenRows.add(row);
    items.push({
      label,
      value,
      links: productInformationLinks(valueNode!, pageUrl),
    });
  }

  for (const grid of container.querySelectorAll(".a-fixed-left-grid")) {
    if (seenRows.has(grid)) continue;
    const columns = [
      ...grid.querySelectorAll(
        ":scope > .a-fixed-left-grid-inner > .a-fixed-left-grid-col",
      ),
    ];
    if (columns.length < 2) continue;
    const label = normalizeProductInformationLabel(visibleElementText(columns[0]!));
    const value = visibleElementText(columns[1]!);
    if (!label || !value) continue;
    seenRows.add(grid);
    items.push({
      label,
      value,
      links: productInformationLinks(columns[1]!, pageUrl),
    });
  }

  for (const term of container.querySelectorAll("dt")) {
    if (seenRows.has(term)) continue;
    const description = term.nextElementSibling;
    if (!description?.matches("dd")) continue;
    const label = normalizeProductInformationLabel(visibleElementText(term));
    const value = visibleElementText(description);
    if (!label || !value) continue;
    seenRows.add(term);
    items.push({
      label,
      value,
      links: productInformationLinks(description, pageUrl),
    });
  }
  return items;
}

function productInformationSectionName(table: HTMLTableElement): string {
  const caption = visibleElementText(table.querySelector("caption"));
  if (caption) return caption;
  if (/techSpec/i.test(table.id)) return "Technical details";
  if (/detailBullets/i.test(table.id)) return "Additional information";
  const expanderName = visibleElementText(
    table
      .closest(".a-expander-container")
      ?.querySelector(".a-expander-header .a-expander-prompt, .a-expander-prompt") ?? null,
  );
  return expanderName || "Product details";
}

function normalizeProductInformationLabel(value: string | null): string | null {
  const normalized = value?.replace(/[\u200E\u200F]/g, "").replace(/\s*:\s*$/, "").trim();
  return normalized || null;
}

function productInformationLinks(
  container: Element,
  pageUrl: URL,
): CaptureProductInformationSection["items"][number]["links"] {
  const links = new Map<string, { label: string; url: string }>();
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const label = visibleElementText(anchor);
    if (!label) continue;
    try {
      const url = new URL(anchor.getAttribute("href")!, pageUrl).href;
      if (!/^https?:\/\//i.test(url)) continue;
      if (!links.has(url)) links.set(url, { label, url });
    } catch {
      // Ignore malformed public links while preserving the parameter text.
    }
  }
  return [...links.values()];
}

function visibleElementTextWithout(
  container: Element,
  excluded: Element | null,
): string | null {
  const clone = container.cloneNode(true) as Element;
  if (excluded) {
    const candidates = [...container.querySelectorAll("*")];
    const index = candidates.indexOf(excluded);
    if (index >= 0) clone.querySelectorAll("*")[index]?.remove();
  }
  return visibleElementText(clone);
}

function visibleElementText(element: Element | null): string | null {
  if (!element) return null;
  const clone = element.cloneNode(true) as Element;
  for (const ignored of clone.querySelectorAll(
    "script, style, noscript, template, iframe, svg, .a-popover-preload",
  )) {
    ignored.remove();
  }
  return cleanText(clone.textContent) || null;
}

function extractAmazonShipping(
  document: Document,
  currency: string | null,
  sellerName: string | null,
): CaptureShipping | null {
  const primarySelector = "#mir-layout-DELIVERY_BLOCK-slot-PRIMARY_DELIVERY_MESSAGE_LARGE";
  const primary =
    document.querySelector<HTMLElement>(
      `${primarySelector} [data-csa-c-delivery-time]`,
    ) ??
    document.querySelector<HTMLElement>(primarySelector) ??
    document.querySelector<HTMLElement>("#deliveryBlockMessage, #ddmDeliveryMessage");
  const deliveryText = cleanText(primary?.textContent);
  const estimatedDelivery =
    primary?.getAttribute("data-csa-c-delivery-time")?.trim() ??
    cleanText(primary?.querySelector(".a-text-bold")?.textContent) ??
    deliveryText.match(
      /(?:delivery|arrives?(?:\s+between|\s+by)?)\s+((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:\s*[-–—]\s*(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?\d{1,2})?)/i,
    )?.[1]?.trim() ??
    null;
  const costRaw =
    primary?.getAttribute("data-csa-c-delivery-price")?.trim() ??
    deliveryText.match(/([$£€]\s*[\d,.]+)\s+(?:delivery|shipping)/i)?.[1]?.replace(/\s+/g, "") ??
    null;
  const cost =
    costRaw && /free/i.test(costRaw)
      ? { raw: "FREE", amount: 0, ...(currency ? { currency } : {}) }
      : parsePrice(costRaw, currency);
  const destination =
    cleanText(
      document.querySelector("#contextualIngressPtLabel_deliveryShortLine")?.textContent ??
        document.querySelector("#contextualIngressPtLabel")?.textContent,
    )
      .replace(/^Deliver(?:ing)? to\s*/i, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim() || null;
  const availabilityText = cleanText(document.querySelector("#availability")?.textContent);
  const processingTime =
    availabilityText.match(/Usually ships within\s+[^.]+\.?/i)?.[0]?.trim() ?? null;
  const shipsFrom =
    tableValue(document, "Ships from") ??
    offerDisplayValue(document, "Shipper / Seller") ??
    sellerName;

  if (!primary && !estimatedDelivery && !cost && !shipsFrom && !destination && !processingTime) {
    return null;
  }
  return {
    estimatedDelivery,
    processingTime,
    cost,
    shipsFrom,
    destination,
    sourceSelector: primary?.closest("[id]")?.id
      ? `#${primary.closest("[id]")!.id}`
      : primarySelector,
  };
}

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

function offerDisplayValue(document: Document, label: string): string | null {
  for (const container of document.querySelectorAll("[offer-display-feature-name]")) {
    const feature = container.getAttribute("offer-display-feature-name");
    if (!feature) continue;
    const region = container.parentElement;
    const regionText = cleanText(region?.textContent);
    if (!regionText.toLowerCase().startsWith(label.toLowerCase())) continue;
    const value = region?.querySelector(
      ".offer-display-feature-text-message, .offer-display-feature-text",
    )?.textContent;
    const normalized = cleanText(value);
    if (normalized && normalized.toLowerCase() !== label.toLowerCase()) return normalized;
  }
  return null;
}

function amazonDetailValue(document: Document, label: string): string | null {
  for (const row of document.querySelectorAll(
    "#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr",
  )) {
    const heading = cleanText(row.querySelector("th")?.textContent);
    if (heading.toLowerCase() !== label.toLowerCase()) continue;
    return cleanText(row.querySelector("td")?.textContent) || null;
  }
  for (const item of document.querySelectorAll("#detailBullets_feature_div li")) {
    const text = cleanText(item.textContent);
    const match = text.match(new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.+)$`, "i"));
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}
