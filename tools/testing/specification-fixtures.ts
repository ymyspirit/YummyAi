import { normalizeSpecificationFactDisplay, type SpecificationFacts } from "../../packages/contracts/src/catalog/specification-facts";

/** Explicit synthetic measurements, never a default for actual products or an approval claim. */
export function syntheticSpecificationFacts(overrides: Partial<SpecificationFacts> = {}): SpecificationFacts {
  return normalizeSpecificationFactDisplay({
    formatVersion: 2,
    material: "Synthetic test fabric",
    dimensions: "",
    physicalDimensions: { basis: "artwork_longest", unit: "mm", length: 254, width: null, height: null },
    structure: "Synthetic test construction",
    packageContents: "Synthetic one-piece test package",
    packageQuantity: 1,
    weightGrams: 200,
    packagedWeightGrams: 250,
    packageMeasurements: { unit: "mm", length: 300, width: 300, height: 100 },
    verificationReference: "Synthetic disposable fixture only; no actual measurement or factory approval",
    factsConfirmed: true,
    ...overrides,
  });
}
