import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ResearchTable } from "./research-table";

describe("ResearchTable", () => {
  it("renders research rows and their snapshot timeline without client filtering", () => {
    const html = renderToStaticMarkup(<ResearchTable items={[{
      id:"item-1", platform:"amazon", marketplace:"amazon.com", normalizedUrl:"https://amazon.com/dp/B000000001", latestTitle:"Personalized Sample Product", latestStatus:"partial", lastCapturedAt:"2026-07-18T00:00:00.000Z",
      snapshots:[{ id:"snapshot-2", capturedAt:"2026-07-18T00:00:00.000Z", status:"partial", title:"Updated product" }, { id:"snapshot-1", capturedAt:"2026-07-17T00:00:00.000Z", status:"complete", title:"Original product" }],
    }]} nextCursor={null} />);
    expect(html).toContain("Personalized Sample Product");
    expect(html).toContain("Updated product");
    expect(html).toContain("Original product");
    expect(html).toContain("partial");
  });
});
