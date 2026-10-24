import type { FactoryCapacityPoolProfile } from "../../packages/contracts/src/suppliers/factory-capacity.js";

/** Explicit finite, synthetic confirmation for an owned disposable fixture only. */
export function syntheticFactoryCapacityProfile(
  bindings: Array<{ capabilityVersionId: string; unitsPerItem: number }>,
  dailyCapacityUnits: number,
  options: Partial<FactoryCapacityPoolProfile> = {},
): FactoryCapacityPoolProfile {
  return {
    name: "Synthetic confirmed production resource",
    status: "active",
    dailyCapacityUnits,
    weekly: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [{ start: "00:00", end: "24:00" }] })),
    exceptions: [],
    cutoffTime: null,
    bindings,
    evidenceReference: "Synthetic explicit capacity confirmation for disposable acceptance only",
    notes: "No real factory capacity, acceptance or production commitment is asserted",
    ...options,
  };
}
