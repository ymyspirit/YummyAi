import { randomUUID } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { Permission, summarizeRoleGrants } from "@yummyai/authz";
import { catalogContextAuthority } from "@yummyai/catalog-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, loadCurrentMembershipContext, memberships, membershipRoles,
  migrateDatabase, organizationTeamMembers, organizationTeams, productPlans, roles,
  spus, withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { KnowledgeController } from "./knowledge.controller.js";
import { KnowledgeService } from "./knowledge.service.js";

requireDisposableIntegrationEnvironment();

type Actor = { context: TenantContext; memberId: string; roleId: string };
const permissions = [Permission.WorkflowRead, Permission.ProductRead];

describe("bounded knowledge product scope candidates", () => {
  let database: DatabaseConnection, service: KnowledgeService;
  let a: Actor, teammate: Actor, outsider: Actor, foreign: Actor, teamId: string;
  let own: string, shared: string, unrelated: string, foreignSpu: string;
  let self: TenantContext, team: TenantContext;
  const prefix = `KPO-${randomUUID()}`;

  beforeAll(async () => {
    database = connectDatabase();
    await migrateDatabase(database);
    service = new KnowledgeService(database, new AuditService(database));
    a = await actor();
    teammate = await actor(a.context.tenantId);
    outsider = await actor(a.context.tenantId);
    foreign = await actor();
    teamId = createEntityId();
    await withTenant(database.db, a.context, async tx => {
      await tx.insert(organizationTeams).values({
        id: teamId, tenantId: a.context.tenantId, name: prefix, createdBy: a.context.userId,
      });
      await tx.insert(organizationTeamMembers).values([a, teammate].map(value => ({
        id: createEntityId(), tenantId: a.context.tenantId, teamId,
        membershipId: value.memberId, createdBy: a.context.userId,
      })));
    });
    a.context = await current(a);
    self = { ...a.context, ...summarizeRoleGrants([{ permissions, scope: "self" }]) };
    team = { ...a.context, ...summarizeRoleGrants([{ permissions, scope: "team" }]) };
    own = await product(a.context, `${prefix}-OWN`, "Synthetic own");
    shared = await product(teammate.context, `${prefix}-TEAM`, "Synthetic teammate", { teamId });
    unrelated = await product(outsider.context, `${prefix}-OTHER`, "Synthetic other");
    foreignSpu = await product(foreign.context, `${prefix}-FOREIGN`, "Synthetic foreign");
  });
  // The acceptance runner owns and verifies removal of this complete disposable database.
  afterAll(async () => { await database?.client.end(); });

  async function current(value: Actor) {
    return withTenant(database.db, value.context, tx => loadCurrentMembershipContext(tx, value.context));
  }
  async function actor(existingTenant?: string): Promise<Actor> {
    const tenantId = existingTenant ?? createEntityId(), userId = createEntityId();
    if (!existingTenant) await database.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic knowledge options',$2)",
      [tenantId, randomUUID()],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic options actor')",
      [userId, randomUUID(), `${userId}@example.invalid`],
    );
    const base: TenantContext = { tenantId, userId, dataScope: "tenant", permissions };
    const memberId = createEntityId(), roleId = createEntityId();
    await withTenant(database.db, base, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId, userId });
      await tx.insert(roles).values({ id: roleId, tenantId, name: `Synthetic options ${userId}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId });
    });
    return { context: await withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base)), memberId, roleId };
  }
  async function product(
    context: TenantContext, code: string, name: string,
    options: { teamId?: string; archivedPlan?: boolean; archivedSpu?: boolean } = {},
  ) {
    const id = createEntityId(), planId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(productPlans).values({
        id: planId, tenantId: context.tenantId, name: `Synthetic ${code}`, customization: { version: 1, fields: [] },
        createdBy: context.userId, teamId: options.teamId,
        status: options.archivedPlan ? "archived" : "developing",
      });
      await tx.insert(spus).values({
        id, tenantId: context.tenantId, productPlanId: planId, code, name, customization: { version: 1, fields: [] },
        status: options.archivedSpu ? "archived" : "developing",
      });
    });
    return id;
  }
  async function snapshot() {
    return withTenant(database.db, a.context, async tx => {
      const values: Record<string, unknown> = {};
      for (const table of ["product_plans", "spus", "knowledge_entries", "knowledge_versions", "knowledge_events", "audit_events"])
        values[table] = await tx.execute(sql.raw(
          `select count(*)::int as count, md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as checksum from ${table} t`,
        ));
      return values;
    });
  }

  it("uses current self/team/tenant object scope and never returns foreign products or knowledge bodies", async () => {
    const before = await snapshot();
    const ownResult = await service.productOptions(self, { q: prefix });
    expect(ownResult.items.map(value => value.id)).toEqual([own]);
    expect(ownResult.contextAuthority).toBe(catalogContextAuthority(self));
    expect(new Set((await service.productOptions(team, { q: prefix })).items.map(value => value.id)))
      .toEqual(new Set([own, shared]));
    const tenantResult = await service.productOptions(a.context, { q: prefix });
    expect(new Set(tenantResult.items.map(value => value.id))).toEqual(new Set([own, shared, unrelated]));
    expect(tenantResult.items.some(value => value.id === foreignSpu)).toBe(false);
    expect((await service.productOptions(a.context, { q: `${prefix}-FOREIGN` })).items).toEqual([]);
    expect(Object.keys(tenantResult).sort()).toEqual(["contextAuthority", "hasMore", "items", "limit"]);
    expect(tenantResult.items.every(value => Object.keys(value).sort().join() === "code,id,name")).toBe(true);
    expect(await snapshot()).toEqual(before);
  });

  it("treats percent, underscore and backslash literally in code/name searches", async () => {
    const id = await product(a.context, `${prefix}-LITERAL-%_\\`, "Synthetic literal name");
    await product(a.context, `${prefix}-LITERAL-xy`, "Synthetic wildcard decoy");
    expect((await service.productOptions(self, { q: "  literal-%_\\  " })).items.map(value => value.id)).toEqual([id]);
    expect((await service.productOptions(self, { q: "SYNTHETIC LITERAL NAME" })).items.map(value => value.id)).toEqual([id]);
  });

  it("returns the first 40 in stable code/id order and explicitly reports the 41st", async () => {
    const pagePrefix = `${prefix}-PAGE`;
    for (let index = 40; index >= 0; index--)
      await product(a.context, `${pagePrefix}-${index.toString().padStart(2, "0")}`, "Synthetic bounded candidate");
    const first = await service.productOptions(self, { q: pagePrefix });
    expect(first.limit).toBe(40);
    expect(first.hasMore).toBe(true);
    expect(first.items.map(value => value.code)).toEqual(Array.from({ length: 40 }, (_, index) => `${pagePrefix}-${index.toString().padStart(2, "0")}`));
    expect(await service.productOptions(self, { q: pagePrefix })).toEqual(first);
    expect((await service.productOptions(self, { q: `${pagePrefix}-40` })).hasMore).toBe(false);
  });

  it("excludes archived SPUs and products under archived plans", async () => {
    const query = `${prefix}-ARCHIVE`;
    const active = await product(a.context, `${query}-ACTIVE`, "Synthetic active");
    await product(a.context, `${query}-SPU`, "Synthetic archived SPU", { archivedSpu: true });
    await product(a.context, `${query}-PLAN`, "Synthetic archived plan", { archivedPlan: true });
    expect((await service.productOptions(self, { q: query })).items.map(value => value.id)).toEqual([active]);
  });

  it("intersects fresh membership grants with the session ceiling after a role downgrade", async () => {
    const value = await actor(a.context.tenantId), query = `${prefix}-NARROW`;
    const ownId = await product(value.context, `${query}-OWN`, "Synthetic narrowed own");
    await product(a.context, `${query}-OTHER`, "Synthetic narrowed other");
    const old = value.context;
    await withTenant(database.db, a.context, tx => tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, value.roleId)));
    const response = await service.productOptions(old, { q: query });
    expect(response.items.map(item => item.id)).toEqual([ownId]);
    expect(response.contextAuthority).toBe(catalogContextAuthority(await current(value)));
    expect(response.contextAuthority).not.toBe(catalogContextAuthority(old));
  });

  it("requires both permissions and rejects revoked grants or an inactive current membership", async () => {
    for (const missing of permissions) {
      const limited = { ...a.context, ...summarizeRoleGrants([{ permissions: permissions.filter(p => p !== missing), scope: "tenant" }]) };
      await expect(service.productOptions(limited, {})).rejects.toThrow();
      const value = await actor(a.context.tenantId);
      await withTenant(database.db, a.context, tx => tx.update(roles).set({ permissions: permissions.filter(p => p !== missing) }).where(eq(roles.id, value.roleId)));
      await expect(service.productOptions(value.context, {})).rejects.toThrow();
    }
    const disabled = await actor(a.context.tenantId);
    await withTenant(database.db, a.context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, disabled.memberId)));
    await expect(service.productOptions(disabled.context, {})).rejects.toThrow();
  });

  it("rejects unknown, duplicate and malformed query values before calling the product owner", async () => {
    const controller = new KnowledgeController(service), call = vi.spyOn(service, "productOptions");
    try {
      for (const raw of [{ q: ["one", "two"] }, { q: "x".repeat(201) }, { unknown: "one" }]) {
        expect(() => controller.productOptions({ headers: {}, tenantContext: a.context }, raw)).toThrow(BadRequestException);
        await expect(service.productOptions(a.context, raw)).rejects.toBeInstanceOf(BadRequestException);
      }
      call.mockClear();
      for (const originalUrl of ["/v1/knowledge/product-options?q=one&q=two", "/v1/knowledge/product-options?q=one&unknown=two"])
        expect(() => controller.productOptions({ headers: {}, tenantContext: a.context, originalUrl }, { q: "one" })).toThrow(BadRequestException);
      expect(call).not.toHaveBeenCalled();
    } finally { call.mockRestore(); }
  });
});
