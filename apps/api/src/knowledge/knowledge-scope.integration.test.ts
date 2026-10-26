import { randomUUID } from "node:crypto";
import { Permission, summarizeRoleGrants } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";
import {
  connectDatabase, knowledgeDocuments, loadCurrentMembershipContext, memberships,
  membershipRoles, migrateDatabase, productPlans, roles, spus, withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { KnowledgeService } from "./knowledge.service.js";

requireDisposableIntegrationEnvironment();

const permissions = [Permission.WorkflowRead, Permission.WorkflowManage, Permission.WorkflowApprove, Permission.ProductRead];
type Actor = { context: TenantContext; memberId: string; roleId: string };
const fields = (spuId: string | null): KnowledgeFields => ({
  title: "Synthetic scoped knowledge", summary: "Synthetic permission fixture", body: "Synthetic approved product facts remain authoritative.",
  topic: "operations", platform: "amazon", market: "US", spuId, sourceType: "team", sourceLabel: "Synthetic scope fixture",
  sourceUrl: "", owner: "Synthetic operator", verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", tags: [],
});
const save = (spuId: string | null, expectedRevision = 0) => ({
  fields: fields(spuId), expectedRevision, reason: "Synthetic scope check", requestId: randomUUID(),
});

describe("knowledge current membership and complete product scope", () => {
  let database: DatabaseConnection, service: KnowledgeService;
  let a: Actor, b: Actor, foreign: Actor, self: TenantContext;
  let ownSpu: string, peerSpu: string, foreignSpu: string, ownCard: string, peerCard: string, generalCard: string, mixedCard: string;

  beforeAll(async () => {
    database = connectDatabase();
    await migrateDatabase(database);
    service = new KnowledgeService(database, new AuditService(database));
    a = await actor(); b = await actor(a.context.tenantId); foreign = await actor();
    self = { ...a.context, ...summarizeRoleGrants([{ permissions, scope: "self" }]) };
    ownSpu = await product(a.context); peerSpu = await product(b.context); foreignSpu = await product(foreign.context);
    ownCard = (await service.save(a.context, null, save(ownSpu))).id;
    peerCard = (await service.save(b.context, null, save(peerSpu))).id;
    generalCard = (await service.save(b.context, null, save(null))).id;
    mixedCard = (await service.save(b.context, null, save(peerSpu))).id;
    await service.save(b.context, mixedCard, save(null, 1));
  });
  // The disposable acceptance owner removes the complete database after service closure.
  afterAll(async () => { await database?.client.end(); });

  async function actor(existingTenant?: string): Promise<Actor> {
    const tenantId = existingTenant ?? createEntityId(), userId = createEntityId(), memberId = createEntityId(), roleId = createEntityId();
    if (!existingTenant) await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic knowledge scope',$2)", [tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic knowledge actor')", [userId, randomUUID(), `${userId}@example.invalid`]);
    const base: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
    await withTenant(database.db, base, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId, userId });
      await tx.insert(roles).values({ id: roleId, tenantId, name: `Synthetic knowledge ${userId}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId });
    });
    return { context: await withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base)), memberId, roleId };
  }
  async function product(context: TenantContext) {
    const id = createEntityId(), productPlanId = createEntityId(), customization = { version: 1, fields: [] };
    await withTenant(database.db, context, async tx => {
      await tx.insert(productPlans).values({ id: productPlanId, tenantId: context.tenantId, name: "Synthetic knowledge plan", customization, createdBy: context.userId });
      await tx.insert(spus).values({ id, tenantId: context.tenantId, productPlanId, code: `SCOPE-${id}`, name: "Synthetic knowledge product", customization });
    });
    return id;
  }
  async function snapshot() {
    return withTenant(database.db, a.context, async tx => {
      const result: Record<string, unknown> = {};
      for (const table of ["knowledge_entries", "knowledge_versions", "knowledge_events", "knowledge_evidence_links", "audit_events"])
        result[table] = await tx.execute(sql.raw(`select count(*)::int as count, md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) as checksum from ${table} t`));
      return result;
    });
  }

  it("filters workspace and complete immutable history without exposing a formerly private product as general knowledge", async () => {
    const workspace = await service.workspace(self);
    expect(workspace.spus.map(value => value.id)).toEqual([ownSpu]);
    expect(new Set(workspace.entries.map(value => value.id))).toEqual(new Set([ownCard, generalCard]));
    expect((await service.history(self, ownCard)).versions).toHaveLength(1);
    for (const id of [peerCard, mixedCard]) await expect(service.history(self, id)).rejects.toMatchObject({ status: 404 });
    expect((await service.history(a.context, mixedCard)).versions.map(value => value.spuId)).toEqual([null, peerSpu]);
    await expect(service.history(foreign.context, ownCard)).rejects.toMatchObject({ status: 404 });
  });

  it("checks existing and proposed product scopes and reference provenance before any new version event or audit", async () => {
    const documentId = createEntityId();
    await withTenant(database.db, b.context, tx => tx.insert(knowledgeDocuments).values({
      id: documentId, tenantId: b.context.tenantId, kind: "reference", fileName: "synthetic.txt", mediaType: "text/plain", checksum: "a".repeat(64),
      rawExpiresAt: new Date("2099-12-31T00:00:00Z"), state: "confirmed", diagnostics: [], fields: fields(peerSpu),
      createdBy: b.context.userId, requestId: randomUUID(), requestChecksum: "b".repeat(64),
    }));
    const before = await snapshot();
    for (const spuId of [peerSpu, foreignSpu]) await expect(service.save(self, null, save(spuId))).rejects.toMatchObject({ status: 404 });
    await expect(service.save(self, peerCard, save(null, 1))).rejects.toMatchObject({ status: 404 });
    await expect(service.save(self, ownCard, save(peerSpu, 1))).rejects.toMatchObject({ status: 404 });
    const payload = save(ownSpu); payload.fields.documentIds = [documentId];
    await expect(service.save(self, null, payload)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
  });

  it("applies the same product scope to every transition while preserving explicit review and approval permissions", async () => {
    const before = await snapshot();
    for (const action of ["submit", "publish", "reject", "disable", "archive"] as const)
      await expect(service.change(self, peerCard, action, { expectedRevision: 1, version: 1, reason: "Synthetic denied transition", requestId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    const manager = { ...self, ...summarizeRoleGrants([{ permissions: [Permission.WorkflowRead, Permission.WorkflowManage, Permission.ProductRead], scope: "self" }]) };
    const created = await service.save(manager, null, save(ownSpu));
    const submit = { expectedRevision: 1, version: 1, reason: "Synthetic explicit submit", requestId: randomUUID() };
    await service.change(manager, created.id, "submit", submit);
    const publish = { expectedRevision: 2, version: 1, reason: "Synthetic explicit publish", requestId: randomUUID() };
    await expect(service.change(manager, created.id, "publish", publish)).rejects.toThrow();
    await service.change(self, created.id, "publish", publish);
    expect((await service.workspace(self)).entries.find(entry => entry.id === created.id)?.activeVersion).toBe(1);
    await expect(service.change(manager, created.id, "archive", { expectedRevision: 3, version: 1, reason: "Synthetic denied live archive", requestId: randomUUID() })).rejects.toThrow();
    const reviewer = { ...self, ...summarizeRoleGrants([{ permissions: [Permission.WorkflowRead, Permission.WorkflowApprove, Permission.ProductRead], scope: "self" }]) };
    await expect(service.save(reviewer, null, save(ownSpu))).rejects.toThrow();
  });

  it("rechecks current membership and both old-key replay paths after scope narrowing or product permission revocation", async () => {
    const actorValue = await actor(a.context.tenantId), old = actorValue.context;
    const spuId = await product(old), payload = save(spuId), card = await service.save(old, null, payload);
    const submit = { expectedRevision: 1, version: 1, reason: "Synthetic replay scope", requestId: randomUUID() };
    await service.change(old, card.id, "submit", submit);
    await withTenant(database.db, a.context, tx => tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, actorValue.roleId)));
    expect((await service.workspace(old)).entries.some(entry => entry.id === peerCard)).toBe(false);
    expect(await service.save(old, null, payload)).toEqual(card);
    expect(await service.change(old, card.id, "submit", submit)).toEqual({ id: card.id });
    await withTenant(database.db, a.context, tx => tx.update(roles).set({ permissions: permissions.filter(value => value !== Permission.ProductRead) }).where(eq(roles.id, actorValue.roleId)));
    const before = await snapshot();
    expect((await service.workspace(old)).entries.some(entry => entry.id === card.id)).toBe(false);
    await expect(service.history(old, card.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.save(old, null, payload)).rejects.toMatchObject({ status: 404 });
    await expect(service.change(old, card.id, "submit", submit)).rejects.toMatchObject({ status: 404 });
    expect(await snapshot()).toEqual(before);
    await withTenant(database.db, a.context, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, actorValue.memberId)));
    await expect(service.workspace(old)).rejects.toThrow();
    await expect(service.history(old, generalCard)).rejects.toThrow();
    await expect(service.save(old, null, save(null))).rejects.toThrow();
    await expect(service.change(old, generalCard, "submit", submit)).rejects.toThrow();
  });

  it("retains the existing general-card collaborator and author approval rules rather than manufacturing new role rights", async () => {
    const value = await service.save(b.context, null, save(null));
    await service.change(b.context, value.id, "submit", { expectedRevision: 1, version: 1, reason: "Synthetic collaborator submit", requestId: randomUUID() });
    await service.change(self, value.id, "publish", { expectedRevision: 2, version: 1, reason: "Synthetic authorized reviewer", requestId: randomUUID() });
    expect((await service.history(self, value.id)).events.map(event => event.action)).toContain("publish");
    await service.change(self, value.id, "disable", { expectedRevision: 3, version: 1, reason: "Synthetic reviewer withdrawal", requestId: randomUUID() });
    expect((await service.workspace(self)).entries.find(entry => entry.id === value.id)?.activeVersion).toBeNull();
  });
});
