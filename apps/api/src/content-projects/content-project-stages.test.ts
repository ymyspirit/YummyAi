import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { contentProjectStages } from "./content-project-stages.js";

function delivered(): Parameters<typeof contentProjectStages>[0] {
  const skuId = createEntityId(),
    recipeId = createEntityId(),
    designId = createEntityId(),
    listingId = createEntityId(),
    versionId = createEntityId();
  return {
    access: { research: true, catalog: true, listing: true, assets: true },
    researchSources: [],
    legacy: false,
    finalDesignStep: true,
    diagnostics: [],
    results: [
      {
        versionId: createEntityId(),
        assetId: createEntityId(),
        name: "Original",
        status: "approved" as const,
        rejectionReason: null,
        width: 64,
        height: 64,
        previewPath: "/preview",
        productionProjects: [],
      },
    ],
    skus: [
      {
        id: skuId,
        code: "OWN-1",
        spuName: "Canvas",
        recipeId,
        recipeVersion: 1,
        artworkVersionId: createEntityId(),
        specificationVersionId: createEntityId(),
        specificationName: "Square",
        factsConfirmed: true,
        material: "Canvas",
        dimensions: "50 mm",
        packageContents: "One",
        status: "approved" as const,
        designVersionId: designId,
        needsUpdate: false,
        belongsToProject: true,
      },
    ],
    mockups: [
      {
        itemId: createEntityId(),
        batchId: createEntityId(),
        skuId,
        skuCode: "OWN-1",
        designVersionId: designId,
        status: "completed",
        requiredCount: 2,
        approvedCount: 2,
        failedCount: 0,
        current: true,
      },
    ],
    listings: [
      {
        id: listingId,
        versionId,
        version: 1,
        title: "Canvas",
        platform: "etsy" as const,
        locale: "en-US",
        status: "approved",
        blockers: [],
        skuIds: [skuId],
      },
    ],
    packages: [
      {
        id: createEntityId(),
        skuId,
        skuCode: "OWN-1",
        recipeId,
        listingId,
        listingVersionId: versionId,
        version: 1,
        platform: "etsy" as const,
        locale: "en-US",
        checksum: "a".repeat(64),
        current: true,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}
const stage = (p: Parameters<typeof contentProjectStages>[0], key: string) =>
  contentProjectStages(p).find((s) => s.key === key)!;
describe("content delivery readiness", () => {
  it("allows original projects without research while requiring completed design review", () => {
    const p = delivered();
    expect(stage(p, "research").status).toBe("optional");
    expect(stage(p, "delivery").status).toBe("complete");
    p.finalDesignStep = false;
    expect(stage(p, "design").status).toBe("in_progress");
  });
  it("does not call a mixed multi-SKU project complete from one successful SKU", () => {
    const p = delivered();
    p.skus.push({ ...p.skus[0], id: createEntityId(), code: "OWN-2" });
    p.listings[0].skuIds.push(p.skus[1].id);
    expect(stage(p, "mockup").status).toBe("in_progress");
    expect(stage(p, "delivery").status).toBe("blocked");
  });
  it("keeps old packages visible without treating them as current deliverables", () => {
    const p = delivered();
    p.skus[0].needsUpdate = true;
    expect(stage(p, "sku").status).toBe("blocked");
    expect(stage(p, "delivery").status).toBe("blocked");
  });
  it("requires a package for each selected marketplace and listing version", () => {
    const p = delivered();
    p.listings.push({ ...p.listings[0], id: createEntityId(), locale: "de-DE" });
    expect(stage(p, "delivery").status).toBe("blocked");
    p.listings.pop();
    p.packages[0].listingVersionId = createEntityId();
    expect(stage(p, "delivery").status).toBe("blocked");
  });
  it("shows missing permissions and refuses completion from truncated evidence", () => {
    const p = delivered();
    p.access.catalog = false;
    p.access.research = false;
    expect(stage(p, "research").status).toBe("unauthorized");
    expect(stage(p, "sku").status).toBe("unauthorized");
    expect(stage(p, "delivery").status).toBe("unauthorized");
    p.access.catalog = true;
    p.diagnostics.push("关联记录超过 100 条：销售 SKU");
    expect(stage(p, "delivery").status).toBe("blocked");
  });
});
