import { createEntityId } from "@yummyai/contracts";
import { ASSIST_TARGET_PAGE_VERSION, type AssistTargetPageQuery } from "@yummyai/contracts/ai/task-target-page";
import { describe, expect, it } from "vitest";
import { mergeAssistTargetPage } from "./task-target-page-client";

const authority = "synthetic actual ERP authority";
const query: AssistTargetPageQuery = { kind: "order_review", q: "original", pageSize: 2 };
function item(id = createEntityId()) { return { id, label: "Synthetic original object", detail: "Original source", href: "/orders?line=" + id }; }
function first() { return { version: ASSIST_TARGET_PAGE_VERSION, effect: "read", kind: query.kind, contextAuthority: authority,
  checkedAt: "2026-10-22T00:00:00.000Z", collectionFingerprint: "a".repeat(64), total: 3, readCount: 2,
  consistency: "unchanged_collection", complete: false, nextCursor: "opaque-original", query, items: [item(), item()] }; }

describe("Native Assist object page accumulation", () => {
  it("retains every original item and calls the collection complete only on its exact final page", () => {
    const raw = first(), previous = mergeAssistTargetPage(null, raw, query, authority);
    expect(previous.complete).toBe(false); expect(previous.items).toHaveLength(2);
    const requested = { ...query, cursor: raw.nextCursor };
    const final = { ...raw, query: requested, items: [item()], readCount: 3, complete: true, nextCursor: null };
    const collected = mergeAssistTargetPage(previous, final, requested, authority);
    expect(collected.items.map(row => row.id)).toEqual([...raw.items, ...final.items].map(row => row.id));
    expect(collected).toMatchObject({ total: 3, readCount: 3, complete: true, nextCursor: null });
    expect(previous.items).toEqual(raw.items);
    const empty = mergeAssistTargetPage(null, { ...raw, total: 0, readCount: 0, complete: true, nextCursor: null, items: [] }, query, authority);
    expect(empty).toMatchObject({ complete: true, readCount: 0, total: 0, items: [] });
  });

  it("rejects stale authority, query, cursor or collection identity without replacing the caller's original pages", () => {
    const raw = first(), previous = mergeAssistTargetPage(null, raw, query, authority), requested = { ...query, cursor: raw.nextCursor };
    const final = { ...raw, query: requested, items: [item()], readCount: 3, complete: true, nextCursor: null };
    for (const corrupt of [ { contextAuthority: "old authority" }, { collectionFingerprint: "b".repeat(64) }, { total: 4, readCount: 4 },
      { query: { ...requested, q: "different" } } ]) {
      expect(() => mergeAssistTargetPage(previous, { ...final, ...corrupt }, requested, authority)).toThrow();
      expect(previous.items).toEqual(raw.items);
    }
    expect(() => mergeAssistTargetPage(previous, final, { ...requested, cursor: "another-cursor" }, authority)).toThrow();
    expect(() => mergeAssistTargetPage(previous, raw, query, authority)).toThrow();
    expect(() => mergeAssistTargetPage(null, final, requested, authority)).toThrow();
  });

  it("rejects cross-page duplicates, invented cumulative counts and foreign destinations rather than silently clipping or deduplicating", () => {
    const raw = first(), previous = mergeAssistTargetPage(null, raw, query, authority), requested = { ...query, cursor: raw.nextCursor };
    const final = { ...raw, query: requested, items: [item()], readCount: 3, complete: true, nextCursor: null };
    for (const changed of [ { items: [raw.items[0]] }, { readCount: 2 }, { items: [{ ...item(), href: "https://external.invalid" }] }, { items: [], readCount: 3 } ])
      expect(() => mergeAssistTargetPage(previous, { ...final, ...changed }, requested, authority)).toThrow();
    expect(previous).toMatchObject({ readCount: 2, complete: false, nextCursor: raw.nextCursor });
  });
});
