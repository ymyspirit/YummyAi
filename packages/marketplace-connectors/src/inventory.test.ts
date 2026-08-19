import { describe, expect, it } from "vitest";

import { normalizeProviderInventoryReport } from "./inventory.js";

describe("provider inventory normalization", () => {
  it("keeps Amazon fulfillment ownership and condition separate", () => {
    const report = normalizeProviderInventoryReport({
      provider: "amazon",
      providerSnapshotId: "report-1",
      observedAt: "2026-07-23T08:00:00.000Z",
      checkpoint: { sequence: 7, cursor: "next-page" },
      records: [
        {
          sellerSku: "SKU-1",
          fulfillmentChannel: "FBA",
          condition: "SELLABLE",
          quantity: 12,
          warehouseCode: "ONT8",
        },
        {
          sellerSku: "SKU-1",
          fulfillmentChannel: "MFN",
          condition: "QUARANTINE",
          quantity: 2,
          warehouseCode: null,
        },
        {
          sellerSku: "SKU-1",
          fulfillmentChannel: "AFN",
          condition: "UNSELLABLE",
          quantity: 1,
          warehouseCode: "ONT8",
        },
      ],
    });

    expect(report.lines).toEqual([
      expect.objectContaining({ source: "fba", condition: "sellable", quantity: 12 }),
      expect.objectContaining({ source: "fbm", condition: "quarantine", quantity: 2 }),
      expect.objectContaining({ source: "fba", condition: "damaged", quantity: 1 }),
    ]);
  });

  it("normalizes Etsy inventory as explicit FBM stock", () => {
    const report = normalizeProviderInventoryReport({
      provider: "etsy",
      providerSnapshotId: "etsy-1",
      observedAt: "2026-07-23T08:00:00.000Z",
      checkpoint: { sequence: 1, cursor: null },
      records: [{ sku: "SKU-1", quantity: 8 }],
    });
    expect(report.lines).toEqual([{
      externalSku: "SKU-1",
      source: "fbm",
      condition: "sellable",
      quantity: 8,
      warehouseCode: null,
    }]);
  });

  it("preserves third-party in-transit and virtual dimensions", () => {
    const report = normalizeProviderInventoryReport({
      provider: "third_party",
      providerSnapshotId: null,
      observedAt: "2026-07-23T08:00:00.000Z",
      checkpoint: { sequence: 3, cursor: "3" },
      records: [
        {
          sku: "SKU-1",
          networkRole: "in_transit",
          condition: "sellable",
          quantity: 20,
          warehouseCode: "SEA",
        },
        {
          sku: "SKU-1",
          networkRole: "virtual",
          condition: "sellable",
          quantity: 50,
          warehouseCode: null,
        },
      ],
    });
    expect(report.lines.map(({ source }) => source)).toEqual(["in_transit", "virtual"]);
  });
});
