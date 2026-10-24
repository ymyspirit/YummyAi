import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  assetFiles,
  salesPackageVersions,
  developmentEvents,
  memberships,
  roles,
  membershipRoles,
  skus,
  productStyles,
  salesSkuDefinitions,
  salesRecipeVersions,
} from "@yummyai/database";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { SalesPackageService } from "./sales-package.service.js";
import { SalesPlanDeliveryService } from "./sales-plan-delivery.service.js";
import { fingerprint } from "./development-data.js";

describe.sequential("original sales package history and verified file reconstruction", () => {
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(
      new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname,
    )
  )
    throw Error("Disposable history runner required");
  const db = connectDatabase(),
    storage = createStorageFromEnvironment(),
    listing = new ListingService(new DrizzleListingRepository(db)),
    catalog = new ProductDevelopmentService(db, storage),
    plans = new SalesPlanService(db, listing),
    packages = new SalesPackageService(db, listing, storage),
    delivery = new SalesPlanDeliveryService(db, packages);
  const a: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    },
    other: TenantContext = { ...a, userId: createEntityId() },
    b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  let scopedReader: TenantContext;
  let planId: string,
    otherPlan: string,
    packageId: string,
    assetId: string,
    originalSnapshot: Record<string, unknown>,
    originalChecksum: string;
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aU3sAAAAASUVORK5CYII=",
    "base64",
  );
  beforeAll(async () => {
    await migrateDatabase(db);
    await storage.ensureBucket();
    for (const c of [a, other, b]) {
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Synthetic package history',$2) on conflict do nothing",
        [c.tenantId, "package-history-" + c.tenantId],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic history actor')",
        [c.userId, c.userId, c.userId + "@example.test"],
      );
    }
    const member = createEntityId(),
      readRole = createEntityId(),
      designRole = createEntityId();
    await withTenant(db.db, a, async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: member, tenantId: a.tenantId, userId: other.userId, status: "active" });
      await tx.insert(roles).values([
        {
          id: readRole,
          tenantId: a.tenantId,
          name: "Synthetic history read " + readRole,
          permissions: [Permission.ProductRead, Permission.ListingRead, Permission.AssetRead],
          dataScope: "tenant",
        },
        {
          id: designRole,
          tenantId: a.tenantId,
          name: "Synthetic history private design " + designRole,
          permissions: [Permission.DesignRead],
          dataScope: "self",
        },
      ]);
      await tx.insert(membershipRoles).values([
        { tenantId: a.tenantId, membershipId: member, roleId: readRole },
        { tenantId: a.tenantId, membershipId: member, roleId: designRole },
      ]);
    });
    const resolved = await new DatabaseMembershipContextLoader(db).load({
      sub: other.userId,
      tenant_id: a.tenantId,
    });
    if (!resolved) throw Error("Synthetic history reader missing");
    scopedReader = resolved;
    const { spu } = await catalog.createSpu(a, {
      code: "HISTORY-" + randomUUID().slice(0, 8),
      name: "Synthetic history source",
      idempotencyKey: randomUUID(),
    });
    const { specification } = await catalog.saveSpecification(a, {
      spuId: spu.id,
      code: "HISTORY-SPEC-" + randomUUID().slice(0, 8),
      name: "Synthetic specification",
      attributes: { size: "sample" },
      facts: syntheticSpecificationFacts({
        material: "Synthetic",
        dimensions: "Synthetic only",
        packageContents: "Synthetic",
        packageQuantity: 1,
        factsConfirmed: false,
      }),
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const { artwork } = await catalog.registerArtwork(a, {
      code: "HISTORY-ART-" + randomUUID().slice(0, 8),
      name: "Synthetic text template",
      mode: "personalized_text",
      customization: {
        version: 1,
        fields: [{ key: "name", type: "short_text", label: "Name", required: true }],
      },
      instructions: "Synthetic method",
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    // Relational history fixture deliberately has no reviewed manufacturing basis.
    // It proves read/export of prior snapshots, never a successful current seal.
    // The personal browser exercises the complete native preparation/review/seal gates.
    const styleId = createEntityId(),
      recipe = {
        id: createEntityId(),
        skuId: createEntityId(),
        skuCode: "HISTORY-SKU-" + randomUUID().slice(0, 8),
      };
    await withTenant(db.db, a, async (tx) => {
      await tx.insert(productStyles).values({
        id: styleId,
        tenantId: a.tenantId,
        createdBy: a.userId,
        spuId: spu.id,
        artworkId: artwork.id,
      });
      await tx.insert(skus).values({
        id: recipe.skuId,
        tenantId: a.tenantId,
        spuId: spu.id,
        code: recipe.skuCode,
        attributes: specification.attributes,
      });
      await tx.insert(salesSkuDefinitions).values({
        id: createEntityId(),
        tenantId: a.tenantId,
        createdBy: a.userId,
        skuId: recipe.skuId,
        spuId: spu.id,
        styleId,
        specificationId: specification.id,
      });
      await tx.insert(salesRecipeVersions).values({
        id: recipe.id,
        tenantId: a.tenantId,
        createdBy: a.userId,
        skuId: recipe.skuId,
        versionNumber: 1,
        artworkVersionId: artwork.versionId,
        specificationVersionId: specification.versionId,
        status: "pending_adaptation",
      });
    });
    const { plan } = await plans.create(a, {
      spuId: spu.id,
      fields: SalesPlanFieldsSchema.parse({
        name: "Synthetic history plan",
        mode: "custom",
        fulfillment: "fbm",
        skuIds: [recipe.skuId],
        artworkVersionIds: [artwork.versionId],
        specificationIds: [specification.id],
      }),
      idempotencyKey: randomUUID(),
    });
    planId = plan.id;
    const second = await plans.create(a, {
      spuId: spu.id,
      fields: SalesPlanFieldsSchema.parse({
        name: "Different original plan",
        mode: "custom",
        fulfillment: "fbm",
      }),
      idempotencyKey: randomUUID(),
    });
    otherPlan = second.plan.id;
    const draft = await withTenant(db.db, a, (tx) =>
      listing.createDevelopmentDraft(tx, a, {
        spuId: spu.id,
        styleId,
        salesPlanId: planId,
        salesPlanRevision: plan.revision,
        platform: "amazon",
        marketplaceId: "ATVPDKIKX0DER",
        locale: "en-US",
        content: {
          platform: "amazon",
          locale: "en-US",
          title: "Original immutable title",
          description: "",
          bullets: [],
          tags: [],
          mediaAssetIds: [],
          variants: [],
          attributes: {},
          compliance: {},
        },
      }),
    );
    const stored = await storage.putPrivate(a, {
      domain: "authorized",
      fileName: "synthetic-original.png",
      mediaType: "image/png",
      body: bytes,
    });
    assetId = createEntityId();
    await withTenant(db.db, a, (tx) =>
      tx.insert(assetFiles).values({
        id: assetId,
        tenantId: a.tenantId,
        ...stored,
        assetDomain: "authorized",
        ownerUserId: a.userId,
        fileName: "synthetic-original.png",
        mediaType: "image/png",
        byteSize: bytes.length,
        rightsStatus: "approved",
        rightsMetadata: { source: { kind: "self_created" }, fixture: "history-only" },
      }),
    );
    // Synthetic immutable prior records exercise history/read/export, not an approval or seal gate.
    // Full native review/seal is covered by the personal browser with reviewed upstream fixtures.
    originalSnapshot = {
      schemaVersion: 1,
      recipe: { skuId: recipe.skuId, skuCode: recipe.skuCode },
      listing: {
        id: draft.listingId,
        versionId: draft.listingVersionId,
        content: { title: "Original immutable title" },
      },
      salesPlanDelivery: {
        schemaVersion: 1,
        planId,
        revision: 1,
        fingerprint: "a".repeat(64),
        review: { id: createEntityId(), note: "Synthetic prior record" },
        customization: plan.fields.customization,
        layout: plan.fields.layout,
        customInstructions: "Original instructions",
        customPage: { status: "verified", evidence: "Synthetic prior evidence" },
        customMaterials: [],
        skuMapping: [{ skuId: recipe.skuId, recipeId: recipe.id }],
      },
      files: [
        {
          id: assetId,
          version: 1,
          checksum: stored.checksumSha256,
          objectKey: stored.objectKey,
          name: "synthetic-original.png",
          mediaType: "image/png",
          byteSize: bytes.length,
          role: "listing",
        },
      ],
    };
    originalSnapshot = JSON.parse(JSON.stringify(originalSnapshot));
    originalChecksum = fingerprint(originalSnapshot);
    const packs = Array.from({ length: 28 }, (_, i) => ({
      id: createEntityId(),
      tenantId: a.tenantId,
      createdBy: a.userId,
      skuId: recipe.skuId,
      recipeId: recipe.id,
      versionNumber: i + 1,
      listingId: draft.listingId,
      listingVersionId: draft.listingVersionId,
      platform: "amazon",
      marketplaceId: "ATVPDKIKX0DER",
      locale: "en-US",
      snapshot: originalSnapshot,
      checksum: originalChecksum,
      createdAt: new Date(Date.now() + i * 1000),
    }));
    packageId = packs[0]!.id;
    await withTenant(db.db, a, (tx) => tx.insert(salesPackageVersions).values(packs));
    await plans.save(a, planId, {
      fields: { ...plan.fields, skuIds: [], name: "Updated current selection" },
      expectedRevision: plan.revision,
      idempotencyKey: randomUUID(),
    });
  });
  afterAll(async () => {
    await db.client.end();
  });
  it("pages the original plan history after current SKU removal without rewriting any original record", async () => {
    const first = await delivery.get(a, planId),
      second = await delivery.get(a, planId, { packagePage: 2 });
    expect(first.skus).toEqual([]);
    expect(first.currentPackages).toEqual([]);
    expect(first.packages).toHaveLength(25);
    expect(first.packageHistory).toEqual({ page: 1, pageSize: 25, hasMore: true });
    expect(second.packages).toHaveLength(3);
    expect(second.packageHistory.hasMore).toBe(false);
    expect(new Set([...first.packages, ...second.packages].map((p) => p.id)).size).toBe(28);
    expect(second.packages.find((p) => p.id === packageId)).toMatchObject({
      current: false,
      checksum: originalChecksum,
    });
    expect((await delivery.get(a, otherPlan)).packages).toEqual([]);
    const [row] = await withTenant(db.db, a, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, packageId)),
    );
    expect(row!.snapshot).toEqual(originalSnapshot);
    expect(row!.checksum).toBe(originalChecksum);
  });
  it("reconstructs original files and pins only through explicit history; current delivery still refuses an obsolete basis", async () => {
    await expect(delivery.export(a, planId, packageId)).rejects.toMatchObject({ status: 409 });
    const result = await delivery.export(a, planId, packageId, { basis: "history" }),
      zip = await JSZip.loadAsync(result.body, { checkCRC32: true });
    expect(result.name).toContain("historical-");
    expect(
      await zip.file(`listing/${assetId}-synthetic-original.png`)!.async("nodebuffer"),
    ).toEqual(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.checksum).toBe(originalChecksum);
    expect(manifest.listing.content.title).toBe("Original immutable title");
    expect(manifest.salesPlanDelivery.revision).toBe(1);
    expect(await zip.file("README.txt")!.async("string")).toContain("原封存版本");
  });
  it("filters before pagination and never grants another tenant, plan or source scope historical access", async () => {
    expect((await delivery.get(scopedReader, planId)).packages).toEqual([]);
    await expect(delivery.get(b, planId)).rejects.toMatchObject({ status: 404 });
    await expect(
      delivery.export(a, otherPlan, packageId, { basis: "history" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      delivery.export(scopedReader, planId, packageId, { basis: "history" }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects unsafe query values before returning or executing work", async () => {
    for (const query of [
      { packagePage: 0 },
      { packagePage: 2, tenantId: a.tenantId },
      { packagePage: 100001 },
    ])
      await expect(delivery.get(a, planId, query)).rejects.toThrow();
    await expect(delivery.export(a, planId, packageId, { basis: "unsafe" })).rejects.toThrow();
    expect(
      await withTenant(db.db, a, (tx) =>
        tx
          .select()
          .from(developmentEvents)
          .where(eq(developmentEvents.action, "sales_plan.delivery_review")),
      ),
    ).toEqual([]);
  });
  it("rejects different bytes from a storage adapter even when the historical metadata still matches", async () => {
    const altered = new Proxy(storage, {
      get(target, key, receiver) {
        if (key === "readPrivate")
          return async () => Buffer.from("Synthetic different storage response");
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guarded = new SalesPlanDeliveryService(db, new SalesPackageService(db, listing, altered));
    await expect(guarded.export(a, planId, packageId, { basis: "history" })).rejects.toThrow(
      "封存素材内容校验失败",
    );
  });
  it("retains immutable metadata but rejects a historical download after the source asset is withdrawn", async () => {
    await withTenant(db.db, a, (tx) =>
      tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, assetId)),
    );
    await expect(delivery.export(a, planId, packageId, { basis: "history" })).rejects.toMatchObject(
      { status: 409 },
    );
    expect(
      (await delivery.get(a, planId, { packagePage: 2 })).packages.some((p) => p.id === packageId),
    ).toBe(true);
  });
});
