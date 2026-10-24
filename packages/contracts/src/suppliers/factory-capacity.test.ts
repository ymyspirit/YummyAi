import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { erpSessionAuthority } from "../auth/session.js";
import {
  CreateFactoryCapacityPoolSchema, FactoryCapacityDaySchema, FactoryCapacityHistorySchema, FactoryCapacityPoolProfileSchema,
  FactoryCapacityPreviewInputSchema, FactoryCapacityQuerySchema, FactoryCapacityReservationViewSchema,
  FactoryCapacityWorkspaceSchema, FactoryLocalDateSchema, FactoryTimeZoneSchema, FactoryWorkingIntervalSchema,
  ProductionCapacityPlanSchema, ProductionCapacityViewSchema, ResolveFactoryLocalTimeInputSchema,
  ReviseFactoryCapacityPoolSchema,
} from "./factory-capacity.js";
import { syntheticFactoryCapacityProfile } from "../../../../tools/testing/factory-capacity-fixtures.js";

const factoryId = createEntityId(), factoryVersionId = createEntityId(), capabilityVersionId = createEntityId();
const poolId = createEntityId(), poolVersionId = createEntityId(), productionOrderId = createEntityId(), productionVersionId = createEntityId();
const at = "2026-10-22T00:00:00.000Z", end = "2026-10-23T00:00:00.000Z", localDate = "2026-10-22";
const authority = (read: "self" | "tenant" = "tenant", write: "self" | "tenant" = "tenant") => erpSessionAuthority({
  tenantId: createEntityId(), userId: createEntityId(), permissions: ["order:read", "order:write"], dataScope: "tenant",
  permissionScopes: { "order:read": read, "order:write": write },
});
const scope = () => ({ contextAuthority: authority(), access: { canRead: true, canWrite: true } });
const profile = () => syntheticFactoryCapacityProfile([{ capabilityVersionId, unitsPerItem: 1 }], 10);
const selection = () => ({ poolId, poolVersionId, localDate });
const pool = () => ({ id: poolId, factoryId, factoryVersionId, code: "SYNTHETIC-POOL", timeZone: "UTC", unit: "each" as const,
  versionId: poolVersionId, versionNumber: 1, profile: profile(), createdAt: at });
const reservation = () => ({ id: createEntityId(), factoryId, poolId, poolVersionId, productionOrderId, productionVersionId, capabilityVersionId,
  localDate, timeZone: "UTC", unit: "each" as const, quantity: 6, unitsPerItem: 1, totalUnits: 6, committedUnits: 0, releasedUnits: 0,
  workStartsAt: at, workEndsAt: end, createdAt: at });
const workspace = () => ({ ...scope(), factoryId, from: localDate, days: 1, recordedAt: at, pools: [pool()], calendar: [] });
const previewItem = () => ({ reference: "SYNTHETIC-LINE-1", factoryVersionId, capabilityVersionId, quantity: 6, expectedCompletionAt: end,
  capacityPlan: { allocations: [selection()] } });

