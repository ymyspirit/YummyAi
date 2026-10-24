import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fulfillmentCommandForOperation } from "./fulfillment-command-intent";

const id = (value: number) => `019a0000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const source = { productionOrderId: id(10), productionVersionId: id(11), qualityInspectionId: id(12), qualityGroupId: id(13), expectedProductionProjectionVersion: 6, quantity: 1 };
const input = { shipDate: "2026-10-23T00:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: "synthetic-native-original-key",
  packages: ["first", "second"].map(packageReferenceId => ({ packageReferenceId, trackingNumber: "SYNTHETIC-" + packageReferenceId,
    carrierCode: "SYNTHETIC", carrierName: "Synthetic", carrierService: "Synthetic", lines: [{ orderLineId: id(2), quantity: 1, productionAllocations: [source] }] })) };

describe("original independent packing command adapter", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());
  it("binds navigation to the current line while the original target remains the exact order, with partial multi-package content", () => {
    const result = fulfillmentCommandForOperation(`lines/${id(2)}/shipments`, input, { orderId: id(1), lineId: id(2) });
    expect(result?.kind).toBe("shipment_create"); expect(result?.targetId).toBe(id(1));
    if (result?.kind !== "shipment_create") throw new Error("independent_packing_command_required");
    expect(result.input.packages).toHaveLength(2);
    expect(result.input.packages.flatMap(item => item.lines).reduce((sum, line) => sum + line.quantity, 0)).toBe(2);
    expect(result.input.idempotencyKey).toBe(input.idempotencyKey); expect(result.requestId).not.toBe(input.idempotencyKey);
  });
  it("rejects a foreign or missing original navigation line and does not broaden arbitrary paths into packing commands", () => {
    expect(() => fulfillmentCommandForOperation(`lines/${id(3)}/shipments`, input, { orderId: id(1), lineId: id(2) })).toThrow("装箱入口不属于当前原商品");
    expect(() => fulfillmentCommandForOperation(`lines/${id(2)}/shipments`, input, { orderId: id(1) })).toThrow("装箱入口不属于当前原商品");
    expect(fulfillmentCommandForOperation(`lines/${id(2)}/shipments/execute`, input, { orderId: id(1), lineId: id(2) })).toBeNull();
    expect(() => fulfillmentCommandForOperation(`orders/${id(1)}/shipments`, input, { orderId: id(1), lineId: id(2) })).toThrow();
  });
});
