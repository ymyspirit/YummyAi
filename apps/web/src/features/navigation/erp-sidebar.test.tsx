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
    for (const group of NAVIGATION_GROUPS.filter((group) => group.id !== "overview")) {
      expect(html).toContain(`>${group.label}</span>`);
      expect(html).toContain(`aria-controls="rail-items-${group.id}"`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-keyshortcuts="Control+k Meta+k"');
    expect(html).toContain('aria-label="打开全部导航"');
    const creativeStart = html.indexOf('id="rail-group-creative"');
    const catalogStart = html.indexOf('id="rail-group-catalog"');
    const researchStart = html.indexOf('id="rail-group-research"');
    const creative = html.slice(creativeStart, catalogStart);
    const catalog = html.slice(catalogStart, researchStart);
    expect(creativeStart).toBeGreaterThan(-1);
    expect(catalogStart).toBeGreaterThan(creativeStart);
    for (const label of ["创意工作台", "生产文件与底稿", "商品套图"]) {
      expect(creative).toContain(label);
      expect(catalog).not.toContain(label);
    }
    for (const href of ["/creative-designs", "/pod-workbench", "/design", "/orders/import"]) expect(creative).not.toContain(`href="${href}"`);
    for (const label of ["产品目录", "工作流中心", "刊登控制台"]) {
      expect(catalog).toContain(label);
      expect(creative).not.toContain(label);
    }
  });

  it("keeps the listing destination stable on a detail route", () => {
    route.pathname = "/listings/example-listing";
    const html = renderToStaticMarkup(<ErpSidebar />);
    expect(html).toContain('href="/listings"');
    expect(html).not.toContain('href="/listings/example-listing"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
