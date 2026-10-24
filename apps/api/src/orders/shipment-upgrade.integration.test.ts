import { createHash, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { ConflictException } from "@nestjs/common";
import { CreateShipmentInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase, assertDatabaseMigrationsCurrent } from "../../../../packages/database/src/migrate.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";

describe("actual pre-0131 shipment upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("preserves old package bytes and receipts, never guesses sources, and requires a new reviewed version for a legacy draft", async () => {
    const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(name) || process.env.E2E_ISOLATED_DAILY !== "1") throw new Error("Disposable upgrade runner required");
    const [{ present }] = await database.client.unsafe("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='shipment_versions' and column_name='production_source_version') as present");
    expect(present).toBe(false);
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: ["order:read", "order:write", "order:pii:read"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic old shipments',$2)", [tenantId, `old-shipments-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic old packer')", [userId, `old-shipment-${userId}`, `${userId}@example.test`]);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic old shop','GLOBAL','etsy_oauth',$3)", [accountId, tenantId, userId]);
    const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit);
    const shipping = new OrderShipmentService(database, vault, orders, audit, { enqueue: async () => undefined });
    const fixtures = [];
    for (const dispatched of [false, true]) {
      const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: randomUUID(), providerStatus: "paid",
        placedAt: "2026-10-01T00:00:00.000Z", orderTotal: null, lines: [{ externalLineId: "old-source-item", externalListingId: null, skuCode: null, title: "Synthetic old source", quantity: 2, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
      await database.client.unsafe("update orders set workflow_state='awaiting_shipment',address_status='protected' where id=$1", [order.id]);
      const [source] = await syntheticPassedProduction(database, context, order.id, [{ id: order.lines[0]!.id, quantity: 2 }]);
      const shipmentId = createEntityId(), versionId = createEntityId(), packageId = createEntityId(), packageLineId = createEntityId();
      const input = CreateShipmentInputSchema.parse({ shipDate: "2026-10-02T00:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: randomUUID(),
        packages: [{ packageReferenceId: "LEGACY-ONE", trackingNumber: "SYNTHETIC-OLD-TRACK", carrierCode: "SYNTHETIC", carrierName: "Synthetic old carrier", carrierService: "Synthetic service", lines: [{ orderLineId: order.lines[0]!.id, quantity: 1 }] }] });
      const review = { decision: "approved" as const, reasonCode: "SYNTHETIC_LEGACY", reason: "Original legacy approval", expectedCurrentVersion: 1, idempotencyKey: randomUUID() };
      await withTenant(database.db, context, async tx => {
        const [{ role }] = await tx.execute<{ role: string }>(sql`select current_user as role`); expect(role).toBe("yummyai_app");
        // Actual old SQL shape before migration; no new-column omission against a modern schema.
        await tx.execute(sql`insert into shipments(id,tenant_id,order_id,status,current_version_number,approved_version_number,idempotency_key,created_by)
          values(${shipmentId},${tenantId},${order.id},${dispatched ? "shipped" : "draft"},1,${dispatched ? 1 : null},${input.idempotencyKey},${userId})`);
        await tx.execute(sql`insert into shipment_versions(id,tenant_id,shipment_id,version_number,ship_date,ship_from_country_code,idempotency_key,created_by)
          values(${versionId},${tenantId},${shipmentId},1,${input.shipDate},'US',${input.idempotencyKey},${userId})`);
        await tx.execute(sql`insert into shipment_packages(id,tenant_id,shipment_id,shipment_version_id,package_reference_id,tracking_number,carrier_code,carrier_name,carrier_service)
          values(${packageId},${tenantId},${shipmentId},${versionId},'LEGACY-ONE','SYNTHETIC-OLD-TRACK','SYNTHETIC','Synthetic old carrier','Synthetic service')`);
        await tx.execute(sql`insert into shipment_package_lines(id,tenant_id,shipment_id,shipment_version_id,package_id,order_line_id,quantity)
          values(${packageLineId},${tenantId},${shipmentId},${versionId},${packageId},${order.lines[0]!.id},1)`);
        if (dispatched) {
          const reasonChecksum = createHash("sha256").update(review.reason).digest("hex");
          await tx.execute(sql`insert into shipment_version_reviews(id,tenant_id,shipment_id,shipment_version_id,decision,reason_code,encrypted_reason,reason_checksum,idempotency_key,reviewed_by)
            values(${createEntityId()},${tenantId},${shipmentId},${versionId},'approved',${review.reasonCode},${vault.encrypt(review.reason)},${reasonChecksum},${review.idempotencyKey},${userId})`);
          await tx.execute(sql`insert into shipment_tracking_events(id,tenant_id,shipment_id,package_id,status,provider,external_event_id,detail_code,occurred_at)
            values(${createEntityId()},${tenantId},${shipmentId},${packageId},'picked_up','legacy-synthetic',${randomUUID()},'SYNTHETIC_OLD_HANDOVER','2026-10-02T01:00:00Z')`);
        }
      });
      const [old] = await database.client.unsafe("select to_jsonb(v) as version,(select jsonb_agg(to_jsonb(p) order by p.id) from shipment_packages p where p.shipment_id=v.shipment_id) as packages,(select jsonb_agg(to_jsonb(l) order by l.id) from shipment_package_lines l where l.shipment_id=v.shipment_id) as lines from shipment_versions v where v.id=$1", [versionId]);
      fixtures.push({ orderId: order.id, lineId: order.lines[0]!.id, shipmentId, versionId, source: source!, input, review, old, dispatched });
    }
    await migrateDatabase(database);
    await expect(assertDatabaseMigrationsCurrent(database)).resolves.toMatchObject({ migrations: expect.any(Number) });
    for (const fixture of fixtures) {
      const [after] = await database.client.unsafe("select to_jsonb(v)-'production_source_version'-'request_checksum' as version,(select jsonb_agg(to_jsonb(p) order by p.id) from shipment_packages p where p.shipment_id=v.shipment_id) as packages,(select jsonb_agg(to_jsonb(l) order by l.id) from shipment_package_lines l where l.shipment_id=v.shipment_id) as lines from shipment_versions v where v.id=$1", [fixture.versionId]);
      expect(after).toEqual(fixture.old);
      const recovered = await shipping.create(context, fixture.orderId, fixture.input);
      expect(recovered.shipment.id).toBe(fixture.shipmentId);
      expect(recovered.versions[0]!.productionSourceVersion).toBeNull(); expect(recovered.versions[0]!.requestChecksum).toBeNull();
      expect(recovered.productionAllocations).toEqual([]);
      const editor = await shipping.versionEditor(context, fixture.shipmentId);
      expect(editor.productionSourceVersion).toBeNull();
      expect(editor.canRevise).toBe(!fixture.dispatched);
      expect(editor.content.packages[0]!.lines[0]!.productionAllocations).toBeUndefined();
      await expect(shipping.create(context, fixture.orderId, { ...fixture.input, shipFromCountryCode: "CN" })).rejects.toBeInstanceOf(ConflictException);
      if (fixture.dispatched) {
        expect((await shipping.reviewVersion(context, fixture.shipmentId, fixture.versionId, fixture.review)).reviews).toHaveLength(1);
        const sources = await shipping.productionSources(context, fixture.orderId);
        expect(sources[0]!.blockers.join(" ")).toContain("旧包裹未记录生产来源");
        expect(sources[0]!.availableQuantity).toBe(0); expect(recovered.physicalHandover.allDispatched).toBe(true);
      } else {
        await expect(shipping.reviewVersion(context, fixture.shipmentId, fixture.versionId, fixture.review)).rejects.toThrow("旧发货版本未记录生产来源");
        const { source } = fixture;
        const revised = await shipping.appendVersion(context, fixture.shipmentId, { ...fixture.input, expectedCurrentVersion: 1, idempotencyKey: randomUUID(), packages: [{ ...fixture.input.packages[0]!,
          lines: [{ orderLineId: fixture.lineId, quantity: 1, productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
            qualityInspectionId: source.qualityInspectionId, expectedProductionProjectionVersion: 5, quantity: 1 }] }] }] });
        const approved = await shipping.reviewVersion(context, fixture.shipmentId, revised.versions[1]!.id, { ...fixture.review, expectedCurrentVersion: 2, idempotencyKey: randomUUID() });
        expect(approved.shipment.approvedVersionNumber).toBe(2); expect(approved.versions[0]!.productionSourceVersion).toBeNull(); expect(approved.productionAllocations).toHaveLength(1);
      }
    }
  });
});
