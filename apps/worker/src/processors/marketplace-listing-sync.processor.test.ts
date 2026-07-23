import { createEntityId } from "@yummyai/contracts";
import { createTraceId, type JobEnvelope } from "@yummyai/jobs";
import { MarketplaceConnectorError, type MarketplaceDraftGateway, type MarketplaceOnlineListingResult } from "@yummyai/marketplace-connectors";
import { describe, expect, it, vi } from "vitest";

import {
  MarketplaceListingSyncProcessor,
  type ListingSyncExecutionRepository,
  type ListingSyncExecutionSnapshot,
} from "./marketplace-listing-sync.processor.js";

describe("marketplace Listing sync processor", () => {
  it("reads online state and records a completed reconciliation", async () => {
    const state = fixture("read");
    const result = onlineResult();
    const repository = fakeRepository(state, "completed");
    const gateway = fakeGateway({ readOnlineListing: vi.fn(async () => result) });
    await expect(new MarketplaceListingSyncProcessor(repository, gateway).process(envelope(state.requestId))).resolves.toEqual({ requestId: state.requestId, status: "completed" });
    expect(gateway.readOnlineListing).toHaveBeenCalledOnce();
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), state, result);
  });

  it("uses the mutation gateway only for an approved price and inventory push", async () => {
    const state = fixture("push_price_inventory");
    const repository = fakeRepository(state, "completed");
    const gateway = fakeGateway({ updateOnlineListingPriceInventory: vi.fn(async () => onlineResult()) });
    await expect(new MarketplaceListingSyncProcessor(repository, gateway).process(envelope(state.requestId))).resolves.toMatchObject({ status: "completed" });
    expect(gateway.updateOnlineListingPriceInventory).toHaveBeenCalledOnce();
    expect(gateway.readOnlineListing).not.toHaveBeenCalled();
  });

  it("marks an uncertain mutation outcome for reconciliation and does not retry", async () => {
    const state = fixture("push_price_inventory");
    const repository = fakeRepository(state, "completed");
    const gateway = fakeGateway({
      updateOnlineListingPriceInventory: vi.fn(async () => {
        throw new MarketplaceConnectorError("amazon", "upstream_terminal", "Response lost", undefined, true);
      }),
    });
    await expect(new MarketplaceListingSyncProcessor(repository, gateway).process(envelope(state.requestId))).resolves.toMatchObject({ status: "reconciliation_required" });
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), state.requestId, expect.objectContaining({ status: "reconciliation_required", retryable: false }));
  });

  it("records retry_pending and rethrows a retryable read failure", async () => {
    const state = fixture("read");
    const repository = fakeRepository(state, "completed");
    const error = new MarketplaceConnectorError("amazon", "upstream_retryable", "Unavailable");
    const gateway = fakeGateway({ readOnlineListing: vi.fn(async () => { throw error; }) });
    await expect(new MarketplaceListingSyncProcessor(repository, gateway).process(envelope(state.requestId))).rejects.toBe(error);
    expect(repository.fail).toHaveBeenCalledWith(expect.anything(), state.requestId, expect.objectContaining({ status: "retry_pending", retryable: true }));
  });
});

function fixture(action: ListingSyncExecutionSnapshot["action"]): ListingSyncExecutionSnapshot {
  return {
    requestId: createEntityId(),
    accountId: createEntityId(),
    action,
    account: { authorizationMode: "amazon_private", externalAccountId: "A1SELLER", platform: "amazon", region: "NA" },
    payload: {
      platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SKU-1",
      attributes: { purchasable_offer: [{ currency: "USD" }], fulfillment_availability: [{ quantity: 7 }] },
    },
    externalListingId: "SKU-1",
    desiredChecksum: "a".repeat(64),
  };
}

function fakeRepository(snapshot: ListingSyncExecutionSnapshot, completedStatus: "completed" | "drift_detected"): ListingSyncExecutionRepository {
  return {
    claim: vi.fn(async () => snapshot),
    withCredential: vi.fn(async (_context, _accountId, callback) => callback({ refreshToken: "secret" })),
    complete: vi.fn(async () => completedStatus),
    fail: vi.fn(async () => undefined),
  };
}

function fakeGateway(overrides: Partial<MarketplaceDraftGateway>): MarketplaceDraftGateway {
  const unsupported = async () => { throw new Error("Unexpected gateway operation"); };
  return {
    create: vi.fn(unsupported), submit: vi.fn(unsupported), configure: vi.fn(unsupported), uploadMedia: vi.fn(unsupported),
    activate: vi.fn(unsupported), getStatus: vi.fn(unsupported), readOnlineListing: vi.fn(unsupported),
    updateOnlineListingPriceInventory: vi.fn(unsupported), ...overrides,
  };
}

function onlineResult(): MarketplaceOnlineListingResult {
  return { issues: [], snapshot: { externalState: "BUYABLE", price: [{ currency: "USD" }], inventory: [{ quantity: 7 }], observedAt: new Date().toISOString() } };
}

function envelope(syncRequestId: string): JobEnvelope {
  return {
    jobId: createEntityId(), tenantId: createEntityId(), requestedBy: createEntityId(), traceId: createTraceId(),
    correlationId: syncRequestId, idempotencyKey: syncRequestId, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 3,
    payload: { syncRequestId },
  };
}
