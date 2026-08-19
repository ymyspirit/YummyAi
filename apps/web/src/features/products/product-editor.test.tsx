import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  isCustomProductProfileEditable,
  ProductEditor,
  type ProductPlanView,
} from "./product-editor";

describe("product editor associations", () => {
  it("links the real research, design, and Listing records", () => {
    const html = renderToStaticMarkup(<ProductEditor initialPlan={plan()} />);
    expect(html).toContain("关联工作");
    expect(html).toContain("/analysis/report-1");
    expect(html).toContain("/design?task=design-1");
    expect(html).toContain("/listings/listing-1");
    expect(html).toContain("/amazon-custom-sop");
    expect(html).toContain("Amazon Custom 上架资料齐套包");
    expect(html).toContain("下载完整上架资料包");
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

  it("submits the current customization schema from a researching plan", () => {
    const value = plan();
    value.status = "researching";
    value.customization = {
      version: 1,
      fields: [
        { key: "milestone_year", label: "Milestone year", required: true, type: "short_text" },
      ],
    };

    const html = renderToStaticMarkup(<ProductEditor initialPlan={value} />);

    expect(html).toContain('name="customization"');
    expect(html).toContain("milestone_year");
    expect(html).toContain('type="submit"');
    expect(html).toContain("保存产品计划");
  });

  it("keeps the Amazon Studio handoff editable through product development", () => {
    expect(isCustomProductProfileEditable("researching")).toBe(true);
    expect(isCustomProductProfileEditable("approved")).toBe(true);
    expect(isCustomProductProfileEditable("developing")).toBe(true);
    expect(isCustomProductProfileEditable("pending_approval")).toBe(false);
    expect(isCustomProductProfileEditable("listing")).toBe(false);
    expect(isCustomProductProfileEditable("ready")).toBe(false);
    expect(isCustomProductProfileEditable("archived")).toBe(false);
  });
});

function plan(): ProductPlanView {
  return {
    id: "plan-1",
    name: "Travel mug",
    status: "developing",
    sourceReportIds: ["report-1"],
    customization: { version: 1, fields: [] },
    spu: {
      id: "spu-1",
      code: "MUG",
      name: "Travel mug",
      skus: [{ id: "sku-1", code: "MUG-NAVY", attributes: { color: "navy" } }],
    },
    suppliers: [],
    designTasks: [
      { id: "design-1", skuCode: "MUG-NAVY", title: "Production proof", status: "open" },
    ],
    listings: [
      {
        id: "listing-1",
        platform: "amazon",
        marketplaceId: "ATVPDKIKX0DER",
        locale: "en-US",
        status: "draft",
      },
    ],
  };
}
