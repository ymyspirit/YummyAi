import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { CreateProductionDeliverySchema, RecordProductionDeliveryFeedbackSchema } from "./production-delivery.js";
const item = { productionOrderId: createEntityId(), productionVersionId: createEntityId(), expectedProjectionVersion: 1 };
const base = { kind: "received", expectedSequence: 0, fileChecksum: "a".repeat(64), idempotencyKey: crypto.randomUUID(), reference: "FACTORY_001", note: "Operator checked actual factory reply", occurredAt: new Date().toISOString(), verifiedByOperator: true };
describe("production delivery write contracts", () => {
  it("rejects duplicate and oversized selections and tenant injection", () => {
    const input = { supplierId: createEntityId(), factoryId: createEntityId(), items: [item], idempotencyKey: crypto.randomUUID() };
    expect(CreateProductionDeliverySchema.safeParse(input).success).toBe(true);
    expect(CreateProductionDeliverySchema.safeParse({ ...input, items: [item, item] }).success).toBe(false);
    expect(CreateProductionDeliverySchema.safeParse({ ...input, items: Array.from({ length: 51 }, () => ({ ...item, productionOrderId: createEntityId() })) }).success).toBe(false);
    expect(CreateProductionDeliverySchema.safeParse({ ...input, tenantId: createEntityId() }).success).toBe(false);
  });
  it("requires verification, file checksum, repair quantity and costs in integer minor units", () => {
    expect(RecordProductionDeliveryFeedbackSchema.safeParse(base).success).toBe(true);
    for (const input of [{ ...base, verifiedByOperator: false }, { ...base, fileChecksum: "" }, { ...base, kind: "rejected" }, { ...base, cost: { amountMinor: 1, currency: "USD", basis: "confirmed", reference: "receipt" } }, { ...base, kind: "rework", affectedQuantity: 1, cost: { amountMinor: 0.25, currency: "USD", basis: "confirmed", reference: "receipt" } }]) expect(RecordProductionDeliveryFeedbackSchema.safeParse(input).success).toBe(false);
    expect(RecordProductionDeliveryFeedbackSchema.safeParse({ ...base, kind: "rework", affectedQuantity: 1, cost: { amountMinor: 0, currency: "CNY", basis: "confirmed", reference: "No-charge factory agreement" } }).success).toBe(true);
  });
});
