import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";

import {
  CAPTURE_PAGE_MESSAGE,
  capturePublicPage,
  type CapturePageRequest,
} from "../lib/capture-messages.js";

export default defineContentScript({
  matches: [
    "https://*.amazon.com/*",
    "https://*.amazon.co.uk/*",
    "https://*.amazon.ca/*",
    "https://*.amazon.de/*",
    "https://*.amazon.fr/*",
    "https://*.amazon.it/*",
    "https://*.amazon.es/*",
    "https://*.amazon.co.jp/*",
  ],
  main() {
    browser.runtime.onMessage.addListener((message: unknown) => {
      if (!isCaptureMessage(message)) return undefined;
      return Promise.resolve(
        capturePublicPage(
          document,
          new URL(window.location.href),
          browser.runtime.getManifest().version,
          { includeReviews: message.includeReviews },
        ),
      );
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
