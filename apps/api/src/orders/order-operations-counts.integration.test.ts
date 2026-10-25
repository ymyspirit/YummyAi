import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, loadCurrentMembershipContext, marketplaceAccounts, membershipRoles,
  memberships, migrateDatabase, orderWorkItems, roles, withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";

// Guard before constructing a connection. The runner removes this whole database,
// bucket and Redis; this suite creates no object, model call, job or production.
requireDisposableIntegrationEnvironment();

type Actor = { context: TenantContext; accounts: [string, string]; roleId: string };

describe.sequential("matching operational quantities use the complete list filter", () => {
  const database = connectDatabase(), audit = new AuditService(database);
  const vault = new SecretVault(Buffer.alloc(32, 106));
  const orders = new OrderService(database, vault, audit);
  const forbiddenEffect = async () => { throw new Error("Operational count reads cannot create external effects"); };
  const storage = { putPrivate: forbiddenEffect, readPrivate: forbiddenEffect } as unknown as Storage;
  const scan = async () => ({ result: "clean" as const, engine: "synthetic-unused", signatureVersion: "unused", scannedAt: new Date().toISOString() });
  const reports = new AmazonOrderReportService(database, vault, orders, audit,
    { download: forbiddenEffect, scan }, { schedule: forbiddenEffect }, { schedule: forbiddenEffect });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit,
    { enqueue: forbiddenEffect }, { scan });
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, { scan });
  const prefix = `SYNTHETIC-OPERATIONS-${createEntityId()}`;
  let actor: Actor, foreign: Actor;

  async function createActor(): Promise<Actor> {
    const seed: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic operations counts',$2)", [seed.tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic count operator')", [seed.userId, randomUUID(), `${seed.userId}@example.invalid`]);
    const membershipId = createEntityId(), roleId = createEntityId(), accounts: [string, string] = [createEntityId(), createEntityId()];
    await withTenant(database.db, seed, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId: seed.tenantId, userId: seed.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: seed.tenantId, name: randomUUID(), permissions: seed.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: seed.tenantId, membershipId, roleId });
      await tx.insert(marketplaceAccounts).values(accounts.map((id, index) => ({ id, tenantId: seed.tenantId,
        platform: "amazon" as const, displayName: `Synthetic count store ${index}`, region: "NA", authorizationMode: "amazon_private" as const,
        marketplaceIds: ["ATVPDKIKX0DER"], createdBy: seed.userId })));
    });
    return { context: await withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed)), accounts, roleId };
  }

  async function seedOrder(owner: Actor, suffix: string, quantities: number[], options: { account?: number; placed?: string; archived?: boolean } = {}) {
    const result = await orders.materializeNormalized(owner.context, {
      accountId: owner.accounts[options.account ?? 0]!, platform: "amazon", externalEventId: randomUUID(), externalOrderId: `${prefix}-${suffix}`,
      providerStatus: "UNSHIPPED", placedAt: options.placed ?? "2026-01-10T12:00:00.000Z", orderTotal: null,
      redactedSource: { source: "synthetic-count-projection-only" }, protectedDetails: null,
      lines: quantities.map((quantity, index) => ({ externalLineId: `${suffix}-${index}`, externalListingId: null,
        skuCode: `${suffix}-SKU-${index}`, title: `Synthetic ${suffix} item ${index}`, quantity, unitPrice: null, customizationCount: 0 })),
    });
    // These states describe only this disposable read projection. No artwork,
    // reviewed manufacturing basis or production admission is manufactured.
    await withTenant(database.db, owner.context, tx => tx.insert(orderWorkItems).values(result.order.lines.map(line => ({
      id: line.id, tenantId: owner.context.tenantId, expiresAt: new Date("2027-01-01T00:00:00.000Z"), searchRevision: 0,
      preparation: suffix === "A" ? "pushed" : "pending_review",
      artwork: suffix === "A" ? line.externalLineId === "A-0" ? "approved" : "in_review" : "not_pushed",
      held: suffix === "A" && line.externalLineId === "A-1",
      dueAt: suffix === "A" && line.externalLineId === "A-1" ? new Date("2026-01-12T12:00:00.000Z") : null,
      platformShipByAt: suffix === "A" && line.externalLineId === "A-1" ? null : new Date("2026-01-15T12:00:00.000Z"),
      archivedAt: options.archived ? new Date("2026-01-20T12:00:00.000Z") : null,
    }))));
  }

  beforeAll(async () => {
    await migrateDatabase(database);
    actor = await createActor(); foreign = await createActor();
    await seedOrder(actor, "A", [3, 1]);
    await seedOrder(actor, "B", [2], { placed: "2026-01-11T12:00:00.000Z" });
    await seedOrder(actor, "C", [5], { account: 1, archived: true });
    await seedOrder(foreign, "FOREIGN", [9]);
  }, 60_000);
  afterAll(async () => { await database.client.end(); });

  const query = () => ({ module: "orders", q: prefix, accountId: actor.accounts[0], grouping: "orders", pageSize: 1 });

  it("keeps order, line and unit totals stable across pages and grouping modes", async () => {
    const first = await work.list(actor.context, query());
    const second = await work.list(actor.context, { ...query(), page: 2 });
    for (const result of [first, second]) {
      expect(result).toMatchObject({ total: 3, groupTotal: 2, matchingQuantity: 6 });
      expect(new Set(result.items.map(row => row.orderId)).size).toBe(1);
      expect(result.counts).toMatchObject({ orders: 2, total: 3, quantity: 6 });
    }
    expect(first.items[0]!.orderId).not.toBe(second.items[0]!.orderId);
    const lines = await work.list(actor.context, { ...query(), grouping: "items" });
    expect(lines).toMatchObject({ total: 3, matchingQuantity: 6 });
    expect(lines.groupTotal).toBeUndefined();
    expect(lines.items).toHaveLength(1);
  });

  it.each([
    [{ stage: "in_review" }, 1, 1],
    [{ orderStatus: "awaiting_review" }, 2, 4],
    [{ workView: "todo" }, 2, 3],
    [{ stage: "in_review", workView: "todo", orderStatus: "awaiting_review" }, 1, 1],
    [{ sku: "A-SKU-0" }, 1, 3],
    [{ artwork: "in_review", attention: "held" }, 1, 1],
    [{ attention: "platform_deadline_missing" }, 1, 1],
    [{ orderNumbers: `${prefix}-B` }, 1, 2],
    [{ from: "2026-01-11", to: "2026-01-11", dateField: "placed", timeZone: "UTC" }, 1, 2],
    [{ dateField: "due", from: "2026-01-12", to: "2026-01-12", timeZone: "UTC" }, 1, 1],
  ] as const)("uses the full filter %o for matching quantities", async (filter, total, quantity) => {
    const result = await work.list(actor.context, { ...query(), ...filter });
    expect(result.total).toBe(total);
    expect(result.matchingQuantity).toBe(quantity);
  });

  it("separates matching quantities from the deliberately broader lifecycle cohort", async () => {
    const result = await work.list(actor.context, { ...query(), stage: "in_review", workView: "todo", orderStatus: "awaiting_review" });
    expect(result).toMatchObject({ total: 1, groupTotal: 1, matchingQuantity: 1, counts: { quantity: 6, orders: 2, total: 3 } });
  });

  it("does not count expanded nonmatching siblings as matched production units", async () => {
    const result = await work.list(actor.context, { ...query(), module: "production", sku: "A-SKU-0" });
    expect(result).toMatchObject({ total: 1, groupTotal: 1, matchingQuantity: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.items.reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
    expect(result.items.every(row => row.orderQuantity === 4 && row.orderStatus === "awaiting_review")).toBe(true);
  });

  it("respects account and archived scope without folding another store into the count", async () => {
    expect(await work.list(actor.context, { ...query(), accountId: actor.accounts[1] })).toMatchObject({ total: 0, groupTotal: 0, matchingQuantity: 0 });
    expect(await work.list(actor.context, { ...query(), accountId: actor.accounts[1], archived: "only" })).toMatchObject({ total: 1, groupTotal: 1, matchingQuantity: 5 });
  });

  it("returns real zero for an empty match and never exposes another tenant's quantities", async () => {
    expect(await work.list(actor.context, { ...query(), q: `${prefix}-MISSING` })).toMatchObject({ total: 0, groupTotal: 0, matchingQuantity: 0 });
    expect(await work.list(foreign.context, query())).toMatchObject({ total: 0, groupTotal: 0, matchingQuantity: 0 });
    expect(await work.list(foreign.context, { ...query(), accountId: foreign.accounts[0] })).toMatchObject({ total: 1, groupTotal: 1, matchingQuantity: 9 });
    await withTenant(database.db, actor.context, async tx => {
      const [actual] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      expect(actual?.role).toBe("yummyai_app");
    });
  });

  it("rechecks current read authority before returning a previously authorized count", async () => {
    await withTenant(database.db, actor.context, tx => tx.update(roles).set({ permissions: [] }).where(eq(roles.id, actor.roleId)));
    try { await expect(work.list(actor.context, query())).rejects.toThrow(); }
    finally {
      await withTenant(database.db, actor.context, tx => tx.update(roles).set({ permissions: actor.context.permissions }).where(eq(roles.id, actor.roleId)));
    }
  });
});
