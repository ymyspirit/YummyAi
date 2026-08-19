import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CustomProductProfileV1 } from "@yummyai/contracts/catalog/custom-product-package";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { inspectCustomProductPackage, type Storage } from "@yummyai/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CustomProductPackageService } from "./custom-product-package.service.js";
import { DrizzleCatalogRepository, ProductService } from "./product.service.js";

describe("catalog database", () => {
  const database = connectDatabase();
  const service = new ProductService(new DrizzleCatalogRepository(database));
  const packageService = new CustomProductPackageService(database, {
    readPrivate: async () => new Uint8Array(),
  } as unknown as Storage);
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
    const firstSku = await service.createSku(first, {
      spuId: firstSpu.id,
      code: "MUG-BLK-11",
      attributes: {},
      unitCost: { amount: 8, currency: "USD" },
    });
    await expect(
      service.createSku(first, { spuId: firstSpu.id, code: "MUG-BLK-11", attributes: {} }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.createSku(second, { spuId: secondSpu.id, code: "MUG-BLK-11", attributes: {} }),
    ).resolves.toMatchObject({ code: "MUG-BLK-11" });
    const designTaskId = createEntityId();
    const listingId = createEntityId();
    await database.client.unsafe(
      `insert into design_tasks (id,tenant_id,sku_id,title,brief,status,created_by) values ($1,$2,$3,'Mug proof','Prepare production proof','open',$4)`,
      [designTaskId, first.tenantId, firstSku.id, userId],
    );
    await database.client.unsafe(
      `insert into listings (id,tenant_id,spu_id,platform,marketplace_id,locale,status,created_by) values ($1,$2,$3,'amazon','ATVPDKIKX0DER','en-US','draft',$4)`,
      [listingId, first.tenantId, firstSpu.id, userId],
    );
    const firstPlans = await service.listPlans(first);
    expect(firstPlans).toHaveLength(1);
    expect(firstPlans[0]).toMatchObject({
      ownerName: "Catalog User",
      ownerUserId: userId,
      spu: {
        id: firstSpu.id,
        code: "SPU-A",
        skus: [
          {
            id: firstSku.id,
            code: "MUG-BLK-11",
            attributes: {},
            unitCost: { amount: 8, currency: "USD" },
          },
        ],
      },
      designTasks: [
        { id: designTaskId, skuCode: "MUG-BLK-11", title: "Mug proof", status: "open" },
      ],
      listings: [
        {
          id: listingId,
          platform: "amazon",
          marketplaceId: "ATVPDKIKX0DER",
          locale: "en-US",
          status: "draft",
        },
      ],
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

  it("persists customization through the tenant-scoped repository boundary", async () => {
    const plan = await service.createPlan(first, {
      name: "Custom photo topper",
      sourceReportIds: [],
      customization: { version: 1, fields: [] },
    });
    const customization = {
      version: 1,
      fields: [
        {
          key: "photo_upload",
          label: "Upload your photo",
          required: true,
          type: "image" as const,
          validation: {
            allowedMediaTypes: ["image/png" as const, "image/jpeg" as const],
            maxBytes: 10_000_000,
            maxFiles: 1,
          },
        },
      ],
    };

    await expect(
      service.updateCustomization(first, plan.id, { customization }),
    ).resolves.toMatchObject({ customization });
    await expect(
      service.updateCustomization(second, plan.id, { customization }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.listPlans(first)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: plan.id, customization })]),
    );
  });

  it("persists a tenant-scoped Amazon Custom profile and exports an inspectable draft ZIP", async () => {
    const plan = await service.createPlan(first, {
      name: "Vintage photo cake topper",
      sourceReportIds: [createEntityId()],
      customization: {
        version: 1,
        fields: [
          {
            key: "photo_upload",
            label: "Upload your photo",
            required: true,
            type: "image",
            validation: {
              allowedMediaTypes: ["image/png", "image/jpeg"],
              maxBytes: 10_000_000,
              maxFiles: 1,
            },
          },
        ],
      },
    });
    const profile = customProfile();

    await expect(packageService.saveProfile(first, plan.id, { profile })).resolves.toMatchObject({
      planId: plan.id,
      profile,
    });
    await expect(packageService.saveProfile(second, plan.id, { profile })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.listPlans(first)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: plan.id, customProductProfile: profile }),
      ]),
    );

    await service.transition(first, plan.id, "pending_approval");
    await service.transition(first, plan.id, "approved");
    await service.createSpu(first, plan.id, { code: "TOPPER", name: "Vintage photo cake topper" });
    const developingProfile = {
      ...profile,
      assetAssignments: [
        {
          assetId: createEntityId(),
          role: "style_reference" as const,
        },
      ],
      updatedAt: "2026-07-31T01:00:00.000Z",
    };
    await expect(
      packageService.saveProfile(first, plan.id, { profile: developingProfile }),
    ).resolves.toMatchObject({ planId: plan.id, profile: developingProfile });

    const exported = await packageService.export(first, plan.id, "draft");
    const inspected = await inspectCustomProductPackage(exported.bytes);
    expect(inspected.manifest).toMatchObject({
      mode: "draft",
      planId: plan.id,
      tenantId: first.tenantId,
    });
    expect(inspected.product.profile.sku?.value).toBe("TOPPER-DRAFT-001");
    expect(inspected.completeness.status).toBe("blocked");
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
  return { tenantId, userId, permissions: [Permission.AssetRead], dataScope: "tenant" };
}

function customProfile(): CustomProductProfileV1 {
  const fact = (value: string) => ({
    value,
    source: "competitor_reference" as const,
    verificationStatus: "unverified" as const,
  });
  return {
    schemaVersion: "1.0",
    sku: fact("TOPPER-DRAFT-001"),
    targetMarketplace: fact("amazon.com"),
    productType: fact("Cake Toppers"),
    materials: [fact("3mm wood and acrylic")],
    colors: [],
    sizeOptions: [fact('6"x6"')],
    packageContents: [],
    targetAudiences: [],
    sellingPoints: [],
    surfaces: [
      {
        key: "front",
        label: "Front",
        fieldKeys: ["photo_upload"],
        source: "inferred_from_research",
        verificationStatus: "unverified",
      },
    ],
    approvedClaims: [],
    prohibitedClaims: [],
    prohibitedElements: [],
    researchItemIds: [],
    assetAssignments: [],
    updatedAt: "2026-07-31T00:00:00.000Z",
  };
}
