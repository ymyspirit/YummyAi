import { createHash, randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase, withTenant, creativeDesignBatches, printProfiles, productionEditorProjects,
  inventoryPurchaseOrders, fulfillmentSuppliers, productPlans, spus, skus, designTasks, designVersions, designVersionFiles, assetFiles, activeCreativeAsset,
  memberships, membershipRoles, roles, type DatabaseConnection } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { AuditService } from "../audit/audit.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { RuleCenterService } from "./rule-center.service.js";

const disposable = /^\/order_daily_(?:e2e|test)_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname);
describe.skipIf(!disposable)("working-record archival preserves tenant history", () => {
  let db: DatabaseConnection, a: TenantContext, b: TenantContext, audit: AuditService;
  const batch = createEntityId(), running = createEntityId(), project = createEntityId(), profile = createEntityId();
  let po: string;
  let designs: PodBatchWorkflowService, editor: ProductionEditorService, work: OrderWorkspaceService, procurement: ProcurementService;
  beforeAll(async () => {
    db = connectDatabase(); await migrateDatabase(db); a = await tenant(); b = await tenant(); audit = new AuditService(db);
    designs = new PodBatchWorkflowService(db, undefined as never, audit, undefined as never);
    editor = new ProductionEditorService(db, undefined as never, undefined as never, undefined as never, audit, undefined as never, undefined as never);
    work = new OrderWorkspaceService(db, undefined as never, undefined as never, undefined as never, editor, undefined as never);
    const inventory = new InventoryService(db, audit);
    procurement = new ProcurementService(db, inventory, audit);
    const supplierId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(creativeDesignBatches).values([batch, running].map(id => ({ id, tenantId: a.tenantId, name: `Synthetic archive ${id}`, executionMode: "infinite_canvas" as const,
        status: id === running ? "running" as const : "completed" as const, itemCount: 1, requestChecksum: createHash("sha256").update(id).digest("hex") })));
      await tx.insert(productionEditorProjects).values({ id: project, tenantId: a.tenantId, name: "Synthetic archive project", createdBy: a.userId });
      await tx.insert(printProfiles).values({ id: profile, tenantId: a.tenantId, code: `ARCHIVE-${profile}` });
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: a.tenantId, name: "Synthetic archive supplier", kind: "manual", regionCode: "CN", settlementCurrency: "USD", createdBy: a.userId });
    });
    const warehouse = await inventory.createWarehouse(a, { code: "ARCHIVE", name: "Synthetic archive warehouse", type: "owned", countryCode: "CN", timeZone: "Asia/Shanghai" });
    const location = await inventory.createLocation(a, { warehouseId: warehouse.id, code: "ARCHIVE", name: "Synthetic archive location" });
    const stock = await inventory.createStockItem(a, { skuId: null, code: "ARCHIVE", name: "Synthetic archive blank", baseUnit: "each" });
    const draft = await procurement.createPurchaseOrder(a, { code: "ARCHIVE-PO", supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: new Date().toISOString(),
      lines: [{ lineKey: "L1", stockItemId: stock.id, destinationLocationId: location.id, quantity: 2, unit: "each", unitCostMinor: 100 }], idempotencyKey: randomUUID() });
    po = draft.id;
    await procurement.reviewPurchaseOrder(a, po, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() });
    await procurement.recordInvoice(a, po, { invoiceNumber: "SYNTHETIC-ARCHIVE", currency: "USD", issuedAt: new Date().toISOString(),
      lines: [{ lineKey: "L1", invoicedQuantity: 1, unitCostMinor: 999 }], idempotencyKey: randomUUID() });
  });
  afterAll(async () => { await db?.client.end(); }); // Disposable runner owns failure-safe DB/bucket teardown.
  const input = { archived: true, reason: "Remove synthetic acceptance data from daily work" };
  it("archives exact records idempotently, preserves business state, allows restore, and rejects other tenants", async () => {
    const operations = [
      { id: batch, table: creativeDesignBatches, run: (ctx: TenantContext, raw: unknown) => designs.archiveDesignBatch(ctx, batch, raw) },
      { id: project, table: productionEditorProjects, run: (ctx: TenantContext, raw: unknown) => editor.archive(ctx, project, raw) },
      { id: profile, table: printProfiles, run: (ctx: TenantContext, raw: unknown) => work.archiveProfile(ctx, profile, raw) },
      { id: po, table: inventoryPurchaseOrders, run: (ctx: TenantContext, raw: unknown) => procurement.archivePurchaseOrder(ctx, po, raw) },
    ];
    for (const op of operations) {
      const before = await withTenant(db.db, a, tx => tx.select().from(op.table).where(eq(op.table.id, op.id)));
      await expect(op.run(b, input)).rejects.toThrow("不存在");
      await expect(op.run({ ...a, permissions: [] }, input)).rejects.toThrow();
      await expect(op.run(a, { ...input, reason: "" })).rejects.toThrow();
      expect(await op.run(a, input)).toEqual({ id: op.id, archived: true });
      expect(await op.run(a, input)).toEqual({ id: op.id, archived: true });
      const after = await withTenant(db.db, a, tx => tx.select().from(op.table).where(eq(op.table.id, op.id)));
      expect(after[0]?.archivedAt).toBeInstanceOf(Date);
      expect({ ...after[0], archivedAt: null }).toEqual(before[0]);
      await op.run(a, { ...input, archived: false });
      expect(await withTenant(db.db, a, tx => tx.select().from(op.table).where(eq(op.table.id, op.id)))).toEqual(before);
      await op.run(a, input);
    }
    await expect(designs.archiveDesignBatch(a, running, input)).rejects.toThrow("请先取消");
    expect((await designs.listDesignBatches(a)).map(row => row.id)).toEqual([running]);
    const canvas = new CanvasBridgeService(db, undefined as never, audit, designs, new ClamAvProductionEditorScanner());
    expect((await canvas.list(a)).map(row => row.id)).toEqual([running]);
    expect((await canvas.projectSummaries(a)).map(row => row.id)).toEqual([running]);
    expect((await designs.getDesignBatch(a, batch)).status).toBe("completed");
    expect((await procurement.workspace(a)).purchaseOrders).toEqual([]);
  });
  it("excludes SPUs of archived plans from the rule directory and rejects new bindings", async () => {
    const planId = createEntityId(), spuId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(productPlans).values({ id: planId, tenantId: a.tenantId, name: "Synthetic archived plan", status: "archived", customization: { version: 1, fields: [] } });
      await tx.insert(spus).values({ id: spuId, tenantId: a.tenantId, productPlanId: planId, name: "Synthetic child", code: "ARCHIVED-CHILD", customization: { version: 1, fields: [] } });
    });
    const rules = new RuleCenterService(db, audit);
    expect((await rules.workspace(a)).spus).toEqual([]);
    await expect(rules.save(a, null, { expectedRevision: 0, idempotencyKey: randomUUID(), changeReason: "Synthetic binding", fields: {
      name: "Synthetic rule", category: "acceptance", instructions: "Synthetic instructions", source: "Synthetic fixture",
      appliesTo: "order_design", scopeKind: "spu", spuId, productType: null,
    } })).rejects.toThrow("已归档");
  });
  it("removes archived production outputs from choices without hiding a shared live output", async () => {
    const assetId = createEntityId();
    await withTenant(db.db, a, async tx => {
      await tx.insert(assetFiles).values({ id: assetId, tenantId: a.tenantId, objectKey: `synthetic/${assetId}`, fileName: "Synthetic production.png", mediaType: "image/png", assetDomain: "authorized", byteSize: 1, checksumSha256: "a".repeat(64), rightsStatus: "approved" });
    });
    const attach = async (archived: boolean) => withTenant(db.db, a, async tx => {
      const planId = createEntityId(), spuId = createEntityId(), skuId = createEntityId(), taskId = createEntityId(), versionId = createEntityId();
      await tx.insert(productPlans).values({ id: planId, tenantId: a.tenantId, name: "Synthetic output owner", status: archived ? "archived" : "developing", customization: { version: 1, fields: [] } });
      await tx.insert(spus).values({ id: spuId, tenantId: a.tenantId, productPlanId: planId, name: "Synthetic output owner", code: spuId, customization: { version: 1, fields: [] } });
      await tx.insert(skus).values({ id: skuId, tenantId: a.tenantId, spuId, code: skuId });
      await tx.insert(designTasks).values({ id: taskId, tenantId: a.tenantId, skuId, title: "Synthetic output", brief: "Synthetic test only" });
      await tx.insert(designVersions).values({ id: versionId, tenantId: a.tenantId, taskId, versionNumber: 1, status: "approved" });
      await tx.insert(designVersionFiles).values({ id: createEntityId(), tenantId: a.tenantId, versionId, assetFileId: assetId, role: "production" });
    });
    const visible = () => withTenant(db.db, a, tx => tx.select({ id: assetFiles.id }).from(assetFiles).where(activeCreativeAsset()));
    await attach(true); expect(await visible()).toEqual([]);
    await attach(false); expect(await visible()).toEqual([{ id: assetId }]);
    expect(await withTenant(db.db, b, tx => tx.select({ id: assetFiles.id }).from(assetFiles).where(activeCreativeAsset()))).toEqual([]);
  });
  async function tenant(): Promise<TenantContext> {
    const tenantId = createEntityId(), userId = createEntityId();
    await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic archive tenant',$2)", [tenantId, `archive-${tenantId}`]);
    await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic archive user')", [userId, `archive-${userId}`, `${userId}@example.test`]);
    const context: TenantContext = { tenantId, userId, dataScope: "tenant", permissions: Object.values(Permission) };
    await withTenant(db.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId, name: `Synthetic archive ${role}`, permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: member, roleId: role });
    });
    return context;
  }
});
