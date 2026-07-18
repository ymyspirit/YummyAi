import {
  CaptureDraftSchema,
  CompetitorShopDraftSchema,
  type CaptureDraft,
  type CompetitorShopDraft,
} from "@yummyai/contracts";

import { etsyShopParser } from "../parsers/etsy-shop.js";
import { parserFor } from "../parsers/parser.js";

export const CAPTURE_PAGE_MESSAGE = "yummyai:capture-page";

export type CapturePageResponse =
  | { ok: true; kind: "product"; draft: CaptureDraft }
  | { ok: true; kind: "shop"; draft: CompetitorShopDraft }
  | { ok: false; error: string };

export function capturePublicPage(
  document: Document,
  url: URL,
  extensionVersion = "development",
): CapturePageResponse {
  try {
    if (etsyShopParser.supports(url)) {
      const shop = etsyShopParser.parse(document, url);
      return {
        ok: true,
        kind: "shop",
        draft: CompetitorShopDraftSchema.parse({ ...shop, extensionVersion }),
      };
    }
    const draft = parserFor(url, document).parse(document, url);
    return {
      ok: true,
      kind: "product",
      draft: CaptureDraftSchema.parse({ ...draft, extensionVersion }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "This page could not be captured.",
    };
  }
}
