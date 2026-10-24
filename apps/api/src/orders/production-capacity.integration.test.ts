import { createHash, randomUUID } from "node:crypto";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, type RecordProductionMilestoneInput } from "@yummyai/contracts";
import { ProductionCapacityViewSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { connectDatabase, factoryCapacityReservations, factoryCapacityEvents, factoryCapacityPools, factoryCapacityVersions, productionOrders, productionOrderVersions, productionMilestoneEvents, withTenant } from "@yummyai/database";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { resolveFactoryCapacityLocalTime, addFactoryCapacityLocalDays } from "../suppliers/factory-capacity-calendar.js";
import { sealProductionManufacturing } from "./production-manufacturing.js";
import { reserveFactoryCapacityInTransaction } from "../suppliers/factory-capacity.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (process.env.E2E_FACTORY_CAPACITY_ISOLATED !== "1" || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Production capacity requires the exact disposable capacity runner before connecting");
requireDisposableIntegrationEnvironment();
const business = (status: number, code: string) => (error: unknown) => !!error && typeof error === "object" && "getStatus" in error && "getResponse" in error &&
  (error as { getStatus(): number }).getStatus() === status && (error as { getResponse(): { code?: string } }).getResponse().code === code;
function postgres(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? postgres(error.cause) : {};
}
const guard = (message: string) => (error: unknown) => postgres(error).code === "23514" && postgres(error).message === message;

