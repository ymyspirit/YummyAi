import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  loadCurrentMembershipContext,
  withTenant,
  memberships,
  membershipRoles,
  roles,
} from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { DrizzleCatalogRepository, ProductService } from "./product.service.js";
import { CustomProductPackageService } from "./custom-product-package.service.js";
import { CustomProductProfileV1Schema } from "@yummyai/contracts/catalog/custom-product-package";
import type { Storage } from "@yummyai/storage";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw Error("Disposable product authority integration required");

describe("product permissions and current role scope", () => {
  const database = connectDatabase(),
    loader = new DatabaseMembershipContextLoader(database),
    service = new ProductService(new DrizzleCatalogRepository(database));
  beforeAll(() => migrateDatabase(database));
  afterAll(() => database.client.end());
  const planInput = (name: string) => ({
    name,
    sourceReportIds: [createEntityId()],
    customization: { version: 1, fields: [] },
  });

  async function fixture() {
    const tenantId = createEntityId(),
      subject = randomUUID(),
      userId = createEntityId(),
      otherId = createEntityId(),
      memberId = createEntityId();
    const admin: TenantContext = {
      tenantId,
      userId,
      dataScope: "tenant",
      permissions: [Permission.ProductRead, Permission.ProductWrite],
    };
    await database.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic product authority',$2)",
      [tenantId, randomUUID()],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic A'),($4,$5,$6,'Synthetic B')",
      [
        userId,
        subject,
        `${userId}@example.invalid`,
        otherId,
        randomUUID(),
        `${otherId}@example.invalid`,
      ],
    );
    await withTenant(database.db, admin, (tx) =>
      tx.insert(memberships).values([
        { id: memberId, tenantId, userId, status: "active" },
        { id: createEntityId(), tenantId, userId: otherId, status: "active" },
      ]),
    );
    const own = await service.createPlan(admin, planInput("Own " + randomUUID())),
      other = await service.createPlan(
        { ...admin, userId: otherId },
        planInput("Other " + randomUUID()),
      );
    async function grant(permissions: string[], scope: "self" | "team" | "tenant") {
      const id = createEntityId();
      await withTenant(database.db, admin, async (tx) => {
        await tx
          .insert(roles)
          .values({ id, tenantId, name: randomUUID(), permissions, dataScope: scope });
        await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId: id });
      });
      return id;
    }
    async function current() {
      const value = await loader.load({ sub: subject, tenant_id: tenantId });
      expect(value).not.toBeNull();
      return value!;
    }
    return { admin, memberId, own, other, grant, current, subject, otherId };
  }

  it("keeps broad product reads while rejecting another owner's commands under self write", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead], "tenant");
    await f.grant([Permission.ProductWrite], "self");
    const context = await f.current();
    expect(context.dataScope).toBe("tenant");
    expect(context.permissionScopes).toEqual({
      [Permission.ProductRead]: "tenant",
      [Permission.ProductWrite]: "self",
    });
    expect((await service.listPlans(context)).map((p) => p.id).sort()).toEqual(
      [f.own.id, f.other.id].sort(),
    );
    await service.updateCustomization(context, f.own.id, {
      customization: { version: 1, fields: [] },
    });
    for (const command of [
      () =>
        service.updateCustomization(context, f.other.id, {
          customization: { version: 1, fields: [] },
        }),
      () => service.transition(context, f.other.id, "pending_approval"),
      () => service.createSpu(context, f.other.id, { code: "DENIED", name: "Denied" }),
    ])
      await expect(command()).rejects.toMatchObject({ status: 404 });
    expect((await service.listPlans(f.admin)).find((p) => p.id === f.other.id)?.status).toBe(
      "researching",
    );
  });

  it("does not borrow an unrelated tenant grant for product reads or writes", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead, Permission.ProductWrite], "self");
    await f.grant([Permission.CaptureRead], "tenant");
    const context = await f.current();
    expect(context.dataScope).toBe("tenant");
    expect((await service.listPlans(context)).map((p) => p.id)).toEqual([f.own.id]);
    await expect(service.transition(context, f.other.id, "pending_approval")).rejects.toMatchObject(
      { status: 404 },
    );
  });

  it("checks the parent plan when an internal command uses another owner's SPU ID", async () => {
    const f = await fixture(),
      owner = { ...f.admin, userId: f.otherId };
    await service.transition(owner, f.other.id, "pending_approval");
    await service.transition(owner, f.other.id, "approved");
    const spu = await service.createSpu(owner, f.other.id, {
      code: randomUUID(),
      name: "Synthetic foreign SPU",
    });
    await f.grant([Permission.ProductRead], "tenant");
    await f.grant([Permission.ProductWrite], "self");
    const context = await f.current(),
      code = "DENIED-" + randomUUID();
    await expect(
      service.createSku(context, { spuId: spu.id, code, attributes: {} }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.listPlans(f.admin)).find((p) => p.id === f.other.id)?.spu?.skus).toEqual(
      [],
    );
  });

  it("a broader role for the same operation permits the actual command", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead, Permission.ProductWrite], "self");
    await f.grant([Permission.ProductWrite], "tenant");
    const context = await f.current();
    expect((await service.listPlans(context)).map((p) => p.id)).toEqual([f.own.id]);
    await expect(
      service.transition(context, f.other.id, "pending_approval"),
    ).resolves.toMatchObject({ id: f.other.id, status: "pending_approval" });
  });

  it("uses product write scope inside the facts package owner, independently of broad reads", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead], "tenant");
    await f.grant([Permission.ProductWrite], "self");
    const context = await f.current(),
      packages = new CustomProductPackageService(database, {} as Storage);
    const profile = CustomProductProfileV1Schema.parse({
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
    });
    await expect(packages.saveProfile(context, f.other.id, { profile })).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await service.listPlans(f.admin)).find((p) => p.id === f.other.id)?.customProductProfile,
    ).toBeUndefined();
    await expect(packages.saveProfile(context, f.own.id, { profile })).resolves.toBeDefined();
  });

  it("reloads permission-specific scope changes in both authentication and transactional reads", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead], "tenant");
    const writerRole = await f.grant([Permission.ProductWrite], "tenant");
    expect((await f.current()).permissionScopes?.[Permission.ProductWrite]).toBe("tenant");
    await withTenant(database.db, f.admin, (tx) =>
      tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, writerRole)),
    );
    const context = await f.current(),
      transactional = await withTenant(database.db, f.admin, (tx) =>
        loadCurrentMembershipContext(tx, f.admin, { lock: true }),
      );
    expect(context.dataScope).toBe("tenant");
    expect(transactional.permissionScopes).toEqual(context.permissionScopes);
    expect(context.permissionScopes?.[Permission.ProductWrite]).toBe("self");
    await expect(service.transition(context, f.other.id, "pending_approval")).rejects.toMatchObject(
      { status: 404 },
    );
    await withTenant(database.db, f.admin, (tx) =>
      tx
        .delete(membershipRoles)
        .where(
          and(eq(membershipRoles.membershipId, f.memberId), eq(membershipRoles.roleId, writerRole)),
        ),
    );
    const revoked = await f.current();
    expect(revoked.permissionScopes?.[Permission.ProductWrite]).toBeUndefined();
    await expect(
      Promise.resolve().then(() =>
        service.createPlan(revoked, planInput("Denied after withdrawal")),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("denies missing permissions, cross-tenant subjects and disabled members", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead], "tenant");
    await expect(
      Promise.resolve().then(async () =>
        service.createPlan(await f.current(), planInput("Denied internal create")),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(loader.load({ sub: f.subject, tenant_id: createEntityId() })).resolves.toBeNull();
    await withTenant(database.db, f.admin, (tx) =>
      tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.memberId)),
    );
    await expect(loader.load({ sub: f.subject, tenant_id: f.admin.tenantId })).resolves.toBeNull();
  });
});
