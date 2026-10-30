import { describe, expect, it } from "vitest";
import { formatSpecificationWeight, orderedSpecifications } from "./specification-presentation";

describe("specification presentation preserves fixed business evidence", () => {
  it("orders eight sizes naturally without changing IDs, versions, evidence or the original array", () => {
    const input = Object.freeze([20, 12, 24, 10, 22, 14, 18, 16].map(size => Object.freeze({
      id: `spec-${size}`, code: `CP-${size}`, name: `${size} 英寸 · 图案主体最长边`,
      versionId: `fixed-version-${size}`, version: 4,
      productionEvidence: Object.freeze({ reference: `Synthetic supplier record ${size}`, rawWeight: 123.456789 }),
    })));
    const before = structuredClone(input), result = orderedSpecifications(input);
    expect(result.map(row => row.id)).toEqual(["spec-10", "spec-12", "spec-14", "spec-16", "spec-18", "spec-20", "spec-22", "spec-24"]);
    expect(result).not.toBe(input);
    expect(input).toEqual(before);
    for (const row of result) {
      const original = input.find(item => item.id === row.id)!;
      expect(row).toBe(original);
      expect(row.versionId).toBe(original.versionId);
      expect(row.version).toBe(4);
      expect(row.productionEvidence).toBe(original.productionEvidence);
    }
  });

  it("uses code and then ID for equal names, keeps every row and returns an independent empty array", () => {
    const rows = [{ id: "id-c", code: "CODE-A", name: "10 英寸" }, { id: "id-b", code: "CODE-B", name: "10 英寸" }, { id: "id-a", code: "CODE-A", name: "10 英寸" }];
    expect(orderedSpecifications(rows).map(row => row.id)).toEqual(["id-a", "id-c", "id-b"]);
    expect(rows.map(row => row.id)).toEqual(["id-c", "id-b", "id-a"]);
    const empty = Object.freeze([]);
    expect(orderedSpecifications(empty)).toEqual([]);
    expect(orderedSpecifications(empty)).not.toBe(empty);
  });
});

describe("packaged weight summary", () => {
  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -0, -1])("keeps missing or invalid weight %s unconfirmed instead of inventing zero grams", weight => {
    expect(formatSpecificationWeight(weight)).toBe("待确认");
  });

  it.each([[0.000001, "<0.01 g"], [0.009999, "<0.01 g"], [0.01, "0.01 g"], [1, "1 g"], [125.123456, "125.12 g"], [260.5, "260.5 g"], [123.999, "124 g"]] as const)("formats the summary for %s grams without modifying its precise source", (weight, display) => {
    const original = weight;
    expect(formatSpecificationWeight(weight)).toBe(display);
    expect(weight).toBe(original);
  });
});
