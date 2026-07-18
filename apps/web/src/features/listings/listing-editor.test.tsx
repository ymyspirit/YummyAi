import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListingEditor, type ListingEditorView } from "./listing-editor";

describe("listing editor", () => {
  it("renders stable platform tabs, field provenance, and validation", () => {
    const html = renderToStaticMarkup(<ListingEditor listing={fixture()} />);
    for (const tab of ["Content", "Media", "Variants", "Attributes", "Compliance", "History"]) expect(html).toContain(tab);
    expect(html).toContain("AI SUGGESTION");
    expect(html).toContain("刊登健康度");
    expect(html).toContain("attributes.brand");
    expect(html).toContain("amazon-2026.07");
  });
});

function fixture(): ListingEditorView {
  const content = { platform: "amazon" as const, locale: "en-US", title: "Travel mug", description: "Gift ready", bullets: ["Personalized"], tags: [], mainImageId: "asset", mediaAssetIds: ["asset"], variants: [{ skuId: "sku", skuCode: "MUG", optionValues: {} }], attributes: {}, compliance: { countryOfOrigin: "CN" } };
  return { id: "listing", platform: "amazon", locale: "en-US", status: "draft", spuCode: "MUG", versionNumber: 3, ruleVersion: "amazon-2026.07", source: "human", updatedAt: "2026-07-18T00:00:00Z", content, validation: { completeness: 83, blockers: [{ severity: "blocker", code: "common.required", path: "attributes.brand", message: "brand is required", ruleVersion: "amazon-2026.07" }], warnings: [] }, history: [] };
}
