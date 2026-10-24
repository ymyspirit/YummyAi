"use client";

import { useState } from "react";
import type { InventoryWorkspaceView } from "@yummyai/contracts";
import { InventoryOperations } from "./inventory-operations";
import { InventoryWorkspace } from "./inventory-workspace";

export function activeInventoryView(data: InventoryWorkspaceView): InventoryWorkspaceView {
  const warehouses = data.warehouses.filter(row => row.status === "active");
  const warehouseIds = new Set(warehouses.map(row => row.id));
  const locations = data.locations.filter(row => row.status === "active" && warehouseIds.has(row.warehouseId));
  const locationIds = new Set(locations.map(row => row.id));
  const stockItems = data.stockItems.filter(row => row.status === "active");
  const stockIds = new Set(stockItems.map(row => row.id));
  const activeDimension = (row: { stockItemId: string; locationId: string }) => stockIds.has(row.stockItemId) && locationIds.has(row.locationId);
  return { ...data, warehouses, locations, stockItems,
    lots: data.lots.filter(row => stockIds.has(row.stockItemId)),
    balances: data.balances.filter(activeDimension), reservations: data.reservations.filter(activeDimension), movements: data.movements.filter(activeDimension),
    transfers: data.transfers.filter(row => stockIds.has(row.stockItemId) && (locationIds.has(row.sourceLocationId) || locationIds.has(row.destinationLocationId))),
  };
}

export function InventoryDailyView({ data }: { data: InventoryWorkspaceView }) {
  const [includeInactive, setIncludeInactive] = useState(false);
  const visible = includeInactive ? data : activeInventoryView(data);
  return <>
    <label className="record-help"><input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)} /> 包含停用资料及其库存流水</label>
    <InventoryOperations data={visible} /><InventoryWorkspace data={visible} />
  </>;
}
