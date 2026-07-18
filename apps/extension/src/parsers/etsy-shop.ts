import {
  CompetitorShopDraftSchema,
  type CompetitorShopDraft,
  type CompetitorShopMember,
} from "@yummyai/contracts";

import { numberFromText } from "./parser.js";

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
      [...document.querySelectorAll("main p")]
        .map((node) => normalize(node.textContent))
        .find(
          (value) =>
            value && /,\s*(?:Canada|United States|United Kingdom|Australia|India)$/i.test(value),
        ) ?? null;
    const reviewLink = [...document.querySelectorAll<HTMLAnchorElement>('main a[href="#reviews"]')]
      .map((link) => normalize(link.textContent))
      .find((value) => value && /\d/.test(value));
    const ratingContainer = document.querySelector<HTMLElement>(
      'main button[aria-label="Rating information"]',
    )?.parentElement;
    const rating = numberFromText(normalize(ratingContainer?.textContent));
    const salesCount = numberFromText(
      aboutText.match(/Sales\s+([\d,.]+)/i)?.[1] ??
        mainText.match(/([\d,.]+)\s+Sales\b/i)?.[1] ??
        null,
    );
    const openedYear = numberFromText(aboutText.match(/On Etsy since\s+(\d{4})/i)?.[1] ?? null);
    const activeListingCount = numberFromText(
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
      parserVersion: "etsy-shop@1.0.0",
      extensionVersion: "0.0.0",
      marketplace: url.hostname.toLowerCase(),
      announcement,
      about,
      policies,
      members,
      productionPartners,
      missingFields: diagnostics
        .filter((item) => item.code === "missing")
        .map((item) => item.field),
      diagnostics,
      captureStatus: name && salesCount !== null ? "complete" : "partial",
      capturedAt,
    });
  },
};

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
