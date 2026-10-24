import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent,
  memberships, membershipRoles, roles, fulfillmentSuppliers, inventoryPurchaseOrders, inventoryPurchaseOrderEvents,
  inventoryProcurementReceipts, inventoryProcurementReceiptLines, inventoryProcurementReceiptRequests } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { seedLegacyApprovedPurchase } from "./legacy-procurement.fixtures.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0142") throw new Error("Actual pre-0142 disposable database required");

describe("actual legacy receipt-request upgrade", () => {
  const db = connectDatabase(), audit = new AuditService(db), inventory = new InventoryService(db, audit), procurement = new ProcurementService(db, inventory, audit);
  afterAll(() => db.client.end());
  it("preserves the full original receipt and stock while refusing to invent its unknown request", async () => {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    const oldLedger = await db.client.unsafe("select hash,created_at from drizzle.__drizzle_migrations order by created_at,id");
    expect(oldLedger).toHaveLength(141); await expect(assertDatabaseMigrationsCurrent(db)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    expect((await db.client.unsafe("select to_regclass('inventory_procurement_receipt_requests') as name"))[0]!.name).toBeNull();
    await db.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic legacy receipt',$2)", [context.tenantId, randomUUID()]);
    await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic legacy operator')", [context.userId, randomUUID(), `${context.userId}@example.test`]);
    const supplier = createEntityId();
    await withTenant(db.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
      await tx.insert(fulfillmentSuppliers).values({ id: supplier, tenantId: context.tenantId, name: "Synthetic old supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 1, createdBy: context.userId });
    });
    const warehouse = await inventory.createWarehouse(context, { code: "LEGACY", name: "Legacy warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: "LEGACY", name: "Legacy receiving" });
    const stock = await inventory.createStockItem(context, { skuId: null, code: "LEGACY-BLANK", name: "Unclassified old stock", baseUnit: "each" });
    const order = await seedLegacyApprovedPurchase(db, context, { code: "LEGACY-ORDER", supplierId: supplier, requisitionId: null, quoteId: null, currency: "USD", expectedAt: "2026-08-01T00:00:00Z",
      lines: [{ lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 2, unit: "each", unitCostMinor: 100 }], idempotencyKey: "legacy-order-create" });
    const receiptId = createEntityId(), key = "legacy-receipt-request", receivedAt = "2026-08-01T12:00:00.000Z";
    // This is the genuine old schema. Seed its old receipt contract explicitly;
    // current recordReceipt() must not pretend future request evidence exists.
    await withTenant(db.db, context, async tx => {
      const [version] = await tx.execute<{ id: string }>(sql`select id from inventory_purchase_order_versions where purchase_order_id=${order.id}::uuid and version_number=1`);
      await tx.insert(inventoryProcurementReceipts).values({ id: receiptId, tenantId: context.tenantId, purchaseOrderId: order.id, purchaseOrderVersionId: version!.id, receivedAt: new Date(receivedAt), externalReference: "OLD-ASN", hasVariance: false, idempotencyKey: key, createdBy: context.userId });
      const posted = await inventory.receiveProcurementStock(tx, context, { receiptId, stockItemId: stock.id, locationId: location.id, lotCode: "LEGACY-LOT", quantity: 2,
        unit: "each", unitCostMinor: 100, currency: "USD", receivedAt, expiresAt: null, idempotencyKey: "legacy-receipt-movement" });
      await tx.insert(inventoryProcurementReceiptLines).values({ id: createEntityId(), tenantId: context.tenantId, receiptId, lineKey: "LINE-1", stockItemId: stock.id,
        destinationLocationId: location.id, receivedQuantity: 2, rejectedQuantity: 0, rejectionReasonCode: null, unit: "each", unitCostMinor: 100, lotId: posted.lot.id, movementId: posted.movement.id });
      await tx.update(inventoryPurchaseOrders).set({ status: "received" }).where(eq(inventoryPurchaseOrders.id, order.id));
      const [sequence] = await tx.execute<{ value: number }>(sql`select coalesce(max(sequence),0)+1 as value from inventory_purchase_order_events where purchase_order_id=${order.id}::uuid`);
      await tx.insert(inventoryPurchaseOrderEvents).values({ id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: order.id, sequence: sequence!.value,
        action: "received", fromStatus: "approved", toStatus: "received", reasonCode: null, idempotencyKey: key, actorUserId: context.userId, occurredAt: new Date(receivedAt) });
    });
    const tables = ["inventory_stock_items", "inventory_procurement_receipts", "inventory_procurement_receipt_lines", "inventory_lots", "inventory_movements", "inventory_balances", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events"];
    const snapshot = async (table: string) => withTenant(db.db, context, async tx => {
      await tx.execute(sql`set local time zone 'UTC'`);
      return [...await tx.execute<{ id: string; hash: string }>(sql`select id::text as id,md5((to_jsonb(t)-'receiving_policy')::text) as hash from ${sql.identifier(table)} t order by id`)];
    });
    const original = new Map<string, Awaited<ReturnType<typeof snapshot>>>(); for (const table of tables) original.set(table, await snapshot(table));
    await migrateDatabase(db);
    for (const table of tables) expect(await snapshot(table)).toEqual(original.get(table));
    expect((await readMigrationEvidence(db)).actualRows.slice(0, oldLedger.length)).toEqual(oldLedger.map(row => ({ hash: String(row.hash), created_at: String(row.created_at) })));
    expect(await withTenant(db.db, context, tx => tx.select().from(inventoryProcurementReceiptRequests))).toEqual([]);
    await expect(withTenant(db.db, context, async tx => {
      const [header] = await tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.id, receiptId));
      await tx.insert(inventoryProcurementReceiptRequests).values({ id: createEntityId(), tenantId: context.tenantId, receiptId,
        purchaseOrderId: order.id, purchaseOrderVersionId: header!.purchaseOrderVersionId, createdBy: context.userId,
        evidenceVersion: 1, requestChecksum: "a".repeat(64), idempotencyKey: key });
    })).rejects.toThrow();
    await expect(procurement.recordReceipt(context, order.id, { expectedVersion: 1, receivedAt, externalReference: "OLD-ASN", lines: [{ lineKey: "LINE-1", receivedQuantity: 2, rejectedQuantity: 0, rejectionReasonCode: null, lotCode: "LEGACY-LOT", expiresAt: null }], idempotencyKey: key }))
      .rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "receipt_input_unavailable" }) });
    for (const table of tables) expect(await snapshot(table)).toEqual(original.get(table));
    expect((await inventory.workspace(context)).stockItems.find(row => row.id === stock.id)?.classification).toBeNull();
    expect((await withTenant(db.db, context, tx => tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, order.id))))[0]!.receivingPolicy).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(db)).resolves.toMatchObject({ migrations: (await readMigrationEvidence(db)).canonicalRows.length });
  });
});
