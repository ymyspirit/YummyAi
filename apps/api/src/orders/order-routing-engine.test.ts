import { createEntityId, type CreateRoutingPolicyInput } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { evaluateSupplierRouting, type RoutingEngineInput, type RoutingSourceCandidate } from "./order-routing-engine.js";

describe("deterministic supplier routing", () => {
  it("produces the same selection, ordering, and checksum regardless of source order", () => {
    const left = candidate({ unitCostMinor: 1_200, leadTimeDays: 5, priority: 2 });
    const right = candidate({ unitCostMinor: 1_000, leadTimeDays: 6, priority: 3 });
    const input = fixture([left, right]);
    const forward = evaluateSupplierRouting(input);
    const reverse = evaluateSupplierRouting({ ...input, candidates: [right, left] });
    expect(forward.selectedSupplierId).toBe(left.supplier.id);
    expect(reverse.selectedSupplierId).toBe(forward.selectedSupplierId);
    expect(reverse.candidates).toEqual(forward.candidates);
    expect(reverse.inputChecksum).toBe(forward.inputChecksum);
    expect(forward.requiresApproval).toBe(false);
  });

  it("uses supplier ID as the final stable tie breaker", () => {
    const first = candidate({ unitCostMinor: 1_000, leadTimeDays: 4, priority: 1 });
    const second = candidate({ unitCostMinor: 1_000, leadTimeDays: 4, priority: 1 });
    const result = evaluateSupplierRouting(fixture([first, second]));
    expect(result.selectedSupplierId).toBe([first.supplier.id, second.supplier.id].sort()[0]);
  });

  it("retains static exclusion evidence and never selects an ineligible candidate", () => {
    const blocked = candidate({ unitCostMinor: 900, leadTimeDays: 2, priority: 1 });
    blocked.capability.blockedRegionCodes = ["CA"];
    blocked.capacity.reservedUnits = blocked.capacity.availableUnits;
    const eligible = candidate({ unitCostMinor: 1_500, leadTimeDays: 7, priority: 4 });
    const result = evaluateSupplierRouting(fixture([blocked, eligible]));
    expect(result.selectedSupplierId).toBe(eligible.supplier.id);
    expect(result.candidates.find((entry) => entry.supplierId === blocked.supplier.id)).toMatchObject({
      eligible: false, exclusionCodes: ["region_blocked", "capacity_insufficient"],
    });
  });

  it("requires review at cost/risk thresholds and when no supplier is eligible", () => {
    const highCost = candidate({ unitCostMinor: 1_500, leadTimeDays: 4, priority: 1, qualityScoreBps: 7_900 });
    const input = fixture([highCost]);
    input.policy = { ...input.policy, minimumQualityBps: 7_000, manualApprovalCostMinor: 1_000, manualApprovalRiskBps: 2_000 };
    expect(evaluateSupplierRouting(input)).toMatchObject({ requiresApproval: true, approvalReasons: ["cost_threshold", "risk_threshold"] });
    highCost.supplier.status = "suspended";
    expect(evaluateSupplierRouting(input)).toMatchObject({ selectedSupplierId: null, requiresApproval: true, approvalReasons: ["no_eligible_supplier"] });
  });
});

function fixture(candidates: RoutingSourceCandidate[]): RoutingEngineInput {
  const first = candidates[0]!;
  return {
    skuId: first.quote.skuId, quantity: 2, currency: "USD", processCodes: ["EMBROIDERY"],
    destinationCountryCode: "US", destinationRegionCode: "CA", evaluatedAt: "2026-07-22T12:00:00.000Z",
    policy: { id: createEntityId(), versionNumber: 1, ...policy() }, candidates,
  };
}

function policy(): CreateRoutingPolicyInput {
  return {
    name: "Balanced POD routing",
    weights: { capability: 1_500, region: 1_000, cost: 2_500, leadTime: 1_500, capacity: 1_000, quality: 1_500, priority: 1_000 },
    minimumQualityBps: 8_000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 3_000,
    manualApprovalCostMinor: 2_000, manualApprovalRiskBps: 2_001,
    tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"],
  };
}

function candidate(input: { unitCostMinor: number; leadTimeDays: number; priority: number; qualityScoreBps?: number }): RoutingSourceCandidate {
  const supplierId = createEntityId();
  const skuId = "019b0000-0000-7000-8000-000000000001";
  return {
    supplier: { id: supplierId, status: "active", priority: input.priority },
    capability: {
      id: createEntityId(), supportedSkuIds: [skuId], processCodes: ["EMBROIDERY"], serviceCountryCodes: ["US"],
      blockedRegionCodes: [], qualityScoreBps: input.qualityScoreBps ?? 9_000,
    },
    quote: {
      id: createEntityId(), skuId, unitCostMinor: input.unitCostMinor, currency: "USD", minimumOrderQuantity: 1,
      leadTimeDays: input.leadTimeDays, validFrom: "2026-07-01T00:00:00.000Z", validUntil: "2026-08-01T00:00:00.000Z",
    },
    capacity: { id: createEntityId(), startsAt: "2026-07-22T00:00:00.000Z", endsAt: "2026-07-23T00:00:00.000Z", availableUnits: 100, reservedUnits: 0 },
  };
}
