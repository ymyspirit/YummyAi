import { randomUUID } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import {
  createEntityId,
  type TenantContext,
  type ProductionEditorDocument,
  type ProductionEditorImageView,
} from "@yummyai/contracts";
import type {
  ArtworkView,
  SpecificationView,
  SalesRecipeView,
} from "@yummyai/contracts/catalog/development";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  productPlans,
  spus,
  skus,
  assetFiles,
  canvasPrintSpecVersions,
  marketplaceAccounts,
  artworkMasterVersions,
  salesRecipeVersions,
  salesPackageVersions,
  listingVersions,
  listings,
  mockupTemplateSourceInspections,
  mockupTemplatePackVersions,
  mockupTemplateSlots,
  mockupBatches,
  mockupBatchItems,
  mockupBatchOutputs,
  modelProviderConfigs,
  modelRoutes,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import JSZip from "jszip";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { DesignService, DrizzleDesignRepository } from "../design/design.service.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { PodBatchWorkflowService } from "../design/pod-batch-workflow.service.js";
import { PodGovernanceService } from "../design/pod-governance.service.js";
import { PodMockupBatchService } from "../design/pod-mockup-batch.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { SalesAdaptationService } from "../design/sales-adaptation.service.js";
import { OrderService } from "../orders/order.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { ProductionEditorRenderProcessor } from "../../../worker/src/processors/production-editor.processor.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesRecipeService } from "./sales-recipe.service.js";
import { SalesPackageService } from "./sales-package.service.js";
import { fingerprint, readSpecification, readArtwork, readRecipe } from "./development-data.js";
import { orderSalesChoices, validateOrderSalesBasis } from "./order-sales-basis.js";
import { AssistCatalogContextService } from "../ai/assist-catalog-context.service.js";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { DrizzleCatalogRepository, ProductService } from "./product.service.js";

