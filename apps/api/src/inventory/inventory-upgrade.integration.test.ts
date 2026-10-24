import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertDatabaseMigrationsCurrent, migrateDatabase, readMigrationEvidence } from "../../../../packages/database/src/migrate.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "./inventory.service.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0138") throw new Error("Actual pre-0138 disposable database required");

describe("actual pre-0138 exact inventory upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });

  it("preserves original integer facts and replay identity while enabling exact fractional stock", async () => {
    const tenantId = createEntityId(), userId = createEntityId(), warehouseId = createEntityId();
    const sourceLocationId = createEntityId(), destinationLocationId = createEntityId(), stockItemId = createEntityId(), lotId = createEntityId();
    const openingId = createEntityId(), balanceId = createEntityId(), reservationId = createEntityId(), transferId = createEntityId();
    const oldFulfilledId = createEntityId();
    const policyId = createEntityId(), policyVersionId = createEntityId(), suggestionId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" };
    const occurredAt = "2026-07-23T02:00:00.000Z", key = "legacy-precision-opening";
    const beforeLedger = await database.client.unsafe("select hash,created_at from drizzle.__drizzle_migrations order by created_at,id");
    expect(beforeLedger).toHaveLength(137);
    const targetCount = (await readMigrationEvidence(database)).canonicalRows.length;
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const shape = () => database.client.unsafe("select format_type(atttypid,atttypmod) as type,atttypmod as modifier from pg_attribute where attrelid='public.inventory_movements'::regclass and attname='quantity_delta'");
    expect((await shape())[0]!.type).toBe("integer");
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Exact stock upgrade',$2)", [tenantId, `stock-upgrade-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Stock upgrade operator')", [userId, `stock-upgrade-${userId}`, `${userId}@example.test`]);
    // Seed the genuine old column contract, without asking current services to
    // pretend that a historical schema already has future columns.
    await withTenant(database.db, context, async tx => {
      await tx.execute(sql`insert into inventory_warehouses(id,tenant_id,code,name,type,country_code,time_zone,created_by) values(${warehouseId},${tenantId},'LEGACY-WH','Old warehouse','owned','US','UTC',${userId})`);
      await tx.execute(sql`insert into inventory_locations(id,tenant_id,warehouse_id,code,name,created_by) values(${sourceLocationId},${tenantId},${warehouseId},'OLD-SOURCE','Old source',${userId}),(${destinationLocationId},${tenantId},${warehouseId},'OLD-DEST','Old destination',${userId})`);
      await tx.execute(sql`insert into inventory_stock_items(id,tenant_id,code,name,base_unit,created_by) values(${stockItemId},${tenantId},'LEGACY-FABRIC','Old fabric','meter',${userId})`);
      await tx.execute(sql`insert into inventory_lots(id,tenant_id,stock_item_id,code,source_type,source_id,unit_cost_minor,unit_cost_currency,received_at,created_by) values(${lotId},${tenantId},${stockItemId},'LEGACY-LOT','opening','legacy-opening',450,'USD',${occurredAt}::timestamptz,${userId})`);
      await tx.execute(sql`insert into inventory_movements(id,tenant_id,stock_item_id,location_id,lot_id,bucket,type,quantity_delta,unit,source_type,source_id,reason_code,idempotency_key,recorded_by,occurred_at) values(${openingId},${tenantId},${stockItemId},${sourceLocationId},${lotId},'physical','opening',10,'meter','opening','legacy-opening','INITIAL_COUNT',${key},${userId},${occurredAt}::timestamptz)`);
      await tx.execute(sql`insert into inventory_balances(id,tenant_id,dimension_key,stock_item_id,location_id,lot_id,unit,physical_quantity,reserved_quantity,projection_version) values(${balanceId},${tenantId},${stockItemId+':'+sourceLocationId+':'+lotId},${stockItemId},${sourceLocationId},${lotId},'meter',10,2,2)`);
      await tx.execute(sql`insert into inventory_reservations(id,tenant_id,stock_item_id,location_id,lot_id,quantity,unit,source_type,source_id,idempotency_key,created_by) values(${reservationId},${tenantId},${stockItemId},${sourceLocationId},${lotId},2,'meter','manual','legacy-reservation','legacy-reservation-key',${userId})`);
      await tx.execute(sql`insert into inventory_reservation_events(id,tenant_id,reservation_id,sequence,action,to_status,reason_code,idempotency_key,actor_user_id) values(${createEntityId()},${tenantId},${reservationId},1,'reserved','active','RESERVATION_CREATED','legacy-reservation-key',${userId})`);
      await tx.execute(sql`insert into inventory_reservations(id,tenant_id,stock_item_id,location_id,lot_id,quantity,unit,source_type,source_id,status,version,idempotency_key,created_by) values(${oldFulfilledId},${tenantId},${stockItemId},${sourceLocationId},${lotId},1,'meter','manual','legacy-no-physical-consumption','fulfilled',2,'legacy-fulfilled-key',${userId})`);
      await tx.execute(sql`insert into inventory_reservation_events(id,tenant_id,reservation_id,sequence,action,from_status,to_status,reason_code,idempotency_key,actor_user_id) values
        (${createEntityId()},${tenantId},${oldFulfilledId},1,'reserved',null,'active','RESERVATION_CREATED','legacy-fulfilled-reserve',${userId}),
        (${createEntityId()},${tenantId},${oldFulfilledId},2,'fulfilled','active','fulfilled','MANUAL_COMPLETE','legacy-fulfilled-close',${userId})`);
      await tx.execute(sql`insert into inventory_transfers(id,tenant_id,stock_item_id,lot_id,source_location_id,destination_location_id,quantity,unit,idempotency_key,created_by) values(${transferId},${tenantId},${stockItemId},${lotId},${sourceLocationId},${destinationLocationId},3,'meter','legacy-transfer-key',${userId})`);
      await tx.execute(sql`insert into inventory_transfer_events(id,tenant_id,transfer_id,sequence,action,to_status,reason_code,idempotency_key,actor_user_id) values(${createEntityId()},${tenantId},${transferId},1,'created','draft','TRANSFER_CREATED','legacy-transfer-key',${userId})`);
      await tx.execute(sql`insert into inventory_replenishment_policies(id,tenant_id,stock_item_id,location_id,created_by) values(${policyId},${tenantId},${stockItemId},${sourceLocationId},${userId})`);
      await tx.execute(sql`insert into inventory_replenishment_policy_versions(id,tenant_id,policy_id,version_number,reorder_point,safety_stock,minimum_order_quantity,lead_time_days,service_level_bps,review_interval_days,idempotency_key,created_by) values(${policyVersionId},${tenantId},${policyId},1,10,2,1,7,9500,7,'legacy-policy-key',${userId})`);
      await tx.execute(sql`insert into inventory_replenishment_suggestions(id,tenant_id,policy_id,policy_version_id,stock_item_id,location_id,available_quantity,in_transit_quantity,suggested_quantity,idempotency_key,created_by) values(${suggestionId},${tenantId},${policyId},${policyVersionId},${stockItemId},${sourceLocationId},8,0,4,'legacy-suggestion-key',${userId})`);
    });
    const tables = ["inventory_warehouses", "inventory_locations", "inventory_stock_items", "inventory_lots", "inventory_movements", "inventory_balances", "inventory_reservations", "inventory_reservation_events", "inventory_transfers", "inventory_transfer_events", "inventory_replenishment_policies", "inventory_replenishment_policy_versions", "inventory_replenishment_suggestions"];
    const columns = await database.client.unsafe("select table_name,column_name from information_schema.columns where table_schema='public' and table_name=any($1::text[]) order by table_name,ordinal_position", [tables]);
    const snapshot = (table: string, ids?: string[]) => withTenant(database.db, context, async tx => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const pairs = columns.filter(c => c.table_name === table).flatMap(c => [sql`${c.column_name}::text`, sql`${sql.identifier(String(c.column_name))}`]);
      if (!pairs.length || ids?.length === 0) return [];
      const where = ids ? sql`where id in (${sql.join(ids.map(id => sql`${id}::uuid`), sql`,`)})` : sql``;
      return tx.execute<{ id: string; hash: string }>(sql`select id::text as id,md5(jsonb_build_object(${sql.join(pairs, sql`,`)})::text) as hash from ${sql.identifier(table)} ${where} order by id`);
    });
    const original = new Map<string, Array<{ id: string; hash: string }>>();
    for (const table of tables) original.set(table, [...await snapshot(table)]);
    await migrateDatabase(database);
    await expect(assertDatabaseMigrationsCurrent(database)).resolves.toEqual({ migrations: targetCount });
    expect((await shape())[0]).toMatchObject({ type: "numeric", modifier: -1 });
    for (const table of tables) expect([...await snapshot(table)]).toEqual(original.get(table));
    const inventory = new InventoryService(database, new AuditService(database));
    const opening = { stockItemId, locationId: sourceLocationId, lotId, bucket: "physical" as const, type: "opening" as const,
      quantityDelta: "10.000000000", unit: "meter" as const, sourceType: "opening" as const, sourceId: "legacy-opening", reasonCode: "INITIAL_COUNT", occurredAt, idempotencyKey: key };
    const replay = await inventory.recordMovement(context, opening);
    expect(replay.movement).toMatchObject({ id: openingId, quantityDelta: 10 });
    expect((await inventory.getReservation(context, reservationId)).reservation.quantity).toBe(2);
    const fulfilled = await inventory.getReservation(context, oldFulfilledId);
    expect(fulfilled.reservation).toMatchObject({ quantity: 1, status: "fulfilled", version: 2 });
    expect(fulfilled.remainingQuantity).toBe(0);
    expect(fulfilled.events).toHaveLength(2);
    expect(fulfilled.events.every(event => event.quantityDelta === null && event.movementId === null)).toBe(true);
    expect((await inventory.getTransfer(context, transferId)).transfer.quantity).toBe(3);
    const fresh = await inventory.recordMovement(context, { ...opening, type: "receipt", quantityDelta: "0.25", idempotencyKey: "legacy-fractional-receipt" });
    expect(fresh.balance).toMatchObject({ physicalQuantity: "10.25", reservedQuantity: 2, availableQuantity: "8.25" });
    for (const table of ["inventory_lots", "inventory_movements", "inventory_reservation_events", "inventory_transfer_events", "inventory_replenishment_suggestions"]) {
      expect([...await snapshot(table, original.get(table)!.map(row => row.id))]).toEqual(original.get(table));
    }
    expect(() => JSON.stringify(fresh)).not.toThrow();
    const rebuilt = await inventory.rebuildProjection(context, { idempotencyKey: "legacy-no-invented-consumption-rebuild" });
    expect(rebuilt.balances.find(row => row.stockItemId === stockItemId)).toMatchObject({ physicalQuantity: "10.25", reservedQuantity: 2 });
    await migrateDatabase(database);
    const afterLedger = await database.client.unsafe("select hash,created_at from drizzle.__drizzle_migrations order by created_at,id");
    expect(afterLedger).toHaveLength(targetCount);
    expect(afterLedger.slice(0, beforeLedger.length)).toEqual(beforeLedger);
    const [role] = await withTenant(database.db, context, tx => tx.execute<{ role: string }>(sql`select current_user as role`));
    expect(role!.role).toBe("yummyai_app");
  });
});
