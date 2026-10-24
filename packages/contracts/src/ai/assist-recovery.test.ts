import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { CreateAssistSchema, AssistViewSchema } from "./assist.js";
import { AssistIntentSchema, AssistReceiptQuerySchema, AssistReceiptViewSchema, assistRequestRecoveryText } from "./assist-recovery.js";

const hash = "b".repeat(64);
const request = () => CreateAssistSchema.options[0].parse({ kind: "knowledge_answer", requestId: randomUUID(), modelId: createEntityId(), scopeId: randomUUID(),
  search: { query: "Synthetic recovery question", topic: "operations", platform: "all", market: "ALL", spuIds: [] } });

describe("Original Assist receipt contracts", () => {
  it("uses the original parsed-request JSON text without rewriting legacy fingerprints", () => {
    const input = request(), before = JSON.stringify(input);
    const reordered = Object.fromEntries(Object.entries(input).reverse());
    expect(assistRequestRecoveryText(input)).toBe(JSON.stringify(CreateAssistSchema.parse(input)));
    expect(assistRequestRecoveryText(input)).toBe(assistRequestRecoveryText(CreateAssistSchema.parse(reordered)));
    expect(JSON.stringify(input)).toBe(before);
    expect(assistRequestRecoveryText({ ...input, modelId: createEntityId() })).not.toBe(assistRequestRecoveryText(input));
  });

  it("persists only hashed owner/task scope and original IDs without prompts or original bodies", () => {
    const input = { version: 1, ownerScope: hash, taskScope: hash, kind: "knowledge_answer", requestId: randomUUID(), requestChecksum: hash, runId: null };
    expect(AssistIntentSchema.parse(input)).toEqual(input);
    for (const field of ["request", "prompt", "result", "authorization", "tenantId", "userId"])
      expect(AssistIntentSchema.safeParse({ ...input, [field]: "Synthetic private value" }).success).toBe(false);
    expect(AssistReceiptQuerySchema.safeParse({ requestId: input.requestId, requestChecksum: hash, runId: createEntityId() }).success).toBe(false);
  });

  it("distinguishes absent receipts from found runs and rejects another request's returned body", () => {
    const input = request(), envelope = { version: "assist-request-receipt-v1", contextAuthority: "synthetic authority",
      requestId: input.requestId, requestChecksum: hash, state: "not_found", run: null };
    expect(AssistReceiptViewSchema.parse(envelope).state).toBe("not_found");
    expect(AssistReceiptViewSchema.safeParse({ ...envelope, state: "found" }).success).toBe(false);
    const run = AssistViewSchema.parse({ id: createEntityId(), kind: input.kind, scope: input.scopeId, status: "queued",
      createdAt: "2026-10-22T00:00:00.000Z", completedAt: null, modelLabel: "Synthetic model", model: "synthetic",
      promptVersion: "synthetic", inputFingerprint: hash, stale: false, maxTaskCostUsd: 1, request: input,
      inputTokens: null, outputTokens: null, costUsd: null, error: null, diagnostics: [], sources: [], checks: [], result: null });
    expect(AssistReceiptViewSchema.parse({ ...envelope, state: "found", run }).run?.id).toBe(run.id);
    expect(AssistReceiptViewSchema.safeParse({ ...envelope, state: "found", run, requestId: randomUUID() }).success).toBe(false);
  });
});
