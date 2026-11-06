import { createEntityId } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import type { MarketplaceShipmentWritebackConnector, MarketplaceShipmentWritebackResult } from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";

import { amazonPackageReferences, ShipmentWritebackProcessor, type ShipmentWritebackExecutionRepository, type ShipmentWritebackExecutionSnapshot } from "./shipment-writeback.processor.js";

const requestId = createEntityId(); const tenantId = createEntityId(); const userId = createEntityId();
const snapshot: ShipmentWritebackExecutionSnapshot = {
  requestId, accountId: createEntityId(), orderId: createEntityId(), shipmentId: createEntityId(), projectionVersion: 2,
  context: { tenantId, accountId: createEntityId(), platform: "etsy", region: "GLOBAL", externalAccountId: "42", marketplaceIds: [] },
  input: { externalOrderId: "100", shipDate: "2026-07-22T10:00:00.000Z", packages: [{ packageReferenceId: "P1", trackingNumber: "T1", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", lines: [{ externalLineId: "L1", quantity: 1 }] }] },
};

describe("shipment writeback processor", () => {
  it("keeps Amazon aliases stable across revisions and holds any cross-shipment collision before submission",()=>{
    const original={shipmentId:"shipment-a",reference:"legacy-order-1"}, numeric={...original,reference:"27"};
    const get=(rows:typeof original[])=>amazonPackageReferences(original.shipmentId,rows);
    const mapped=get([original,numeric])!;
    expect(mapped.get("27")).toBe("27");const alias=mapped.get(original.reference)!;
    expect(alias).toMatch(/^[1-9]\d*$/);
    expect(get([numeric,original,original])).toEqual(mapped);
    expect(get([original,{shipmentId:"other",reference:alias}])).toBeNull();
    expect(get([numeric,{shipmentId:"other",reference:"027"}])).toBeNull();
  });
  it.each(["accepted", "rejected", "uncertain"] as const)("persists a %s connector outcome", async (status) => {
    const result: MarketplaceShipmentWritebackResult = { status, providerCode: status.toUpperCase(), externalReference: status === "accepted" ? "ack" : null };
    const repository: ShipmentWritebackExecutionRepository = {
      claim: vi.fn(async () => snapshot), withCredential: vi.fn(async (_context, _accountId, callback) => callback({ accessToken: "secret" })), complete: vi.fn(async () => undefined),
    };
    const connector = { platform: "etsy", confirm: vi.fn(async () => result) } satisfies MarketplaceShipmentWritebackConnector;
    const ignored = { platform: "amazon", confirm: vi.fn() } as unknown as MarketplaceShipmentWritebackConnector;
    const processor = new ShipmentWritebackProcessor(repository, { amazon: ignored, etsy: connector });
    expect(await processor.process(envelope())).toEqual({ requestId, status });
    expect(repository.complete).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), snapshot, result);
  });
});

function envelope(): JobEnvelope {
  return { jobId: createEntityId(), tenantId, requestedBy: userId, traceId: "a".repeat(32), correlationId: requestId, idempotencyKey: requestId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 2, payload: { writebackRequestId: requestId } };
}
