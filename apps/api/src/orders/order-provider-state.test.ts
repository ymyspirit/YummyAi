import { createEntityId, NormalizeOrderInputSchema } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";
import { amazonProviderState } from "./order-provider-state.js";

describe("Amazon fulfillment admission", () => {
  function input(status: string, source: Record<string, unknown> = {}) {
    return NormalizeOrderInputSchema.parse({ accountId: createEntityId(), platform: "amazon", externalEventId: "synthetic", externalOrderId: "synthetic-order",
      providerStatus: status, placedAt: "2026-11-01T00:00:00Z", orderTotal: null, lines: [{ externalLineId: "line", title: "Synthetic", quantity: 1, unitPrice: null }],
      redactedSource: { apiVersion: "2026-01-01", lastUpdatedTime: "2026-11-01T00:00:00Z", fulfilledBy: "MERCHANT", ...source } });
  }
  it.each([
    ["PENDING", "payment_pending"], ["PENDING_AVAILABILITY", "payment_pending"], ["CANCELLED", "cancelled"],
    ["SHIPPED", "already_shipped"], ["PARTIALLY_SHIPPED", "partially_shipped"], ["UNKNOWN", "status_unknown"], ["UNSHIPPED", null],
  ] as const)("classifies %s before local fulfillment", (status, blockReason) => {
    expect(amazonProviderState(input(status))?.blockReason).toBe(blockReason);
  });
  it("does not assign FBA or an unconfirmed fulfiller to a local factory", () => {
    expect(amazonProviderState(input("UNSHIPPED", { fulfilledBy: "AMAZON" }))?.blockReason).toBe("amazon_fulfilled");
    expect(amazonProviderState(input("UNSHIPPED", { fulfilledBy: null }))?.blockReason).toBe("fulfillment_unknown");
    expect(amazonProviderState(input("UNSHIPPED", { lastUpdatedTime: null }))?.blockReason).toBe("status_unknown");
  });
  it("stops the whole parcel when a single line is cancelled or has a cancellation request", () => {
    expect(amazonProviderState(input("UNSHIPPED", { cancellationRequestedLineIds: ["line"] }))?.blockReason).toBe("cancellation_requested");
    expect(amazonProviderState(input("UNSHIPPED", { cancelledLineIds: ["line"] }))?.blockReason).toBe("cancelled");
  });
  it("preserves the separate manual-report lifecycle", () => {
    expect(amazonProviderState({ ...input("report_imported"), redactedSource: { source: "amazon_order_report" } })).toBeNull();
  });
});
