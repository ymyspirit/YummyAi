import { describe, expect, it, vi } from "vitest";
import { retryDatabaseTimeRollback } from "./database-time-retry.js";

const violation = () => new Error("Private SQL must not reach the conflict response", { cause: {
  code: "23514", constraint_name: "incoming_commands_time",
} });

describe("confirmed database time rollback recovery", () => {
  it("retries the complete callback after a known rollback and returns its actual result", async () => {
    const result = { id: "actual-result" };
    const transaction = vi.fn().mockRejectedValueOnce(violation()).mockResolvedValueOnce(result);
    expect(await retryDatabaseTimeRollback(transaction, "incoming_commands_time")).toBe(result);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("propagates authorization lost on the next fresh attempt", async () => {
    const denied = Object.assign(new Error("Current grant revoked"), { status: 403 });
    const transaction = vi.fn().mockRejectedValueOnce(violation()).mockRejectedValueOnce(denied);
    await expect(retryDatabaseTimeRollback(transaction, "incoming_commands_time")).rejects.toBe(denied);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: "23514", constraint_name: "unrelated_business_quality_check" },
    { code: "CONNECTION_CLOSED" },
    { code: "40001" },
  ])("does not retry unrelated or uncertain outcomes $code", async error => {
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(retryDatabaseTimeRollback(transaction, "incoming_commands_time")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("ends persistent time failure with a sanitized conflict even if the process clock is frozen", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const transaction = vi.fn().mockRejectedValue(violation());
    try {
      await expect(retryDatabaseTimeRollback(transaction, "incoming_commands_time")).rejects.toMatchObject({
        status: 409, response: { code: "database_clock_not_ready" },
      });
      expect(transaction.mock.calls.length).toBeGreaterThan(1);
    } finally { clock.mockRestore(); }
  });

  it("does not loop through a cyclic unrelated cause", async () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(retryDatabaseTimeRollback(transaction, "incoming_commands_time")).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
