import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { createEntityId, type TenantContext, type RecordProcurementReceiptInput } from "@yummyai/contracts";
import { connectDatabase, withTenant, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent, memberships, membershipRoles, roles,
  fulfillmentSuppliers, inventoryPurchaseOrders, inventoryPurchaseOrderEvents, inventoryProcurementReceipts, inventoryProcurementReceiptLines, inventoryProcurementReceiptRequests } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { seedLegacyApprovedPurchase } from "./legacy-procurement.fixtures.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0143") throw new Error("Actual 142-schema disposable database required");
describe("genuine 142 inventory and receipt upgrade into incoming inspection", () => {
  const database = connectDatabase(), audit = new AuditService(database), inventory = new InventoryService(database, audit), procurement = new ProcurementService(database, inventory, audit), incoming = new IncomingInspectionService(database, procurement, audit);
  afterAll(() => database.client.end());
  it("preserves every original column, request proof and ledger prefix without fabricating any inspection", async () => {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    const oldLedger = (await readMigrationEvidence(database)).actualRows;
    expect(oldLedger).toHaveLength(142);
    expect((await database.client.unsafe("select to_regclass('inventory_incoming_standards') as name"))[0]!.name).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic actual 142 fixture',$2)", [context.tenantId, randomUUID()]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic legacy operator')", [context.userId, randomUUID(), `${context.userId}@example.test`]);
    const supplierId = createEntityId();
    await withTenant(database.db, context, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: context.tenantId, name: "Synthetic historical supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 1, createdBy: context.userId });
    });
    const warehouse = await inventory.createWarehouse(context, { code: "OLD-142", name: "Synthetic old warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: "OLD-142", name: "Synthetic old receiving" });
    const stock = await inventory.createStockItem(context, { skuId: null, code: "OLD-142", name: "Synthetic old blank", baseUnit: "each" });
    const purchaseInput = { code: "OLD-142", supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: "2026-08-01T00:00:00Z",
      lines: [{ lineKey: "L1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 3, unit: "each" as const, unitCostMinor: 100 }], idempotencyKey: "synthetic-old-purchase" };
    const order = await seedLegacyApprovedPurchase(database, context, purchaseInput), receiptId = createEntityId();
    const input: RecordProcurementReceiptInput = { expectedVersion: 1, receivedAt: "2026-08-01T12:00:00.000Z", externalReference: "SYNTHETIC-OLD-ASN", idempotencyKey: "synthetic-142-receipt",
      lines: [{ lineKey: "L1", receivedQuantity: 1, rejectedQuantity: 0, rejectionReasonCode: null, lotCode: "OLD-142-LOT", expiresAt: null }] };
    const requestChecksum = createHash("sha256").update(canonicalJson({ version: 1, purchaseOrderId: order.id, input })).digest("hex");
    await withTenant(database.db, context, async tx => {
      await tx.insert(inventoryProcurementReceipts).values({ id: receiptId, tenantId: context.tenantId, purchaseOrderId: order.id, purchaseOrderVersionId: order.versionId,
        receivedAt: new Date(input.receivedAt), externalReference: input.externalReference, hasVariance: false, idempotencyKey: input.idempotencyKey, createdBy: context.userId });
      const posted = await inventory.receiveProcurementStock(tx, context, { receiptId, stockItemId: stock.id, locationId: location.id, lotCode: "OLD-142-LOT", quantity: 1, unit: "each", unitCostMinor: 100, currency: "USD", receivedAt: input.receivedAt, expiresAt: null, idempotencyKey: "synthetic-old-movement" });
      await tx.insert(inventoryProcurementReceiptLines).values({ id: createEntityId(), tenantId: context.tenantId, receiptId, lineKey: "L1", stockItemId: stock.id, destinationLocationId: location.id,
        receivedQuantity: 1, rejectedQuantity: 0, rejectionReasonCode: null, unit: "each", unitCostMinor: 100, lotId: posted.lot.id, movementId: posted.movement.id });
      await tx.insert(inventoryProcurementReceiptRequests).values({ id: createEntityId(), tenantId: context.tenantId, receiptId, purchaseOrderId: order.id, purchaseOrderVersionId: order.versionId,
        createdBy: context.userId, evidenceVersion: 1, requestChecksum, idempotencyKey: input.idempotencyKey });
      await tx.execute(sql`update inventory_purchase_orders set status='partially_received' where id=${order.id}::uuid`);
      await tx.insert(inventoryPurchaseOrderEvents).values({ id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: order.id, sequence: 3, action: "partially_received", fromStatus: "approved", toStatus: "partially_received",
        reasonCode: null, idempotencyKey: input.idempotencyKey, actorUserId: context.userId, occurredAt: new Date(input.receivedAt) });
    });
    const columns = await database.client.unsafe("select table_name,column_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position");
    const tables = new Map<string, string[]>();
    for (const column of columns) {
      const name = String(column.table_name), field = String(column.column_name);
      if (!/^[a-z_][a-z0-9_]*$/.test(name) || !/^[a-z_][a-z0-9_]*$/.test(field)) throw new Error("Unexpected historical identifier");
      tables.set(name, [...tables.get(name) ?? [], field]);
    }
    const snapshot = () => database.client.begin(async tx => {
      await tx.unsafe("set local time zone 'UTC'"); const hashes: { table: string; rows: number; hash: string }[] = [];
      for (const [table, fields] of tables) {
        const [result] = await tx.unsafe(`select count(*)::int as rows,md5(coalesce(string_agg(row_to_json(s)::text,E'\\n' order by row_to_json(s)::text),'')) as hash from (select ${fields.map(field => '"'+field+'"').join(",")} from "${table}") s`);
        hashes.push({ table, rows: Number(result!.rows), hash: String(result!.hash) });
      }
      return hashes;
    });
    const original = await snapshot();
    await migrateDatabase(database);
    expect(await snapshot()).toEqual(original);
    const evidence = await readMigrationEvidence(database);
    expect(evidence.actualRows.slice(0, 142)).toEqual(oldLedger);
    await expect(assertDatabaseMigrationsCurrent(database)).resolves.toMatchObject({ migrations: evidence.canonicalRows.length });
    expect((await withTenant(database.db, context, tx => tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, order.id))))[0]!.receivingPolicy).toBeNull();
    for (const table of ["inventory_incoming_standards", "inventory_procurement_arrivals", "inventory_procurement_arrival_lines", "inventory_incoming_inspections", "inventory_incoming_inspection_reviews", "inventory_incoming_postings", "inventory_incoming_returns", "inventory_incoming_commands"])
      expect((await database.client.unsafe(`select count(*)::int as count from "${table}"`))[0]!.count).toBe(0);
    expect((await procurement.recordReceipt(context, order.id, input)).receipt.id).toBe(receiptId);
    await expect(procurement.recordReceipt(context, order.id, { ...input, externalReference: "Changed old body" })).rejects.toMatchObject({ status: 409 });
    expect(await snapshot()).toEqual(original);
    const remainder = { ...input, idempotencyKey: "synthetic-new-legacy-receipt", lines: [{ ...input.lines[0]!, lotCode: "OLD-142-SECOND" }] };
    await procurement.recordReceipt(context, order.id, remainder);
    const receiptWorkspace = await procurement.workspace(context);
    expect(receiptWorkspace.receipts.filter(row => row.purchaseOrderId === order.id)).toHaveLength(2);
    expect((await inventory.workspace(context)).balances.filter(row => row.stockItemId === stock.id).reduce((sum, row) => sum + Number(row.physicalQuantity), 0)).toBe(2);
    await incoming.recordArrival(context, order.id, { code: "ACTUAL-AFTER-UPGRADE", expectedPurchaseOrderVersion: 1, arrivedAt: input.receivedAt, externalReference: "Synthetic actual new arrival after explicit adoption",
      lines: [{ lineKey: "L1", quantity: 1, unit: "each", holdingLocationId: location.id, lotCode: "实际原批号 Ab", expiresAt: null }], idempotencyKey: "synthetic-actual-new-arrival" });
    await expect(procurement.recordReceipt(context, order.id, { ...remainder, idempotencyKey: "synthetic-no-legacy-bypass" })).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "incoming_inspection_required" }) });
    const fresh = await procurement.createPurchaseOrder(context, { ...purchaseInput, code: "NEW-AFTER-UPGRADE", idempotencyKey: "synthetic-new-policy-purchase" });
    expect(fresh.receivingPolicy).toBe("inspection_required");
    process.stdout.write(JSON.stringify({ type: "incoming.upgrade.case", genuineOldMigrations: 142, preservedTables: original.length, preservedRows: original.reduce((sum, row) => sum + row.rows, 0),
      originalReceiptAndProofPreserved: true, noInventedInspection: true, oldPolicyUndeclared: true, legacyReplayRetained: true, newPurchasesRequireInspection: true }) + "\n");
  });
});
