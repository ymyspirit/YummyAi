import { Permission } from "@yummyai/authz";
import {
  CreateMarketplaceAccountInputSchema,
  createEntityId,
  type TenantContext,
} from "@yummyai/contracts";
import {
  auditEvents,
  connectDatabase,
  marketplaceAccounts,
  memberships,
  membershipRoles,
  roles,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";

describe("marketplace account foundation", () => {
  const database = connectDatabase();
  const service = new MarketplaceAccountService(database, new AuditService(database));
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.StoreRead, Permission.StoreManage],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId };
  let accountId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Store tenant', $2), ($3, 'Other store tenant', $4)`,
      [tenantId, `store-${tenantId}`, otherTenantId, `other-store-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Store Admin')`,
      [userId, `store-${userId}`, `${userId}@example.test`],
    );
    for (const actor of [context, otherContext]) await withTenant(database.db, actor, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: actor.tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: actor.tenantId, name: "Store fixture " + roleId,
        permissions: [...actor.permissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId, roleId });
    });
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("creates redacted tenant-scoped account metadata and an audit event", async () => {
    const input = CreateMarketplaceAccountInputSchema.parse({
      platform: "etsy",
      displayName: "Etsy US",
      region: "GLOBAL",
      marketplaceIds: ["etsy"],
      authorizationMode: "etsy_oauth",
      requestedScopes: ["listings_r", "listings_w", "shops_r"],
    });
    const created = await service.create(context, input);
    accountId = created.id;
    expect(created).toMatchObject({
      status: "pending_authorization",
      credentialStatus: "missing",
      hasCredential: false,
      healthStatus: "not_checked",
    });
    expect(JSON.stringify(created)).not.toMatch(/accessToken|refreshToken|encryptedCredential/i);

    const events = await withTenant(database.db, context, (tx) =>
      tx.select().from(auditEvents).where(eq(auditEvents.entityId, accountId)),
    );
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "marketplace_account.create", result: "success" }),
    ]));
  });

  it("keeps the account invisible to another tenant", async () => {
    await expect(service.list(otherContext)).resolves.toEqual([]);
    await expect(service.get(otherContext, accountId)).rejects.toMatchObject({ status: 404 });
  });

  it("allows choosing an Amazon authorization mode later without accepting another platform", async () => {
    const amazon = await service.create(context, CreateMarketplaceAccountInputSchema.parse({ platform: "amazon", displayName: "Manual Amazon", region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private" }));
    await expect(service.update(context, amazon.id, { authorizationMode: "amazon_public" })).resolves.toMatchObject({ authorizationMode: "amazon_public", hasCredential: false, status: "pending_authorization" });
    await expect(service.update(context, amazon.id, { authorizationMode: "etsy_oauth" })).rejects.toMatchObject({ status: 409 });
    await expect(service.update(otherContext, amazon.id, { displayName: "Wrong tenant" })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a duplicate display identity in the same platform", async () => {
    await expect(service.create(context, CreateMarketplaceAccountInputSchema.parse({
      platform: "etsy",
      displayName: "Etsy US",
      region: "GLOBAL",
      marketplaceIds: ["etsy"],
      authorizationMode: "etsy_oauth",
    }))).rejects.toMatchObject({ status: 409 });
  });

  it("allows explicit disable and returns to authorization pending when re-enabled", async () => {
    await expect(service.update(context, accountId, { enabled: false })).resolves.toMatchObject({ status: "disabled" });
    await expect(service.update(context, accountId, { enabled: true })).resolves.toMatchObject({ status: "pending_authorization" });
  });

  it("records connector health without allowing it to cross tenant boundaries", async () => {
    const health = await service.recordHealth(context, accountId, "degraded", "UPSTREAM_503");
    expect(health).toMatchObject({ status: "degraded", healthStatus: "degraded", lastErrorCode: "UPSTREAM_503" });
    const otherRows = await withTenant(database.db, otherContext, (tx) => tx.select().from(marketplaceAccounts));
    expect(otherRows).toEqual([]);
  });

  it("removes the shop from live access while preserving its identity and audit history", async () => {
    await expect(service.remove(otherContext, accountId)).rejects.toMatchObject({ status: 404 });
    await expect(service.remove({ ...context, permissions: [Permission.StoreRead] }, accountId)).rejects.toThrow();
    const removed = await service.remove(context, accountId);
    expect(removed.id).toBe(accountId);
    expect((await service.list(context)).some((row) => row.id === accountId)).toBe(false);
    await expect(service.get(context, accountId)).rejects.toMatchObject({ status: 404 });
    await expect(service.update(context, accountId, { enabled: true })).rejects.toMatchObject({ status: 404 });
    expect(await service.remove(context, accountId)).toEqual(removed);
    const retained = await withTenant(database.db, context, async (tx) => ({
      accounts: await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)),
      events: await tx.select().from(auditEvents).where(eq(auditEvents.entityId, accountId)),
    }));
    expect(retained.accounts[0]).toMatchObject({ displayName: "Etsy US", status: "disabled" });
    expect(retained.accounts[0]?.deletedAt?.toISOString()).toBe(removed.deletedAt);
    expect(retained.events.filter((event) => event.action === "marketplace_account.remove")).toHaveLength(1);
    expect(retained.events.some((event) => event.action === "marketplace_account.create")).toBe(true);
    await expect(withTenant(database.db, context, (tx) => tx.update(marketplaceAccounts)
      .set({ deletedAt: null, status: "pending_authorization" }).where(eq(marketplaceAccounts.id, accountId)))).rejects.toThrow();
  });
});
