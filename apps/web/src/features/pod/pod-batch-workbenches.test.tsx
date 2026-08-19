import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BatchDesignWorkbench } from "./batch-design-workbench";
import { MockupBatchWorkbench } from "./mockup-batch-workbench";
import type { BatchCapabilities, DesignOptions, MockupOptions } from "./pod-batch-types";

const id = (suffix: string) => `019f0000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const capabilities: BatchCapabilities = {
  batchDesign: { enabled: true, blockers: [] },
  mockupBatches: { enabled: true, blockers: [] },
};
const spec = {
  id: id("1"), name: "Canvas 4:3", versionNumber: 1, aspectWidth: 4, aspectHeight: 3,
  status: "approved", targetDpi: 300,
};

describe("canvas batch workbenches", () => {
  it("renders candidate selection, failed-item retry, aspect review, and SKU promotion controls", () => {
    const options: DesignOptions = {
      printSpecs: [spec], printSpecVersions: [spec], referenceAssets: [],
      skus: [{ id: id("2"), code: "CANVAS-4X3", attributes: {}, status: "active" }],
    };
    const html = renderToStaticMarkup(<BatchDesignWorkbench
      assetUrls={{}}
      batches={[]}
      capabilities={capabilities}
      options={options}
      batch={{
        id: id("3"), name: "E2E creative batch", status: "partially_succeeded", itemCount: 1,
        generatedCount: 1, approvedCount: 1, failedCount: 1, createdAt: "2026-08-05T00:00:00.000Z",
        items: [{
          id: id("4"), rowKey: "row-1", name: "Coastal canvas", prompt: "quiet coastal sunrise",
          candidateCount: 2, printSpecVersionIds: [spec.id], status: "partially_succeeded",
          candidates: [
            { id: id("5"), ordinal: 0, status: "generated", modelKey: "pod.text-to-image.v1" },
            { id: id("6"), ordinal: 1, status: "failed", errorMessage: "provider timeout" },
          ],
          creativeVersions: [
            {
              id: id("7"), name: "Pending family", status: "pending_review",
              assets: [
                { id: id("8"), assetId: id("9"), role: "master", adaptationMode: "original", generatedRegions: [] },
                { id: id("10"), assetId: id("11"), role: "aspect_variant", printSpecVersionId: spec.id, adaptationMode: "ai_outpaint", generatedRegions: [{ x: 0 }] },
              ],
            },
            {
              id: id("12"), name: "Approved family", status: "approved",
              assets: [{ id: id("13"), assetId: id("14"), role: "aspect_variant", printSpecVersionId: spec.id, adaptationMode: "crop", generatedRegions: [] }],
            },
          ],
        }],
      }}
    />);

    expect(html).toContain("CREATIVE DESIGN STUDIO");
    expect(html).toContain("画图设计");
    expect(html).toContain('href="/pod-workbench/mockup-batches"');
    expect(html).toContain("将所选候选创建为独立创意族");
    expect(html).toContain("只重试失败候选");
    expect(html).toContain("AI 扩图 · 必须人工确认");
    expect(html).toContain("批准母版与全部画幅");
    expect(html).toContain("绑定所选 SKU");
    expect(html).toContain("CANVAS-4X3");
  });

  it("renders row-by-slot review, isolated retry, mobile slot labels, and explicit Listing mapping", () => {
    const packId = id("20");
    const designVersionId = id("21");
    const skuId = id("22");
    const spuId = id("23");
    const options: MockupOptions = {
      templatePacks: [{
        id: packId, name: "Amazon room scenes", platform: "amazon", locale: "en-US", versionNumber: 1,
        status: "approved", slots: [
          { id: id("24"), slotKey: "hero", label: "主图", required: true, ordinal: 0, acceptedPrintSpecVersionIds: [spec.id] },
          { id: id("25"), slotKey: "room", label: "客厅场景", required: true, ordinal: 1, acceptedPrintSpecVersionIds: [spec.id] },
        ],
      }],
      formalDesigns: [{ designVersionId, designTaskId: id("26"), title: "Coastal formal design", skuId, skuCode: "CANVAS-4X3", spuId, printSpecVersionId: spec.id, creativeDesignVersionId: id("27") }],
      listingVersions: [{ listingVersionId: id("28"), versionNumber: 2, status: "draft", listingId: id("29"), platform: "amazon", locale: "en-US", spuId }],
      templateSourceAssets: [], inspections: [], printSpecs: [spec],
    };
    const html = renderToStaticMarkup(<MockupBatchWorkbench
      allPacks={[{ id: packId, name: "Amazon room scenes", versionNumber: 1, status: "approved", platform: "amazon", locale: "en-US" }]}
      assetUrls={{}}
      batches={[]}
      capabilities={capabilities}
      options={options}
      batch={{
        id: id("30"), name: "Canvas mockup batch", status: "partially_succeeded", platform: "amazon", locale: "en-US",
        templatePackVersionId: packId, itemCount: 2, completedCount: 1, failedCount: 1, createdAt: "2026-08-05T00:00:00.000Z",
        items: [
          { id: id("31"), designVersionId, skuId, status: "failed", outputs: [
            { id: id("32"), slotKey: "hero", attempt: 0, status: "succeeded" },
            { id: id("33"), slotKey: "room", attempt: 0, status: "failed", errorMessage: "perspective render failed" },
          ] },
          { id: id("34"), designVersionId, skuId, status: "completed", outputs: [
            { id: id("35"), slotKey: "hero", attempt: 1, status: "approved", assetId: id("36") },
            { id: id("37"), slotKey: "room", attempt: 1, status: "approved", assetId: id("38") },
          ] },
        ],
      }}
    />);

    expect(html).toContain('href="/creative-designs"');
    expect(html).toContain("画图设计来源");
    expect(html).toContain("ROW × SLOT REVIEW");
    expect(html).toContain('data-slot="主图"');
    expect(html).toContain('data-slot="客厅场景"');
    expect(html).toContain("perspective render failed");
    expect(html).toContain("重试");
    expect(html).toContain("批准所选款式");
    expect(html).toContain("显式绑定 Listing");
    expect(html).toContain('value="hero"');
    expect(html).toContain('value="room"');
  });
});
