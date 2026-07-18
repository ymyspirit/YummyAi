import {
  CaptureDraftSchema,
  CompetitorShopDraftSchema,
  type CaptureDomain,
  type CaptureDraft,
  type CompetitorShopDraft,
} from "@yummyai/contracts";
import { browser } from "wxt/browser";

import {
  CAPTURE_PAGE_MESSAGE,
  withoutReviewEvidence,
  type CapturePageResponse,
} from "./capture-messages.js";
import { COLLECT_ALL_REVIEWS_MESSAGE } from "./etsy-review-collector.js";

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
  includeReviews: boolean;
  includedMediaIds: ReadonlySet<string>;
}

export interface CaptureUploadResult {
  captureId?: string;
  status: "complete" | "partial";
  message?: string;
}

export type ActiveEvidence =
  { kind: "product"; draft: CaptureDraft } | { kind: "shop"; draft: CompetitorShopDraft };

export async function readActiveEvidence(
  options: { includeReviews?: boolean } = {},
): Promise<ActiveEvidence> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("请先打开 Amazon、Etsy 商品页或 Etsy 店铺页。");

  const response = (await browser.tabs.sendMessage(tab.id, {
    type: CAPTURE_PAGE_MESSAGE,
    includeReviews: options.includeReviews ?? false,
  })) as CapturePageResponse | undefined;
  if (!response) throw new Error("YummyAI 未连接当前页面，请刷新页面后重试。");
  if (!response.ok) throw new Error(response.error);
  return response.kind === "shop"
    ? { kind: "shop", draft: CompetitorShopDraftSchema.parse(response.draft) }
    : { kind: "product", draft: CaptureDraftSchema.parse(response.draft) };
}

export async function readActiveCapture(): Promise<CaptureDraft> {
  const evidence = await readActiveEvidence();
  if (evidence.kind !== "product") throw new Error("当前页面是店铺页面，不是商品页面。");
  return evidence.draft;
}

export async function startActiveReviewCollection(pageDelayMs: number): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("请先打开 Etsy 商品页面。");
  const response = (await browser.tabs.sendMessage(tab.id, {
    type: COLLECT_ALL_REVIEWS_MESSAGE,
    pageDelayMs,
  })) as { started?: boolean } | undefined;
  if (!response) throw new Error("评论采集器未连接，请刷新 Etsy 页面后重试。");
}

export function redactCaptureDraft(draft: CaptureDraft, redaction: CaptureRedaction): CaptureDraft {
  const redacted = CaptureDraftSchema.parse({
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
  return redaction.includeReviews ? redacted : withoutReviewEvidence(redacted);
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
    const problem = (await response.json().catch(() => null)) as {
      detail?: string;
      title?: string;
    } | null;
    throw new Error(
      problem?.detail ?? problem?.title ?? `Capture upload failed (${response.status}).`,
    );
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

export async function uploadCompetitorShop(
  draft: CompetitorShopDraft,
  options: {
    apiBaseUrl: string;
    accessToken?: string;
    signal?: AbortSignal;
    onProgress?: (state: CaptureProgressState) => void;
  },
): Promise<CaptureUploadResult> {
  options.onProgress?.("uploading");
  const response = await fetch(
    `${options.apiBaseUrl.replace(/\/$/, "")}/v1/competitor-shops/captures`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
      },
      body: JSON.stringify(CompetitorShopDraftSchema.parse(draft)),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as {
      detail?: string;
      title?: string;
    } | null;
    throw new Error(problem?.detail ?? problem?.title ?? `店铺快照上传失败 (${response.status})。`);
  }
  options.onProgress?.("complete");
  return { status: "complete" };
}
