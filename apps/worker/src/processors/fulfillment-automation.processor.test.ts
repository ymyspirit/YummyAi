import { createEntityId } from "@yummyai/contracts";
import type { JobEnvelope } from "@yummyai/jobs";
import { describe, expect, it, vi } from "vitest";

import { FulfillmentAutomationProcessor, type FulfillmentAutomationExecutionRepository, type FulfillmentAutomationRunner } from "./fulfillment-automation.processor.js";

const id = () => createEntityId();
const envelope = (taskId: string): JobEnvelope => ({ jobId: id(), tenantId: id(), requestedBy: id(), traceId: "1".repeat(32), correlationId: taskId, idempotencyKey: taskId, attempt: 0, maxAttempts: 3, requestedAt: new Date().toISOString(), payload: { taskId } });
const snapshot = (taskId: string) => ({ taskId, type: "attention_scan", projectionVersion: 2, attemptCount: 1, maxAttempts: 3, requestedBy: id() });

describe("FulfillmentAutomationProcessor", () => {
  it("completes a claimed identifier-only task", async () => {
    const taskId = id(); const claimed = snapshot(taskId);
    const repository = { claim: vi.fn().mockResolvedValue(claimed), complete: vi.fn(), fail: vi.fn() } as unknown as FulfillmentAutomationExecutionRepository;
    const runner = { run: vi.fn().mockResolvedValue({ status: "completed", code: "OK", summary: "production=0" }) } as FulfillmentAutomationRunner;
    await expect(new FulfillmentAutomationProcessor(repository, runner).process(envelope(taskId))).resolves.toMatchObject({ status: "completed" });
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), claimed, expect.objectContaining({ code: "OK" }));
  });
  it("throws for a retryable failure so BullMQ applies backoff", async () => {
    const taskId = id();
    const repository = { claim: vi.fn().mockResolvedValue(snapshot(taskId)), complete: vi.fn(), fail: vi.fn().mockResolvedValue({ retry: true }) } as unknown as FulfillmentAutomationExecutionRepository;
    const runner = { run: vi.fn().mockRejectedValue(new Error("provider unavailable")) } as FulfillmentAutomationRunner;
    await expect(new FulfillmentAutomationProcessor(repository, runner).process(envelope(taskId))).rejects.toThrow("retry scheduled");
  });
  it("returns dead-letter after the persisted retry budget is exhausted", async () => {
    const taskId = id();
    const repository = { claim: vi.fn().mockResolvedValue(snapshot(taskId)), complete: vi.fn(), fail: vi.fn().mockResolvedValue({ retry: false }) } as unknown as FulfillmentAutomationExecutionRepository;
    const runner = { run: vi.fn().mockRejectedValue(new Error("failed")) } as FulfillmentAutomationRunner;
    await expect(new FulfillmentAutomationProcessor(repository, runner).process(envelope(taskId))).resolves.toMatchObject({ status: "dead_letter" });
  });
});
