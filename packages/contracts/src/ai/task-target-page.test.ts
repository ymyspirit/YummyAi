import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";
import { AssistTaskTargetQuerySchema, AssistTaskTargetsSchema } from "./task-workspace.js";
import { ASSIST_TARGET_PAGE_VERSION, AssistTargetPageQuerySchema, AssistTargetPageViewSchema, assistTargetPageHref } from "./task-target-page.js";

const item = (kind: "order_review" | "procurement_review" = "order_review") => {
  const id = kind === "procurement_review" ? `${createEntityId()}:${createEntityId()}` : createEntityId();
  return { id, label: "Synthetic original business object", detail: "Original owner projection", href: assistTargetPageHref(kind, id) };
};
const page = () => ({ version: ASSIST_TARGET_PAGE_VERSION, effect: "read", kind: "order_review", contextAuthority: "synthetic authority",
  checkedAt: "2026-10-22T00:00:00.000Z", collectionFingerprint: "a".repeat(64), total: 101, readCount: 1,
  consistency: "unchanged_collection", complete: false, nextCursor: "opaque-original-cursor",
  query: { kind: "order_review", q: "", pageSize: 1 }, items: [item()] });

describe("Additive native Assist target pages", () => {
  it("keeps the original v1 target ABI while bounding and normalizing the new page query", () => {
    expect(AssistTaskTargetQuerySchema.parse({ kind: "order_review", q: " original " })).toEqual({ kind: "order_review", q: "original" });
    const legacy = { items: Array.from({ length: 40 }, () => item()), hasMore: true };
    expect(AssistTaskTargetsSchema.parse(legacy)).toEqual(legacy);
    expect(AssistTargetPageQuerySchema.parse({ kind: "order_review", q: " original " })).toEqual({ kind: "order_review", q: "original", pageSize: 40 });
    expect(AssistTargetPageQuerySchema.parse({ kind: "order_review", pageSize: "100" }).pageSize).toBe(100);
    for (const extra of [{ pageSize: 101 }, { pageSize: 0 }, { cursor: "" }, { offset: 40 }, { kind: "dynamic_owner" }])
      expect(AssistTargetPageQuerySchema.safeParse({ kind: "order_review", ...extra }).success).toBe(false);
  });

  it("requires an exact complete final page instead of treating a bounded prefix as the whole collection", () => {
    expect(AssistTargetPageViewSchema.parse(page()).complete).toBe(false);
    const final = { ...page(), total: 101, readCount: 101, complete: true, nextCursor: null, query: { ...page().query, cursor: "opaque-original-previous-page" } };
    expect(AssistTargetPageViewSchema.parse(final).readCount).toBe(101);
    const duplicate = item();
    for (const changed of [
      { complete: true, nextCursor: null }, { readCount: 102 }, { readCount: 0 },
      { total: 1 }, { nextCursor: null }, { kind: "creative" },
      { items: [duplicate, duplicate], query: { ...page().query, pageSize: 2 }, readCount: 2 },
    ]) expect(AssistTargetPageViewSchema.safeParse({ ...page(), ...changed }).success).toBe(false);
    expect(AssistTargetPageViewSchema.parse({ ...page(), total: 0, readCount: 0, items: [], nextCursor: null, complete: true }).complete).toBe(true);
  });

  it("binds the original typed object and local destination, with composite procurement IDs and no fabricated knowledge objects", () => {
    const source = item("procurement_review");
    expect(AssistTargetPageViewSchema.parse({ ...page(), kind: "procurement_review", query: { ...page().query, kind: "procurement_review" }, items: [source] }).items).toEqual([source]);
    for (const source of [ { ...item(), href: "https://external.invalid" }, { ...item(), id: "arbitrary_sql" },
      { ...item(), id: `${createEntityId()}:${createEntityId()}` } ])
      expect(AssistTargetPageViewSchema.safeParse({ ...page(), items: [source] }).success).toBe(false);
    const knowledge = { ...page(), kind: "knowledge_answer", query: { ...page().query, kind: "knowledge_answer" }, total: 0, readCount: 0, items: [], complete: true, nextCursor: null };
    expect(AssistTargetPageViewSchema.parse(knowledge).items).toEqual([]);
    expect(AssistTargetPageViewSchema.safeParse({ ...knowledge, items: [{ ...item(), href: "/knowledge" }], total: 1, readCount: 1 }).success).toBe(false);
  });
});
