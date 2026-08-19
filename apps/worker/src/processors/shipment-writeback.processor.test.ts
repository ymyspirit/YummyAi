import { createEntityId } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import type { MarketplaceShipmentWritebackConnector, MarketplaceShipmentWritebackResult } from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";

import { ShipmentWritebackProcessor, type ShipmentWritebackExecutionRepository, type ShipmentWritebackExecutionSnapshot } from "./shipment-writeback.processor.js";

const requestId = createEntityId(); const tenantId = createEntityId(); const userId = createEntityId();
const snapshot: ShipmentWritebackExecutionSnapshot = {
  requestId, accountId: createEntityId(), orderId: createEntityId(), shipmentId: createEntityId(), projectionVersion: 2,
  context: { tenantId, accountId: createEntityId(), platform: "etsy", region: "GLOBAL", externalAccountId: "42", marketplaceIds: [] },
  input: { externalOrderId: "100", shipDate: "2026-07-22T10:00:00.000Z", packages: [{ packageReferenceId: "P1", trackingNumber: "T1", carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", lines: [{ externalLineId: "L1", quantity: 1 }] }] },
};

describe("shipment writeback processor", () => {
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
