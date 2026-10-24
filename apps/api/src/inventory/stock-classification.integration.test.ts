import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, withTenant, inventoryStockItems, inventoryStockItemClassifications as classifications,
  memberships, membershipRoles, roles } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "./inventory.service.js";

requireDisposableIntegrationEnvironment();
describe.sequential("stock classification source and revision", () => {
  const db = connectDatabase(), audit = new AuditService(db), service = new InventoryService(db, audit);
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: [Permission.InventoryRead, Permission.InventoryWrite] };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const other: TenantContext = { ...a, userId: createEntityId() };
  const roleIds = new Map<string, string>();
  const stock = (context = a, kind?: "blank" | "material" | "packaging" | "work_in_progress" | "finished_good") => service.createStockItem(context,
    { skuId: null, code: `CLASS-${randomUUID()}`.toUpperCase(), name: "Synthetic stock identity", baseUnit: "meter", ...(kind ? { materialKind: kind } : {}) });
  const input = (expectedVersion = 0) => ({ expectedVersion, kind: "material" as const, reason: "Synthetic operator classification", idempotencyKey: randomUUID() });
  const original = (id: string) => withTenant(db.db, a, async tx => (await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, id)))[0]);

  beforeAll(async () => {
    await migrateDatabase(db);
    for (const context of [a, b]) await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic classification',$2)", [context.tenantId, randomUUID()]);
    for (const context of [a, b, other]) {
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic classifier')", [context.userId, randomUUID(), `${context.userId}@example.test`]);
      await withTenant(db.db, context, async tx => {
        const member = createEntityId(), role = createEntityId(); roleIds.set(context.userId, role);
        await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
        await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
      });
    }
  });
  afterAll(() => db.client.end());

  it("keeps unknown stock explicit and appends classification without rewriting the original identity", async () => {
    const unknown = await stock(), before = await original(unknown.id);
    expect(unknown.classification).toBeNull();
    const classified = await service.classifyStockItem(a, unknown.id, input());
    expect(classified).toMatchObject({ replayed: false, classification: { versionNumber: 1, kind: "material" } });
    expect(await original(unknown.id)).toEqual(before);
    const workspace = await service.workspace(a);
    expect(workspace.stockItems.find(row => row.id === unknown.id)?.classification).toEqual(classified.classification);
    const json = JSON.stringify(classified);
    for (const privateKey of ["tenantId", "createdBy", "requestChecksum", "idempotencyKey"]) expect(json).not.toContain(privateKey);
    expect(workspace.balances).toEqual([]);
  });

  it("saves an explicitly selected initial category with the stock and keeps all five categories distinct", async () => {
    for (const kind of ["blank", "material", "packaging", "work_in_progress", "finished_good"] as const) {
      expect((await stock(a, kind)).classification).toMatchObject({ kind, versionNumber: 1 });
    }
  });

  it("replays its original fact under current authority without hiding a later classification", async () => {
    const item = await stock(), request = input(), first = await service.classifyStockItem(a, item.id, request);
    const second = await service.classifyStockItem(a, item.id, { ...input(1), kind: "packaging" });
    const replay = await service.classifyStockItem(a, item.id, request);
    expect(replay).toMatchObject({ replayed: true, classification: first.classification, stockItem: { classification: second.classification } });
    await expect(service.classifyStockItem(a, item.id, { ...request, reason: "Changed original body" })).rejects.toMatchObject({ status: 409 });
    await expect(service.classifyStockItem(other, item.id, request)).rejects.toMatchObject({ status: 409 });
    await expect(service.classifyStockItem(a, (await stock()).id, request)).rejects.toMatchObject({ status: 409 });
  });

  it("serializes competing revisions and rejects a stale version", async () => {
    const item = await stock();
    const results = await Promise.allSettled([service.classifyStockItem(a, item.id, input()), service.classifyStockItem(a, item.id, { ...input(), kind: "blank" })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(row => row.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    expect((await service.stockClassificationHistory(a, item.id)).items).toHaveLength(1);
    await expect(service.classifyStockItem(a, item.id, input())).rejects.toMatchObject({ status: 409 });
  });

  it("rechecks membership and the original narrow scope for reads, writes and replay", async () => {
    const item = await stock(), request = input(); await service.classifyStockItem(a, item.id, request);
    await expect(service.stockClassificationHistory(b, item.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.classifyStockItem(b, item.id, input())).rejects.toMatchObject({ status: 404 });
    await expect(service.stockClassificationHistory({ ...other, dataScope: "self" }, item.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.classifyStockItem({ ...other, dataScope: "team" }, item.id, input(1))).rejects.toMatchObject({ status: 403 });
    try {
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: [Permission.InventoryRead] }).where(eq(roles.id, roleIds.get(a.userId)!)));
      expect((await service.stockClassificationHistory(a, item.id)).canClassify).toBe(false);
      await expect(service.classifyStockItem(a, item.id, request)).rejects.toMatchObject({ status: 403 });
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: [] }).where(eq(roles.id, roleIds.get(a.userId)!)));
      await expect(service.classifyStockItem(a, item.id, request)).rejects.toMatchObject({ status: 403 });
      await expect(service.stockClassificationHistory(a, item.id)).rejects.toMatchObject({ status: 403 });
    } finally { await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleIds.get(a.userId)!))); }
  });

  it("enforces non-owner RLS, immutable facts, sequential versions and the real actor at the SQL boundary", async () => {
    const item = await stock(a, "material");
    expect(await withTenant(db.db, b, tx => tx.select().from(classifications).where(eq(classifications.stockItemId, item.id)))).toEqual([]);
    await expect(withTenant(db.db, a, tx => tx.update(classifications).set({ kind: "packaging" }).where(eq(classifications.stockItemId, item.id)))).rejects.toThrow();
    const raw = { id: createEntityId(), tenantId: a.tenantId, stockItemId: item.id, versionNumber: 99, kind: "blank", reason: "Synthetic SQL", requestChecksum: "a".repeat(64), idempotencyKey: randomUUID(), createdBy: a.userId };
    await expect(withTenant(db.db, a, tx => tx.insert(classifications).values(raw))).rejects.toThrow();
    await expect(withTenant(db.db, a, tx => tx.insert(classifications).values({ ...raw, versionNumber: 2, createdBy: other.userId }))).rejects.toThrow();
    const role = await withTenant(db.db, a, tx => tx.execute<{ role: string }>(sql`select current_user as role`)); expect(role[0]!.role).toBe("yummyai_app");
    expect((await service.stockClassificationHistory(a, item.id)).items).toHaveLength(1);
  });

  it("rolls back both an initial stock and a later classification when the atomic audit fails", async () => {
    const item = await stock(), code = `FAIL-${randomUUID()}`.toUpperCase();
    const failing = vi.spyOn(audit, "recordInTransaction").mockRejectedValue(new Error("Synthetic classification audit failure"));
    try {
      await expect(service.classifyStockItem(a, item.id, input())).rejects.toThrow("Synthetic classification audit failure");
      await expect(service.createStockItem(a, { skuId: null, code, name: "Synthetic failed stock", baseUnit: "each", materialKind: "blank" })).rejects.toThrow("Synthetic classification audit failure");
    } finally { failing.mockRestore(); }
    expect((await service.stockClassificationHistory(a, item.id)).items).toEqual([]);
    expect(await withTenant(db.db, a, tx => tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.code, code)))).toEqual([]);
  });

  it("pages the complete immutable history by revision rather than record time", async () => {
    const item = await stock(); for (let version = 0; version < 27; version++) await service.classifyStockItem(a, item.id, input(version));
    const first = await service.stockClassificationHistory(a, item.id), second = await service.stockClassificationHistory(a, item.id, first.nextVersion!);
    expect(first.items.map(row => row.versionNumber)).toEqual(Array.from({ length: 25 }, (_, index) => 27 - index));
    expect(second.items.map(row => row.versionNumber)).toEqual([2, 1]); expect(second.nextVersion).toBeNull();
  });
});
