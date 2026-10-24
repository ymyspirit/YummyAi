import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CustomProductProfileV1Schema } from "@yummyai/contracts/catalog/custom-product-package";
import { connectDatabase, migrateDatabase, withTenant, productPlans, spus, skus, developmentEvents } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { ProductDevelopmentService } from "./product-development.service.js";
import { DrizzleCatalogRepository } from "./product.service.js";
import { CustomProductPackageService } from "./custom-product-package.service.js";

describe.sequential("SPU basic information updates", () => {
  const database = connectDatabase(), service = new ProductDevelopmentService(database, createStorageFromEnvironment());
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const b = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  let spuId: string;
  const read = async () => (await service.options(a)).spus.find(item => item.id === spuId)!;
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const context of [a, b]) {
      await database.client.unsafe("insert into organizations (id,name,slug) values ($1,'Synthetic SPU tenant',$2)", [context.tenantId, `spu-${context.tenantId}`]);
      await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Synthetic SPU user')", [context.userId, `spu-${context.userId}`, `${context.userId}@example.test`]);
    }
    const created = await service.createSpu(a, { code: "PET-PILLOW", name: "Pet pillow", description: "Original description", idempotencyKey: randomUUID() });
    spuId = created.spu.id;
    await service.createSpu(a, { code: "OTHER-PRODUCT", name: "Other", idempotencyKey: randomUUID() });
    await withTenant(database.db, a, async tx => {
      await tx.insert(skus).values({ id: createEntityId(), tenantId: a.tenantId, spuId, code: "ORIGINAL-SKU", attributes: { size: "10 inch" } });
      await tx.update(productPlans).set({ customProductProfile: CustomProductProfileV1Schema.parse({ schemaVersion: "1.0", sku: { value: "PET-PILLOW", source: "seller_provided", verificationStatus: "confirmed" }, updatedAt: new Date().toISOString() }) }).where(eq(productPlans.id, created.spu.productPlanId));
    });
  });
  afterAll(async () => { await database.client.end(); });

  it("renames the existing identity and parent, preserves SKU links, and retries idempotently", async () => {
    const before = await read();
    const input = { code: "CUSTOM-SHAPED-PILLOW", name: "定制异形抱枕", description: "人物、宠物及其他来图", expectedRevision: before.revision, idempotencyKey: randomUUID() };
    const [first, retry] = await Promise.all([service.updateSpu(a, spuId, input), service.updateSpu(a, spuId, input)]);
    expect(retry).toEqual(first);
    expect(first.spu).toMatchObject({ id: before.id, productPlanId: before.productPlanId, code: input.code, name: input.name, description: input.description });
    expect(first.spu.revision).not.toBe(before.revision);
    expect(first.previous).toMatchObject({ code: "PET-PILLOW", name: "Pet pillow" });
    const stored = await withTenant(database.db, a, async tx => ({
      children: await tx.select().from(skus).where(eq(skus.spuId, spuId)),
      parents: await tx.select().from(productPlans).where(eq(productPlans.id, before.productPlanId)),
      events: await tx.select().from(developmentEvents).where(eq(developmentEvents.idempotencyKey, input.idempotencyKey)),
    }));
    expect(stored.children).toHaveLength(1);
    expect(stored.children[0]).toMatchObject({ code: "ORIGINAL-SKU", spuId, attributes: { size: "10 inch" } });
    expect(stored.parents[0]).toMatchObject({ name: input.name, description: input.description, status: "developing", customization: { version: 1, fields: [] }, customProductProfile: { sku: { value: input.code } } });
    expect(stored.events).toHaveLength(1);
    await expect(service.updateSpu(a, spuId, { ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    // An unrelated/missing target is checked before any idempotent receipt.
    await expect(service.updateSpu(a, createEntityId(), input)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects duplicate codes, foreign tenants, absent permissions and concurrent stale changes", async () => {
    const current = await read();
    const input = { code: current.code, name: "Updated pillow", description: current.description, expectedRevision: current.revision, idempotencyKey: randomUUID() };
    await expect(service.updateSpu(a, spuId, { ...input, code: "other-product" })).rejects.toMatchObject({ status: 409 });
    await expect(service.updateSpu(b, spuId, input)).rejects.toMatchObject({ status: 404 });
    await expect(service.updateSpu({ ...a, permissions: [] }, spuId, input)).rejects.toThrow();
    const results = await Promise.allSettled([service.updateSpu(a, spuId, input), service.updateSpu(a, spuId, { ...input, name: "Stale update", idempotencyKey: randomUUID() })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await service.options(b)).spus).toHaveLength(0);
  });

  it("preserves every legacy SPU, rejects ambiguous parent writes, and keeps explicit child access", async () => {
    const created = await service.createSpu(a, { code: "LEGACY-A", name: "Original A", idempotencyKey: randomUUID() });
    const secondId = createEntityId(), planId = created.spu.productPlanId;
    // This privileged fixture represents the result of the forward legacy migration.
    await database.client.unsafe("update spus set legacy_plan_ambiguous=true where id=$1", [created.spu.id]);
    await database.client.unsafe("insert into spus(id,tenant_id,product_plan_id,code,name,customization,legacy_plan_ambiguous) select $1,tenant_id,product_plan_id,'LEGACY-B','Original B',customization,true from spus where id=$2", [secondId, created.spu.id]);
    await database.client.unsafe("update product_plans set status='researching' where id=$1", [planId]);
    const repository = new DrizzleCatalogRepository(database), before = (await repository.listPlans(a)).find(plan => plan.id === planId)!;
    expect(before.spu).toBeUndefined();
    expect(before.legacySpuCandidates?.map(row => row.id).sort()).toEqual([created.spu.id, secondId].sort());
    await expect(repository.setPlanStatus(a, planId, "pending_approval")).rejects.toMatchObject({ status: 409 });
    await expect(repository.updatePlanCustomization(a, planId, { version: 1, fields: [] })).rejects.toMatchObject({ status: 409 });
    await expect(repository.createSpu(a, before, { code: "LEGACY-C", name: "Must not create" })).rejects.toMatchObject({ status: 409 });
    const current = (await service.options(a)).spus.find(row => row.id === created.spu.id)!;
    await expect(service.updateSpu(a, current.id, { code: current.code, name: "Must not rename shared parent", description: "", expectedRevision: current.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    const profile = CustomProductProfileV1Schema.parse({ schemaVersion: "1.0", updatedAt: new Date().toISOString() });
    await expect(new CustomProductPackageService(database, createStorageFromEnvironment()).saveProfile(a, planId, { profile })).rejects.toMatchObject({ status: 409 });
    const child = await repository.createSku(a, { spuId: secondId, code: "EXPLICIT-LEGACY-B-SKU", attributes: {} });
    expect(child.spuId).toBe(secondId);
    expect((await repository.getPlan(a, planId))?.name).toBe("Original A");
    await expect(withTenant(database.db, a, tx => tx.insert(spus).values({ id: createEntityId(), tenantId: a.tenantId, productPlanId: planId, code: "LEGACY-C", name: "Forbidden default", customization: { version: 1, fields: [] } }))).rejects.toThrow();
    await expect(withTenant(database.db, a, tx => tx.update(spus).set({ legacyPlanAmbiguous: false }).where(eq(spus.id, secondId)))).rejects.toThrow();
    expect((await repository.listPlans(b)).some(plan => plan.id === planId)).toBe(false);
  });

  it("does not modify archived products", async () => {
    const current = await read();
    await withTenant(database.db, a, tx => tx.update(spus).set({ status: "archived" }).where(eq(spus.id, spuId)));
    expect((await service.options(a)).spus.some(item => item.id === spuId)).toBe(false);
    await expect(service.updateSpu(a, spuId, { code: current.code, name: current.name, description: current.description, expectedRevision: current.revision, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
  });
});
