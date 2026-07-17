import {
  CaptureDraftSchema,
  type CaptureDomain,
  type CaptureDraft,
} from "@yummyai/contracts";
import { browser } from "wxt/browser";

import { CAPTURE_PAGE_MESSAGE, type CapturePageResponse } from "./capture-messages.js";

export type CaptureProgressState =
  | "pending"
  | "parsing"
  | "preview"
  | "uploading"
  | "normalizing"
  | "complete"
  | "partial"
  | "failed"
  | "cancelled";

export interface CaptureRedaction {
  domain: CaptureDomain;
  includeTitle: boolean;
  includePrice: boolean;
  includeBullets: boolean;
  includedMediaIds: ReadonlySet<string>;
}

export interface CaptureUploadResult {
  captureId?: string;
  status: "complete" | "partial";
  message?: string;
}

export async function readActiveCapture(): Promise<CaptureDraft> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("Open an Amazon or Etsy product page first.");

  const response = (await browser.tabs.sendMessage(tab.id, {
    type: CAPTURE_PAGE_MESSAGE,
  })) as CapturePageResponse | undefined;
  if (!response) throw new Error("YummyAI is not available on this page. Refresh it and try again.");
  if (!response.ok) throw new Error(response.error);
  return CaptureDraftSchema.parse(response.draft);
}

export function redactCaptureDraft(
  draft: CaptureDraft,
  redaction: CaptureRedaction,
): CaptureDraft {
  return CaptureDraftSchema.parse({
    ...draft,
    domain: redaction.domain,
    title: redaction.includeTitle ? draft.title : null,
    price: redaction.includePrice ? draft.price : null,
    bullets: redaction.includeBullets ? draft.bullets : [],
    media: draft.media.map((item) => ({
      ...item,
      included: redaction.includedMediaIds.has(item.id),
    })),
  });
}

export async function uploadCapture(
  draft: CaptureDraft,
  options: {
    apiBaseUrl: string;
    accessToken?: string;
    signal?: AbortSignal;
    onProgress?: (state: CaptureProgressState) => void;
  },
): Promise<CaptureUploadResult> {
  options.onProgress?.("uploading");
  const response = await fetch(`${options.apiBaseUrl.replace(/\/$/, "")}/v1/captures`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
    },
    body: JSON.stringify(draft),
    signal: options.signal,
  });

  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as
      | { detail?: string; title?: string }
      | null;
    throw new Error(problem?.detail ?? problem?.title ?? `Capture upload failed (${response.status}).`);
  }

  options.onProgress?.("normalizing");
  const payload = (await response.json().catch(() => ({}))) as Partial<CaptureUploadResult>;
  const status = response.status === 207 || payload.status === "partial" ? "partial" : "complete";
  options.onProgress?.(status);
  return {
    ...(payload.captureId ? { captureId: payload.captureId } : {}),
    status,
    ...(payload.message ? { message: payload.message } : {}),
  };
}
