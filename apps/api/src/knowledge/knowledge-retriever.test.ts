import { describe, expect, it } from "vitest";
import type { KnowledgeFields, KnowledgeSearch } from "@yummyai/contracts/knowledge";
import {
  knowledgeEligible,
  knowledgeExcerpt,
  knowledgeTerms,
  scoreKnowledge,
} from "./knowledge-retriever.js";
const fields: KnowledgeFields = {
  title: "定制抱枕 Listing 文案",
  summary: "原文与商品事实",
  body: "定制抱枕需要说明买家如何上传照片",
  topic: "listing",
  platform: "amazon",
  market: "US",
  spuId: null,
  sourceType: "team",
  sourceLabel: "Synthetic SOP",
  sourceUrl: "",
  owner: "Synthetic operator",
  verifiedOn: "2026-01-01",
  reviewDueOn: "2026-12-31",
  tags: ["抱枕"],
};
const input: KnowledgeSearch = {
  query: "定制抱枕文案",
  topic: "listing",
  platform: "amazon",
  market: "US",
  spuIds: [],
};
describe("knowledge context and keyword retrieval", () => {
  it("filters wrong platform, market, product, future and overdue versions", () => {
    expect(knowledgeEligible(fields, input, "2026-10-06")).toBe(true);
    for (const patch of [
      { platform: "etsy" },
      { market: "GB" },
      { spuId: "unmatched" },
      { verifiedOn: "2026-11-01" },
      { reviewDueOn: "2026-01-02" },
    ])
      expect(
        knowledgeEligible({ ...fields, ...patch } as KnowledgeFields, input, "2026-10-06"),
      ).toBe(false);
    expect(
      knowledgeEligible({ ...fields, platform: "all", market: "ALL" }, input, "2026-10-06"),
    ).toBe(true);
  });
  it("supports Chinese words and full-width Latin input without pretending semantic search", () => {
    expect(knowledgeTerms("定制抱枕 ＬＩＳＴＩＮＧ")).toContain("listing");
    expect(knowledgeTerms("猫")).toContain("猫");
    expect(scoreKnowledge({ ...fields, title: "猫照片上传说明" }, "猫")).toBeGreaterThan(0);
    expect(scoreKnowledge(fields, input.query)).toBeGreaterThan(0);
    expect(scoreKnowledge(fields, "unrelatedwordxyz")).toBe(0);
  });
  it("returns a bounded excerpt around a late match", () => {
    const body = "前置资料。".repeat(600) + "custom pillow" + "后续资料。".repeat(600);
    const excerpt = knowledgeExcerpt(body, "custom pillow");
    expect(excerpt).toContain("custom pillow");
    expect(excerpt.length).toBeLessThanOrEqual(2002);
  });
});
