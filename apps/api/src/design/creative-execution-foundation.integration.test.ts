import { randomUUID } from "node:crypto";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { captureCreativeExecutionAuthority, connectDatabase, creativeExecutions, creativeExecutionChecksum, creativeStudioGenerations,
  currentCreativeExecutionAuthority, loadCurrentMembershipContext, migrateDatabase, roles, withTenant } from "@yummyai/database";
import { selectPodMethod } from "@yummyai/pod-core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname))
  throw new Error("Creative execution tests require the disposable acceptance runner");

describe("creative execution immutable input in real tenant transactions", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), otherTenant = createEntityId(), otherUser = createEntityId(), roleId = createEntityId();
  const all = Object.values(Permission), base: TenantContext = { tenantId, userId, permissions: all, dataScope: "tenant" };
  const outside = { ...base, tenantId: otherTenant, userId: otherUser };
  const identity = { tenantId, userId };
  const current = () => withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, identity));
  async function grant(permissions: readonly string[] = all, dataScope: "tenant" | "self" = "self") {
    await withTenant(database.db, base, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, roleId)));
  }
  async function generation(context = base) {
    const id = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId, ownerId: context.userId,
      scope: "unassigned", requestId: randomUUID(), input: StudioGenerateSchema.parse({ requestId: randomUUID(), modelId: createEntityId(), prompt: "Synthetic execution foundation" }),
      references: [], modelSnapshot: { providerConfigId: createEntityId(), model: "synthetic-no-call", capability: "image" } }));
    return id;
  }
  async function record() {
    const studioGenerationId = await generation(), context = await current();
    return withTenant(database.db, context, async tx => {
      const captured = await captureCreativeExecutionAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      const method = await selectPodMethod(tx, captured.authority, "text_to_image");
      const [row] = await tx.insert(creativeExecutions).values({ id: createEntityId(), tenantId, kind: "studio_generation", studioGenerationId, stepKey: "generate",
        requestedBy: userId, authoritySnapshot: captured.snapshot, authorityChecksum: captured.checksum,
        inputFingerprint: creativeExecutionChecksum({ studioGenerationId, purpose: "synthetic" }), executionContract: method.executionContract, methodSelection: method.methodSelection, effect: "external_request" }).returning();
      return row!;
    });
  }
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const [org, user] of [[tenantId, userId], [otherTenant, otherUser]]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic creative execution',$2)", [org!, `execution-${org}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic execution actor')", [user!, `execution-${user}`, `${user}@example.test`]);
    }
    const membershipId = createEntityId();
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membershipId, tenantId, userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,'Execution operator',$3::jsonb,'self')", [roleId, tenantId, JSON.stringify(all)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, membershipId, roleId]);
  });
  beforeEach(() => grant());
  afterAll(() => database.client.end());

  it("keeps original narrow authority after later role expansion", async () => {
    const original = await record(); await grant(all, "tenant");
    const authority = await withTenant(database.db, base, tx => currentCreativeExecutionAuthority(tx, identity, original, [Permission.DesignWrite]));
    authorize(authority, Permission.DesignWrite, { ownerId: userId });
    expect(() => authorize(authority, Permission.DesignWrite, { ownerId: otherUser })).toThrow();
    expect(original.authoritySnapshot.context.permissionScopes?.[Permission.DesignWrite]).toBe("self");
  });
  it("rejects current revocation and mismatched original actors", async () => {
    const original = await record(); await grant([Permission.DesignRead, Permission.AssetRead]);
    await expect(withTenant(database.db, base, tx => currentCreativeExecutionAuthority(tx, identity, original, [Permission.DesignWrite]))).rejects.toMatchObject({ status: 403 });
    await expect(withTenant(database.db, base, tx => currentCreativeExecutionAuthority(tx, { tenantId, userId: otherUser }, original, [Permission.DesignRead]))).rejects.toMatchObject({ status: 403 });
  });
  it("does not turn a server adapter ceiling into an invented membership", async () => {
    const captured = await withTenant(database.db, outside, tx => captureCreativeExecutionAuthority(tx, outside, [Permission.DesignRead]));
    await expect(withTenant(database.db, outside, tx => currentCreativeExecutionAuthority(tx, outside, { tenantId: otherTenant, requestedBy: otherUser, authoritySnapshot: captured.snapshot, authorityChecksum: captured.checksum }, [Permission.DesignRead]))).rejects.toMatchObject({ status: 403 });
  });
  it("forces tenant isolation and original-owner foreign keys", async () => {
    const original = await record();
    expect(await withTenant(database.db, outside, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, original.id)))).toEqual([]);
    await expect(withTenant(database.db, outside, tx => tx.insert(creativeExecutions).values({ ...original, id: createEntityId() }))).rejects.toThrow();
    const foreignId = await generation(outside);
    await expect(withTenant(database.db, base, tx => tx.insert(creativeExecutions).values({ ...original, id: createEntityId(), studioGenerationId: foreignId }))).rejects.toThrow();
  });
  it("prevents rewriting authority, original method, actor or fingerprint", async () => {
    const original = await record();
    for (const patch of [{ authorityChecksum: "b".repeat(64) }, { inputFingerprint: "c".repeat(64) }, { requestedBy: otherUser }, { executionContract: { ...original.executionContract, executorKey: "injected.tool" } }])
      await expect(withTenant(database.db, base, tx => tx.update(creativeExecutions).set(patch).where(eq(creativeExecutions.id, original.id)))).rejects.toThrow();
    const [preserved] = await withTenant(database.db, base, tx => tx.select().from(creativeExecutions).where(eq(creativeExecutions.id, original.id)));
    expect(preserved!.authorityChecksum).toBe(original.authorityChecksum);
  });
  it("rejects incomplete authority and paid/completed state without original evidence", async () => {
    const original = await record();
    for (const patch of [{ submittedAt: new Date() }, { phase: "completed" as const }, { responseObjectKey: "foreign/raw-response" }])
      await expect(withTenant(database.db, base, tx => tx.update(creativeExecutions).set(patch).where(eq(creativeExecutions.id, original.id)))).rejects.toThrow();
    await expect(withTenant(database.db, base, tx => tx.insert(creativeExecutions).values({ ...original, id: createEntityId(), stepKey: "invalid", authoritySnapshot: {} as typeof original.authoritySnapshot }))).rejects.toThrow();
  });
});
