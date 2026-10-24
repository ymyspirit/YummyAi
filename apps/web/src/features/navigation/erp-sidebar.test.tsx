import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ErpSidebar } from "./erp-sidebar";
import { NAVIGATION_GROUPS, PRIMARY_DESTINATIONS } from "./navigation-registry";

const route = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

describe("ErpSidebar", () => {
  it.each(PRIMARY_DESTINATIONS)("keeps every destination available on $href", (destination) => {
    route.pathname = destination.href;
    const html = renderToStaticMarkup(<ErpSidebar />);
    for (const item of PRIMARY_DESTINATIONS) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(item.label);
    }
    for (const group of NAVIGATION_GROUPS.filter((item) => item.id !== "overview")) {
      expect(html).toContain(`>${group.label}</span>`);
      expect(html).toContain(`aria-controls="rail-items-${group.id}"`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-keyshortcuts="Control+k Meta+k"');
    expect(html).toContain('aria-label="打开全部导航"');
    expect(html).toContain('class="erp-navigation-collapse"');
  });

  it("puts the selling and fulfillment workflow ahead of supporting tools", () => {
    route.pathname = "/ai-tasks";
    const html = renderToStaticMarkup(<ErpSidebar />);
    const catalogStart = html.indexOf('id="rail-items-catalog"');
    const commerceStart = html.indexOf('id="rail-items-commerce"');
    const creativeStart = html.indexOf('id="rail-items-creative"');
    expect(catalogStart).toBeLessThan(commerceStart);
    expect(commerceStart).toBeLessThan(creativeStart);
    const catalog = html.slice(catalogStart, commerceStart);
    for (const label of ["商品库", "印花库", "销售 SKU 组合", "商品套图", "上架工作台", "刊登管理"]) expect(catalog).toContain(label);
    const commerce = html.slice(commerceStart, creativeStart);
    expect(commerce).toContain('href="/logistics"');
    expect(commerce).not.toContain('href="/stores"');
    expect(html).toContain('href="/business-tasks"');
  });

  it("keeps the listing destination stable on a detail route", () => {
    route.pathname = "/listings/example-listing";
    const html = renderToStaticMarkup(<ErpSidebar />);
    expect(html).toContain('href="/listings"');
    expect(html).not.toContain('href="/listings/example-listing"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
