import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErpSidebar, type ErpSection } from "./erp-sidebar";

describe("ErpSidebar", () => {
  it.each<ErpSection>([
    "dashboard",
    "research",
    "competitors",
    "products",
    "workflows",
    "pod-workbench",
    "creative-designs",
    "mockup-batches",
    "design",
    "stores",
    "listings",
    "orders",
    "inventory",
    "procurement",
    "supplier-performance",
    "channel-inventory",
    "finance",
    "customer-intelligence",
    "operating-cockpit",
  ])("keeps every primary destination visible when %s is active", (active) => {
    const html = renderToStaticMarkup(
      <ErpSidebar active={active} contextLabel="TEST" note="Navigation test" />,
    );

    for (const label of [
      "运营总览",
      "研究资料库",
      "竞争店铺",
      "产品目录",
      "工作流中心",
      "POD 作图中心",
      "画图设计",
      "批量套图",
      "设计校样",
      "店铺运营",
      "刊登控制台",
      "订单履约",
      "库存台账",
      "采购补货",
      "供应商绩效",
      "渠道库存",
      "财务利润",
      "广告与 VOC",
      "数据与集成",
    ]) {
      expect(html).toContain(label);
    }
    for (const group of ["总览", "研究", "商品", "创意设计", "交易履约", "供应链", "经营洞察"]) {
      expect(html).toContain(`>${group}</p>`);
    }

    const creativeStart = html.indexOf('id="rail-group-creative"');
    const catalogStart = html.indexOf('id="rail-group-catalog"');
    const commerceStart = html.indexOf('id="rail-group-commerce"');
    const creativeNavigation = html.slice(creativeStart, catalogStart);
    const catalogNavigation = html.slice(catalogStart, commerceStart);

    expect(creativeStart).toBeGreaterThan(-1);
    expect(catalogStart).toBeGreaterThan(creativeStart);
    for (const label of ["画图设计", "POD 作图中心", "设计校样", "批量套图"]) {
      expect(creativeNavigation).toContain(label);
      expect(catalogNavigation).not.toContain(label);
    }
    for (const label of ["产品目录", "工作流中心", "刊登控制台"]) {
      expect(catalogNavigation).toContain(label);
      expect(creativeNavigation).not.toContain(label);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
