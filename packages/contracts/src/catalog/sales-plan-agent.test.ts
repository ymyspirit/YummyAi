import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts/common/ids";
import { PreparationAnalyzeSchema, PreparationStartSchema, PreparationCommandSchema } from "./sales-plan-agent.js";
describe("sales preparation command boundary", () => {
  it("rejects arbitrary execution paths, tenant selection, source values and missing revision pins", () => {
    const base = { expectedRevision: 1, idempotencyKey: createEntityId() };
    expect(PreparationStartSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ tools: ["publish"] }, { tenantId: createEntityId() }, { approved: true }])
      expect(PreparationStartSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(PreparationCommandSchema.safeParse(base).success).toBe(false);
    expect(PreparationAnalyzeSchema.safeParse({ ...base, expectedRunRevision: 1, kind: "creative",
      modelId: createEntityId(), expectedFingerprint: "a".repeat(64) }).success).toBe(true);
    expect(PreparationAnalyzeSchema.safeParse({ ...base, expectedRunRevision: 1, kind: "purchase_label" }).success).toBe(false);
  });
});
