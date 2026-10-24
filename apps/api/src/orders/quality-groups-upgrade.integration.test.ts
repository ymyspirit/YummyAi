import { ensureLegacyMembership, legacyRecordSnapshot, seedLegacyOrder, seedLegacyPassedProduction, upgradeLegacyDatabase } from "./legacy-upgrade.test-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { CreateShipmentInputSchema, RecordQualityInspectionInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { connectDatabase, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { assertDatabaseMigrationsCurrent } from "../../../../packages/database/src/migrate.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { inspectionRequestChecksum } from "./quality-inspection-evidence.js";
import { productionReadyQuantity } from "@yummyai/order-core";

describe("actual pre-0132 physical quality group upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("preserves real V2 inspection and V1 shipment receipts without inventing physical groups or defect quantities", async () => {
    const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(name) || process.env.E2E_ISOLATED_DAILY !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0132")
      throw new Error("Actual disposable pre-0132 upgrade required");
    const [{ groups }] = await database.client.unsafe("select to_regclass('quality_inspection_groups') as groups"); expect(groups).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: ["order:read", "order:write", "order:pii:read"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic physical group upgrade',$2)", [tenantId, `group-upgrade-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic old quality operator')", [userId, `group-upgrade-${userId}`, `${userId}@example.test`]);
    await ensureLegacyMembership(database, context);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic old group shop','GLOBAL','etsy_oauth',$3)", [accountId, tenantId, userId]);
    const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit);
    const production = new OrderProductionService(database, vault, orders, audit), shipping = new OrderShipmentService(database, vault, orders, audit, { enqueue: async () => undefined });
    const order = await seedLegacyOrder(database, context, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: randomUUID(), providerStatus: "paid",
      placedAt: "2026-10-01T00:00:00.000Z", orderTotal: null, lines: [{ externalLineId: "old-group-item", externalListingId: null, skuCode: null, title: "Synthetic pre-group stock", quantity: 2, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    await database.client.unsafe("update orders set workflow_state='awaiting_shipment',address_status='protected' where id=$1", [order.id]);
    const [source] = await seedLegacyPassedProduction(database, context, order.id, [{ id: order.lines[0]!.id, quantity: 2 }]);
    const shipmentId = createEntityId(), versionId = createEntityId(), packageId = createEntityId(), packageLineId = createEntityId(), allocationId = createEntityId();
    const shipmentInput = CreateShipmentInputSchema.parse({ shipDate: "2026-10-02T00:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: randomUUID(), packages: [{
      packageReferenceId: "OLD-GROUP-PACK", trackingNumber: "SYNTHETIC-OLD-GROUP", carrierCode: "SYNTHETIC", carrierName: "Synthetic old carrier", carrierService: "Synthetic old service",
      lines: [{ orderLineId: source!.orderLineId, quantity: 1, productionAllocations: [{ productionOrderId: source!.productionOrderId, productionVersionId: source!.productionVersionId,
        qualityInspectionId: source!.qualityInspectionId, expectedProductionProjectionVersion: source!.expectedProductionProjectionVersion, quantity: 1 }] }] }] });
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    await withTenant(database.db, context, async tx => {
      await tx.execute(sql`insert into shipments(id,tenant_id,order_id,status,current_version_number,idempotency_key,created_by) values(${shipmentId},${tenantId},${order.id},'draft',1,${shipmentInput.idempotencyKey},${userId})`);
      await tx.execute(sql`insert into shipment_versions(id,tenant_id,shipment_id,version_number,ship_date,ship_from_country_code,idempotency_key,created_by,production_source_version,request_checksum)
        values(${versionId},${tenantId},${shipmentId},1,${shipmentInput.shipDate},'US',${shipmentInput.idempotencyKey},${userId},1,${hash(canonicalJson({ actor: userId, input: shipmentInput }))})`);
      await tx.execute(sql`insert into shipment_packages(id,tenant_id,shipment_id,shipment_version_id,package_reference_id,tracking_number,carrier_code,carrier_name,carrier_service)
        values(${packageId},${tenantId},${shipmentId},${versionId},'OLD-GROUP-PACK','SYNTHETIC-OLD-GROUP','SYNTHETIC','Synthetic old carrier','Synthetic old service')`);
      await tx.execute(sql`insert into shipment_package_lines(id,tenant_id,shipment_id,shipment_version_id,package_id,order_line_id,quantity) values(${packageLineId},${tenantId},${shipmentId},${versionId},${packageId},${source!.orderLineId},1)`);
      await tx.execute(sql`insert into shipment_production_allocations(id,tenant_id,shipment_id,shipment_version_id,package_id,package_line_id,order_line_id,production_order_id,production_version_id,quality_inspection_id,production_projection_version,quantity)
        values(${allocationId},${tenantId},${shipmentId},${versionId},${packageId},${packageLineId},${source!.orderLineId},${source!.productionOrderId},${source!.productionVersionId},${source!.qualityInspectionId},${source!.expectedProductionProjectionVersion},1)`);
    });
    const inspectionId = createEntityId(), defectId = createEntityId();
    const inspectionInput = RecordQualityInspectionInputSchema.parse({ qualityStandardVersionId: source!.standardId, expectedProductionProjectionVersion: 5,
      assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", passed: false, scoreBps: 9000, evidenceAssetIds: [] }] }, result: "failed", scoreBps: 9000,
      inspectedAt: "2026-10-02T01:00:00.000Z", defects: [{ code: "STOCK", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic original unquantified defect", evidenceAssetIds: [] }], idempotencyKey: randomUUID() });
    await withTenant(database.db, context, async tx => {
      // A historical recorder clock can be ahead. A newer production projection
      // must still determine the current root; do not rewrite the original time.
      await tx.execute(sql`insert into quality_inspections(id,tenant_id,production_order_id,quality_standard_version_id,result,score_bps,evidence_asset_ids,idempotency_key,inspected_by,inspected_at,assessment_version,criterion_results,request_checksum,production_version_id,production_projection_version,created_at)
        values(${inspectionId},${tenantId},${source!.productionOrderId},${source!.standardId},'failed',9000,'[]'::jsonb,${inspectionInput.idempotencyKey},${userId},${inspectionInput.inspectedAt},2,${JSON.stringify(inspectionInput.assessment!.criterionResults)}::jsonb,${inspectionRequestChecksum(context, inspectionInput)},${source!.productionVersionId},5,clock_timestamp()+interval '1 day')`);
      await tx.execute(sql`insert into quality_defects(id,tenant_id,production_order_id,inspection_id,code,severity,responsibility,disposition,encrypted_detail,detail_checksum,evidence_asset_ids)
        values(${defectId},${tenantId},${source!.productionOrderId},${inspectionId},'STOCK','major','supplier','remake',${vault.encrypt(inspectionInput.defects[0]!.note)},${hash(inspectionInput.defects[0]!.note)},'[]'::jsonb)`);
      await tx.execute(sql`update production_orders set status='quality_hold',projection_version=6 where id=${source!.productionOrderId}`);
    });
    const snapshot = await legacyRecordSnapshot(database, context, { inspection: { table: "quality_inspections", id: inspectionId },
      defect: { table: "quality_defects", id: defectId }, version: { table: "shipment_versions", id: versionId },
      allocation: { table: "shipment_production_allocations", id: allocationId } });
    const before = await snapshot(); await upgradeLegacyDatabase(database, 132); await assertDatabaseMigrationsCurrent(database);
    expect(await snapshot()).toEqual(before);
    const original = await production.inspect(context, source!.productionOrderId, inspectionInput);
    expect(original.inspections.find(item => item.id === inspectionId)!.assessmentVersion).toBe(2);
    expect(original.defects.find(item => item.id === defectId)).toMatchObject({ qualityGroupId: null, affectedQuantity: null });
    expect((await production.qualityGroups(context, source!.productionOrderId)).groups).toEqual([]);
    const replay = await shipping.create(context, order.id, shipmentInput);
    expect(replay.shipment.id).toBe(shipmentId); expect(replay.versions[0]!.productionSourceVersion).toBe(1);
    expect(replay.productionAllocations[0]).toMatchObject({ qualityGroupId: null, groupQualityResult: null });
    const basis = await production.qualityGroups(context, source!.productionOrderId);
    // The quality gate uses the database clock; the Windows host and Docker VM can differ.
    const [inspectionClock] = await withTenant(database.db, context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
    const grouped = await production.inspectGroups(context, source!.productionOrderId, { formatVersion: 3, productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId, qualityStandardVersionId: source!.standardId,
      inspectedAt: new Date(inspectionClock!.now).toISOString(), segregationConfirmed: true, groups: [
        { key: "A", label: "Synthetic accepted bin", quantity: 1, criterionResults: [{ code: "STOCK", scoreBps: 10000, passed: true, evidenceAssetIds: [] }], defects: [] },
        { key: "B", label: "Synthetic held bin", quantity: 1, criterionResults: [{ code: "STOCK", scoreBps: 9000, passed: false, evidenceAssetIds: [] }], defects: inspectionInput.defects },
      ], idempotencyKey: randomUUID() });
    const accepted = grouped.workspace.groups.find(group => group.result === "passed")!;
    const chronology = await withTenant(database.db, context, tx => tx.execute(sql`select id,assessment_version,production_projection_version,created_at::text,inspected_at::text
      from quality_inspections where production_order_id=${source!.productionOrderId} order by created_at,id`));
    expect(grouped.workspace.rootInspectionId, JSON.stringify({ chronology, savedInspection: grouped.inspectionId })).toBe(grouped.inspectionId);
    const [ready] = await withTenant(database.db, context, tx => tx.execute<{ quantity: number }>(sql`select ${productionReadyQuantity(sql`${source!.productionOrderId}::uuid`)} as quantity`));
    expect(ready!.quantity).toBe(1);
    expect((await production.get(context, source!.productionOrderId)).inspections[0]!.id).toBe(grouped.inspectionId);
    const sources = await shipping.productionSources(context, order.id), candidate = sources.find(item => item.qualityGroupId === accepted.id)!;
    expect(candidate, JSON.stringify({ chronology, groups: grouped.workspace.groups.map(group => ({ id: group.id, active: group.active, result: group.result })), sources })).toBeDefined();
    const revised = await shipping.appendVersion(context, shipmentId, { ...shipmentInput, expectedCurrentVersion: 1, idempotencyKey: randomUUID(), packages: [{ ...shipmentInput.packages[0]!, lines: [{
      orderLineId: source!.orderLineId, quantity: 1, productionAllocations: [{ productionOrderId: candidate.productionOrderId, productionVersionId: candidate.productionVersionId,
        qualityInspectionId: candidate.qualityInspectionId!, qualityGroupId: candidate.qualityGroupId, expectedProductionProjectionVersion: candidate.projectionVersion, quantity: 1 }],
    }] }] });
    expect(revised.versions[1]!.productionSourceVersion).toBe(2);
    expect(revised.productionAllocations.find(item => item.shipmentVersionId === revised.versions[1]!.id)!.qualityGroupId).toBe(accepted.id);
    expect(await snapshot()).toEqual(before);
  });
});
