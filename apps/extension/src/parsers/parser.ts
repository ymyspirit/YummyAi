import { CaptureDraftSchema, type CaptureDraft } from "@yummyai/contracts";

import { amazonParser } from "./amazon.js";
import { etsyParser } from "./etsy.js";

export interface MarketplaceParser {
  supports(url: URL, document: Document): boolean;
  parse(document: Document, url: URL, options?: ParserOptions): CaptureDraft;
}

export interface ParserOptions {
  includeReviews?: boolean;
}

export class UnsupportedMarketplacePageError extends Error {
  constructor(url: string) {
    super(`YummyAI cannot capture this page: ${url}`);
    this.name = "UnsupportedMarketplacePageError";
  }
}

export function parserFor(url: URL, document: Document): MarketplaceParser {
  const parser = [amazonParser, etsyParser].find((candidate) => candidate.supports(url, document));
  if (!parser) throw new UnsupportedMarketplacePageError(url.href);
  return parser;
}

type Diagnostic = CaptureDraft["diagnostics"][number];
type Media = CaptureDraft["media"][number];
type Variant = CaptureDraft["variants"][number];
type ContentBlock = CaptureDraft["contentBlocks"][number];

interface MediaOptions {
  identity?: (sourceUrl: string) => string;
}

export class PublicPageReader {
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly document: Document) {}

  text(field: string, selectors: readonly string[], required = false): string | null {
    for (const selector of selectors) {
      try {
        const value = normalizeText(this.document.querySelector(selector)?.textContent);
        if (value) return value;
      } catch {
        this.selectorError(field, selector);
      }
    }
    if (required) this.missing(field);
    return null;
  }

  attribute(
    field: string,
    selectors: readonly string[],
    attribute: string,
    required = false,
  ): string | null {
    for (const selector of selectors) {
      try {
        const value = this.document.querySelector(selector)?.getAttribute(attribute)?.trim();
        if (value) return value;
      } catch {
        this.selectorError(field, selector);
      }
    }
    if (required) this.missing(field);
    return null;
  }

  texts(field: string, selectors: readonly string[]): string[] {
    for (const selector of selectors) {
      try {
        const values = [...this.document.querySelectorAll(selector)]
          .map((node) => normalizeText(node.textContent))
          .filter((value): value is string => Boolean(value));
        if (values.length > 0) return unique(values);
      } catch {
        this.selectorError(field, selector);
      }
    }
    return [];
  }

  media(selectors: readonly string[], options: MediaOptions = {}): Media[] {
    const results: Media[] = [];
    for (const selector of selectors) {
      try {
        for (const node of this.document.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
          selector,
        )) {
          const rawUrl =
            node.getAttribute("data-old-hires") ??
            node.getAttribute("data-src-zoom-image") ??
            (node.currentSrc || null) ??
            node.getAttribute("src") ??
            (node.tagName === "VIDEO"
              ? node.querySelector("source[src]")?.getAttribute("src")
              : null);
          if (!rawUrl) continue;
          try {
            const sourceUrl = new URL(rawUrl, this.document.baseURI).href;
            if (!sourceUrl.startsWith("http://") && !sourceUrl.startsWith("https://")) continue;
            results.push({
              id: stableMediaId(sourceUrl),
              kind: node.tagName === "VIDEO" ? "video" : "image",
              sourceUrl,
              ...(node.getAttribute("alt")?.trim()
                ? { alt: node.getAttribute("alt")!.trim() }
                : {}),
              included: true,
            });
          } catch {
            this.diagnostics.push({
              field: "media",
              code: "invalid",
              message: "A media URL on the public page was invalid.",
              severity: "warning",
            });
          }
        }
      } catch {
        this.selectorError("media", selector);
      }
    }
    const uniqueByIdentity = new Map<string, Media>();
    for (const item of results) {
      const identity = options.identity?.(item.sourceUrl) ?? item.sourceUrl;
      if (!uniqueByIdentity.has(identity)) uniqueByIdentity.set(identity, item);
    }
    const uniqueMedia = [...uniqueByIdentity.values()];
    if (uniqueMedia.length === 0) this.missing("media");
    return uniqueMedia;
  }

  variants(containerSelectors: readonly string[]): Variant[] {
    const results: Variant[] = [];
    for (const selector of containerSelectors) {
      try {
        const containers = [...this.document.querySelectorAll(selector)];
        const variants = containers.flatMap((container) => {
          const select = container.matches("select")
            ? (container as HTMLSelectElement)
            : container.querySelector<HTMLSelectElement>("select");
          if (!select) return [];
          const label =
            normalizeText(
              (select.id
                ? [...this.document.querySelectorAll<HTMLLabelElement>("label")].find(
                    (candidate) => candidate.htmlFor === select.id,
                  )
                : undefined
              )?.textContent,
            ) ??
            normalizeText(container.querySelector("label")?.textContent) ??
            select.getAttribute("aria-label")?.trim() ??
            "Option";
          const options = [...select.options]
            .filter((option) => !option.disabled && normalizeText(option.textContent))
            .map((option) => {
              const value = option.value.split(",").at(-1)?.trim();
              return {
                label: normalizeText(option.textContent)!,
                ...(value && value !== option.textContent?.trim() ? { externalId: value } : {}),
              };
            });
          return options.length > 0 ? [{ label, options }] : [];
        });
        results.push(...variants);
      } catch {
        this.selectorError("variants", selector);
      }
    }
    return [...new Map(results.map((item) => [item.label, item])).values()];
  }

  contentBlock(kind: ContentBlock["kind"], selector: string): ContentBlock | null {
    try {
      const text = normalizeText(this.document.querySelector(selector)?.textContent);
      return text ? { kind, text, sourceSelector: selector } : null;
    } catch {
      this.selectorError("contentBlocks", selector);
      return null;
    }
  }

  contentBlocks(kind: ContentBlock["kind"], selectors: readonly string[]): ContentBlock[] {
    for (const selector of selectors) {
      try {
        const blocks = [...this.document.querySelectorAll(selector)]
          .map((node) => normalizeText(node.textContent))
          .filter((text): text is string => Boolean(text))
          .map((text) => ({ kind, text, sourceSelector: selector }));
        if (blocks.length > 0) return blocks;
      } catch {
        this.selectorError("contentBlocks", selector);
      }
    }
    return [];
  }

  build(
    draft: Omit<CaptureDraft, "diagnostics" | "missingFields" | "captureStatus">,
  ): CaptureDraft {
    const missingFields = unique(
      this.diagnostics.filter((item) => item.code === "missing").map((item) => item.field),
    );
    const captureStatus = draft.title && draft.media.length > 0 ? "complete" : "partial";
    return CaptureDraftSchema.parse({
      ...draft,
      diagnostics: this.diagnostics,
      missingFields,
      captureStatus,
    });
  }

  missing(field: string): void {
    if (this.diagnostics.some((item) => item.field === field && item.code === "missing")) return;
    this.diagnostics.push({
      field,
      code: "missing",
      message: `The public page did not expose ${field}.`,
      severity: field === "title" || field === "media" ? "error" : "warning",
    });
  }

  private selectorError(field: string, selector: string): void {
    this.diagnostics.push({
      field,
      code: "selector_error",
      message: `The selector for ${field} could not be evaluated: ${selector}`,
      severity: "warning",
    });
  }
}

export function parsePrice(raw: string | null, currency: string | null) {
  if (!raw) return null;
  const numeric = raw
    .replace(/[^\d.,]/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const amount = Number.parseFloat(numeric);
  return {
    raw,
    ...(Number.isFinite(amount) ? { amount } : {}),
    ...(currency?.length === 3 ? { currency: currency.toUpperCase() } : {}),
  };
}

export function numberFromText(value: string | null): number | null {
  if (!value) return null;
  const match = value.replaceAll(",", "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function stableMediaId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `media-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
