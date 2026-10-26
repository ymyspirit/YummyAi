import { describe, expect, it } from "vitest";
import { resolveOrderShippingTime, type OrderShippingTimeInput } from "./order-shipping-time.js";

const NOW = "2026-10-26T12:00:00.000Z";
const VERSION = "019f7600-0000-7000-8000-000000000009";
const input = (patch: Partial<OrderShippingTimeInput> = {}): OrderShippingTimeInput => ({
  now: new Date(NOW), placedAt: "2026-10-20T12:00:00.000Z",
  platformShipByAt: null, platformDeadlineVerifiedAt: null, dueAt: null,
  remainingQuantity: 2, closed: false, ...patch,
});

describe("platform shipping time projection", () => {
  it("keeps an unknown platform deadline explicit and does not infer a 48-hour target", () => {
    expect(resolveOrderShippingTime(input())).toMatchObject({
      computedAt: NOW, platform: { at: null, source: "missing", sourceVersionId: null, verifiedAt: null },
      internal: { at: null, source: "missing", confidence: "unknown" },
      nextAttentionAt: null, countdownBasis: null, remainingSeconds: null,
      platformOverdue: false, active: true, missingReasons: ["platform_deadline_missing"],
    });
  });

  it("retains a manual internal date without using it for platform countdown", () => {
    const result = resolveOrderShippingTime(input({ dueAt: "2026-10-25T00:00:00.000Z" }));
    expect(result.internal).toEqual({ at: "2026-10-25T00:00:00.000Z", source: "operator", confidence: "explicit", evidenceReference: null });
    expect(result.internalOverdue).toBe(true);
    expect(result.nextAttentionAt).toBeNull(); expect(result.remainingSeconds).toBeNull();
    expect(result.platformOverdue).toBe(false); expect(result.countdownBasis).toBeNull();
  });

  it("uses the platform date even when an optional internal date is earlier", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: "2026-10-27T12:00:00.000Z", dueAt: "2026-10-26T13:00:00.000Z" }));
    expect(result.nextAttentionAt).toBe("2026-10-27T12:00:00.000Z");
    expect(result.remainingSeconds).toBe(86400); expect(result.countdownBasis).toBe("platform");
    expect(result.missingReasons).toEqual([]);
  });

  it("reports a platform breach independently of a later manual date", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: "2026-10-26T11:00:00.000Z", dueAt: "2026-10-30T00:00:00.000Z" }));
    expect(result.platformOverdue).toBe(true); expect(result.remainingSeconds).toBe(-3600);
    expect(result.internalOverdue).toBe(false);
  });

  it("distinguishes the exact deadline from a millisecond after it", () => {
    const at = resolveOrderShippingTime(input({ platformShipByAt: NOW }));
    expect(at.remainingSeconds).toBe(0); expect(at.platformOverdue).toBe(false);
    const late = resolveOrderShippingTime(input({ now: new Date("2026-10-26T12:00:00.001Z"), platformShipByAt: NOW }));
    expect(late.remainingSeconds).toBe(-1); expect(late.platformOverdue).toBe(true);
  });

  it.each([{ closed: true }, { remainingQuantity: 0 }])("stops reminders for closed or fully shipped work: %j", patch => {
    const result = resolveOrderShippingTime(input({ ...patch, platformShipByAt: "2026-10-25T00:00:00.000Z", dueAt: "2026-10-24T00:00:00.000Z" }));
    expect(result.active).toBe(false); expect(result.platform.at).not.toBeNull();
    expect(result.nextAttentionAt).toBeNull(); expect(result.countdownBasis).toBeNull(); expect(result.remainingSeconds).toBeNull();
    expect(result.platformOverdue).toBe(false); expect(result.internalOverdue).toBe(false); expect(result.missingReasons).toEqual([]);
  });

  it("preserves a recorded human verification without creating a new one", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: "2026-10-27T20:00:00+08:00", platformDeadlineVerifiedAt: "2026-10-26T10:00:00.000Z" }));
    expect(result.platform).toEqual({ at: "2026-10-27T12:00:00.000Z", source: "verified_record", sourceVersionId: null, verifiedAt: "2026-10-26T10:00:00.000Z" });
    expect(resolveOrderShippingTime(input({ platformShipByAt: NOW })).platform.verifiedAt).toBeNull();
  });

  it("retains an explicit manual clear without a countdown or an old API fallback", () => {
    const result = resolveOrderShippingTime(input({ platformSource: "verified_record", platformDeadlineVerifiedAt: "2026-10-26T10:00:00.000Z" }));
    expect(result.platform).toEqual({ at: null, source: "verified_record", sourceVersionId: null, verifiedAt: "2026-10-26T10:00:00.000Z" });
    expect(result.countdownBasis).toBeNull(); expect(result.remainingSeconds).toBeNull();
    expect(result.missingReasons).toEqual(["platform_deadline_missing"]);
    expect(resolveOrderShippingTime(input({ platformSource: "verified_record", platformDeadlineVerifiedAt: "invalid" })).platform)
      .toEqual({ at: null, source: "missing", sourceVersionId: null, verifiedAt: null });
  });

  it("labels API evidence with its exact immutable source and no human verification", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: NOW, platformSource: "marketplace_api", platformSourceVersionId: VERSION, platformDeadlineVerifiedAt: "2026-10-26T10:00:00.000Z" }));
    expect(result.platform).toEqual({ at: NOW, source: "marketplace_api", sourceVersionId: VERSION, verifiedAt: null });
    expect(resolveOrderShippingTime(input({ platformShipByAt: NOW, platformSource: "marketplace_api" })).platform.source).toBe("missing");
  });

  it("labels report evidence with its source version and requires the same immutable pin", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: NOW, platformSource: "report_import", platformSourceVersionId: VERSION,
      platformDeadlineVerifiedAt: "2026-10-26T10:00:00.000Z" }));
    expect(result.platform).toEqual({ at: NOW, source: "report_import", sourceVersionId: VERSION, verifiedAt: null });
    expect(resolveOrderShippingTime(input({ platformShipByAt: NOW, platformSource: "report_import" })).platform.source).toBe("missing");
  });

  it("does not let an explicit missing source revive a stale deadline", () => {
    const result = resolveOrderShippingTime(input({ platformShipByAt: NOW, platformSource: "missing", platformSourceVersionId: VERSION }));
    expect(result.platform).toEqual({ at: null, source: "missing", sourceVersionId: null, verifiedAt: null });
    expect(result.nextAttentionAt).toBeNull();
  });

  it("rejects invalid clocks and quantities while treating malformed optional dates as unavailable", () => {
    expect(() => resolveOrderShippingTime(input({ now: new Date("invalid") }))).toThrow(RangeError);
    expect(() => resolveOrderShippingTime(input({ remainingQuantity: -1 }))).toThrow(RangeError);
    const result = resolveOrderShippingTime(input({ platformShipByAt: "not-a-time", dueAt: "not-a-time" }));
    expect(result.platform.source).toBe("missing"); expect(result.missingReasons).toEqual(["platform_deadline_invalid"]);
    expect(result.internal.at).toBeNull();
  });
});
