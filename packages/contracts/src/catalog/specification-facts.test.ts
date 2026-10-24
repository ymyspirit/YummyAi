import { describe, expect, it } from "vitest";
import { SpecificationFactsSchema, specificationFactProblems, specificationFactsReady, normalizeSpecificationFactDisplay } from "./specification-facts.js";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";

describe("explicit product specification facts", () => {
  it("persists unknown draft values without manufacturing defaults or confirmation", () => {
    const draft = SpecificationFactsSchema.parse({ formatVersion: 2, material: "", dimensions: "", packageContents: "", packageQuantity: null, factsConfirmed: false });
    expect(draft.packageQuantity).toBeNull();
    expect(draft.physicalDimensions).toBeUndefined();
    expect(specificationFactsReady(draft)).toBe(false);
  });
  it("keeps legacy input shape and values intact but requires a new confirmation for new work", () => {
    const old = { material: "fabric", dimensions: "10in", packageContents: "one", packageQuantity: 1, factsConfirmed: true };
    expect(SpecificationFactsSchema.parse(old)).toEqual(old);
    expect(normalizeSpecificationFactDisplay(old)).toBe(old);
    expect(specificationFactProblems(old)).toEqual([expect.stringContaining("旧规格")]);
  });
  it("requires measured dimensions, structure, packaging, weights and a reference before readiness", () => {
    const complete = syntheticSpecificationFacts();
    expect(specificationFactsReady(complete)).toBe(true);
    for (const patch of [{ factsConfirmed: false }, { material: "" }, { structure: "" }, { physicalDimensions: null }, { packageContents: "" }, { packageQuantity: null }, { weightGrams: null }, { packagedWeightGrams: null }, { packageMeasurements: null }, { verificationReference: "" }, { packagedWeightGrams: 100 }])
      expect(specificationFactsReady({ ...complete, ...patch })).toBe(false);
  });
  it("distinguishes a longest side or diameter from planar and three-dimensional measurements", () => {
    const base = syntheticSpecificationFacts();
    for (const basis of ["artwork_longest", "diameter"] as const)
      expect(specificationFactsReady({ ...base, physicalDimensions: { basis, unit: "in", length: 10, width: null, height: null } })).toBe(true);
    for (const basis of ["finished_outer_2d", "flat_piece", "finished_outer_3d"] as const) {
      const physicalDimensions = { basis, unit: "cm" as const, length: 25.4, width: null, height: null };
      expect(specificationFactsReady({ ...base, physicalDimensions })).toBe(false);
      expect(specificationFactsReady({ ...base, physicalDimensions: { ...physicalDimensions, width: 20, height: basis === "finished_outer_3d" ? 8 : null } })).toBe(true);
    }
  });
  it("rejects invalid measurements and caller-invented confirmation metadata", () => {
    for (const value of [0, -1, NaN, Infinity])
      expect(SpecificationFactsSchema.safeParse(syntheticSpecificationFacts({ weightGrams: value })).success).toBe(false);
    expect(SpecificationFactsSchema.safeParse({ ...syntheticSpecificationFacts(), confirmedByUserId: "invented" }).success).toBe(false);
    expect(SpecificationFactsSchema.safeParse(syntheticSpecificationFacts({ physicalDimensions: { basis: "artwork_longest", unit: "mm", length: -1, width: null, height: null } })).success).toBe(false);
  });
});
