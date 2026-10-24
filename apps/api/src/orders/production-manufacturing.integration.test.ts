import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { ManufacturingRecipeContentSchema } from "@yummyai/contracts/catalog/manufacturing";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { connectDatabase, migrateDatabase, withTenant, assetFiles, designTasks, designVersions, designVersionFiles, skus, orderLineCatalogLinks,
  fulfillmentSuppliers, productionOrders, productionOrderVersions, productionManufacturingBindings, orderWorkItems, orderWorkRevisions,
  productSpecifications, productSpecificationVersions, inventoryStockItems, routingPolicyVersions, orderRoutingDecisions, purchaseOrders, purchaseOrderVersions,
  memberships, membershipRoles, roles, loadCurrentMembershipContext, orders as orderTable, orderProtectedDetails } from "@yummyai/database";
import { withOrderAuthority } from "@yummyai/order-core";
import { encryptProductionBytes } from "@yummyai/production-editor";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { ManufacturingService } from "../catalog/manufacturing.service.js";
import { manufacturingBasis } from "../catalog/manufacturing.test-fixture.js";
import { OrderService } from "./order.service.js";
import { readProductionManufacturingPins, sealProductionManufacturing, orderProductionManufacturingOptions } from "./production-manufacturing.js";
import { OrderProductionService } from "./order-production.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { reserveFactoryCapacityInTransaction } from "../suppliers/factory-capacity.service.js";
import { NativeProductionService } from "./native-production.service.js";
import { ProductionCommandService } from "./production-command.service.js";
import { productionCommandIntents, productionCommandAttempts } from "@yummyai/database";
import { productionMaterialEntries, inventoryMovements } from "@yummyai/database";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProductionMaterialService } from "./production-material.service.js";
import { ProductionMaterialCommandService } from "./production-material-command.service.js";
import { productionMaterialCommands } from "@yummyai/database";
import { expireMaterialCommandInputs, MaterialCommandRetentionDispatcher } from "@yummyai/order-core";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RecordProductionMaterialSchema } from "@yummyai/contracts/order/material-execution";
import { createQueue, QueueName } from "@yummyai/jobs";
import { createStorageFromEnvironment } from "@yummyai/storage";

