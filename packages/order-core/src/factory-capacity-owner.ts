import { createHash } from "node:crypto";
import { Permission, erpPermissionContext, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  CreateFactoryCapacityPoolSchema, ReviseFactoryCapacityPoolSchema, FactoryCapacityQuerySchema,
  FactoryCapacityPoolProfileSchema, FactoryCapacityPoolViewSchema, FactoryCapacityWorkspaceSchema,
  FactoryCapacityPreviewInputSchema, FactoryCapacityPreviewSchema, FactoryCapacityHistorySchema,
  ResolveFactoryLocalTimeInputSchema, ResolvedFactoryLocalTimeSchema, ProductionCapacityPlanSchema,
  FactoryCapacityReservationViewSchema, ProductionCapacityViewSchema,
  type FactoryCapacityDay, type FactoryCapacityPoolProfile, type FactoryCapacityPoolView,
  type FactoryCapacityPreview, type FactoryCapacityPreviewInput, type ProductionCapacityPlan,
} from "@yummyai/contracts/suppliers/factory-capacity";
import { FactoryProfileSchema } from "@yummyai/contracts/suppliers/factory-directory";
import {
  factoryCapacityPools as pools, factoryCapacityVersions as versions,
  factoryCapacityReservations as reservations, factoryCapacityEvents as events,
  fulfillmentFactories as factories, fulfillmentFactoryVersions as factoryVersions,
  factoryCapabilityVersions as capabilityVersions, productionOrders, productionOrderVersions,
  productionMilestoneEvents, withTenant, type DatabaseConnection, type TenantTransaction, type RecordAuditEvent,
  factoryCapacityStopEffects as stopEffects, productionQuantityReviews,
} from "@yummyai/database";
import { currentOrderAuthority, hasTenantOrderPermissions } from "./order-authority.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  addFactoryCapacityLocalDays, factoryCapacityLocalDate, FactoryCapacityCalendarError,
  resolveFactoryCapacityCalendarDay, resolveFactoryCapacityLocalTime,
} from "./factory-capacity-calendar.js";

export interface FactoryCapacityAudit {
  recordInTransaction(tx: TenantTransaction, context: TenantContext, event: RecordAuditEvent): Promise<unknown>;
}

type FactoryCapacityErrorBody = string | { code: string; message: string; blockers?: string[] };
export class FactoryCapacityOwnerError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(readonly status: 404 | 409 | 422, readonly body: FactoryCapacityErrorBody) {
    super(typeof body === "string" ? body : body.message);
    this.name = "FactoryCapacityOwnerError";
    this.statusCode = status;
    this.code = typeof body === "string" ? "factory_capacity_error" : body.code;
  }
}

type PoolRow = typeof pools.$inferSelect;
type VersionRow = typeof versions.$inferSelect;
type ReservationRow = typeof reservations.$inferSelect;
type CurrentPool = { pool: PoolRow; version: VersionRow };
type DayKey = { poolId: string; localDate: string };
type DayBalance = { allocated: number; committed: number; released: number };
type FactoryRow = { factory: typeof factories.$inferSelect; version: typeof factoryVersions.$inferSelect };
type PlannedItem = FactoryCapacityPreview["items"][number];
const emptyBalance: DayBalance = { allocated: 0, committed: 0, released: 0 };
const readOptions = { isolationLevel: "repeatable read", accessMode: "read write" } as const;
const id = (value: string) => EntityIdSchema.parse(value).toLowerCase();
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const key = (value: DayKey) => `${value.poolId}:${value.localDate}`;
const unique = (values: string[]) => [...new Set(values)];

function authority(context: TenantContext) {
  return { contextAuthority: erpSessionAuthority(erpPermissionContext(context)), access: {
    canRead: hasTenantOrderPermissions(context, [Permission.OrderRead]),
    canWrite: hasTenantOrderPermissions(context, [Permission.OrderWrite]),
  } };
}

function conflict(code: string): never {
  throw new FactoryCapacityOwnerError(409, { code, message: "工厂产能依据或可用量已变化 请重新核对" });
}

function invalid(code: string): never {
  throw new FactoryCapacityOwnerError(422, { code, message: "请明确核对工厂当地日期 资源池版本和实际产能依据" });
}

function units(value: string | number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) invalid("factory_capacity_units_invalid");
  return result;
}

function profile(input: FactoryCapacityPoolProfile): FactoryCapacityPoolProfile {
  const parsed = FactoryCapacityPoolProfileSchema.parse(input);
  return { ...parsed, bindings: parsed.bindings.map(binding => ({ ...binding, capabilityVersionId: id(binding.capabilityVersionId) })) };
}

async function databaseNow(tx: TenantTransaction): Promise<string> {
  const [row] = await tx.execute<{ instant: string }>(sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as instant`);
  if (!row?.instant) conflict("factory_capacity_clock_unavailable");
  return row.instant;
}

async function factoryLock(tx: TenantTransaction, factoryId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'factory:' + factoryId}))`);
}

