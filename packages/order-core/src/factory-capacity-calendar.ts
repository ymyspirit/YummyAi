import { Temporal } from "@js-temporal/polyfill";
import type { FactoryCapacityPoolProfile } from "@yummyai/contracts/suppliers/factory-capacity";

export class FactoryCapacityCalendarError extends Error {
  constructor(readonly code: "factory_capacity_local_time_invalid" | "factory_capacity_calendar_invalid") {
    super(code);
    this.name = "FactoryCapacityCalendarError";
  }
}

export interface FactoryCapacityCalendarDay {
  intervals: Array<{ start: string; end: string }>;
  cutoffAt: string | null;
  capacityUnits: number | null;
  workingMinutes: number;
  remainingWorkingMinutes: number;
  blockers: string[];
}

const minuteNanoseconds = 60_000_000_000n;

function localDate(value: string) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Invalid factory local date");
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

function localInstant(timeZone: string, date: string, clock: string) {
  const day = localDate(date);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) throw new RangeError("Invalid factory local time");
  const [hour, minute] = clock.split(":").map(Number);
  if (/^[+-]/.test(timeZone)) throw new RangeError("Factory time zone must be an IANA identifier");
  return Temporal.ZonedDateTime.from({
    timeZone, year: day.year, month: day.month, day: day.day, hour, minute,
  }, { overflow: "reject", disambiguation: "reject", offset: "reject" }).toInstant();
}

export function resolveFactoryCapacityLocalTime(timeZone: string, localDateTime: string): string {
  try {
    if (!/^20\d{2}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(localDateTime)) throw new RangeError("Invalid factory local time");
    return localInstant(timeZone, localDateTime.slice(0, 10), localDateTime.slice(11)).toString({ smallestUnit: "millisecond" });
  } catch {
    throw new FactoryCapacityCalendarError("factory_capacity_local_time_invalid");
  }
}

export function factoryCapacityLocalDate(timeZone: string, instant: string): string {
  try {
    if (/^[+-]/.test(timeZone)) throw new RangeError("Factory time zone must be an IANA identifier");
    return Temporal.Instant.from(instant).toZonedDateTimeISO(timeZone).toPlainDate().toString();
  } catch {
    throw new FactoryCapacityCalendarError("factory_capacity_calendar_invalid");
  }
}

export function addFactoryCapacityLocalDays(date: string, days: number): string {
  try {
    if (!Number.isSafeInteger(days)) throw new RangeError("Invalid number of local days");
    const result = localDate(date).add({ days }).toString();
    localDate(result);
    return result;
  } catch {
    throw new FactoryCapacityCalendarError("factory_capacity_calendar_invalid");
  }
}

/** Resolve each wall-clock endpoint; a local day is never assumed to be 24 hours. */
export function resolveFactoryCapacityCalendarDay(input: {
  profile: FactoryCapacityPoolProfile;
  timeZone: string;
  unit: "each" | "minute";
  localDate: string;
  now: string;
}): FactoryCapacityCalendarDay {
  const result: FactoryCapacityCalendarDay = {
    intervals: [], cutoffAt: null, capacityUnits: input.profile.dailyCapacityUnits,
    workingMinutes: 0, remainingWorkingMinutes: 0, blockers: [],
  };
  try {
    const date = localDate(input.localDate), now = Temporal.Instant.from(input.now);
    const today = factoryCapacityLocalDate(input.timeZone, input.now);
    const exception = input.profile.exceptions.find(day => day.localDate === input.localDate);
    const intervals = exception?.intervals ?? input.profile.weekly.find(day => day.weekday === date.dayOfWeek)?.intervals;
    if (!intervals) throw new RangeError("Missing factory weekday");
    if (exception) result.capacityUnits = exception.capacityUnits;
    let duration = 0n, remaining = 0n;
    for (const interval of [...intervals].sort((left, right) => left.start.localeCompare(right.start))) {
      const start = localInstant(input.timeZone, input.localDate, interval.start);
      const end = interval.end === "24:00"
        ? localInstant(input.timeZone, addFactoryCapacityLocalDays(input.localDate, 1), "00:00")
        : localInstant(input.timeZone, input.localDate, interval.end);
      if (Temporal.Instant.compare(start, end) >= 0) throw new RangeError("Invalid factory working interval");
      const previous = result.intervals.at(-1);
      if (previous && Temporal.Instant.compare(Temporal.Instant.from(previous.end), start) > 0) throw new RangeError("Overlapping factory working intervals");
      result.intervals.push({ start: start.toString({ smallestUnit: "millisecond" }), end: end.toString({ smallestUnit: "millisecond" }) });
      duration += end.epochNanoseconds - start.epochNanoseconds;
      const remainingStart = Temporal.Instant.compare(now, start) > 0 ? now : start;
      if (Temporal.Instant.compare(remainingStart, end) < 0) remaining += end.epochNanoseconds - remainingStart.epochNanoseconds;
    }
    result.workingMinutes = Number(duration / minuteNanoseconds);
    result.remainingWorkingMinutes = Number(remaining / minuteNanoseconds);
    if (input.profile.cutoffTime) {
      const cutoff = localInstant(input.timeZone, input.localDate, input.profile.cutoffTime);
      result.cutoffAt = cutoff.toString({ smallestUnit: "millisecond" });
      if (input.localDate === today && Temporal.Instant.compare(now, cutoff) >= 0) result.blockers.push("factory_capacity_cutoff_passed");
    }
    if (input.localDate < today) result.blockers.push("factory_capacity_date_in_past");
    if (!result.intervals.length) result.blockers.push("factory_capacity_day_closed");
    if (input.localDate === today && result.remainingWorkingMinutes === 0) result.blockers.push("factory_capacity_working_day_ended");
    if (input.profile.status !== "active") result.blockers.push("factory_capacity_pool_inactive");
    if (result.capacityUnits === null) result.blockers.push("factory_capacity_amount_unknown");
    if (input.unit === "minute" && result.capacityUnits !== null && result.capacityUnits > result.workingMinutes)
      result.blockers.push("factory_capacity_minutes_exceed_working_time");
    return result;
  } catch {
    return { ...result, intervals: [], cutoffAt: null, workingMinutes: 0, remainingWorkingMinutes: 0,
      blockers: [...new Set([...result.blockers, "factory_capacity_calendar_invalid"])] };
  }
}
