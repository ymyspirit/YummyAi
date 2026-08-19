import {
  CompetitorShopDraftSchema,
  type CaptureEhuntShopActiveSection,
  type CaptureEhuntShopAnalysis,
  type CaptureEhuntShopMetric,
  type CompetitorShopDraft,
  type CompetitorShopMember,
  type CompetitorShopSection,
} from "@yummyai/contracts";

import { numberFromText, parsePrice } from "./parser.js";

export const etsyShopParser = {
  supports(url: URL) {
    return /(^|\.)etsy\.com$/i.test(url.hostname) && /^\/shop\/[^/]+/i.test(url.pathname);
  },

  parse(document: Document, url: URL): CompetitorShopDraft {
    const diagnostics: CompetitorShopDraft["diagnostics"] = [];
    const name = normalize(document.querySelector("main h1, h1")?.textContent);
    const externalId = url.pathname.match(/^\/shop\/([^/]+)/i)?.[1] ?? name ?? null;
    if (!name) missing(diagnostics, "name", true);
    const mainText = normalize(document.querySelector("main")?.textContent) ?? "";
    const aboutText = normalize(document.querySelector("#about")?.textContent) ?? "";
    const location =
      normalize(document.querySelector(".sb-shop-location")?.textContent) ??
      [...document.querySelectorAll("main p")]
        .map((node) => normalize(node.textContent))
        .find(
          (value) =>
            value &&
            /^(?:[^,]+,\s*)?(?:Canada|United States|United Kingdom|Australia|India)$/i.test(value),
        ) ??
      null;
    const reviewLink = [...document.querySelectorAll<HTMLAnchorElement>('main a[href="#reviews"]')]
      .map((link) => normalize(link.textContent))
      .find((value) => value && /\d/.test(value));
    const ratingElement = document.querySelector<HTMLElement>(
      "main [data-review-ratings-count][data-rating], main [data-rating]",
    );
    const legacyRatingContainer = document.querySelector<HTMLElement>(
      'main button[aria-label="Rating information"]',
    )?.parentElement;
    const rating = numberFromText(
      ratingElement?.getAttribute("data-rating") ??
        document.querySelector(".rating-and-reviews-count__avg-rating")?.textContent ??
        normalize(legacyRatingContainer?.textContent),
    );
    const salesCount = numberFromText(
      aboutText.match(/Sales\s+([\d,.]+)/i)?.[1] ??
        mainText.match(/([\d,.]+)\s+Sales\b/i)?.[1] ??
        null,
    );
    const openedYear = numberFromText(aboutText.match(/On Etsy since\s+(\d{4})/i)?.[1] ?? null);
    const shopSections = extractShopSections(document, url);
    const allSection = shopSections.find((section) => section.kind === "all");
    const activeListingCount =
      allSection?.listingCount ??
      numberFromText(
        document
          .querySelector<HTMLInputElement>('input[aria-label^="Search all "]')
          ?.getAttribute("aria-label") ??
          document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ??
          null,
      );
    const admirerCount = humanCount(
      document.querySelector<HTMLAnchorElement>('a[href*="/favoriters"]')?.textContent ?? null,
    );
    const yearsOnPlatform = numberFromText(
      mainText.match(/([\d,.]+)\s+years?\s+on Etsy/i)?.[1] ?? null,
    );
    const announcement = normalize(document.querySelector("#announcement")?.textContent);
    const about = normalize(document.querySelector("#about-story")?.textContent);
    const policies = normalize(document.querySelector("#policies")?.textContent);
    const members = extractMembers(document);
    const productionPartners = extractProductionPartners(document);
    const ownerName = members.find((member) => /owner/i.test(member.role ?? ""))?.name ?? null;
    const badges = /Star Seller/i.test(mainText) ? ["Star Seller"] : [];
    const ehuntAnalysis = extractEhuntShopAnalysis(document);

    if (shopSections.length === 0) missing(diagnostics, "shopSections", false);
    for (const section of shopSections) {
      if (section.listingCount === null) {
        missing(diagnostics, `shopSections.${section.externalId}.listingCount`, false);
      }
    }
    for (const [field, value] of [
      ["salesCount", salesCount],
      ["rating", rating],
      ["activeListingCount", activeListingCount],
      ["location", location],
    ] as const) {
      if (value === null) missing(diagnostics, field, false);
    }
    const capturedAt = new Date().toISOString();
    return CompetitorShopDraftSchema.parse({
      platform: "etsy",
      externalId,
      name: name ?? externalId ?? "Etsy shop",
      sourceUrl: url.href,
      location,
      ownerName,
      rating,
      reviewCount: humanCount(reviewLink),
      salesCount,
      activeListingCount,
      admirerCount,
      openedYear,
      yearsOnPlatform,
      badges,
      parserVersion: "etsy-shop@1.2.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      announcement,
      about,
      policies,
      members,
      productionPartners,
      shopSections,
      ...(ehuntAnalysis ? { ehuntAnalysis } : {}),
      missingFields: diagnostics
        .filter((item) => item.code === "missing")
        .map((item) => item.field),
      diagnostics,
      captureStatus: name && salesCount !== null ? "complete" : "partial",
      capturedAt,
    });
  },
};

