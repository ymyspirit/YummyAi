import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { normalizeModelTokenUsage } from "@yummyai/ai-core";
import type { podArtworkInvocations } from "@yummyai/database";
import { podInvocationViews } from "./invocation.js";

describe("durable POD usage projection", () => {
  const now = new Date();
  const task = { id: createEntityId(), status: "failed" as const, attemptCount: 1, startedAt: now, completedAt: now };
  const usage = normalizeModelTokenUsage({ input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 20, image_tokens: 80 } })!;
  const row = { id: createEntityId(), tenantId: createEntityId(), taskId: task.id, attemptNumber: 1, phase: "failed", startedAt: now, submittedAt: now,
    receivedAt: now, finishedAt: now, responseChecksum: "a".repeat(64), providerRequestId: "synthetic-request", modelKey: "synthetic", modelVersion: "v1",
    reportedCostUsd: null, metadataValid: true, resultVersionId: null, tokenUsage: usage } satisfies typeof podArtworkInvocations.$inferSelect;
  it("shows the original reported usage even when output processing failed", () => {
    const [view] = podInvocationViews(task, [row]);
    expect(view).toMatchObject({ state: "failed", boundary: "received", usage: { inputTokens: 100, outputTokens: 30 }, tokenUsage: usage });
    expect(view?.billing.amountUsd).toBeNull();
  });
  it("keeps historical or absent provider usage unknown instead of zero", () => {
    expect(podInvocationViews(task, [{ ...row, tokenUsage: null }])[0]).toMatchObject({ usage: { inputTokens: null, outputTokens: null }, tokenUsage: null });
    expect(podInvocationViews(task, [])[0]?.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});
