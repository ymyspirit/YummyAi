import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { measuredQuantityExceedsPlan, RecordProductionMaterialSchema } from "./material-execution.js";

describe("measured production material commands", () => {
  const base = { bindingId: createEntityId(), contextAuthority: "synthetic-member-authority", materialCode: "FABRIC", expectedProductionRevision: 1,
    idempotencyKey: "synthetic-material-command", occurredAt: "2026-10-20T00:00:00.000Z" };
  it("requires an actual confirmation and canonical exact decimal input", () => {
    const value = { ...base, kind: "consume", quantity: "00.350000000", locationId: createEntityId(), lotId: null, reservationEntryId: null, actualConfirmed: true };
    expect(RecordProductionMaterialSchema.parse(value)).toMatchObject({ quantity: "0.35", reason: null });
    expect(RecordProductionMaterialSchema.safeParse({ ...value, actualConfirmed: false }).success).toBe(false);
    expect(RecordProductionMaterialSchema.safeParse({ ...value, quantity: 0.35 }).success).toBe(false);
    expect(RecordProductionMaterialSchema.safeParse({ ...value, stockItemId: createEntityId() }).success).toBe(false);
  });
  it("compares actuals to thirds, losses and tiny remainders without rounding the plan", () => {
    expect(measuredQuantityExceedsPlan("0.333333333", "1", "3")).toBe(false);
    expect(measuredQuantityExceedsPlan("0.333333334", "1", "3")).toBe(true);
    expect(measuredQuantityExceedsPlan("1.05", "21", "20")).toBe(false);
    expect(measuredQuantityExceedsPlan("1.050000001", "21", "20")).toBe(true);
    expect(() => measuredQuantityExceedsPlan(1, "1", "0")).toThrow();
  });
  it("requires an explicit factory report source and refuses a location on a factory report", () => {
    const value = { ...base, kind: "factory_report", quantity: "0.2", reportReference: "Factory daily sheet 001", actualConfirmed: true };
    expect(RecordProductionMaterialSchema.safeParse(value).success).toBe(true);
    expect(RecordProductionMaterialSchema.safeParse({ ...value, reportReference: "" }).success).toBe(false);
    expect(RecordProductionMaterialSchema.safeParse({ ...value, locationId: createEntityId() }).success).toBe(false);
  });
  it("derives a release quantity from the original reservation instead of accepting caller totals", () => {
    const value = { ...base, kind: "release", originalEntryId: createEntityId() };
    expect(RecordProductionMaterialSchema.safeParse(value).success).toBe(true);
    expect(RecordProductionMaterialSchema.safeParse({ ...value, quantity: 10 }).success).toBe(false);
  });
});
