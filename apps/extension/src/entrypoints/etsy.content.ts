import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import { CAPTURE_PAGE_MESSAGE, capturePublicPage } from "../lib/capture-messages.js";
import {
  COLLECT_ALL_REVIEWS_MESSAGE,
  captureVisibleEtsyReviews,
  mergeStoredEtsyReviews,
  startEtsyReviewCollection,
} from "../lib/etsy-review-collector.js";

export default defineContentScript({
  matches: ["https://*.etsy.com/listing/*", "https://*.etsy.com/shop/*"],
  main() {
    const pageUrl = () => new URL(window.location.href);
    let observationTimer: number | undefined;
    const observeReviews = () => {
      window.clearTimeout(observationTimer);
      observationTimer = window.setTimeout(() => {
        void captureVisibleEtsyReviews(document, pageUrl());
      }, 800);
    };
    if (/^\/listing\//i.test(pageUrl().pathname)) {
      void captureVisibleEtsyReviews(document, pageUrl());
      new MutationObserver(observeReviews).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    browser.runtime.onMessage.addListener(async (message: unknown) => {
      if (isCaptureMessage(message)) {
        const response = capturePublicPage(
          document,
          pageUrl(),
          browser.runtime.getManifest().version,
        );
        if (!response.ok || response.kind === "shop") return response;
        return { ...response, draft: await mergeStoredEtsyReviews(response.draft) };
      }
      if (isReviewCollectionMessage(message)) {
        return startEtsyReviewCollection(document, pageUrl(), message.pageDelayMs);
      }
      return undefined;
    });
  },
});

function isCaptureMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === CAPTURE_PAGE_MESSAGE
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
