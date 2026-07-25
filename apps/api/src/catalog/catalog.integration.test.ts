import { ConflictException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleCatalogRepository, ProductService } from "./product.service.js";

describe("catalog database", () => {
  const database = connectDatabase();
  const service = new ProductService(new DrizzleCatalogRepository(database));
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Catalog A', $2), ($3, 'Catalog B', $4)`,
      [first.tenantId, `catalog-${first.tenantId}`, second.tenantId, `catalog-${second.tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Catalog User')`,
      [userId, `catalog-${userId}`, `${userId}@example.test`],
    );
    await database.client.unsafe(
      `insert into memberships (id, tenant_id, user_id, status) values ($1, $2, $3, 'active'), ($4, $5, $3, 'active')`,
      [createEntityId(), first.tenantId, userId, createEntityId(), second.tenantId],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("enforces tenant-scoped SKU uniqueness through RLS and database constraints", async () => {
    const firstSpu = await createApprovedSpu(first, "PLAN-A", "SPU-A");
    const secondSpu = await createApprovedSpu(second, "PLAN-B", "SPU-B");
    const firstSku = await service.createSku(first, { spuId: firstSpu.id, code: "MUG-BLK-11", attributes: {}, unitCost: { amount: 8, currency: "USD" } });
    await expect(service.createSku(first, { spuId: firstSpu.id, code: "MUG-BLK-11", attributes: {} })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.createSku(second, { spuId: secondSpu.id, code: "MUG-BLK-11", attributes: {} })).resolves.toMatchObject({ code: "MUG-BLK-11" });
    const designTaskId = createEntityId(); const listingId = createEntityId();
    await database.client.unsafe(`insert into design_tasks (id,tenant_id,sku_id,title,brief,status,created_by) values ($1,$2,$3,'Mug proof','Prepare production proof','open',$4)`, [designTaskId, first.tenantId, firstSku.id, userId]);
    await database.client.unsafe(`insert into listings (id,tenant_id,spu_id,platform,marketplace_id,locale,status,created_by) values ($1,$2,$3,'amazon','ATVPDKIKX0DER','en-US','draft',$4)`, [listingId, first.tenantId, firstSpu.id, userId]);
    const firstPlans = await service.listPlans(first);
    expect(firstPlans).toHaveLength(1);
    expect(firstPlans[0]).toMatchObject({
      ownerName: "Catalog User",
      ownerUserId: userId,
      spu: {
        id: firstSpu.id,
        code: "SPU-A",
        skus: [{ id: firstSku.id, code: "MUG-BLK-11", attributes: {}, unitCost: { amount: 8, currency: "USD" } }],
      },
      designTasks: [{ id: designTaskId, skuCode: "MUG-BLK-11", title: "Mug proof", status: "open" }],
      listings: [{ id: listingId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "draft" }],
    });
    expect(firstPlans[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(firstPlans[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const secondPlans = await service.listPlans(second);
    expect(secondPlans).toHaveLength(1);
    expect(secondPlans[0]?.spu?.code).toBe("SPU-B");
    expect(secondPlans[0]?.spu?.skus).toHaveLength(1);
    expect(secondPlans[0]?.designTasks).toEqual([]);
    expect(secondPlans[0]?.listings).toEqual([]);
    expect(secondPlans.some((plan) => plan.spu?.code === "SPU-A")).toBe(false);
  });

  async function createApprovedSpu(context: TenantContext, planName: string, code: string) {
    const plan = await service.createPlan(context, {
      name: planName,
      sourceReportIds: [createEntityId()],
      customization: { version: 1, fields: [] },
    });
    await service.transition(context, plan.id, "pending_approval");
    await service.transition(context, plan.id, "approved");
    return service.createSpu(context, plan.id, { code, name: code });
  }
});

function tenant(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, permissions: [], dataScope: "tenant" };
}