const parentUrl = new URL(requireDisposableIntegrationEnvironment());
describe.sequential("production manufacturing atomic evidence prototype", () => {
  const name = "order_daily_e2e_" + randomUUID().replaceAll("-", ""), targetUrl = new URL(parentUrl), adminUrl = new URL(parentUrl);
  targetUrl.pathname = "/" + name; adminUrl.pathname = "/postgres";
  if (!/^order_daily_e2e_[a-f0-9]{32}$/.test(name) || targetUrl.pathname === parentUrl.pathname) throw new Error("Unsafe manufacturing fixture database");
  const admin = connectDatabase(adminUrl.href), db = connectDatabase(targetUrl.href);
  const resources = { kind: "production-manufacturing-prototype", database: name, databaseCreated: false, databaseDeleted: false, ordinaryDatabaseTouched: false };
  const saveResources = async () => {
    process.stdout.write(JSON.stringify({ productionManufacturingDatabaseProof: resources }) + "\n");
    const directory = process.env.YUMMYAI_TEST_CACHE_DIR;
    if (directory) { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, `manufacturing-database-${name}.json`), JSON.stringify(resources)); }
  };
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant", permissions: Object.values(Permission) };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const vault = new SecretVault(Buffer.alloc(32, 71)), audit = new AuditService(db), catalog = new ManufacturingService(db, audit), orders = new OrderService(db, vault, audit);
  const accountId = createEntityId(), supplierId = createEntityId();
  const factories = new FactoryDirectoryService(db, audit), production = new OrderProductionService(db, vault, orders, audit, undefined, factories);
  let factory: Awaited<ReturnType<typeof createSyntheticFactory>>;
  let capacity: Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>;
  beforeAll(async () => {
    await saveResources();
    if ((await admin.client.unsafe("select 1 from pg_database where datname=$1", [name])).length) throw new Error("Manufacturing fixture database already exists");
    await admin.client.unsafe(`create database ${name}`); resources.databaseCreated = true; await saveResources();
    await migrateDatabase(db);
    // All registered migrations are installed only in this disposable database.
    for (const context of [a, b]) {
      await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic production BOM',$2)", [context.tenantId, randomUUID()]);
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic operator')", [context.userId, randomUUID(), `${context.userId}@example.invalid`]);
    }
    await db.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic BOM shop','GLOBAL','etsy_oauth',$3)", [accountId, a.tenantId, a.userId]);
    await withTenant(db.db, a, tx => tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: a.tenantId, name: "Synthetic BOM supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 1, profile: syntheticSupplierProfile, createdBy: a.userId }));
    factory = await createSyntheticFactory(factories, a, supplierId, "rectangular_print");
    capacity = await createSyntheticFactoryCapacity(db, a, { factory: factory.factory,
      bindings: [{ capabilityVersionId: factory.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10_000 });
  }, 60000);
  afterAll(async () => {
    try { await db.client.end(); }
    finally {
      try {
        if (resources.databaseCreated) {
          await admin.client.unsafe(`drop database ${name} with (force)`);
          resources.databaseDeleted = (await admin.client.unsafe("select 1 from pg_database where datname=$1", [name])).length === 0;
        }
      } finally { await admin.client.end(); await saveResources(); }
    }
    expect(!resources.databaseCreated || resources.databaseDeleted).toBe(true);
  });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");

  async function fixture(kind: "native" | "work" = "native", productType: "rectangular_print" | "shaped_pillow" | "tire_cover" = "rectangular_print",
    material: { responsibility?: "merchant" | "factory"; denominator?: number; stockItemId?: string } = {}) {
    const basis = await manufacturingBasis(db, a, productType), nativeSku = createEntityId(), designId = createEntityId(), assetId = createEntityId(), taskId = createEntityId();
    const order = await orders.ingestNormalized(a, { accountId, platform: "etsy", externalEventId: randomUUID(), externalOrderId: randomUUID(), providerStatus: "paid",
      placedAt: "2026-10-19T00:00:00.000Z", orderTotal: null, lines: [{ externalLineId: "synthetic", externalListingId: null, skuCode: null,
        title: "Synthetic finished SKU", quantity: 3, unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    const lineId = order.lines[0]!.id, revisionId = kind === "work" ? createEntityId() : null;
    const policyId = createEntityId(), decisionId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: a.tenantId, name: `Synthetic routing basis ${policyId}`, versionNumber: 1,
        weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
        thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: a.userId });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId: a.tenantId, orderId: order.id, orderLineId: lineId, routingPolicyVersionId: policyId,
        versionNumber: 1, status: "approved", selectedSupplierId: supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: randomUUID() });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId: a.tenantId, supplierId, orderId: order.id, status: "approved", currentVersionNumber: 1, createdBy: a.userId });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId: a.tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: 3,
        lineSnapshot: [{ orderLineId: lineId, quantity: 3, unitCostMinor: 1 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: a.userId });
      await tx.insert(skus).values({ id: nativeSku, tenantId: a.tenantId, spuId: basis.spuId, code: randomUUID(), attributes: {} });
      await tx.insert(orderLineCatalogLinks).values({ id: createEntityId(), tenantId: a.tenantId, orderLineId: lineId, skuId: nativeSku, matchSource: "manual", linkedBy: a.userId });
      await tx.insert(assetFiles).values({ id: assetId, tenantId: a.tenantId, ownerUserId: a.userId, objectKey: `authorized/synthetic-${assetId}`, assetDomain: "authorized",
        fileName: "synthetic-production.png", mediaType: "image/png", byteSize: 1, checksumSha256: "e".repeat(64), rightsStatus: "approved",
        rightsMetadata: { source: { kind: "owned", reference: "Synthetic metadata only; no actual production file" }, approvedAt: new Date().toISOString() } });
      await tx.insert(designTasks).values({ id: taskId, tenantId: a.tenantId, skuId: nativeSku, title: "Synthetic native design", brief: "Synthetic fixture only", status: "approved", createdBy: a.userId });
      await tx.insert(designVersions).values({ id: designId, tenantId: a.tenantId, taskId, versionNumber: 1, status: "approved", createdBy: a.userId, reviewedBy: a.userId, reviewedAt: new Date() });
      await tx.insert(designVersionFiles).values({ id: createEntityId(), tenantId: a.tenantId, versionId: designId, assetFileId: assetId, role: "production" });
      if (revisionId) {
        const key = randomBytes(32), draft = OrderWorkDraftSchema.parse({ printProfileVersionId: basis.profileVersionId, specificationVersionId: basis.specificationVersionId,
          fields: [], images: [], instructions: "Synthetic private order instructions", customerApprovalRequired: false, dueAt: null });
        try {
          await tx.insert(orderWorkItems).values({ id: lineId, tenantId: a.tenantId, revision: 1, encryptedDataKey: vault.encrypt(key.toString("base64")), expiresAt: new Date(Date.now() + 86400000) });
          await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId: a.tenantId, workItemId: lineId, revision: 1, profileVersionId: basis.profileVersionId,
            encryptedDraft: Buffer.from(encryptProductionBytes(key, Buffer.from(JSON.stringify(draft)))).toString("base64"), checksum: hash(JSON.stringify(draft)), createdBy: a.userId });
          await tx.update(orderWorkItems).set({ pushedRevisionId: revisionId }).where(eq(orderWorkItems.id, lineId));
        } finally { key.fill(0); }
      }
    });
    const created = await catalog.create(a, { spuId: basis.spuId, specificationId: basis.specificationId, code: randomUUID(), idempotencyKey: randomUUID(),
      content: ManufacturingRecipeContentSchema.parse({ specificationVersionId: basis.specificationVersionId, name: "Synthetic approved finished SKU", outputQuantity: 1, outputUnit: "each",
        materials: [{ code: "FABRIC", name: "Synthetic fabric", stockItemId: material.stockItemId ?? basis.stockId, quantityNumerator: 1, quantityDenominator: material.denominator ?? 2, unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: material.responsibility ?? "merchant", operationCode: "CUT" }],
        operations: [{ code: "CUT", name: "Synthetic cut", processCode: "cut", responsibility: "factory", expectedSecondsPerOutput: null }] }) });
    await catalog.review(a, created.recipeId, { expectedVersion: 1, versionId: created.versionId, decision: "approved", note: "Synthetic approval for evidence tests only", idempotencyKey: randomUUID() });
    return { ...basis, lineId, orderId: order.id, nativeSku, designId, assetId, revisionId, decisionId, purchaseVersionId, manufacturingVersionId: created.versionId,
      selection: { versionId: created.versionId, orderUnitConfirmed: true as const }, confirmation: { specificationVersionId: basis.specificationVersionId, note: "Synthetic new product confirmation; private" } };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function createVersion(tx: Parameters<Parameters<typeof withTenant>[2]>[0], f: Fixture, parentProductionOrderId: string | null = null) {
    const id = createEntityId(), versionId = createEntityId();
    await tx.insert(productionOrders).values({ id, tenantId: a.tenantId, orderId: f.orderId, orderLineId: f.lineId, supplierId, sourceWorkItemId: f.revisionId ? f.lineId : null,
      routingDecisionId: f.revisionId ? null : f.decisionId, purchaseOrderVersionId: f.revisionId ? null : f.purchaseVersionId,
      source: parentProductionOrderId ? "remake" : "initial", parentProductionOrderId, factoryId: factory.factory.id,
      expectedCompletionAt: new Date(capacity.expectedCompletionAt), idempotencyKey: randomUUID(), createdBy: a.userId });
    await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: a.tenantId, productionOrderId: id, versionNumber: 1, quantity: 1,
      designVersionId: f.revisionId ? null : f.designId, productionAssetIds: f.revisionId ? [] : [f.assetId], sourceWorkRevisionId: f.revisionId,
      ...factory.pins, encryptedInstructions: vault.encrypt("Synthetic private production instructions"), instructionsChecksum: "a".repeat(64), expectedCompletionAt: new Date(capacity.expectedCompletionAt), createdBy: a.userId });
    return { id, versionId };
  }
  async function initial(f: Fixture, context = a) {
    return withOrderAuthority(db.db, context, [Permission.OrderRead, Permission.OrderWrite], async tx => {
      const version = await createVersion(tx, f);
      await sealProductionManufacturing(tx, context, vault, version.versionId, f.selection,
        f.revisionId ? { kind: "order_work_revision" } : { kind: "approved_product_confirmation", confirmation: f.confirmation });
      await reserveFactoryCapacityInTransaction(tx, context, audit, { productionOrderId: version.id, productionVersionId: version.versionId, capacityPlan: capacity.capacityPlan });
      return version;
    });
  }

  it.each(["native", "work"] as const)("seals %s lineage and returns only minimal immutable task metadata", async kind => {
    const f = await fixture(kind), original = await initial(f);
    const pin = await withTenant(db.db, a, async tx => (await readProductionManufacturingPins(tx, [original.versionId])).get(original.versionId));
    expect(pin).toMatchObject({ productionOrderId: original.id, productionVersionId: original.versionId, versionId: f.manufacturingVersionId,
      processProfileVersionId: f.profileVersionId, specificationVersionId: f.specificationVersionId, quantity: 1, unit: "each", workRevisionId: f.revisionId,
      source: kind === "work" ? "order_work_revision" : "approved_product_confirmation" });
    expect(JSON.stringify(pin)).not.toMatch(/private|materials|stockItemId|encrypted/);
    const [stored] = await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionVersionId, original.versionId)));
    expect(stored!.contentChecksum).toBe(hash(stored!.contentCanonical));
    if (kind === "native") expect(vault.withSecret(stored!.encryptedConfirmationNote!, value => value)).toBe(f.confirmation.note);
    expect(await withTenant(db.db, b, tx => tx.select().from(productionManufacturingBindings))).toEqual([]);
    await expect(db.client.unsafe("update production_manufacturing_bindings set output_unit='set' where id=$1", [stored!.id])).rejects.toThrow("immutable");
    await expect(db.client.unsafe("delete from production_manufacturing_bindings where id=$1", [stored!.id])).rejects.toThrow("immutable");
  });
  it("rolls back a new production version when its atomic binding is missing or the final audit fails", async () => {
    const f = await fixture(); let missing: string | undefined, failed: string | undefined, missingCapacityReserved = false, failedCapacityReserved = false;
    await expect(withTenant(db.db, a, async tx => {
      const value = await createVersion(tx, f); missing = value.id;
      // Satisfy the independent capacity gate with an actual same-transaction
      // reservation, leaving only the original manufacturing binding absent.
      await reserveFactoryCapacityInTransaction(tx, a, audit, { productionOrderId: value.id, productionVersionId: value.versionId, capacityPlan: capacity.capacityPlan });
      missingCapacityReserved = true;
    })).rejects.toThrow("require an explicit immutable manufacturing");
    expect(missingCapacityReserved).toBe(true);
    await expect(withTenant(db.db, a, async tx => {
      const value = await createVersion(tx, f); failed = value.id;
      await sealProductionManufacturing(tx, a, vault, value.versionId, f.selection, { kind: "approved_product_confirmation", confirmation: f.confirmation });
      await reserveFactoryCapacityInTransaction(tx, a, audit, { productionOrderId: value.id, productionVersionId: value.versionId, capacityPlan: capacity.capacityPlan });
      failedCapacityReserved = true;
      throw new Error("Synthetic final audit unavailable");
    })).rejects.toThrow("Synthetic final audit unavailable");
    expect(failedCapacityReserved).toBe(true);
    const remaining = await withTenant(db.db, a, tx => tx.execute(sql`select id from production_orders where id in (${missing!},${failed!})`));
    expect(remaining).toHaveLength(0);
    expect(await withTenant(db.db, a, tx => tx.execute(sql`select id from factory_capacity_reservations where production_order_id in (${missing!},${failed!})`))).toHaveLength(0);
  });
  it("requires explicit selection and current design/asset authority without converting the output unit", async () => {
    const f = await fixture();
    for (const selection of [undefined, { versionId: f.manufacturingVersionId, orderUnitConfirmed: false }]) {
      await expect(withTenant(db.db, a, async tx => { const v = await createVersion(tx, f); await sealProductionManufacturing(tx, a, vault, v.versionId, selection as typeof f.selection,
        { kind: "approved_product_confirmation", confirmation: f.confirmation }); })).rejects.toThrow();
    }
    for (const permission of [Permission.ProductRead, Permission.DesignRead, Permission.AssetRead]) {
      await expect(initial(f, { ...a, permissions: a.permissions.filter(p => p !== permission) })).rejects.toThrow();
    }
    await withTenant(db.db, a, tx => tx.update(assetFiles).set({ rightsMetadata: { source: { kind: "licensed", reference: "Synthetic expired license", licenseExpiresAt: "2020-01-01T00:00:00Z" }, approvedAt: new Date().toISOString() } }).where(eq(assetFiles.id, f.assetId)));
    await expect(initial(f)).rejects.toThrow("有效期");
  });
  it("rejects unrelated files, a different SKU and a direct confirmation over actual order work", async () => {
    const f = await fixture(), different = await fixture();
    await expect(initial({ ...f, assetId: different.assetId })).rejects.toThrow("原审核设计");
    await expect(initial({ ...f, designId: different.designId, assetId: different.assetId })).rejects.toThrow("产品 SKU");
    const work = await fixture("work");
    await expect(withTenant(db.db, a, async tx => {
      const v = await createVersion(tx, work);
      await sealProductionManufacturing(tx, a, vault, v.versionId, work.selection, { kind: "approved_product_confirmation", confirmation: work.confirmation });
    })).rejects.toThrow("已有审单");
  });
  it("preserves original remake evidence after the current product specification advances", async () => {
    const f = await fixture("work"), original = await initial(f);
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecificationVersions).values({ id: createEntityId(), tenantId: a.tenantId, specificationId: f.specificationId,
        versionNumber: 2, name: "Synthetic later specification", attributes: {}, facts: syntheticSpecificationFacts(), processProfileVersionId: f.profileVersionId, createdBy: a.userId });
      await tx.update(productSpecifications).set({ versionNumber: 2 }).where(eq(productSpecifications.id, f.specificationId));
    });
    const replacement = await withTenant(db.db, a, async tx => {
      const v = await createVersion(tx, f, original.id);
      await sealProductionManufacturing(tx, a, vault, v.versionId, f.selection, { kind: "original_production_binding", originalProductionVersionId: original.versionId });
      await reserveFactoryCapacityInTransaction(tx, a, audit, { productionOrderId: v.id, productionVersionId: v.versionId, capacityPlan: capacity.capacityPlan }); return v;
    });
    const pins = await withTenant(db.db, a, tx => readProductionManufacturingPins(tx, [original.versionId, replacement.versionId]));
    expect(pins.get(replacement.versionId)).toMatchObject({ source: "original_production_binding", originalBindingId: pins.get(original.versionId)!.id, specificationVersionId: f.specificationVersionId });
    expect(pins.get(replacement.versionId)!.contentChecksum).toBe(pins.get(original.versionId)!.contentChecksum);
    await withTenant(db.db, a, tx => tx.update(inventoryStockItems).set({ status: "inactive" }).where(eq(inventoryStockItems.id, f.stockId)));
    await expect(withTenant(db.db, a, async tx => {
      const v = await createVersion(tx, f, original.id);
      await sealProductionManufacturing(tx, a, vault, v.versionId, f.selection, { kind: "original_production_binding", originalProductionVersionId: original.versionId });
    })).rejects.toThrow("物料");
  });
  it("forbids admitting a current unbound production as historical before any late manufacturing attachment", async () => {
    const f = await fixture(), id = createEntityId(), versionId = createEntityId();
    // A present-day INSERT is not historical evidence. Genuine NULL-binding history
    // belongs to the pre-0134 upgrade fixture; a backdated current row cannot be admitted.
    await expect(withTenant(db.db, a, async tx => {
      await tx.insert(productionOrders).values({ id, tenantId: a.tenantId, orderId: f.orderId, orderLineId: f.lineId, supplierId, factoryId: factory.factory.id,
        routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId,
        expectedCompletionAt: new Date(capacity.expectedCompletionAt), idempotencyKey: randomUUID(), createdBy: a.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: a.tenantId, productionOrderId: id, versionNumber: 1, quantity: 1,
        ...factory.pins, designVersionId: f.designId, productionAssetIds: [f.assetId], encryptedInstructions: "synthetic", instructionsChecksum: "a".repeat(64),
        expectedCompletionAt: new Date(capacity.expectedCompletionAt), createdBy: a.userId, createdAt: new Date("2026-01-01") });
      await tx.execute(sql`set constraints production_version_requires_capacity immediate`);
    })).rejects.toMatchObject({ cause: { code: "23514", message: "factory_capacity_all_pools_required" } });
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.id, id)))).toEqual([]);
    expect(await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionVersionId, versionId)))).toEqual([]);
  });
  it("rechecks the original native design's rights before making another production version", async () => {
    const f = await fixture(), original = await initial(f);
    await withTenant(db.db, a, tx => tx.update(assetFiles).set({ rightsStatus: "rejected" }).where(eq(assetFiles.id, f.assetId)));
    await expect(withTenant(db.db, a, async tx => {
      const v = await createVersion(tx, f, original.id);
      await sealProductionManufacturing(tx, a, vault, v.versionId, f.selection, { kind: "original_production_binding", originalProductionVersionId: original.versionId });
    })).rejects.toThrow("授权");
    expect((await withTenant(db.db, a, tx => readProductionManufacturingPins(tx, [original.versionId]))).get(original.versionId)?.versionId).toBe(f.manufacturingVersionId);
  });
  it("rejects a recomputed checksum for content that differs from the approved BOM inside SQL", async () => {
    const f = await fixture(), original = await initial(f);
    const [stored] = await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionVersionId, original.versionId)));
    const changedContent = JSON.stringify({ ...JSON.parse(stored!.contentCanonical), name: "Synthetic unapproved content" });
    await expect(withTenant(db.db, a, async tx => {
      const v = await createVersion(tx, f);
      await tx.insert(productionManufacturingBindings).values({ ...stored!, id: createEntityId(), productionOrderId: v.id, productionVersionId: v.versionId,
        createdAt: undefined, contentCanonical: changedContent, contentChecksum: hash(changedContent) });
    })).rejects.toMatchObject({ cause: { message: expect.stringContaining("immutable approved version") } });
  });
  it("revalidates actual private-order and design permissions inside the binding transaction", async () => {
    const memberId = createEntityId(), roleId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: a.tenantId, userId: a.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: a.tenantId, name: randomUUID(), permissions: a.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: memberId, roleId });
    });
    const personal = await withTenant(db.db, a, tx => loadCurrentMembershipContext(tx, a));
    const native = await fixture(), work = await fixture("work");
    for (const [f, permission] of [[native, Permission.DesignRead], [work, Permission.OrderPiiRead]] as const) {
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions.filter(value => value !== permission) }).where(eq(roles.id, roleId)));
      await expect(initial(f, personal)).rejects.toMatchObject({ status: 403 });
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleId)));
      expect((await initial(f, personal)).versionId).toBeTruthy();
    }
  });
  async function commandFixture() {
    const f = await fixture();
    // Explicit synthetic state fixture; this does not assert a real order was commercially released.
    await db.client.unsafe("update orders set workflow_state='in_production',address_status='protected' where id=$1", [f.orderId]);
    const input = { ...factory.pins, orderLineId: f.lineId, routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId,
      designVersionId: f.designId, productionAssetIds: [f.assetId], expectedCompletionAt: capacity.expectedCompletionAt, capacityPlan: capacity.capacityPlan, instructions: "Synthetic actual command boundary",
      manufacturing: f.selection, productConfirmation: f.confirmation, idempotencyKey: randomUUID() };
    return { f, input };
  }
  it("binds the actual direct production command and its remake to the exact approved source and original factory basis", async () => {
    const { f, input } = await commandFixture(), created = await production.create(a, f.orderId, input);
    expect(created.versions[0]!.manufacturing).toMatchObject({ versionId: f.manufacturingVersionId, skuId: f.nativeSku, quantity: 3 });
    expect((await production.create(a, f.orderId, input)).productionOrder.id).toBe(created.productionOrder.id);
    await production.recordMilestone(a, created.productionOrder.id, { type: "failed", expectedProjectionVersion: 1, externalEventId: randomUUID(), occurredAt: new Date().toISOString(), evidence: { code: "SYNTHETIC_FAILED", note: null, assetIds: [] } });
    const remakeInput = { type: "remake", originalProductionOrderId: created.productionOrder.id, reason: "Synthetic actual remake command", remakeQuantity: 1,
      manufacturing: f.selection, expectedCompletionAt: capacity.expectedCompletionAt, capacityPlan: capacity.capacityPlan, idempotencyKey: randomUUID() };
    const remake = await production.recover(a, remakeInput);
    expect(await production.recover(a, remakeInput)).toEqual(remake);
    const replacement = await production.get(a, remake.replacementProductionOrderId!);
    expect(replacement.versions[0]!.manufacturing).toMatchObject({ source: "original_production_binding", originalBindingId: created.versions[0]!.manufacturing!.id,
      specificationVersionId: f.specificationVersionId, skuId: f.nativeSku, quantity: 1 });
    const [originalBinding] = await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionOrderId, created.productionOrder.id)));
    const [replacementBinding] = await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionOrderId, replacement.productionOrder.id)));
    expect(replacementBinding!.factoryBasis).toEqual(originalBinding!.factoryBasis);
    await withTenant(db.db, a, tx => tx.update(inventoryStockItems).set({ status: "inactive" }).where(eq(inventoryStockItems.id, f.stockId)));
    expect((await production.create({ ...a, permissions: a.permissions.filter(permission => permission !== Permission.ProductRead) }, f.orderId, input)).productionOrder.id).toBe(created.productionOrder.id);
    await expect(production.recover(a, { ...remakeInput, idempotencyKey: randomUUID() })).rejects.toThrow("物料");
  });
  it("rolls back the actual direct command's sealed manufacturing on an audit failure and serializes different request keys", async () => {
    const { f, input } = await commandFixture(), failure = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic real audit boundary failed"));
    try { await expect(production.create(a, f.orderId, input)).rejects.toThrow("Synthetic real audit boundary failed"); }
    finally { failure.mockRestore(); }
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, f.lineId)))).toHaveLength(0);
    const results = await Promise.allSettled([production.create(a, f.orderId, input), production.create(a, f.orderId, { ...input, idempotencyKey: randomUUID() })]);
    expect(results.filter(value => value.status === "fulfilled")).toHaveLength(1);
    const rows = await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.orderLineId, f.lineId)));
    expect(rows).toHaveLength(1); expect(rows[0]!.quantity).toBe(3);
  });
  it("offers only approved manufacturing versions for the actual original work specification without inventory browsing", async () => {
    const f = await fixture("work"), context = { ...a, permissions: a.permissions.filter(permission => permission !== Permission.InventoryRead) };
    const options = await withOrderAuthority(db.db, context, [Permission.OrderRead, Permission.OrderPiiRead], tx => orderProductionManufacturingOptions(tx, context, vault, f.lineId, {}));
    expect(options.source).toMatchObject({ specificationVersionId: f.specificationVersionId, packageQuantity: 1 });
    expect(options.items.map(item => item.versionId)).toEqual([f.manufacturingVersionId]);
    expect(JSON.stringify(options)).not.toMatch(/private|stockItemId|contentCanonical/);
    await expect(withTenant(db.db, a, tx => orderProductionManufacturingOptions(tx, { ...a, permissions: a.permissions.filter(permission => permission !== Permission.ProductRead) }, vault, f.lineId, {}))).rejects.toThrow();
  });
  it("rejects a newly forged legacy receipt instead of adopting its old checksum or missing manufacturing", async () => {
    const { f, input } = await commandFixture(), id = createEntityId(), versionId = createEntityId();
    const legacy = { orderLineId: input.orderLineId, factoryId: input.factoryId, factoryVersionId: input.factoryVersionId, capabilityVersionId: input.capabilityVersionId,
      routingDecisionId: input.routingDecisionId, purchaseOrderVersionId: input.purchaseOrderVersionId, designVersionId: input.designVersionId,
      productionAssetIds: input.productionAssetIds, expectedCompletionAt: input.expectedCompletionAt, instructions: input.instructions, idempotencyKey: input.idempotencyKey };
    const originalChecksum = hash(JSON.stringify({ orderId: f.orderId, input: legacy }));
    await expect(withTenant(db.db, a, async tx => {
      await tx.insert(productionOrders).values({ id, tenantId: a.tenantId, orderId: f.orderId, orderLineId: f.lineId, supplierId, factoryId: factory.factory.id,
        routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId, expectedCompletionAt: new Date(legacy.expectedCompletionAt),
        idempotencyKey: legacy.idempotencyKey, requestChecksum: originalChecksum, createdBy: a.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: a.tenantId, productionOrderId: id, versionNumber: 1, quantity: 3,
        ...factory.pins, designVersionId: f.designId, productionAssetIds: [f.assetId], encryptedInstructions: "synthetic", instructionsChecksum: "a".repeat(64),
        expectedCompletionAt: new Date(legacy.expectedCompletionAt), createdBy: a.userId, createdAt: new Date("2026-01-01") });
      await tx.execute(sql`set constraints production_version_requires_capacity immediate`);
    })).rejects.toMatchObject({ cause: { code: "23514", message: "factory_capacity_all_pools_required" } });
    const restricted = { ...a, permissions: [Permission.OrderRead, Permission.OrderWrite] };
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.id, id)))).toEqual([]);
    expect(await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.productionVersionId, versionId)))).toEqual([]);
    await expect(production.create(restricted, f.orderId, legacy)).rejects.toThrow();
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.id, id)))).toEqual([]);
  });
  it("reads actual native order/specification/design/purchase choices and seals the existing production command", async () => {
    const f = await fixture(), native = new NativeProductionService(db, factories);
    await withTenant(db.db, a, tx => tx.update(orderTable).set({ workflowState: "in_production" }).where(eq(orderTable.id, f.orderId)));
    const detail = await native.detail(a, f.lineId, { specificationVersionId: f.specificationVersionId });
    const list = await native.workspace(a, { q: detail.line.orderNumber }); expect(list.items.map(item => item.id)).toEqual([f.lineId]);
    expect(detail).toMatchObject({ line: { id: f.lineId, quantity: 3, allocatedQuantity: 0, blockers: [] }, source: { productType: "rectangular_print" }, diagnostics: [] });
    expect(detail.designs.map(row => row.versionId)).toEqual([f.designId]); expect(detail.designs[0]!.files.map(row => row.id)).toEqual([f.assetId]);
    expect(detail.routes).toContainEqual(expect.objectContaining({ routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId, supplierId }));
    const choices = await native.factoryChoices(a, f.lineId, { specificationVersionId: f.specificationVersionId, routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId });
    expect(choices.some(choice => choice.pin.factoryId === factory.factory.id && !choice.blockers.length)).toBe(true);
    const manufacturing = await withOrderAuthority(db.db, a, [Permission.OrderRead, Permission.OrderPiiRead], tx => orderProductionManufacturingOptions(tx, a, vault, f.lineId, { nativeSpecificationVersionId: f.specificationVersionId }));
    expect(manufacturing.items.map(item => item.versionId)).toEqual([f.manufacturingVersionId]);
    const input = { ...factory.pins, orderLineId: f.lineId, routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId,
      designVersionId: f.designId, productionAssetIds: [f.assetId], expectedCompletionAt: capacity.expectedCompletionAt, capacityPlan: capacity.capacityPlan, instructions: "Synthetic internal arrangement; no files sent", manufacturing: f.selection, productConfirmation: f.confirmation, idempotencyKey: randomUUID() };
    const created = await production.create(a, f.orderId, input); expect(created.versions[0]!.manufacturing).toMatchObject({ versionId: f.manufacturingVersionId, quantity: 3 });
    const after = await native.detail(a, f.lineId, { specificationVersionId: f.specificationVersionId });
    expect(after.line.allocatedQuantity).toBe(3); expect(after.line.blockers.join(" ")).toContain("不能重复"); expect(after.productions.map(row => row.id)).toContain(created.productionOrder.id);
  });
  it("keeps native reads tenant/private and refuses to override reviewed work or another SKU's specification", async () => {
    const f = await fixture(), work = await fixture("work"), native = new NativeProductionService(db, factories), readonly = { ...a, permissions: a.permissions.filter(permission => permission !== Permission.OrderWrite) };
    expect((await native.detail(readonly, f.lineId, {})).canCreate).toBe(false);
    await expect(native.detail({ ...a, permissions: a.permissions.filter(permission => permission !== Permission.OrderPiiRead) }, f.lineId, {})).rejects.toMatchObject({ status: 403 });
    await expect(native.detail(b, f.lineId, {})).rejects.toMatchObject({ status: 404 });
    await expect(native.detail(a, work.lineId, {})).rejects.toMatchObject({ status: 404 });
    await expect(native.detail(a, f.lineId, { specificationVersionId: work.specificationVersionId })).rejects.toMatchObject({ status: 409 });
    await expect(withTenant(db.db, a, tx => orderProductionManufacturingOptions(tx, a, vault, work.lineId, { nativeSpecificationVersionId: work.specificationVersionId }))).rejects.toThrow("原审核稿");
    const envelopeId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.update(orderTable).set({ addressStatus: "protected" }).where(eq(orderTable.id, f.orderId));
      await tx.insert(orderProtectedDetails).values({ id: envelopeId, tenantId: a.tenantId, orderId: f.orderId, status: "protected", encryptedEnvelope: "synthetic-unused-expired-envelope", retentionExpiresAt: new Date(Date.now() - 60000) });
    });
    await expect(native.detail(a, f.lineId, {})).rejects.toMatchObject({ status: 404 });
    await expect(withTenant(db.db, a, tx => orderProductionManufacturingOptions(tx, a, vault, f.lineId, { nativeSpecificationVersionId: f.specificationVersionId }))).rejects.toThrow("已不可用");
  });
  it("omits design and asset objects outside the current permission-specific owner ceiling", async () => {
    const f = await fixture(), native = new NativeProductionService(db, factories);
    const personal = await withTenant(db.db, a, tx => loadCurrentMembershipContext(tx, a));
    const ceiling = { ...personal, permissionScopes: { ...personal.permissionScopes!, [Permission.DesignRead]: "self" as const, [Permission.AssetRead]: "self" as const } };
    expect((await native.detail(ceiling, f.lineId, { specificationVersionId: f.specificationVersionId })).designs).toHaveLength(1);
    const [version] = await withTenant(db.db, a, tx => tx.select({ taskId: designVersions.taskId }).from(designVersions).where(eq(designVersions.id, f.designId)));
    await withTenant(db.db, a, tx => tx.update(designTasks).set({ createdBy: b.userId }).where(eq(designTasks.id, version!.taskId)));
    expect((await native.detail(ceiling, f.lineId, { specificationVersionId: f.specificationVersionId })).designs).toEqual([]);
    await withTenant(db.db, a, async tx => { await tx.update(designTasks).set({ createdBy: a.userId }).where(eq(designTasks.id, version!.taskId)); await tx.update(assetFiles).set({ ownerUserId: b.userId }).where(eq(assetFiles.id, f.assetId)); });
    expect((await native.detail(ceiling, f.lineId, { specificationVersionId: f.specificationVersionId })).designs).toEqual([]);
  });
  it("rejects approved purchase snapshots from another order, supplier or quantity before any production write", async () => {
    const { f, input } = await commandFixture(), other = await fixture(), wrongSupplier = createEntityId(), wrongPurchase = createEntityId(), wrongVersion = createEntityId(), foreignVersion = createEntityId(), quantityVersion = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(fulfillmentSuppliers).values({ id: wrongSupplier, tenantId: a.tenantId, name: "Synthetic wrong supplier", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, createdBy: a.userId });
      await tx.insert(purchaseOrders).values({ id: wrongPurchase, tenantId: a.tenantId, supplierId: wrongSupplier, orderId: f.orderId, status: "approved", createdBy: a.userId });
      const [original] = await tx.select().from(purchaseOrderVersions).where(eq(purchaseOrderVersions.id, f.purchaseVersionId));
      const [foreign] = await tx.select().from(purchaseOrderVersions).where(eq(purchaseOrderVersions.id, other.purchaseVersionId));
      await tx.insert(purchaseOrderVersions).values({ ...original!, id: wrongVersion, purchaseOrderId: wrongPurchase, createdAt: undefined });
      await tx.insert(purchaseOrderVersions).values({ ...foreign!, id: foreignVersion, versionNumber: 2, lineSnapshot: original!.lineSnapshot, routingDecisionIds: original!.routingDecisionIds, createdAt: undefined });
      await tx.update(purchaseOrders).set({ currentVersionNumber: 2 }).where(eq(purchaseOrders.id, foreign!.purchaseOrderId));
      await tx.insert(purchaseOrderVersions).values({ ...original!, id: quantityVersion, versionNumber: 2, lineSnapshot: [{ orderLineId: f.lineId, quantity: 2, unitCostMinor: 1 }], createdAt: undefined });
      await tx.update(purchaseOrders).set({ currentVersionNumber: 2 }).where(eq(purchaseOrders.id, original!.purchaseOrderId));
    });
    for (const purchaseOrderVersionId of [wrongVersion, foreignVersion, quantityVersion]) await expect(production.create(a, f.orderId, { ...input, purchaseOrderVersionId, idempotencyKey: randomUUID() })).rejects.toThrow("current approved purchase-order version");
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, f.lineId)))).toEqual([]);
  });
  it.each(["shaped_pillow", "tire_cover"] as const)("keeps %s behind reviewed geometry and rolls back every direct-production write", async productType => {
    const f = await fixture("native", productType), native = new NativeProductionService(db, factories);
    await withTenant(db.db, a, tx => tx.update(orderTable).set({ workflowState: "in_production" }).where(eq(orderTable.id, f.orderId)));
    const source = await native.detail(a, f.lineId, { specificationVersionId: f.specificationVersionId });
    expect(source.source?.productType).toBe(productType); expect(source.designs).toEqual([]); expect(source.diagnostics.join(" ")).toContain("已审核生产稿及其几何");
    await expect(native.factoryChoices(a, f.lineId, { specificationVersionId: f.specificationVersionId, routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId })).rejects.toThrow("已审核生产稿");
    await expect(production.create(a, f.orderId, { ...factory.pins, orderLineId: f.lineId, routingDecisionId: f.decisionId, purchaseOrderVersionId: f.purchaseVersionId,
      capacityPlan: capacity.capacityPlan,
      designVersionId: f.designId, productionAssetIds: [f.assetId], expectedCompletionAt: "2026-10-30T00:00:00.000Z", instructions: "Synthetic rejected geometry-only fixture",
      manufacturing: f.selection, productConfirmation: f.confirmation, idempotencyKey: randomUUID() })).rejects.toThrow("直接设计文件入口尚未核实");
    expect(await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, f.lineId)))).toEqual([]);
    expect(await withTenant(db.db, a, tx => tx.select().from(productionManufacturingBindings).where(eq(productionManufacturingBindings.orderLineId, f.lineId)))).toEqual([]);
  });
  describe.sequential("actual production materials", () => {
    const operator: TenantContext = { ...a, userId: createEntityId() };
    const otherOperator: TenantContext = { ...a, userId: createEntityId() };
    const roleId = createEntityId(), memberId = createEntityId();
    const stock = new InventoryService(db, audit), materials = new ProductionMaterialService(db, vault, stock, audit);
    beforeAll(async () => {
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic material operator')", [operator.userId, randomUUID(), `${operator.userId}@example.invalid`]);
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic second material operator')", [otherOperator.userId, randomUUID(), `${otherOperator.userId}@example.invalid`]);
      await withTenant(db.db, a, async tx => {
        await tx.insert(memberships).values({ id: memberId, tenantId: a.tenantId, userId: operator.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: a.tenantId, name: randomUUID(), permissions: a.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: memberId, roleId });
        const otherMembershipId = createEntityId();
        await tx.insert(memberships).values({ id: otherMembershipId, tenantId: a.tenantId, userId: otherOperator.userId, status: "active" });
        await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: otherMembershipId, roleId });
      });
      await withTenant(db.db, b, async tx => {
        const membershipId = createEntityId(), tenantRoleId = createEntityId();
        await tx.insert(memberships).values({ id: membershipId, tenantId: b.tenantId, userId: b.userId, status: "active" });
        await tx.insert(roles).values({ id: tenantRoleId, tenantId: b.tenantId, name: randomUUID(), permissions: b.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: b.tenantId, membershipId, roleId: tenantRoleId });
      });
    });
    async function stocked(options: Parameters<typeof fixture>[2] = {}, opening: number | string = 2) {
      const f = await fixture("native", "rectangular_print", options), po = await initial(f);
      const warehouse = await stock.createWarehouse(operator, { code: "M" + randomUUID().replaceAll("-", "").toUpperCase(), name: "Synthetic material storage", type: "owned", countryCode: "US", timeZone: "UTC" });
      const location = await stock.createLocation(operator, { warehouseId: warehouse.id, code: "MATERIAL", name: "Synthetic material bin" });
      const stockItemId = options.stockItemId ?? f.stockId;
      await stock.recordMovement(operator, { stockItemId, locationId: location.id, lotId: null, quantityDelta: opening, unit: "meter", bucket: "physical", type: "opening",
        sourceType: "opening", sourceId: f.lineId, reasonCode: "SYNTHETIC_OPENING", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
      const workspace = await materials.workspace(operator, po.id);
      return { f, po, warehouseId: warehouse.id, locationId: location.id, stockItemId, bindingId: workspace.bindingId!, contextAuthority: workspace.contextAuthority };
    }
    function base(f: Awaited<ReturnType<typeof stocked>>) { return { bindingId: f.bindingId, contextAuthority: f.contextAuthority, materialCode: "FABRIC", expectedProductionRevision: 1, idempotencyKey: randomUUID(), occurredAt: new Date().toISOString() }; }
    async function balance(f: Awaited<ReturnType<typeof stocked>>) { return (await stock.listBalances(operator)).find(row => row.stockItemId === f.stockItemId && row.locationId === f.locationId)!; }

    describe.sequential("durable material intents", () => {
      const commands = new ProductionMaterialCommandService(db, vault, materials, audit);
      const consume = (f: Awaited<ReturnType<typeof stocked>>) => ({ ...base(f), kind: "consume", quantity: "0.2", locationId: f.locationId,
        lotId: null, reservationEntryId: null, actualConfirmed: true });
      const stored = async (id: string) => (await withTenant(db.db, operator, tx => tx.select().from(productionMaterialCommands).where(eq(productionMaterialCommands.id, id))))[0]!;

      it("persists the original input, recovers in a fresh service and commits only one fact before acknowledgement", async () => {
        const f = await stocked(), input = { ...consume(f), reason: "Synthetic measured fabric was physically consumed" };
        const prepared = await commands.prepare(operator, f.po.id, input);
        expect(prepared).toMatchObject({ status: "prepared", receipt: null, requestKey: input.idempotencyKey });
        expect(await balance(f)).toMatchObject({ physicalQuantity: 2 });
        expect(JSON.stringify(await stored(prepared.id))).not.toContain(input.reason);
        const fresh = new ProductionMaterialCommandService(db, vault, materials, audit);
        expect((await fresh.list(operator, f.po.id)).items[0]!.input).toMatchObject(input);
        const results = await Promise.all([fresh.execute(operator, f.po.id, prepared.id), commands.execute(operator, f.po.id, prepared.id)]);
        expect(results.map(row => row.status)).toEqual(["succeeded", "succeeded"]);
        expect(results[0]!.receipt!.id).toBe(results[1]!.receipt!.id);
        expect(await balance(f)).toMatchObject({ physicalQuantity: "1.8" });
        await expect(commands.prepare(operator, f.po.id, consume(f))).rejects.toThrow("上一笔");
        await commands.acknowledge(operator, f.po.id, prepared.id);
        expect((await stored(prepared.id)).encryptedInput).toBeNull();
        expect((await fresh.get(operator, f.po.id, prepared.id)).receipt!.id).toBe(results[0]!.receipt!.id);
        expect((await fresh.list(operator, f.po.id)).items).toEqual([]);
      });
      it("rejects changed actors or input and makes cancellation prevent both raw and admitted retries", async () => {
        const f = await stocked(), input = consume(f), prepared = await commands.prepare(operator, f.po.id, input);
        expect((await commands.prepare(operator, f.po.id, input)).id).toBe(prepared.id);
        await expect(commands.prepare(operator, f.po.id, { ...input, quantity: "0.1" })).rejects.toThrow("填写发生变化");
        await expect(commands.prepare(otherOperator, f.po.id, input)).rejects.toThrow("原操作员");
        await expect(materials.record(operator, f.po.id, input)).rejects.toThrow("原待确认");
        const cancelled = await commands.cancel(operator, f.po.id, prepared.id);
        expect(cancelled).toMatchObject({ status: "cancelled", input: null, receipt: null });
        expect((await commands.execute(operator, f.po.id, prepared.id)).status).toBe("cancelled");
        await expect(materials.record(operator, f.po.id, input)).rejects.toThrow("已取消或过期");
        expect(await balance(f)).toMatchObject({ physicalQuantity: 2 });
        expect((await commands.acknowledge(operator, f.po.id, prepared.id)).acknowledged).toBe(true);
      });
      it("rolls back stock, original fact and command success together on the final command audit failure", async () => {
        const f = await stocked(), prepared = await commands.prepare(operator, f.po.id, consume(f));
        const original = audit.recordInTransaction.bind(audit); let calls = 0;
        const failed = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (...args) => {
          if (++calls === 2) throw new Error("Synthetic final material command audit failure"); return original(...args);
        });
        try { await expect(commands.execute(operator, f.po.id, prepared.id)).rejects.toThrow("Synthetic final material command audit failure"); } finally { failed.mockRestore(); }
        expect((await stored(prepared.id)).status).toBe("prepared");
        expect(await balance(f)).toMatchObject({ physicalQuantity: 2 });
        expect((await materials.workspace(operator, f.po.id)).entries).toEqual([]);
        expect((await new ProductionMaterialCommandService(db, vault, materials, audit).execute(operator, f.po.id, prepared.id)).status).toBe("succeeded");
      });
      it("stores a domain rejection after its savepoint rollback without inventing a stock or receipt fact", async () => {
        const f = await stocked(), prepared = await commands.prepare(operator, f.po.id, consume(f));
        await stock.recordMovement(operator, { stockItemId: f.stockItemId, locationId: f.locationId, lotId: null, unit: "meter", bucket: "physical", type: "pick", quantityDelta: -2,
          sourceType: "manual", sourceId: "synthetic-physical-change", reasonCode: "MEASURED_PICK", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
        expect(await commands.execute(operator, f.po.id, prepared.id)).toMatchObject({ status: "rejected", errorCode: "basis_changed", receipt: null });
        expect(await balance(f)).toMatchObject({ physicalQuantity: 0 });
        expect((await materials.workspace(operator, f.po.id)).entries).toEqual([]);
      });
      it("waits for an in-flight atomic execution before cancellation and returns its actual committed receipt", async () => {
        const f = await stocked(), prepared = await commands.prepare(operator, f.po.id, consume(f));
        let release!: () => void, reached!: () => void, completed = false;
        const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
        const record = audit.recordInTransaction.bind(audit);
        const pause = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (...args) => {
          if (args[2].action === "production_material.consume") { reached(); await gate; } return record(...args);
        });
        let execution: Promise<unknown> | undefined, cancellation: Promise<unknown> | undefined;
        try {
          execution = commands.execute(operator, f.po.id, prepared.id); await entered;
          cancellation = commands.cancel(operator, f.po.id, prepared.id).then(value => { completed = true; return value; });
          await new Promise(resolve => setTimeout(resolve, 50)); expect(completed).toBe(false);
          expect((await stored(prepared.id)).status).toBe("prepared");
          release(); const results = await Promise.all([execution, cancellation]);
          expect(results).toEqual([expect.objectContaining({ status: "succeeded" }), expect.objectContaining({ status: "succeeded" })]);
          expect(await balance(f)).toMatchObject({ physicalQuantity: "1.8" });
        } finally { release(); await Promise.allSettled([execution, cancellation]); pause.mockRestore(); }
      });
      it("independently redacts an expired original input under tenant RLS without performing business work", async () => {
        const f = await stocked(), input = RecordProductionMaterialSchema.parse(consume(f)), id = createEntityId();
        const authority = await withTenant(db.db, operator, tx => loadCurrentMembershipContext(tx, operator, { lock: false }));
        await withTenant(db.db, operator, tx => tx.insert(productionMaterialCommands).values({ id, tenantId: operator.tenantId, productionOrderId: f.po.id, bindingId: f.bindingId,
          createdBy: operator.userId, requestKey: input.idempotencyKey, requestChecksum: hash(canonicalJson(input)), authoritySnapshot: authority, encryptedInput: vault.encrypt(canonicalJson(input)),
          createdAt: sql`clock_timestamp()-interval '8 days'`, expiresAt: sql`clock_timestamp()-interval '1 day'` }));
        expect(await withTenant(db.db, { ...b, permissions: [] }, tx => expireMaterialCommandInputs(tx))).toBe(0);
        expect(await new MaterialCommandRetentionDispatcher(db).dispatch()).toMatchObject({ redacted: 1, failures: 0 });
        expect(await new MaterialCommandRetentionDispatcher(db).dispatch()).toMatchObject({ redacted: 0, failures: 0 });
        expect(await commands.get(operator, f.po.id, id)).toMatchObject({ status: "expired", input: null, receipt: null, canExecute: false });
        expect((await commands.execute(operator, f.po.id, id)).status).toBe("expired");
        await expect(materials.record(operator, f.po.id, input)).rejects.toThrow("已取消或过期");
        expect((await commands.acknowledge(operator, f.po.id, id)).acknowledged).toBe(true);
        expect(await balance(f)).toMatchObject({ physicalQuantity: 2 });
      });
      it("runs the real independent maintenance process across periodic expiry and restart without consuming queued work", async () => {
        const expired = await stocked(), succeeded = await stocked(), fresh = await stocked();
        const expiredInput = RecordProductionMaterialSchema.parse(consume(expired)), succeededInput = RecordProductionMaterialSchema.parse(consume(succeeded));
        const authority = await withTenant(db.db, operator, tx => loadCurrentMembershipContext(tx, operator, { lock: false }));
        const expiredId = createEntityId(), succeededId = createEntityId();
        await withTenant(db.db, operator, async tx => {
          const identity = await tx.execute<{ role: string }>(sql`select current_user as role`);
          expect(identity[0]!.role).toBe("yummyai_app");
          for (const [id, f, input, due] of [[expiredId, expired, expiredInput, true], [succeededId, succeeded, succeededInput, false]] as const) {
            await tx.insert(productionMaterialCommands).values({ id, tenantId: operator.tenantId, productionOrderId: f.po.id, bindingId: f.bindingId,
              createdBy: operator.userId, requestKey: input.idempotencyKey, requestChecksum: hash(canonicalJson(input)), authoritySnapshot: authority,
              encryptedInput: vault.encrypt(canonicalJson(input)), createdAt: sql`clock_timestamp()-interval '8 days'`,
              expiresAt: due ? sql`clock_timestamp()-interval '1 day'` : sql`clock_timestamp()+interval '30 seconds'` });
          }
        });
        const expiredBefore = await stored(expiredId);
        const success = await commands.execute(operator, succeeded.po.id, succeededId);
        expect(success.status).toBe("succeeded"); const successBefore = await stored(succeededId);
        const freshCommand = await commands.prepare(operator, fresh.po.id, consume(fresh)), freshBefore = await stored(freshCommand.id);
        await createStorageFromEnvironment().ensureBucket(); // Guarded disposable runner bucket only.
        const queue = createQueue(QueueName.Media), job = await queue.add("synthetic-retention-backlog", { synthetic: true }, { jobId: randomUUID() })
          .catch(async error => { await queue.close(); throw error; });
        const children: ChildProcess[] = [];
        const root = fileURLToPath(new URL("../../../../", import.meta.url));
        async function launch() {
          const events: Array<Record<string, unknown>> = []; let output = "";
          const child = spawn(process.execPath, ["--import", "./apps/api/node_modules/tsx/dist/loader.mjs", "tools/scripts/material-retention-runtime.mjs"], {
            cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...process.env, DATABASE_URL: targetUrl.href, TSX_DISABLE_CACHE: "1",
              WORKER_QUEUES: "all", WORKER_SCHEDULERS: "all", WORKER_SHUTDOWN_TIMEOUT_MS: "5000", MODEL_CREDENTIAL_ENCRYPTION_KEY: "unusable-unused-model-key",
              ORDER_PII_ENCRYPTION_KEY: "unusable-unused-order-key", MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY: "unusable-unused-marketplace-key" },
          });
          children.push(child);
          child.stdout!.on("data", value => { output = (output + String(value)).slice(-20_000); });
          child.stderr!.on("data", value => { output = (output + String(value)).slice(-20_000); });
          child.on("message", value => { if (value && typeof value === "object") events.push(value as Record<string, unknown>); });
          const closed = new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code ?? 1)); });
          void closed.catch(() => undefined);
          async function waitFor(check: () => boolean, timeout = 25_000) {
            const end = Date.now() + timeout;
            while (!check()) {
              if (child.exitCode !== null || child.signalCode !== null) throw new Error("Retention process exited before expected evidence");
              if (Date.now() >= end) throw new Error("Retention process evidence deadline exceeded");
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          await waitFor(() => events.some(e => e.type === "worker.lifecycle" && e.state === "ready"));
          const ready = events.find(e => e.type === "worker.lifecycle" && e.state === "ready")!;
          expect(ready.queues).toEqual([]); expect(ready.schedulers).toEqual(["materialCommandRetentionScheduler"]);
          return { child, events, closed, waitFor, output: () => output };
        }
        async function stop(probe: { child: ChildProcess; closed: Promise<number> }) {
          if (probe.child.exitCode === null && probe.child.signalCode === null && probe.child.connected) probe.child.send("shutdown", () => undefined);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try { return await Promise.race([probe.closed, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Retention process shutdown deadline exceeded")), 8_000);
          })]); } finally { if (timer) clearTimeout(timer); }
        }
        try {
          const first = await launch();
          await first.waitFor(() => first.events.some(e => e.type === "worker.maintenance"));
          expect((await stored(expiredId)).status).toBe("expired");
          expect((await stored(expiredId)).encryptedInput).toBeNull();
          expect((await stored(succeededId)).encryptedInput).not.toBeNull();
          expect(await job.getState()).toBe("waiting");
          await first.waitFor(() => first.events.filter(e => e.type === "worker.maintenance").length >= 2, 75_000);
          const successAfter = await stored(succeededId);
          expect(successAfter).toEqual({ ...successBefore, encryptedInput: null, redactedAt: expect.any(Date) });
          expect(await stored(freshCommand.id)).toEqual(freshBefore);
          expect(await balance(expired)).toMatchObject({ physicalQuantity: 2 });
          expect(await balance(succeeded)).toMatchObject({ physicalQuantity: "1.8" });
          expect(await job.getState()).toBe("waiting");
          expect(await stop(first)).toBe(0);
          const restarted = await launch();
          await restarted.waitFor(() => restarted.events.some(e => e.type === "worker.maintenance"));
          expect((await stored(succeededId)).entryId).toBe(successBefore.entryId);
          expect(await stored(freshCommand.id)).toEqual(freshBefore);
          expect(await job.getState()).toBe("waiting");
          expect(await stop(restarted)).toBe(0);
          for (const current of [first, restarted]) {
            expect(current.events.filter(e => e.type === "worker.maintenance").every(e => e.state === "completed" && e.failures === 0)).toBe(true);
            for (const secret of [operator.tenantId, operator.userId, expiredId, succeededId, "unusable-unused-model-key", expiredBefore.encryptedInput!, successBefore.encryptedInput!]) expect(current.output()).not.toContain(secret);
            expect(current.output()).not.toContain('"type":"worker.job"');
          }
        } finally {
          for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise(resolve => child.once("close", resolve)); }
          }
          try { await job.remove(); } finally { await queue.close(); }
        }
      }, 140_000);
      it("rechecks current permissions, isolates original operators and rejects mutable or fabricated SQL outcomes", async () => {
        const f = await stocked(), prepared = await commands.prepare(operator, f.po.id, consume(f));
        await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions.filter(value => value !== Permission.InventoryWrite) }).where(eq(roles.id, roleId)));
        try {
          await expect(commands.execute(operator, f.po.id, prepared.id)).rejects.toThrow();
          expect((await commands.list(operator, f.po.id)).items[0]!.canExecute).toBe(false);
          expect((await commands.cancel(operator, f.po.id, prepared.id)).status).toBe("cancelled");
        } finally { await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleId))); }
        await expect(commands.get(otherOperator, f.po.id, prepared.id)).rejects.toThrow("本人的原物料提交不存在");
        await expect(commands.get(b, f.po.id, prepared.id)).rejects.toThrow("not found");
        expect(await withTenant(db.db, b, tx => tx.select().from(productionMaterialCommands))).toEqual([]);
        await expect(withTenant(db.db, operator, tx => tx.update(productionMaterialCommands).set({ requestChecksum: "e".repeat(64) }).where(eq(productionMaterialCommands.id, prepared.id)))).rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("immutable") } });
        await expect(withTenant(db.db, operator, tx => tx.update(productionMaterialCommands).set({ status: "succeeded", entryId: createEntityId(), completedAt: new Date() }).where(eq(productionMaterialCommands.id, prepared.id)))).rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("immutable") } });
      });
      it("rejects unfenced SQL material writes and requires command success in the same commit even with a forged local setting", async () => {
        const f = await stocked({ responsibility: "factory" }), input = { ...base(f), kind: "factory_report", quantity: "0.2", reportReference: "Synthetic actual supplier report", actualConfirmed: true };
        const prepared = await commands.prepare(operator, f.po.id, input), header = await stored(prepared.id);
        const fact = () => ({ id: createEntityId(), tenantId: operator.tenantId, productionOrderId: f.po.id, bindingId: f.bindingId, materialCode: "FABRIC", stockItemId: f.stockItemId,
          unit: "meter", kind: "factory_report" as const, quantity: "0.2", reportReference: input.reportReference, idempotencyKey: input.idempotencyKey,
          requestChecksum: header.requestChecksum, createdBy: operator.userId, occurredAt: new Date(input.occurredAt) });
        await expect(withTenant(db.db, operator, tx => tx.insert(productionMaterialEntries).values(fact()))).rejects.toMatchObject({ cause: { code: "23514", message: expect.stringContaining("original admitted command") } });
        await expect(withTenant(db.db, operator, async tx => {
          await tx.execute(sql`select set_config('app.material_command_id', ${prepared.id}, true)`);
          await tx.insert(productionMaterialEntries).values(fact());
        })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("commit together") });
        expect((await stored(prepared.id)).status).toBe("prepared");
        expect((await materials.workspace(operator, f.po.id)).entries).toEqual([]);
      });
    });

    it("consumes part of its original reservation, releases only the remainder and returns an actual original quantity", async () => {
      const f = await stocked(), reserve = await materials.record(operator, f.po.id, { ...base(f), kind: "reserve", quantity: "0.5", locationId: f.locationId, lotId: null });
      const consume = await materials.record(operator, f.po.id, { ...base(f), kind: "consume", quantity: "0.2", locationId: f.locationId, lotId: null, reservationEntryId: reserve.entry.id, actualConfirmed: true });
      expect(await balance(f)).toMatchObject({ physicalQuantity: "1.8", reservedQuantity: "0.3", availableQuantity: "1.5" });
      expect((await materials.receipt(operator, f.po.id, reserve.entry.idempotencyKey)).remainingReservedQuantity).toBe("0.3");
      await stock.rebuildProjection(operator, { idempotencyKey: randomUUID() });
      expect(await balance(f)).toMatchObject({ physicalQuantity: "1.8", reservedQuantity: "0.3" });
      const released = await materials.record(operator, f.po.id, { ...base(f), kind: "release", originalEntryId: reserve.entry.id });
      expect(released.entry.quantity).toBe("0.3");
      await materials.record(operator, f.po.id, { ...base(f), kind: "return", originalEntryId: consume.entry.id, quantity: "0.05", actualConfirmed: true, reason: "Synthetic unused measured fabric returned to original bin" });
      expect(await balance(f)).toMatchObject({ physicalQuantity: "1.85", reservedQuantity: 0 });
      expect((await materials.workspace(operator, f.po.id)).lines[0]).toMatchObject({ actualNetQuantity: "0.15", outstandingReservedQuantity: 0 });
      await expect(materials.record(operator, f.po.id, { ...base(f), kind: "return", originalEntryId: consume.entry.id, quantity: "0.16", actualConfirmed: true, reason: "Synthetic excessive return must be refused" })).rejects.toThrow("累计更正");
      const [header] = await withTenant(db.db, a, tx => tx.select().from(productionOrders).where(eq(productionOrders.id, f.po.id)));
      expect(header).toMatchObject({ status: "planned", projectionVersion: 1, currentVersionNumber: 1 });
    });
    it("pages original stock dimensions with stable cursors across projection rebuild and rejects other BOM sources", async () => {
      const f = await stocked();
      for (let index = 0; index < 25; index++) {
        const location = await stock.createLocation(operator, { warehouseId: f.warehouseId, code: "M" + index, name: "Synthetic material bin " + index });
        await stock.recordMovement(operator, { stockItemId: f.stockItemId, locationId: location.id, lotId: null, quantityDelta: 1, unit: "meter", bucket: "physical", type: "opening",
          sourceType: "opening", sourceId: f.f.lineId, reasonCode: "SYNTHETIC_OPENING", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
      }
      const query = { bindingId: f.bindingId, materialCode: "FABRIC" }, first = await materials.stockOptions(operator, f.po.id, query);
      expect(first.items).toHaveLength(25); expect(first.nextCursor).not.toBeNull();
      await stock.rebuildProjection(operator, { idempotencyKey: randomUUID() });
      const second = await materials.stockOptions(operator, f.po.id, { ...query, after: first.nextCursor });
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(row => row.dimensionKey)).size).toBe(26);
      const refreshed = await materials.stockOptions(operator, f.po.id, { ...query, selected: second.items[0]!.dimensionKey });
      expect(refreshed.items).toHaveLength(25); expect(refreshed.selected[0]!.dimensionKey).toBe(second.items[0]!.dimensionKey);
      await expect(materials.stockOptions(operator, f.po.id, { ...query, after: `${createEntityId()}:${f.locationId}:-` })).rejects.toThrow("游标");
      await expect(materials.stockOptions(b, f.po.id, query)).rejects.toThrow("制造依据不存在");
      const factory = await stocked({ responsibility: "factory" });
      await expect(materials.stockOptions(operator, factory.po.id, { bindingId: factory.bindingId, materialCode: "FABRIC" })).rejects.toThrow("商家供料");
    });
    it("pages all original reservation choices and exposes exact current remainders after partial consumption", async () => {
      const f = await stocked();
      for (let index = 0; index < 26; index++) await materials.record(operator, f.po.id, { ...base(f), kind: "reserve", quantity: "0.01", locationId: f.locationId, lotId: null });
      const query = { bindingId: f.bindingId, materialCode: "FABRIC" }, first = await materials.reservationOptions(operator, f.po.id, query);
      expect(first.items).toHaveLength(25);
      const chosen = first.items[0]!;
      await materials.record(operator, f.po.id, { ...base(f), kind: "consume", quantity: "0.005", locationId: chosen.locationId, lotId: chosen.lotId, reservationEntryId: chosen.entryId, actualConfirmed: true });
      const current = await materials.reservationOptions(operator, f.po.id, query);
      expect(current.items.find(row => row.entryId === chosen.entryId)).toMatchObject({ remainingQuantity: "0.005", dimensionActive: true });
      const second = await materials.reservationOptions(operator, f.po.id, { ...query, after: first.nextCursor });
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(row => row.entryId)).size).toBe(26);
      const refreshed = await materials.reservationOptions(operator, f.po.id, { ...query, selected: second.items[0]!.entryId });
      expect(refreshed.selected).toHaveLength(1); expect(refreshed.selected[0]!.entryId).toBe(second.items[0]!.entryId);
      expect(await materials.entry(operator, f.po.id, chosen.entryId)).toMatchObject({ remainingReservedQuantity: "0.005", warehouseName: expect.any(String), locationName: expect.any(String) });
      await expect(materials.entry(b, f.po.id, chosen.entryId)).rejects.toThrow();
    });
    it("recovers one original receipt after concurrent retries and a fresh service instance", async () => {
      const f = await stocked();
      const command = { ...base(f), kind: "consume", quantity: "0.25", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true };
      const results = await Promise.all([materials.record(operator, f.po.id, command), materials.record(operator, f.po.id, command)]);
      expect(results[0]!.entry.id).toBe(results[1]!.entry.id); expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
      const fresh = new ProductionMaterialService(db, vault, stock, audit);
      expect((await fresh.receipt(operator, f.po.id, command.idempotencyKey)).id).toBe(results[0]!.entry.id);
      expect(await balance(f)).toMatchObject({ physicalQuantity: "1.75" });
      await expect(materials.record(operator, f.po.id, { ...command, quantity: "0.1" })).rejects.toThrow("正文发生变化");
      await expect(materials.record(otherOperator, f.po.id, command)).rejects.toThrow("操作员");
    });
    it("records factory supplied material as a manual report without deducting merchant stock", async () => {
      const f = await stocked({ responsibility: "factory" });
      const report = await materials.record(operator, f.po.id, { ...base(f), kind: "factory_report", quantity: "0.3", reportReference: "Synthetic factory sheet 001", actualConfirmed: true });
      expect(report.entry).toMatchObject({ movementId: null, reservationId: null, locationId: null });
      await materials.record(operator, f.po.id, { ...base(f), kind: "factory_correction", originalEntryId: report.entry.id, quantity: "0.1", reason: "Synthetic correction to the original factory sheet" });
      expect(await balance(f)).toMatchObject({ physicalQuantity: 2, reservedQuantity: 0 });
      expect((await materials.workspace(operator, f.po.id)).lines[0]).toMatchObject({ actualNetQuantity: "0.2", actualSource: "manual_factory_report" });
      await expect(materials.record(operator, f.po.id, { ...base(f), kind: "consume", quantity: "0.1", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true })).rejects.toThrow("供料责任");
      await expect(materials.record(operator, f.po.id, { ...base(f), kind: "factory_correction", originalEntryId: report.entry.id, quantity: "0.21", reason: "Synthetic excessive correction is rejected" })).rejects.toThrow("累计更正");
    });
    it("compares nonterminating original plans exactly and requires an explained overage", async () => {
      const f = await stocked({ denominator: 3 });
      await materials.record(operator, f.po.id, { ...base(f), kind: "consume", quantity: "0.333333333", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true });
      const extra = { ...base(f), kind: "consume", quantity: "0.000000001", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true };
      await expect(materials.record(operator, f.po.id, extra)).rejects.toThrow("偏差原因");
      await materials.record(operator, f.po.id, { ...extra, reason: "Synthetic measured extra nanounit was physically consumed" });
      expect((await materials.workspace(operator, f.po.id)).lines[0]).toMatchObject({ plannedNumerator: "1", plannedDenominator: "3", actualNetQuantity: "0.333333334" });
    });
    it("serializes different productions against the same stock dimension without overselling", async () => {
      const f = await stocked({}, "0.5"), secondFixture = await fixture("native", "rectangular_print", { stockItemId: f.stockItemId }), second = await initial(secondFixture);
      const secondBasis = await materials.workspace(operator, second.id);
      const command = { ...base(f), kind: "consume", quantity: "0.4", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true };
      const results = await Promise.allSettled([materials.record(operator, f.po.id, command), materials.record(operator, second.id, { ...command, bindingId: secondBasis.bindingId, idempotencyKey: randomUUID() })]);
      expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
      expect(await balance(f)).toMatchObject({ physicalQuantity: "0.1", reservedQuantity: 0 });
    });
    it("rolls back movement, partial reservation and receipt when the atomic audit fails", async () => {
      const f = await stocked(), reserve = await materials.record(operator, f.po.id, { ...base(f), kind: "reserve", quantity: "0.5", locationId: f.locationId, lotId: null });
      const command = { ...base(f), kind: "consume", quantity: "0.2", locationId: f.locationId, lotId: null, reservationEntryId: reserve.entry.id, actualConfirmed: true };
      const failed = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic material audit rejection"));
      try { await expect(materials.record(operator, f.po.id, command)).rejects.toThrow("Synthetic material audit rejection"); } finally { failed.mockRestore(); }
      expect(await balance(f)).toMatchObject({ physicalQuantity: 2, reservedQuantity: "0.5" });
      await expect(materials.receipt(operator, f.po.id, command.idempotencyKey)).rejects.toThrow("尚未找到");
      expect((await materials.record(operator, f.po.id, command)).replayed).toBe(false);
    });
    it("uses current member permissions even for an old receipt and preserves tenant isolation", async () => {
      const f = await stocked(), command = { ...base(f), kind: "consume", quantity: "0.1", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true };
      await materials.record(operator, f.po.id, command);
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions.filter(value => value !== Permission.InventoryWrite) }).where(eq(roles.id, roleId)));
      try { await expect(materials.record(operator, f.po.id, command)).rejects.toThrow(); } finally {
        await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleId)));
      }
      expect(await withTenant(db.db, b, tx => tx.select().from(productionMaterialEntries))).toEqual([]);
      await expect(materials.workspace(b, f.po.id)).rejects.toThrow("not found");
      await expect(db.client.unsafe("update production_material_entries set quantity=1 where production_order_id=$1", [f.po.id])).rejects.toThrow("immutable");
      await expect(db.client.unsafe("delete from production_material_entries where production_order_id=$1", [f.po.id])).rejects.toThrow("immutable");
    });
    it("does not permit a generic consumption entry without the original production receipt", async () => {
      const f = await stocked();
      await expect(stock.recordMovement(operator, { stockItemId: f.stockItemId, locationId: f.locationId, lotId: null, unit: "meter", bucket: "physical", type: "consumption",
        quantityDelta: "-0.1", sourceType: "order_line", sourceId: f.f.lineId, reasonCode: "PRODUCTION_CONSUMPTION", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() })).rejects.toThrow("原生产单");
      await expect(withTenant(db.db, operator, tx => tx.insert(inventoryMovements).values({ id: createEntityId(), tenantId: a.tenantId, stockItemId: f.stockItemId, locationId: f.locationId,
        lotId: null, unit: "meter", bucket: "physical", type: "consumption", quantityDelta: "-0.1", sourceType: "order_line", sourceId: f.f.lineId,
        reasonCode: "SYNTHETIC_ORPHAN", occurredAt: new Date(), idempotencyKey: randomUUID(), recordedBy: operator.userId }))).rejects.toThrow("atomic material receipt");
    });
    it("rejects stale identity, substituted bindings and state revisions while allowing an explained actual late record", async () => {
      const f = await stocked(), other = await stocked();
      const command = { ...base(f), kind: "consume", quantity: "0.1", locationId: f.locationId, lotId: null, reservationEntryId: null, actualConfirmed: true };
      await expect(materials.record(operator, f.po.id, { ...command, contextAuthority: "stale-authority" })).rejects.toThrow("当前账号");
      await expect(materials.record(operator, f.po.id, { ...command, bindingId: other.bindingId })).rejects.toThrow("制造依据不存在");
      await expect(materials.record(operator, f.po.id, { ...command, materialCode: "OTHER" })).rejects.toThrow("不属于原生产BOM");
      await withTenant(db.db, a, tx => tx.update(productionOrders).set({ status: "completed", projectionVersion: 2 }).where(eq(productionOrders.id, f.po.id)));
      await expect(materials.record(operator, f.po.id, command)).rejects.toThrow("生产状态已变化");
      await expect(materials.record(operator, f.po.id, { ...command, expectedProductionRevision: 2 })).rejects.toThrow("补记须说明原因");
      await materials.record(operator, f.po.id, { ...command, expectedProductionRevision: 2, reason: "Synthetic prior physical consumption recorded after completion" });
      expect(await balance(f)).toMatchObject({ physicalQuantity: "1.9" });
      expect((await materials.workspace(operator, f.po.id)).productionStatus).toBe("completed");
    });
  });

  describe.sequential("durable production commands", () => {
    const operator: TenantContext = { ...a, userId: createEntityId() };
    const roleId = createEntityId(), memberId = createEntityId();
    const commands = new ProductionCommandService(db, vault, production);
    beforeAll(async () => {
      await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic recovery operator')", [operator.userId, randomUUID(), `${operator.userId}@example.invalid`]);
      await withTenant(db.db, a, async tx => {
        await tx.insert(memberships).values({ id: memberId, tenantId: a.tenantId, userId: operator.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: a.tenantId, name: randomUUID(), permissions: a.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: memberId, roleId });
      });
    });
    async function preparedFixture() {
      const { f, input } = await commandFixture();
      // Native orders never supplied customer PII. Do not manufacture an envelope.
      await db.client.unsafe("update orders set address_status='missing' where id=$1", [f.orderId]);
      const command = { kind: "approved_design" as const, targetId: f.orderId, input };
      return { f, input, command, intent: await commands.prepare(operator, command) };
    }
    const rowsFor = (lineId: string) => withTenant(db.db, operator, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, lineId)));

    it("finds the original prepared command in a new service and rejects changed bodies, actors and tenant reads", async () => {
      const { f, command, intent } = await preparedFixture();
      expect(intent).toMatchObject({ status: "prepared", canExecute: true, receipt: null, summary: { quantity: 3, instructions: command.input.instructions } });
      const fresh = new ProductionCommandService(db, vault, production);
      expect((await fresh.list(operator, { orderId: f.orderId })).items.map(item => item.id)).toEqual([intent.id]);
      expect((await fresh.prepare(operator, command)).id).toBe(intent.id);
      await expect(fresh.prepare(operator, { ...command, input: { ...command.input, instructions: "Different body" } })).rejects.toThrow("原始内容");
      await expect(fresh.prepare(operator, { ...command, targetId: command.targetId.toUpperCase() })).rejects.toThrow("小写编号");
      await expect(fresh.prepare(operator, { ...command, input: { ...command.input, orderLineId: f.lineId.toUpperCase() } })).rejects.toThrow("小写编号");
      await expect(fresh.get(a, intent.id)).rejects.toThrow();
      expect(await withTenant(db.db, b, tx => tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, intent.id)))).toEqual([]);
      expect(await rowsFor(f.lineId)).toHaveLength(0);
      await expect(production.createReceipt(operator, f.orderId, command.input)).rejects.toThrow("原生产提交");
      await commands.cancel(operator, intent.id);
      await expect(production.createReceipt(operator, f.orderId, command.input)).rejects.toThrow("原生产提交");
    });

    it("commits a minimal receipt without a DTO read and retains success until the original actor acknowledges it", async () => {
      const { f, intent } = await preparedFixture(), dtoFailure = vi.spyOn(production, "get").mockRejectedValue(new Error("Synthetic post-commit detail failure"));
      let saved;
      try { saved = await commands.execute(operator, intent.id); expect(dtoFailure).not.toHaveBeenCalled(); }
      finally { dtoFailure.mockRestore(); }
      expect(saved).toMatchObject({ id: intent.id, status: "succeeded", acknowledged: false });
      expect(saved.receipt?.productionOrderIds).toHaveLength(1);
      expect((await commands.execute(operator, intent.id)).receipt).toEqual(saved.receipt);
      expect(await rowsFor(f.lineId)).toHaveLength(1);
      expect((await commands.list(operator, { orderId: f.orderId })).items).toHaveLength(1);
      const acknowledged = await commands.acknowledge(operator, intent.id);
      expect(acknowledged).toMatchObject({ status: "succeeded", acknowledged: true, summary: null, receipt: saved.receipt });
      expect((await commands.list(operator, { orderId: f.orderId })).items).toHaveLength(0);
      const [stored] = await withTenant(db.db, operator, tx => tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, intent.id)));
      expect(stored!.encryptedInput).toBeNull(); expect(stored!.requestChecksum).toHaveLength(64);
    });

    it("recovers committed owner evidence when the command process loses its result before sealing the journal", async () => {
      const { f, intent } = await preparedFixture();
      const original = production.createReceipt.bind(production);
      const interrupted = vi.spyOn(production, "createReceipt").mockImplementationOnce(async (...args) => {
        await original(...args); throw new Error("Synthetic process lost its commit response");
      });
      try { expect((await commands.execute(operator, intent.id)).status).toBe("succeeded"); }
      finally { interrupted.mockRestore(); }
      expect(await rowsFor(f.lineId)).toHaveLength(1);
      expect((await new ProductionCommandService(db, vault, production).get(operator, intent.id)).status).toBe("succeeded");
    });

    it("rechecks current membership and permission scopes without replacing the original authority ceiling", async () => {
      const { f, intent } = await preparedFixture();
      try {
        await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: a.permissions.filter(value => value !== Permission.OrderWrite) }).where(eq(roles.id, roleId)));
        expect((await commands.get(operator, intent.id)).canExecute).toBe(false);
        await expect(commands.execute(operator, intent.id)).rejects.toThrow();
        expect(await rowsFor(f.lineId)).toHaveLength(0);
        await withTenant(db.db, a, tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, memberId)));
        await expect(commands.get(operator, intent.id)).rejects.toThrow();
      } finally {
        await withTenant(db.db, a, async tx => { await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, memberId));
          await tx.update(roles).set({ permissions: a.permissions }).where(eq(roles.id, roleId)); });
      }
      expect((await commands.execute(operator, intent.id)).status).toBe("succeeded");
    });

    it("redacts an anonymized source before decrypting or executing and keeps immutable request evidence", async () => {
      const { f, intent } = await preparedFixture();
      await db.client.unsafe("update orders set address_status='anonymized' where id=$1", [f.orderId]);
      const [stored] = await withTenant(db.db, operator, tx => tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, intent.id)));
      expect(stored!.encryptedInput).toBeNull();
      expect(await commands.get(operator, intent.id)).toMatchObject({ status: "expired", summary: null, canExecute: false, errorCode: "source_unavailable" });
      expect((await commands.execute(operator, intent.id)).status).toBe("expired");
      expect(await rowsFor(f.lineId)).toHaveLength(0);
      await expect(withTenant(db.db, operator, tx => tx.update(productionCommandIntents).set({ encryptedInput: "replacement" }).where(eq(productionCommandIntents.id, intent.id))))
        .rejects.toThrow();
    });

    it("retains the original narrower product scope after a later role grant and requires a newly confirmed command", async () => {
      const { f, input } = await commandFixture();
      await db.client.unsafe("update orders set address_status='missing' where id=$1", [f.orderId]);
      const narrowed: TenantContext = { ...operator, permissionScopes: Object.fromEntries(operator.permissions.map(permission => [permission, permission === Permission.ProductRead ? "self" : "tenant"])) };
      const intent = await commands.prepare(narrowed, { kind: "approved_design", targetId: f.orderId, input });
      const rejected = await commands.execute(operator, intent.id);
      expect(rejected).toMatchObject({ status: "rejected", errorCode: "conflict", canExecute: false });
      const [stored] = await withTenant(db.db, operator, tx => tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, intent.id)));
      expect(stored!.authoritySnapshot.permissionScopes?.[Permission.ProductRead]).toBe("self");
      expect(await rowsFor(f.lineId)).toHaveLength(0);
      await commands.acknowledge(operator, intent.id);
      const next = await commands.prepare(operator, { kind: "approved_design", targetId: f.orderId, input: { ...input, idempotencyKey: randomUUID() } });
      expect((await commands.execute(operator, next.id)).status).toBe("succeeded"); expect(await rowsFor(f.lineId)).toHaveLength(1);
    });

    it("refuses fabricated SQL success and preserves line-scoped legacy keys across different native orders", async () => {
      const first = await preparedFixture(), second = await commandFixture();
      await db.client.unsafe("update orders set address_status='missing' where id=$1", [second.f.orderId]);
      const other = await commands.prepare(operator, { kind: "approved_design", targetId: second.f.orderId,
        input: { ...second.input, idempotencyKey: first.input.idempotencyKey } });
      expect(other.id).not.toBe(first.intent.id);
      await expect(withTenant(db.db, operator, tx => tx.update(productionCommandIntents).set({ status: "succeeded", resultIds: [createEntityId()] })
        .where(eq(productionCommandIntents.id, first.intent.id)))).rejects.toThrow();
      expect((await commands.get(operator, first.intent.id)).status).toBe("prepared");
      await commands.cancel(operator, first.intent.id); await commands.cancel(operator, other.id);
    });

    it("waits for an already fenced transaction and recovers its commit before another claim can write", async () => {
      const { f, intent } = await preparedFixture();
      let release!: () => void, reached!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
      const create = production.createReceipt.bind(production), record = audit.recordInTransaction.bind(audit);
      const lease = vi.spyOn(production, "createReceipt").mockImplementationOnce(async (...args) => {
        await withTenant(db.db, operator, tx => tx.update(productionCommandIntents).set({ leaseExpiresAt: new Date(Date.now() + 1000) }).where(eq(productionCommandIntents.id, intent.id)));
        return create(...args);
      });
      const pause = vi.spyOn(audit, "recordInTransaction").mockImplementationOnce(async (...args) => { reached(); await gate; return record(...args); });
      let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined, secondDone = false;
      try {
        first = commands.execute(operator, intent.id); await entered;
        await new Promise(resolve => setTimeout(resolve, 1100));
        second = new ProductionCommandService(db, vault, production).execute(operator, intent.id).then(value => { secondDone = true; return value; });
        await new Promise(resolve => setTimeout(resolve, 50)); expect(secondDone).toBe(false);
        expect(await rowsFor(f.lineId)).toHaveLength(0);
        release(); const results = await Promise.all([first, second]);
        expect(results).toEqual([expect.objectContaining({ status: "succeeded" }), expect.objectContaining({ status: "succeeded" })]);
        expect(await rowsFor(f.lineId)).toHaveLength(1);
        const attempts = await withTenant(db.db, operator, tx => tx.select().from(productionCommandAttempts).where(eq(productionCommandAttempts.intentId, intent.id)));
        expect(attempts).toHaveLength(1); expect(attempts[0]!.status).toBe("succeeded");
      } finally { release(); await Promise.allSettled([first, second].filter(Boolean)); lease.mockRestore(); pause.mockRestore(); }
    });

    it("rejects a paused executor inside the real write transaction after another claim takes over", async () => {
      const { f, intent } = await preparedFixture();
      function pausedOwner() {
        let admit!: () => void, reached!: () => void, calls = 0;
        const gate = new Promise<void>(resolve => { admit = resolve; }), entered = new Promise<void>(resolve => { reached = resolve; });
        const proxy = new Proxy(db.db, { get(target, property, receiver) {
          if (property !== "transaction") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof target.transaction>) => {
            if (++calls === 2) { reached(); await gate; }
            return target.transaction(...args);
          };
        } });
        const owner = new OrderProductionService({ ...db, db: proxy }, vault, orders, audit, undefined, factories);
        return { commands: new ProductionCommandService(db, vault, owner), entered, admit };
      }
      const first = pausedOwner(), second = pausedOwner(); let oldRun: Promise<unknown> | undefined, newRun: Promise<unknown> | undefined;
      try {
        oldRun = first.commands.execute(operator, intent.id); await first.entered;
        await withTenant(db.db, operator, tx => tx.update(productionCommandIntents).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(productionCommandIntents.id, intent.id)));
        newRun = second.commands.execute(operator, intent.id); await second.entered;
        first.admit(); await oldRun;
        expect(await rowsFor(f.lineId)).toHaveLength(0);
        const [active] = await withTenant(db.db, operator, tx => tx.select().from(productionCommandIntents).where(eq(productionCommandIntents.id, intent.id)));
        expect(active).toMatchObject({ status: "executing", generation: 2 });
        second.admit(); expect(await newRun).toMatchObject({ status: "succeeded" });
        expect(await rowsFor(f.lineId)).toHaveLength(1);
        const attempts = await withTenant(db.db, operator, tx => tx.select().from(productionCommandAttempts).where(eq(productionCommandAttempts.intentId, intent.id)).orderBy(productionCommandAttempts.generation));
        expect(attempts.map(attempt => attempt.status)).toEqual(["superseded", "succeeded"]);
      } finally { first.admit(); second.admit(); await Promise.allSettled([oldRun, newRun].filter(Boolean)); }
    });
  });
});
