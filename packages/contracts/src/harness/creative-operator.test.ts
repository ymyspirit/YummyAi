import { describe, expect, it } from "vitest";
import { CreativeHistoryQuerySchema, CreativeOperatorCommandSchema } from "./creative-operator.js";

const command = { action: "record_check", commandId: "81a06f57-c64a-4b73-a3af-98b22378cb01", expectedFingerprint: "a".repeat(64),
  finding: "response_located", proofChecksum: "b".repeat(64), matchesOriginalRequest: true };
describe("bounded human creative execution controls", () => {
  it("accepts explicit original-request attestations and excludes raw proof, prompts and state replacements", () => {
    expect(CreativeOperatorCommandSchema.parse(command)).toEqual(command);
    for (const patch of [{ rawProof: "private" }, { phase: "pending" }, { prompt: "private" }, { authoritySnapshot: {} }, { amountUsd: "0.00" }])
      expect(CreativeOperatorCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
    expect(CreativeOperatorCommandSchema.safeParse({ ...command, matchesOriginalRequest: false }).success).toBe(false);
  });
  it("does not allow a recovery request to reset attempts, budgets or original input", () => {
    const recovery = { action: "request_recovery", commandId: command.commandId, expectedFingerprint: command.expectedFingerprint };
    expect(CreativeOperatorCommandSchema.safeParse(recovery).success).toBe(true);
    for (const patch of [{ attemptCount: 0 }, { budgetLimitUsd: "999" }, { inputFingerprint: "f".repeat(64) }])
      expect(CreativeOperatorCommandSchema.safeParse({ ...recovery, ...patch }).success).toBe(false);
  });
  it("requires an exact history cursor and refuses caller-selected tenant identifiers", () => {
    expect(CreativeHistoryQuerySchema.parse({})).toEqual({});
    expect(CreativeHistoryQuerySchema.safeParse({ after: "unbounded" }).success).toBe(false);
    expect(CreativeHistoryQuerySchema.safeParse({ tenantId: command.commandId }).success).toBe(false);
  });
});
