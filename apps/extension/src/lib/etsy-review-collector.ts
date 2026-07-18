import { CaptureDraftSchema, type CaptureDraft, type CapturedReview } from "@yummyai/contracts";
import { browser } from "wxt/browser";

import { extractEtsyReviews } from "../parsers/etsy.js";

export const COLLECT_ALL_REVIEWS_MESSAGE = "yummyai:collect-all-reviews";
export const MIN_REVIEW_PAGE_DELAY_MS = 1_500;
export const MAX_REVIEW_PAGE_DELAY_MS = 15_000;

interface StoredReviewCollection {
  listingId: string;
  reviews: CapturedReview[];
  reportedTotal: number | null;
  pageSignatures: string[];
  status: "visible" | "in_progress" | "complete" | "paused";
  updatedAt: string;
  message?: string;
}

let runningCollection: Promise<void> | null = null;

export async function captureVisibleEtsyReviews(
  document: Document,
  url: URL,
  status?: StoredReviewCollection["status"],
): Promise<StoredReviewCollection | null> {
  const listingId = url.pathname.match(/^\/listing\/(\d+)/i)?.[1];
  if (!listingId) return null;
  const current = await readStoredCollection(listingId);
  const visible = extractEtsyReviews(document);
  const reviews = mergeReviews(current?.reviews ?? [], visible);
  const signature = visible
    .map((review) => review.externalId)
    .sort()
    .join(":");
  const reportedTotal = findReportedTotal(document) ?? current?.reportedTotal ?? null;
  const next: StoredReviewCollection = {
    listingId,
    reviews,
    reportedTotal,
    pageSignatures: signature
      ? [...new Set([...(current?.pageSignatures ?? []), signature])]
      : (current?.pageSignatures ?? []),
    status:
      reportedTotal !== null && reviews.length >= reportedTotal
        ? "complete"
        : (status ?? current?.status ?? "visible"),
    updatedAt: new Date().toISOString(),
  };
  await browser.storage.local.set({ [storageKey(listingId)]: next });
  return next;
}

export async function mergeStoredEtsyReviews(draft: CaptureDraft): Promise<CaptureDraft> {
  if (draft.platform !== "etsy" || !draft.externalId) return draft;
  const stored = await readStoredCollection(draft.externalId);
  if (!stored) return draft;
  const reviews = mergeReviews(draft.reviews, stored.reviews);
  return CaptureDraftSchema.parse({
    ...draft,
    reviews,
    reviewCollection: {
      collectedCount: reviews.length,
      reportedTotal: stored.reportedTotal ?? draft.reviewCollection.reportedTotal,
      pageCount: stored.pageSignatures.length,
      status: stored.status,
      updatedAt: stored.updatedAt,
    },
  });
}

export function startEtsyReviewCollection(
  document: Document,
  url: URL,
  requestedDelayMs: number,
): { started: boolean; pageDelayMs: number } {
  const pageDelayMs = Math.min(
    Math.max(Math.round(requestedDelayMs), MIN_REVIEW_PAGE_DELAY_MS),
    MAX_REVIEW_PAGE_DELAY_MS,
  );
  if (runningCollection) return { started: false, pageDelayMs };
  runningCollection = collectAllPages(document, url, pageDelayMs).finally(() => {
    runningCollection = null;
  });
  return { started: true, pageDelayMs };
}

async function collectAllPages(document: Document, url: URL, pageDelayMs: number): Promise<void> {
  const listingId = url.pathname.match(/^\/listing\/(\d+)/i)?.[1];
  if (!listingId) return;
  try {
    const openButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => normalize(button.textContent) === "View all reviews for this item",
    );
    if (openButton) openButton.click();
    const dialog = await waitForReviewDialog(document);
    if (!dialog) {
      await pauseCollection(document, url, "没有打开 Etsy 全部评论弹层。");
      return;
    }

    for (let page = 0; page < 250; page += 1) {
      if (hasSecurityChallenge(document)) {
        await pauseCollection(document, url, "Etsy 要求进行安全验证，已保留当前进度。");
        return;
      }
      const before = reviewSignature(dialog);
      const collection = await captureVisibleEtsyReviews(document, url, "in_progress");
      if (!collection || collection.status === "complete") return;
      const nextButton = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => normalize(button.textContent) === "Next" && !button.disabled,
      );
      if (!nextButton) {
        await setCollectionStatus(listingId, "complete");
        return;
      }
      await delay(pageDelayMs);
      nextButton.click();
      const changed = await waitForReviewChange(dialog, before);
      if (!changed) {
        await pauseCollection(document, url, "下一页评论没有加载，已保留当前进度。");
        return;
      }
    }
    await pauseCollection(document, url, "达到单次采集页数上限，已保留当前进度。");
  } catch (error) {
    await pauseCollection(
      document,
      url,
      error instanceof Error ? error.message : "评论采集意外停止。",
    );
  }
}

async function pauseCollection(document: Document, url: URL, message: string): Promise<void> {
  const collection = await captureVisibleEtsyReviews(document, url, "paused");
  if (!collection) return;
  await browser.storage.local.set({
    [storageKey(collection.listingId)]: { ...collection, status: "paused", message },
  });
}

async function setCollectionStatus(
  listingId: string,
  status: StoredReviewCollection["status"],
): Promise<void> {
  const current = await readStoredCollection(listingId);
  if (!current) return;
  await browser.storage.local.set({
    [storageKey(listingId)]: { ...current, status, updatedAt: new Date().toISOString() },
  });
}

async function readStoredCollection(listingId: string): Promise<StoredReviewCollection | null> {
  const key = storageKey(listingId);
  const result = await browser.storage.local.get(key);
  const value = result[key] as StoredReviewCollection | undefined;
  return value?.listingId === listingId && Array.isArray(value.reviews) ? value : null;
}

function findReportedTotal(document: Document): number | null {
  const text = normalize(
    [...document.querySelectorAll('[role="dialog"], #reviews')]
      .map((node) => node.textContent)
      .join(" "),
  );
  const value =
    text.match(/Reviews for this item\s*\((\d[\d,]*)\)/i)?.[1] ??
    text.match(/\((\d[\d,]*)\s+reviews?\)/i)?.[1];
  return value ? Number(value.replaceAll(",", "")) : null;
}

function mergeReviews(left: CapturedReview[], right: CapturedReview[]): CapturedReview[] {
  return [...new Map([...left, ...right].map((review) => [review.externalId, review])).values()];
}

function reviewSignature(container: Element): string {
  return [...container.querySelectorAll<HTMLElement>("[data-review-region]")]
    .map((node) => node.getAttribute("data-review-region"))
    .filter(Boolean)
    .join(":");
}

async function waitForReviewDialog(document: Document): Promise<HTMLElement | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"], .wt-overlay')].find(
      (node) => /^Reviews for this item/i.test(normalize(node.innerText || node.textContent)),
    );
    if (dialog) return dialog;
    await delay(250);
  }
  return null;
}

async function waitForReviewChange(container: Element, previous: string): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(250);
    const current = reviewSignature(container);
    if (current && current !== previous) return true;
  }
  return false;
}

function hasSecurityChallenge(document: Document): boolean {
  return Boolean(
    document.querySelector('iframe[src*="captcha"], [data-captcha]') ||
    /captcha|security check|verify you are human/i.test(document.title),
  );
}

function storageKey(listingId: string): string {
  return `yummyai.etsy.reviews.${listingId}`;
}

function normalize(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
