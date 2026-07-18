import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";

describe("design assets database", () => {
  const database = connectDatabase();
  const storage = {
    signRead: async () => "https://signed.example/authorized?X-Amz-Expires=600",
    promoteToAuthorized: async () => { throw new Error("not used in this test"); },
  } as unknown as Storage;
  const service = new DesignService(new DrizzleDesignRepository(database, storage));
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);
  let firstSkuId: string;
  let secondSkuId: string;
  let firstAssetId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Design A', $2), ($3, 'Design B', $4)`,
      [first.tenantId, `design-${first.tenantId}`, second.tenantId, `design-${second.tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Design User')`,
      [userId, `design-${userId}`, `${userId}@example.test`],
    );
    firstSkuId = await createSku(first, "DES-A", "DESIGN-A-SKU");
    secondSkuId = await createSku(second, "DES-B", "DESIGN-B-SKU");
    firstAssetId = await createAuthorizedAsset(first, "a");
  });

  afterAll(async () => { await database.client.end(); });

  it("keeps approved versions immutable and isolates tenant tasks", async () => {
    const firstTask = await service.createTask(first, { skuId: firstSkuId, title: "Production artwork", brief: "Prepare print-ready effect and production files" });
    await service.createTask(second, { skuId: secondSkuId, title: "Other tenant", brief: "Must remain isolated" });
    const approved = await service.uploadVersion(first, firstTask.id, { files: [{ assetId: firstAssetId, role: "production" }] });
    await service.reviewVersion(first, approved.id, { decision: "approve" });

    await expect(withTenant(database.db, first, (tx) => tx.update(assetFiles).set({ fileName: "still-allowed.png" }).where(eq(assetFiles.id, firstAssetId)))).resolves.toBeDefined();
    await expect(database.client.unsafe(`update design_versions set change_note = 'overwrite' where id = $1`, [approved.id]))
      .rejects.toMatchObject({ code: "55000" });

    const next = await service.uploadVersion(first, firstTask.id, { changeNote: "Second proof", files: [{ assetId: firstAssetId, role: "production" }] });
    expect(next.id).not.toBe(approved.id);
    expect(next.versionNumber).toBe(2);
    expect(next.status).toBe("pending_review");
    await expect(service.listTasks(first)).resolves.toHaveLength(1);
    await expect(service.listTasks(second)).resolves.toHaveLength(1);
    await expect(service.signVersionFile(first, next.id, next.files[0]!.id)).resolves.toMatchObject({ url: expect.stringContaining("signed.example") });
  });

  async function createSku(context: TenantContext, planName: string, skuCode: string) {
    const plan = await catalog.createPlan(context, { name: planName, sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(context, plan.id, "pending_approval");
    await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `${skuCode}-SPU`, name: planName });
    return (await catalog.createSku(context, { spuId: spu.id, code: skuCode, attributes: {} })).id;
  }

  async function createAuthorizedAsset(context: TenantContext, checksumCharacter: string) {
    const id = createEntityId();
    await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({
      id, tenantId: context.tenantId, ownerUserId: context.userId,
      objectKey: `tenants/${context.tenantId}/authorized/${checksumCharacter.repeat(64)}/proof.png`,
      assetDomain: "authorized", fileName: "proof.png", mediaType: "image/png", byteSize: 1200,
      checksumSha256: checksumCharacter.repeat(64), rightsStatus: "approved",
      rightsMetadata: { source: { kind: "owned", reference: "internal design" }, approvedAt: new Date().toISOString() },
    }));
    return id;
  }
});

function tenant(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, permissions: [], dataScope: "tenant" };
}
