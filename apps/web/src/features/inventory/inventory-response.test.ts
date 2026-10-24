import { createEntityId } from "@yummyai/contracts";
import type { InventoryWorkspaceView } from "@yummyai/contracts/inventory";
import { describe, expect, it } from "vitest";
import { parseInventoryWorkspaceResponse } from "./inventory-response";

function response(): InventoryWorkspaceView {
  return {
    warehouses: [], locations: [], stockItems: [], lots: [], reservations: [], transfers: [], movements: [],
    balances: [{ stockItemId: createEntityId(), locationId: createEntityId(), lotId: null, unit: "meter",
      physicalQuantity: "9007199254740993.123456789", reservedQuantity: 0, availableQuantity: "9007199254740993.123456789",
      inTransitQuantity: "0.000000001", providerQuantity: 0, virtualQuantity: 0, projectionVersion: 1, updatedAt: "2026-10-20T00:00:00.000Z" }],
  };
}

describe("inventory response boundary", () => {
  it("preserves nine decimal places, large exact quantities and original integer values without changing the input", () => {
    const original = response(), before = JSON.stringify(original), workspace = parseInventoryWorkspaceResponse(original);
    expect(workspace.balances[0]).toMatchObject({ physicalQuantity: "9007199254740993.123456789", availableQuantity: "9007199254740993.123456789", inTransitQuantity: "0.000000001", reservedQuantity: 0 });
    expect(JSON.stringify(original)).toBe(before);
  });

  it("rejects a fractional JavaScript number instead of treating it as an exact inventory fact", () => {
    const original = response(); original.balances[0]!.physicalQuantity = 0.1;
    expect(() => parseInventoryWorkspaceResponse(original)).toThrow();
  });

  it("keeps rejecting internal fields on original records even though the shared schema would strip them", () => {
    for (const field of ["tenantId", "createdBy", "recordedBy", "idempotencyKey"]) {
      const original = response(), input = { ...original, balances: [{ ...original.balances[0]!, [field]: "synthetic-private-field" }] };
      expect(() => parseInventoryWorkspaceResponse(input)).toThrow("内部租户或幂等字段");
    }
  });

  it("rejects incomplete workspace data instead of inventing empty collections", () => {
    expect(() => parseInventoryWorkspaceResponse({ warehouses: [] })).toThrow();
  });
});
