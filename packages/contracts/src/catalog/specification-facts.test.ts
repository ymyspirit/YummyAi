import { describe, expect, it } from "vitest";
import { SpecificationFactsSchema, specificationFactProblems, specificationFactsReady, specificationProductionFactProblems, specificationProductionFactsReady, normalizeSpecificationFactDisplay } from "./specification-facts.js";
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

  it("allows an explicitly checked production specification without claiming a net weight or full product confirmation", () => {
    const facts = syntheticSpecificationFacts({ factsConfirmed: false, productionConfirmed: true, weightGrams: null });
    expect(SpecificationFactsSchema.parse(facts).weightGrams).toBeNull();
    expect(specificationProductionFactsReady(facts)).toBe(true);
    expect(specificationFactsReady(facts)).toBe(false);
    expect(specificationFactProblems(facts)).toContain("商品重量与含包装重量尚未确认");
    expect(specificationProductionFactsReady({ ...facts, productionConfirmed: false })).toBe(false);
  });

  it("does not require package measurements for artwork production or turn missing shipping facts into zero", () => {
    const facts = syntheticSpecificationFacts({ factsConfirmed: false, productionConfirmed: true, weightGrams: null,
      packagedWeightGrams: null, packageMeasurements: null });
    expect(specificationProductionFactsReady(facts)).toBe(true);
    expect(specificationFactsReady(facts)).toBe(false);
    expect(normalizeSpecificationFactDisplay(facts).packagedWeightGrams).toBeNull();
  });

  it("retains production requirements and rejects contradictory weights even under a production-only confirmation", () => {
    const facts = syntheticSpecificationFacts({ factsConfirmed: false, productionConfirmed: true, weightGrams: null });
    for (const patch of [{ material: "" }, { structure: "" }, { physicalDimensions: null },
      { packageContents: "" }, { packageQuantity: null }, { verificationReference: "" },
      { weightGrams: 200, packagedWeightGrams: 100 }])
      expect(specificationProductionFactsReady({ ...facts, ...patch })).toBe(false);
    expect(specificationProductionFactsReady({ ...facts, physicalDimensions: {
      basis: "artwork_longest", unit: "in", length: 16, width: 10, height: null,
    } })).toBe(false);
    expect(specificationProductionFactsReady({ ...facts, formatVersion: undefined })).toBe(false);
    expect(specificationProductionFactProblems({ ...facts, productionConfirmed: false })).toContain("生产资料尚未核对");
  });

  it("preserves fully confirmed V2 compatibility and pins each rule to one immutable version", () => {
    expect(specificationProductionFactsReady(syntheticSpecificationFacts())).toBe(true);
    const reference = { ruleId: "019f7600-0000-7000-8000-000000000901", versionId: "019f7600-0000-7000-8000-000000000902", version: 1 };
    const facts = syntheticSpecificationFacts({ factsConfirmed: false, productionConfirmed: true, weightGrams: null,
      productionRuleReferences: [reference] });
    expect(SpecificationFactsSchema.parse(facts).productionRuleReferences).toEqual([reference]);
    const upperReference = { ...reference, ruleId: reference.ruleId.toUpperCase(), versionId: reference.versionId.toUpperCase() };
    expect(SpecificationFactsSchema.parse({ ...facts, productionRuleReferences: [upperReference] }).productionRuleReferences).toEqual([reference]);
    expect(SpecificationFactsSchema.safeParse({ ...facts, productionRuleReferences: [reference, upperReference] }).success).toBe(false);
    expect(SpecificationFactsSchema.safeParse({ ...facts, productionRuleReferences: [reference, { ...reference, version: 2 }] }).success).toBe(false);
    expect(SpecificationFactsSchema.safeParse({ ...facts, productionRuleReferences: [{ ...reference, confirmedByUserId: "invented" }] }).success).toBe(false);
    expect(SpecificationFactsSchema.safeParse({ ...facts, productionRuleReferences: Array.from({ length: 13 }, () => reference) }).success).toBe(false);
  });
});
