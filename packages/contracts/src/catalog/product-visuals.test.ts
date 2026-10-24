import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import {
  AdoptProductVisualsSchema,
  CollectProductVisualsSchema,
  GenerateProductVisualSchema,
  PrepareProductVisualsSchema,
  ReviewProductVisualSchema,
} from "./product-visuals.js";

describe("controlled product visual commands", () => {
  const prepare = () => ({
    requestId: randomUUID(),
    expectedRevision: 1,
    sampleAssetId: createEntityId(),
    sampleAttestation: "Synthetic licensed sample",
    modelId: createEntityId(),
    direction: "Original synthetic shape",
    callCeilingUsd: 0.15,
    totalBudgetUsd: 0.6,
    budgetAttested: true,
  });
  it("requires an attested bounded budget and rejects caller-selected rights or tenant context", () => {
    expect(PrepareProductVisualsSchema.parse(prepare()).size).toBe("2048x2048");
    for (const input of [
      { ...prepare(), budgetAttested: false },
      { ...prepare(), callCeilingUsd: 0 },
      { ...prepare(), totalBudgetUsd: 0.1 },
      { ...prepare(), totalBudgetUsd: 0.0000001 },
      { ...prepare(), rightsStatus: "approved" },
      { ...prepare(), tenantId: createEntityId() },
    ])
      expect(PrepareProductVisualsSchema.safeParse(input).success).toBe(false);
    const input = prepare();
    expect(
      PrepareProductVisualsSchema.safeParse({ ...input, referenceAssetIds: [input.sampleAssetId] })
        .success,
    ).toBe(false);
  });
  it("requires the exact artwork origin for derived image slots", () => {
    const input = { requestId: randomUUID(), modelId: createEntityId(), slotKey: "scene" };
    expect(GenerateProductVisualSchema.safeParse(input).success).toBe(false);
    expect(
      GenerateProductVisualSchema.safeParse({ ...input, artworkVersionId: createEntityId() })
        .success,
    ).toBe(true);
    expect(GenerateProductVisualSchema.safeParse({ ...input, slotKey: "artwork" }).success).toBe(
      true,
    );
  });
  it("requires four explicit visual checks and a reason when returning a version", () => {
    const input = {
      versionId: createEntityId(),
      decision: "approve",
      checks: { identity: true, shape: true, facts: true, sides: true },
    };
    expect(ReviewProductVisualSchema.safeParse(input).success).toBe(true);
    for (const key of Object.keys(input.checks))
      expect(
        ReviewProductVisualSchema.safeParse({ ...input, checks: { ...input.checks, [key]: false } })
          .success,
      ).toBe(false);
    expect(ReviewProductVisualSchema.safeParse({ ...input, decision: "reject" }).success).toBe(
      false,
    );
    expect(
      ReviewProductVisualSchema.safeParse({
        ...input,
        decision: "reject",
        reason: "Synthetic shape mismatch",
      }).success,
    ).toBe(true);
  });
  it("selects exactly three distinct immutable versions and keeps collection free of model input", () => {
    const input = {
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      versionIds: Array.from({ length: 3 }, createEntityId),
    };
    expect(AdoptProductVisualsSchema.safeParse(input).success).toBe(true);
    expect(
      AdoptProductVisualsSchema.safeParse({ ...input, versionIds: input.versionIds.slice(1) })
        .success,
    ).toBe(false);
    expect(
      AdoptProductVisualsSchema.safeParse({
        ...input,
        versionIds: [input.versionIds[0], input.versionIds[0], input.versionIds[1]],
      }).success,
    ).toBe(false);
    expect(CollectProductVisualsSchema.safeParse({ modelId: createEntityId() }).success).toBe(
      false,
    );
  });
});
