import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { ShipmentPackageLineInputSchema, CreateShipmentInputSchema } from "./shipment.js";
import { CreateWholeOrderShipmentInputSchema } from "./whole-fulfillment.js";
const source = (quantity: number) => ({ productionOrderId: createEntityId(), productionVersionId: createEntityId(), qualityInspectionId: createEntityId(), expectedProductionProjectionVersion: 5, quantity });
describe("shipment production source transport", () => {
  it("retains genuine legacy omissions for receipt recovery and refuses an empty fabricated source list", () => {
    const line = { orderLineId: createEntityId(), quantity: 1 };
    expect(ShipmentPackageLineInputSchema.parse(line)).toEqual(line);
    expect(ShipmentPackageLineInputSchema.safeParse({ ...line, productionAllocations: [] }).success).toBe(false);
  });
  it("requires exact quantity coverage with unique production lots in both single and whole commands", () => {
    const a = source(1), b = source(2), orderLineId = createEntityId();
    expect(ShipmentPackageLineInputSchema.safeParse({ orderLineId, quantity: 3, productionAllocations: [a, b] }).success).toBe(true);
    expect(ShipmentPackageLineInputSchema.safeParse({ orderLineId, quantity: 3, productionAllocations: [a] }).success).toBe(false);
    expect(ShipmentPackageLineInputSchema.safeParse({ orderLineId, quantity: 2, productionAllocations: [a, a] }).success).toBe(false);
    const whole = { items: [{ lineId: orderLineId, quantity: 2, expectedRevision: 1, expectedProjectionVersion: 1, productionAllocations: [a] }], trackingNumber: "SYNTHETIC", carrierCode: "SYNTHETIC", carrierName: "Synthetic", carrierService: "Synthetic", shipFromCountryCode: "US", shipDate: "2026-10-01T00:00:00.000Z", idempotencyKey: createEntityId() };
    expect(CreateWholeOrderShipmentInputSchema.safeParse(whole).success).toBe(false);
  });
  it("keeps production source identity separate from ShipOS waybill selection and rejects unknown proof fields", () => {
    const a = source(1), orderLineId = createEntityId();
    expect(ShipmentPackageLineInputSchema.safeParse({ orderLineId, quantity: 1, productionAllocations: [{ ...a, approved: true }] }).success).toBe(false);
    expect(CreateShipmentInputSchema.safeParse({ shipDate: "2026-10-01T00:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: "synthetic-source-command",
      packages: [{ packageReferenceId: "SYNTHETIC", trackingNumber: "SYNTHETIC", carrierCode: "SYNTHETIC", carrierName: "Synthetic", carrierService: "Synthetic", lines: [{ orderLineId, quantity: 1, productionAllocations: [a] }] }] }).success).toBe(true);
  });
});
