import {
  CaptureDraftSchema,
  CompetitorShopDraftSchema,
  type CaptureDraft,
  type CompetitorShopDraft,
} from "@yummyai/contracts";

import { etsyShopParser } from "../parsers/etsy-shop.js";
import { parserFor } from "../parsers/parser.js";

export const CAPTURE_PAGE_MESSAGE = "yummyai:capture-page";

export interface CapturePageRequest {
  type: typeof CAPTURE_PAGE_MESSAGE;
  includeReviews: boolean;
}

export interface CapturePageOptions {
  includeReviews?: boolean;
}

export type CapturePageResponse =
  | { ok: true; kind: "product"; draft: CaptureDraft }
  | { ok: true; kind: "shop"; draft: CompetitorShopDraft }
  | { ok: false; error: string };

export function capturePublicPage(
  document: Document,
  url: URL,
  extensionVersion = "development",
  options: CapturePageOptions = {},
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
    const parsedDraft = CaptureDraftSchema.parse({
      ...parserFor(url, document).parse(document, url, options),
      extensionVersion,
    });
    const draft =
      options.includeReviews === false ? withoutReviewEvidence(parsedDraft) : parsedDraft;
    return {
      ok: true,
      kind: "product",
      draft,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "This page could not be captured.",
    };
  }
}

export function withoutReviewEvidence(draft: CaptureDraft): CaptureDraft {
  return CaptureDraftSchema.parse({
    ...draft,
    rating: null,
    reviewCount: null,
    reviewSummary: null,
    reviews: [],
    reviewCollection: {
      collectedCount: 0,
      reportedTotal: null,
      pageCount: 0,
      status: "visible",
      updatedAt: draft.capturedAt,
    },
    contentBlocks: draft.contentBlocks.filter((block) => block.kind !== "review"),
  });
}
