import { describe, expect, it } from "vitest";

import { ReconcileFulfillmentAutomationInputSchema, ScheduleFulfillmentAutomationInputSchema } from "./fulfillment-automation.js";

describe("fulfillment automation contracts", () => {
  it("accepts bounded identifier-only scheduling input", () => {
    expect(ScheduleFulfillmentAutomationInputSchema.parse({ type: "attention_scan", runAt: "2026-07-22T12:00:00.000Z", maxAttempts: 3, idempotencyKey: "attention-scan-0001" })).toMatchObject({ maxAttempts: 3 });
  });

  it("requires a new time only when manually rescheduling", () => {
    expect(() => ReconcileFulfillmentAutomationInputSchema.parse({ outcome: "rescheduled", expectedProjectionVersion: 2, reason: "Retry after operator review", runAt: null, idempotencyKey: "reconcile-task-0001" })).toThrow();
  });
});
