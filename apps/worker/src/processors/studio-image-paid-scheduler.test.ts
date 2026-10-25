import { describe, expect, it } from "vitest";
import { StudioPaidImageScheduler, type StudioPaidImageDispatcher } from "./studio-image-paid-scheduler.js";

describe("Studio paid image scheduler closed operator gate", () => {
  it("does not access the database, enqueue or purge any old/new owner while disabled", async () => {
    let closes = 0;
    const database = { get db(): never { throw new Error("Unexpected database access"); } };
    const dispatcher: StudioPaidImageDispatcher = {
      async enqueue() { throw new Error("Unexpected paid queue dispatch"); },
      async close() { closes++; },
    };
    const env = { STUDIO_PAID_IMAGE_ENABLED: "0", STUDIO_PAID_IMAGE_TENANT_IDS: "019a1030-0000-7000-8000-000000000001" };
    const scheduler = new StudioPaidImageScheduler(database, dispatcher, () => env);
    try {
      expect(await scheduler.dispatch()).toEqual({ queued: 0, failed: 0, skipped: 0 });
      env.STUDIO_PAID_IMAGE_TENANT_IDS = "*"; env.STUDIO_PAID_IMAGE_ENABLED = "1";
      expect(await scheduler.dispatch()).toEqual({ queued: 0, failed: 0, skipped: 0 });
    } finally { await scheduler.close(); }
    expect(closes).toBe(1);
  });
});
