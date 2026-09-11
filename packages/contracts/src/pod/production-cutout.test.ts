import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { RefineProductionImageInputSchema, ProductionCutoutRecipeSchema } from "./production-cutout.js";

const input = { expectedVersionId: createEntityId(), recipe: { schemaVersion: 1, maskPngBase64: null, operations: [] }, radius: 0.01, strokes: [] };
describe("cutout refinement request boundaries", () => {
  it("rejects remote URLs, unbounded brush paths, and out-of-image coordinates", () => {
    expect(RefineProductionImageInputSchema.safeParse({ ...input, sourceUrl: "https://example.test/private" }).success).toBe(false);
    expect(RefineProductionImageInputSchema.safeParse({ ...input, radius: 1 }).success).toBe(false);
    expect(RefineProductionImageInputSchema.safeParse({ ...input, strokes: [{ radius: 0.1, points: [{ x: -0.1, y: 0.5 }] }] }).success).toBe(false);
    const stroke = { radius: 0.01, points: Array.from({ length: 2000 }, () => ({ x: 0.5, y: 0.5 })) };
    expect(RefineProductionImageInputSchema.safeParse({ ...input, strokes: Array(5).fill(stroke) }).success).toBe(false);
    expect(RefineProductionImageInputSchema.safeParse(input).success).toBe(true);
  });
  it("keeps old recipes readable and bounds cleanup so it cannot become a hard cutoff", () => {
    expect(ProductionCutoutRecipeSchema.parse(input.recipe)).toEqual(input.recipe);
    expect(ProductionCutoutRecipeSchema.safeParse({ ...input.recipe, operations: [{ kind: "clean-alpha", threshold: 0.1 }] }).success).toBe(true);
    expect(ProductionCutoutRecipeSchema.safeParse({ ...input.recipe, operations: [{ kind: "clean-alpha", threshold: 1 }] }).success).toBe(false);
  });
});
