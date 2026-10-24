import { createEntityId, type InventoryWorkspaceView } from "@yummyai/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InventoryWorkspace } from "./inventory-workspace";
import { activeInventoryView } from "./inventory-daily-view";

describe("InventoryWorkspace", () => {
  it("shows the unconsumed reservation remainder while retaining its original quantity", () => {
    const data = fixture(), row = data.balances[0]!;
    data.reservations.push({ id: createEntityId(), stockItemId: row.stockItemId, locationId: row.locationId, lotId: row.lotId, quantity: 2, remainingQuantity: 1,
      unit: "each", sourceType: "order_line", sourceId: "synthetic-original-line", status: "active", version: 2, expiresAt: null,
      createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" });
    const html = renderToStaticMarkup(<InventoryWorkspace data={data} />);
    expect(html).toContain('<b>1<small>件 待耗用</small></b>');
    expect(data.reservations[0]!.quantity).toBe(2);
  });
  it("excludes inactive inventory dimensions without changing the original ledger", () => {
    const data = fixture(), before = JSON.stringify(data);
    expect(activeInventoryView(data).balances).toEqual(data.balances);
    expect(JSON.stringify(data)).toBe(before);
    const inactive = { ...data, warehouses: data.warehouses.map(row => ({ ...row, status: "inactive" as const })) };
    const visible = activeInventoryView(inactive);
    expect(visible.locations).toEqual([]);
    expect(visible.balances).toEqual([]);
    expect(visible.movements).toEqual([]);
    expect(inactive.balances).toEqual(data.balances);
  });
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
    expect(html).toContain("再登记期初入库");
  });

  it("keeps precise material quantities and counted stock in separate unit totals", () => {
    const data = fixture();
    const stockItemId = createEntityId();
    data.stockItems.push({ id: stockItemId, skuId: null, code: "FABRIC", name: "面料", baseUnit: "meter", status: "active" });
    data.balances.push({ ...data.balances[0]!, stockItemId, lotId: null, unit: "meter", physicalQuantity: "1.05", reservedQuantity: "0.35", availableQuantity: "0.7", inTransitQuantity: "0.000000001" });
    const html = renderToStaticMarkup(<InventoryWorkspace data={data} />);
    const totals = html.slice(html.indexOf('aria-label="库存桶汇总"'), html.indexOf('aria-labelledby="inventory-balance-title"'));
    expect(totals).toContain('data-inventory-unit="each">10');
    expect(totals).toContain('data-inventory-unit="meter">1.05');
    expect(totals).toContain('data-inventory-unit="meter">0.7');
    expect(totals).toContain("0.000000001");
    expect(totals).not.toContain(">11.05<");
    expect(totals).not.toContain(">101.05<");
    expect(html).toContain(">0.35</b>");
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
