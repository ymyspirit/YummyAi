import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { filterProductPlans, ProductCatalog } from "./product-catalog";
import type { ProductPlanView } from "./product-editor";

describe("ProductCatalog", () => {
  it("renders real product signals, filters, and deep links", () => {
    const items = fixture();
    const html = renderToStaticMarkup(
      <ProductCatalog items={items} owner="owner-1" query="mug" selectedId={items[0]!.id} status="developing" />,
    );

    expect(html).toContain("产品目录");
    expect(html).toContain("新增产品");
    expect(html).toContain("创建产品企划");
    expect(html).toContain('name="targetCostAmount"');
    expect(html).toContain('name="sourceReportIds"');
    expect(html).toContain("Travel Mug Gift");
    expect(html).toContain("1 / 2 RECORDS");
    expect(html).toContain('name="q"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="owner"');
    expect(html).toContain("Lin Q.");
    expect(html).toContain("TRAVEL-MUG-GIFT");
    expect(html).toContain("2 个 SKU");
    expect(html).toContain("更新时间");
    expect(html).toContain(`plan=${items[0]!.id}`);
    expect(html).toContain("is-selected");
  });

  it("filters by query and status without fabricating missing results", () => {
    const items = fixture();

    expect(filterProductPlans(items, "mug", "developing", "owner-1")).toEqual([items[0]]);
    expect(filterProductPlans(items, "poster", "ready")).toEqual([items[1]]);
    expect(filterProductPlans(items, "unknown", "")).toEqual([]);

    const html = renderToStaticMarkup(<ProductCatalog items={items} owner="" query="unknown" status="" />);
    expect(html).toContain("没有匹配的产品企划");
    expect(html).toContain("不会用演示产品填充结果");
  });
});

function fixture(): ProductPlanView[] {
  return [
    {
      id: "0198fbef-4a10-7000-8000-000000000041",
      name: "Travel Mug Gift",
      description: "Personalized travel mug for gifting.",
      status: "developing",
      sourceReportIds: ["report-1", "report-2"],
      targetCost: { amount: 8.5, currency: "USD" },
      ownerUserId: "owner-1",
      ownerName: "Lin Q.",
      updatedAt: "2026-07-18T03:12:00.000Z",
      customization: { version: 2, fields: [] },
      spu: { id: "spu-1", code: "TRAVEL-MUG-GIFT", name: "Travel Mug Gift", skus: [{ id: "sku-1", code: "MUG-1", attributes: {} }, { id: "sku-2", code: "MUG-2", attributes: {} }] },
    },
    {
      id: "0198fbef-4a10-7000-8000-000000000042",
      name: "Minimal Poster",
      description: "Ready-to-list wall art.",
      status: "ready",
      sourceReportIds: ["report-3"],
      customization: { version: 1, fields: [] },
    },
  ];
}
