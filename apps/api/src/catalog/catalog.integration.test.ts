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
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("enforces tenant-scoped SKU uniqueness through RLS and database constraints", async () => {
    const firstSpu = await createApprovedSpu(first, "PLAN-A", "SPU-A");
    const secondSpu = await createApprovedSpu(second, "PLAN-B", "SPU-B");
    await service.createSku(first, { spuId: firstSpu.id, code: "MUG-BLK-11", attributes: {}, unitCost: { amount: 8, currency: "USD" } });
    await expect(service.createSku(first, { spuId: firstSpu.id, code: "MUG-BLK-11", attributes: {} })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.createSku(second, { spuId: secondSpu.id, code: "MUG-BLK-11", attributes: {} })).resolves.toMatchObject({ code: "MUG-BLK-11" });
    await expect(service.listPlans(first)).resolves.toHaveLength(1);
    await expect(service.listPlans(second)).resolves.toHaveLength(1);
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
