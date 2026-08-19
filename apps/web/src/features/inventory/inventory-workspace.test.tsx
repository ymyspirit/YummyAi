import { createEntityId, type InventoryWorkspaceView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InventoryWorkspace } from "./inventory-workspace";

describe("InventoryWorkspace", () => {
  it("renders traceable balance buckets and immutable movement evidence", () => {
    const html = renderToStaticMarkup(<InventoryWorkspace data={fixture()} />);
    expect(html).toContain("实物库存");
    expect(html).toContain("可用库存");
    expect(html).toContain("BLANK-PILLOW");
    expect(html).toContain("OPENING_BALANCE");
    expect(html).toContain("最近库存流水");
  });

  it("does not fabricate inventory when no facts exist", () => {
    const empty: InventoryWorkspaceView = {
      warehouses: [],
      locations: [],
      stockItems: [],
      lots: [],
      balances: [],
      reservations: [],
      transfers: [],
      movements: [],
    };
    const html = renderToStaticMarkup(<InventoryWorkspace data={empty} />);
    expect(html).toContain("还没有库存事实");
    expect(html).toContain("系统不会推测库存数量");
  });
});

function fixture(): InventoryWorkspaceView {
  const warehouseId = createEntityId();
  const locationId = createEntityId();
  const stockItemId = createEntityId();
  const lotId = createEntityId();
  const movementId = createEntityId();
  return {
    warehouses: [{
      id: warehouseId,
      code: "MAIN",
      name: "Main warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
      status: "active",
    }],
    locations: [{
      id: locationId,
      warehouseId,
      code: "PICK-A",
      name: "Pick face",
      status: "active",
    }],
    stockItems: [{
      id: stockItemId,
      skuId: null,
      code: "BLANK-PILLOW",
      name: "Blank pillow cover",
      baseUnit: "each",
      status: "active",
    }],
    lots: [{
      id: lotId,
      stockItemId,
      code: "LOT-001",
      sourceType: "opening",
      sourceId: "opening-001",
      unitCostMinor: 450,
      unitCostCurrency: "USD",
      receivedAt: "2026-07-23T01:00:00.000Z",
      expiresAt: null,
      createdAt: "2026-07-23T01:00:00.000Z",
    }],
    balances: [{
      stockItemId,
      locationId,
      lotId,
      unit: "each",
      physicalQuantity: 10,
      reservedQuantity: 2,
      availableQuantity: 8,
      inTransitQuantity: 1,
      providerQuantity: 0,
      virtualQuantity: 0,
      projectionVersion: 2,
      updatedAt: "2026-07-23T01:00:00.000Z",
    }],
    reservations: [],
    transfers: [],
    movements: [{
      id: movementId,
      stockItemId,
      locationId,
      lotId,
      bucket: "physical",
      type: "opening",
      quantityDelta: 10,
      unit: "each",
      sourceType: "opening",
      sourceId: "opening-001",
      reasonCode: "OPENING_BALANCE",
      occurredAt: "2026-07-23T01:00:00.000Z",
      recordedAt: "2026-07-23T01:00:00.000Z",
    }],
  };
}
