import { randomUUID } from "node:crypto";
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
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { IdentitySessionController } from "./identity-session.controller.js";
if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw Error("Disposable identity integration required");
describe("current personal ERP session", () => {
  const database = connectDatabase(),
    controller = new IdentitySessionController(database);
  beforeAll(() => migrateDatabase(database));
  afterAll(() => database.client.end());
  async function fixture(
    rights: string[] = [Permission.ProductRead],
    scope: "self" | "team" | "tenant" = "self",
  ) {
    const tenantId = createEntityId(),
      userId = createEntityId(),
      memberId = createEntityId(),
      roleId = createEntityId(),
      context: TenantContext = {
        tenantId,
        userId,
        permissions: Object.values(Permission),
        dataScope: "tenant",
      };
    await database.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic identity tenant',$2)",
      [tenantId, randomUUID()],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic personal member')",
      [userId, randomUUID(), `${userId}@example.invalid`],
    );
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(memberships).values({ id: memberId, tenantId, userId, status: "active" });
      await tx
        .insert(roles)
        .values({
          id: roleId,
          tenantId,
          name: "Synthetic identity role",
          permissions: rights,
          dataScope: scope,
        });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId });
    });
    return {
      context,
      memberId,
      roleId,
      request: { headers: {}, tenantContext: context, authenticationKind: "oidc" as const },
    };
  }
  it("reads current non-owner roles rather than trusting stale request permissions", async () => {
    const f = await fixture();
    const value = await controller.session(f.request, {});
    expect(value).toMatchObject({
      userId: f.context.userId,
      tenantId: f.context.tenantId,
      canUseErp: true,
      permissions: [Permission.ProductRead],
      dataScope: "self",
    });
    expect(JSON.stringify(value)).not.toMatch(/oidc_subject|email|access_token|encrypted/);
  });
  it("reflects changed roles and scope and refuses a disabled membership", async () => {
    const f = await fixture();
    await withTenant(database.db, f.context, (tx) =>
      tx
        .update(roles)
        .set({ permissions: [Permission.ProductWrite], dataScope: "team" })
        .where(eq(roles.id, f.roleId)),
    );
    expect(await controller.session(f.request, {})).toMatchObject({
      permissions: [Permission.ProductWrite],
      dataScope: "team",
    });
    await withTenant(database.db, f.context, (tx) =>
      tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, f.memberId)),
    );
    await expect(controller.session(f.request, {})).rejects.toMatchObject({ status: 401 });
  });
  it("does not turn factory-only permissions into ERP access", async () => {
    const f = await fixture([Permission.FactoryTaskRead, Permission.FactoryTaskRespond]);
    expect(await controller.session(f.request, {})).toMatchObject({
      canUseErp: false,
      permissions: [],
    });
  });
  it("rejects API-client identity and caller-selected scope before reading member details", async () => {
    const f = await fixture();
    await expect(
      controller.session({ ...f.request, authenticationKind: "api_client" }, {}),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      controller.session(f.request, { tenantId: createEntityId() }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.session(
        { ...f.request, tenantContext: { ...f.context, tenantId: createEntityId() } },
        {},
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
