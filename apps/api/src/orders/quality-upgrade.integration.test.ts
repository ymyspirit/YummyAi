import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, RecordQualityInspectionInputSchema, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, fulfillmentSuppliers, marketplaceAccounts, productionOrders, productionOrderVersions, orderRoutingDecisions, routingPolicyVersions, purchaseOrders, purchaseOrderVersions, qualityInspections, qualityStandardVersions, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase, assertDatabaseMigrationsCurrent } from "../../../../packages/database/src/migrate.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderProductionService } from "./order-production.service.js";

describe("quality legacy upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("preserves actual pre-0130 rows and original receipts without manufacturing criterion evidence", async () => {
    const name = new URL(process.env.DATABASE_URL!).pathname.slice(1);
    if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(name) || process.env.E2E_ISOLATED_DAILY !== "1")
      throw new Error("Quality upgrade requires the disposable runner");
    const [{ present }] = await database.client.unsafe("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='quality_inspections' and column_name='assessment_version') as present");
    expect(present).toBe(false);
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId(), supplierId = createEntityId();
    const standardId = createEntityId(), productionId = createEntityId(), inspectionId = createEntityId();
    const policyId = createEntityId(), decisionId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: ["order:read", "order:write"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [tenantId, "Synthetic old quality tenant", "old-quality-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [userId, "old-quality-" + userId, userId + "@example.test", "Synthetic old inspector"]);
    await withTenant(database.db, context, async tx => {
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId, platform: "etsy", displayName: "Synthetic old shop", region: "GLOBAL", authorizationMode: "etsy_oauth", createdBy: userId });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId, name: "Synthetic old supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 1, profile: syntheticSupplierProfile, createdBy: userId });
      await tx.insert(qualityStandardVersions).values({ id: standardId, tenantId, name: "Old total score only", versionNumber: 1,
        minimumScoreBps: 9000, criteria: [{ code: "OUTPUT", label: "Old output quality", weightBps: 10_000, blocking: true }], createdBy: userId });
    });
    const audit = new AuditService(database), vault = new SecretVault(Buffer.alloc(32, 53));
    const orders = new OrderService(database, vault, audit);
    const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: "old-quality-event", externalOrderId: "old-quality-order",
      providerStatus: "paid", placedAt: "2026-10-01T00:00:00.000Z", orderTotal: null,
      lines: [{ externalLineId: "old-quality-line", externalListingId: null, skuCode: null, title: "Synthetic legacy production", quantity: 1, unitPrice: null, customizationCount: 0 }],
      redactedSource: { synthetic: true }, protectedDetails: null });
    const original = await withTenant(database.db, context, async tx => {
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId, name: "Synthetic old routing", versionNumber: 1,
        weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
        thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: userId });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId, orderId: order.id, orderLineId: order.lines[0]!.id,
        routingPolicyVersionId: policyId, versionNumber: 1, status: "approved", selectedSupplierId: supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: "old-routing" });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId, supplierId, orderId: order.id, status: "approved", currentVersionNumber: 1, createdBy: userId });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: 800,
        lineSnapshot: [{ orderLineId: order.lines[0]!.id, quantity: 1, unitCostMinor: 800 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: userId });
      await tx.insert(productionOrders).values({ id: productionId, tenantId, orderId: order.id, orderLineId: order.lines[0]!.id, supplierId,
        routingDecisionId: decisionId, purchaseOrderVersionId: purchaseVersionId, status: "completed", projectionVersion: 5, expectedCompletionAt: new Date("2026-10-02T00:00:00.000Z"), idempotencyKey: "old-production", createdBy: userId });
      await tx.insert(productionOrderVersions).values({ id: createEntityId(), tenantId, productionOrderId: productionId, versionNumber: 1, quantity: 1,
        encryptedInstructions: vault.encrypt("Synthetic immutable old instructions"), instructionsChecksum: "c".repeat(64),
        expectedCompletionAt: new Date("2026-10-02T00:00:00.000Z"), createdBy: userId });
      await tx.execute(sql`insert into quality_inspections
        (id,tenant_id,production_order_id,quality_standard_version_id,result,score_bps,evidence_asset_ids,idempotency_key,inspected_by,inspected_at,created_at)
        values (${inspectionId},${tenantId},${productionId},${standardId},'passed',9500,'[]'::jsonb,'old-quality-receipt',${userId},'2026-10-02T01:00:00Z','2026-10-02T01:01:00Z')`);
      const rows = await tx.execute<{ original: Record<string, unknown> }>(sql`select row_to_json(q) as original from quality_inspections q where id=${inspectionId}`);
      return rows[0]!.original;
    });
    await migrateDatabase(database);
    await assertDatabaseMigrationsCurrent(database);
    const [{ upgraded }] = await database.client.unsafe("select exists(select 1 from information_schema.columns where table_schema='public' and table_name='quality_inspections' and column_name='assessment_version') as upgraded");
    expect(upgraded).toBe(true);
    const saved = await withTenant(database.db, context, async tx => {
      const rows = await tx.execute<{ original: Record<string, unknown> }>(sql`select row_to_json(q) as original from quality_inspections q where id=${inspectionId}`);
      return rows[0]!.original;
    });
    for (const key of Object.keys(original)) expect(saved[key]).toEqual(original[key]);
    for (const key of ["assessment_version", "criterion_results", "request_checksum", "production_version_id", "production_projection_version"]) expect(saved[key]).toBeNull();
    const production = new OrderProductionService(database, vault, orders, audit);
    const body = RecordQualityInspectionInputSchema.parse({ qualityStandardVersionId: standardId, result: "passed", scoreBps: 9500,
      inspectedAt: "2026-10-02T01:00:00.000Z", idempotencyKey: "old-quality-receipt" });
    const replay = await production.inspect(context, productionId, body);
    expect(replay.productionOrder.projectionVersion).toBe(5);
    expect(replay.inspections[0]).toMatchObject({ id: inspectionId, assessmentVersion: null, criterionResults: null, inspectedBy: userId });
    await expect(production.inspect(context, productionId, { ...body, scoreBps: 9600 })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspect(context, productionId, { ...body, expectedProductionProjectionVersion: 5,
      assessment: { formatVersion: 2, criterionResults: [{ code: "OUTPUT", passed: true, scoreBps: 9500, evidenceAssetIds: [] }] } })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspect(context, productionId, { ...body, idempotencyKey: "new-request-needs-criteria" })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await withTenant(database.db, context, tx => tx.select().from(qualityInspections).where(eq(qualityInspections.productionOrderId, productionId)))).toHaveLength(1);
  });
});
