import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SalesPlanContentStep } from "./sales-plan-steps";
import { createEntityId } from "@yummyai/contracts";
import {
  SalesPlanFieldsSchema,
  type SalesPlanOptions,
} from "@yummyai/contracts/catalog/sales-plan";
import {
  removeSalesPlanReference,
  retainUnlistedReferences,
  salesPlanReferenceIssues,
  salesPlanReferenceSelection,
} from "./sales-plan-references";
const fields = () =>
  SalesPlanFieldsSchema.parse({ name: "Synthetic references", mode: "custom", fulfillment: "fbm" });
const options = (): SalesPlanOptions => ({
  contextAuthority: "synthetic",
  preferenceScope: "tenant:user",
  spus: [],
  specifications: [],
  skus: [],
  artworks: [],
  researchItems: [],
  assets: [],
  projects: [],
  accounts: [],
  access: {
    research: true,
    design: true,
    assets: true,
    listing: true,
    write: true,
    listingWrite: true,
  },
});
describe("sales-plan explicit reference repair", () => {
  it("retains an unlisted old choice when visible choices change until its explicit removal", () => {
    const old = createEntityId(),
      a = createEntityId(),
      b = createEntityId();
    expect(retainUnlistedReferences([old, a], [b], [a, b])).toEqual([old, b]);
    const f = { ...fields(), researchItemIds: [old, b] };
    const repaired = removeSalesPlanReference(f, { kind: "research", label: "研究商品", id: old });
    expect(repaired.researchItemIds).toEqual([b]);
    expect(f.researchItemIds).toEqual([old, b]);
  });
  it("removes all uses of one explicitly chosen asset without changing other assets or copy", () => {
    const old = createEntityId(),
      keep = createEntityId();
    const f = {
      ...fields(),
      title: "Preserved title",
      mediaAssetIds: [old, keep],
      mainImageId: old,
      customMaterials: [
        { fieldKey: "", label: "Old", assetId: old, optionValue: "" },
        { fieldKey: "", label: "Keep", assetId: keep, optionValue: "" },
      ],
    };
    expect(salesPlanReferenceSelection(f).assetIds).toHaveLength(2);
    const next = removeSalesPlanReference(f, { kind: "asset", label: "授权素材", id: old });
    expect(next.mediaAssetIds).toEqual([keep]);
    expect(next.mainImageId).toBeNull();
    expect(next.customMaterials).toEqual([f.customMaterials[1]]);
    expect(next.title).toBe(f.title);
  });
  it("does not replace a valid historical artwork version with the latest option", () => {
    const old = createEntityId(),
      latest = createEntityId(),
      spu = createEntityId(),
      o = options();
    o.artworks = [
      { versionId: old, mode: "fixed" },
      { versionId: latest, mode: "fixed" },
    ] as SalesPlanOptions["artworks"];
    const f = { ...fields(), artworkVersionIds: [old] };
    expect(salesPlanReferenceIssues(f, o, spu)).toEqual([]);
    expect(f.artworkVersionIds).toEqual([old]);
  });
  it("keeps product and artwork-mode mismatches visible rather than silently deleting them", () => {
    const sku = createEntityId(),
      art = createEntityId(),
      spu = createEntityId(),
      o = options();
    o.skus = [{ id: sku, code: "Other", spuId: createEntityId(), attributes: {} }];
    o.artworks = [{ versionId: art, mode: "customer_image" }] as SalesPlanOptions["artworks"];
    const f = { ...fields(), mode: "standard" as const, skuIds: [sku], artworkVersionIds: [art] };
    expect(salesPlanReferenceIssues(f, o, spu).map((i) => i.kind)).toEqual(["sku", "artwork"]);
    expect(f.skuIds).toEqual([sku]);
  });
  it("keeps a selected image visible beyond the first 24 candidates", () => {
    const o = options();
    o.assets = Array.from({ length: 30 }, (_, i) => ({
      id: createEntityId(),
      fileName: i === 29 ? "Selected outside first page.png" : `Candidate ${i}.png`,
      mediaType: "image/png",
    }));
    const f = { ...fields(), mode: "standard" as const, mediaAssetIds: [o.assets[29]!.id] };
    const html = renderToStaticMarkup(
      createElement(SalesPlanContentStep, {
        fields: f,
        options: o,
        spuId: createEntityId(),
        disabled: false,
        current: "/sales-plans",
        change: () => {},
      }),
    );
    expect(html).toContain('alt="Selected outside first page.png"');
    expect(html).toContain(`assets/${o.assets[29]!.id}/preview`);
  });
});
