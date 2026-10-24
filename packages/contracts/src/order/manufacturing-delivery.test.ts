import { describe, expect, it } from "vitest";
import { FactoryManufacturingPlanSchema } from "./manufacturing-delivery.js";
import { RecordProductionDeliveryFeedbackSchema } from "./production-delivery.js";
import { FactoryTaskFeedbackSchema } from "../suppliers/factory-portal.js";

const plan = () => ({ schemaVersion: 1, code: "MF-SYNTHETIC", name: "Synthetic factory plan", versionNumber: 1,
  sourceContentChecksum: "a".repeat(64), checksum: "b".repeat(64), quantity: 2, unit: "each", recipeOutputQuantity: 1, proposalOnly: true,
  materials: [{ code: "FABRIC", name: "Synthetic fabric", unit: "meter", responsibility: "merchant", operationCode: "MAKE", recipeQuantityNumerator: 1,
    recipeQuantityDenominator: 2, lossBps: 0, lossBasis: "add_to_net", plannedNumerator: "1", plannedDenominator: "1" }],
  operations: [{ code: "MAKE", name: "Synthetic manufacture", processCode: "make", responsibility: "factory" }] });
describe("factory manufacturing delivery boundary", () => {
  it("accepts precise planned fractions and refuses rounded or invalid quantities", () => {
    expect(FactoryManufacturingPlanSchema.safeParse(plan()).success).toBe(true);
    for (const plannedNumerator of ["1.5", "1e9", "-1", "0"]) expect(FactoryManufacturingPlanSchema.safeParse({ ...plan(), materials: [{ ...plan().materials[0], plannedNumerator }] }).success).toBe(false);
    expect(FactoryManufacturingPlanSchema.safeParse({ ...plan(), materials: [{ ...plan().materials[0], plannedDenominator: "0" }] }).success).toBe(false);
  });
  it("rejects private BOM fields at every public level", () => {
    for (const privatePlan of [{ ...plan(), notes: "Private price" }, { ...plan(), materials: [{ ...plan().materials[0], stockItemId: crypto.randomUUID() }] },
      { ...plan(), operations: [{ ...plan().operations[0], notes: "Private internal instruction", expectedSecondsPerOutput: 60 }] }])
      expect(FactoryManufacturingPlanSchema.safeParse(privatePlan).success).toBe(false);
  });
  it("does not add manufacturing checksum defaults to historical receipt bodies", () => {
    const base = { kind: "received", expectedSequence: 0, fileChecksum: "a".repeat(64), idempotencyKey: crypto.randomUUID(), reference: "SYNTHETIC", note: "Synthetic historical receipt", occurredAt: new Date().toISOString() };
    expect(Object.hasOwn(RecordProductionDeliveryFeedbackSchema.parse({ ...base, verifiedByOperator: true }), "manufacturingChecksum")).toBe(false);
    expect(Object.hasOwn(FactoryTaskFeedbackSchema.parse({ ...base, confirmedFileVersion: true }), "manufacturingChecksum")).toBe(false);
  });
});