describe.sequential("artwork to sales SKU, immutable package and order basis", () => {
  const db = connectDatabase(),
    storage = createStorageFromEnvironment(),
    a: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    },
    b = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  const audit = new AuditService(db),
    vault = new SecretVault(Buffer.alloc(32, 117)),
    orderService = new OrderService(db, vault, audit);
  const scan = async () => ({
    result: "clean" as const,
    engine: "synthetic",
    signatureVersion: "fixture",
    scannedAt: new Date().toISOString(),
  });
  const reports = new AmazonOrderReportService(
    db,
    vault,
    orderService,
    audit,
    {
      download: async () => {
        throw Error("No remote data");
      },
      scan,
    },
    { schedule: async () => undefined },
  );
  const editor = new ProductionEditorService(
    db,
    vault,
    storage,
    reports,
    audit,
    { enqueue: async () => undefined },
    { scan },
  );
  const work = new OrderWorkspaceService(db, vault, storage, reports, editor, { scan }),
    worker = new ProductionEditorRenderProcessor(db, storage, vault);
  const queue = {
    enqueueCreativeCandidate: vi.fn(),
    enqueueCreativeAdaptation: vi.fn(),
    enqueueTemplateCompile: vi.fn(),
    enqueueMockupRender: vi.fn(),
  };
  const creative = new PodBatchWorkflowService(
      db,
      queue,
      audit,
      new DesignService(new DrizzleDesignRepository(db, storage)),
    ),
    bridge = new CanvasBridgeService(db, storage, audit, creative);
  const catalog = new ProductDevelopmentService(db, storage),
    recipes = new SalesRecipeService(db, new SalesAdaptationService(db, storage, editor)),
    listing = new ListingService(new DrizzleListingRepository(db)),
    packages = new SalesPackageService(db, listing, storage);
  const specId = createEntityId(),
    accountId = createEntityId(),
    spuIds = [createEntityId(), createEntityId()];
  let artwork: ArtworkView,
    otherArt: ArtworkView,
    specifications: SpecificationView[],
    sales: SalesRecipeView[],
    profileVersionId: string,
    packageId: string,
    orderLineId: string,
    image: Buffer,
    outputAssetId: string;
  const doc = (): ProductionEditorDocument => ({
    schemaVersion: 1,
    name: "Synthetic process",
    productType: "tire_cover",
    spec: { diameterMm: 50, dpi: 150, safeInsetMm: 2, opening: null },
    contour: [],
    layers: [],
    confirmations: {
      physicalSize: true,
      visualReview: true,
      whiteBorderRule: true,
      narrowParts: true,
      barcodeTab: true,
      backText: true,
    },
  });
  async function creativeVersion(color: string) {
    const png = await sharp({ create: { width: 512, height: 512, channels: 4, background: color } })
      .png()
      .toBuffer();
    const brief = await bridge.create(a, {
      requestId: randomUUID(),
      name: "Synthetic artwork",
      prompt: "Original synthetic test shape",
      referenceAssetIds: [],
    });
    const result = await bridge.submit(a, brief.id, {
      submissionId: randomUUID(),
      protocolVersion: 1,
      pluginVersion: CANVAS_BRIDGE.pluginVersion,
      upstreamVersion: CANVAS_BRIDGE.upstreamVersion,
      sourceNodeId: randomUUID(),
      title: "Synthetic master",
      contentBase64: png.toString("base64"),
      rightsAttested: true,
      sourceKind: "owned",
      sourceReference: "Integration fixture",
    });
    await creative.reviewCreativeVersion(a, result.versionId, { decision: "approve" });
    return result.versionId;
  }
  async function register(code: string, versionId: string, expectedVersion = 0) {
    return (
      await catalog.registerArtwork(a, {
        code,
        name: code,
        mode: "fixed",
        creativeVersionId: versionId,
        expectedVersion,
        idempotencyKey: randomUUID(),
      })
    ).artwork;
  }
  beforeAll(async () => {
    await migrateDatabase(db);
    await storage.ensureBucket();
    for (const c of [a, b]) {
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Sales development test',$2)",
        [c.tenantId, `sales-${c.tenantId}`],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Sales operator')",
        [c.userId, c.userId, `${c.userId}@example.test`],
      );
    }
    for (const index of spuIds.keys()) {
      const input = {
        code: `SPU-${index + 1}`,
        name: `Physical product ${index}`,
        idempotencyKey: randomUUID(),
      };
      const [first, retry] = await Promise.all([
        catalog.createSpu(a, input),
        catalog.createSpu(a, input),
      ]);
      expect(first).toEqual(retry);
      spuIds[index] = first.spu.id;
      await expect(
        catalog.createSpu(a, { ...input, idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(ConflictException);
      const [parent] = await withTenant(db.db, a, (tx) =>
        tx.select().from(productPlans).where(eq(productPlans.id, first.spu.productPlanId)),
      );
      expect(parent).toMatchObject({ status: "developing", sourceReportIds: [], approvedBy: null });
    }
    expect((await catalog.options(b)).spus).toHaveLength(0);
    await withTenant(db.db, a, async (tx) => {
      const providerId = createEntityId();
      await tx.insert(modelProviderConfigs).values({ id: providerId, tenantId: a.tenantId, provider: "openai-compatible", label: "Synthetic image provider", endpoint: "https://example.test/v1", encryptedApiKey: "synthetic-unused-encrypted-key", createdBy: a.userId });
      await tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: a.tenantId, modelKey: "synthetic-image", taskType: "studio_image", targets: [{ providerConfigId: providerId, providerModel: "gpt-image-2.5", timeoutMs: 600000 }] });
      await tx.insert(canvasPrintSpecVersions).values({
        id: specId,
        tenantId: a.tenantId,
        specId: createEntityId(),
        versionNumber: 1,
        name: "Square synthetic",
        aspectWidth: 1,
        aspectHeight: 1,
        targetDpi: 150,
        bleedMm: "0",
        safeZoneMm: "2",
        wrapMode: "none",
        physicalSizes: [{ key: "50", label: "50mm", widthMm: 50, heightMm: 50 }],
        status: "approved",
        createdBy: a.userId,
        reviewedBy: a.userId,
        reviewedAt: new Date(),
      });
      await tx.insert(marketplaceAccounts).values({
        id: accountId,
        tenantId: a.tenantId,
        platform: "amazon",
        displayName: "Synthetic sales shop",
        region: "NA",
        authorizationMode: "amazon_private",
        marketplaceIds: ["ATVPDKIKX0DER"],
        createdBy: a.userId,
      });
    });
    image = await sharp({ create: { width: 512, height: 512, channels: 4, background: "#3275ac" } })
      .png()
      .toBuffer();
    let template = await editor.create(a, { name: "Synthetic process", document: doc() });
    const imageAsset = (await editor.upload(
      a,
      template.project.id,
      "process.png",
      image,
    )) as ProductionEditorImageView;
    const document = doc();
    document.layers = [
      {
        id: "base",
        kind: "image",
        name: "Process reference",
        assetId: imageAsset.id,
        assetVersion: 1,
        xMm: 0,
        yMm: 0,
        widthMm: 50,
        heightMm: 50,
        rotationDeg: 0,
        opacity: 1,
        visible: true,
        locked: false,
        flipX: false,
        flipY: false,
      },
    ];
    template = await editor.save(a, template.project.id, {
      expectedVersionId: template.version.id,
      document,
    });
    await editor.review(a, template.project.id, template.version.id);
    profileVersionId = (
      await work.saveProfile(a, {
        code: "PROCESS-001",
        name: "50mm synthetic",
        projectId: template.project.id,
        versionId: template.version.id,
        instructions: "Synthetic process",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    )[0]!.versionId;
    artwork = await register("ART-001", await creativeVersion("#a33355"));
    otherArt = await register("ART-002", await creativeVersion("#3a8a55"));
    specifications = [];
    for (const spuId of spuIds)
      for (const color of ["BLUE", "RED"])
        specifications.push(
          (
            await catalog.saveSpecification(a, {
              spuId,
              code: color,
              name: color,
              attributes: { color },
              facts: {
                material: "Synthetic fabric",
                dimensions: "50mm",
                packageContents: "One cover",
                packageQuantity: 1,
                factsConfirmed: true,
              },
              processProfileVersionId: profileVersionId,
              canvasPrintSpecVersionId: specId,
              expectedVersion: 0,
              idempotencyKey: randomUUID(),
            })
          ).specification,
        );
  }, 60000);
  afterAll(async () => {
    await db.client.end();
  });

  it("saves size drafts without a process and prevents production until a new verified version is supplied", async () => {
    const { spu } = await catalog.createSpu(a, { code: "SIZE-DRAFTS", name: "Synthetic size drafts", idempotencyKey: randomUUID() });
    const items = [10, 12].map(size => ({ code: `${size}IN`, name: `${size} inch`, attributes: { size: `${size} inch` }, facts: { ...specifications[0]!.facts, dimensions: `${size} inch nominal longest side; factory tolerance pending`, factsConfirmed: false }, processProfileVersionId: null }));
    const input = { spuId: spu.id, items, idempotencyKey: randomUUID() };
    await expect(catalog.createSpecifications(b, input)).rejects.toThrow();
    await expect(catalog.createSpecifications({ ...a, permissions: [] }, input)).rejects.toThrow();
    const first = await catalog.createSpecifications(a, input);
    expect(await catalog.createSpecifications(a, input)).toEqual(first);
    const draft = first.specifications[0]!;
    expect(draft).toMatchObject({ processProfileVersionId: null, productType: null, facts: { factsConfirmed: false } });
    expect((await catalog.options(a)).specifications.filter(item => item.spuId === spu.id)).toHaveLength(2);
    expect((await withTenant(db.db, a, tx => orderSalesChoices(tx))).specifications.some(item => item.id === draft.versionId)).toBe(false);
    await expect(catalog.combine(a, { artworkVersionId: artwork.versionId, items: [{ specificationVersionId: draft.versionId, skuCode: "DRAFT-MUST-NOT-PRODUCE" }], idempotencyKey: randomUUID() })).rejects.toThrow("规格仍为草稿");
    await expect(withTenant(db.db, a, tx => validateOrderSalesBasis(tx, { artworkVersionId: artwork.versionId, specificationVersionId: draft.versionId, printProfileVersionId: null } as Parameters<typeof validateOrderSalesBasis>[1]))).rejects.toThrow("规格仍为草稿");
    await expect(catalog.saveSpecification(a, { ...items[0], spuId: spu.id, facts: { ...items[0]!.facts, factsConfirmed: true }, expectedVersion: 1, idempotencyKey: randomUUID() })).rejects.toThrow("只能保存未确认");
    const ready = await catalog.saveSpecification(a, { ...items[0], spuId: spu.id, processProfileVersionId: profileVersionId, facts: { ...items[0]!.facts, factsConfirmed: true }, expectedVersion: 1, idempotencyKey: randomUUID() });
    expect(ready.specification).toMatchObject({ id: draft.id, version: 2, processProfileVersionId: profileVersionId });
    expect(await withTenant(db.db, a, tx => readSpecification(tx, draft.versionId))).toMatchObject({ version: 1, processProfileVersionId: null });
    expect((await withTenant(db.db, a, tx => orderSalesChoices(tx))).specifications.some(item => item.id === ready.specification.versionId)).toBe(true);
  });

  it("excludes archived parents and SPUs from reusable product and specification choices while retaining history", async () => {
    const products = new ProductService(new DrizzleCatalogRepository(db));
    for (const archiveTarget of ["plan", "spu"] as const) {
      const { spu } = await catalog.createSpu(a, { code: `ARCHIVE-${archiveTarget}`, name: "Synthetic archived product", idempotencyKey: randomUUID() });
      const { specification } = await catalog.saveSpecification(a, {
        spuId: spu.id, code: "DEFAULT", name: "Synthetic archived specification", attributes: { size: "fixture" },
        facts: specifications[0]!.facts, processProfileVersionId: profileVersionId,
        expectedVersion: 0, idempotencyKey: randomUUID(),
      });
      const before = await catalog.options(a);
      expect(before.spus.some(item => item.id === spu.id)).toBe(true);
      expect(before.specifications.some(item => item.id === specification.id)).toBe(true);
      if (archiveTarget === "plan") await products.transition(a, spu.productPlanId, "archived");
      else await withTenant(db.db, a, tx => tx.update(spus).set({ status: "archived" }).where(eq(spus.id, spu.id)));
      const after = await catalog.options(a);
      expect(after.spus.some(item => item.id === spu.id)).toBe(false);
      expect(after.specifications.some(item => item.id === specification.id)).toBe(false);
      const historical = (await products.listPlans(a)).find(item => item.id === spu.productPlanId);
      expect(historical?.spu?.id).toBe(spu.id);
      expect((await catalog.options(a)).spus).toEqual(expect.arrayContaining(spuIds.map(id => expect.objectContaining({ id }))));
    }
  });

  it("removes archived SKUs and archived product children from list counts and searches while retaining version history", async () => {
    const products = new ProductService(new DrizzleCatalogRepository(db));
    const prefix = "ARCHIVE-LIST-";
    const fixtures = [];
    const keep = await products.createSku(a, { spuId: spuIds[0]!, code: `${prefix}KEEP`, attributes: { size: "legacy" } });
    for (const target of ["plan", "spu", "sku"] as const) {
      const { spu } = await catalog.createSpu(a, { code: `${prefix}${target}`, name: "Synthetic list archive fixture", idempotencyKey: randomUUID() });
      const { specification } = await catalog.saveSpecification(a, {
        spuId: spu.id, code: "DEFAULT", name: "Synthetic list specification", attributes: { size: "fixture" },
        facts: specifications[0]!.facts, processProfileVersionId: profileVersionId, expectedVersion: 0, idempotencyKey: randomUUID(),
      });
      const { recipes: [recipe] } = await catalog.combine(a, { artworkVersionId: artwork.versionId,
        items: [{ specificationVersionId: specification.versionId, skuCode: `${prefix}${target}-MAPPED` }], idempotencyKey: randomUUID() });
      const legacy = await products.createSku(a, { spuId: spu.id, code: `${prefix}${target}-LEGACY`, attributes: { size: "legacy" } });
      fixtures.push({ target, spu, recipe: recipe!, legacy });
    }
    const initial = await catalog.workspace(a, { q: prefix, pageSize: 2, page: 2 });
    expect(initial.total).toBe(7);
    expect(initial.items).toHaveLength(2);
    for (const fixture of fixtures) {
      if (fixture.target === "plan") await products.transition(a, fixture.spu.productPlanId, "archived");
      else if (fixture.target === "spu") await withTenant(db.db, a, tx => tx.update(spus).set({ status: "archived" }).where(eq(spus.id, fixture.spu.id)));
      else await withTenant(db.db, a, tx => tx.update(skus).set({ status: "archived" }).where(inArray(skus.id, [fixture.recipe.skuId, fixture.legacy.id])));
      expect((await catalog.workspace(a, { spuId: fixture.spu.id })).total).toBe(0);
      expect((await catalog.workspace(a, { q: fixture.recipe.skuCode, status: "pending_adaptation" })).total).toBe(0);
      const historical = await catalog.detail(a, fixture.recipe.skuId);
      expect(historical.recipes[0]!.id).toBe(fixture.recipe.id);
      expect((await catalog.detail(a, fixture.legacy.id)).item.skuCode).toBe(fixture.legacy.code);
      await expect(catalog.detail(b, fixture.recipe.skuId)).rejects.toThrow();
    }
    for (const status of ["all", "unmapped"]) {
      const current = await catalog.workspace(a, { q: prefix, status, pageSize: 2 });
      expect(current.total).toBe(1);
      expect(current.items.map(i => i.skuId)).toEqual([keep.id]);
    }
    expect((await catalog.workspace(b, { q: prefix })).total).toBe(0);
  });

  it("atomically binds multiple size/shape specifications, rejects duplicate combinations and keeps tenant/version boundaries", async () => {
    const { spu } = await catalog.createSpu(a, {
      code: "BATCH-SPECS",
      name: "Synthetic multi-option product",
      idempotencyKey: randomUUID(),
    });
    const items = ["50mm", "60mm"].flatMap((size, sizeIndex) =>
      ["圆形", "心形"].map((shape, shapeIndex) => ({
        code: `SIZE-${sizeIndex}-SHAPE-${shapeIndex}`,
        name: `${size} · ${shape}`,
        attributes: { 尺寸: size, 形状: shape },
        facts: { ...specifications[0]!.facts, dimensions: size },
        processProfileVersionId: profileVersionId,
        canvasPrintSpecVersionId: specId,
      })),
    );
    const input = { spuId: spu.id, items, idempotencyKey: randomUUID() };
    await expect(catalog.createSpecifications({ ...a, permissions: [] }, input)).rejects.toThrow();
    await expect(catalog.createSpecifications(b, input)).rejects.toThrow();
    const failed = {
      ...input,
      items: items.map((item, i) =>
        i === 3 ? { ...item, processProfileVersionId: createEntityId() } : item,
      ),
    };
    await expect(catalog.createSpecifications(a, failed)).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await catalog.options(a)).specifications.filter((spec) => spec.spuId === spu.id),
    ).toHaveLength(0);
    // The failed transaction must also roll back its idempotency record.
    const [first, retry] = await Promise.all([
      catalog.createSpecifications(a, input),
      catalog.createSpecifications(a, input),
    ]);
    expect(retry).toEqual(first);
    expect(first.specifications).toHaveLength(4);
    expect(new Set(first.specifications.map((spec) => spec.spuId))).toEqual(new Set([spu.id]));
    expect(first.specifications.map((spec) => spec.facts.dimensions)).toEqual([
      "50mm",
      "50mm",
      "60mm",
      "60mm",
    ]);
    expect((await catalog.options(b)).specifications).toHaveLength(0);
    await expect(
      catalog.createSpecifications(a, { ...input, items: items.slice(0, 1) }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      catalog.createSpecifications(a, {
        ...input,
        idempotencyKey: randomUUID(),
        items: [
          { ...items[0]!, code: "DIFFERENT-CODE", attributes: { 形状: "圆形", 尺寸: "50mm" } },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      catalog.createSpecifications(a, {
        ...input,
        idempotencyKey: randomUUID(),
        items: [items[0], { ...items[0], code: "DUPLICATE-ATTRIBUTES" }],
      }),
    ).rejects.toThrow();
    const saved = first.specifications[0]!;
    const revised = await catalog.saveSpecification(a, {
      ...items[0],
      spuId: spu.id,
      name: "Updated size label",
      expectedVersion: saved.version,
      idempotencyKey: randomUUID(),
    });
    expect(revised.specification.version).toBe(2);
    expect(revised.specification.id).toBe(saved.id);
    expect(revised.specification.versionId).not.toBe(saved.versionId);
    expect(
      (await catalog.options(a)).specifications.filter((spec) => spec.spuId === spu.id),
    ).toHaveLength(4);
    // A different tenant's SPU cannot bind this tenant's approved process.
    const foreign = await catalog.createSpu(b, {
      code: "B-OWN-SPU",
      name: "Tenant B",
      idempotencyKey: randomUUID(),
    });
    await expect(
      catalog.createSpecifications(b, {
        ...input,
        spuId: foreign.spu.id,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await catalog.options(b)).specifications).toHaveLength(0);
  });

  it("makes four SKUs from one artwork and two SPUs with two specs, and safely retries", async () => {
    const input = {
      artworkVersionId: artwork.versionId,
      items: specifications.map((s, i) => ({
        specificationVersionId: s.versionId,
        skuCode: `SALE-${i}`,
      })),
      idempotencyKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      catalog.combine(a, input),
      catalog.combine(a, input),
    ]);
    expect(first).toEqual(second);
    sales = first.recipes;
    expect(sales).toHaveLength(4);
    expect(new Set(sales.map((r) => r.artwork.id)).size).toBe(1);
    expect(new Set(sales.map((r) => r.specification.spuId)).size).toBe(2);
    await expect(
      catalog.combine(a, { ...input, items: input.items.slice(0, 1) }),
    ).rejects.toBeInstanceOf(ConflictException);
    const list = await catalog.workspace(a, {
      q: "ART-001",
      status: "pending_adaptation",
      pageSize: 2,
    });
    expect(list.total).toBe(4);
    expect(list.items).toHaveLength(2);
    expect((await catalog.workspace(b, {})).total).toBe(0);
    await expect(catalog.detail(b, sales[0]!.skuId)).rejects.toThrow();
    await expect(
      catalog.registerArtwork({ ...a, permissions: [] }, { code: "X" }),
    ).rejects.toThrow();
    await expect(
      withTenant(db.db, b, (tx) =>
        tx.execute(sql`select * from artwork_master_versions where id=${artwork.versionId}`),
      ),
    ).resolves.toHaveLength(0);
    await expect(
      withTenant(db.db, a, (tx) =>
        tx
          .update(artworkMasterVersions)
          .set({ name: "overwrite" })
          .where(eq(artworkMasterVersions.id, artwork.versionId)),
      ),
    ).rejects.toThrow();
  });

  it("copies the chosen master, renders and freezes the reviewed recipe and enables mockup handoff", async () => {
    for (const index of [0, 1]) {
      const target = sales[index]!;
      const started = await recipes.action(a, target.id, {
        action: "start_adaptation",
        reason: "Synthetic start",
        idempotencyKey: randomUUID(),
      });
      expect(started.recipe.editorProjectId).toBeTruthy();
      let project = await editor.get(a, started.recipe.editorProjectId!);
      expect(project.project.catalogSource?.recipeId).toBe(target.id);
      expect(project.version.document.layers[0]?.id).toBe("catalog_artwork");
      expect(
        (await editor.list(a, "templates")).projects.some((p) => p.id === project.project.id),
      ).toBe(false);
      const input = {
        action: "approve_adaptation",
        reason: "Verified original artwork, size and material",
        expectedEditorVersionId: project.version.id,
        renderId: createEntityId(),
        idempotencyKey: randomUUID(),
      };
      await expect(recipes.action(a, target.id, input)).rejects.toThrow();
      project.version.document.confirmations.visualReview = true;
      project = await editor.save(a, project.project.id, {
        expectedVersionId: project.version.id,
        document: project.version.document,
      });
      await editor.review(a, project.project.id, project.version.id);
      const render = await editor.render(a, project.project.id, {
        expectedVersionId: project.version.id,
        purpose: "production",
        format: "png",
        background: "transparent",
      });
      await worker.process(
        JobEnvelopeSchema.parse({
          jobId: createEntityId(),
          tenantId: a.tenantId,
          requestedBy: a.userId,
          correlationId: render.id,
          idempotencyKey: render.id,
          payload: { renderId: render.id },
        }),
      );
      sales[index] = (
        await recipes.action(a, target.id, {
          ...input,
          expectedEditorVersionId: project.version.id,
          renderId: render.id,
          idempotencyKey: randomUUID(),
        })
      ).recipe;
      expect(sales[index].status).toBe("approved");
      await expect(
        editor.save(a, project.project.id, {
          expectedVersionId: project.version.id,
          document: project.version.document,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(editor.remove(a, project.project.id)).rejects.toThrow();
      await expect(
        withTenant(db.db, a, (tx) =>
          tx
            .update(salesRecipeVersions)
            .set({ status: "pending_adaptation" })
            .where(eq(salesRecipeVersions.id, target.id)),
        ),
      ).rejects.toThrow();
      const mockups = new PodMockupBatchService(
        db,
        queue,
        audit,
        new PodGovernanceService(db, audit),
      );
      expect(
        (await mockups.batchOptions(a)).formalDesigns.some(
          (d) => d.designVersionId === sales[index]!.designVersionId,
        ),
      ).toBe(true);
    }
    expect((await catalog.detail(a, sales[0]!.skuId)).relatedRecipes).toHaveLength(2);
  }, 60000);

  it("seals an approved SKU-specific mockup and listing, rejects substitutes and exports pinned bytes", async () => {
    const r = sales[0]!,
      draft = await packages.createListing(a, {
        recipeIds: [r.id, sales[1]!.id],
        platform: "amazon",
        marketplaceId: "ATVPDKIKX0DER",
        locale: "en-US",
        title: "Synthetic reviewed cover",
        idempotencyKey: randomUUID(),
      });
    const stored = await storage.putPrivate(a, {
      body: image,
      domain: "authorized",
      fileName: "synthetic-reviewed-mockup.png",
      mediaType: "image/png",
    });
    outputAssetId = createEntityId();
    const secondAssetId = createEntityId();
    const secondImage = await sharp({
      create: { width: 512, height: 512, channels: 4, background: "#9c3151" },
    })
      .png()
      .toBuffer();
    const secondStored = await storage.putPrivate(a, {
      body: secondImage,
      domain: "authorized",
      fileName: "synthetic-second-spec.png",
      mediaType: "image/png",
    });
    // The established renderer/Listing suites own upstream review. This fixture
    // provides their approved outputs to test the new package boundary.
    await withTenant(db.db, a, async (tx) => {
      const now = new Date(),
        inspection = createEntityId(),
        pack = createEntityId(),
        slot = createEntityId(),
        batch = createEntityId(),
        item = createEntityId();
      await tx.insert(assetFiles).values({
        id: outputAssetId,
        tenantId: a.tenantId,
        ...stored,
        assetDomain: "authorized",
        fileName: "synthetic-reviewed-mockup.png",
        mediaType: "image/png",
        byteSize: image.length,
        rightsStatus: "approved",
      });
      await tx.insert(mockupTemplateSourceInspections).values({
        id: inspection,
        tenantId: a.tenantId,
        sourceAssetId: outputAssetId,
        sourceAssetVersion: 1,
        checksumSha256: stored.checksumSha256,
        slotKey: "hero",
        status: "completed",
        compilerVersion: "synthetic",
        compilation: {
          canvasWidth: 512,
          canvasHeight: 512,
          slotKey: "hero",
          transform: [0, 0, 512, 0, 512, 512, 0, 512],
          backgroundAssetId: outputAssetId,
          foregroundAssetId: outputAssetId,
          previewAssetId: outputAssetId,
          manifestAssetId: outputAssetId,
          checksumSha256: stored.checksumSha256,
          ssimPermille: 1000,
          compilerVersion: "synthetic",
        },
        requestedBy: a.userId,
        confirmedBy: a.userId,
        completedAt: now,
        confirmedAt: now,
      });
      await tx.insert(mockupTemplatePackVersions).values({
        id: pack,
        tenantId: a.tenantId,
        packId: createEntityId(),
        versionNumber: 1,
        name: "Synthetic pack",
        platform: "amazon",
        locale: "en-US",
        status: "approved",
        createdBy: a.userId,
        reviewedBy: a.userId,
        reviewedAt: now,
      });
      await tx.insert(mockupTemplateSlots).values({
        id: slot,
        tenantId: a.tenantId,
        templatePackVersionId: pack,
        inspectionId: inspection,
        slotKey: "hero",
        label: "Hero",
        ordinal: 0,
        required: true,
        acceptedPrintSpecVersionIds: [specId],
      });
      await tx.insert(mockupBatches).values({
        id: batch,
        tenantId: a.tenantId,
        name: "Synthetic reviewed mockup",
        templatePackVersionId: pack,
        platform: "amazon",
        locale: "en-US",
        status: "completed",
        itemCount: 2,
        completedCount: 2,
        requestChecksum: "a".repeat(64),
        createdBy: a.userId,
        completedAt: now,
      });
      await tx.insert(mockupBatchItems).values({
        id: item,
        tenantId: a.tenantId,
        batchId: batch,
        ordinal: 0,
        designVersionId: r.designVersionId!,
        skuId: r.skuId,
        status: "completed",
        reviewedBy: a.userId,
        reviewedAt: now,
        completedAt: now,
      });
      await tx.insert(mockupBatchOutputs).values({
        id: createEntityId(),
        tenantId: a.tenantId,
        itemId: item,
        templateSlotId: slot,
        slotKey: "hero",
        status: "approved",
        assetId: outputAssetId,
        assetVersion: 1,
        checksumSha256: stored.checksumSha256,
        width: 512,
        height: 512,
        completedAt: now,
      });
      const secondItem = createEntityId();
      await tx.insert(assetFiles).values({
        id: secondAssetId,
        tenantId: a.tenantId,
        ...secondStored,
        assetDomain: "authorized",
        fileName: "synthetic-second-spec.png",
        mediaType: "image/png",
        byteSize: secondImage.length,
        rightsStatus: "approved",
      });
      await tx.insert(mockupBatchItems).values({
        id: secondItem,
        tenantId: a.tenantId,
        batchId: batch,
        ordinal: 1,
        designVersionId: sales[1]!.designVersionId!,
        skuId: sales[1]!.skuId,
        status: "completed",
        reviewedBy: a.userId,
        reviewedAt: now,
        completedAt: now,
      });
      await tx.insert(mockupBatchOutputs).values({
        id: createEntityId(),
        tenantId: a.tenantId,
        itemId: secondItem,
        templateSlotId: slot,
        slotKey: "hero",
        status: "approved",
        assetId: secondAssetId,
        assetVersion: 1,
        checksumSha256: secondStored.checksumSha256,
        width: 512,
        height: 512,
        completedAt: now,
      });
      const [v] = await tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.id, draft.listingVersionId));
      await tx
        .update(listingVersions)
        .set({
          status: "approved",
          content: {
            ...v!.content,
            mainImageId: outputAssetId,
            mediaAssetIds: [outputAssetId, secondAssetId],
          },
          validation: { completeness: 100, blockers: [], warnings: [] },
        })
        .where(eq(listingVersions.id, draft.listingVersionId));
      await tx
        .update(listings)
        .set({ status: "approved", primaryVersionId: draft.listingVersionId })
        .where(eq(listings.id, draft.listingId));
    });
    const assistant = new AssistCatalogContextService(new PodPersonalizationService(db, { enqueue: vi.fn() }, audit), packages);
    const aiRequest = { kind: "sku_package" as const, modelId: createEntityId(), requestId: randomUUID(), listingId: draft.listingId, expectedVersionId: draft.listingVersionId };
    const aiBasis = await assistant.prepare(a, aiRequest);
    expect(aiBasis.images).toHaveLength(2);
    expect(aiBasis.images.every((i) => i.dataUrl?.startsWith("data:image/jpeg;base64,"))).toBe(true);
    expect(await assistant.stale(a, aiBasis)).toBe(false);
    const pinnedImage = (await packages.analysisBasis(a, draft.listingId, draft.listingVersionId)).images[0]!;
    await withTenant(db.db, a, tx => tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, pinnedImage.id)));
    try {
      await expect(packages.analysisImage(a, pinnedImage)).rejects.toThrow("源文件已变化");
      expect(await assistant.stale(a, aiBasis)).toBe(true);
    } finally { await withTenant(db.db, a, tx => tx.update(assetFiles).set({ deletedAt: null }).where(eq(assetFiles.id, pinnedImage.id))); }
    await expect(assistant.prepare(b, aiRequest)).rejects.toThrow();
    await expect(assistant.prepare(a, { ...aiRequest, expectedVersionId: createEntityId() })).rejects.toThrow("更新");
    expect((await listing.getWorkspace(a, draft.listingId)).version.id).toBe(draft.listingVersionId);
    const input = {
      recipeId: r.id,
      listingId: draft.listingId,
      listingVersionId: draft.listingVersionId,
      imageEvidence: [
        { assetId: outputAssetId, kind: "mockup" },
        { assetId: secondAssetId, kind: "mockup" },
      ],
      reason: "Reviewed exact production version and scene",
      idempotencyKey: randomUUID(),
    };
    await expect(
      packages.seal(a, { ...input, imageEvidence: [{ assetId: artwork.assetId, kind: "mockup" }] }),
    ).rejects.toThrow();
    const sealed = await packages.seal(a, input);
    packageId = sealed.packageId;
    expect(await packages.seal(a, input)).toEqual(sealed);
    const zip = await JSZip.loadAsync((await packages.export(a, packageId)).body),
      manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.recipe.id).toBe(r.id);
    expect(manifest.listing.content.variants).toHaveLength(2);
    expect(new Set(manifest.mockupSources.map((m: { skuId: string }) => m.skuId)).size).toBe(2);
    expect(manifest.checksum).toBe(sealed.checksum);
    expect(Object.keys(zip.files).some((name) => name.startsWith("production/"))).toBe(true);
    await expect(packages.export(b, packageId)).rejects.toThrow();
    const tamperedRead = vi
      .spyOn(storage, "readPrivate")
      .mockResolvedValueOnce(Buffer.from("changed bytes"));
    try {
      await expect(packages.export(a, packageId)).rejects.toBeInstanceOf(ConflictException);
    } finally {
      tamperedRead.mockRestore();
    }
    await expect(
      withTenant(db.db, a, (tx) =>
        tx
          .update(salesPackageVersions)
          .set({ checksum: "0".repeat(64) })
          .where(eq(salesPackageVersions.id, packageId)),
      ),
    ).rejects.toThrow();
  }, 30000);

  it("matches at order time, requires an explicit push, and overrides artwork only on the order", async () => {
    const channelInput = {
      packageId,
      accountId,
      externalSku: "SHOP-001",
      externalListingId: "LISTING-001",
      effectiveFrom: new Date(Date.now() - 86400000).toISOString(),
      evidence: "Synthetic historic listing record",
      idempotencyKey: randomUUID(),
    };
    const binding = await packages.bind(a, channelInput);
    expect(await packages.bind(a, channelInput)).toEqual(binding);
    await expect(
      packages.bind(a, { ...channelInput, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(ConflictException);
    const external = `SALES-${createEntityId()}`,
      content = `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tSHOP-001\tSynthetic cover\t1\tUSD\t20.00`;
    const batch = await reports.importReport(a, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "synthetic-sales.tsv",
      content,
    });
    const line = (await reports.workspace(a, { batchId: batch.id })).lines[0]!;
    orderLineId = line.orderLineId;
    let detail = await work.detail(a, orderLineId);
    expect(detail.draft.salesRecipeVersionId).toBe(sales[0]!.id);
    expect(detail.draft.salesPackageId).toBe(packageId);
    expect(detail.line.artwork).toBe("not_pushed");
    detail = await work.save(a, orderLineId, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        artworkVersionId: otherArt.versionId,
        instructions: "Use alternate print for this order",
        designExecutor: "human",
      },
      status: "ready_to_push",
      reason: "Customer authorized alternate print",
      idempotencyKey: randomUUID(),
    });
    expect(detail.line.printSku).toBe(otherArt.code);
    expect(detail.line.skuCode).toBe("SHOP-001");
    expect(detail.line.artwork).toBe("not_pushed");
    const act = async (action: string) => {
      detail = await work.action(a, orderLineId, {
        action,
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        reason: "Synthetic handoff",
        idempotencyKey: randomUUID(),
      });
    };
    await act("push");
    expect(detail.line.artwork).toBe("queued");
    await act("start_artwork");
    const project = await editor.get(a, detail.line.editorProjectId!);
    expect(project.project.workSource?.workItemId).toBe(orderLineId);
    expect(project.project.catalogSource).toBeNull();
    const layer = project.version.document.layers.find((l) => l.id === "catalog_artwork")!;
    expect(layer.name).toBe(otherArt.code);
    expect((await catalog.detail(a, sales[0]!.skuId)).recipes[0]!.artwork.id).toBe(artwork.id);
    artwork = await register(artwork.code, await creativeVersion("#ddaa33"), 1);
    const revised = await catalog.revise(a, sales[0]!.skuId, {
      artworkVersionId: artwork.versionId,
      specificationVersionId: sales[0]!.specification.versionId,
      expectedVersion: 1,
      reason: "New master version",
      idempotencyKey: randomUUID(),
    });
    expect(revised.recipe.version).toBe(2);
    const historical = await work.detail(a, orderLineId);
    expect(historical.draft.salesRecipeVersionId).toBe(sales[0]!.id);
    expect(historical.draft.artworkVersionId).toBe(otherArt.versionId);
    const [pack] = await withTenant(db.db, a, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, packageId)),
    );
    expect(fingerprint(pack!.snapshot)).toBe(pack!.checksum);
  }, 60000);

  it("pins structured creative requirements and refuses foreign references and changed retries", async () => {
    const input = {
      requestId: randomUUID(),
      name: "Template requirements",
      prompt: "Reusable pet border",
      referenceAssetIds: [],
      templateKey: "freeform",
      requirements: {
        mode: "personalized_text",
        audience: "Pet owners",
        acceptance: "Keep border intact",
        specificationVersionIds: [specifications[0]!.versionId],
        customization: {
          version: 1,
          fields: [{ key: "name", label: "宠物名字", type: "short_text", required: true }],
        },
        layout: [
          { fieldKey: "name", xPercent: 10, yPercent: 75, widthPercent: 80, heightPercent: 15 },
        ],
      },
    };
    const brief = await bridge.create(a, input);
    expect((await bridge.get(a, brief.id)).workflow?.requirements?.audience).toBe("Pet owners");
    expect(brief.designInstructions).toContain("Keep border intact");
    expect((await bridge.create(a, input)).id).toBe(brief.id);
    await expect(
      bridge.create(a, { ...input, requirements: { ...input.requirements, audience: "changed" } }),
    ).rejects.toThrow();
    await expect(bridge.create(b, input)).rejects.toThrow();
    await expect(
      bridge.create(a, {
        ...input,
        requestId: randomUUID(),
        requirements: {
          ...input.requirements,
          researchItemIds: [createEntityId()],
        },
      }),
    ).rejects.toThrow();
  });

  it("dispatches a direct print and SPU specification into a private template draft without a sales recipe", async () => {
    const creativeVersionId = await creativeVersion("#339977");
    const input = {
      code: "DIRECT-CUSTOM",
      name: "Reusable pet template",
      mode: "personalized_text",
      creativeVersionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      materials: [{ assetId: otherArt.assetId, role: "decoration", usage: "Reusable decoration" }],
      customization: {
        version: 1,
        fields: [
          {
            key: "pet_name",
            label: "宠物名字",
            type: "short_text",
            required: true,
            validation: { maxLength: 30 },
          },
        ],
      },
      layout: [
        { fieldKey: "pet_name", xPercent: 10, yPercent: 75, widthPercent: 80, heightPercent: 15 },
      ],
    };
    await expect(
      catalog.registerArtwork(a, {
        ...input,
        materials: [{ assetId: createEntityId(), role: "source", usage: "Foreign source" }],
      }),
    ).rejects.toThrow();
    const custom = (await catalog.registerArtwork(a, input)).artwork;
    expect(custom.materials).toHaveLength(2);
    expect(custom.materials[0]).toMatchObject({
      role: "master",
      assetId: custom.assetId,
      assetVersion: 1,
    });
    const external = `DIRECT-${createEntityId()}`;
    const batch = await reports.importReport(a, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "direct-template.tsv",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tUNMAPPED\tSynthetic custom\t1\tUSD\t20.00`,
    });
    const id = (await reports.workspace(a, { batchId: batch.id })).lines[0]!.orderLineId;
    let detail = await work.detail(a, id);
    for (const partial of [{ artworkVersionId: createEntityId() }, { specificationVersionId: createEntityId() }]) {
      await expect(work.save(a, id, { expectedRevision: 0,
        expectedSourceVersionId: detail.report?.versionId ?? null,
        draft: { ...detail.draft, ...partial }, status: "pending_review",
        reason: "Reject an invalid partial selection", idempotencyKey: randomUUID(),
      })).rejects.toThrow();
    }
    expect((await work.detail(a, id)).line.revision).toBe(0);
    detail = await work.save(a, id, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        salesRecipeVersionId: null,
        salesPackageId: null,
        artworkVersionId: custom.versionId,
        specificationVersionId: specifications[0]!.versionId,
        printProfileVersionId: profileVersionId,
        designExecutor: "agent",
        fields: [{ key: "pet_name", label: "宠物名字", value: "Luna", kind: "text" }],
      },
      status: "ready_to_push",
      reason: "Operations confirms direct match",
      idempotencyKey: randomUUID(),
    });
    expect(detail.line).toMatchObject({ artwork: "not_pushed", editorProjectId: null });
    const plan = await work.templatePlan(a, id);
    expect(plan).toMatchObject({ ready: true, revision: detail.line.revision, artworkVersionId: custom.versionId, templateVersionId: detail.profile!.sourceVersionId });
    expect(plan.mappings).toEqual([expect.objectContaining({ fieldKey: "pet_name", value: "Luna" })]);
    expect((await work.detail(a, id)).line).toMatchObject({ artwork: "not_pushed", editorProjectId: null });
    await expect(work.templatePlan(b, id)).rejects.toThrow();
    const action = {
      action: "push",
      expectedRevision: detail.line.revision,
      expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Dispatch template executor",
      idempotencyKey: randomUUID(),
    };
    detail = await work.action(a, id, action);
    expect(detail.line.artwork).toBe("in_progress");
    expect((await work.action(a, id, action)).line.editorProjectId).toBe(
      detail.line.editorProjectId,
    );
    const project = await editor.get(a, detail.line.editorProjectId!);
    expect(project.project.workSource?.workItemId).toBe(id);
    expect(project.version.document.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "catalog_artwork", name: custom.code }),
        expect.objectContaining({ id: "custom_pet_name", text: "Luna" }),
      ]),
    );
    expect(project.version.document.confirmations.visualReview).toBe(false);
    expect(project.images.some((i) => i.name.includes("Reusable decoration"))).toBe(true);
    const material = await work.artworkMaterial(a, id, otherArt.assetId!);
    expect(material.body.byteLength).toBeGreaterThan(0);
    await expect(work.artworkMaterial(b, id, otherArt.assetId!)).rejects.toThrow();
    await expect(work.artworkMaterial(a, id, artwork.assetId!)).rejects.toThrow();
    const revised = (
      await catalog.registerArtwork(a, {
        ...input,
        expectedVersion: 1,
        creativeVersionId: await creativeVersion("#7700aa"),
        idempotencyKey: randomUUID(),
      })
    ).artwork;
    expect(revised.version).toBe(2);
    expect((await work.detail(a, id)).draft.artworkVersionId).toBe(custom.versionId);
    await expect(
      withTenant(db.db, a, (tx) =>
        tx
          .update(artworkMasterVersions)
          .set({ materials: [] })
          .where(eq(artworkMasterVersions.id, custom.versionId)),
      ),
    ).rejects.toThrow();
  }, 60000);

  it("registers a masterless customer plan, retains versioned materials and creates a private order without template sample layers", async () => {
    const input = {
      code: "CUSTOM-NO-MASTER", name: "Customer photo pillow", mode: "customer_image", creativeVersionId: null,
      expectedVersion: 0, idempotencyKey: randomUUID(), instructions: "Remove the background and preserve the customer subject. Review before production.",
      customization: { version: 1, fields: [{ key: "buyer_photo", label: "顾客原图", type: "image", required: true,
        validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 32000000 } }] },
      materials: [{ assetId: otherArt.assetId!, role: "decoration", usage: "Optional fixture decoration" }], layout: [],
    };
    for (const patch of [{ mode: "fixed" }, { customization: {version: 1, fields: []} }, { instructions: "" }, {materials: [{assetId: createEntityId(), role: "source", usage: "Foreign"}]}])
      await expect(catalog.registerArtwork(a, {...input, ...patch, idempotencyKey: randomUUID()})).rejects.toThrow();
    await expect(catalog.registerArtwork({...a, permissions: [Permission.ProductWrite]}, input)).rejects.toThrow();
    const registered = await catalog.registerArtwork(a, input);
    expect(await catalog.registerArtwork(a, input)).toEqual(registered);
    const custom = registered.artwork;
    expect(custom).toMatchObject({assetId: null, assetVersion: null, creativeVersionId: null, archived: false});
    expect(custom.materials).toHaveLength(1);
    expect((await catalog.options(a)).artworks.some(a => a.id === custom.id)).toBe(true);
    await expect(withTenant(db.db, b, tx => readArtwork(tx, custom.versionId))).rejects.toThrow();
    const combined = await catalog.combine(a, {artworkVersionId: custom.versionId, items: [{specificationVersionId: specifications[0]!.versionId, skuCode: "CUSTOM-NO-MASTER-SALE"}], idempotencyKey: randomUUID()});
    expect(combined.recipes[0]!.status).toBe("pending_adaptation");
    await expect(recipes.action(a, combined.recipes[0]!.id, {action:"start_adaptation",reason:"Needs order photo",idempotencyKey:randomUUID()})).rejects.toThrow("没有固定主图");
    const planAction = {action:"confirm_customization_plan",reason:"Confirm reusable instructions and process, awaiting private buyer image",idempotencyKey:randomUUID()};
    await expect(recipes.action(b, combined.recipes[0]!.id, planAction)).rejects.toThrow();
    await expect(recipes.action({...a,permissions:[Permission.ProductWrite]}, combined.recipes[0]!.id, planAction)).rejects.toThrow();
    const confirmed = await recipes.action(a, combined.recipes[0]!.id, planAction);
    expect(await recipes.action(a, combined.recipes[0]!.id, planAction)).toEqual(confirmed);
    expect(confirmed.recipe).toMatchObject({status:"ready_for_customization",editorProjectId:null,editorVersionId:null,renderId:null,designVersionId:null});
    expect((await catalog.workspace(a,{q:"CUSTOM-NO-MASTER-SALE",status:"ready_for_customization"})).total).toBe(1);
    expect((await withTenant(db.db,a,tx=>orderSalesChoices(tx))).recipes.some(recipe=>recipe.id===confirmed.recipe.id)).toBe(true);
    await expect(recipes.action(a,confirmed.recipe.id,{...planAction,idempotencyKey:randomUUID()})).rejects.toThrow("不可覆盖");
    const external = `MASTERLESS-${createEntityId()}`;
    const batch = await reports.importReport(a, {accountId, marketplaceId:"ATVPDKIKX0DER", fileName:"masterless.tsv",
      content:`order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tUNMAPPED\tSynthetic custom\t1\tUSD\t20.00`});
    const id = (await reports.workspace(a,{batchId:batch.id})).lines[0]!.orderLineId;
    let detail = await work.detail(a,id);
    const draft = {...detail.draft, salesRecipeVersionId:confirmed.recipe.id, artworkVersionId:custom.versionId, specificationVersionId:specifications[0]!.versionId, printProfileVersionId:profileVersionId, designExecutor:"human"};
    await expect(work.save(a,id,{expectedRevision:0,expectedSourceVersionId:detail.report?.versionId??null,draft,status:"ready_to_push",reason:"Missing buyer photo",idempotencyKey:randomUUID()})).rejects.toThrow("必填定制内容");
    detail = await work.save(a,id,{expectedRevision:0,expectedSourceVersionId:detail.report?.versionId??null,draft,status:"pending_review",reason:"Create private draft before uploading buyer photo",idempotencyKey:randomUUID()});
    detail = await work.upload(a,id,"buyer.png",image);
    const uploaded = detail.assets[0]!;
    detail = await work.save(a,id,{expectedRevision:detail.line.revision,expectedSourceVersionId:detail.report?.versionId??null,
      draft:{...draft,images:[{origin:"upload",key:uploaded.id,usage:"顾客原图"}]},status:"ready_to_push",reason:"Confirmed image purpose",idempotencyKey:randomUUID()});
    const act = (action:string) => work.action(a,id,{action,expectedRevision:detail.line.revision,expectedProjectionVersion:detail.line.projectionVersion,reason:"Masterless test",idempotencyKey:randomUUID()});
    detail = await act("push");
    detail = await act("start_artwork");
    const project = await editor.get(a,detail.line.editorProjectId!);
    expect(project.project.workSource?.workItemId).toBe(id);
    expect(project.version.document.layers).toEqual([]);
    expect(project.version.document.confirmations.visualReview).toBe(false);
    expect(project.images.some(i=>i.name.includes("buyer.png"))).toBe(true);
    expect(project.images.some(i=>i.name.includes("Optional fixture decoration"))).toBe(true);
    expect(project.images.some(i=>i.name==="process.png")).toBe(false);
    expect((await work.artworkMaterial(a,id,otherArt.assetId!)).body.length).toBeGreaterThan(0);
    await expect(work.artworkMaterial(b,id,otherArt.assetId!)).rejects.toThrow();
    const revision = await catalog.registerArtwork(a,{...input,expectedVersion:1,materials:[],idempotencyKey:randomUUID()});
    expect(revision.artwork).toMatchObject({id:custom.id,version:2,materials:[],assetId:null});
    expect((await work.detail(a,id)).draft.artworkVersionId).toBe(custom.versionId);
    expect((await withTenant(db.db,a,tx=>readArtwork(tx,custom.versionId))).materials).toHaveLength(1);
  },60000);

  it("archives and restores artwork without deleting immutable versions or historical SKU relationships", async () => {
    const art = await register("ARCHIVE-MASTER", await creativeVersion("#2244cc"));
    const combined = await catalog.combine(a,{artworkVersionId:art.versionId,items:[{specificationVersionId:specifications[0]!.versionId,skuCode:"ARCHIVE-SALE"}],idempotencyKey:randomUUID()});
    const input = {archived:true,expectedVersion:art.version,reason:"Unused fixture",idempotencyKey:randomUUID()};
    await expect(catalog.archiveArtwork(b,art.id,input)).rejects.toThrow();
    await expect(catalog.archiveArtwork({...a,permissions:[]},art.id,input)).rejects.toThrow();
    await expect(catalog.archiveArtwork(a,art.id,{...input,expectedVersion:2})).rejects.toThrow("版本已变化");
    const archived = await catalog.archiveArtwork(a,art.id,input);
    expect(await catalog.archiveArtwork(a,art.id,input)).toEqual(archived);
    expect(archived.artwork).toMatchObject({id:art.id,versionId:art.versionId,archived:true});
    const options = await catalog.options(a);
    expect(options.artworks.some(a=>a.id===art.id)).toBe(false);
    expect(options.archivedArtworks?.some(a=>a.id===art.id)).toBe(true);
    expect((await withTenant(db.db,a,tx=>orderSalesChoices(tx))).artworks.some(a=>a.id===art.versionId)).toBe(false);
    expect((await withTenant(db.db,a,tx=>readRecipe(tx,combined.recipes[0]!.id))).artwork.versionId).toBe(art.versionId);
    await expect(catalog.combine(a,{artworkVersionId:art.versionId,items:[{specificationVersionId:specifications[1]!.versionId,skuCode:"ARCHIVED-BLOCKED"}],idempotencyKey:randomUUID()})).rejects.toThrow("已归档");
    await expect(register(art.code,art.creativeVersionId!,1)).rejects.toThrow("已归档");
    const restored = await catalog.archiveArtwork(a,art.id,{...input,archived:false,reason:"Restore fixture",idempotencyKey:randomUUID()});
    expect(restored.artwork).toMatchObject({versionId:art.versionId,archived:false});
    expect((await catalog.options(a)).artworks.some(a=>a.id===art.id)).toBe(true);
    await expect(catalog.archiveArtwork(a,art.id,{...input,archived:false})).rejects.toThrow("请求编号");
  });

  it("keeps failed material preparation queued with an event and permits an explicit retry", async () => {
    const external = `FAILURE-${createEntityId()}`;
    const batch = await reports.importReport(a, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "retry-template.tsv",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tUNMAPPED\tSynthetic fixed\t1\tUSD\t20.00`,
    });
    const id = (await reports.workspace(a, { batchId: batch.id })).lines[0]!.orderLineId;
    let detail = await work.detail(a, id);
    detail = await work.save(a, id, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: {
        ...detail.draft,
        artworkVersionId: otherArt.versionId,
        specificationVersionId: specifications[0]!.versionId,
        printProfileVersionId: profileVersionId,
        designExecutor: "human",
      },
      status: "ready_to_push",
      reason: "Ready",
      idempotencyKey: randomUUID(),
    });
    const act = (action: string) =>
      work.action(a, id, {
        action,
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        reason: "Retry QA",
        idempotencyKey: randomUUID(),
      });
    detail = await act("push");
    const altered = vi.spyOn(storage, "readPrivate").mockResolvedValueOnce(Buffer.from("tampered"));
    try {
      await expect(act("start_artwork")).rejects.toThrow("内容已变化");
    } finally {
      altered.mockRestore();
    }
    detail = await work.detail(a, id);
    expect(detail.line.artwork).toBe("queued");
    expect(detail.events.some((e) => e.action === "artwork_failed")).toBe(true);
    detail = await act("start_artwork");
    expect(detail.line.artwork).toBe("in_progress");
  }, 60000);
});
