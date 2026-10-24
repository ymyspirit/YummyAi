import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SupplyTermsSchema, type SupplyTerms } from "@yummyai/contracts/catalog/product-supply";
import {
  connectDatabase, migrateDatabase, withTenant, productPlans, spus, skus, fulfillmentSuppliers,
  productSupplyLinks, productSupplyVersions, inventoryPurchaseOrders, inventoryPurchaseOrderVersions,
  memberships, membershipRoles, roles,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { ProductSupplyService } from "./product-supply.service.js";

describe.sequential("product supply relationships and pinned purchase quotes", () => {
  const database = connectDatabase();
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(),
    permissions: ["product:read", "product:write", "procurement:read", "procurement:write", "inventory:read", "inventory:write"], dataScope: "tenant" };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const plan = createEntityId(), secondPlan = createEntityId(), foreignPlan = createEntityId();
  const supplier = createEntityId(), secondSupplier = createEntityId(), foreignSupplier = createEntityId();
  const spu = createEntityId(), sku = createEntityId();
  const audit = new AuditService(database);
  const inventory = new InventoryService(database, audit);
  const supply = new ProductSupplyService(database, audit);
  const procurement = new ProcurementService(database, inventory, audit);
  let terms: SupplyTerms;
  let linkId: string, secondLinkId: string, location: string, foreignStock: string;
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const context of [a, b]) {
      await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3)", [context.tenantId, "Supply test", `supply-${context.tenantId}`]);
      await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4)", [context.userId, context.userId, `${context.userId}@example.test`, "Supply tester"]);
      await withTenant(database.db, context, async tx => {
        const member = createEntityId(), role = createEntityId();
        await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
        await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: `Synthetic supply ${role}`, permissions: context.permissions, dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
      });
    }
    await withTenant(database.db, a, async (tx) => {
      await tx.insert(productPlans).values([plan, secondPlan].map((id) => ({ id, tenantId: a.tenantId, name: `Product ${id}`, status: "approved", customization: { version: 1, fields: [] } })));
      await tx.insert(spus).values({ id: spu, tenantId: a.tenantId, productPlanId: plan, code: "SPU-1", name: "SKU parent", customization: { version: 1, fields: [] } });
      await tx.insert(skus).values({ id: sku, tenantId: a.tenantId, spuId: spu, code: "SKU-1", attributes: { size: "50x60" } });
      await tx.insert(fulfillmentSuppliers).values([supplier, secondSupplier].map((id) => ({ id, tenantId: a.tenantId, name: `Supplier ${id}`, kind: "manual", regionCode: "CN", settlementCurrency: "CNY", createdBy: a.userId })));
    });
    await withTenant(database.db, b, async (tx) => {
      await tx.insert(productPlans).values({ id: foreignPlan, tenantId: b.tenantId, name: "Private product", customization: { version: 1, fields: [] } });
      await tx.insert(fulfillmentSuppliers).values({ id: foreignSupplier, tenantId: b.tenantId, name: "Private supplier", kind: "manual", regionCode: "CN", settlementCurrency: "CNY", createdBy: b.userId });
    });
    const stock = await inventory.createStockItem(a, { code: "STOCK-1", name: "Custom blanket", baseUnit: "each", skuId: sku });
    const wh = await inventory.createWarehouse(a, { code: "WH-1", name: "Quality control warehouse", type: "owned", countryCode: "CN", timeZone: "Asia/Shanghai" });
    location = (await inventory.createLocation(a, { warehouseId: wh.id, code: "LOC-1", name: "Receiving" })).id;
    foreignStock = (await inventory.createStockItem(b, { code: "FOREIGN", name: "Private stock", skuId: null, baseUnit: "each" })).id;
    terms = SupplyTermsSchema.parse({ fulfillmentModes: ["custom_order", "fba_replenishment"], stockItemId: stock.id, unitCostMinor: 1250, currency: "CNY", minimumOrderQuantity: 5, leadTimeDays: 3,
      validFrom: new Date(Date.now() - 86400000).toISOString(), validUntil: new Date(Date.now() + 86400000).toISOString(), status: "active", preference: "primary", sampleStatus: "passed" });
  });
  afterAll(async () => { await database.client.end(); });

  it("supports multiple suppliers per product and multiple products per supplier, including pre-SKU products", async () => {
    const input = { productPlanId: plan, supplierId: supplier, skuId: sku, terms, idempotencyKey: createEntityId() };
    const first = await supply.create(a, input);
    linkId = first.id;
    expect(await supply.create(a, input)).toEqual(first);
    secondLinkId = (await supply.create(a, { ...input, supplierId: secondSupplier, terms: { ...terms, preference: "alternative" }, idempotencyKey: createEntityId() })).id;
    await supply.create(a, { ...input, productPlanId: secondPlan, skuId: null, terms: { ...terms, stockItemId: null }, idempotencyKey: createEntityId() });
    const workspace = await supply.workspace(a);
    expect(workspace.links.filter((link) => link.productPlanId === plan)).toHaveLength(2);
    expect(workspace.links.filter((link) => link.supplierId === supplier)).toHaveLength(2);
    expect(workspace.products.find((product) => product.id === plan)?.skus[0]?.code).toBe("SKU-1");
    expect(JSON.stringify(workspace)).not.toContain("tenantId");
    expect(JSON.stringify(workspace)).not.toContain("externalConnectionRef");
  });

  it("rejects duplicate relationships, mismatched SKUs, stock mappings, and a second primary supplier", async () => {
    const input = { productPlanId: plan, supplierId: supplier, skuId: sku, terms, idempotencyKey: createEntityId() };
    await expect(supply.create(a, input)).rejects.toThrow(ConflictException);
    await expect(supply.create(a, { ...input, productPlanId: secondPlan })).rejects.toThrow(NotFoundException);
    await expect(supply.create(a, { ...input, skuId: null })).rejects.toThrow(ConflictException);
    await expect(supply.revise(a, secondLinkId, { expectedVersion: 1, terms, idempotencyKey: createEntityId() })).rejects.toThrow("Primary supplier already exists");
  });

  it("enforces tenant isolation on reads, links, history, quote changes and procurement", async () => {
    expect((await supply.workspace(b)).links).toEqual([]);
    await expect(supply.history(b, linkId)).rejects.toThrow(NotFoundException);
    await expect(supply.revise(b, linkId, { expectedVersion: 1, terms, idempotencyKey: createEntityId() })).rejects.toThrow(NotFoundException);
    for (const override of [{ productPlanId: foreignPlan }, { supplierId: foreignSupplier }, { terms: { ...terms, stockItemId: foreignStock } }]) {
      await expect(supply.create(a, { productPlanId: plan, supplierId: supplier, skuId: sku, terms, idempotencyKey: createEntityId(), ...override })).rejects.toThrow(NotFoundException);
    }
    await expect(procurement.createPurchaseOrderFromSupply(b, linkId, purchaseInput())).rejects.toThrow(NotFoundException);
    const [role] = await withTenant(database.db, a, (tx) => tx.execute(sql`select current_user as role`));
    expect(role!.role).toBe("yummyai_app");
    await expect(withTenant(database.db, a, (tx) => tx.insert(productSupplyLinks).values({ id: createEntityId(), tenantId: b.tenantId, productPlanId: foreignPlan, supplierId: foreignSupplier }))).rejects.toThrow();
  });

  it("pins quote V1 and procurement purpose, preserves history and safely replays after a quote revision", async () => {
    const input = purchaseInput();
    const order = await procurement.createPurchaseOrderFromSupply(a, linkId, input);
    expect(order.totalMinor).toBe(6250);
    expect(order.purpose).toBe("fba_replenishment");
    expect(order.lines[0]?.unitCostMinor).toBe(1250);
    const history = await supply.history(a, linkId);
    expect(order.sourceSupplyVersionId).toBe(history[0]?.id);
    const revision = { expectedVersion: 1, terms: { ...terms, unitCostMinor: 1400 }, idempotencyKey: createEntityId() };
    await supply.revise(a, linkId, revision);
    expect((await supply.revise(a, linkId, revision)).currentVersion).toBe(2);
    await expect(supply.revise(a, linkId, { ...revision, terms, idempotencyKey: createEntityId() })).rejects.toThrow("version changed");
    await expect(supply.revise(a, linkId, { ...revision, terms })).rejects.toThrow("different input");
    expect((await supply.history(a, linkId)).map((version) => version.terms.unitCostMinor)).toEqual([1400, 1250]);
    expect(await procurement.createPurchaseOrderFromSupply(a, linkId, input)).toEqual(order);
    expect(await procurement.createPurchaseOrderFromSupply(a, linkId.toUpperCase(), { ...input, expectedAt: input.expectedAt.replace("Z", "0Z") })).toEqual(order);
    await expect(procurement.createPurchaseOrderFromSupply(a, linkId, { ...input, quantity: 10 })).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "procurement_request_mismatch" }) });
    const versions = await withTenant(database.db, a, (tx) => tx.select().from(inventoryPurchaseOrderVersions).where(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id)));
    expect(versions[0]?.lineSnapshot[0]?.unitCostMinor).toBe(1250);
    await expect(withTenant(database.db, a, (tx) => tx.update(productSupplyVersions).set({ terms }).where(eq(productSupplyVersions.linkId, linkId)))).rejects.toThrow();
    await expect(withTenant(database.db, a, (tx) => tx.update(productSupplyLinks).set({ supplierId: secondSupplier }).where(eq(productSupplyLinks.id, linkId)))).rejects.toThrow();
    await expect(withTenant(database.db, a, (tx) => tx.update(inventoryPurchaseOrders).set({ sourceSupplyVersionId: null }).where(eq(inventoryPurchaseOrders.id, order.id)))).rejects.toThrow();
  });

  it("uses database validity for a supply purchase when the caller process clock is ahead", async () => {
    const input = { ...purchaseInput(), expectedVersion: 2 };
    const [clock] = await withTenant(database.db, a, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const skew = vi.spyOn(Date, "now").mockReturnValue(new Date(clock!.now).getTime() + 2 * 86_400_000);
    try { expect((await procurement.createPurchaseOrderFromSupply(a, linkId, input)).lines[0]!.unitCostMinor).toBe(1400); }
    finally { skew.mockRestore(); }
  });

  it("blocks stale or unusable quotes, unsupported purposes, MOQ violations and inactive destinations", async () => {
    await expect(procurement.createPurchaseOrderFromSupply(a, linkId, purchaseInput())).rejects.toThrow("version changed");
    await expect(procurement.createPurchaseOrderFromSupply(a, linkId, { ...purchaseInput(), expectedVersion: 2, quantity: 1 })).rejects.toThrow("minimum order quantity");
    let version = 1;
    const alternatives: Array<Partial<SupplyTerms>> = [
      { unitCostMinor: null }, { stockItemId: null }, { status: "paused" }, { sampleStatus: "failed" },
      { validFrom: new Date(Date.now() - 172800000).toISOString(), validUntil: new Date(Date.now() - 86400000).toISOString() },
      { validFrom: new Date(Date.now() + 3600000).toISOString() }, { fulfillmentModes: ["custom_order"] },
    ];
    for (const override of alternatives) {
      await supply.revise(a, secondLinkId, { expectedVersion: version, terms: { ...terms, preference: "alternative", ...override }, idempotencyKey: createEntityId() });
      version += 1;
      await expect(procurement.createPurchaseOrderFromSupply(a, secondLinkId, { ...purchaseInput(), expectedVersion: version })).rejects.toThrow(ConflictException);
    }
    await withTenant(database.db, a, (tx) => tx.execute(sql`update inventory_locations set status = 'inactive' where id = ${location}`));
    await expect(procurement.createPurchaseOrderFromSupply(a, linkId, { ...purchaseInput(), expectedVersion: 2 })).rejects.toThrow(ConflictException);
  });

  it("serializes concurrent revisions so only one can replace the current quote", async () => {
    const results = await Promise.allSettled([1500, 1600].map((cost) => supply.revise(a, linkId, { expectedVersion: 2, terms: { ...terms, unitCostMinor: cost }, idempotencyKey: createEntityId() })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await supply.history(a, linkId)).map((version) => version.version)).toEqual([3, 2, 1]);
  });

  function purchaseInput() {
    return { expectedVersion: 1, purpose: "fba_replenishment" as const, code: `PO-${createEntityId()}`.toUpperCase(), destinationLocationId: location, quantity: 5, expectedAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: createEntityId() };
  }
});
