import { describe, expect, it } from "vitest";
import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { emptySpecificationFactDraft, specificationFactsDraft, specificationFactsFromDraft } from "./specification-fact-fields";

describe("specification measurement drafts", () => {
  it("keeps unknown counts and measurements null and never parses a variant label as physical evidence", () => {
    const facts = specificationFactsFromDraft({ ...emptySpecificationFactDraft, dimensions: "10 inch size label" }, false);
    expect(facts).toMatchObject({ dimensions: "10 inch size label", packageQuantity: null, physicalDimensions: { basis: null, unit: null, length: null } });
    expect(specificationFactsReady(facts)).toBe(false);
    expect(specificationFactsDraft({ material: "Known fabric", dimensions: "10 inch legacy", packageContents: "One", packageQuantity: 1, factsConfirmed: true })).toMatchObject({ sizeBasis: "", sizeUnit: "", sizeLength: "", verificationReference: "", packageQuantity: "1" });
  });
  it("round-trips an explicitly chosen unit without converting or relabeling the measured number", () => {
    const draft = { ...emptySpecificationFactDraft, material: "Measured fabric", structure: "Measured construction", packageContents: "One", packageQuantity: "1", weightGrams: "200", packagedWeightGrams: "250", sizeBasis: "artwork_longest", sizeUnit: "in", sizeLength: "10", packageUnit: "cm", packageLength: "30", packageWidth: "30", packageHeight: "10", verificationReference: "Synthetic measurement record" };
    const facts = specificationFactsFromDraft(draft, true);
    expect(specificationFactsReady(facts)).toBe(true);
    expect(facts.physicalDimensions).toMatchObject({ unit: "in", length: 10 });
    expect(facts.dimensions).toContain("10 in");
    expect(specificationFactsDraft(facts)).toMatchObject({ sizeUnit: "in", sizeLength: "10", packageUnit: "cm", packageLength: "30" });
  });
});