export function extractEhuntShopAnalysis(document: Document): CaptureEhuntShopAnalysis | null {
  const root = document.querySelector<HTMLElement>(
    "#etsy-rank-tool-store-table .eh-store-detail",
  );
  if (!root) return null;

  const openedAt = ehuntShopValue(root, ["开店时间", "Opened"]);
  const primaryCategory = ehuntShopValue(root, ["主营类目", "Primary category"]);
  const country = ehuntShopValue(root, ["国家", "Country"]);
  const weeklySales = metricFromText(ehuntShopValue(root, ["周销量", "Weekly sales"]));
  const weeklyRevenue = moneyFromText(
    ehuntShopValue(root, ["周销售额", "Weekly revenue"]),
  );
  const weeklyReviews = metricFromText(ehuntShopValue(root, ["周评论", "Weekly reviews"]));
  const totalSales = metricFromText(ehuntShopValue(root, ["总销量", "Total sales"]));
  const totalRevenue = moneyFromText(
    ehuntShopValue(root, ["总销售额", "Total revenue"]),
  );
  const totalReviews = metricFromText(ehuntShopValue(root, ["总评论", "Total reviews"]));
  const weeklyFavorites = metricFromText(
    ehuntShopValue(root, ["周收藏", "Weekly favorites"]),
  );
  const listingCount = metricFromText(
    ehuntShopValue(root, ["商品总数", "Total listings", "Listings"]),
  );
  const rating = numberFromText(ehuntShopValue(root, ["评星", "Rating"]));
  const totalFavorites = metricFromText(
    ehuntShopValue(root, ["总收藏", "Total favorites"]),
  );
  const starSeller = booleanFromText(ehuntShopValue(root, ["Star Seller"]));
  const socialMedia = extractLabeledLinks(root, ["社媒信息", "Social media"]);
  const paymentMethods = extractPaymentMethods(root);
  const activeSection = extractEhuntShopActiveSection(root, document);

  const analysis: CaptureEhuntShopAnalysis = {
    provider: "ehunt",
    sourceSelector: "#etsy-rank-tool-store-table .eh-store-detail",
    openedAt,
    primaryCategory,
    country,
    weeklySales,
    weeklyRevenue,
    weeklyReviews,
    totalSales,
    totalRevenue,
    totalReviews,
    weeklyFavorites,
    listingCount,
    rating,
    totalFavorites,
    starSeller,
    socialMedia,
    paymentMethods,
    activeSection,
  };

  const hasSummaryEvidence = [
    openedAt,
    primaryCategory,
    country,
    weeklySales,
    weeklyRevenue,
    weeklyReviews,
    totalSales,
    totalRevenue,
    totalReviews,
    weeklyFavorites,
    listingCount,
    rating,
    totalFavorites,
    starSeller,
  ].some((value) => value !== null);
  return hasSummaryEvidence || socialMedia.length > 0 || paymentMethods.length > 0 || activeSection
    ? analysis
    : null;
}

