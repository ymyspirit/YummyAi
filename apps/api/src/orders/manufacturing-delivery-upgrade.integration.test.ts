import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { ProductionDeliverySnapshotSchema } from "@yummyai/contracts/order/production-delivery";
import { FactoryDestinationSchema } from "@yummyai/contracts/suppliers/factory-directory";
import { connectDatabase, withTenant, orderWorkItems, orderWorkRevisions, productionEditorProjects, productionEditorVersions, productionEditorRenders,
  productionOrderVersions, productionDeliveryPackages, productionDeliveryItems } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { migrateDatabase, assertDatabaseMigrationsCurrent } from "../../../../packages/database/src/migrate.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderProductionDeliveryService } from "./order-production-delivery.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import type { ProductionEditorService } from "../design/production-editor.service.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";
import { sealWork } from "./order-workspace.service.js";

requireDisposableIntegrationEnvironment();
if (process.env.E2E_LEGACY_SCHEMA_TARGET !== "pre-0135") throw new Error("Actual pre-0135 disposable database required");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
describe("actual pre-0135 V2 delivery upgrade", () => {
  const database = connectDatabase();
  afterAll(async () => { await database.client.end(); });
  it("keeps original V2 bytes and checksum without adding an available manufacturing plan, and rejects new downgraded packages", async () => {
    await expect(assertDatabaseMigrationsCurrent(database)).rejects.toMatchObject({ code: "DATABASE_MIGRATIONS_NOT_READY" });
    const tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
    const context: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic V2 delivery upgrade',$2)", [tenantId, `v2-upgrade-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic historical operator')", [userId, `v2-upgrade-${userId}`, `${userId}@example.test`]);
    await withTenant(database.db, context, tx => tx.execute(sql`insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by)
      values(${accountId},${tenantId},'etsy','Synthetic historical shop','GLOBAL','etsy_oauth',${userId})`));
    const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit), factories = new FactoryDirectoryService(database, audit);
    const production = new OrderProductionService(database, vault, orders, audit);
    const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: randomUUID(), providerStatus: "paid",
      placedAt: "2026-10-01T00:00:00.000Z", orderTotal: null, lines: [{ externalLineId: "old-v2-item", externalListingId: null, skuCode: null,
        title: "Synthetic old V2 metadata", quantity: 2, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    const product = await syntheticManufacturingProduct(database, context), lineId = order.lines[0]!.id, revisionId = createEntityId(), projectId = createEntityId(), editorVersionId = createEntityId(), renderId = createEntityId();
    const workKey = randomBytes(32), packetId = createEntityId(), itemId = createEntityId(), createdAt = new Date(), expiresAt = new Date(Date.now() + 86_400_000);
    try {
      const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: product.profileVersionId, specificationVersionId: product.specificationVersionId,
        artworkVersionId: product.artworkVersionId, designExecutor: "human", fields: [], images: [], instructions: "Synthetic historical work", customerApprovalRequired: false, dueAt: null });
      await withTenant(database.db, context, async tx => {
        await tx.insert(orderWorkItems).values({ id: lineId, tenantId, revision: 1, encryptedDataKey: vault.encrypt(workKey.toString("base64")), expiresAt });
        await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId, workItemId: lineId, revision: 1, profileVersionId: product.profileVersionId,
          encryptedDraft: sealWork(workKey, draft), checksum: hash(JSON.stringify(draft)), createdBy: userId });
        // Historical metadata intentionally has no recoverable production file.
        await tx.insert(productionEditorProjects).values({ id: projectId, tenantId, name: "shaped_pillow", createdBy: userId, expiresAt });
        await tx.insert(productionEditorVersions).values({ id: editorVersionId, tenantId, projectId, versionNumber: 1,
          encryptedDocument: sealWork(workKey, { legacyMissingFile: true }), checksum: hash(JSON.stringify({ legacyMissingFile: true })), createdBy: userId });
        await tx.insert(productionEditorRenders).values({ id: renderId, tenantId, projectId, versionId: editorVersionId, status: "completed", encryptedOptions: sealWork(workKey, { metadataOnly: true }), requestedBy: userId });
      });
      const [source] = await syntheticPassedProduction(database, context, order.id, [{ id: lineId, quantity: 2 }], factories,
        { vault, workSources: new Map([[lineId, { revisionId, manufacturing: product.manufacturing }]]) });
      const [version] = await withTenant(database.db, context, tx => tx.select().from(productionOrderVersions).where(eq(productionOrderVersions.id, source!.productionVersionId)));
      const pin = await withTenant(database.db, context, tx => factories.pinned(tx, version!.factoryId!, version!.factoryVersionId!, version!.capabilityVersionId!));
      if (!pin) throw new Error("Historical factory pin missing");
      const snapshot = ProductionDeliverySnapshotSchema.parse({ factory: pin, orderNumber: order.externalOrderId, orderLineId: lineId, quantity: 2, instructions: "Synthetic historical factory instruction",
        productionOrderId: source!.productionOrderId, productionVersionId: source!.productionVersionId, workRevisionId: revisionId, workRevision: 1,
        editorProjectId: projectId, editorVersionId, editorVersionNumber: 1, renderId, templateVersionId: null, sourceVersionId: null,
        ruleSnapshotChecksum: null, ruleSnapshotStatus: "legacy_missing", factoryStandardId: "legacy-unverified", designRunId: null, designRunInputChecksum: null,
        sizeMm: 254, sizeBasis: "artwork", sideMode: "single", minimumNeckMm: 50, minimumNeckBasis: "cut_contour", expectedCompletionAt: version!.expectedCompletionAt.toISOString(),
        file: { key: "legacy-no-file", path: "legacy/metadata-only.jpg", checksum: "d".repeat(64), byteSize: 1, width: 1, height: 1, dpi: 150, mediaType: "image/jpeg" } });
      const destination = FactoryDestinationSchema.parse(Object.fromEntries(Object.entries(pin).filter(([key]) => !["capabilityId", "capabilityVersionId", "capabilityVersionNumber", "capabilityProfile"].includes(key))));
      const checksum = hash(JSON.stringify({ schemaVersion: 2, id: packetId, supplier: { id: pin.supplierId, name: pin.supplierName }, factory: destination, createdAt: createdAt.toISOString(), items: [snapshot] }));
      await withTenant(database.db, context, async tx => {
        await tx.insert(productionDeliveryPackages).values({ id: packetId, tenantId, supplierId: pin.supplierId, supplierName: pin.supplierName, schemaVersion: 2,
          factoryId: pin.factoryId, factoryVersionId: pin.factoryVersionId, idempotencyKey: randomUUID(), requestChecksum: "e".repeat(64), checksum, createdAt, createdBy: userId });
        await tx.execute(sql`insert into production_delivery_items(id,tenant_id,package_id,production_order_id,production_version_id,work_item_id,work_revision_id,editor_project_id,editor_version_id,render_id,file_checksum,byte_size,encrypted_snapshot)
          values(${itemId},${tenantId},${packetId},${source!.productionOrderId},${source!.productionVersionId},${lineId},${revisionId},${projectId},${editorVersionId},${renderId},${snapshot.file.checksum},1,${sealWork(workKey,snapshot)})`);
      });
      const original = async () => withTenant(database.db, context, async tx => (await tx.execute(sql`select
        (select to_jsonb(p) from production_delivery_packages p where p.id=${packetId}) as package,
        (select to_jsonb(i)-'manufacturing_binding_id'-'manufacturing_content_checksum'-'manufacturing_plan_checksum' from production_delivery_items i where i.id=${itemId}) as item`))[0]);
      const before = await original(); await migrateDatabase(database); await assertDatabaseMigrationsCurrent(database);
      expect(await original()).toEqual(before);
      const delivery = new OrderProductionDeliveryService(database, vault, {} as ProductionEditorService, production, audit, factories);
      const old = await delivery.get(context, packetId);
      expect(old).toMatchObject({ schemaVersion: 2, checksum, canDownload: false });
      expect(old.items[0]!.snapshot!.manufacturing).toBeUndefined();
      expect((await production.get(context, source!.productionOrderId)).versions[0]!.manufacturing).not.toBeNull();
      const [stored] = await withTenant(database.db, context, tx => tx.select().from(productionDeliveryPackages).where(eq(productionDeliveryPackages.id, packetId)));
      const [metadata] = await withTenant(database.db, context, tx => tx.select().from(productionDeliveryItems).where(eq(productionDeliveryItems.id, itemId)));
      expect(metadata).toMatchObject({ manufacturingBindingId: null, manufacturingContentChecksum: null, manufacturingPlanChecksum: null });
      await expect(withTenant(database.db, context, tx => tx.insert(productionDeliveryPackages).values({ ...stored!, id: createEntityId(), idempotencyKey: randomUUID() }))).rejects.toMatchObject({ cause: { code: "23514" } });
      await expect(delivery.download(context, packetId)).rejects.toBeInstanceOf(ConflictException);
      await migrateDatabase(database); expect(await original()).toEqual(before);
    } finally { workKey.fill(0); }
  });
});
