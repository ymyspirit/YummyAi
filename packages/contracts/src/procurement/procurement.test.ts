import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import {
  CreateInventoryPurchaseOrderInputSchema,
  ProcurementReceiptLineInputSchema,
  UpsertReplenishmentPolicyInputSchema,
} from "./procurement.js";

describe("procurement contracts", () => {
  it("accepts explicit purchase quantities, units, destinations, and minor-unit costs", () => {
    expect(CreateInventoryPurchaseOrderInputSchema.parse({
      code: "PO-2026-001",
      supplierId: createEntityId(),
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [{
        lineKey: "LINE-1",
        stockItemId: createEntityId(),
        destinationLocationId: createEntityId(),
        quantity: 120,
        unit: "each",
        unitCostMinor: 425,
      }],
      idempotencyKey: "procurement-order-contract-0001",
    })).toMatchObject({ currency: "USD" });
  });

  it("requires received stock to have a lot and rejected stock to have a reason", () => {
    expect(ProcurementReceiptLineInputSchema.safeParse({
      lineKey: "LINE-1",
      receivedQuantity: 5,
      rejectedQuantity: 0,
      rejectionReasonCode: null,
      lotCode: null,
      expiresAt: null,
    }).success).toBe(false);
    expect(ProcurementReceiptLineInputSchema.safeParse({
      lineKey: "LINE-1",
      receivedQuantity: 0,
      rejectedQuantity: 2,
      rejectionReasonCode: null,
      lotCode: null,
      expiresAt: null,
    }).success).toBe(false);
  });

  it("rejects duplicate line keys and invalid service-level policy values", () => {
    const line = {
      lineKey: "LINE-1",
      stockItemId: createEntityId(),
      destinationLocationId: createEntityId(),
      quantity: 1,
      unit: "each",
      unitCostMinor: 100,
    };
    expect(CreateInventoryPurchaseOrderInputSchema.safeParse({
      code: "PO-DUPLICATE",
      supplierId: createEntityId(),
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [line, line],
      idempotencyKey: "procurement-order-contract-0002",
    }).success).toBe(false);
    expect(UpsertReplenishmentPolicyInputSchema.safeParse({
      stockItemId: createEntityId(),
      locationId: createEntityId(),
      reorderPoint: 10,
      safetyStock: 4,
      minimumOrderQuantity: 5,
      leadTimeDays: 7,
      serviceLevelBps: 10_001,
      reviewIntervalDays: 7,
      idempotencyKey: "replenishment-policy-contract-0001",
    }).success).toBe(false);
  });
});
