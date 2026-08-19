import { Permission } from "@yummyai/authz";
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
  const repository = new DrizzleDesignRepository(database, storage);
  const service = new DesignService(repository);
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

  it("checks order PII permission before mutating order-private design versions", async () => {
    const task = await service.createTask(first, {
      skuId: firstSkuId,
      title: "Private customer render",
      brief: "Review an order-scoped composite without exposing customer content",
    });
    const assetId = await createOrderAsset(first, "c");
    const piiContext: TenantContext = { ...first, permissions: [Permission.OrderPiiRead] };

    await expect(service.approveAssetRights(piiContext, assetId, {
      kind: "customer_provided",
      reference: `order-customization:${createEntityId()}`,
    })).rejects.toMatchObject({ status: 409 });
    await expect(repository.createVersion(first, task.id, { files: [{ assetId, role: "effect" }] })).rejects.toThrow();
    await expect(repository.listVersions(piiContext, task.id)).resolves.toHaveLength(0);

    const version = await repository.createVersion(piiContext, task.id, { files: [{ assetId, role: "effect" }] });
    await expect(service.reviewVersion(first, version.id, { decision: "approve" })).rejects.toThrow();
    await expect(service.reviewVersion(piiContext, version.id, { decision: "approve" })).resolves.toMatchObject({ status: "approved" });

    await expect(repository.setPrimaryVersion(first, task.id, version.id)).rejects.toThrow();
    await expect(repository.getTask(first, task.id)).resolves.toMatchObject({ primaryVersionId: undefined });
    await expect(repository.setPrimaryVersion(piiContext, task.id, version.id)).resolves.toMatchObject({ primaryVersionId: version.id });
    await expect(service.signVersionFile(first, version.id, version.files[0]!.id)).rejects.toThrow();
    await expect(service.signVersionFile(piiContext, version.id, version.files[0]!.id)).resolves.toMatchObject({ url: expect.stringContaining("signed.example") });
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

  async function createOrderAsset(context: TenantContext, checksumCharacter: string) {
    const id = createEntityId();
    await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({
      id, tenantId: context.tenantId, ownerUserId: context.userId,
      objectKey: `tenants/${context.tenantId}/order/${checksumCharacter.repeat(64)}/customer-render.png`,
      assetDomain: "order", fileName: "customer-render.png", mediaType: "image/png", byteSize: 1200,
      checksumSha256: checksumCharacter.repeat(64), rightsStatus: "approved",
      rightsMetadata: {
        source: { kind: "customer_provided", reference: createEntityId() },
        approvedAt: new Date().toISOString(),
      },
    }));
    return id;
  }
});

function tenant(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, permissions: [], dataScope: "tenant" };
}
