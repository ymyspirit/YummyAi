import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import {
  CreateInventoryLotInputSchema,
  CreateInventoryTransferInputSchema,
  InventoryBalanceViewSchema,
  InventoryWorkspaceViewSchema,
  RecordInventoryMovementInputSchema,
} from "./inventory.js";

describe("inventory contracts", () => {
  it("requires an integer non-zero movement in one explicit inventory bucket", () => {
    const base = {
      stockItemId: createEntityId(),
      locationId: createEntityId(),
      lotId: null,
      bucket: "physical",
      type: "opening",
      unit: "each",
      sourceType: "opening",
      sourceId: "opening-2026-07",
      reasonCode: "INITIAL_COUNT",
      occurredAt: "2026-07-23T01:00:00.000Z",
      idempotencyKey: "inventory-opening-0001",
    };

    expect(RecordInventoryMovementInputSchema.safeParse({ ...base, quantityDelta: 25 }).success).toBe(true);
    expect(RecordInventoryMovementInputSchema.safeParse({ ...base, quantityDelta: 0 }).success).toBe(false);
    expect(RecordInventoryMovementInputSchema.safeParse({ ...base, quantityDelta: 1.5 }).success).toBe(false);
  });

  it("accepts exact decimal material quantities while counted units remain indivisible", () => {
    const input = {
      stockItemId: createEntityId(), locationId: createEntityId(), lotId: null,
      bucket: "physical", type: "opening", unit: "meter", sourceType: "opening",
      sourceId: "material-opening", reasonCode: "INITIAL_COUNT", occurredAt: "2026-07-23T01:00:00.000Z",
      idempotencyKey: "decimal-material-opening", quantityDelta: "0.350000000",
    };
    expect(RecordInventoryMovementInputSchema.parse(input).quantityDelta).toBe("0.35");
    expect(RecordInventoryMovementInputSchema.parse({ ...input, quantityDelta: "1.000" }).quantityDelta).toBe(1);
    for (const unit of ["each", "pair", "set"]) {
      expect(RecordInventoryMovementInputSchema.safeParse({ ...input, unit }).success).toBe(false);
    }
    for (const quantityDelta of [0.35, "0.1234567890", "2147483647.000000001", "1e-3"]) {
      expect(RecordInventoryMovementInputSchema.safeParse({ ...input, quantityDelta }).success).toBe(false);
    }
  });

  it("keeps fractional balances serializable without converting them to floating-point numbers", () => {
    const balance = InventoryBalanceViewSchema.parse({
      stockItemId: createEntityId(), locationId: createEntityId(), lotId: null, unit: "meter",
      physicalQuantity: "1.05", reservedQuantity: "0.35", availableQuantity: "0.7",
      inTransitQuantity: "1.000", providerQuantity: 0, virtualQuantity: 0,
      projectionVersion: 1, updatedAt: "2026-07-23T01:00:00.000Z",
    });
    expect(balance).toMatchObject({ physicalQuantity: "1.05", reservedQuantity: "0.35", availableQuantity: "0.7", inTransitQuantity: 1 });
    expect(JSON.parse(JSON.stringify(balance))).toEqual(balance);
  });

  it("rejects a transfer that has no location boundary", () => {
    const locationId = createEntityId();
    expect(CreateInventoryTransferInputSchema.safeParse({
      stockItemId: createEntityId(),
      lotId: null,
      sourceLocationId: locationId,
      destinationLocationId: locationId,
      quantity: 1,
      unit: "each",
      idempotencyKey: "inventory-transfer-0001",
    }).success).toBe(false);
  });

  it("keeps lot cost amount and currency paired", () => {
    expect(CreateInventoryLotInputSchema.safeParse({
      stockItemId: createEntityId(),
      code: "LOT-001",
      sourceType: "receipt",
      sourceId: "receipt-001",
      unitCostMinor: 250,
      unitCostCurrency: null,
      receivedAt: "2026-07-23T01:00:00.000Z",
      expiresAt: null,
    }).success).toBe(false);
  });

  it("exposes availability as a derived, explicit balance dimension", () => {
    const result = InventoryBalanceViewSchema.parse({
      stockItemId: createEntityId(),
      locationId: createEntityId(),
      lotId: null,
      unit: "each",
      physicalQuantity: 10,
      reservedQuantity: 4,
      availableQuantity: 6,
      inTransitQuantity: 2,
      providerQuantity: 0,
      virtualQuantity: 0,
      projectionVersion: 3,
      updatedAt: "2026-07-23T01:00:00.000Z",
    });
    expect(result.availableQuantity).toBe(6);
  });

  it("keeps the inventory workspace transport free of tenant and idempotency internals", () => {
    const stockItemId = createEntityId();
    const locationId = createEntityId();
    const workspace = InventoryWorkspaceViewSchema.parse({
      warehouses: [],
      locations: [],
      stockItems: [],
      lots: [],
      balances: [{
        stockItemId,
        locationId,
        lotId: null,
        unit: "each",
        physicalQuantity: 3,
        reservedQuantity: 1,
        availableQuantity: 2,
        inTransitQuantity: 0,
        providerQuantity: 0,
        virtualQuantity: 0,
        projectionVersion: 2,
        updatedAt: "2026-07-23T01:00:00.000Z",
      }],
      reservations: [],
      transfers: [],
      movements: [],
    });
    expect(workspace.balances[0]?.availableQuantity).toBe(2);
    expect("tenantId" in workspace).toBe(false);
    expect("idempotencyKey" in workspace).toBe(false);
  });
});
