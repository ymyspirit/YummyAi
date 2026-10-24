import { createHash, randomUUID } from "node:crypto";
import { erpPermissionContext, ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryCapacityHistorySchema, FactoryCapacityWorkspaceSchema, FactoryCapacityPreviewSchema } from "@yummyai/contracts/suppliers/factory-capacity";
import { connectDatabase, factoryCapacityPools, factoryCapacityVersions, memberships, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticFactoryCapacityProfile } from "../../../../tools/testing/factory-capacity-fixtures.js";
import { factoryCapacityFixture, type SyntheticCapacityFactory } from "./factory-capacity.test-fixture.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
if (process.env.E2E_FACTORY_CAPACITY_ISOLATED !== "1" || !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory capacity tests require the exact disposable capacity runner before connecting");
requireDisposableIntegrationEnvironment();
const read = Permission.OrderRead, write = Permission.OrderWrite;
const code = (status: number, value: string) => (error: unknown) => !!error && typeof error === "object" &&
  "getStatus" in error && (error as { getStatus(): number }).getStatus() === status &&
  "getResponse" in error && (error as { getResponse(): { code?: string } }).getResponse().code === value;

describe.sequential("confirmed factory calendars and operation authority", () => {
  const database = connectDatabase(), f = factoryCapacityFixture(database);
  beforeAll(() => f.initialize());
  afterEach(async () => { vi.restoreAllMocks(); await f.grant(); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); }); // All immutable synthetic rows belong to the nonce DB removed by the runner.
  const createInput = (site: SyntheticCapacityFactory) => ({ factoryVersionId: site.factory.versionId, code: `SYNTHETIC-${randomUUID()}`, timeZone: site.factory.profile.timeZone!,
    unit: "each" as const, profile: syntheticFactoryCapacityProfile(site.capabilities.map(item => ({ capabilityVersionId: item.versionId, unitsPerItem: 1 })), 10), idempotencyKey: randomUUID() });
  async function choice(site: SyntheticCapacityFactory, quantity: number, reference = randomUUID()) {
    const saved = await f.pool(site), time = await f.clock(site.factory.profile.timeZone!);
    return { saved, item: { reference, factoryVersionId: site.factory.versionId, capabilityVersionId: site.capabilities[0]!.versionId, quantity,
      expectedCompletionAt: time.expectedCompletionAt, capacityPlan: saved.capacityPlan } };
  }

  it("stores explicit confirmed capacity and exact key replay without duplicating versions or audit", async () => {
    const site = await f.factory(), input = createInput(site), first = await f.capacity.createPool(f.context, site.factory.id, input), before = await f.state();
    expect(first).toMatchObject({ factoryId: site.factory.id, timeZone: "UTC", unit: "each", versionNumber: 1, profile: { dailyCapacityUnits: 10 } });
    expect(await f.capacity.createPool(f.context, site.factory.id, input)).toEqual(first);
    expect(await f.state()).toEqual(before);
    await expect(f.capacity.createPool(f.context, site.factory.id, { ...input, profile: { ...input.profile, dailyCapacityUnits: 11 } })).rejects.toSatisfy(code(409, "factory_capacity_request_mismatch"));
    expect(await f.state()).toEqual(before);
  });
  it("returns canonical current authority and one shared pool for two capabilities", async () => {
    const site = await f.factory({ count: 2 }), saved = await f.pool(site), before = await f.state();
    const value = FactoryCapacityWorkspaceSchema.parse(await f.capacity.workspace(f.context, site.factory.id, { from: saved.localDate, days: 2 }));
    const presented = erpPermissionContext(f.context), excluded: string[] = [Permission.FactoryTaskRead, Permission.FactoryTaskRespond].sort();
    // The real full-permission member retains factory-portal authority. Only the
    // ordinary ERP presentation omits these two permissions and their scope keys.
    expect(f.context.permissions.filter(permission => !presented.permissions.includes(permission)).sort()).toEqual(excluded);
    expect(f.context.permissionScopes).toMatchObject({ [Permission.FactoryTaskRead]: "tenant", [Permission.FactoryTaskRespond]: "tenant" });
    expect(Object.keys(f.context.permissionScopes!).filter(permission => !(permission in presented.permissionScopes!)).sort()).toEqual(excluded);
    expect(value).toMatchObject({ contextAuthority: erpSessionAuthority(presented), access: { canRead: true, canWrite: true }, days: 2 });
    expect(JSON.parse(value.contextAuthority).permissions).toEqual([...f.context.permissions].filter(permission => !excluded.includes(permission)).sort());
    expect(value.pools).toHaveLength(1); expect(value.pools[0]!.profile.bindings).toHaveLength(2);
    expect(value.calendar).toHaveLength(2);
    for (const day of value.calendar) expect(day).toMatchObject({ allocatedUnits: 0, committedUnits: 0, releasedUnits: 0, capacityUnits: 10, availableUnits: 10 });
    expect(await f.state()).toEqual(before);
  });
  it("keeps root timezone, unit and code while appending an immutable CAS version", async () => {
    const site = await f.factory(), saved = await f.pool(site), input = { expectedVersion: 1, profile: { ...saved.pool.profile, dailyCapacityUnits: 8 }, idempotencyKey: randomUUID() };
    const second = await f.capacity.revisePool(f.context, site.factory.id, saved.pool.id, input), before = await f.state();
    expect(second).toMatchObject({ id: saved.pool.id, code: saved.pool.code, unit: saved.pool.unit, timeZone: saved.pool.timeZone, versionNumber: 2 });
    expect(second.versionId).not.toBe(saved.pool.versionId);
    expect(await f.capacity.revisePool(f.context, site.factory.id, saved.pool.id, input)).toEqual(second); expect(await f.state()).toEqual(before);
    const history = FactoryCapacityHistorySchema.parse(await f.capacity.history(f.context, site.factory.id, saved.pool.id));
    expect(history.versions.map(item => [item.versionNumber, item.profile.dailyCapacityUnits])).toEqual([[1, 10], [2, 8]]);
    await expect(f.capacity.revisePool(f.context, site.factory.id, saved.pool.id, { ...input, idempotencyKey: randomUUID() })).rejects.toSatisfy(code(409, "factory_capacity_version_changed"));
    expect(await f.state()).toEqual(before);
  });
  it("lets only one concurrent expected-version revision append", async () => {
    const site = await f.factory(), saved = await f.pool(site), input = { expectedVersion: 1, profile: saved.pool.profile };
    const results = await Promise.allSettled([11, 12].map(dailyCapacityUnits => f.capacity.revisePool(f.context, site.factory.id, saved.pool.id,
      { ...input, profile: { ...input.profile, dailyCapacityUnits }, idempotencyKey: randomUUID() })));
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(item => item.status === "rejected"); expect(failed?.status === "rejected" && code(409, "factory_capacity_version_changed")(failed.reason)).toBe(true);
    expect((await f.capacity.history(f.context, site.factory.id, saved.pool.id)).versions).toHaveLength(2);
  });
  it("rejects a capability belonging to another real factory without writing a pool", async () => {
    const site = await f.factory(), other = await f.factory(), input = createInput(site), before = await f.state();
    await expect(f.capacity.createPool(f.context, site.factory.id, { ...input, profile: { ...input.profile, bindings: [{ capabilityVersionId: other.capabilities[0]!.versionId, unitsPerItem: 1 }] } })).rejects.toSatisfy(code(422, "factory_capacity_binding_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("requires the real current factory version and IANA timezone when confirming a root", async () => {
    const site = await f.factory(), input = createInput(site), before = await f.state();
    for (const changed of [{ ...input, factoryVersionId: createEntityId() }, { ...input, timeZone: "Asia/Shanghai" }])
      await expect(f.capacity.createPool(f.context, site.factory.id, changed)).rejects.toSatisfy(code(409, "factory_capacity_basis_changed"));
    expect(await f.state()).toEqual(before);
  });
  it("aggregates 6 plus 6 across two capability items against the same finite 10-unit day without reserving", async () => {
    const site = await f.factory({ count: 2 }), { saved, item } = await choice(site, 6), before = await f.state();
    const value = FactoryCapacityPreviewSchema.parse(await f.capacity.preview(f.context, site.factory.id, { items: [item, { ...item, reference: "second", capabilityVersionId: site.capabilities[1]!.versionId }] }));
    expect(value.canReserve).toBe(false); expect(value.blockers).toContain("factory_capacity_insufficient");
    expect(value.items.map(row => row.allocations[0]!.requestedUnits)).toEqual([6, 6]);
    expect(value.items.every(row => row.allocations[0]!.selection.poolId === saved.pool.id && row.blockers.includes("factory_capacity_insufficient"))).toBe(true);
    expect(await f.state()).toEqual(before);
  });
  it("does not infer active capacity from an unbound or paused pool or let callers omit a required pool", async () => {
    const site = await f.factory(), { item } = await choice(site, 1);
    const second = await f.pool(site, 10, { profile: { status: "paused" } });
    const omitted = await f.capacity.preview(f.context, site.factory.id, { items: [item] });
    expect(omitted.canReserve).toBe(false); expect(omitted.blockers).toContain("factory_capacity_binding_set_changed");
    const included = await f.capacity.preview(f.context, site.factory.id, { items: [{ ...item, capacityPlan: { allocations: [...item.capacityPlan.allocations, ...second.capacityPlan.allocations] } }] });
    expect(included.canReserve).toBe(false); expect(included.blockers).toContain("factory_capacity_pool_inactive");
  });
  it("refuses stale pool versions and work ending after the explicitly promised completion", async () => {
    const site = await f.factory(), { saved, item } = await choice(site, 1);
    await f.capacity.revisePool(f.context, site.factory.id, saved.pool.id, { expectedVersion: 1, profile: saved.pool.profile, idempotencyKey: randomUUID() });
    const stale = await f.capacity.preview(f.context, site.factory.id, { items: [item] }); expect(stale.blockers).toContain("factory_capacity_basis_changed");
    const latest = (await f.capacity.history(f.context, site.factory.id, saved.pool.id)).versions.at(-1)!;
    const early = await f.capacity.preview(f.context, site.factory.id, { items: [{ ...item, expectedCompletionAt: `${saved.localDate}T23:59:00.000Z`, capacityPlan: f.plan(latest, saved.localDate) }] });
    expect(early.canReserve).toBe(false); expect(early.blockers).toContain("factory_capacity_after_completion");
  });
  it("returns unavailable for yesterday using the database's factory-local day", async () => {
    const site = await f.factory({ timeZone: "Pacific/Kiritimati" }), saved = await f.pool(site), time = await f.clock(site.factory.profile.timeZone!, -1);
    const value = await f.capacity.preview(f.context, site.factory.id, { items: [{ reference: "past", factoryVersionId: site.factory.versionId,
      capabilityVersionId: site.capabilities[0]!.versionId, quantity: 1, expectedCompletionAt: saved.expectedCompletionAt, capacityPlan: f.plan(saved.pool, time.localDate) }] });
    expect(value.canReserve).toBe(false); expect(value.blockers).toContain("factory_capacity_date_in_past");
  });
  it("resolves the pinned factory timezone and rejects both real New York DST gap and fold", async () => {
    const site = await f.factory({ timeZone: "America/New_York" }), before = await f.state();
    const resolved = await f.capacity.resolveTime(f.context, site.factory.id, { factoryVersionId: site.factory.versionId, localDateTime: "2026-07-15T12:00" });
    expect(resolved).toMatchObject({ factoryId: site.factory.id, timeZone: "America/New_York", instant: "2026-07-15T16:00:00.000Z" });
    for (const localDateTime of ["2026-03-08T02:30", "2026-11-01T01:30"])
      await expect(f.capacity.resolveTime(f.context, site.factory.id, { factoryVersionId: site.factory.versionId, localDateTime })).rejects.toSatisfy(code(422, "factory_capacity_local_time_invalid"));
    expect(await f.state()).toEqual(before);
  });
  it("does not allow a 1381-minute promise during an actual 1380-minute spring-forward day", async () => {
    const site = await f.factory({ timeZone: "America/New_York" }), saved = await f.pool(site, 1381, { unit: "minute", localDate: "2027-03-14" });
    const value = await f.capacity.workspace(f.context, site.factory.id, { from: "2027-03-14", days: 1 });
    expect(value.calendar).toHaveLength(1); expect(value.calendar[0]).toMatchObject({ availableUnits: 0, capacityUnits: 1381 });
    expect(value.calendar[0]!.blockers).toContain("factory_capacity_minutes_exceed_working_time");
    expect(saved.pool.unit).toBe("minute");
  });
  it.each(["create", "revise"] as const)("requires tenant Write for %s despite tenant Read plus self Write", async operation => {
    const site = await f.factory(), saved = await f.pool(site), input = createInput(site); await f.grant([write], "self", [read]); const ceiling = await f.current(), before = await f.state();
    const call = operation === "create" ? f.capacity.createPool(ceiling, site.factory.id, input) : f.capacity.revisePool(ceiling, site.factory.id, saved.pool.id, { expectedVersion: 1, profile: saved.pool.profile, idempotencyKey: randomUUID() });
    await expect(call).rejects.toBeInstanceOf(ForbiddenError); expect(await f.state()).toEqual(before);
    expect((await f.capacity.workspace(ceiling, site.factory.id, {})).access).toEqual({ canRead: true, canWrite: false });
  });
  it("permits Write-only pool create and revision without enlarging self Read to tenant Read", async () => {
    const site = await f.factory(), input = createInput(site); await f.grant([read], "self", [write]); const ceiling = await f.current();
    const first = await f.capacity.createPool(ceiling, site.factory.id, input), second = await f.capacity.revisePool(ceiling, site.factory.id, first.id, { expectedVersion: 1, profile: first.profile, idempotencyKey: randomUUID() });
    expect(second.versionNumber).toBe(2); expect(second).not.toHaveProperty("contextAuthority");
    await expect(f.capacity.workspace(ceiling, site.factory.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.capacity.history(ceiling, site.factory.id, first.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("checks current Write before successful-key replay and the original ceiling before a later grant", async () => {
    const site = await f.factory(), input = createInput(site), saved = await f.capacity.createPool(f.context, site.factory.id, input), ceiling = f.context;
    await f.grant([read]); const narrow = await f.current(), before = await f.state();
    await expect(f.capacity.createPool(ceiling, site.factory.id, input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.grant(); await expect(f.capacity.createPool(narrow, site.factory.id, { ...input, code: "SYNTHETIC-LATER", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.capacity.createPool(await f.current(), site.factory.id, input)).toEqual(saved); expect(await f.state()).toEqual(before);
  });
  it("rejects current scope narrowing and disabled membership without returning a historical pool", async () => {
    const site = await f.factory(), saved = await f.pool(site), ceiling = f.context;
    await f.grant([read], "self", [write]);
    await expect(f.capacity.history(ceiling, site.factory.id, saved.pool.id)).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, f.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.owner.membershipId)));
    await expect(f.capacity.createPool(ceiling, site.factory.id, createInput(site))).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("hides foreign factory and pool rows under the forced application RLS role", async () => {
    const site = await f.factory(), saved = await f.pool(site);
    await expect(f.capacity.workspace(f.foreignContext, site.factory.id, {})).rejects.toSatisfy(code(404, "factory_capacity_factory_not_found"));
    await expect(f.capacity.history(f.foreignContext, site.factory.id, saved.pool.id)).rejects.toSatisfy(code(404, "factory_capacity_factory_not_found"));
    const [row] = await withTenant(database.db, f.foreignContext, tx => tx.execute<{ is_owner: boolean; pools: string; versions: string }>(sql`select
      current_user=(select pg_get_userbyid(relowner) from pg_class where oid='factory_capacity_pools'::regclass) as is_owner,
      (select count(*)::text from factory_capacity_pools where id=${saved.pool.id}::uuid) as pools,
      (select count(*)::text from factory_capacity_versions where pool_id=${saved.pool.id}::uuid) as versions`));
    expect(row).toEqual({ is_owner: false, pools: "0", versions: "0" });
  });
  it.each(["create", "revise"] as const)("rolls all %s pool facts back if the same-transaction audit fails", async operation => {
    const site = await f.factory(), saved = await f.pool(site), input = createInput(site), before = await f.state();
    const actual = f.audit.recordInTransaction.bind(f.audit), spy = vi.spyOn(f.audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === `factory_capacity.pool.${operation}`) throw new Error("Synthetic capacity audit unavailable");
      return actual(tx, actor, event);
    });
    try {
      const call = operation === "create" ? f.capacity.createPool(f.context, site.factory.id, input) : f.capacity.revisePool(f.context, site.factory.id, saved.pool.id, { expectedVersion: 1, profile: saved.pool.profile, idempotencyKey: randomUUID() });
      await expect(call).rejects.toThrow("Synthetic capacity audit unavailable"); expect(await f.state()).toEqual(before);
    } finally { spy.mockRestore(); }
  });
  it("keeps exact pool-history parent identity instead of exposing another factory's pool", async () => {
    const site = await f.factory(), other = await f.factory(), saved = await f.pool(site);
    await expect(f.capacity.history(f.context, other.factory.id, saved.pool.id)).rejects.toSatisfy(code(404, "factory_capacity_pool_not_found"));
    const value = await f.capacity.workspace(f.context, other.factory.id, {}); expect(value.pools).toEqual([]); expect(value.calendar).toEqual([]);
  });
  it("raw SQL cannot hide a new pool header without its original version", async () => {
    const site = await f.factory(), before = await f.state();
    await expect(withTenant(database.db, f.context, async tx => {
      await tx.insert(factoryCapacityPools).values({ id: createEntityId(), tenantId: f.context.tenantId, factoryId: site.factory.id, factoryVersionId: site.factory.versionId,
        code: `SYNTHETIC-${randomUUID()}`, timeZone: site.factory.profile.timeZone!, unit: "each", currentVersionNumber: 1, createdBy: f.context.userId });
      await tx.execute(sql`set constraints factory_capacity_pool_version_required immediate`);
    })).rejects.toMatchObject({ cause: { code: "23514", message: "factory_capacity_pool_version_required" } });
    expect(await f.state()).toEqual(before);
  });
  it("raw SQL cannot append a correctly hashed version while leaving the header on its old version", async () => {
    const site = await f.factory(), saved = await f.pool(site), before = await f.state(), input = { expectedVersion: 1, profile: saved.pool.profile, idempotencyKey: randomUUID() };
    const checksum = createHash("sha256").update(canonicalJson({ operation: "revise", factoryId: site.factory.id, poolId: saved.pool.id, input })).digest("hex");
    await expect(withTenant(database.db, f.context, async tx => {
      await tx.insert(factoryCapacityVersions).values({ id: createEntityId(), tenantId: f.context.tenantId, factoryId: site.factory.id, poolId: saved.pool.id,
        versionNumber: 2, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: checksum, createdBy: f.context.userId });
      await tx.execute(sql`set constraints factory_capacity_version_header_required immediate`);
    })).rejects.toMatchObject({ cause: { code: "23514", message: "factory_capacity_pool_version_required" } });
    expect(await f.state()).toEqual(before);
  });
  it("pool-limit: serializes the 200th root and keeps exact replay and the factory readable", async () => {
    const site = await f.factory();
    const draft = () => {
      const input = createInput(site);
      return { ...input, profile: { ...input.profile, status: "draft" as const, dailyCapacityUnits: null, bindings: [] } };
    };
    for (let index = 0; index < 199; index++) await f.capacity.createPool(f.context, site.factory.id, draft());
    const counts = () => withTenant(database.db, f.context, async tx => {
      const [value] = await tx.execute<{ roots: number; versions: number; audits: number }>(sql`select
        (select count(*)::int from factory_capacity_pools where factory_id=${site.factory.id}::uuid) as roots,
        (select count(*)::int from factory_capacity_versions where factory_id=${site.factory.id}::uuid) as versions,
        (select count(*)::int from audit_events a join factory_capacity_pools p on p.tenant_id=a.tenant_id and p.id=a.entity_id
          where p.factory_id=${site.factory.id}::uuid and a.action='factory_capacity.pool.create' and a.entity_type='factory_capacity_pool' and a.result='success') as audits`);
      return value!;
    });
    expect(await counts()).toEqual({ roots: 199, versions: 199, audits: 199 });
    const inputs = [draft(), draft()], results = await Promise.allSettled(inputs.map(input => f.capacity.createPool(f.context, site.factory.id, input)));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const winnerIndex = results.findIndex(result => result.status === "fulfilled"), winner = results[winnerIndex]!;
    if (winner.status !== "fulfilled") throw new Error("Synthetic last capacity root did not succeed");
    const loser = results.find(result => result.status === "rejected");
    expect(loser?.status === "rejected" && code(409, "factory_capacity_pool_limit")(loser.reason)).toBe(true);
    expect(await counts()).toEqual({ roots: 200, versions: 200, audits: 200 });
    const beforeReplay = await f.state();
    expect(await f.capacity.createPool(f.context, site.factory.id, inputs[winnerIndex]!)).toEqual(winner.value);
    const value = FactoryCapacityWorkspaceSchema.parse(await f.capacity.workspace(f.context, site.factory.id, { days: 1 }));
    expect(value.pools).toHaveLength(200); expect(value.pools.every(pool => pool.profile.status === "draft")).toBe(true);
    expect(value.pools.some(pool => pool.id === winner.value.id && pool.versionId === winner.value.versionId)).toBe(true);
    expect((await f.capacity.history(f.context, site.factory.id, winner.value.id)).versions).toHaveLength(1);
    expect(await counts()).toEqual({ roots: 200, versions: 200, audits: 200 });
    expect(await f.state()).toEqual(beforeReplay);
  });
  it("pool-limit: raw SQL cannot create a 201st root or leave versions and audit behind", async () => {
    const site = await f.factory();
    for (let index = 0; index < 200; index++) {
      const input = createInput(site);
      await f.capacity.createPool(f.context, site.factory.id, { ...input, profile: { ...input.profile, status: "draft", dailyCapacityUnits: null, bindings: [] } });
    }
    expect((await f.capacity.workspace(f.context, site.factory.id, { days: 1 })).pools).toHaveLength(200);
    const before = await f.state(), poolId = createEntityId(), versionId = createEntityId(), input = createInput(site);
    const checksum = createHash("sha256").update(canonicalJson({ operation: "create", factoryId: site.factory.id, input })).digest("hex");
    await expect(withTenant(database.db, f.context, async tx => {
      // The attempted append is otherwise a complete, correctly bound creation.
      // A missing version or missing audit must not substitute for the root limit.
      await tx.insert(factoryCapacityPools).values({ id: poolId, tenantId: f.context.tenantId, factoryId: site.factory.id, factoryVersionId: input.factoryVersionId,
        code: input.code, timeZone: input.timeZone, unit: input.unit, currentVersionNumber: 1, createdBy: f.context.userId });
      await tx.insert(factoryCapacityVersions).values({ id: versionId, tenantId: f.context.tenantId, factoryId: site.factory.id, poolId,
        versionNumber: 1, profile: input.profile, idempotencyKey: input.idempotencyKey, requestChecksum: checksum, createdBy: f.context.userId });
      await f.audit.recordInTransaction(tx, f.context, { action: "factory_capacity.pool.create", resourceType: "factory_capacity_pool", resourceId: poolId,
        result: "success", metadata: { factoryId: site.factory.id, versionNumber: 1 } });
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toMatchObject({ cause: { code: "23514", message: "factory_capacity_pool_limit" } });
    expect(await f.state()).toEqual(before);
    const [remaining] = await withTenant(database.db, f.context, tx => tx.execute<{ roots: number; versions: number; audits: number }>(sql`select
      (select count(*)::int from factory_capacity_pools where id=${poolId}::uuid) as roots,
      (select count(*)::int from factory_capacity_versions where id=${versionId}::uuid or idempotency_key=${input.idempotencyKey}::uuid) as versions,
      (select count(*)::int from audit_events where entity_id=${poolId}::uuid) as audits`));
    expect(remaining).toEqual({ roots: 0, versions: 0, audits: 0 });
    expect((await f.capacity.workspace(f.context, site.factory.id, { days: 1 })).pools).toHaveLength(200);
  });
});