async function poolLocks(tx: TenantTransaction, poolIds: string[]) {
  for (const poolId of unique(poolIds).sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'factory-capacity-pool:' + poolId},0))`);
}

async function dayLocks(tx: TenantTransaction, days: DayKey[]) {
  for (const day of [...new Map(days.map(day => [key(day), day])).values()].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0))
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'factory-capacity-day:' + day.poolId + ':' + day.localDate},0))`);
}

async function requestLock(tx: TenantTransaction, context: TenantContext, requestKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'factory-capacity-request:' + context.tenantId + ':' + requestKey},0))`);
}

async function readFactory(tx: TenantTransaction, factoryId: string): Promise<FactoryRow> {
  const [row] = await tx.select({ factory: factories, version: factoryVersions }).from(factories)
    .innerJoin(factoryVersions, and(eq(factoryVersions.factoryId, factories.id), eq(factoryVersions.versionNumber, factories.currentVersionNumber)))
    .where(eq(factories.id, factoryId));
  if (!row) throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_factory_not_found", message: "工厂不存在或无权访问" });
  return row;
}

async function readPools(tx: TenantTransaction, factoryId: string): Promise<CurrentPool[]> {
  const rows = await tx.select({ pool: pools, version: versions }).from(pools)
    .innerJoin(versions, and(eq(versions.poolId, pools.id), eq(versions.versionNumber, pools.currentVersionNumber)))
    .where(eq(pools.factoryId, factoryId)).orderBy(asc(pools.id)).limit(201);
  if (rows.length > 200) conflict("factory_capacity_pool_limit");
  return rows;
}

function poolView(pool: PoolRow, version: VersionRow): FactoryCapacityPoolView {
  return FactoryCapacityPoolViewSchema.parse({ id: pool.id, factoryId: pool.factoryId, code: pool.code,
    timeZone: pool.timeZone, unit: pool.unit, factoryVersionId: pool.factoryVersionId,
    versionId: version.id, versionNumber: version.versionNumber, profile: version.profile, createdAt: version.createdAt.toISOString() });
}

async function validateBindings(tx: TenantTransaction, factoryId: string, value: FactoryCapacityPoolProfile) {
  if (!value.bindings.length) return;
  const ids = value.bindings.map(binding => binding.capabilityVersionId);
  const rows = await tx.select({ id: capabilityVersions.id }).from(capabilityVersions)
    .where(and(eq(capabilityVersions.factoryId, factoryId), inArray(capabilityVersions.id, ids)));
  if (rows.length !== ids.length) invalid("factory_capacity_binding_invalid");
}

async function readBalances(tx: TenantTransaction, requested: DayKey[]): Promise<Map<string, DayBalance>> {
  const days = [...new Map(requested.map(day => [key(day), { pool_id: day.poolId, local_date: day.localDate }])).values()];
  if (!days.length) return new Map();
  const rows = await tx.execute<{ pool_id: string; local_date: string; allocated: string; committed: string; released: string }>(sql`
    select r.pool_id, r.local_date::text as local_date, sum(r.total_units)::text as allocated,
      sum(e.committed-stopped.reduced)::text as committed, sum(e.released+stopped.released)::text as released
    from jsonb_to_recordset(${JSON.stringify(days)}::jsonb) wanted(pool_id uuid,local_date date)
    join factory_capacity_reservations r on r.pool_id=wanted.pool_id and r.local_date=wanted.local_date
      and r.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
    cross join lateral (select coalesce(sum(case when e.kind='commit' then e.units else 0 end),0) as committed,
      coalesce(sum(case when e.kind='release' then e.units else 0 end),0) as released
      from factory_capacity_events e where e.tenant_id=r.tenant_id and e.reservation_id=r.id) e
    cross join lateral (select coalesce(sum(se.commit_reduction_units),0) as reduced,
      coalesce(sum(se.released_units),0) as released from factory_capacity_stop_effects se
      where se.tenant_id=r.tenant_id and se.reservation_id=r.id) stopped
    group by r.pool_id,r.local_date`);
  return new Map(rows.map(row => [`${row.pool_id}:${row.local_date}`, {
    allocated: units(row.allocated), committed: units(row.committed), released: units(row.released),
  }]));
}

async function readLegacyBasis(tx: TenantTransaction, factoryId: string, timeZone: string, now: string, excluded: string[]) {
  const today = factoryCapacityLocalDate(timeZone, now);
  const exclude = excluded.length ? sql`and p.id not in (${sql.join(excluded.map(value => sql`${value}::uuid`), sql`,`)})` : sql``;
  const [row] = await tx.execute<{ active: boolean; terminal_today: boolean }>(sql`
    select coalesce(bool_or(p.status not in ('completed','cancelled')),false) as active,
      coalesce(bool_or(p.status in ('completed','cancelled') and (
        (p.created_at at time zone ${timeZone})::date=${today}::date or
        (p.updated_at at time zone ${timeZone})::date=${today}::date or exists(
          select 1 from production_milestone_events m where m.tenant_id=p.tenant_id and m.production_order_id=p.id
            and m.type in ('completed','cancelled') and (m.recorded_at at time zone ${timeZone})::date=${today}::date))),false) as terminal_today
    from production_orders p where p.tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid
      and p.factory_id=${factoryId}::uuid
      and not exists(select 1 from factory_capacity_reservations r where r.tenant_id=p.tenant_id and r.production_order_id=p.id)
      ${exclude}`);
  return { active: row?.active === true, terminalToday: row?.terminal_today === true, today };
}

function capacityDay(row: CurrentPool, date: string, now: string, balance: DayBalance,
  legacy: Awaited<ReturnType<typeof readLegacyBasis>>, factory: FactoryRow): FactoryCapacityDay {
  const calendar = resolveFactoryCapacityCalendarDay({ profile: row.version.profile, timeZone: row.pool.timeZone,
    unit: row.pool.unit as "each" | "minute", localDate: date, now });
  const blockers = [...calendar.blockers];
  if (factory.factory.status !== "active") blockers.push("factory_capacity_factory_inactive");
  const currentProfile = FactoryProfileSchema.parse(factory.version.profile);
  if (currentProfile.timeZone !== row.pool.timeZone) blockers.push("factory_capacity_time_zone_changed");
  if (legacy.active || legacy.terminalToday && date === legacy.today) blockers.push("factory_capacity_legacy_untracked");
  if (balance.committed + balance.released > balance.allocated) conflict("factory_capacity_ledger_invalid");
  const net = balance.allocated - balance.released, outstanding = net - balance.committed;
  let available = Math.max(0, (calendar.capacityUnits ?? 0) - net);
  if (row.pool.unit === "minute" && date === legacy.today)
    available = Math.min(available, Math.max(0, calendar.remainingWorkingMinutes - outstanding));
  if (blockers.length) available = 0;
  return { poolId: row.pool.id, poolVersionId: row.version.id, localDate: date, timeZone: row.pool.timeZone,
    unit: row.pool.unit as "each" | "minute", intervals: calendar.intervals, cutoffAt: calendar.cutoffAt,
    capacityUnits: blockers.includes("factory_capacity_legacy_untracked") ? null : calendar.capacityUnits,
    allocatedUnits: balance.allocated, committedUnits: balance.committed, releasedUnits: balance.released,
    availableUnits: available, blockers: unique(blockers) };
}

async function planBatch(tx: TenantTransaction, factoryId: string, input: FactoryCapacityPreviewInput, options: {
  now: string; factory?: FactoryRow; rows?: CurrentPool[]; excludedProductionIds?: string[];
}) {
  const factory = options.factory ?? await readFactory(tx, factoryId), rows = options.rows ?? await readPools(tx, factoryId);
  const allDays = input.items.flatMap(item => item.capacityPlan.allocations);
  const balances = await readBalances(tx, allDays);
  const legacy = new Map<string, Awaited<ReturnType<typeof readLegacyBasis>>>();
  for (const timeZone of unique(rows.map(row => row.pool.timeZone)))
    legacy.set(timeZone, await readLegacyBasis(tx, factoryId, timeZone, options.now, options.excludedProductionIds ?? []));
  const factoryVersionIds = unique(input.items.map(item => item.factoryVersionId));
  const factoryPins = await tx.select().from(factoryVersions).where(and(eq(factoryVersions.factoryId, factoryId), inArray(factoryVersions.id, factoryVersionIds)));
  const capabilityIds = unique(input.items.map(item => item.capabilityVersionId));
  const capabilities = await tx.select({ id: capabilityVersions.id }).from(capabilityVersions)
    .where(and(eq(capabilityVersions.factoryId, factoryId), inArray(capabilityVersions.id, capabilityIds)));
  const requested = new Map<string, number>(), items: PlannedItem[] = [];
  for (const item of input.items) {
    const blockers: string[] = [], allocations: PlannedItem["allocations"] = [];
    const factoryPin = factoryPins.find(pin => pin.id === item.factoryVersionId);
    if (!factoryPin || !capabilities.some(capability => capability.id === item.capabilityVersionId)) blockers.push("factory_capacity_production_basis_invalid");
    const needed = rows.filter(row => ["active", "paused"].includes(row.version.profile.status) && row.version.profile.bindings.some(binding => binding.capabilityVersionId === item.capabilityVersionId));
    if (!needed.length) blockers.push("factory_capacity_binding_unconfirmed");
    const actualIds = needed.map(row => row.pool.id).sort(), chosenIds = item.capacityPlan.allocations.map(value => value.poolId).sort();
    if (canonicalJson(actualIds) !== canonicalJson(chosenIds)) blockers.push("factory_capacity_binding_set_changed");
    for (const selection of item.capacityPlan.allocations) {
      const row = needed.find(value => value.pool.id === selection.poolId);
      if (!row || row.version.id !== selection.poolVersionId) { blockers.push("factory_capacity_basis_changed"); continue; }
      const binding = row.version.profile.bindings.find(value => value.capabilityVersionId === item.capabilityVersionId)!;
      const amount = units(BigInt(item.quantity) * BigInt(binding.unitsPerItem));
      if (amount < 1 || amount > 1_000_000_000) { blockers.push("factory_capacity_units_invalid"); continue; }
      const day = capacityDay(row, selection.localDate, options.now, balances.get(key(selection)) ?? emptyBalance, legacy.get(row.pool.timeZone)!, factory);
      if (factoryPin && FactoryProfileSchema.parse(factoryPin.profile).timeZone !== row.pool.timeZone) blockers.push("factory_capacity_time_zone_changed");
      const last = day.intervals.at(-1);
      if (last && Date.parse(item.expectedCompletionAt) < Date.parse(last.end)) blockers.push("factory_capacity_after_completion");
      blockers.push(...day.blockers);
      requested.set(key(selection), units(BigInt(requested.get(key(selection)) ?? 0) + BigInt(amount)));
      allocations.push({ selection, poolName: row.version.profile.name, unitsPerItem: binding.unitsPerItem, requestedUnits: amount, day });
    }
    items.push({ reference: item.reference, quantity: item.quantity, expectedCompletionAt: item.expectedCompletionAt, blockers: unique(blockers), allocations });
  }
  for (const item of items) for (const allocation of item.allocations) {
    if ((requested.get(key(allocation.selection)) ?? 0) > allocation.day.availableUnits) item.blockers.push("factory_capacity_insufficient");
    item.blockers = unique(item.blockers);
  }
  return { items, blockers: unique(items.flatMap(item => item.blockers)) };
}

async function reservationViews(tx: TenantTransaction, rows: ReservationRow[]) {
  if (!rows.length) return [];
  const actualEvents = await tx.select().from(events).where(inArray(events.reservationId, rows.map(row => row.id))).orderBy(asc(events.reservationId), asc(events.sequence));
  const actualStops = await tx.select().from(stopEffects).where(inArray(stopEffects.reservationId, rows.map(row => row.id)));
  return rows.map(row => FactoryCapacityReservationViewSchema.parse({ id: row.id, factoryId: row.factoryId, poolId: row.poolId,
    poolVersionId: row.poolVersionId, productionOrderId: row.productionOrderId, productionVersionId: row.productionVersionId,
    capabilityVersionId: row.capabilityVersionId, localDate: row.localDate, timeZone: row.timeZone, unit: row.unit,
    quantity: row.quantity, unitsPerItem: row.unitsPerItem, totalUnits: row.totalUnits,
    committedUnits: units(actualEvents.filter(event => event.reservationId === row.id && event.kind === "commit").reduce((sum, event) => sum + BigInt(event.units), 0n)
      - actualStops.filter(effect => effect.reservationId === row.id).reduce((sum, effect) => sum + BigInt(effect.commitReductionUnits), 0n)),
    releasedUnits: units(actualEvents.filter(event => event.reservationId === row.id && event.kind === "release").reduce((sum, event) => sum + BigInt(event.units), 0n)
      + actualStops.filter(effect => effect.reservationId === row.id).reduce((sum, effect) => sum + BigInt(effect.releasedUnits), 0n)),
    workStartsAt: row.workStartsAt.toISOString(), workEndsAt: row.workEndsAt.toISOString(), createdAt: row.createdAt.toISOString() }));
}

export class FactoryCapacityOwner {
  constructor(private readonly database: DatabaseConnection, private readonly audit: FactoryCapacityAudit) {}

  async workspace(context: TenantContext, factoryId: string, rawQuery: unknown = {}) {
    requireTenantOrderPermissions(context, [Permission.OrderRead]);
    factoryId = id(factoryId); const query = FactoryCapacityQuerySchema.parse(rawQuery);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]), factory = await readFactory(tx, factoryId), now = await databaseNow(tx);
      const allRows = await readPools(tx, factoryId);
      const capabilityVersionId = query.capabilityVersionId && id(query.capabilityVersionId);
      if (capabilityVersionId && !(await tx.select({ id: capabilityVersions.id }).from(capabilityVersions).where(and(eq(capabilityVersions.id, capabilityVersionId), eq(capabilityVersions.factoryId, factoryId)))).length)
        throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_capability_not_found", message: "工厂能力不存在或无权访问" });
      const rows = capabilityVersionId ? allRows.filter(row => row.version.profile.bindings.some(binding => binding.capabilityVersionId === capabilityVersionId)) : allRows;
      const zone = FactoryProfileSchema.parse(factory.version.profile).timeZone;
      if (!zone && query.from === undefined) invalid("factory_capacity_time_zone_unknown");
      const from = query.from ?? factoryCapacityLocalDate(zone!, now), calendar: FactoryCapacityDay[] = [];
      const days = Array.from({ length: query.days }, (_, offset) => addFactoryCapacityLocalDays(from, offset));
      const balances = await readBalances(tx, rows.flatMap(row => days.map(localDate => ({ poolId: row.pool.id, localDate }))));
      const legacy = new Map<string, Awaited<ReturnType<typeof readLegacyBasis>>>();
      for (const timeZone of unique(rows.map(row => row.pool.timeZone))) legacy.set(timeZone, await readLegacyBasis(tx, factoryId, timeZone, now, []));
      for (const row of rows) for (const localDate of days)
        calendar.push(capacityDay(row, localDate, now, balances.get(key({ poolId: row.pool.id, localDate })) ?? emptyBalance, legacy.get(row.pool.timeZone)!, factory));
      return FactoryCapacityWorkspaceSchema.parse({ ...authority(current), factoryId, from, days: query.days, recordedAt: now,
        pools: rows.map(row => poolView(row.pool, row.version)), calendar });
    }, readOptions);
  }

  async createPool(context: TenantContext, factoryId: string, rawInput: unknown) {
    requireTenantOrderPermissions(context, [Permission.OrderWrite]);
    factoryId = id(factoryId); const parsed = CreateFactoryCapacityPoolSchema.parse(rawInput);
    const input = { ...parsed, factoryVersionId: id(parsed.factoryVersionId), idempotencyKey: parsed.idempotencyKey.toLowerCase(), profile: profile(parsed.profile) };
    const checksum = hash({ operation: "create", factoryId, input });
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      await requestLock(tx, current, input.idempotencyKey); await factoryLock(tx, factoryId);
      const [replay] = await tx.select().from(versions).where(eq(versions.idempotencyKey, input.idempotencyKey));
      if (replay) return this.replay(tx, current, replay, factoryId, null, checksum);
      const factory = await readFactory(tx, factoryId);
      if (factory.factory.status === "archived") conflict("factory_capacity_factory_inactive");
      if (factory.version.id !== input.factoryVersionId || FactoryProfileSchema.parse(factory.version.profile).timeZone !== input.timeZone) conflict("factory_capacity_basis_changed");
      await validateBindings(tx, factoryId, input.profile);
      if ((await tx.select({ id: pools.id }).from(pools).where(and(eq(pools.factoryId, factoryId), eq(pools.code, input.code)))).length) conflict("factory_capacity_code_exists");
      const [poolCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(pools).where(eq(pools.factoryId, factoryId));
      if (poolCount && poolCount.count >= 200) conflict("factory_capacity_pool_limit");
      const [pool] = await tx.insert(pools).values({ id: createEntityId(), tenantId: current.tenantId, factoryId, factoryVersionId: input.factoryVersionId,
        code: input.code, timeZone: input.timeZone, unit: input.unit, currentVersionNumber: 1, createdBy: current.userId }).returning();
      const [version] = await tx.insert(versions).values({ id: createEntityId(), tenantId: current.tenantId, factoryId, poolId: pool!.id,
        versionNumber: 1, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: checksum, createdBy: current.userId }).returning();
      await this.audit.recordInTransaction(tx, current, { action: "factory_capacity.pool.create", resourceType: "factory_capacity_pool", resourceId: pool!.id,
        result: "success", metadata: { factoryId, versionNumber: 1 } });
      return poolView(pool!, version!);
    });
  }

  async revisePool(context: TenantContext, factoryId: string, poolId: string, rawInput: unknown) {
    requireTenantOrderPermissions(context, [Permission.OrderWrite]);
    factoryId = id(factoryId); poolId = id(poolId); const parsed = ReviseFactoryCapacityPoolSchema.parse(rawInput);
    const input = { ...parsed, idempotencyKey: parsed.idempotencyKey.toLowerCase(), profile: profile(parsed.profile) };
    const checksum = hash({ operation: "revise", factoryId, poolId, input });
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
      await requestLock(tx, current, input.idempotencyKey); await factoryLock(tx, factoryId); await poolLocks(tx, [poolId]);
      const [replay] = await tx.select().from(versions).where(eq(versions.idempotencyKey, input.idempotencyKey));
      if (replay) return this.replay(tx, current, replay, factoryId, poolId, checksum);
      const factory = await readFactory(tx, factoryId);
      if (factory.factory.status === "archived") conflict("factory_capacity_factory_inactive");
      const [pool] = await tx.select().from(pools).where(and(eq(pools.id, poolId), eq(pools.factoryId, factoryId)));
      if (!pool) throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_pool_not_found", message: "资源池不存在或无权访问" });
      if (pool.currentVersionNumber !== input.expectedVersion) conflict("factory_capacity_version_changed");
      await validateBindings(tx, factoryId, input.profile);
      const [version] = await tx.insert(versions).values({ id: createEntityId(), tenantId: current.tenantId, factoryId, poolId,
        versionNumber: input.expectedVersion + 1, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: checksum, createdBy: current.userId }).returning();
      const [updated] = await tx.update(pools).set({ currentVersionNumber: version!.versionNumber })
        .where(and(eq(pools.id, poolId), eq(pools.currentVersionNumber, input.expectedVersion))).returning();
      if (!updated) conflict("factory_capacity_version_changed");
      await this.audit.recordInTransaction(tx, current, { action: "factory_capacity.pool.revise", resourceType: "factory_capacity_pool", resourceId: poolId,
        result: "success", metadata: { factoryId, versionNumber: version!.versionNumber } });
      return poolView(updated, version!);
    });
  }

  private async replay(tx: TenantTransaction, current: TenantContext, version: VersionRow, factoryId: string, poolId: string | null, checksum: string) {
    if (version.createdBy !== current.userId || version.factoryId !== factoryId || poolId !== null && version.poolId !== poolId || version.requestChecksum !== checksum)
      conflict("factory_capacity_request_mismatch");
    const [pool] = await tx.select().from(pools).where(and(eq(pools.id, version.poolId), eq(pools.factoryId, factoryId)));
    if (!pool) conflict("factory_capacity_basis_changed");
    return poolView(pool, version);
  }

  async history(context: TenantContext, factoryId: string, poolId: string) {
    requireTenantOrderPermissions(context, [Permission.OrderRead]); factoryId = id(factoryId); poolId = id(poolId);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]); await readFactory(tx, factoryId);
      const [pool] = await tx.select().from(pools).where(and(eq(pools.id, poolId), eq(pools.factoryId, factoryId)));
      if (!pool) throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_pool_not_found", message: "资源池不存在或无权访问" });
      const rows = await tx.select().from(versions).where(and(eq(versions.poolId, poolId), eq(versions.factoryId, factoryId))).orderBy(asc(versions.versionNumber));
      return FactoryCapacityHistorySchema.parse({ ...authority(current), factoryId, poolId, versions: rows.map(version => poolView(pool, version)) });
    }, readOptions);
  }

  async preview(context: TenantContext, factoryId: string, rawInput: unknown) {
    requireTenantOrderPermissions(context, [Permission.OrderRead]); factoryId = id(factoryId);
    const input = normalizePreview(FactoryCapacityPreviewInputSchema.parse(rawInput));
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]), now = await databaseNow(tx);
      const planned = await planBatch(tx, factoryId, input, { now });
      return FactoryCapacityPreviewSchema.parse({ ...authority(current), factoryId, recordedAt: now, canReserve: planned.blockers.length === 0, ...planned });
    }, readOptions);
  }

  async resolveTime(context: TenantContext, factoryId: string, rawInput: unknown) {
    requireTenantOrderPermissions(context, [Permission.OrderRead]); factoryId = id(factoryId);
    const input = ResolveFactoryLocalTimeInputSchema.parse(rawInput);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]); await readFactory(tx, factoryId);
      const [version] = await tx.select().from(factoryVersions).where(and(eq(factoryVersions.id, id(input.factoryVersionId)), eq(factoryVersions.factoryId, factoryId)));
      if (!version) throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_factory_version_not_found", message: "工厂版本不存在或无权访问" });
      const timeZone = FactoryProfileSchema.parse(version.profile).timeZone;
      if (!timeZone) invalid("factory_capacity_time_zone_unknown");
      try {
        return ResolvedFactoryLocalTimeSchema.parse({ ...authority(current), factoryId, factoryVersionId: version.id, timeZone,
          localDateTime: input.localDateTime, instant: resolveFactoryCapacityLocalTime(timeZone, input.localDateTime) });
      } catch (error) {
        if (error instanceof FactoryCapacityCalendarError) invalid(error.code);
        throw error;
      }
    }, readOptions);
  }

  async production(context: TenantContext, productionOrderId: string) {
    requireTenantOrderPermissions(context, [Permission.OrderRead]); productionOrderId = id(productionOrderId);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead]);
      if (!(await tx.select({ id: productionOrders.id }).from(productionOrders).where(eq(productionOrders.id, productionOrderId))).length)
        throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_production_not_found", message: "生产单不存在或无权访问" });
      const rows = await tx.select().from(reservations).where(eq(reservations.productionOrderId, productionOrderId)).orderBy(asc(reservations.poolId), asc(reservations.id));
      return ProductionCapacityViewSchema.parse({ ...authority(current), productionOrderId, status: rows.length ? "reserved" : "legacy_unreserved", reservations: await reservationViews(tx, rows) });
    }, readOptions);
  }
}

function normalizePlan(value: ProductionCapacityPlan): ProductionCapacityPlan {
  return { allocations: value.allocations.map(selection => ({ ...selection, poolId: id(selection.poolId), poolVersionId: id(selection.poolVersionId) })) };
}

function normalizePreview(input: FactoryCapacityPreviewInput): FactoryCapacityPreviewInput {
  return { items: input.items.map(item => ({ ...item, factoryVersionId: id(item.factoryVersionId), capabilityVersionId: id(item.capabilityVersionId), capacityPlan: normalizePlan(item.capacityPlan) })) };
}

/** Called by the actual production owner in its existing top-level tenant transaction. */
export async function reserveFactoryCapacityInTransaction(tx: TenantTransaction, context: TenantContext, audit: FactoryCapacityAudit, input: {
  productionOrderId: string; productionVersionId: string; capacityPlan: ProductionCapacityPlan | undefined;
}) {
  const current = await currentOrderAuthority(tx, context, [Permission.OrderWrite]);
  if (input.capacityPlan === undefined) invalid("capacity_plan_required");
  const capacityPlan = normalizePlan(ProductionCapacityPlanSchema.parse(input.capacityPlan));
  const productionOrderId = id(input.productionOrderId), productionVersionId = id(input.productionVersionId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'production-order:' + productionOrderId},0))`);
  const [source] = await tx.select({ production: productionOrders, version: productionOrderVersions }).from(productionOrders)
    .innerJoin(productionOrderVersions, and(eq(productionOrderVersions.productionOrderId, productionOrders.id), eq(productionOrderVersions.id, productionVersionId)))
    .where(eq(productionOrders.id, productionOrderId));
  if (!source?.production.factoryId || !source.version.factoryVersionId || !source.version.capabilityVersionId || source.version.factoryId !== source.production.factoryId || source.version.versionNumber !== source.production.currentVersionNumber || source.version.createdBy !== current.userId)
    conflict("factory_capacity_production_basis_invalid");
  const factoryId = source.production.factoryId;
  await factoryLock(tx, factoryId);
  const rows = await readPools(tx, factoryId);
  await poolLocks(tx, [...rows.map(row => row.pool.id), ...capacityPlan.allocations.map(selection => selection.poolId)]);
  await dayLocks(tx, capacityPlan.allocations);
  const existing = await tx.select().from(reservations).where(eq(reservations.productionVersionId, productionVersionId)).orderBy(asc(reservations.poolId));
  if (existing.length) {
    if (existing.length !== capacityPlan.allocations.length || existing.some(row => row.productionOrderId !== productionOrderId || row.createdBy !== current.userId || row.quantity !== source.version.quantity ||
      !capacityPlan.allocations.some(selection => selection.poolId === row.poolId && selection.poolVersionId === row.poolVersionId && selection.localDate === row.localDate))) conflict("factory_capacity_request_mismatch");
    return reservationViews(tx, existing);
  }
  const now = await databaseNow(tx), planned = await planBatch(tx, factoryId, { items: [{ reference: productionVersionId,
    factoryVersionId: source.version.factoryVersionId, capabilityVersionId: source.version.capabilityVersionId, quantity: source.version.quantity,
    expectedCompletionAt: source.version.expectedCompletionAt.toISOString(), capacityPlan }] }, { now, rows, excludedProductionIds: [productionOrderId] });
  if (planned.blockers.length) throw new FactoryCapacityOwnerError(409, { code: "factory_capacity_unavailable", message: "工厂产能依据或余量不足 请重新核对", blockers: planned.blockers });
  const saved: ReservationRow[] = [];
  for (const allocation of [...planned.items[0]!.allocations].sort((left, right) => left.selection.poolId < right.selection.poolId ? -1 : 1)) {
    const first = allocation.day.intervals[0], last = allocation.day.intervals.at(-1);
    if (!first || !last) conflict("factory_capacity_calendar_invalid");
    const [reservation] = await tx.insert(reservations).values({ id: createEntityId(), tenantId: current.tenantId, factoryId,
      poolId: allocation.selection.poolId, poolVersionId: allocation.selection.poolVersionId, productionOrderId, productionVersionId,
      capabilityVersionId: source.version.capabilityVersionId, localDate: allocation.selection.localDate, timeZone: allocation.day.timeZone, unit: allocation.day.unit,
      quantity: source.version.quantity, unitsPerItem: allocation.unitsPerItem, totalUnits: allocation.requestedUnits,
      workStartsAt: new Date(first.start), workEndsAt: new Date(last.end), createdBy: current.userId }).returning();
    await tx.insert(events).values({ id: createEntityId(), tenantId: current.tenantId, reservationId: reservation!.id,
      sequence: 1, kind: "reserve", units: allocation.requestedUnits, milestoneEventId: null, createdBy: current.userId });
    saved.push(reservation!);
  }
  await audit.recordInTransaction(tx, current, { action: "factory_capacity.reserve", resourceType: "production_order_version", resourceId: productionVersionId,
    result: "success", metadata: { factoryId, reservationCount: saved.length } });
  return reservationViews(tx, saved);
}

