import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErpSidebar, type ErpSection } from "./erp-sidebar";

describe("ErpSidebar", () => {
  it.each<ErpSection>([
    "dashboard",
    "research",
    "competitors",
    "products",
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
    for (const group of ["总览", "研究", "商品", "交易履约", "供应链", "经营洞察"]) {
      expect(html).toContain(`>${group}</p>`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