function extractEhuntShopActiveSection(
  root: HTMLElement,
  document: Document,
): CaptureEhuntShopActiveSection | null {
  const activeLabel = normalize(
    root.querySelector(
      ".el-radio-button.is-active .el-radio-button__inner, .el-radio-button input:checked + .el-radio-button__inner",
    )?.textContent,
  );
  if (!activeLabel) return null;

  const kind = ehuntShopSectionKind(activeLabel);
  if (!kind) return null;

  if (kind === "hot_products" || kind === "new_products" || kind === "delisted_products") {
    const items = [...root.querySelectorAll<HTMLElement>(".eh-product-box-new-item")]
      .map((item) => {
        const titleNode = item.querySelector<HTMLAnchorElement>(".eh-product-item-title");
        const title = normalize(titleNode?.textContent);
        if (!title) return null;
        const metricTexts = [...item.querySelectorAll<HTMLElement>(".eh-product-item-sales")]
          .map((node) => normalize(node.textContent))
          .filter((value): value is string => Boolean(value));
        const salesRaw = labeledMetric(metricTexts, ["总销量", "Total sales"]);
        const priceRaw = labeledMetric(metricTexts, ["价格", "Price"]);
        return {
          title,
          detailUrl: safeUrl(titleNode?.getAttribute("href"), document.baseURI),
          imageUrl: safeUrl(item.querySelector("img")?.getAttribute("src"), document.baseURI),
          totalSales: metricFromText(salesRaw),
          price: moneyFromText(priceRaw),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return items.length > 0 ? { kind, label: activeLabel, items } : null;
  }

  if (kind === "common_tags") {
    const items = [...root.querySelectorAll<HTMLElement>(".eh-product-box-new-label")]
      .map((row) => {
        const label = normalize(row.querySelector(".is-click")?.textContent);
        if (!label) return null;
        const metricTexts = [...row.querySelectorAll<HTMLElement>(".item")]
          .map((node) => normalize(node.textContent))
          .filter((value): value is string => Boolean(value));
        return {
          label,
          frequency: metricFromText(labeledMetric(metricTexts, ["频次", "Frequency"])),
          competition: metricFromText(
            labeledMetric(metricTexts, ["竞争度", "Competition"]),
          ),
          views: metricFromText(labeledMetric(metricTexts, ["浏览量", "Views"])),
          viewDelta: metricFromText(labeledDelta(metricTexts, ["浏览量", "Views"])),
          favorites: metricFromText(
            labeledMetric(metricTexts, ["收藏量", "Favorites"]),
          ),
          favoriteDelta: metricFromText(
            labeledDelta(metricTexts, ["收藏量", "Favorites"]),
          ),
          sales: metricFromText(labeledMetric(metricTexts, ["销售", "Sales"])),
          salesDelta: metricFromText(labeledDelta(metricTexts, ["销售", "Sales"])),
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return items.length > 0 ? { kind, label: activeLabel, items } : null;
  }

  if (kind === "popular_categories") {
    const items = [...root.querySelectorAll<HTMLElement>(".eh-product-box-new > div > div > div")]
      .map((row) => {
        const raw = normalize(row.textContent);
        const path = [...row.querySelectorAll<HTMLElement>(".is-click")]
          .map((node) => normalize(node.textContent))
          .filter((value): value is string => Boolean(value));
        if (!raw || path.length === 0) return null;
        return {
          path,
          sharePercent: numberFromText(raw.match(/\(([\d.]+)\s*%/)?.[1] ?? null),
          raw,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
    return items.length > 0 ? { kind, label: activeLabel, items } : null;
  }

  const table = root.querySelector<HTMLTableElement>("#history-trend table");
  if (!table) return null;
  const headings = [...table.querySelectorAll<HTMLElement>("thead th")].map((cell) =>
    normalize(cell.textContent),
  );
  const points = [...table.querySelectorAll<HTMLTableRowElement>("tbody tr")]
    .map((row) => {
      const cells = [...row.querySelectorAll<HTMLElement>("th, td")];
      const period = normalize(cells[0]?.textContent);
      if (!period) return null;
      const values = cells.slice(1).flatMap((cell, index) => {
        const raw = normalize(cell.textContent);
        const label =
          normalize(cell.getAttribute("data-label")) ??
          normalize(cell.getAttribute("aria-label")) ??
          headings[index + 1] ??
          null;
        const metric = metricFromText(raw);
        return label && metric ? [{ label, metric }] : [];
      });
      return values.length > 0 ? { period, values } : null;
    })
    .filter((point): point is NonNullable<typeof point> => point !== null);
  return points.length > 0 ? { kind, label: activeLabel, points } : null;
}

function ehuntShopSectionKind(
  label: string,
): CaptureEhuntShopActiveSection["kind"] | null {
  const normalized = label.toLowerCase();
  if (label === "热销商品" || normalized === "hot products") return "hot_products";
  if (label === "上新选品" || normalized === "new products") return "new_products";
  if (label === "下架选品" || normalized === "delisted products") {
    return "delisted_products";
  }
  if (label === "历史趋势" || normalized === "history trend") return "history_trend";
  if (label === "常用标签" || normalized === "common tags") return "common_tags";
  if (label === "热门类目" || normalized === "popular categories") {
    return "popular_categories";
  }
  return null;
}

function ehuntShopValue(root: HTMLElement, labels: readonly string[]): string | null {
  return normalize(ehuntShopValueCell(root, labels)?.textContent);
}

function ehuntShopValueCell(
  root: HTMLElement,
  labels: readonly string[],
): HTMLElement | null {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  const labelCell = [...root.querySelectorAll<HTMLElement>(".eh-store-detail-content-label")].find(
    (cell) => {
      const text = normalize(cell.textContent)?.toLowerCase();
      return text ? normalizedLabels.includes(text) : false;
    },
  );
  if (!labelCell) return null;
  const sibling = labelCell.nextElementSibling;
  if (sibling) return sibling as HTMLElement;
  const siblings = labelCell.parentElement ? [...labelCell.parentElement.children] : [];
  const index = siblings.indexOf(labelCell);
  return index >= 0 && siblings[index + 1] ? (siblings[index + 1] as HTMLElement) : null;
}

function extractLabeledLinks(root: HTMLElement, labels: readonly string[]): string[] {
  const cell = ehuntShopValueCell(root, labels);
  if (!cell) return [];
  return uniqueStrings(
    [...cell.querySelectorAll<HTMLAnchorElement>("a[href]")].flatMap((link) => {
      const explicit =
        normalize(link.textContent) ??
        normalize(link.getAttribute("aria-label")) ??
        normalize(link.getAttribute("title"));
      if (explicit) return [explicit];
      try {
        return [new URL(link.href).hostname.replace(/^www\./, "")];
      } catch {
        return [];
      }
    }),
  );
}

function extractPaymentMethods(root: HTMLElement): string[] {
  const cell = ehuntShopValueCell(root, ["支付方式", "Payment methods"]);
  if (!cell) return [];
  return uniqueStrings(
    [...cell.querySelectorAll<HTMLImageElement>("img")].flatMap((image) => {
      const explicit =
        normalize(image.getAttribute("alt")) ??
        normalize(image.getAttribute("title")) ??
        normalize(image.getAttribute("aria-label"));
      if (explicit) return [explicit];
      const source = image.getAttribute("src");
      const filename = source?.split(/[\\/]/).at(-1)?.split(/[?#]/)[0]?.replace(/\.[^.]+$/, "");
      return filename ? [filename] : [];
    }),
  );
}

function labeledMetric(values: readonly string[], labels: readonly string[]): string | null {
  const pattern = labels.map(escapeRegExp).join("|");
  for (const value of values) {
    const match = value.match(new RegExp(`^(?:${pattern})\\s*[:：]\\s*([^\\s↑]+)`, "i"));
    if (match?.[1]) return match[1];
  }
  return null;
}

function labeledDelta(values: readonly string[], labels: readonly string[]): string | null {
  const pattern = labels.map(escapeRegExp).join("|");
  for (const value of values) {
    if (!new RegExp(`^(?:${pattern})\\s*[:：]`, "i").test(value)) continue;
    const match = value.match(/[↑+]\s*([\d.,]+\s*[km]?)/i);
    if (match?.[1]) return match[1].replace(/\s+/g, "");
  }
  return null;
}

function metricFromText(value: string | null): CaptureEhuntShopMetric | null {
  const raw = normalize(value);
  if (!raw) return null;
  return { raw, value: humanCount(raw) };
}

function moneyFromText(value: string | null) {
  const raw = normalize(value);
  if (!raw) return null;
  const currency = raw.match(/\b(USD|CAD|AUD|GBP|EUR|CNY|JPY)\b/i)?.[1] ?? null;
  return parsePrice(raw, currency);
}

function booleanFromText(value: string | null): boolean | null {
  const normalized = normalize(value)?.toLowerCase();
  if (!normalized) return null;
  if (["是", "yes", "true"].includes(normalized)) return true;
  if (["否", "no", "false"].includes(normalized)) return false;
  return null;
}

function safeUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractShopSections(document: Document, pageUrl: URL): CompetitorShopSection[] {
  const baseUrl = new URL(pageUrl.href);
  baseUrl.search = "";
  baseUrl.hash = "";
  const seen = new Set<string>();
  const sections: CompetitorShopSection[] = [];

  for (const tab of document.querySelectorAll<HTMLElement>(
    'main [role="tab"][data-wt-tab][data-section-id]',
  )) {
    const externalId = tab.dataset.sectionId?.trim();
    if (!externalId || seen.has(externalId)) continue;
    const labels = tab.querySelectorAll<HTMLElement>(":scope > span");
    const name =
      normalize(
        labels[0]?.querySelector<HTMLElement>("[data-shop-pretranslations-translation]")
          ?.textContent,
      ) ?? normalize(labels[0]?.textContent);
    if (!name) continue;
    seen.add(externalId);
    const kind = externalId === "0" ? "all" : externalId === "1" ? "sale" : "category";
    const sourceUrl = new URL(baseUrl.href);
    if (kind === "category") sourceUrl.searchParams.set("section_id", externalId);
    sections.push({
      kind,
      externalId,
      name,
      listingCount: numberFromText(normalize(labels[1]?.textContent)),
      sourceUrl: kind === "sale" ? null : sourceUrl.href,
    });
  }

  return sections;
}

function extractMembers(document: Document): CompetitorShopMember[] {
  return [...document.querySelectorAll<HTMLElement>("#shop-members li")]
    .map((item) => {
      const text = normalize(item.textContent) ?? "";
      const roleMatch = text.match(
        /\b(Owner|Designer|Customer Service|Maker|Photographer|Shipper)\b/i,
      );
      const roleStart = roleMatch?.index ?? -1;
      return {
        name: roleStart > 0 ? text.slice(0, roleStart).trim() : text,
        role: roleStart >= 0 ? text.slice(roleStart).trim() : null,
      };
    })
    .filter((member) => member.name);
}

function extractProductionPartners(document: Document): string[] {
  const heading = [...document.querySelectorAll("#about h3")].find(
    (node) => normalize(node.textContent)?.toLowerCase() === "production partners",
  );
  const text = normalize(heading?.parentElement?.textContent)?.replace(
    /^Production partners\s*/i,
    "",
  );
  return text ? [text] : [];
}

function humanCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replaceAll(",", "").match(/([\d.]+)\s*([km])?/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier =
    match[2]?.toLowerCase() === "k" ? 1_000 : match[2]?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(amount * multiplier);
}

function missing(
  diagnostics: CompetitorShopDraft["diagnostics"],
  field: string,
  required: boolean,
) {
  diagnostics.push({
    field,
    code: "missing",
    message: `The public shop page did not expose ${field}.`,
    severity: required ? "error" : "warning",
  });
}

function normalize(value: string | null | undefined): string | null {
  return value?.replace(/\s+/g, " ").trim() || null;
}
