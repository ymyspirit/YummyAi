import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProductEditor, type ProductPlanView } from "./product-editor";

describe("product editor associations", () => {
  it("links the real research, design, and Listing records", () => {
    const html = renderToStaticMarkup(<ProductEditor initialPlan={plan()} />);
    expect(html).toContain("关联工作");
    expect(html).toContain('/analysis/report-1');
    expect(html).toContain('/design?task=design-1');
    expect(html).toContain('/listings/listing-1');
    expect(html).toContain("MUG-NAVY");
    expect(html).toContain("ATVPDKIKX0DER");
  });

  it("keeps unavailable associations explicit", () => {
    const value = plan();
    value.sourceReportIds = [];
    value.designTasks = [];
    value.listings = [];
    const html = renderToStaticMarkup(<ProductEditor initialPlan={value} />);
    expect(html).toContain("尚未关联研究报告");
    expect(html).toContain("当前 SPU/SKU 尚未创建设计任务");
    expect(html).toContain("当前 SPU 尚未创建 Listing");
  });
});

function plan(): ProductPlanView {
  return {
    id: "plan-1",
    name: "Travel mug",
    status: "developing",
    sourceReportIds: ["report-1"],
    customization: { version: 1, fields: [] },
    spu: { id: "spu-1", code: "MUG", name: "Travel mug", skus: [{ id: "sku-1", code: "MUG-NAVY", attributes: { color: "navy" } }] },
    suppliers: [],
    designTasks: [{ id: "design-1", skuCode: "MUG-NAVY", title: "Production proof", status: "open" }],
    listings: [{ id: "listing-1", platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "draft" }],
  };
}
