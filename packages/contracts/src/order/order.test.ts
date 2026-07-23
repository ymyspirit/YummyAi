import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import { AnonymizeOrderProtectedDetailsCommandSchema, CompleteOrderIngestionRunInputSchema, NormalizeOrderInputSchema, OrderFulfillmentViewSchema, OrderTransitionCommandSchema, OrderViewSchema } from "./order.js";

describe("order contracts", () => {
  it("uses integer minor units and accepts protected data only on the internal normalization boundary", () => {
    const parsed = NormalizeOrderInputSchema.parse({
      accountId: createEntityId(), platform: "etsy", externalEventId: "receipt-1:v3", externalOrderId: "receipt-1",
      providerStatus: "paid", placedAt: "2026-07-20T04:00:00.000Z", orderTotal: { amountMinor: 2640, currency: "USD" },
      lines: [{ externalLineId: "transaction-1", title: "Personalized pillow", quantity: 1, unitPrice: { amountMinor: 2640, currency: "USD" }, customizationCount: 1 }],
      redactedSource: { receipt_id: 1, name: "[REDACTED]" },
      protectedDetails: { buyer: { name: "Buyer", email: "buyer@example.test", phone: null }, shippingAddress: { recipient: "Buyer", lines: ["1 Test Street"], city: "Test", region: null, postalCode: "00000", countryCode: "US" }, customizations: [] },
    });
    expect(parsed.orderTotal.amountMinor).toBe(2640);
    expect(parsed.protectedDetails?.buyer.email).toBe("buyer@example.test");
  });

  it("rejects PII and encrypted envelopes on the public order view", () => {
    expect(OrderViewSchema.safeParse({ ...fixtureOrder(), buyer: { name: "Buyer" } }).success).toBe(false);
    expect(OrderViewSchema.safeParse({ ...fixtureOrder(), encryptedEnvelope: "v1.secret" }).success).toBe(false);
  });

  it("exposes protected details only through a purpose-bound fulfillment view", () => {
    const parsed = OrderFulfillmentViewSchema.parse({
      order: fixtureOrder(), purpose: "fulfillment", accessedAt: "2026-07-20T04:10:00.000Z",
      protectedDetails: { buyer: { name: "Buyer", email: null, phone: null }, shippingAddress: { recipient: "Buyer", lines: [], city: null, region: null, postalCode: null, countryCode: "US" }, customizations: [] },
    });
    expect(parsed.purpose).toBe("fulfillment");
  });

  it("requires optimistic sequence and idempotency on transition commands", () => {
    expect(OrderTransitionCommandSchema.safeParse({ toState: "awaiting_customization", expectedSequence: 1, idempotencyKey: "approve-0001" }).success).toBe(true);
    expect(OrderTransitionCommandSchema.safeParse({ toState: "awaiting_customization", expectedSequence: 0, idempotencyKey: "short" }).success).toBe(false);
  });

  it("requires optimistic order and envelope versions for irreversible PII anonymization", () => {
    const input = { expectedSequence: 3, expectedEnvelopeVersion: 2, idempotencyKey: "retention-anonymize-0001", reason: "Retention period elapsed" };
    expect(AnonymizeOrderProtectedDetailsCommandSchema.safeParse(input).success).toBe(true);
    expect(AnonymizeOrderProtectedDetailsCommandSchema.safeParse({ ...input, expectedEnvelopeVersion: 0 }).success).toBe(false);
    expect(AnonymizeOrderProtectedDetailsCommandSchema.safeParse({ ...input, customerEmail: "buyer@example.test" }).success).toBe(false);
  });

  it("keeps ingestion diagnostics bounded and free of arbitrary provider fields", () => {
    const input = {
      collectedCount: 2, reportedCount: 3, duplicateCount: 1, sourceVersion: "etsy-open-api-v3",
      nextCursor: null, highWaterAt: "2026-07-22T12:00:00.000Z", status: "completed",
      risks: [{ code: "address_gap", severity: "blocker", externalOrderId: "receipt-1", externalLineId: null, message: "Protected shipping address is incomplete or unavailable" }],
    };
    expect(CompleteOrderIngestionRunInputSchema.safeParse(input).success).toBe(true);
    expect(CompleteOrderIngestionRunInputSchema.safeParse({ ...input, buyerEmail: "buyer@example.test" }).success).toBe(false);
  });
});

function fixtureOrder() {
  return {
    id: createEntityId(), accountId: createEntityId(), platform: "etsy", externalOrderId: "receipt-1", providerStatus: "paid",
    workflowState: "pending", sideState: null, orderTotal: { amountMinor: 2640, currency: "USD" }, lineCount: 1,
    address: { status: "protected", countryCode: "US" }, latestEventSequence: 1,
    placedAt: "2026-07-20T04:00:00.000Z", createdAt: "2026-07-20T04:00:00.000Z", updatedAt: "2026-07-20T04:00:00.000Z",
    lines: [{ id: createEntityId(), externalLineId: "transaction-1", externalListingId: null, skuCode: null, title: "Personalized pillow", quantity: 1, unitPrice: { amountMinor: 2640, currency: "USD" }, customizationCount: 1 }],
  };
}