describe("factory capacity calendar and immutable reservation contract", () => {
  it("requires explicit finite confirmed capacity and rates instead of copying a factory daily reference", () => {
    expect(FactoryCapacityPoolProfileSchema.parse(profile())).toMatchObject({ dailyCapacityUnits: 10, bindings: [{ capabilityVersionId, unitsPerItem: 1 }] });
    for (const patch of [{ dailyCapacityUnits: null }, { bindings: [] }, { evidenceReference: "" }])
      expect(FactoryCapacityPoolProfileSchema.safeParse({ ...profile(), ...patch }).success).toBe(false);
  });
  it("preserves an unknown draft and permits an explicitly confirmed zero-capacity active pool", () => {
    expect(FactoryCapacityPoolProfileSchema.parse({ ...profile(), status: "draft", dailyCapacityUnits: null, bindings: [], evidenceReference: "" }).dailyCapacityUnits).toBeNull();
    expect(FactoryCapacityPoolProfileSchema.parse({ ...profile(), dailyCapacityUnits: 0 }).dailyCapacityUnits).toBe(0);
  });
  it.each(["2026-02-30", "1999-12-31", "2100-01-01", "2026-10-22T00:00:00Z"])("rejects an invalid or out-of-range local date %s", value => {
    expect(FactoryLocalDateSchema.safeParse(value).success).toBe(false);
  });
  it("accepts real IANA zones and rejects a numeric UTC offset or an invented zone", () => {
    for (const value of ["UTC", "Asia/Shanghai", "America/New_York"]) expect(FactoryTimeZoneSchema.parse(value)).toBe(value);
    for (const value of ["", "+08:00", "-04:00", "Synthetic/Factory"]) expect(FactoryTimeZoneSchema.safeParse(value).success).toBe(false);
  });
  it("accepts adjacent intervals and an end at 24:00 without inventing a cross-day interval", () => {
    const value = profile(); value.weekly[0]!.intervals = [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "24:00" }];
    expect(FactoryCapacityPoolProfileSchema.parse(value).weekly[0]!.intervals).toHaveLength(2);
    for (const interval of [{ start: "22:00", end: "02:00" }, { start: "24:00", end: "24:00" }, { start: "08:00", end: "08:00" }])
      expect(FactoryWorkingIntervalSchema.safeParse(interval).success).toBe(false);
  });
  it("rejects overlapping working intervals even when input order changes", () => {
    const value = profile(); value.weekly[0]!.intervals = [{ start: "12:00", end: "17:00" }, { start: "09:00", end: "13:00" }];
    expect(FactoryCapacityPoolProfileSchema.safeParse(value).success).toBe(false);
  });
  it("requires all seven distinct weekdays rather than treating a missing day as open", () => {
    const value = profile(); value.weekly[6]!.weekday = 1;
    expect(FactoryCapacityPoolProfileSchema.safeParse(value).success).toBe(false);
    expect(FactoryCapacityPoolProfileSchema.safeParse({ ...profile(), weekly: profile().weekly.slice(0, 6) }).success).toBe(false);
  });
  it("retains explicit closed exceptions and rejects nonzero capacity on a closed date", () => {
    const value = { ...profile(), exceptions: [{ localDate, intervals: [], capacityUnits: 0 }] };
    expect(FactoryCapacityPoolProfileSchema.parse(value).exceptions[0]!.capacityUnits).toBe(0);
    expect(FactoryCapacityPoolProfileSchema.safeParse({ ...value, exceptions: [{ localDate, intervals: [], capacityUnits: 1 }] }).success).toBe(false);
    expect(FactoryCapacityPoolProfileSchema.safeParse({ ...value, exceptions: [...value.exceptions, ...value.exceptions] }).success).toBe(false);
  });
  it("allows multiple capabilities to share one finite pool but rejects duplicate bindings and fractional rates", () => {
    const value = profile(); value.bindings.push({ capabilityVersionId: createEntityId(), unitsPerItem: 2 });
    expect(FactoryCapacityPoolProfileSchema.parse(value).bindings).toHaveLength(2);
    expect(FactoryCapacityPoolProfileSchema.safeParse({ ...profile(), bindings: [...profile().bindings, ...profile().bindings] }).success).toBe(false);
    for (const unitsPerItem of [0, -1, 0.5, 1_000_001]) expect(FactoryCapacityPoolProfileSchema.safeParse({ ...profile(), bindings: [{ capabilityVersionId, unitsPerItem }] }).success).toBe(false);
  });
  it("fixes root identity on create and does not accept code, timezone or unit reassignment on revision", () => {
    const value = { factoryVersionId, code: "SYNTHETIC-POOL", timeZone: "UTC", unit: "each", profile: profile(), idempotencyKey: "11111111-1111-4111-8111-111111111111" };
    expect(CreateFactoryCapacityPoolSchema.parse(value)).toEqual(value);
    for (const patch of [{ code: "OTHER" }, { timeZone: "Asia/Shanghai" }, { unit: "minute" }, { factoryVersionId: createEntityId() }])
      expect(ReviseFactoryCapacityPoolSchema.safeParse({ expectedVersion: 1, profile: profile(), idempotencyKey: value.idempotencyKey, ...patch }).success).toBe(false);
  });
  it("requires each selected pool once while allowing two genuinely different required resources", () => {
    expect(ProductionCapacityPlanSchema.parse({ allocations: [selection(), { ...selection(), poolId: createEntityId(), poolVersionId: createEntityId() }] }).allocations).toHaveLength(2);
    expect(ProductionCapacityPlanSchema.safeParse({ allocations: [selection(), { ...selection(), localDate: "2026-10-23" }] }).success).toBe(false);
    expect(ProductionCapacityPlanSchema.safeParse({ allocations: [] }).success).toBe(false);
  });
  it("does not accept caller-supplied units, reservation receipts or claimed balance in the production plan", () => {
    for (const patch of [{ totalUnits: 1 }, { unitsPerItem: 1 }, { reservationId: createEntityId() }, { availableUnits: 10 }])
      expect(ProductionCapacityPlanSchema.safeParse({ allocations: [{ ...selection(), ...patch }] }).success).toBe(false);
  });
  it("keeps batch preview references unique and rejects caller-selected tenants or fractional finished quantities", () => {
    const value = { items: [previewItem()] }; expect(FactoryCapacityPreviewInputSchema.parse(value)).toEqual(value);
    expect(FactoryCapacityPreviewInputSchema.safeParse({ items: [previewItem(), previewItem()] }).success).toBe(false);
    expect(FactoryCapacityPreviewInputSchema.safeParse({ items: [{ ...previewItem(), quantity: 0.5 }] }).success).toBe(false);
    expect(FactoryCapacityPreviewInputSchema.safeParse({ ...value, tenantId: createEntityId() }).success).toBe(false);
  });
  it("bounds page inputs and rejects unknown query fields without assuming a factory-local date", () => {
    expect(FactoryCapacityQuerySchema.parse({})).toEqual({ days: 14 });
    expect(FactoryCapacityQuerySchema.parse({ from: localDate, days: "31", capabilityVersionId })).toEqual({ from: localDate, days: 31, capabilityVersionId });
    for (const value of [{ days: 0 }, { days: 32 }, { tenantId: createEntityId() }, { from: "2026-10-22T00:00Z" }]) expect(FactoryCapacityQuerySchema.safeParse(value).success).toBe(false);
  });
  it("requires an explicit pinned factory version when resolving a local wall clock", () => {
    expect(ResolveFactoryLocalTimeInputSchema.parse({ factoryVersionId, localDateTime: "2026-11-01T01:30" }).factoryVersionId).toBe(factoryVersionId);
    expect(ResolveFactoryLocalTimeInputSchema.safeParse({ localDateTime: "2026-11-01T01:30" }).success).toBe(false);
    expect(ResolveFactoryLocalTimeInputSchema.safeParse({ factoryVersionId, localDateTime: "2026-11-01T01:30Z", disambiguation: "earlier" }).success).toBe(false);
  });
  it("retains an exact immutable reservation and never allows commit plus release to exceed its original units", () => {
    const value = reservation(); expect(FactoryCapacityReservationViewSchema.parse(value)).toEqual(value);
    expect(FactoryCapacityReservationViewSchema.safeParse({ ...reservation(), committedUnits: 4, releasedUnits: 3 }).success).toBe(false);
  });
  it("rejects a false server total that is not the actual integer quantity times saved rate", () => {
    expect(FactoryCapacityReservationViewSchema.safeParse({ ...reservation(), quantity: 6, unitsPerItem: 2, totalUnits: 6 }).success).toBe(false);
  });
  it("does not call an empty or wrong-parent result reserved, or invent reservations for legacy production", () => {
    const value = { ...scope(), productionOrderId, status: "reserved", reservations: [reservation()] };
    expect(ProductionCapacityViewSchema.parse(value)).toEqual(value);
    expect(ProductionCapacityViewSchema.safeParse({ ...value, reservations: [] }).success).toBe(false);
    expect(ProductionCapacityViewSchema.safeParse({ ...value, status: "legacy_unreserved" }).success).toBe(false);
    expect(ProductionCapacityViewSchema.safeParse({ ...value, reservations: [{ ...reservation(), productionOrderId: createEntityId() }] }).success).toBe(false);
    expect(ProductionCapacityViewSchema.parse({ ...value, status: "legacy_unreserved", reservations: [] }).reservations).toEqual([]);
  });
  it("binds history to the actual pool and factory and rejects conflicting immutable version identities", () => {
    const value = { ...scope(), factoryId, poolId, versions: [pool()] }; expect(FactoryCapacityHistorySchema.parse(value)).toEqual(value);
    for (const patch of [{ id: createEntityId() }, { factoryId: createEntityId() }])
      expect(FactoryCapacityHistorySchema.safeParse({ ...value, versions: [{ ...pool(), ...patch }] }).success).toBe(false);
    expect(FactoryCapacityHistorySchema.safeParse({ ...value, versions: [pool(), pool()] }).success).toBe(false);
    expect(FactoryCapacityHistorySchema.safeParse({ ...value, versions: [pool(), { ...pool(), versionId: createEntityId() }] }).success).toBe(false);
  });
  it("does not inflate capacity access from the other operation's tenant scope", () => {
    const value = workspace();
    expect(FactoryCapacityWorkspaceSchema.parse({ ...value, contextAuthority: authority("tenant", "self"), access: { canRead: true, canWrite: false } }).access.canWrite).toBe(false);
    expect(FactoryCapacityWorkspaceSchema.safeParse({ ...value, contextAuthority: authority("tenant", "self") }).success).toBe(false);
    expect(FactoryCapacityWorkspaceSchema.safeParse({ ...value, contextAuthority: authority("self", "tenant"), access: { canRead: false, canWrite: true } }).success).toBe(false);
  });
  it("retains gross allocations and bounds current availability by net occupancy without forcing unknown capacity to zero facts", () => {
    const value = { poolId, poolVersionId, localDate, timeZone: "UTC", unit: "each", intervals: [{ start: at, end }], cutoffAt: null,
      capacityUnits: 10, allocatedUnits: 6, committedUnits: 2, releasedUnits: 1, availableUnits: 5, blockers: [] };
    expect(FactoryCapacityDaySchema.parse(value)).toEqual(value);
    expect(FactoryCapacityDaySchema.parse({ ...value, availableUnits: 0, blockers: ["Synthetic blocked current calendar"] }).availableUnits).toBe(0);
    expect(FactoryCapacityDaySchema.safeParse({ ...value, availableUnits: 6 }).success).toBe(false);
    expect(FactoryCapacityDaySchema.safeParse({ ...value, committedUnits: 5, releasedUnits: 2 }).success).toBe(false);
    expect(FactoryCapacityDaySchema.parse({ ...value, capacityUnits: null, availableUnits: 0, blockers: ["Synthetic unknown legacy occupancy"] }).allocatedUnits).toBe(6);
    expect(FactoryCapacityDaySchema.safeParse({ ...value, capacityUnits: null, availableUnits: 1 }).success).toBe(false);
  });
});