describe.sequential("real production capacity reservations and milestone effects", () => {
  const database = connectDatabase(), f = factoryCapacityFixture(database);
  beforeAll(() => f.initialize());
  afterEach(async () => { vi.restoreAllMocks(); await f.grant(); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); });
  async function setup(quantity = 6, capacityUnits = 10, options: { rates?: number[]; count?: number } = {}) {
    const site = await f.factory({ count: options.count }), pool = await f.pool(site, capacityUnits, { rates: options.rates }), source = await f.source(site, quantity, pool.pool);
    return { site, pool, source };
  }
  async function day(factoryId: string, poolId: string, localDate: string) {
    const value = await f.capacity.workspace(f.context, factoryId, { from: localDate, days: 1 });
    const found = value.calendar.find(row => row.poolId === poolId); if (!found) throw new Error("Synthetic pool day missing"); return found;
  }
  async function milestone(id: string, type: RecordProductionMilestoneInput["type"], eventId = randomUUID()) {
    const actual = await f.production.get(f.context, id), time = await f.clock();
    const input: RecordProductionMilestoneInput = { type, expectedProjectionVersion: actual.productionOrder.projectionVersion, externalEventId: eventId,
      occurredAt: time.now, evidence: { code: "SYNTHETIC_CAPACITY_EVENT", note: null, assetIds: [] } };
    return { input, value: await f.production.recordMilestone(f.context, id, input) };
  }
  async function ledger(id: string) {
    return withTenant(database.db, f.context, async tx => {
      const rows = await tx.select().from(factoryCapacityReservations).where(eq(factoryCapacityReservations.productionOrderId, id)).orderBy(asc(factoryCapacityReservations.id));
      const events = await tx.select().from(factoryCapacityEvents).where(sql`${factoryCapacityEvents.reservationId} in (select id from factory_capacity_reservations where production_order_id=${id}::uuid)`)
        .orderBy(asc(factoryCapacityEvents.reservationId), asc(factoryCapacityEvents.sequence));
      return { rows, events };
    });
  }
  async function rawReservation(value: Awaited<ReturnType<typeof setup>>, window: { start: string; end: string }) {
    const { site, pool, source } = value;
    return withTenant(database.db, f.context, async tx => {
      const productionId = createEntityId(), versionId = createEntityId();
      await tx.insert(productionOrders).values({ id: productionId, tenantId: f.context.tenantId, orderId: source.order.id, orderLineId: source.lineId,
        supplierId: site.supplierId, factoryId: site.factory.id, routingDecisionId: source.input.routingDecisionId, purchaseOrderVersionId: source.input.purchaseOrderVersionId,
        expectedCompletionAt: new Date(source.input.expectedCompletionAt), idempotencyKey: randomUUID(), createdBy: f.context.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: f.context.tenantId, productionOrderId: productionId, versionNumber: 1, quantity: 1,
        designVersionId: source.input.designVersionId, productionAssetIds: source.input.productionAssetIds, factoryId: site.factory.id, factoryVersionId: site.factory.versionId,
        capabilityVersionId: site.capabilities[0]!.versionId, encryptedInstructions: f.vault.encrypt("Synthetic SQL calendar negative"), instructionsChecksum: "d".repeat(64),
        expectedCompletionAt: new Date(source.input.expectedCompletionAt), createdBy: f.context.userId });
      await sealProductionManufacturing(tx, f.context, f.vault, versionId, source.input.manufacturing, { kind: "approved_product_confirmation", confirmation: source.input.productConfirmation! });
      // A genuine current birth and manufacturing pin reach the calendar gate.
      // The forged window is the only deliberately invalid fact and never commits.
      await tx.insert(factoryCapacityReservations).values({ id: createEntityId(), tenantId: f.context.tenantId, factoryId: site.factory.id,
        poolId: pool.pool.id, poolVersionId: pool.pool.versionId, productionOrderId: productionId, productionVersionId: versionId,
        capabilityVersionId: site.capabilities[0]!.versionId, localDate: pool.localDate, timeZone: pool.pool.timeZone, unit: pool.pool.unit,
        quantity: 1, unitsPerItem: 1, totalUnits: 1, workStartsAt: new Date(window.start), workEndsAt: new Date(window.end), createdBy: f.context.userId });
    });
  }

  it("atomically lets only one of two actual 6-item orders reserve a shared 10-item pool", async () => {
    const { site, pool, source } = await setup(), second = await f.source(site, 6, pool.pool);
    const results = await Promise.allSettled([source, second].map(item => f.production.create(f.context, item.order.id, item.input)));
    const successes = results.filter(item => item.status === "fulfilled"), failures = results.filter(item => item.status === "rejected");
    expect(successes).toHaveLength(1); expect(failures).toHaveLength(1);
    expect(failures[0]!.status === "rejected" && business(409, "factory_capacity_unavailable")(failures[0]!.reason)).toBe(true);
    const value = await day(site.factory.id, pool.pool.id, pool.localDate);
    expect(value).toMatchObject({ capacityUnits: 10, allocatedUnits: 6, committedUnits: 0, releasedUnits: 0, availableUnits: 4 });
    const [facts] = await withTenant(database.db, f.context, tx => tx.execute<{ count: string; units: string }>(sql`select count(*)::text as count,sum(r.total_units)::text as units
      from factory_capacity_reservations r where r.pool_id=${pool.pool.id}::uuid`));
    expect(facts).toEqual({ count: "1", units: "6" });
    const [orders] = await withTenant(database.db, f.context, tx => tx.execute<{ count: string }>(sql`select count(*)::text as count from production_orders where order_id in (${source.order.id}::uuid,${second.order.id}::uuid)`));
    expect(orders?.count).toBe("1");
  });
  it("mints the reservation and reserve event from the actual production-version birth transaction and replays once", async () => {
    const { site, pool, source } = await setup(3), saved = await f.production.create(f.context, source.order.id, source.input), id = saved.productionOrder.id;
    const actual = ProductionCapacityViewSchema.parse(await f.capacity.production(f.context, id));
    expect(actual.status).toBe("reserved"); expect(actual.reservations).toHaveLength(1);
    expect(actual.reservations[0]).toMatchObject({ productionOrderId: id, quantity: 3, unitsPerItem: 1, totalUnits: 3, committedUnits: 0, releasedUnits: 0,
      factoryId: site.factory.id, poolId: pool.pool.id, poolVersionId: pool.pool.versionId, localDate: pool.localDate });
    const [birth] = await withTenant(database.db, f.context, tx => tx.execute<{ matching: boolean; reserve_count: string }>(sql`select
      r.creation_transaction_id=p.creation_transaction_id and p.owner_kind='version' and p.quantity=r.quantity as matching,
      (select count(*)::text from factory_capacity_events e where e.reservation_id=r.id and e.kind='reserve' and e.units=r.total_units) as reserve_count
      from factory_capacity_reservations r join factory_capacity_owner_proofs p on p.tenant_id=r.tenant_id and p.owner_id=r.production_version_id
      where r.production_order_id=${id}::uuid`));
    expect(birth).toEqual({ matching: true, reserve_count: "1" }); const before = await f.state();
    expect((await f.production.create(f.context, source.order.id, source.input)).productionOrder.id).toBe(id); expect(await f.state()).toEqual(before);
    await expect(f.production.create(f.context, source.order.id, { ...source.input, expectedCompletionAt: new Date(Date.parse(source.input.expectedCompletionAt) + 60_000).toISOString() })).rejects.toThrow(/重试/);
    expect(await f.state()).toEqual(before);
  });
  it("shares one pool across distinct capability versions instead of granting each capability a new allowance", async () => {
    const { site, pool, source } = await setup(6, 10, { count: 2 }); await f.production.create(f.context, source.order.id, source.input);
    const second = await f.source(site, 5, pool.pool, { capabilityIndex: 1 }); const before = await f.state();
    await expect(f.production.create(f.context, second.order.id, second.input)).rejects.toSatisfy(business(409, "factory_capacity_unavailable"));
    expect(await f.state()).toEqual(before); expect((await day(site.factory.id, pool.pool.id, pool.localDate)).availableUnits).toBe(4);
  });
  it("does not reset consumed capacity when a new pool version changes the daily limit", async () => {
    const { site, pool, source } = await setup(); await f.production.create(f.context, source.order.id, source.input);
    const revised = await f.capacity.revisePool(f.context, site.factory.id, pool.pool.id, { expectedVersion: 1, profile: { ...pool.pool.profile, dailyCapacityUnits: 8 }, idempotencyKey: randomUUID() });
    expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ poolVersionId: revised.versionId, allocatedUnits: 6, capacityUnits: 8, availableUnits: 2 });
    const stale = await f.source(site, 1, pool.pool), before = await f.state();
    await expect(f.production.create(f.context, stale.order.id, stale.input)).rejects.toSatisfy(business(409, "factory_capacity_unavailable")); expect(await f.state()).toEqual(before);
    const current = { ...stale.input, capacityPlan: f.plan(revised, pool.localDate), idempotencyKey: randomUUID() };
    await f.production.create(f.context, stale.order.id, current);
    expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ allocatedUnits: 7, availableUnits: 1 });
  });
  it("keeps independent real factory pools separate even for the same capability type", async () => {
    const a = await setup(10), b = await setup(10);
    await Promise.all([a, b].map(item => f.production.create(f.context, item.source.order.id, item.source.input)));
    for (const item of [a, b]) expect(await day(item.site.factory.id, item.pool.pool.id, item.pool.localDate)).toMatchObject({ allocatedUnits: 10, availableUnits: 0 });
  });
  it("calculates integer per-item pool units on the server and reserves every required pool", async () => {
    const { site, pool, source } = await setup(3, 10, { rates: [2] }), second = await f.pool(site, 20, { rates: [3] });
    const input = { ...source.input, capacityPlan: { allocations: [...source.input.capacityPlan!.allocations, ...second.capacityPlan.allocations] } };
    const saved = await f.production.create(f.context, source.order.id, input), actual = await f.capacity.production(f.context, saved.productionOrder.id);
    expect(actual.reservations.map(row => [row.unitsPerItem, row.totalUnits]).sort((a, b) => a[0]! - b[0]!)).toEqual([[2, 6], [3, 9]]);
    expect((await day(site.factory.id, pool.pool.id, pool.localDate)).availableUnits).toBe(4);
    expect((await day(site.factory.id, second.pool.id, second.localDate)).availableUnits).toBe(11);
  });
  it("rejects missing capacity and an omitted newly required pool without leaving any production or proof", async () => {
    const { site, source } = await setup(1); const before = await f.state();
    await expect(f.production.create(f.context, source.order.id, { ...source.input, capacityPlan: undefined })).rejects.toSatisfy(business(422, "capacity_plan_required"));
    expect(await f.state()).toEqual(before); await f.pool(site, 10);
    const both = await f.state(); await expect(f.production.create(f.context, source.order.id, source.input)).rejects.toSatisfy(business(409, "factory_capacity_unavailable"));
    expect(await f.state()).toEqual(both);
  });
  it("a cancellation request alone holds capacity and a final pre-start cancellation releases it once", async () => {
    const { site, pool, source } = await setup(), saved = await f.production.create(f.context, source.order.id, source.input), id = saved.productionOrder.id;
    await milestone(id, "cancel_requested"); expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ allocatedUnits: 6, releasedUnits: 0, availableUnits: 4 });
    const cancelled = await milestone(id, "cancelled"), after = await ledger(id);
    expect(after.events.map(row => [row.kind, row.units])).toEqual([["reserve", 6], ["release", 6]]);
    expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ allocatedUnits: 6, releasedUnits: 6, availableUnits: 10 });
    await f.production.recordMilestone(f.context, id, cancelled.input); expect(await ledger(id)).toEqual(after);
    const next = await f.source(site, 10, pool.pool); await f.production.create(f.context, next.order.id, next.input);
    expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ allocatedUnits: 16, releasedUnits: 6, availableUnits: 0 });
  });
  it("a real started milestone commits the full reservation and later cancellation cannot refund it", async () => {
    const { site, pool, source } = await setup(), saved = await f.production.create(f.context, source.order.id, source.input), id = saved.productionOrder.id;
    for (const type of ["submitted", "acknowledged"] as const) await milestone(id, type);
    const started = await milestone(id, "started"), committed = await ledger(id);
    expect(committed.events.map(row => [row.kind, row.units])).toEqual([["reserve", 6], ["commit", 6]]);
    await f.production.recordMilestone(f.context, id, started.input); expect(await ledger(id)).toEqual(committed);
    for (const type of ["cancel_requested", "cancelled"] as const) await milestone(id, type);
    expect((await ledger(id)).events).toEqual(committed.events);
    expect(await day(site.factory.id, pool.pool.id, pool.localDate)).toMatchObject({ allocatedUnits: 6, committedUnits: 6, releasedUnits: 0, availableUnits: 4 });
  });
  it.each(["factory_capacity.reserve", "production_order.create"])("rolls production, manufacturing birth and all capacity facts back when %s audit fails", async action => {
    const { source } = await setup(1), before = await f.state(), actual = f.audit.recordInTransaction.bind(f.audit);
    const spy = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === action) throw new Error("Synthetic capacity transaction audit failed"); return actual(tx, actor, event);
    });
    try { await expect(f.production.create(f.context, source.order.id, source.input)).rejects.toThrow("Synthetic capacity transaction audit failed"); expect(await f.state()).toEqual(before); }
    finally { spy.mockRestore(); }
    const saved = await f.production.create(f.context, source.order.id, source.input); expect((await f.capacity.production(f.context, saved.productionOrder.id)).reservations).toHaveLength(1);
  });
  it.each(["started", "cancelled"] as const)("rolls the actual %s event, status and capacity effect back if its capacity audit fails", async type => {
    const { source } = await setup(1), saved = await f.production.create(f.context, source.order.id, source.input), id = saved.productionOrder.id;
    for (const previous of type === "started" ? ["submitted", "acknowledged"] as const : ["cancel_requested"] as const) await milestone(id, previous);
    const before = await f.state(), actual = f.audit.recordInTransaction.bind(f.audit), action = type === "started" ? "factory_capacity.commit" : "factory_capacity.release";
    const spy = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === action) throw new Error("Synthetic capacity effect audit failed"); return actual(tx, actor, event);
    });
    try { await expect(milestone(id, type)).rejects.toThrow("Synthetic capacity effect audit failed"); expect(await f.state()).toEqual(before); }
    finally { spy.mockRestore(); }
  });
  it("rechecks current tenant Write before a fresh reservation and never widens a mixed-scope ceiling", async () => {
    const { source } = await setup(1), ceiling = f.context; await f.grant([Permission.OrderWrite], "self", [Permission.OrderRead]); const before = await f.state();
    await expect(f.production.create(ceiling, source.order.id, source.input)).rejects.toBeInstanceOf(ForbiddenError); expect(await f.state()).toEqual(before);
  });
  it("keeps actual capacity receipt and raw ledger private across tenants", async () => {
    const { source } = await setup(1), saved = await f.production.create(f.context, source.order.id, source.input), id = saved.productionOrder.id;
    await expect(f.capacity.production(f.foreignContext, id)).rejects.toSatisfy(business(404, "factory_capacity_production_not_found"));
    expect(await withTenant(database.db, f.foreignContext, tx => tx.select().from(factoryCapacityReservations).where(eq(factoryCapacityReservations.productionOrderId, id)))).toEqual([]);
  });
  it("does not let application SQL reuse an old version birth or caller stamp to append a reservation", async () => {
    const { source } = await setup(1), saved = await f.production.create(f.context, source.order.id, source.input), original = (await ledger(saved.productionOrder.id)).rows[0]!, before = await f.state();
    await expect(withTenant(database.db, f.context, tx => tx.insert(factoryCapacityReservations).values({ ...original, id: createEntityId(), creationTransactionId: "1" })))
      .rejects.toSatisfy(guard("factory_capacity_reservation_original_required")); expect(await f.state()).toEqual(before);
  });
  it("rejects a raw production version without its real reservation even with a fabricated app setting", async () => {
    const { source } = await setup(1), before = await f.state();
    await expect(withTenant(database.db, f.context, async tx => {
      await tx.execute(sql`select set_config('app.capacity_reserved','true',true)`);
      const productionId = createEntityId(), versionId = createEntityId();
      await tx.insert(productionOrders).values({ id: productionId, tenantId: f.context.tenantId, orderId: source.order.id, orderLineId: source.lineId,
        supplierId: (await tx.execute<{ supplier_id: string }>(sql`select selected_supplier_id as supplier_id from order_routing_decisions where id=${source.input.routingDecisionId}::uuid`))[0]!.supplier_id,
        routingDecisionId: source.input.routingDecisionId, purchaseOrderVersionId: source.input.purchaseOrderVersionId, factoryId: source.input.factoryId,
        expectedCompletionAt: new Date(source.input.expectedCompletionAt), idempotencyKey: randomUUID(), createdBy: f.context.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: f.context.tenantId, productionOrderId: productionId, versionNumber: 1, quantity: 1,
        designVersionId: source.input.designVersionId, productionAssetIds: source.input.productionAssetIds, factoryId: source.input.factoryId,
        factoryVersionId: source.input.factoryVersionId, capabilityVersionId: source.input.capabilityVersionId, encryptedInstructions: f.vault.encrypt("Synthetic direct SQL negative"),
        instructionsChecksum: "c".repeat(64), expectedCompletionAt: new Date(source.input.expectedCompletionAt), createdBy: f.context.userId });
      // Force this named deferred constraint before unrelated manufacturing constraints; the transaction is expected to fail in full.
      await tx.execute(sql`set constraints production_version_requires_capacity immediate`);
    })).rejects.toSatisfy(guard("factory_capacity_all_pools_required")); expect(await f.state()).toEqual(before);
  });
  it("requires a genuine same-transaction started/cancelled event for capacity effects", async () => {
    const { source } = await setup(1), saved = await f.production.create(f.context, source.order.id, source.input), reservation = (await ledger(saved.productionOrder.id)).rows[0]!;
    await milestone(saved.productionOrder.id, "submitted");
    const [old] = await withTenant(database.db, f.context, tx => tx.select().from(productionMilestoneEvents).where(and(eq(productionMilestoneEvents.productionOrderId, saved.productionOrder.id), eq(productionMilestoneEvents.type, "submitted"))));
    const before = await f.state();
    await expect(withTenant(database.db, f.context, tx => tx.insert(factoryCapacityEvents).values({ id: createEntityId(), tenantId: f.context.tenantId, reservationId: reservation.id,
      sequence: 2, kind: "commit", units: 1, milestoneEventId: old!.id, createdBy: f.context.userId }))).rejects.toSatisfy(guard("factory_capacity_actual_milestone_required"));
    expect(await f.state()).toEqual(before);
  });
  it("exposes birth proofs as SELECT-only and capacity reservations/events as immutable app data", async () => {
    const { source } = await setup(1), saved = await f.production.create(f.context, source.order.id, source.input), reservation = (await ledger(saved.productionOrder.id)).rows[0]!, before = await f.state();
    const [grants] = await withTenant(database.db, f.context, tx => tx.execute<{ proof_write: boolean; reservation_update: boolean; event_delete: boolean }>(sql`select
      has_table_privilege(current_user,'factory_capacity_owner_proofs','INSERT,UPDATE,DELETE') as proof_write,
      has_table_privilege(current_user,'factory_capacity_reservations','UPDATE') as reservation_update,
      has_table_privilege(current_user,'factory_capacity_events','DELETE') as event_delete`));
    expect(grants).toEqual({ proof_write: false, reservation_update: false, event_delete: false });
    for (const table of ["factory_capacity_reservations", "factory_capacity_events"]) {
      await expect(withTenant(database.db, f.context, tx => tx.execute(sql`delete from ${sql.identifier(table)} where ${table === "factory_capacity_reservations" ? sql`id` : sql`reservation_id`}=${reservation.id}::uuid`)))
        .rejects.toSatisfy(error => postgres(error).code === "42501");
    }
    expect(await f.state()).toEqual(before);
  });
  it("raw SQL cannot invent an open work window on a confirmed closed calendar", async () => {
    const site = await f.factory(), pool = await f.pool(site, 10, { profile: { weekly: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [] })) } });
    const source = await f.source(site, 1, pool.pool), before = await f.state();
    await expect(rawReservation({ site, pool, source }, { start: `${pool.localDate}T01:00:00Z`, end: `${pool.localDate}T02:00:00Z` })).rejects.toSatisfy(guard("factory_capacity_day_unconfirmed"));
    expect(await f.state()).toEqual(before);
  });
  it("raw SQL cannot shrink the original all-day calendar into a caller-selected work window", async () => {
    const value = await setup(1), before = await f.state();
    await expect(rawReservation(value, { start: `${value.pool.localDate}T01:00:00Z`, end: `${value.pool.localDate}T02:00:00Z` })).rejects.toSatisfy(guard("factory_capacity_reservation_date_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it.each([
    ["gap", "2027-03-14", "02:30", "03:30", "2027-03-14T07:30:00Z", "2027-03-14T08:30:00Z"],
    ["fold", "2026-11-01", "01:30", "02:30", "2026-11-01T05:30:00Z", "2026-11-01T07:30:00Z"],
  ] as const)("raw SQL rejects a real DST %s instead of using PostgreSQL's implicit offset choice", async (_kind, localDate, start, end, instantStart, instantEnd) => {
    const site = await f.factory({ timeZone: "America/New_York" }), pool = await f.pool(site, 10, { localDate,
      profile: { weekly: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [{ start, end }] })) } });
    const source = await f.source(site, 1, pool.pool, { localDate }), before = await f.state();
    await expect(rawReservation({ site, pool, source }, { start: instantStart, end: instantEnd })).rejects.toSatisfy(guard("factory_capacity_local_time_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("raw SQL rejects a minute quota larger than the actual spring-forward working duration", async () => {
    const site = await f.factory({ timeZone: "America/New_York" }), localDate = "2027-03-14", pool = await f.pool(site, 1381, { unit: "minute", localDate });
    const source = await f.source(site, 1, pool.pool, { localDate }), before = await f.state();
    await expect(rawReservation({ site, pool, source }, { start: resolveFactoryCapacityLocalTime(site.factory.profile.timeZone!, `${localDate}T00:00`),
      end: resolveFactoryCapacityLocalTime(site.factory.profile.timeZone!, `${addFactoryCapacityLocalDays(localDate, 1)}T00:00`) })).rejects.toSatisfy(guard("factory_capacity_insufficient"));
    expect(await f.state()).toEqual(before);
  });
  it("raw SQL cannot reserve today's otherwise valid work window after the actual local cutoff", async () => {
    const site = await f.factory(), pool = await f.pool(site, 10, { profile: { cutoffTime: "00:00" } }), source = await f.source(site, 1, pool.pool), before = await f.state();
    await expect(rawReservation({ site, pool, source }, { start: `${pool.localDate}T00:00:00Z`, end: pool.expectedCompletionAt })).rejects.toSatisfy(guard("factory_capacity_reservation_date_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("rechecks the same-transaction pool set after a successful early constraint flush and a later new required pool", async () => {
    const { site, pool, source } = await setup(1), before = await f.state(); let firstFlushReached = false;
    await expect(withTenant(database.db, f.context, async tx => {
      const productionId = createEntityId(), versionId = createEntityId();
      await tx.insert(productionOrders).values({ id: productionId, tenantId: f.context.tenantId, orderId: source.order.id, orderLineId: source.lineId,
        supplierId: site.supplierId, factoryId: site.factory.id, routingDecisionId: source.input.routingDecisionId, purchaseOrderVersionId: source.input.purchaseOrderVersionId,
        expectedCompletionAt: new Date(source.input.expectedCompletionAt), idempotencyKey: randomUUID(), createdBy: f.context.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: f.context.tenantId, productionOrderId: productionId, versionNumber: 1, quantity: 1,
        designVersionId: source.input.designVersionId, productionAssetIds: source.input.productionAssetIds, factoryId: site.factory.id, factoryVersionId: site.factory.versionId,
        capabilityVersionId: site.capabilities[0]!.versionId, encryptedInstructions: f.vault.encrypt("Synthetic double-flush owner control"), instructionsChecksum: "e".repeat(64),
        expectedCompletionAt: new Date(source.input.expectedCompletionAt), createdBy: f.context.userId });
      await sealProductionManufacturing(tx, f.context, f.vault, versionId, source.input.manufacturing, { kind: "approved_product_confirmation", confirmation: source.input.productConfirmation! });
      await reserveFactoryCapacityInTransaction(tx, f.context, f.audit, { productionOrderId: productionId, productionVersionId: versionId, capacityPlan: pool.capacityPlan });
      await f.audit.recordInTransaction(tx, f.context, { action: "production_order.create", resourceType: "production_order", resourceId: productionId, result: "success", metadata: { orderId: source.order.id } });
      await tx.execute(sql`set constraints all immediate`); firstFlushReached = true;
      // A pool is a two-row append, so defer only its named pair while writing it.
      // The second flush must still recheck the production born in this transaction.
      await tx.execute(sql`set constraints factory_capacity_pool_version_required,factory_capacity_version_header_required deferred`);
      const poolId = createEntityId(), input = { factoryVersionId: site.factory.versionId, code: `SYNTHETIC-${randomUUID()}`, timeZone: pool.pool.timeZone,
        unit: pool.pool.unit, profile: pool.pool.profile, idempotencyKey: randomUUID() };
      await tx.insert(factoryCapacityPools).values({ id: poolId, tenantId: f.context.tenantId, factoryId: site.factory.id, factoryVersionId: input.factoryVersionId,
        code: input.code, timeZone: input.timeZone, unit: input.unit, currentVersionNumber: 1, createdBy: f.context.userId });
      await tx.insert(factoryCapacityVersions).values({ id: createEntityId(), tenantId: f.context.tenantId, factoryId: site.factory.id, poolId, versionNumber: 1,
        profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: createHash("sha256").update(canonicalJson({ operation: "create", factoryId: site.factory.id, input })).digest("hex"), createdBy: f.context.userId });
      await f.audit.recordInTransaction(tx, f.context, { action: "factory_capacity.pool.create", resourceType: "factory_capacity_pool", resourceId: poolId, result: "success", metadata: { factoryId: site.factory.id, versionNumber: 1 } });
      await tx.execute(sql`set constraints factory_capacity_pool_version_required,factory_capacity_version_header_required immediate`);
    })).rejects.toSatisfy(guard("factory_capacity_all_pools_required"));
    expect(firstFlushReached).toBe(true); expect(await f.state()).toEqual(before);
  });
});
