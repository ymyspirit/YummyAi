import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { syntheticFactoryCapacityProfile } from "../../../../tools/testing/factory-capacity-fixtures.js";
import { addFactoryCapacityLocalDays, FactoryCapacityCalendarError, factoryCapacityLocalDate,
  resolveFactoryCapacityCalendarDay, resolveFactoryCapacityLocalTime } from "./factory-capacity-calendar.js";

const profile = (capacity = 10) => syntheticFactoryCapacityProfile([{ capabilityVersionId: createEntityId(), unitsPerItem: 1 }], capacity);
const day = (localDate: string, timeZone: string, capacity = 10, unit: "each" | "minute" = "each", now = "2026-01-01T00:00:00.000Z") =>
  resolveFactoryCapacityCalendarDay({ profile: profile(capacity), localDate, timeZone, unit, now });

describe("real factory wall-clock calendar resolution", () => {
  it("resolves the actual IANA offset instead of using the host timezone", () => {
    expect(resolveFactoryCapacityLocalTime("America/New_York", "2026-07-15T09:00")).toBe("2026-07-15T13:00:00.000Z");
    expect(resolveFactoryCapacityLocalTime("America/New_York", "2026-01-15T09:00")).toBe("2026-01-15T14:00:00.000Z");
    expect(resolveFactoryCapacityLocalTime("Asia/Shanghai", "2026-07-15T09:00")).toBe("2026-07-15T01:00:00.000Z");
  });
  it.each(["2026-03-08T02:30", "2026-11-01T01:30"])("rejects the nonexistent or repeated New York clock %s without selecting an offset", local => {
    expect(() => resolveFactoryCapacityLocalTime("America/New_York", local)).toThrow(FactoryCapacityCalendarError);
    try { resolveFactoryCapacityLocalTime("America/New_York", local); }
    catch (error) { expect(error).toMatchObject({ code: "factory_capacity_local_time_invalid" }); }
  });
  it("rejects invalid dates, numeric offsets and caller-provided offset strings", () => {
    for (const [zone, local] of [["UTC", "2026-02-30T09:00"], ["+08:00", "2026-10-22T09:00"], ["UTC", "2026-10-22T09:00+08:00"]])
      expect(() => resolveFactoryCapacityLocalTime(zone!, local!)).toThrow(FactoryCapacityCalendarError);
  });
  it("uses the factory-local day across both sides of a UTC midnight", () => {
    const instant = "2026-10-22T01:00:00.000Z";
    expect(factoryCapacityLocalDate("America/Los_Angeles", instant)).toBe("2026-10-21");
    expect(factoryCapacityLocalDate("Asia/Shanghai", instant)).toBe("2026-10-22");
    expect(factoryCapacityLocalDate("Pacific/Kiritimati", "2026-10-21T12:00:00.000Z")).toBe("2026-10-22");
  });
  it("adds local calendar days through DST and leap days without adding fixed 24-hour durations", () => {
    expect(addFactoryCapacityLocalDays("2026-03-07", 2)).toBe("2026-03-09");
    expect(addFactoryCapacityLocalDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addFactoryCapacityLocalDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(() => addFactoryCapacityLocalDays("2099-12-31", 1)).toThrow(FactoryCapacityCalendarError);
    expect(() => addFactoryCapacityLocalDays("2026-10-22", 0.5)).toThrow(FactoryCapacityCalendarError);
  });
  it("measures the spring DST day as exactly 1380 actual working minutes", () => {
    const result = day("2026-03-08", "America/New_York", 1380, "minute");
    expect(result).toMatchObject({ intervals: [{ start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T04:00:00.000Z" }], workingMinutes: 1380, remainingWorkingMinutes: 1380, blockers: [] });
    expect(day("2026-03-08", "America/New_York", 1381, "minute").blockers).toContain("factory_capacity_minutes_exceed_working_time");
  });
  it("measures the fall DST day as exactly 1500 minutes and keeps count capacity independent of duration", () => {
    expect(day("2026-11-01", "America/New_York", 1500, "minute")).toMatchObject({ intervals: [{ start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T05:00:00.000Z" }], workingMinutes: 1500, blockers: [] });
    expect(day("2026-03-08", "America/New_York", 2000, "each").blockers).not.toContain("factory_capacity_minutes_exceed_working_time");
  });
  it("counts a spring interval spanning the missing hour by its real instants", () => {
    const value = profile(60); value.weekly = value.weekly.map(item => ({ ...item, intervals: [{ start: "01:30", end: "03:30" }] }));
    const result = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "America/New_York", localDate: "2026-03-08", unit: "minute", now: "2026-03-01T00:00:00.000Z" });
    expect(result).toMatchObject({ intervals: [{ start: "2026-03-08T06:30:00.000Z", end: "2026-03-08T07:30:00.000Z" }], workingMinutes: 60, blockers: [] });
  });
  it("fails closed when an interval endpoint or cutoff is an ambiguous wall clock", () => {
    for (const value of [
      { ...profile(), weekly: profile().weekly.map(item => ({ ...item, intervals: [{ start: "01:30", end: "03:00" }] })) },
      { ...profile(), cutoffTime: "01:30" },
    ]) {
      const result = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "America/New_York", localDate: "2026-11-01", unit: "each", now: "2026-10-01T00:00:00.000Z" });
      expect(result.intervals).toEqual([]); expect(result.workingMinutes).toBe(0);
      expect(result.blockers).toContain("factory_capacity_calendar_invalid");
    }
  });
  it("uses a closed exception instead of falling back to the regular open weekday", () => {
    const value = { ...profile(), exceptions: [{ localDate: "2026-10-22", intervals: [], capacityUnits: 0 }] };
    const result = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "UTC", localDate: "2026-10-22", unit: "each", now: "2026-10-21T00:00:00.000Z" });
    expect(result).toMatchObject({ capacityUnits: 0, intervals: [], workingMinutes: 0 }); expect(result.blockers).toContain("factory_capacity_day_closed");
  });
  it("preserves explicit zero capacity and unknown capacity as different states", () => {
    const zero = day("2026-10-22", "UTC", 0); expect(zero.capacityUnits).toBe(0); expect(zero.blockers).not.toContain("factory_capacity_amount_unknown");
    const value = { ...profile(), status: "draft" as const, dailyCapacityUnits: null };
    const unknown = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "UTC", localDate: "2026-10-22", unit: "each", now: "2026-10-21T00:00:00.000Z" });
    expect(unknown.capacityUnits).toBeNull(); expect(unknown.blockers).toEqual(expect.arrayContaining(["factory_capacity_amount_unknown", "factory_capacity_pool_inactive"]));
  });
  it("subtracts elapsed time and lunch breaks when calculating today's remaining working minutes", () => {
    const value = profile(420); value.weekly = value.weekly.map(item => ({ ...item, intervals: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:00" }] }));
    const result = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "UTC", localDate: "2026-10-22", unit: "minute", now: "2026-10-22T11:30:00.000Z" });
    expect(result).toMatchObject({ workingMinutes: 420, remainingWorkingMinutes: 270, blockers: [] });
  });
  it("closes today's cutoff at the exact instant but does not prematurely close tomorrow", () => {
    const value = { ...profile(), cutoffTime: "12:00" };
    const result = (date: string, now: string) => resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "Asia/Shanghai", localDate: date, unit: "each", now });
    expect(result("2026-10-22", "2026-10-22T03:59:59.999Z").blockers).not.toContain("factory_capacity_cutoff_passed");
    expect(result("2026-10-22", "2026-10-22T04:00:00.000Z").blockers).toContain("factory_capacity_cutoff_passed");
    expect(result("2026-10-23", "2026-10-22T04:00:00.000Z").blockers).not.toContain("factory_capacity_cutoff_passed");
  });
  it("rejects past factory-local dates and exhausted intervals using the supplied database instant", () => {
    expect(day("2026-10-21", "Pacific/Kiritimati", 10, "each", "2026-10-21T12:00:00.000Z").blockers).toContain("factory_capacity_date_in_past");
    const value = profile(); value.weekly = value.weekly.map(item => ({ ...item, intervals: [{ start: "09:00", end: "10:00" }] }));
    expect(resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "UTC", localDate: "2026-10-22", unit: "each", now: "2026-10-22T10:00:00.000Z" }).blockers).toContain("factory_capacity_working_day_ended");
  });
  it("returns no fabricated work interval for malformed or overlapping actual calendar data", () => {
    const value = profile(); value.weekly = value.weekly.map(item => ({ ...item, intervals: [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "17:00" }] }));
    const result = resolveFactoryCapacityCalendarDay({ profile: value, timeZone: "UTC", localDate: "2026-10-22", unit: "minute", now: "2026-10-21T00:00:00.000Z" });
    expect(result.intervals).toEqual([]); expect(result.remainingWorkingMinutes).toBe(0); expect(result.blockers).toContain("factory_capacity_calendar_invalid");
  });
});
