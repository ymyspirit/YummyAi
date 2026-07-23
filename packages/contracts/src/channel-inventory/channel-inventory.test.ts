import { describe, expect, it } from "vitest";

import {
  RecordNetworkInventorySnapshotInputSchema,
  UpsertChannelAllocationPolicyInputSchema,
} from "./channel-inventory.js";

describe("channel inventory contracts", () => {
  it("rejects virtual eligibility unless the policy explicitly enables it", () => {
    expect(() => UpsertChannelAllocationPolicyInputSchema.parse({
      policyId: null,
      stockItemId: "019f8dd7-bdc0-716d-b55a-d20f3a8ea4a1",
      name: "Policy",
      eligibleSources: ["virtual"],
      allowVirtual: false,
      safetyBufferQuantity: 0,
      channels: [{
        accountId: "019f8dd7-bdc0-716d-b55a-d20f3a8ea4a2",
        platform: "etsy",
        marketplaceId: "US",
        listingId: null,
        priority: 1,
        capQuantity: null,
        bufferQuantity: 0,
      }],
      reasonCode: "TEST",
      idempotencyKey: "policy-test-0001",
    })).toThrow("Virtual stock requires allowVirtual");
  });

  it("requires a non-empty immutable snapshot payload", () => {
    expect(() => RecordNetworkInventorySnapshotInputSchema.parse({
      accountId: null,
      provider: "internal",
      scopeKey: "owned:main",
      providerSnapshotId: null,
      checkpointSequence: 1,
      checkpointCursor: null,
      observedAt: "2026-07-23T08:00:00.000Z",
      idempotencyKey: "snapshot-test-0001",
      lines: [],
    })).toThrow();
  });
});
