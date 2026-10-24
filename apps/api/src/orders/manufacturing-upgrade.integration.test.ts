import { insertLegacy, ensureLegacyMembership, legacyRecordSnapshot, seedLegacyOrder, seedLegacyPassedProduction, upgradeLegacyDatabase } from "./legacy-upgrade.test-fixture.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, withTenant, productionOrderVersions, productionManufacturingBindings, orderWorkItems, orderWorkRevisions,
  productionEditorProjects, productionEditorVersions, productionEditorRenders, productionDeliveryPackages, productionDeliveryItems } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase, assertDatabaseMigrationsCurrent } from "../../../../packages/database/src/migrate.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { sealWork } from "./order-workspace.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import type { ProductionEditorService } from "../design/production-editor.service.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0134") throw new Error("Use the actual pre-0134 disposable upgrade runner");

describe("actual pre-0134 manufacturing binding upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("preserves historical production bytes and missing manufacturing evidence while requiring a binding on new app versions", async () => {
    const [{ binding }] = await database.client.unsafe("select to_regclass('production_manufacturing_bindings') as binding");
    expect(binding).toBeNull();
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic manufacturing upgrade',$2)", [tenantId, `manufacturing-upgrade-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic historical operator')", [userId, `manufacturing-upgrade-${userId}`, `${userId}@example.test`]);
    await ensureLegacyMembership(database, context);
    await withTenant(database.db, context, tx => tx.execute(sql`insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by)
      values(${accountId},${tenantId},'etsy','Synthetic historical shop','GLOBAL','etsy_oauth',${userId})`));
    const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit);
    const production = new OrderProductionService(database, vault, orders, audit);
    const order = await seedLegacyOrder(database, context, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: randomUUID(), providerStatus: "paid",
      placedAt: "2026-10-01T00:00:00.000Z", orderTotal: null, lines: [{ externalLineId: "old-manufacturing-item", externalListingId: null, skuCode: null,
        title: "Synthetic historical stock", quantity: 2, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    // This fixture is inserted through the application role into the real old
    // schema. It contains no manufactured approval or inferred BOM history.
    const lineId = order.lines[0]!.id, revisionId = createEntityId(), projectId = createEntityId(), editorVersionId = createEntityId(), renderId = createEntityId();
    const packageId = createEntityId(), itemId = createEntityId(), workKey = randomBytes(32), createdAt = new Date(), expiresAt = new Date(Date.now() + 86_400_000);
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    let source: Awaited<ReturnType<typeof seedLegacyPassedProduction>>[number], manifestChecksum: string;
    try {
      await withTenant(database.db, context, async tx => {
        await insertLegacy(tx, orderWorkItems, { id: lineId, tenantId, revision: 1, encryptedDataKey: vault.encrypt(workKey.toString("base64")), expiresAt });
        await insertLegacy(tx, orderWorkRevisions, { id: revisionId, tenantId, workItemId: lineId, revision: 1,
          encryptedDraft: sealWork(workKey, { historical: true }), checksum: hash(JSON.stringify({ historical: true })), createdBy: userId });
        // Historical metadata has no recoverable project key or actual file.
        // Its absence remains a visible blocker, never a factory acceptance.
        await insertLegacy(tx, productionEditorProjects, { id: projectId, tenantId, name: "shaped_pillow", sourceWorkItemId: lineId, sourceWorkRevisionId: revisionId, createdBy: userId, expiresAt });
        await insertLegacy(tx, productionEditorVersions, { id: editorVersionId, tenantId, projectId, versionNumber: 1,
          encryptedDocument: sealWork(workKey, { historicalMissingFile: true }), checksum: hash(JSON.stringify({ historicalMissingFile: true })), createdBy: userId });
        await insertLegacy(tx, productionEditorRenders, { id: renderId, tenantId, projectId, versionId: editorVersionId,
          status: "completed", encryptedOptions: sealWork(workKey, { historicalMetadataOnly: true }), requestedBy: userId });
      });
      [source] = await seedLegacyPassedProduction(database, context, order.id, [{ id: lineId, quantity: 2 }],
        { vault, workSources: new Map([[lineId, { revisionId }]]) });
      const snapshot = { orderNumber: order.externalOrderId, orderLineId: lineId, quantity: 2, instructions: "Synthetic historical instructions",
        productionOrderId: source!.productionOrderId, productionVersionId: source!.productionVersionId, workRevisionId: revisionId, workRevision: 1,
        editorProjectId: projectId, editorVersionId, editorVersionNumber: 1, renderId, templateVersionId: null, sourceVersionId: null,
        ruleSnapshotChecksum: null, ruleSnapshotStatus: "legacy_missing", factoryStandardId: "legacy-unverified", designRunId: null, designRunInputChecksum: null,
        sizeMm: 254, sizeBasis: "artwork", sideMode: "single", minimumNeckMm: 50, minimumNeckBasis: "cut_contour",
        expectedCompletionAt: "2026-07-23T00:00:00.000Z", file: { key: "historical-no-file", path: "legacy/metadata-only.jpg", checksum: "d".repeat(64),
          byteSize: 1, width: 1, height: 1, dpi: 150, mediaType: "image/jpeg" } };
      const supplier = await withTenant(database.db, context, tx => tx.execute(sql`select s.id,s.name from fulfillment_suppliers s join production_orders p on p.supplier_id=s.id where p.id=${source!.productionOrderId}`));
      const supplierId = String(supplier[0]!.id), supplierName = String(supplier[0]!.name);
      manifestChecksum = hash(JSON.stringify({ schemaVersion: 1, id: packageId, supplier: { id: supplierId, name: supplierName }, createdAt: createdAt.toISOString(), items: [snapshot] }));
      await withTenant(database.db, context, async tx => {
        await insertLegacy(tx, productionDeliveryPackages, { id: packageId, tenantId, schemaVersion: 1, supplierId, supplierName,
          idempotencyKey: randomUUID(), requestChecksum: "e".repeat(64), checksum: manifestChecksum, createdAt, createdBy: userId });
        await tx.execute(sql`insert into production_delivery_items(id,tenant_id,package_id,production_order_id,production_version_id,work_item_id,work_revision_id,editor_project_id,editor_version_id,render_id,file_checksum,byte_size,encrypted_snapshot)
          values(${itemId},${tenantId},${packageId},${source!.productionOrderId},${source!.productionVersionId},${lineId},${revisionId},${projectId},${editorVersionId},${renderId},${snapshot.file.checksum},1,${sealWork(workKey,snapshot)})`);
      });
    } finally { workKey.fill(0); }
    const snapshot = await legacyRecordSnapshot(database, context, { production: { table: "production_orders", id: source!.productionOrderId },
      version: { table: "production_order_versions", id: source!.productionVersionId }, quality: { table: "quality_inspections", id: source!.qualityInspectionId },
      package: { table: "production_delivery_packages", id: packageId }, item: { table: "production_delivery_items", id: itemId } });
    const before = await snapshot();
    await upgradeLegacyDatabase(database, 134); await assertDatabaseMigrationsCurrent(database);
    expect(await snapshot()).toEqual(before);
    const original = await production.get(context, source!.productionOrderId);
    const [legacyMetadata] = await withTenant(database.db, context, tx => tx.select().from(productionDeliveryItems).where(eq(productionDeliveryItems.id, itemId)));
    expect(legacyMetadata).toMatchObject({ manufacturingBindingId: null, manufacturingContentChecksum: null, manufacturingPlanChecksum: null });
    expect(original.versions[0]!.manufacturing).toBeNull();
    const delivery = new OrderProductionDeliveryService(database, vault, {} as ProductionEditorService, production, audit, new FactoryDirectoryService(database, audit));
    const legacy = await delivery.get(context, packageId);
    expect(legacy).toMatchObject({ schemaVersion: 1, factory: null, canDownload: false, checksum: manifestChecksum! });
    expect(legacy.items[0]!.snapshot).not.toBeNull();
    expect(legacy.items[0]!.blockers.join(" ")).toContain("旧生产单未确认具体工厂");
    await expect(delivery.download(context, packageId)).rejects.toBeInstanceOf(ConflictException);
    await expect(production.recordMilestone(context, source!.productionOrderId, { type: "submitted", expectedProjectionVersion: 5, externalEventId: randomUUID(),
      occurredAt: new Date().toISOString(), evidence: { code: "SYNTHETIC", note: null, assetIds: [] } })).rejects.toBeInstanceOf(ConflictException);
    expect(await withTenant(database.db, context, tx => tx.select().from(productionManufacturingBindings))).toEqual([]);
    const [version] = await withTenant(database.db, context, tx => tx.select().from(productionOrderVersions).where(eq(productionOrderVersions.id, source!.productionVersionId)));
    await expect(withTenant(database.db, context, tx => tx.insert(productionOrderVersions).values({ ...version!, id: createEntityId(), versionNumber: 2, createdAt: new Date() })))
      .rejects.toMatchObject({ code: "23514" });
    await expect(production.recover(context, { type: "remake", originalProductionOrderId: source!.productionOrderId, reason: "Synthetic old source cannot invent a manufacturing pin",
      expectedCompletionAt: new Date(Date.now() + 86_400_000).toISOString(), idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(ConflictException);
    await migrateDatabase(database);
    expect(await snapshot()).toEqual(before);
    expect((await production.get(context, source!.productionOrderId)).versions).toHaveLength(1);
    expect(await withTenant(database.db, context, tx => tx.select().from(productionManufacturingBindings))).toEqual([]);
  });
});
