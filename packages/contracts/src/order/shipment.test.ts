import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import { CreateShipmentInputSchema, RecordShipmentWritebackEventInputSchema } from "./shipment.js";

describe("shipment contracts", () => {
  it("accepts a split and combined package plan", () => {
    const first = createEntityId(); const second = createEntityId();
    const parsed = CreateShipmentInputSchema.parse({
      shipDate: "2026-07-22T10:00:00.000Z", promisedDeliveryAt: "2026-07-28T10:00:00.000Z",
      estimatedDeliveryAt: "2026-07-27T10:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: "shipment-contract-1",
      packages: [
        { packageReferenceId: "PKG-1", trackingNumber: "TRACK-1", carrierCode: "USPS", carrierName: "USPS", carrierService: "Ground", lines: [{ orderLineId: first, quantity: 1 }, { orderLineId: second, quantity: 1 }] },
        { packageReferenceId: "PKG-2", trackingNumber: "TRACK-2", carrierCode: "USPS", carrierName: "USPS", carrierService: "Ground", lines: [{ orderLineId: first, quantity: 1 }] },
      ],
    });
    expect(parsed.packages).toHaveLength(2);
  });

  it("rejects duplicate package references and incomplete label money", () => {
    const lineId = createEntityId();
    const result = CreateShipmentInputSchema.safeParse({
      shipDate: "2026-07-22T10:00:00.000Z", promisedDeliveryAt: null, estimatedDeliveryAt: null,
      shipFromCountryCode: "US", idempotencyKey: "shipment-contract-2",
      packages: [
        { packageReferenceId: "PKG", trackingNumber: "A", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", labelCostMinor: 100, lines: [{ orderLineId: lineId, quantity: 1 }] },
        { packageReferenceId: "PKG", trackingNumber: "B", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", lines: [{ orderLineId: lineId, quantity: 1 }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires an external acknowledgement for accepted writeback", () => {
    expect(RecordShipmentWritebackEventInputSchema.safeParse({
      action: "accepted", expectedProjectionVersion: 1, providerCode: "OK", externalReference: null,
      occurredAt: "2026-07-22T10:00:00.000Z",
    }).success).toBe(false);
  });
});
