import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ErpSidebar, type ErpSection } from "./erp-sidebar";

describe("ErpSidebar", () => {
  it.each<ErpSection>(["dashboard", "research", "competitors", "products", "design", "listings"])(
    "keeps every primary destination visible when %s is active",
    (active) => {
      const html = renderToStaticMarkup(
        <ErpSidebar active={active} contextLabel="TEST" note="Navigation test" />,
      );

      for (const label of [
        "运营总览",
        "研究资料库",
        "竞争店铺",
        "产品开发",
        "设计校样",
        "刊登控制台",
      ]) {
        expect(html).toContain(label);
      }
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    },
  );
});
