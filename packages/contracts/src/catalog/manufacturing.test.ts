import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { ManufacturingRecipeContentSchema, calculateManufacturingDemand, manufacturingApprovalProblems } from "./manufacturing.js";

const content = () => ManufacturingRecipeContentSchema.parse({
  specificationVersionId: createEntityId(), name: "Synthetic textile", outputQuantity: 2, outputUnit: "each",
  materials: [{ code: "FABRIC", name: "Fabric", stockItemId: createEntityId(), quantityNumerator: 3, quantityDenominator: 2,
    unit: "meter", lossBps: 1000, lossBasis: "add_to_net", responsibility: "merchant", operationCode: "CUT" }],
  operations: [{ code: "CUT", name: "Cut", processCode: "cut", responsibility: "factory", expectedSecondsPerOutput: null }],
});
describe("manufacturing version and exact material proposals", () => {
  it("distinguishes both explicit loss bases and returns exact fractional base units without changing inventory", () => {
    const input = content();
    expect(calculateManufacturingDemand(input, 3).lines[0]).toMatchObject({ exactNumerator: "99", exactDenominator: "40", wholeBaseUnitCeiling: "3", responsibility: "merchant" });
    input.materials[0]!.lossBasis = "fraction_of_input";
    expect(calculateManufacturingDemand(input, 3).lines[0]).toMatchObject({ exactNumerator: "5", exactDenominator: "2" });
    expect(input.materials[0]!.quantityNumerator).toBe(3);
  });
  it("preserves unknown drafts and lists approval gaps instead of treating unknown consumption as zero", () => {
    const input = content(); input.materials[0]!.quantityNumerator = null; input.materials[0]!.lossBasis = null;
    input.materials[0]!.responsibility = "unknown";
    expect(ManufacturingRecipeContentSchema.parse(input).materials[0]!.quantityNumerator).toBeNull();
    expect(manufacturingApprovalProblems(input)).toHaveLength(3);
    expect(() => calculateManufacturingDemand(input, 1)).toThrow("尚未确认");
  });
  it("retains separate cut lines of one material, and rejects duplicate codes or missing operations", () => {
    const input = content(); input.materials.push({ ...input.materials[0]!, code: "SECOND_CUT" });
    expect(ManufacturingRecipeContentSchema.safeParse(input).success).toBe(true);
    input.materials[1]!.code = "FABRIC";
    expect(ManufacturingRecipeContentSchema.safeParse(input).success).toBe(false);
    input.materials[1]!.code = "SECOND_CUT"; input.materials[1]!.operationCode = "MISSING";
    expect(ManufacturingRecipeContentSchema.safeParse(input).success).toBe(false);
  });
  it("rejects impossible input-loss, implicit negative or zero quantities and unexpected approval injection", () => {
    const input = content(); input.materials[0]!.lossBasis = "fraction_of_input"; input.materials[0]!.lossBps = 10000;
    expect(ManufacturingRecipeContentSchema.safeParse(input).success).toBe(false);
    expect(ManufacturingRecipeContentSchema.safeParse({ ...content(), outputQuantity: 0 }).success).toBe(false);
    expect(ManufacturingRecipeContentSchema.safeParse({ ...content(), approved: true }).success).toBe(false);
  });
  it("sums exact repeated material lines before ceiling and keeps factory supply separate", () => {
    const input = content(); input.materials.push({ ...input.materials[0]!, code: "SECOND_CUT" });
    const result = calculateManufacturingDemand(input, 3);
    expect(result.totals).toHaveLength(1);
    expect(result.totals[0]).toMatchObject({ exactNumerator: "99", exactDenominator: "20", wholeBaseUnitCeiling: "5" });
    input.materials[1]!.responsibility = "factory";
    expect(calculateManufacturingDemand(input, 3).totals).toHaveLength(2);
  });
});
