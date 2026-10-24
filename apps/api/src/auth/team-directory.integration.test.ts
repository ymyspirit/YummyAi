import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  memberships,
  membershipRoles,
  roles,
  organizationTeamMembers,
  organizationTeamCommands,
  organizationTeams,
  productPlans,
} from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { TeamDirectoryService } from "./team-directory.service.js";
import { DatabaseMembershipContextLoader } from "./tenant-context.guard.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { ProductDevelopmentService } from "../catalog/product-development.service.js";
import type { Storage } from "@yummyai/storage";
if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw Error("Disposable team integration required");

describe("trusted teams and catalog scope", () => {
  const database = connectDatabase(),
    teams = new TeamDirectoryService(database),
    loader = new DatabaseMembershipContextLoader(database),
    catalog = new ProductService(new DrizzleCatalogRepository(database)),
    development = new ProductDevelopmentService(database, {} as Storage);
  beforeAll(() => migrateDatabase(database));
  afterAll(() => database.client.end());
  const request = (extra: Record<string, unknown> = {}) => ({
    requestId: randomUUID(),
    reason: "Synthetic team access test",
    ...extra,
  });
  async function fixture() {
    const tenantId = createEntityId(),
      adminId = createEntityId(),
      subject = randomUUID(),
      memberId = createEntityId(),
      roleId = createEntityId();
    const seed: TenantContext = {
      tenantId,
      userId: adminId,
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    await database.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic team tenant',$2)",
      [tenantId, randomUUID()],
    );
    async function person(
      userId: string,
      sub: string,
      rights: string[],
      scope: "self" | "team" | "tenant",
      fixedMember?: string,
      fixedRole?: string,
    ) {
      const membershipId = fixedMember ?? createEntityId(),
        role = fixedRole ?? createEntityId();
      await database.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,$4)",
        [userId, sub, `${userId}@example.invalid`, "Synthetic member " + userId.slice(-6)],
      );
      await withTenant(database.db, seed, async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, tenantId, userId, status: "active" });
        await tx
          .insert(roles)
          .values({
            id: role,
            tenantId,
            name: randomUUID(),
            permissions: rights,
            dataScope: scope,
          });
        await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId: role });
      });
      return {
        userId,
        membershipId,
        roleId: role,
        current: async () => {
          const c = await loader.load({ sub, tenant_id: tenantId });
          if (!c) throw Error("Synthetic member missing");
          return c;
        },
      };
    }
    const adminActor = await person(
        adminId,
        subject,
        Object.values(Permission),
        "tenant",
        memberId,
        roleId,
      ),
      admin = await adminActor.current();
    const rights = [
      Permission.ProductRead,
      Permission.ProductWrite,
      Permission.DesignRead,
      Permission.DesignReview,
      Permission.AssetRead,
    ];
    const a = await person(createEntityId(), randomUUID(), rights, "team"),
      b = await person(createEntityId(), randomUUID(), rights, "team"),
      c = await person(createEntityId(), randomUUID(), rights, "team");
    const first = await teams.create(admin, request({ name: "Team A " + randomUUID() })),
      second = await teams.create(admin, request({ name: "Team B " + randomUUID() }));
    await teams.setMember(
      admin,
      first.id,
      request({ membershipId: a.membershipId, active: true, expectedRevision: null }),
    );
    await teams.setMember(
      admin,
      first.id,
      request({ membershipId: b.membershipId, active: true, expectedRevision: null }),
    );
    await teams.setMember(
      admin,
      second.id,
      request({ membershipId: c.membershipId, active: true, expectedRevision: null }),
    );
    const plan = await catalog.createPlan(admin, {
        name: "Team A plan",
        teamId: first.id,
        sourceReportIds: [],
        customization: { version: 1, fields: [] },
      }),
      other = await catalog.createPlan(admin, {
        name: "Team B plan",
        teamId: second.id,
        sourceReportIds: [],
        customization: { version: 1, fields: [] },
      });
    return { tenantId, admin, adminActor, a, b, c, first, second, plan, other };
  }
  it("loads actual active team relationships and permits only the matching team's product", async () => {
    const f = await fixture(),
      a = await f.a.current(),
      c = await f.c.current();
    expect(a.teamIds).toEqual([f.first.id]);
    expect(a.teamAuthority).toMatch(/^[a-f0-9]{64}$/);
    expect((await catalog.listPlans(a)).map((p) => p.id)).toEqual([f.plan.id]);
    expect((await catalog.listPlans(c)).map((p) => p.id)).toEqual([f.other.id]);
    await expect(
      catalog.updateCustomization(a, f.plan.id, { customization: { version: 1, fields: [] } }),
    ).resolves.toMatchObject({ id: f.plan.id });
    await expect(
      catalog.updateCustomization(a, f.other.id, { customization: { version: 1, fields: [] } }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("keeps self writes narrower than a broad read role even for a current teammate", async () => {
    const f = await fixture();
    await withTenant(database.db, f.admin, async (tx) => {
      await tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, f.a.roleId));
      const roleId = createEntityId();
      await tx
        .insert(roles)
        .values({
          id: roleId,
          tenantId: f.tenantId,
          name: randomUUID(),
          permissions: [Permission.ProductRead],
          dataScope: "tenant",
        });
      await tx
        .insert(membershipRoles)
        .values({ tenantId: f.tenantId, membershipId: f.a.membershipId, roleId });
    });
    const a = await f.a.current();
    expect((await catalog.listPlans(a)).length).toBe(2);
    await expect(
      catalog.updateCustomization(a, f.plan.id, { customization: { version: 1, fields: [] } }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("invalidates a captured context on removal and prevents old responses or re-addition from reviving it", async () => {
    const f = await fixture(),
      before = await f.a.current();
    const original = (await teams.workspace(f.admin, {})).teams
      .find((t) => t.id === f.first.id)!
      .members.find((m) => m.membershipId === f.a.membershipId)!;
    await teams.setMember(
      f.admin,
      f.first.id,
      request({
        membershipId: f.a.membershipId,
        active: false,
        expectedRevision: original.revision,
      }),
    );
    expect((await f.a.current()).teamIds).toEqual([]);
    await expect(catalog.listPlans(before)).rejects.toMatchObject({ status: 409 });
    await teams.setMember(
      f.admin,
      f.first.id,
      request({
        membershipId: f.a.membershipId,
        active: true,
        expectedRevision: original.revision + 1,
      }),
    );
    const after = await f.a.current();
    expect(after.teamIds).toEqual(before.teamIds);
    expect(after.teamAuthority).not.toBe(before.teamAuthority);
    await expect(catalog.listPlans(before)).rejects.toMatchObject({ status: 409 });
  });
  it("retains idempotent member commands without replaying an obsolete grant", async () => {
    const f = await fixture(),
      add = request({ membershipId: f.c.membershipId, active: true, expectedRevision: null });
    const applied = await teams.setMember(f.admin, f.first.id, add);
    expect((await teams.setMember(f.admin, f.first.id, add)).replayed).toBe(true);
    await teams.setMember(
      f.admin,
      f.first.id,
      request({
        membershipId: f.c.membershipId,
        active: false,
        expectedRevision: applied.revision,
      }),
    );
    await teams.setMember(f.admin, f.first.id, add);
    expect((await f.c.current()).teamIds).toEqual([f.second.id]);
    const [relation] = await withTenant(database.db, f.admin, (tx) =>
      tx
        .select()
        .from(organizationTeamMembers)
        .where(
          and(
            eq(organizationTeamMembers.teamId, f.first.id),
            eq(organizationTeamMembers.membershipId, f.c.membershipId),
          ),
        ),
    );
    expect(relation?.active).toBe(false);
    await expect(
      teams.setMember(f.admin, f.first.id, { ...add, active: false }),
    ).rejects.toMatchObject({ status: 409 });
    const rows = await withTenant(database.db, f.admin, (tx) =>
      tx
        .select()
        .from(organizationTeamCommands)
        .where(eq(organizationTeamCommands.requestId, add.requestId)),
    );
    expect(rows).toHaveLength(1);
    await expect(
      withTenant(database.db, f.admin, (tx) =>
        tx
          .update(organizationTeamCommands)
          .set({ requestHash: "a".repeat(64) })
          .where(eq(organizationTeamCommands.id, rows[0]!.id)),
      ),
    ).rejects.toBeDefined();
  });
  it("keeps renames and unchanged membership harmless but invalidates archive and re-enable", async () => {
    const f = await fixture(),
      before = await f.a.current();
    const base = (await teams.workspace(f.admin, {})).teams.find((t) => t.id === f.first.id)!;
    const renamed = await teams.update(
      f.admin,
      base.id,
      request({ name: base.name + " renamed", status: "active", expectedRevision: base.revision }),
    );
    expect((await f.a.current()).teamAuthority).toBe(before.teamAuthority);
    const relation = base.members.find((m) => m.membershipId === f.a.membershipId)!;
    const unchanged = await teams.setMember(
      f.admin,
      base.id,
      request({
        membershipId: f.a.membershipId,
        active: true,
        expectedRevision: relation.revision,
      }),
    );
    expect(unchanged.revision).toBe(relation.revision);
    expect((await f.a.current()).teamAuthority).toBe(before.teamAuthority);
    const archived = await teams.update(
      f.admin,
      base.id,
      request({
        name: base.name + " renamed",
        status: "archived",
        expectedRevision: renamed.revision,
      }),
    );
    expect((await f.a.current()).teamIds).toEqual([]);
    await teams.update(
      f.admin,
      base.id,
      request({
        name: base.name + " renamed",
        status: "active",
        expectedRevision: archived.revision,
      }),
    );
    expect((await f.a.current()).teamIds).toEqual(before.teamIds);
    expect((await f.a.current()).teamAuthority).not.toBe(before.teamAuthority);
    await expect(catalog.listPlans(before)).rejects.toMatchObject({ status: 409 });
  });
  it("conflicts on concurrent or stale management updates and denies non-managers", async () => {
    const f = await fixture(),
      base = (await teams.workspace(f.admin, {})).teams.find((t) => t.id === f.first.id)!;
    const results = await Promise.allSettled([
      teams.update(
        f.admin,
        base.id,
        request({ name: base.name, status: "archived", expectedRevision: base.revision }),
      ),
      teams.update(
        f.admin,
        base.id,
        request({
          name: base.name + " changed",
          status: "active",
          expectedRevision: base.revision,
        }),
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    await expect(
      teams.create(await f.a.current(), request({ name: "Denied" })),
    ).rejects.toMatchObject({ status: 403 });
    await expect(teams.workspace(f.admin, { tenantId: createEntityId() })).rejects.toBeDefined();
  });
  it("filters SPU options and prevents a foreign team's mutation, including a cached request", async () => {
    const f = await fixture(),
      key = randomUUID();
    const created = await development.createSpu(f.admin, {
      code: "TEAM-" + randomUUID().slice(0, 8),
      name: "Scoped physical item",
      teamId: f.first.id,
      idempotencyKey: key,
    });
    const a = await f.a.current(),
      c = await f.c.current();
    expect((await development.options(a)).spus.map((s) => s.id)).toContain(created.spu.id);
    expect((await development.options(c)).spus.map((s) => s.id)).not.toContain(created.spu.id);
    await expect(
      development.updateSpu(c, created.spu.id, {
        code: created.spu.code,
        name: "Forbidden update",
        expectedRevision: "a".repeat(64),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const selected = (await development.options(a)).spus.find((s) => s.id === created.spu.id)!;
    const original = {
      code: selected.code,
      name: "Team scoped update",
      expectedRevision: selected.revision!,
      idempotencyKey: randomUUID(),
    };
    await development.updateSpu(a, selected.id, original);
    const membership = (await teams.workspace(f.admin, {})).teams
      .find((t) => t.id === f.first.id)!
      .members.find((m) => m.membershipId === f.a.membershipId)!;
    await teams.setMember(
      f.admin,
      f.first.id,
      request({
        membershipId: f.a.membershipId,
        active: false,
        expectedRevision: membership.revision,
      }),
    );
    await expect(development.updateSpu(a, selected.id, original)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      development.updateSpu(await f.a.current(), selected.id, original),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("never manufactures team ownership for legacy products or accepts another tenant's team", async () => {
    const f = await fixture(),
      other = await fixture();
    const legacy = await catalog.createPlan(f.admin, {
      name: "Legacy unassigned",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    expect((await catalog.listPlans(await f.a.current())).some((p) => p.id === legacy.id)).toBe(
      false,
    );
    const [record] = await withTenant(database.db, f.admin, (tx) =>
      tx.select().from(productPlans).where(eq(productPlans.id, legacy.id)),
    );
    expect(record?.teamId).toBeNull();
    await expect(
      catalog.createPlan(f.admin, {
        name: "Foreign team injection",
        teamId: other.first.id,
        sourceReportIds: [],
        customization: { version: 1, fields: [] },
      }),
    ).rejects.toMatchObject({ status: 404 });
    const rows = await withTenant(database.db, f.admin, (tx) =>
      tx.select().from(organizationTeams).where(eq(organizationTeams.id, other.first.id)),
    );
    expect(rows).toEqual([]);
    expect(createHash("sha256").update("[]").digest("hex")).not.toBe(
      (await f.a.current()).teamAuthority,
    );
  });
});
