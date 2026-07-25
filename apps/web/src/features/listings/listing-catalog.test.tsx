import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListingCatalog, type ListingCatalogPageView } from "./listing-catalog";

describe("listing catalog", () => {
  it("renders filters, real gate signals, and complete catalog columns", () => {
    const html = renderToStaticMarkup(<ListingCatalog catalog={catalog()} filters={{ blockers: "all", completeness: "all", direction: "desc", sort: "updatedAt" }} />);
    for (const value of ["Listing 目录", "标题、SPU、Listing ID", "站点 / 店铺标识", "语言", "完整度", "低于 80%", "渠道", "主图已关联", "Travel Mug", "MUG-001", "V04", "86%", "2 阻断", "批量发布门禁"]) expect(html).toContain(value);
    expect(html).toContain("未指定店铺");
    expect(html).not.toContain("销售额");
  });
});

function catalog(): ListingCatalogPageView {
  return { page: 1, limit: 25, total: 1, pages: 1, items: [{ id: "listing-1", spuId: "spu-1", spuCode: "MUG-001", spuName: "Travel Mug", platform: "amazon", locale: "en-US", status: "draft", versionId: "version-4", versionNumber: 4, title: "Travel Mug", hasMainImage: true, completeness: 86, blockerCount: 2, source: "human", updatedAt: "2026-07-25T00:00:00.000Z" }] };
}
