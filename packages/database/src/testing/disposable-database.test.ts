import { describe, expect, it } from "vitest";
import { isolatedDatabaseForTests } from "./disposable-database.js";

describe("database integration isolation before connection", () => {
  const disposable = "postgresql://fixture@127.0.0.1/order_daily_e2e_" + "a".repeat(32);
  it.each([
    {},
    { DATABASE_URL: disposable },
    { E2E_ISOLATED_DAILY: "1" },
    { E2E_ISOLATED_DAILY: "1", DATABASE_URL: "postgresql://fixture@127.0.0.1/yummyai" },
    { E2E_ISOLATED_DAILY: "1", DATABASE_URL: "postgresql://fixture@127.0.0.1/order_daily_e2e_invalid" },
    { E2E_ISOLATED_DAILY: "1", DATABASE_URL: "file:///order_daily_e2e_" + "a".repeat(32) },
    { E2E_ISOLATED_DAILY: "1", DATABASE_URL: "invalid" },
  ])("rejects missing runner evidence and ordinary database URLs", environment => {
    expect(() => isolatedDatabaseForTests(environment)).toThrow();
  });
  it("returns only the explicitly supplied disposable connection", () => {
    expect(isolatedDatabaseForTests({ E2E_ISOLATED_DAILY: "1", DATABASE_URL: disposable })).toBe(disposable);
  });
});
