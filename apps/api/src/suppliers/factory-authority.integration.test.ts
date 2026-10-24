import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { erpPermissionContext, ForbiddenError, intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { FactoryDirectorySchema, FactoryHistorySchema } from "@yummyai/contracts/suppliers/factory-directory";
import { connectDatabase, fulfillmentSuppliers, fulfillmentFactoryVersions, factoryCapabilityVersions,
  loadCurrentMembershipContext, memberships, roles, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { FactoryDirectoryService } from "./factory-directory.service.js";
import { createSyntheticFactory } from "./factory-directory.test-fixture.js";
import { syntheticFactoryCapability, syntheticFactoryProfile, syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(databaseUrl.pathname)?.[1];
const permittedRunner = process.env.E2E_FACTORY_CAPACITY_ISOLATED === "1"
  ? process.env.E2E_LEGACY_SCHEMA_TARGET === "current"
  : process.env.E2E_FACTORY_AUTHORITY_ISOLATED === "1";
if (process.env.E2E_ISOLATED_DAILY !== "1" || !permittedRunner || !nonce ||
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Factory authority requires a matching authority or current-capacity disposable runner before connecting");
requireDisposableIntegrationEnvironment();

const read = Permission.OrderRead, write = Permission.OrderWrite;
const operations = ["factory_create", "factory_revise", "capability_create", "capability_revise"] as const;
type Operation = typeof operations[number];

describe.sequential("factory directory operation-specific current authority", () => {
  const database = connectDatabase(), audit = new AuditService(database), service = new FactoryDirectoryService(database, audit);
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const actor = (tenant = tenantId) => ({ tenantId: tenant, userId: createEntityId(), membershipId: createEntityId(), roleId: createEntityId(), wideRoleId: createEntityId() });
  const member = actor(), foreign = actor(foreignTenantId), missingUserId = createEntityId();
  const seed: TenantContext = { tenantId, userId: member.userId, permissions: Object.values(Permission), dataScope: "tenant" };
  const foreignSeed: TenantContext = { ...seed, tenantId: foreign.tenantId, userId: foreign.userId };
  const supplierId = createEntityId(), foreignSupplierId = createEntityId();
  let original: Awaited<ReturnType<typeof createSyntheticFactory>>;
  const current = (value = member) => withTenant(database.db, { ...seed, tenantId: value.tenantId, userId: value.userId }, tx =>
    loadCurrentMembershipContext(tx, { ...seed, tenantId: value.tenantId, userId: value.userId }));
  async function grant(primary: readonly string[] = [read, write], scope: "self" | "team" | "tenant" = "tenant", wider: readonly string[] = [], value = member) {
    await withTenant(database.db, { ...seed, tenantId: value.tenantId, userId: value.userId }, async tx => {
      await tx.update(roles).set({ permissions: [...primary], dataScope: scope }).where(eq(roles.id, value.roleId));
      await tx.update(roles).set({ permissions: [...wider], dataScope: "tenant" }).where(eq(roles.id, value.wideRoleId));
      await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, value.membershipId));
    });
  }
  async function state(context = seed) {
    return withTenant(database.db, context, async tx => {
      const result: Record<string, string> = {};
      for (const table of ["fulfillment_factories", "fulfillment_factory_versions", "factory_capabilities", "factory_capability_versions", "audit_events"]) {
        const [row] = await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by item.id)::text,'[]')) as digest from ${sql.raw(table)} item`);
        result[table] = row!.digest;
      }
      return result;
    });
  }
  async function request(kind: Operation) {
    const pair = await createSyntheticFactory(service, seed, supplierId, "other", `Synthetic authority target ${createEntityId()}`);
    const input = { supplierId, code: `AUTH-${randomUUID().toUpperCase()}`, profile: syntheticFactoryProfile(`Synthetic authority new ${createEntityId()}`), idempotencyKey: randomUUID() };
    const revision = { expectedVersion: 1, profile: { ...pair.factory.profile, notes: `Synthetic revised ${createEntityId()}` }, idempotencyKey: randomUUID() };
    const capability = { profile: syntheticFactoryCapability("other"), idempotencyKey: randomUUID() };
    const capabilityRevision = { expectedVersion: 1, profile: { ...pair.capability.profile, specifications: `Synthetic changed ${createEntityId()}` }, idempotencyKey: randomUUID() };
    const call = (context: TenantContext) => {
      switch (kind) {
        case "factory_create": return service.create(context, input);
        case "factory_revise": return service.revise(context, pair.factory.id, revision);
        case "capability_create": return service.createCapability(context, pair.factory.id, capability);
        case "capability_revise": return service.reviseCapability(context, pair.capability.id, capabilityRevision);
      }
    };
    return { call, pair, action: kind === "factory_create" ? "factory.create" : kind === "factory_revise" ? "factory.revise" : "factory_capability.save" };
  }
  beforeAll(async () => {
    for (const value of [member, foreign]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [value.tenantId, `Synthetic factory authority ${value.tenantId}`, `factory-authority-${value.tenantId}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [value.userId, `factory-authority-${value.userId}`, `${value.userId}@example.invalid`, `Synthetic factory member ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      for (const id of [value.roleId, value.wideRoleId]) {
        await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, value.tenantId, `Synthetic factory role ${id}`, JSON.stringify(id === value.roleId ? [read, write] : [])]);
        await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, id]);
      }
    }
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic user without membership')", [missingUserId, `factory-unassigned-${missingUserId}`, `${missingUserId}@example.invalid`]);
    for (const [context, id] of [[seed, supplierId], [foreignSeed, foreignSupplierId]] as const) {
      await withTenant(database.db, context, tx => tx.insert(fulfillmentSuppliers).values({ id, tenantId: context.tenantId,
        name: `Synthetic factory supplier ${id}`, kind: "manual", regionCode: "CN", settlementCurrency: "CNY", profile: syntheticSupplierProfile, createdBy: context.userId }));
    }
    original = await createSyntheticFactory(service, seed, supplierId, "other", "Synthetic original authority factory");
  });
  afterEach(async () => { vi.restoreAllMocks(); await grant(); await grant([read, write], "tenant", [], foreign); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); }); // Immutable fixtures belong to the runner's exact nonce DB.

  it("returns the current canonical authority and operation flags for a real mixed-role member", async () => {
    await grant([write], "self", [read]);
    const ceiling = await current(); expect(ceiling).toMatchObject({ dataScope: "tenant", permissionScopes: { [read]: "tenant", [write]: "self" } });
    const directory = FactoryDirectorySchema.parse(await service.directory(ceiling, { supplier: supplierId }));
    expect(directory.access).toEqual({ canRead: true, canWrite: false });
    expect(directory.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(ceiling)));
    expect(directory.factories.some(row => row.id === original.factory.id)).toBe(true);
    const history = FactoryHistorySchema.parse(await service.history(ceiling, original.factory.id));
    expect(history).toMatchObject({ factoryId: original.factory.id, contextAuthority: directory.contextAuthority, access: directory.access });
  });
  it.each(operations)("rejects %s for tenant Read plus self Write without any version or audit change", async kind => {
    const action = await request(kind); await grant([write], "self", [read]); const ceiling = await current(), before = await state();
    await expect(action.call(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });
  it.each(operations)("permits %s with tenant Write alone while self Read cannot fetch private history", async kind => {
    const action = await request(kind); await grant([read], "self", [write]); const ceiling = await current();
    expect(ceiling).toMatchObject({ dataScope: "tenant", permissionScopes: { [read]: "self", [write]: "tenant" } });
    const saved = await action.call(ceiling); expect(saved.versionId).toMatch(/^[a-f0-9-]{36}$/);
    await expect(service.directory(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.history(ceiling, action.pair.factory.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("does not let a later wider role enlarge the original request ceiling", async () => {
    await grant([read], "tenant"); const ceiling = await current();
    const action = await request("factory_create"); await grant([read, write]); const before = await state();
    await expect(action.call(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });
  it.each(operations)("rechecks live Write before replaying the successful %s key", async kind => {
    const action = await request(kind), ceiling = await current(), saved = await action.call(ceiling);
    await grant([read]); const before = await state();
    await expect(action.call(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
    await grant(); const replay = await action.call(await current());
    expect(replay.versionId).toBe(saved.versionId); expect(await state()).toEqual(before);
  });
  it("blocks a stale tenant Write ceiling after the database narrows that permission to self", async () => {
    const action = await request("factory_revise"), ceiling = await current();
    await grant([write], "self", [read]); const before = await state();
    await expect(action.call(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    const directory = await service.directory(ceiling); expect(directory.access).toEqual({ canRead: true, canWrite: false });
    expect(await state()).toEqual(before);
  });
  it("blocks reads and choices after current Read is revoked even if tenant Write remains", async () => {
    const ceiling = await current(); await grant([write]); const before = await state();
    await expect(service.directory(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.history(ceiling, original.factory.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.choices(ceiling, { productType: "other", productPlanId: null, skuId: null, quantity: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });
  it("rejects a disabled current membership before reads, new writes or exact replay", async () => {
    const action = await request("factory_create"), ceiling = await current(); await action.call(ceiling);
    await withTenant(database.db, seed, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, member.membershipId)));
    const before = await state();
    await expect(service.directory(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.history(ceiling, original.factory.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(action.call(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.create(ceiling, { supplierId, code: `DISABLED-${randomUUID()}`, profile: syntheticFactoryProfile(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });
  it("does not accept a fabricated personal permission map without a real membership", async () => {
    const ceiling = { ...await current(), userId: missingUserId }, before = await state();
    await expect(service.directory(ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.create(ceiling, { supplierId, code: `UNASSIGNED-${randomUUID()}`, profile: syntheticFactoryProfile(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await state()).toEqual(before);
  });
  it("keeps foreign factories and immutable versions hidden under forced RLS with a real foreign membership", async () => {
    const other = await current(foreign), before = await state();
    expect((await service.directory(other)).factories).toEqual([]);
    await expect(service.history(other, original.factory.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revise(other, original.factory.id, { expectedVersion: 1, profile: original.factory.profile, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createCapability(other, original.factory.id, { profile: syntheticFactoryCapability(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect(await withTenant(database.db, other, tx => tx.select().from(fulfillmentFactoryVersions).where(eq(fulfillmentFactoryVersions.id, original.factory.versionId)))).toEqual([]);
    expect(await withTenant(database.db, other, tx => tx.select().from(factoryCapabilityVersions).where(eq(factoryCapabilityVersions.id, original.capability.versionId)))).toEqual([]);
    expect(await state()).toEqual(before);
  });
  it.each(operations)("rolls %s and its audit back together, then exactly replays one immutable success", async kind => {
    const action = await request(kind), ceiling = await current(), before = await state(), record = audit.recordInTransaction.bind(audit);
    const spy = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      if (event.action === action.action) throw new Error("Synthetic factory atomic audit failure");
      return record(tx, context, event);
    });
    try { await expect(action.call(ceiling)).rejects.toThrow("Synthetic factory atomic audit failure"); expect(await state()).toEqual(before); }
    finally { spy.mockRestore(); }
    const successfulAudit = vi.spyOn(audit, "recordInTransaction"), saved = await action.call(ceiling), after = await state();
    expect(saved.versionNumber).toBe(kind.endsWith("revise") ? 2 : 1);
    expect(successfulAudit.mock.calls.filter(([, , event]) => event.action === action.action)).toHaveLength(1);
    expect((await action.call(ceiling)).versionId).toBe(saved.versionId);
    expect(await state()).toEqual(after);
    expect(successfulAudit.mock.calls.filter(([, , event]) => event.action === action.action)).toHaveLength(1);
  });
  it("retains explicit legacy non-membership credential contexts without inventing a membership", async () => {
    expect(seed.permissionScopes).toBeUndefined();
    const directory = FactoryDirectorySchema.parse(await service.directory(seed, { supplier: supplierId }));
    expect(directory.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(intersectPermissionContexts(seed, seed))));
    expect(JSON.parse(directory.contextAuthority)).toMatchObject({ tenantId: seed.tenantId, userId: seed.userId, dataScope: "tenant" });
    const excluded: string[] = [Permission.FactoryTaskRead, Permission.FactoryTaskRespond];
    expect(seed.permissions).toEqual(expect.arrayContaining(excluded));
    expect(JSON.parse(directory.contextAuthority).permissions).toEqual([...seed.permissions].filter(permission => !excluded.includes(permission)).sort());
    expect(directory.access).toEqual({ canRead: true, canWrite: true });
    expect(FactoryHistorySchema.parse(await service.history(seed, original.factory.id)).factoryId).toBe(original.factory.id);
  });
});
