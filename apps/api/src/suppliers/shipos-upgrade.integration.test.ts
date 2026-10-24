import { insertLegacy, ensureLegacyMembership, legacyRecordSnapshot, upgradeLegacyDatabase } from "../orders/legacy-upgrade.test-fixture.js";
import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, fulfillmentSuppliers, marketplaceAccounts, orderSourceSnapshots, orders, orderLines, orderWorkItems, shiposConnections, shiposSyncRuns, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { assertDatabaseMigrationsCurrent, migrateDatabase, readMigrationEvidence } from "../../../../packages/database/src/migrate.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ShiposReadGateway } from "./shipos-read.gateway.js";
import { ShiposService } from "./shipos.service.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0137") throw new Error("Actual pre-0137 disposable database required");

describe("actual pre-0137 ShipOS observation upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("preserves old evidence without inventing sequence values and starts ordered replay-safe observations", async () => {
    const tenantId = createEntityId(), userId = createEntityId(), supplierId = createEntityId(), connectionId = createEntityId(), oldRunId = createEntityId(), oldRecordId = createEntityId();
    const accountId = createEntityId(), orderId = createEntityId(), lineId = createEntityId(), snapshotId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" };
    const vault = new SecretVault(Buffer.alloc(32, 19));
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const beforeLedger = await database.client.unsafe("select hash,created_at from drizzle.__drizzle_migrations order by created_at,id");
    const currentMigrationCount = (await readMigrationEvidence(database)).canonicalRows.length;
    expect(beforeLedger).toHaveLength(136);
    const [shape] = await database.client`select count(*)::integer as count from information_schema.columns where table_schema='public' and table_name='shipos_sync_runs' and column_name='sync_sequence'`;
    expect(shape!.count).toBe(0);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'ShipOS upgrade fixture',$2)", [tenantId, `shipos-upgrade-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Upgrade operator')", [userId, `shipos-upgrade-${userId}`, `${userId}@example.test`]);
    await ensureLegacyMembership(database, context);
    const evidence = { orderNumber: "LEGACY", trackingNumber: "OLD-TRACK", labelAvailable: false, statusCode: 14, labelStatusCode: 2,
      cancelStatusCode: 0, settlementStatusCode: 1, channel: null, fee: null, currency: null, diagnostics: [] };
    await withTenant(database.db, context, async tx => {
      await insertLegacy(tx, fulfillmentSuppliers, { id: supplierId, tenantId, name: "Upgrade supplier", kind: "manual", regionCode: "", settlementCurrency: "USD", createdBy: userId });
      await insertLegacy(tx, marketplaceAccounts, { id: accountId, tenantId, platform: "amazon", displayName: "Upgrade shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: ["ATVPDKIKX0DER"], createdBy: userId });
      await insertLegacy(tx, orderSourceSnapshots, { id: snapshotId, tenantId, accountId, platform: "amazon", externalEventId: `upgrade-${orderId}`, externalOrderId: "LEGACY", normalizedOrderId: orderId, redactedPayload: {}, payloadChecksum: "d".repeat(64) });
      await insertLegacy(tx, orders, { id: orderId, tenantId, accountId, sourceSnapshotId: snapshotId, platform: "amazon", externalOrderId: "LEGACY", providerStatus: "synthetic", lineCount: 1, placedAt: new Date(), addressStatus: "protected" });
      await insertLegacy(tx, orderLines, { id: lineId, tenantId, orderId, externalLineId: "upgrade-line", title: "Synthetic item", quantity: 1 });
      await insertLegacy(tx, orderWorkItems, { id: lineId, tenantId, encryptedDataKey: vault.encrypt(Buffer.alloc(32, 8).toString("base64url")), expiresAt: sql`clock_timestamp()+interval '1 day'` });
      await tx.execute(sql`insert into shipos_connections(id,tenant_id,supplier_id,name,status,version,encrypted_credentials,last_request_key,last_request_checksum,created_by)
        values(${connectionId},${tenantId},${supplierId},'Legacy connection','active',1,${vault.encrypt(JSON.stringify({ appKey: "synthetic-upgrade-key", appSecret: "synthetic-upgrade-secret" }))},${randomUUID()},${"a".repeat(64)},${userId})`);
      await tx.execute(sql`insert into shipos_sync_runs(id,tenant_id,connection_id,connection_version,idempotency_key,request_checksum,order_numbers,status,created_by,created_at,completed_at)
        values(${oldRunId},${tenantId},${connectionId},1,${randomUUID()},${"b".repeat(64)},${JSON.stringify(["LEGACY"])}::jsonb,'completed',${userId},clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day')`);
      await tx.execute(sql`insert into shipos_order_snapshots(id,tenant_id,run_id,evidence,local_order_id,local_line_id,match,fetched_at)
        values(${oldRecordId},${tenantId},${oldRunId},${JSON.stringify(evidence)}::jsonb,${orderId},${lineId},'matched',clock_timestamp()+interval '1 day')`);
    });
    const original = await legacyRecordSnapshot(database, context, { connection: { table: "shipos_connections", id: connectionId },
      run: { table: "shipos_sync_runs", id: oldRunId }, snapshot: { table: "shipos_order_snapshots", id: oldRecordId } });
    const before = await original();
    await upgradeLegacyDatabase(database, 137);
    await expect(assertDatabaseMigrationsCurrent(database)).resolves.toEqual({ migrations: currentMigrationCount });
    expect(await original()).toEqual(before);
    const [connection] = await withTenant(database.db, context, tx => tx.select().from(shiposConnections));
    const [legacy] = await withTenant(database.db, context, tx => tx.select().from(shiposSyncRuns).where(eq(shiposSyncRuns.id, oldRunId)));
    expect(connection!.syncSequence).toBe(0n); expect(legacy!.syncSequence).toBeNull();
    const gateway = new ShiposReadGateway();
    const queries = vi.spyOn(gateway, "orders").mockResolvedValue([{ ...evidence, trackingNumber: "NEW-TRACK" }]);
    vi.spyOn(gateway, "detail").mockResolvedValue({ trackingNumber: "NEW-TRACK", labelUrl: null, channel: null, fee: null, currency: null });
    const service = new ShiposService(database, vault, gateway, new AuditService(database));
    const fields = { carrierCode: "UPS", carrierName: "Synthetic UPS", carrierService: "Synthetic ground", shipFromCountryCode: "CN", trackingNumber: "OLD-TRACK" };
    expect((await service.orderEvidence(context, orderId))[0]!.blockers.join()).toContain("可靠同步顺序");
    await expect(withTenant(database.db, context, tx => service.pinShipmentEvidence(context, tx, orderId, { supplierId, recordId: oldRecordId, expectedConnectionVersion: 1 }, fields)))
      .rejects.toMatchObject({ message: expect.stringContaining("可靠同步顺序") });
    expect(queries).not.toHaveBeenCalled();
    const input = { orderNumbers: ["LEGACY"], expectedVersion: 1, idempotencyKey: randomUUID() };
    const fresh = await service.sync(context, supplierId, input);
    expect((await service.sync(context, supplierId, input)).id).toBe(fresh.id);
    expect(queries).toHaveBeenCalledTimes(1);
    const workspace = await service.workspace(context, supplierId);
    expect(workspace.runs[0]!.id).toBe(fresh.id);
    expect(workspace.recent[0]!.runId).toBe(fresh.id);
    expect(await withTenant(database.db, context, tx => service.pinShipmentEvidence(context, tx, orderId,
      { supplierId, recordId: fresh.records[0]!.id, expectedConnectionVersion: 1 }, { ...fields, trackingNumber: "NEW-TRACK" }))).toMatchObject({ recordId: fresh.records[0]!.id });
    expect(() => JSON.stringify(workspace)).not.toThrow();
    const [current] = await withTenant(database.db, context, tx => tx.select().from(shiposConnections));
    expect(current!.syncSequence).toBe(1n); expect(current!.version).toBe(1);
    await expect(withTenant(database.db, context, tx => tx.update(shiposSyncRuns).set({ syncSequence: 1n }).where(eq(shiposSyncRuns.id, oldRunId)))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.update(shiposConnections).set({ syncSequence: 0n }).where(eq(shiposConnections.id, connectionId)))).rejects.toThrow();
    expect(await original()).toEqual(before);
    await migrateDatabase(database);
    const afterLedger = await database.client.unsafe("select hash,created_at from drizzle.__drizzle_migrations order by created_at,id");
    expect(afterLedger).toHaveLength(currentMigrationCount); expect(afterLedger.slice(0, beforeLedger.length)).toEqual(beforeLedger);
  });
});
