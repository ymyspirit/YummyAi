import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { type SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import { connectDatabase, migrateDatabase, withTenant, assetFiles } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { and, eq, isNull, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { ProductService, DrizzleCatalogRepository } from "./product.service.js";
import { SalesPlanService } from "./sales-plan.service.js";

describe.sequential("SPU-first sales plans and tenant-backed draft handoff", () => {
  const db = connectDatabase(),
    catalog = new ProductDevelopmentService(db, createStorageFromEnvironment());
  const a: TenantContext = {
    tenantId: createEntityId(),
    userId: createEntityId(),
    permissions: Object.values(Permission),
    dataScope: "tenant",
  };
  const b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const listing = new ListingService(new DrizzleListingRepository(db)),
    service = new SalesPlanService(db, listing);
  const products = new ProductService(new DrizzleCatalogRepository(db));
  const planIds: string[] = [],
    listingIds: string[] = [],
    productIds: string[] = [];
  const assets: Array<{ id: string; tenant: TenantContext }> = [];
  const artworks: Array<{ id: string; version: number }> = [];
  const directory = new URL("../../../../tmp/sales-plans/", import.meta.url),
    manifest = new URL(`integration-${a.tenantId}.json`, directory);
  let spuId: string,
    custom: SalesPlanView,
    standard: SalesPlanView,
    draftId: string,
    versionId: string;
  const record = (cleanup = "pending") => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      manifest,
      JSON.stringify(
        {
          tenantId: a.tenantId,
          userId: a.userId,
          productIds,
          planIds,
          listingIds,
          assets: assets.map(({ id, tenant }) => ({ id, tenantId: tenant.tenantId })),
          artworks,
          cleanup,
          retainedHistory:
            "archived business records, immutable development events and listing versions",
        },
        null,
        2,
      ),
    );
  };
  beforeAll(async () => {
    await migrateDatabase(db);
    for (const context of [a, b]) {
      // Identity bootstrap only; business reads and writes below always use withTenant and yummyai_app.
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Sales plan fixture',$2)",
        [context.tenantId, `sales-plan-${context.tenantId}`],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Sales plan fixture')",
        [context.userId, context.userId, `${context.userId}@example.test`],
      );
    }
    const created = await catalog.createSpu(a, {
      code: `PLAN-${a.tenantId.slice(-8)}`,
      name: "共享商品 SPU",
      capabilities: {
        processes: "热转印",
        customizationScope: "照片、文字、固定印花",
        packaging: "待核实",
      },
      idempotencyKey: randomUUID(),
    });
    spuId = created.spu.id;
    productIds.push(created.spu.productPlanId);
    record();
  }, 60000);
  afterAll(async () => {
    const errors: unknown[] = [];
    for (const artwork of artworks)
      try {
        await catalog.archiveArtwork(a, artwork.id, {
          archived: true,
          expectedVersion: artwork.version,
          reason: "Synthetic sales-plan fixture cleanup",
          idempotencyKey: randomUUID(),
        });
      } catch (error) {
        errors.push(error);
      }
    for (const { id, tenant } of assets)
      try {
        // No storage object was created: remove only these synthetic rejection-test rows from active reads.
        await withTenant(db.db, tenant, (tx) =>
          tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, id)),
        );
        expect(
          await withTenant(db.db, tenant, (tx) =>
            tx
              .select()
              .from(assetFiles)
              .where(and(eq(assetFiles.id, id), isNull(assetFiles.deletedAt))),
          ),
        ).toHaveLength(0);
      } catch (error) {
        errors.push(error);
      }
    for (const id of listingIds)
      try {
        await listing.archive(a, id);
      } catch (error) {
        errors.push(error);
      }
    for (const id of planIds)
      try {
        const { plan } = await service.get(a, id);
        if (!plan.archived)
          await service.archive(a, id, {
            expectedRevision: plan.revision,
            idempotencyKey: randomUUID(),
          });
      } catch (error) {
        errors.push(error);
      }
    for (const id of productIds)
      try {
        await products.transition(a, id, "archived");
      } catch (error) {
        errors.push(error);
      }
    try {
      expect((await service.list(a, {})).total).toBe(0);
      expect((await catalog.options(a)).spus).toHaveLength(0);
      expect((await service.options(a)).artworks).toHaveLength(0);
    } catch (error) {
      errors.push(error);
    }
    record(errors.length ? "incomplete" : "verified-active-lists-clear");
    await db.client.end();
    if (errors.length) throw new AggregateError(errors, "Sales plan fixture cleanup failed");
  }, 60000);

  it("uses the non-owner role, scopes options by permissions and keeps Custom/standard plans independent", async () => {
    const role = await withTenant(db.db, a, (tx) => tx.execute(sql`select current_user as role`));
    expect(role[0]?.role).toBe("yummyai_app");
    for (const [mode, fulfillment] of [
      ["custom", "fbm"],
      ["standard", "fba"],
    ]) {
      const result = await service.create(a, {
        spuId,
        fields: { name: mode === "custom" ? "宠物纪念来图" : "固定猫咪印花", mode, fulfillment },
        idempotencyKey: randomUUID(),
      });
      planIds.push(result.plan.id);
      record();
      if (mode === "custom") custom = result.plan;
      else standard = result.plan;
    }
    expect((await service.list(a, { spuId })).total).toBe(2);
    expect(custom.id).not.toBe(standard.id);
    expect(custom.spuId).toBe(standard.spuId);
    const options = await service.options({ ...a, permissions: [Permission.ProductRead] });
    expect(options.spus[0]?.capabilities?.processes).toBe("热转印");
    expect(options.assets).toEqual([]);
    expect(options.researchItems).toEqual([]);
    expect(options.projects).toEqual([]);
    expect(options.accounts).toEqual([]);
    expect((await service.list(b, {})).total).toBe(0);
    await expect(service.get(b, custom.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.save(b, custom.id, {
        fields: custom.fields,
        expectedRevision: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it("replays creation safely, rejects Custom FBA and preserves drafts after revision conflicts", async () => {
    const input = {
      spuId,
      fields: { name: "标品 FBM", mode: "standard", fulfillment: "fbm" },
      idempotencyKey: randomUUID(),
    };
    const created = await service.create(a, input);
    planIds.push(created.plan.id);
    record();
    expect((await service.create(a, input)).plan.id).toBe(created.plan.id);
    await expect(
      service.create(a, {
        ...input,
        fields: { ...input.fields, mode: "custom", fulfillment: "fba" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
    const updated = await service.save(a, custom.id, {
      expectedRevision: custom.revision,
      fields: {
        ...custom.fields,
        audience: "宠物主人",
        scenario: "纪念赠礼",
        researchConclusion: "合成测试结论",
      },
      idempotencyKey: randomUUID(),
    });
    await expect(
      service.save(a, custom.id, {
        expectedRevision: custom.revision,
        fields: { ...custom.fields, audience: "stale overwrite" },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    custom = updated.plan;
    expect((await service.get(a, standard.id)).plan.fields.audience).toBe("");
    expect((await service.get(a, custom.id)).plan.fields.audience).toBe("宠物主人");
  });
  it("creates incomplete Listing drafts for both sales modes without requiring approved production files", async () => {
    for (const plan of [custom, standard]) {
      const input = { expectedRevision: plan.revision, idempotencyKey: randomUUID() };
      const result = await service.draft(a, plan.id, input);
      listingIds.push(result.listingId);
      record();
      expect(await service.draft(a, plan.id, input)).toEqual(result);
      const detail = await listing.getWorkspace(a, result.listingId);
      expect(detail.listing.status).toBe("draft");
      expect(detail.listing.salesPlanId).toBe(plan.id);
      expect(detail.version.validation.blockers.length).toBeGreaterThan(0);
      if (plan.id === custom.id) {
        draftId = result.listingId;
        versionId = result.listingVersionId;
      }
    }
    await expect(
      service.save(a, custom.id, {
        fields: { ...custom.fields, mode: "standard", fulfillment: "fba" },
        expectedRevision: custom.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("synchronizes to a new immutable draft version and rejects a stale Listing version", async () => {
    const initial = await listing.getWorkspace(a, draftId);
    const edited = await listing.saveVersion(
      a,
      draftId,
      {
        ...initial.version.content,
        attributes: { ...initial.version.content.attributes, brand: "Synthetic Brand" },
        compliance: { origin: "Synthetic origin" },
        publication: {
          platform: "amazon",
          productType: "PILLOW",
          attributes: { country_of_origin: [{ value: "CN" }] },
        },
      },
      "human",
      versionId,
    );
    const firstVersionId = versionId;
    versionId = edited.id;
    custom = (
      await service.save(a, custom.id, {
        fields: { ...custom.fields, title: "Synthetic personalized pillow draft" },
        expectedRevision: custom.revision,
        idempotencyKey: randomUUID(),
      })
    ).plan;
    const next = await service.draft(a, custom.id, {
      expectedRevision: custom.revision,
      expectedListingVersionId: versionId,
      idempotencyKey: randomUUID(),
    });
    expect(next.listingId).toBe(draftId);
    expect(next.listingVersionId).not.toBe(versionId);
    const versions = await listing.listVersions(a, draftId);
    expect(versions).toHaveLength(3);
    expect(versions.find((version) => version.id === firstVersionId)?.content.title).toBe("");
    const current = await listing.getWorkspace(a, draftId);
    expect(current.version.content.attributes.brand).toBe("Synthetic Brand");
    expect(current.version.content.compliance.origin).toBe("Synthetic origin");
    expect(current.version.content.publication).toEqual(edited.content.publication);
    expect(current.version.content.title).toBe("Synthetic personalized pillow draft");
    await expect(
      service.draft(a, custom.id, {
        expectedRevision: custom.revision,
        expectedListingVersionId: versionId,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
  it("keeps personalized print templates out of standard/FBA plans", async () => {
    const { artwork } = await catalog.registerArtwork(a, {
      code: `PLAN-CUSTOM-${a.tenantId.slice(-8)}`,
      name: "Synthetic personalized print",
      mode: "personalized_text",
      customization: {
        version: 1,
        fields: [{ key: "name", type: "short_text", label: "Name", required: true }],
      },
      instructions: "Synthetic customer text template",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    artworks.push({ id: artwork.id, version: artwork.version });
    record();
    await expect(
      service.save(a, standard.id, {
        fields: { ...standard.fields, artworkVersionIds: [artwork.versionId] },
        expectedRevision: standard.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    custom = (
      await service.save(a, custom.id, {
        fields: { ...custom.fields, artworkVersionIds: [artwork.versionId] },
        expectedRevision: custom.revision,
        idempotencyKey: randomUUID(),
      })
    ).plan;
    expect(custom.fields.artworkVersionIds).toEqual([artwork.versionId]);
  });
  it("rejects research-domain and cross-tenant asset promotion and keeps archive history out of daily counts", async () => {
    for (const tenant of [a, b]) {
      const assetId = createEntityId();
      await withTenant(db.db, tenant, (tx) =>
        tx.insert(assetFiles).values({
          id: assetId,
          tenantId: tenant.tenantId,
          ownerUserId: tenant.userId,
          objectKey: `tenants/${tenant.tenantId}/${tenant === a ? "research" : "authorized"}/sales-plan-${assetId}.png`,
          assetDomain: tenant === a ? "research" : "authorized",
          fileName: "Synthetic research reference.png",
          mediaType: "image/png",
          byteSize: 1,
          checksumSha256: "1".repeat(64),
          rightsStatus: "approved",
        }),
      );
      assets.push({ id: assetId, tenant });
      record();
      await expect(
        service.save(a, custom.id, {
          fields: { ...custom.fields, mediaAssetIds: [assetId], mainImageId: assetId },
          expectedRevision: custom.revision,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
    }
    const hidden = await service.get({ ...a, permissions: [Permission.ProductRead] }, custom.id);
    expect(hidden.listingAccess).toBe(false);
    expect(hidden.listings).toEqual([]);
    await listing.archive(a, draftId);
    const query = {
      q: "",
      completeness: "all",
      blockers: "all",
      sort: "updatedAt",
      direction: "desc",
      page: 1,
      limit: 25,
    } as const;
    expect((await listing.catalog(a, query)).items.some((item) => item.id === draftId)).toBe(false);
    expect(
      (await listing.catalog(a, { ...query, status: "archived" })).items.some(
        (item) => item.id === draftId,
      ),
    ).toBe(true);
    await service.archive(a, standard.id, {
      expectedRevision: standard.revision,
      idempotencyKey: randomUUID(),
    });
    expect((await service.list(a, { q: "固定猫咪" })).total).toBe(0);
    expect((await service.list(a, { q: "固定猫咪", archived: "1" })).total).toBe(1);
  });
});