/** The caller has already authorized the ERP operation or exact factory assignment. */
export async function recordFactoryCapacityMilestoneInTransaction(tx: TenantTransaction, context: TenantContext, audit: FactoryCapacityAudit, input: { milestoneEventId: string }) {
  const milestoneEventId = id(input.milestoneEventId);
  const [milestone] = await tx.select().from(productionMilestoneEvents).where(eq(productionMilestoneEvents.id, milestoneEventId));
  if (!milestone) throw new FactoryCapacityOwnerError(404, { code: "factory_capacity_milestone_not_found", message: "生产事件不存在或无权访问" });
  if (!["started", "cancelled"].includes(milestone.type)) return;
  if (milestone.actorUserId !== context.userId) conflict("factory_capacity_milestone_actor_mismatch");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'production-order:' + milestone.productionOrderId},0))`);
  const rows = await tx.select().from(reservations).where(eq(reservations.productionOrderId, milestone.productionOrderId)).orderBy(asc(reservations.poolId), asc(reservations.id));
  if (!rows.length) return;
  for (const factoryId of unique(rows.map(row => row.factoryId)).sort()) await factoryLock(tx, factoryId);
  await poolLocks(tx, rows.map(row => row.poolId)); await dayLocks(tx, rows);
  const actualEvents = await tx.select().from(events).where(inArray(events.reservationId, rows.map(row => row.id))).orderBy(asc(events.reservationId), asc(events.sequence));
  for (const row of rows) {
    const history = actualEvents.filter(event => event.reservationId === row.id);
    if (history.some(event => event.milestoneEventId === milestoneEventId)) continue;
    const committed = units(history.filter(event => event.kind === "commit").reduce((sum, event) => sum + BigInt(event.units), 0n));
    const released = units(history.filter(event => event.kind === "release").reduce((sum, event) => sum + BigInt(event.units), 0n));
    if (committed + released > row.totalUnits) conflict("factory_capacity_ledger_invalid");
    const kind = milestone.type === "started" ? "commit" : "release";
    if (kind === "release" && committed > 0) continue;
    const [stop] = await tx.execute<{ released: string; reduced: string }>(sql`select coalesce(sum(released_units),0)::text as released,
      coalesce(sum(commit_reduction_units),0)::text as reduced from factory_capacity_stop_effects where reservation_id=${row.id}`);
    const amount = row.totalUnits - committed - released - units(stop!.released) + units(stop!.reduced);
    if (!amount) continue;
    await tx.insert(events).values({ id: createEntityId(), tenantId: context.tenantId, reservationId: row.id,
      sequence: (history.at(-1)?.sequence ?? 0) + 1, kind, units: amount, milestoneEventId, createdBy: context.userId });
    await audit.recordInTransaction(tx, context, { action: `factory_capacity.${kind}`, resourceType: "factory_capacity_reservation", resourceId: row.id,
      result: "success", metadata: { milestoneEventId, units: amount } });
  }
}

/** Called only after the actual quantity owner inserts its reviewed immutable receipt. */
export async function applyProductionQuantityCapacityStop(tx: TenantTransaction, context: TenantContext, reviewId: string) {
  const [review] = await tx.select().from(productionQuantityReviews).where(eq(productionQuantityReviews.id, id(reviewId)));
  if (!review || review.createdBy !== context.userId) conflict("factory_capacity_actual_stop_required");
  if (!review.stoppedDelta) return;
  const rows = await tx.select().from(reservations).where(and(eq(reservations.productionOrderId, review.productionOrderId),
    eq(reservations.productionVersionId, review.productionVersionId))).orderBy(asc(reservations.poolId), asc(reservations.id));
  if (!rows.length) conflict("factory_capacity_actual_stop_required");
  for (const factoryId of unique(rows.map(row => row.factoryId)).sort()) await factoryLock(tx, factoryId);
  await poolLocks(tx, rows.map(row => row.poolId)); await dayLocks(tx, rows);
  for (const row of rows) {
    const [balance] = await tx.execute<{ committed: string; released: string; stopReleased: string; reduced: string }>(sql`
      select coalesce((select sum(units) from factory_capacity_events where reservation_id=${row.id} and kind='commit'),0)::text as committed,
        coalesce((select sum(units) from factory_capacity_events where reservation_id=${row.id} and kind='release'),0)::text as released,
        coalesce((select sum(released_units) from factory_capacity_stop_effects where reservation_id=${row.id}),0)::text as "stopReleased",
        coalesce((select sum(commit_reduction_units) from factory_capacity_stop_effects where reservation_id=${row.id}),0)::text as reduced`);
    const releasedUnits = review.stoppedDelta * row.unitsPerItem;
    if (!balance || units(balance.released) || releasedUnits + units(balance.stopReleased) > row.totalUnits)
      conflict("factory_capacity_stop_conservation_invalid");
    const availableCommit = units(balance.committed) - units(balance.reduced);
    if (availableCommit < 0) conflict("factory_capacity_stop_conservation_invalid");
    await tx.insert(stopEffects).values({ id: createEntityId(), tenantId: context.tenantId, reviewId: review.id, reservationId: row.id,
      stoppedQuantity: review.stoppedDelta, releasedUnits, commitReductionUnits: Math.min(releasedUnits, availableCommit), createdBy: context.userId });
  }
}
