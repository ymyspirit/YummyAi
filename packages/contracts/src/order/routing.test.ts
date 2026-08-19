import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import {
  CreateRoutingPolicyInputSchema,
  CreateSupplierCapacityWindowInputSchema,
  SupplierRoutingCandidateSchema,
} from "./routing.js";

describe("supplier routing contracts", () => {
  it("requires integer-basis-point weights totaling exactly 10000", () => {
    const policy = fixturePolicy();
    expect(CreateRoutingPolicyInputSchema.safeParse(policy).success).toBe(true);
    expect(CreateRoutingPolicyInputSchema.safeParse({ ...policy, weights: { ...policy.weights, cost: 2_501 } }).success).toBe(false);
  });

  it("rejects capacity windows that over-reserve or travel backwards", () => {
    const base = { supplierId: createEntityId(), startsAt: "2026-07-22T00:00:00.000Z", endsAt: "2026-07-23T00:00:00.000Z", availableUnits: 10, reservedUnits: 4, sourceVersion: "manual-v1" };
    expect(CreateSupplierCapacityWindowInputSchema.safeParse(base).success).toBe(true);
    expect(CreateSupplierCapacityWindowInputSchema.safeParse({ ...base, reservedUnits: 11 }).success).toBe(false);
    expect(CreateSupplierCapacityWindowInputSchema.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
  });

  it("keeps candidate diagnostics static and free of arbitrary provider messages", () => {
    const candidate = {
      supplierId: createEntityId(), quoteId: createEntityId(), capabilitySnapshotId: createEntityId(), capacityWindowId: createEntityId(),
      eligible: false, exclusionCodes: ["capacity_insufficient"],
      scores: { capability: 10_000, region: 10_000, cost: 8_000, leadTime: 7_000, capacity: 0, quality: 9_500, priority: 8_000, total: 7_350 },
      unitCostMinor: 1_250, leadTimeDays: 4, availableUnits: 0, qualityScoreBps: 9_500,
    };
    expect(SupplierRoutingCandidateSchema.safeParse(candidate).success).toBe(true);
    expect(SupplierRoutingCandidateSchema.safeParse({ ...candidate, providerMessage: "secret upstream response" }).success).toBe(false);
  });
});

function fixturePolicy() {
  return {
    name: "Balanced POD routing",
    weights: { capability: 1_500, region: 1_000, cost: 2_500, leadTime: 1_500, capacity: 1_000, quality: 1_500, priority: 1_000 },
    minimumQualityBps: 8_000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 3_000,
    manualApprovalCostMinor: 2_000, manualApprovalRiskBps: 2_000,
  };
}
