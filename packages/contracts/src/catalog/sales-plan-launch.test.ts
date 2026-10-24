import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { LaunchAdoptRequestSchema, LaunchBasisRequestSchema } from "./sales-plan-launch.js";
describe("sales launch commands", () => {
  const command = () => ({
    kind: "creative",
    runId: createEntityId(),
    fields: ["positioning"],
    expectedRevision: 1,
    idempotencyKey: createEntityId(),
  });
  it("rejects facts, approval state, duplicate fields and untrusted values", () => {
    for (const input of [
      { ...command(), fields: ["factsConfirmed"] },
      { ...command(), fields: ["positioning", "positioning"] },
      { ...command(), values: { positioning: "forged" } },
      { ...command(), approval: "approved" },
      { ...command(), tenantId: createEntityId() },
      { ...command(), expectedRevision: 0 },
    ])
      expect(LaunchAdoptRequestSchema.safeParse(input).success).toBe(false);
  });
  it("requires an explicit version and bounded focus for free previews", () => {
    expect(
      LaunchBasisRequestSchema.safeParse({
        kind: "creative",
        expectedRevision: 1,
        taskGoal: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      LaunchBasisRequestSchema.safeParse({
        kind: "creative",
        expectedRevision: 1,
        modelId: createEntityId(),
      }).success,
    ).toBe(false);
    expect(LaunchAdoptRequestSchema.parse(command()).directionIndex).toBe(0);
  });
});
