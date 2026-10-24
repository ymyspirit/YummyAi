import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant, migrateDatabase, readMigrationEvidence, assertDatabaseMigrationsCurrent,
  memberships, membershipRoles, roles, fulfillmentSuppliers, inventoryProcurementRequisitions,
  inventoryProcurementRequisitionVersions, inventoryProcurementRfqs, inventorySupplierQuoteVersions,
  inventoryPurchaseOrders, inventoryPurchaseOrderVersions, inventoryPurchaseOrderEvents, inventoryProcurementWriteRequests } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { captureLegacyDataCheckpoint } from "../../../../tools/testing/legacy-data-checkpoint.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { ProcurementCommandService } from "./procurement-command.service.js";
import type { PrepareProcurementCommand } from "@yummyai/contracts/procurement/procurement-command";
import { procurementCommands } from "@yummyai/database";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0146") throw new Error("Genuine disposable 145 schema required before connecting");

describe("genuine 145 to 148 procurement upgrade", () => {
  const database = connectDatabase(), audit = new AuditService(database), inventory = new InventoryService(database, audit), procurement = new ProcurementService(database, inventory, audit);
  const commands = new ProcurementCommandService(database, new SecretVault(randomBytes(32)), procurement, audit);
  afterAll(() => database.client.end());
  it("preserves every old column and ledger entry, leaves old originals unknown, and binds only new actual writes", async () => {
    const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    const oldLedger = (await readMigrationEvidence(database)).actualRows;
    expect(oldLedger).toHaveLength(145);
    expect((await database.client.unsafe("select to_regclass('inventory_procurement_write_requests') as name"))[0]!.name).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic145 procurement',$2)", [context.tenantId, `old-procurement-${context.tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic145 buyer')", [context.userId, randomUUID(), `${context.userId}@example.test`]);
    const supplierId = createEntityId();
    await withTenant(database.db, context, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: context.tenantId, name: "Synthetic145 supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", createdBy: context.userId });
    });
    const warehouse = await inventory.createWarehouse(context, { code: "OLD145", name: "Synthetic145 warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    const location = await inventory.createLocation(context, { warehouseId: warehouse.id, code: "OLD145", name: "Synthetic145 location" });
    const stock = await inventory.createStockItem(context, { code: "OLD145", name: "Synthetic145 blank", skuId: null, baseUnit: "each" });
    const reqId = createEntityId(), reqVersionId = createEntityId(), rfqId = createEntityId(), quoteId = createEntityId(), orderId = createEntityId();
    const line = { lineKey: "L1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 10, unit: "each" as const };
    const reqInput = { code: "OLD145-REQ", reasonCode: "SYNTHETIC", lines: [line], idempotencyKey: "old145-request-key" };
    const rfqInput = { expectedRequisitionVersion: 1, supplierIds: [supplierId], responseDueAt: "2026-09-02T00:00:00.000Z", idempotencyKey: "old145-rfq-key" };
    const quoteInput = { supplierId, currency: "USD", validUntil: "2026-09-20T00:00:00.000Z", lines: [{ lineKey: "L1", unitCostMinor: 425, minimumOrderQuantity: 5, leadTimeDays: 7 }], idempotencyKey: "old145-quote-key" };
    const purchaseInput = { code: "OLD145-PO", supplierId, requisitionId: reqId, quoteId, currency: "USD", expectedAt: "2026-09-10T00:00:00.000Z", lines: [{ ...line, unitCostMinor: 425 }], idempotencyKey: "old145-purchase-key" };
    const revision = { expectedVersion: 1, currency: "USD", expectedAt: purchaseInput.expectedAt, lines: [{ ...line, quantity: 11, unitCostMinor: 425 }], idempotencyKey: "old145-revision-key" };
    const review = { expectedVersion: 2, decision: "approved" as const, reasonCode: "SYNTHETIC", idempotencyKey: "old145-review-key" };
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    // This is the actual old schema, before the new table and constraints exist.
    // These synthetic old facts intentionally have no invented request evidence.
    await withTenant(database.db, context, async tx => {
      await tx.insert(inventoryProcurementRequisitions).values({ id: reqId, tenantId: context.tenantId, code: reqInput.code, status: "ordered", idempotencyKey: reqInput.idempotencyKey, createdBy: context.userId });
      await tx.insert(inventoryProcurementRequisitionVersions).values({ id: reqVersionId, tenantId: context.tenantId, requisitionId: reqId, versionNumber: 1,
        reasonCode: reqInput.reasonCode, lineSnapshot: reqInput.lines, checksum: hash(reqInput), createdBy: context.userId });
      // The genuine 145 schema has no creation witness column yet.
      await tx.execute(sql`insert into inventory_procurement_rfqs
        (id,tenant_id,requisition_id,requisition_version_id,supplier_ids,response_due_at,idempotency_key,created_by)
        values(${rfqId},${context.tenantId},${reqId},${reqVersionId},${JSON.stringify([supplierId])}::jsonb,
          ${rfqInput.responseDueAt}::timestamptz,${rfqInput.idempotencyKey},${context.userId})`);
      await tx.insert(inventorySupplierQuoteVersions).values({ id: quoteId, tenantId: context.tenantId, rfqId, supplierId, versionNumber: 1, currency: "USD",
        validUntil: new Date(quoteInput.validUntil), lineSnapshot: quoteInput.lines, totalMinor: 4250, checksum: hash(quoteInput), idempotencyKey: quoteInput.idempotencyKey, createdBy: context.userId });
      await tx.insert(inventoryPurchaseOrders).values({ id: orderId, tenantId: context.tenantId, code: purchaseInput.code, supplierId, requisitionId: reqId, quoteId,
        expectedAt: new Date(purchaseInput.expectedAt), idempotencyKey: purchaseInput.idempotencyKey, createdBy: context.userId });
      for (const [number, input] of [[1, purchaseInput], [2, revision]] as const) await tx.insert(inventoryPurchaseOrderVersions).values({ id: createEntityId(), tenantId: context.tenantId,
        purchaseOrderId: orderId, versionNumber: number, currency: input.currency, expectedAt: new Date(input.expectedAt), lineSnapshot: input.lines,
        totalMinor: input.lines.reduce((sum, row) => sum + row.quantity * row.unitCostMinor, 0), checksum: hash(input), createdBy: context.userId });
      await tx.insert(inventoryPurchaseOrderEvents).values([
        { id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: orderId, sequence: 1, action: "created", fromStatus: null, toStatus: "draft", idempotencyKey: purchaseInput.idempotencyKey, actorUserId: context.userId },
        { id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: orderId, sequence: 2, action: "revised", fromStatus: "draft", toStatus: "draft", idempotencyKey: revision.idempotencyKey, actorUserId: context.userId },
        { id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: orderId, sequence: 3, action: "approved", fromStatus: "draft", toStatus: "approved", reasonCode: review.reasonCode, idempotencyKey: review.idempotencyKey, actorUserId: context.userId },
      ]);
      await tx.update(inventoryPurchaseOrders).set({ currentVersion: 2, status: "approved" });
    });
    const checkpoint = await captureLegacyDataCheckpoint(database);
    const original = await checkpoint.snapshot();
    await migrateDatabase(database);
    expect(await checkpoint.snapshot()).toEqual(original);
    const current = await readMigrationEvidence(database);
    expect(current.actualRows).toHaveLength(148);
    expect(current.actualRows.slice(0, 145)).toEqual(oldLedger);
    expect(current.actualRows.slice(145)).toEqual(current.canonicalRows.slice(145));
    expect((await database.client.unsafe("select creation_transaction_id as witness from inventory_procurement_rfqs where id=$1", [rfqId]))[0]!.witness).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).resolves.toMatchObject({ migrations: current.actualRows.length });
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests))).toEqual([]);
    const oldReplays = [
      () => procurement.createRequisition(context, reqInput), () => procurement.createRfq(context, reqId, rfqInput),
      () => procurement.recordSupplierQuote(context, rfqId, quoteInput), () => procurement.createPurchaseOrder(context, purchaseInput),
      () => procurement.revisePurchaseOrder(context, orderId, revision), () => procurement.reviewPurchaseOrder(context, orderId, review),
    ];
    for (const execute of oldReplays) await expect(execute()).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "procurement_input_unavailable" }) });
    let oldRfqAcceptedAsNew = false;
    const rollbackProbe = new Error("Synthetic RFQ probe rollback");
    try {
      await withTenant(database.db, context, async tx => {
        await tx.update(inventoryProcurementRfqs).set({ status: "closed" }).where(eq(inventoryProcurementRfqs.id, rfqId));
        await tx.insert(inventoryProcurementWriteRequests).values({ id: createEntityId(), tenantId: context.tenantId,
          operation: "rfq_create", targetId: reqId, createdBy: context.userId, idempotencyKey: rfqInput.idempotencyKey,
          requestChecksum: hash(rfqInput), requisitionId: reqId, rfqId });
        await tx.execute(sql`set constraints all immediate`);
        oldRfqAcceptedAsNew = true;
        throw rollbackProbe;
      });
    } catch (cause) {
      if (cause !== rollbackProbe) {
        const failure = cause as { code?: string; cause?: { code?: string } };
        expect(failure.code ?? failure.cause?.code).toBe("23514");
      }
    }
    process.stdout.write(JSON.stringify({ type: "procurement.upgrade.legacy-rfq-probe", oldRfqAcceptedAsNew, probeRolledBack: true }) + "\n");
    expect.soft(oldRfqAcceptedAsNew, "updating an old RFQ must not manufacture a new creation witness").toBe(false);
    await expect(withTenant(database.db, context, tx => tx.execute(sql`update inventory_procurement_rfqs
      set creation_transaction_id=pg_current_xact_id()::text where id=${rfqId}`)))
      .rejects.toMatchObject({ cause: { code: "23514", message: "RFQ creation transaction is immutable" } });
    await expect(withTenant(database.db, context, async tx => {
      const [inserted] = await tx.execute<{ witness: string; actual: string }>(sql`insert into inventory_procurement_rfqs
        (id,tenant_id,requisition_id,requisition_version_id,supplier_ids,response_due_at,idempotency_key,created_by,creation_transaction_id)
        values(${createEntityId()},${context.tenantId},${reqId},${reqVersionId},${JSON.stringify([supplierId])}::jsonb,
          ${rfqInput.responseDueAt}::timestamptz,${randomUUID()},${context.userId},'0')
        returning creation_transaction_id as witness,pg_current_xact_id()::text as actual`);
      expect(inserted!.witness).toBe(inserted!.actual); expect(inserted!.witness).not.toBe("0");
      throw rollbackProbe;
    })).rejects.toBe(rollbackProbe);
    expect(await checkpoint.snapshot()).toEqual(original);
    const oldPreparations: PrepareProcurementCommand[] = [
      { kind: "requisition_create", targetId: null, input: reqInput },
      { kind: "rfq_create", targetId: reqId, input: rfqInput },
      { kind: "quote_record", targetId: rfqId, input: quoteInput },
      { kind: "purchase_create", targetId: null, input: purchaseInput },
      { kind: "purchase_revise", targetId: orderId, input: revision },
      { kind: "purchase_review", targetId: orderId, input: review },
    ];
    for (const original of oldPreparations) {
      await expect.soft(commands.prepare(context, original), original.kind + " must not turn an old fact into a preparation")
        .rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "procurement_input_unavailable" }) });
    }
    expect.soft(await withTenant(database.db, context, tx => tx.select().from(procurementCommands))).toEqual([]);
    expect(await checkpoint.snapshot()).toEqual(original);
    const [clock] = await withTenant(database.db, context, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const future = new Date(new Date(clock!.now).getTime() + 86_400_000).toISOString();
    const freshReq = await procurement.createRequisition(context, { ...reqInput, code: "NEW146-REQ", idempotencyKey: randomUUID() });
    const freshRfq = await procurement.createRfq(context, freshReq.id, { ...rfqInput, responseDueAt: future, idempotencyKey: randomUUID() });
    const [freshWitness] = await withTenant(database.db, context, tx => tx.select({ witness: inventoryProcurementRfqs.creationTransactionId })
      .from(inventoryProcurementRfqs).where(eq(inventoryProcurementRfqs.id, freshRfq.id)));
    expect(freshWitness!.witness).toMatch(/^[0-9]+$/);
    const [unchangedWitness] = await withTenant(database.db, context, tx => tx.update(inventoryProcurementRfqs)
      .set({ status: "open", creationTransactionId: freshWitness!.witness }).where(eq(inventoryProcurementRfqs.id, freshRfq.id))
      .returning({ witness: inventoryProcurementRfqs.creationTransactionId }));
    expect(unchangedWitness!.witness).toBe(freshWitness!.witness);
    await expect(withTenant(database.db, context, tx => tx.execute(sql`update inventory_procurement_rfqs
      set creation_transaction_id=null where id=${freshRfq.id}`)))
      .rejects.toMatchObject({ cause: { code: "23514", message: "RFQ creation transaction is immutable" } });
    const freshQuote = await procurement.recordSupplierQuote(context, freshRfq.id, { ...quoteInput, validUntil: future, idempotencyKey: randomUUID() });
    const freshPurchase = await procurement.createPurchaseOrder(context, { ...purchaseInput, code: "NEW146-PO", requisitionId: freshReq.id, quoteId: freshQuote.id, expectedAt: future, idempotencyKey: randomUUID() });
    await procurement.revisePurchaseOrder(context, freshPurchase.id, { ...revision, expectedAt: future, idempotencyKey: randomUUID() });
    await procurement.reviewPurchaseOrder(context, freshPurchase.id, { ...review, idempotencyKey: randomUUID() });
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests))).toHaveLength(6);
    const newOriginal: PrepareProcurementCommand = { kind: "requisition_create", targetId: null,
      input: { ...reqInput, code: "NEW147-COMMAND", idempotencyKey: randomUUID() } };
    const prepared = await commands.prepare(context, newOriginal);
    expect(prepared.status).toBe("prepared"); expect(prepared.original).toEqual(newOriginal);
    const executed = await commands.execute(context, prepared.id);
    expect(executed.status).toBe("succeeded");
    expect((await commands.execute(context, prepared.id)).result).toEqual(executed.result);
    expect(await withTenant(database.db, context, tx => tx.select().from(procurementCommands))).toHaveLength(1);
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementWriteRequests))).toHaveLength(7);
    process.stdout.write(JSON.stringify({ type: "procurement.upgrade.case", genuineOldMigrations: 145, preservedTables: original.length,
      preservedRows: original.reduce((sum, row) => sum + row.rows, 0), currentMigrations: 148, originalLedgerPreserved: true,
      oldReplaysExplicitlyUnknown: 6, oldPreparationsExplicitlyUnknown: 6, noInventedOriginals: true,
      newDirectRequests: 6, newCommandRequests: 1, noDuplicateExecution: true }) + "\n");
  });
});
