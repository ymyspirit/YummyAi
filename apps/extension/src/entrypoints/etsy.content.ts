import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import {
  CAPTURE_PAGE_MESSAGE,
  capturePublicPage,
  type CapturePageRequest,
} from "../lib/capture-messages.js";
import {
  COLLECT_ALL_REVIEWS_MESSAGE,
  mergeStoredEtsyReviews,
  startEtsyReviewCollection,
} from "../lib/etsy-review-collector.js";

export default defineContentScript({
  matches: ["https://*.etsy.com/listing/*", "https://*.etsy.com/shop/*"],
  main() {
    const pageUrl = () => new URL(window.location.href);
    browser.runtime.onMessage.addListener(async (message: unknown) => {
      if (isCaptureMessage(message)) {
        const response = capturePublicPage(
          document,
          pageUrl(),
          browser.runtime.getManifest().version,
          { includeReviews: message.includeReviews },
        );
        if (!response.ok || response.kind === "shop" || !message.includeReviews) return response;
        return { ...response, draft: await mergeStoredEtsyReviews(response.draft) };
      }
      if (isReviewCollectionMessage(message)) {
        return startEtsyReviewCollection(document, pageUrl(), message.pageDelayMs);
      }
      return undefined;
    });
  },
});

function isCaptureMessage(message: unknown): message is CapturePageRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === CAPTURE_PAGE_MESSAGE &&
    "includeReviews" in message &&
    typeof message.includeReviews === "boolean"
  );
}

function isReviewCollectionMessage(
  message: unknown,
): message is { type: typeof COLLECT_ALL_REVIEWS_MESSAGE; pageDelayMs: number } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === COLLECT_ALL_REVIEWS_MESSAGE &&
    "pageDelayMs" in message &&
    typeof message.pageDelayMs === "number"
  );
}
