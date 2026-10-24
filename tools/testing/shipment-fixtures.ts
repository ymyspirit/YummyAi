import type { ShipmentProductionSource } from "../../packages/contracts/src/order/shipment";

/** Explicit disposable fixture choice. Never infer sources in production commands. */
export function syntheticShipmentAllocations(sources: ShipmentProductionSource[], lineId: string, quantity: number) {
  const eligible = sources.filter(source => source.orderLineId === lineId && !source.blockers.length && source.availableQuantity >= quantity);
  if (!eligible.length) return undefined;
  if (eligible.length !== 1) throw new Error("Synthetic shipment must choose its production source explicitly");
  const source = eligible[0]!;
  return [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
    qualityInspectionId: source.qualityInspectionId!, expectedProductionProjectionVersion: source.projectionVersion, quantity }];
}
