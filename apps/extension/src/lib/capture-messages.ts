import { CaptureDraftSchema, type CaptureDraft } from "@yummyai/contracts";

import { parserFor } from "../parsers/parser.js";

export const CAPTURE_PAGE_MESSAGE = "yummyai:capture-page";

export type CapturePageResponse =
  | { ok: true; draft: CaptureDraft }
  | { ok: false; error: string };

export function capturePublicPage(
  document: Document,
  url: URL,
  extensionVersion = "development",
): CapturePageResponse {
  try {
    const draft = parserFor(url, document).parse(document, url);
    return {
      ok: true,
      draft: CaptureDraftSchema.parse({ ...draft, extensionVersion }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "This page could not be captured.",
    };
  }
}
