import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { SaveProductSpecificationSchema } from "@yummyai/contracts/catalog/development";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { productSpecifications, productSpecificationVersions } from "@yummyai/database";
import { mutateDevelopment } from "./development-data.js";
import { randomUUID, createHash } from "node:crypto";
import { ConflictException } from "@nestjs/common";
import { erpPermissions, Permission } from "@yummyai/authz";
import { SecretVault } from "@yummyai/ai-core";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  createEntityId,
  type TenantContext,
  type ProductionEditorDocument,
  type ProductionEditorImageView,
  ProductionImageEditOptionsSchema,
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
  productStyles,
  spus,
  skus,
  assetFiles,
  canvasPrintSpecVersions,
  marketplaceAccounts,
  artworkMasterVersions,
  salesRecipeVersions,
  salesSkuDefinitions,
  salesPackageVersions,
  salesChannelBindings,
  developmentEvents,
  productionEditorRenders,
  productionEditorProjects,
  productionRenderDispatchTenants,
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
  organizationTeams,
  memberships,
  roles,
  membershipRoles,
  researchItems,
  loadCurrentMembershipContext,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { JobEnvelopeSchema, createQueue, enqueueJob, type QueueNameValue } from "@yummyai/jobs";
import { eq, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { createDefaultProductionDocument } from "@yummyai/production-editor/products";
import { encryptProductionBytes } from "@yummyai/production-editor";
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
import { dispatchApprovedProductionRenders, RedisProductionRenderDispatcher } from "../../../worker/src/processors/production-render-dispatcher.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesRecipeService } from "./sales-recipe.service.js";
import { SalesPackageService } from "./sales-package.service.js";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { fingerprint, readSpecification, readArtwork, readRecipe } from "./development-data.js";
import {
  orderSalesChoices,
  validateOrderSalesBasis,
  resolveOrderSalesBasis,
} from "./order-sales-basis.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { CustomSalesSkuMappingSchema } from "@yummyai/contracts/catalog/composition";
import { AssistCatalogContextService } from "../ai/assist-catalog-context.service.js";
import { KnowledgeService } from "../knowledge/knowledge.service.js";
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
    bridge = new CanvasBridgeService(db, storage, audit, creative, { scan });
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
  const editorRoleId = createEntityId();
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
  async function creativeVersion(color: string, pixels = 512, context = a) {
    const png = await sharp({
      create: { width: pixels, height: pixels, channels: 4, background: color },
    })
      .png()
      .toBuffer();
    const brief = await bridge.create(context, {
      requestId: randomUUID(),
      name: "Synthetic artwork",
      prompt: "Original synthetic test shape",
      referenceAssetIds: [],
    });
    const result = await bridge.submit(context, brief.id, {
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
    await creative.reviewCreativeVersion(context, result.versionId, { decision: "approve" });
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
      await withTenant(db.db, c, async (tx) => {
        const membershipId = createEntityId();
        await tx.insert(memberships).values({ id: membershipId, tenantId: c.tenantId, userId: c.userId, status: "active" });
        const roleId = c === a ? editorRoleId : createEntityId();
        await tx.insert(roles).values({ id: roleId, tenantId: c.tenantId, name: `Synthetic editor ${roleId}`, permissions: Object.values(Permission), dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: c.tenantId, membershipId, roleId });
      });
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
      await tx.insert(modelProviderConfigs).values({
        id: providerId,
        tenantId: a.tenantId,
        provider: "openai-compatible",
        label: "Synthetic image provider",
        endpoint: "https://example.test/v1",
        encryptedApiKey: "synthetic-unused-encrypted-key",
        createdBy: a.userId,
      });
      await tx.insert(modelRoutes).values({
        id: createEntityId(),
        tenantId: a.tenantId,
        modelKey: "synthetic-image",
        taskType: "studio_image",
        targets: [
          { providerConfigId: providerId, providerModel: "gpt-image-2.5", timeoutMs: 600000 },
        ],
      });
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
              facts: syntheticSpecificationFacts({
                material: "Synthetic fabric",
                dimensions: "50mm",
                packageContents: "One cover",
                packageQuantity: 1,
                factsConfirmed: true,
              }),
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

  it("keeps the current recipe private instead of substituting an older readable version", async () => {
    const teamId = createEntityId(),
      membershipId = createEntityId(),
      roleId = createEntityId();
    await withTenant(db.db, a, async (tx) => {
      await tx.insert(organizationTeams).values({
        id: teamId,
        tenantId: a.tenantId,
        name: "Synthetic recipe readers " + teamId,
        createdBy: a.userId,
      });
      await tx
        .insert(memberships)
        .values({ id: membershipId, tenantId: a.tenantId, userId: b.userId, status: "active" });
      await tx.insert(roles).values({
        id: roleId,
        tenantId: a.tenantId,
        name: "Synthetic recipe role " + roleId,
        permissions: [Permission.ProductRead, Permission.DesignRead, Permission.AssetRead],
        dataScope: "team",
      });
      await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId, roleId });
      const { organizationTeamMembers } = await import("@yummyai/database");
      await tx.insert(organizationTeamMembers).values({
        id: createEntityId(),
        tenantId: a.tenantId,
        teamId,
        membershipId,
        createdBy: a.userId,
      });
    });
    const reader = await new DatabaseMembershipContextLoader(db).load({
      sub: b.userId,
      tenant_id: a.tenantId,
    });
    if (!reader) throw Error("Synthetic reader missing");
    const { spu } = await catalog.createSpu(a, {
      code: "PRIVATE-RECIPE-" + teamId.slice(-8),
      name: "Synthetic team carrier",
      teamId,
      idempotencyKey: randomUUID(),
    });
    const { specification } = await catalog.saveSpecification(a, {
      spuId: spu.id,
      code: "DEFAULT",
      name: "Synthetic scope specification",
      attributes: { size: "50mm" },
      facts: specifications[0]!.facts,
      processProfileVersionId: profileVersionId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const makeArt = (code: string, shared: boolean) =>
      catalog.registerArtwork(a, {
        code,
        name: code,
        mode: "personalized_text",
        ...(shared ? { teamId } : {}),
        customization: {
          version: 1,
          fields: [{ key: "name", label: "Name", type: "short_text", required: true }],
        },
        instructions: "Synthetic text placement",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
    const shared = (await makeArt("SHARED-" + teamId.slice(-8), true)).artwork,
      privateArt = (await makeArt("PRIVATE-" + teamId.slice(-8), false)).artwork;
    const first = (
      await catalog.combine(a, {
        artworkVersionId: shared.versionId,
        items: [
          {
            specificationVersionId: specification.versionId,
            skuCode: "SCOPED-" + teamId.slice(-8),
          },
        ],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    expect((await catalog.detail(reader, first.skuId)).item.recipe?.id).toBe(first.id);
    expect((await catalog.workspace(reader, { spuId: spu.id })).total).toBe(1);
    expect((await catalog.workspace(reader, { spuId: spu.id, page: 999 })).total).toBe(1);
    await expect(
      catalog.revise(a, first.skuId, {
        artworkVersionId: privateArt.versionId,
        specificationVersionId: specification.versionId,
        expectedVersion: 1,
        reason: "Synthetic private replacement",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("更换印花身份");
    // Imported legacy history can contain a different artwork identity. It must
    // not make the older readable recipe appear to be the current version.
    await withTenant(db.db, a, async (tx) => {
      const [previous] = await tx
        .select()
        .from(salesRecipeVersions)
        .where(eq(salesRecipeVersions.id, first.id));
      await tx.insert(salesRecipeVersions).values({
        ...previous!,
        id: createEntityId(),
        versionNumber: 2,
        artworkVersionId: privateArt.versionId,
      });
      await tx
        .update(salesSkuDefinitions)
        .set({ versionNumber: 2 })
        .where(eq(salesSkuDefinitions.skuId, first.skuId));
    });
    await expect(catalog.detail(reader, first.skuId)).rejects.toMatchObject({ status: 404 });
    expect((await catalog.workspace(reader, { spuId: spu.id })).items).toEqual([]);
    expect((await catalog.detail(a, first.skuId)).recipes.map((recipe) => recipe.version)).toEqual([
      2, 1,
    ]);
  });

  it("saves size drafts without a process and prevents production until a new verified version is supplied", async () => {
    const { spu } = await catalog.createSpu(a, {
      code: "SIZE-DRAFTS",
      name: "Synthetic size drafts",
      idempotencyKey: randomUUID(),
    });
    const items = [10, 12].map((size) => ({
      code: `${size}IN`,
      name: `${size} inch`,
      attributes: { size: `${size} inch` },
      facts: {
        ...specifications[0]!.facts,
        dimensions: `${size} inch nominal longest side; factory tolerance pending`,
        factsConfirmed: false,
      },
      processProfileVersionId: null,
    }));
    const input = { spuId: spu.id, items, idempotencyKey: randomUUID() };
    await expect(catalog.createSpecifications(b, input)).rejects.toThrow();
    await expect(catalog.createSpecifications({ ...a, permissions: [] }, input)).rejects.toThrow();
    const first = await catalog.createSpecifications(a, input);
    expect(await catalog.createSpecifications(a, input)).toEqual(first);
    const draft = first.specifications[0]!;
    expect(draft).toMatchObject({
      processProfileVersionId: null,
      productType: null,
      facts: { factsConfirmed: false },
    });
    expect(
      (await catalog.options(a)).specifications.filter((item) => item.spuId === spu.id),
    ).toHaveLength(2);
    expect(
      (await withTenant(db.db, a, (tx) => orderSalesChoices(tx, a))).specifications.some(
        (item) => item.id === draft.versionId,
      ),
    ).toBe(false);
    await expect(
      catalog.combine(a, {
        artworkVersionId: artwork.versionId,
        items: [{ specificationVersionId: draft.versionId, skuCode: "DRAFT-MUST-NOT-PRODUCE" }],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("规格仍为草稿");
    await expect(
      withTenant(db.db, a, (tx) =>
        validateOrderSalesBasis(tx, {
          artworkVersionId: artwork.versionId,
          specificationVersionId: draft.versionId,
          printProfileVersionId: null,
        } as Parameters<typeof validateOrderSalesBasis>[1]),
      ),
    ).rejects.toThrow("规格仍为草稿");
    await expect(
      catalog.saveSpecification(a, {
        ...items[0],
        spuId: spu.id,
        facts: { ...items[0]!.facts, factsConfirmed: true },
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("只能保存未确认");
    const ready = await catalog.saveSpecification(a, {
      ...items[0],
      spuId: spu.id,
      processProfileVersionId: profileVersionId,
      facts: { ...items[0]!.facts, factsConfirmed: true },
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(ready.specification).toMatchObject({
      id: draft.id,
      version: 2,
      processProfileVersionId: profileVersionId,
    });
    expect(
      await withTenant(db.db, a, (tx) => readSpecification(tx, draft.versionId)),
    ).toMatchObject({ version: 1, processProfileVersionId: null });
    expect(
      (await withTenant(db.db, a, (tx) => orderSalesChoices(tx, a))).specifications.some(
        (item) => item.id === ready.specification.versionId,
      ),
    ).toBe(true);
  });

  it("specification facts V2 persist unknown drafts and require a measured confirmation with a server actor", async () => {
    const { spu } = await catalog.createSpu(a, { code: "FACTS-V2-" + randomUUID(), name: "Synthetic unmeasured product", idempotencyKey: randomUUID() });
    const base = { spuId: spu.id, code: "UNMEASURED", name: "Unmeasured sample", attributes: { sample: "A" }, processProfileVersionId: profileVersionId };
    const unknown = { formatVersion: 2, material: "", dimensions: "", packageContents: "", packageQuantity: null, factsConfirmed: false };
    const saved = await catalog.saveSpecification(a, { ...base, facts: unknown, expectedVersion: 0, idempotencyKey: randomUUID() });
    expect(saved.specification.facts).toEqual(unknown);
    expect(saved.specification.factVerification).toBeNull();
    const versionsBefore = await withTenant(db.db, a, tx => tx.select().from(productSpecificationVersions).where(eq(productSpecificationVersions.specificationId, saved.specification.id)));
    for (const facts of [{ ...unknown, factsConfirmed: true }, syntheticSpecificationFacts({ packagedWeightGrams: 100 })]) {
      await expect(catalog.saveSpecification(a, { ...base, facts, expectedVersion: 1, idempotencyKey: randomUUID() })).rejects.toThrow(/事实未完成确认/);
    }
    expect(await withTenant(db.db, a, tx => tx.select().from(productSpecificationVersions).where(eq(productSpecificationVersions.specificationId, saved.specification.id)))).toEqual(versionsBefore);
    const facts = syntheticSpecificationFacts({ physicalDimensions: { basis: "artwork_longest", unit: "in", length: 10, width: null, height: null }, verificationReference: "Synthetic measurement sheet V2" });
    const confirmed = await catalog.saveSpecification(a, { ...base, facts, expectedVersion: 1, idempotencyKey: randomUUID() });
    expect(confirmed.specification.factVerification).toEqual({ confirmedByUserId: a.userId, confirmedAt: confirmed.specification.createdAt, reference: facts.verificationReference });
    expect(confirmed.specification.facts.dimensions).toContain("10 in");
    await expect(catalog.saveSpecification(a, { ...base, facts: { ...facts, confirmedByUserId: b.userId }, expectedVersion: 2, idempotencyKey: randomUUID() })).rejects.toThrow();
    const changed = await catalog.saveSpecification(a, { ...base, facts: { ...facts, material: "Synthetic changed construction", factsConfirmed: false }, expectedVersion: 2, idempotencyKey: randomUUID() });
    expect(changed.specification.factVerification).toBeNull();
    expect((await withTenant(db.db, a, tx => readSpecification(tx, confirmed.specification.versionId))).facts).toEqual(facts);
    await expect(catalog.combine(a, { artworkVersionId: artwork.versionId, items: [{ specificationVersionId: changed.specification.versionId, skuCode: "FACTS-UNCONFIRMED-" + randomUUID() }], idempotencyKey: randomUUID() })).rejects.toThrow(/商品事实尚未确认/);
  });

  it("specification facts V2 roll back a whole batch when one measured confirmation is incomplete", async () => {
    const { spu } = await catalog.createSpu(a, { code: "FACTS-BATCH-" + randomUUID(), name: "Synthetic atomic measurement batch", idempotencyKey: randomUUID() });
    const input = { spuId: spu.id, idempotencyKey: randomUUID(), items: ["A", "B"].map(code => ({ code, name: code, attributes: { sample: code }, processProfileVersionId: profileVersionId, facts: syntheticSpecificationFacts() })) };
    input.items[1]!.facts.packageMeasurements = null;
    await expect(catalog.createSpecifications(a, input)).rejects.toThrow(/包装外尺寸/);
    expect((await catalog.options(a)).specifications.filter(row => row.spuId === spu.id)).toEqual([]);
    expect(await withTenant(db.db, a, tx => tx.select().from(developmentEvents).where(eq(developmentEvents.idempotencyKey, input.idempotencyKey)))).toEqual([]);
    input.items[1]!.facts = syntheticSpecificationFacts({ physicalDimensions: { basis: "artwork_longest", unit: "cm", length: 30.48, width: null, height: null } });
    const saved = await catalog.createSpecifications(a, input);
    expect(saved.specifications.map(row => row.facts.physicalDimensions?.length)).toEqual([254, 30.48]);
    expect(saved.specifications.every(row => row.factVerification?.confirmedByUserId === a.userId)).toBe(true);
    expect(await catalog.createSpecifications(a, input)).toEqual(saved);
  });

  it("specification facts V2 retain legacy snapshots and original receipts while blocking new work until a new confirmation", async () => {
    const { spu } = await catalog.createSpu(a, { code: "FACTS-LEGACY-" + randomUUID(), name: "Synthetic pre-V2 facts", idempotencyKey: randomUUID() });
    const specificationId = createEntityId(), versionId = createEntityId();
    // This fixture represents an already committed pre-V2 record, not a new write through today's API.
    const legacyFacts = { material: "Legacy fabric", dimensions: "10 inch old record", packageContents: "One", packageQuantity: 1, factsConfirmed: true };
    await withTenant(db.db, a, async tx => {
      await tx.insert(productSpecifications).values({ id: specificationId, tenantId: a.tenantId, spuId: spu.id, code: "LEGACY", versionNumber: 1, createdBy: a.userId });
      await tx.insert(productSpecificationVersions).values({ id: versionId, tenantId: a.tenantId, specificationId, versionNumber: 1, name: "Legacy size", attributes: { sample: "legacy" }, facts: legacyFacts, processProfileVersionId: profileVersionId, createdBy: a.userId });
    });
    const originalRequest = SaveProductSpecificationSchema.parse({ spuId: spu.id, code: "LEGACY", name: "Legacy size", attributes: { sample: "legacy" }, facts: legacyFacts, processProfileVersionId: profileVersionId, expectedVersion: 0, idempotencyKey: randomUUID() });
    const original = await mutateDevelopment(db, a, { access: { kind: "spu", id: spu.id, permissions: [Permission.ProductWrite] }, key: originalRequest.idempotencyKey, action: "specification.save", resourceId: specificationId, reason: originalRequest.name, input: originalRequest }, async tx => {
      const old = await readSpecification(tx, versionId);
      const legacyReceipt = { ...old };
      delete legacyReceipt.factVerification;
      return { specification: legacyReceipt };
    });
    expect(await catalog.saveSpecification(a, originalRequest)).toEqual(original);
    const historical = await withTenant(db.db, a, tx => readSpecification(tx, versionId));
    expect(historical.facts).toEqual(legacyFacts);
    expect(historical.factVerification).toBeNull();
    expect((await withTenant(db.db, a, tx => orderSalesChoices(tx, a))).specifications.some(row => row.id === versionId)).toBe(false);
    expect((await withTenant(db.db, a, tx => orderSalesChoices(tx, a, versionId, artwork.versionId))).specifications.some(row => row.id === versionId)).toBe(true);
    const pinnedDraft = OrderWorkDraftSchema.parse({ artworkVersionId: artwork.versionId, specificationVersionId: versionId, printProfileVersionId: profileVersionId, fields: [], images: [], instructions: "", customerApprovalRequired: false, dueAt: null });
    expect((await withTenant(db.db, a, tx => validateOrderSalesBasis(tx, pinnedDraft)))?.specification.versionId).toBe(versionId);
    await expect(withTenant(db.db, a, tx => validateOrderSalesBasis(tx, pinnedDraft, false, undefined, undefined, true))).rejects.toThrow(/新匹配/);
    await expect(catalog.combine(a, { artworkVersionId: artwork.versionId, items: [{ specificationVersionId: versionId, skuCode: "LEGACY-NEW-" + randomUUID() }], idempotencyKey: randomUUID() })).rejects.toThrow(/旧规格/);
    const updated = await catalog.saveSpecification(a, { ...originalRequest, expectedVersion: 1, facts: syntheticSpecificationFacts({ verificationReference: "Synthetic explicit remeasurement" }), idempotencyKey: randomUUID() });
    expect(updated.specification.version).toBe(2);
    expect(updated.specification.factVerification?.confirmedByUserId).toBe(a.userId);
    expect(await catalog.saveSpecification(a, originalRequest)).toEqual(original);
    expect((await withTenant(db.db, a, tx => readSpecification(tx, versionId))).facts).toEqual(legacyFacts);
  });

  it("excludes archived parents and SPUs from reusable product and specification choices while retaining history", async () => {
    const products = new ProductService(new DrizzleCatalogRepository(db));
    for (const archiveTarget of ["plan", "spu"] as const) {
      const { spu } = await catalog.createSpu(a, {
        code: `ARCHIVE-${archiveTarget}`,
        name: "Synthetic archived product",
        idempotencyKey: randomUUID(),
      });
      const { specification } = await catalog.saveSpecification(a, {
        spuId: spu.id,
        code: "DEFAULT",
        name: "Synthetic archived specification",
        attributes: { size: "fixture" },
        facts: specifications[0]!.facts,
        processProfileVersionId: profileVersionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      const before = await catalog.options(a);
      expect(before.spus.some((item) => item.id === spu.id)).toBe(true);
      expect(before.specifications.some((item) => item.id === specification.id)).toBe(true);
      if (archiveTarget === "plan") await products.transition(a, spu.productPlanId, "archived");
      else
        await withTenant(db.db, a, (tx) =>
          tx.update(spus).set({ status: "archived" }).where(eq(spus.id, spu.id)),
        );
      const after = await catalog.options(a);
      expect(after.spus.some((item) => item.id === spu.id)).toBe(false);
      expect(after.specifications.some((item) => item.id === specification.id)).toBe(false);
      const historical = (await products.listPlans(a)).find(
        (item) => item.id === spu.productPlanId,
      );
      expect(historical?.spu?.id).toBe(spu.id);
      expect((await catalog.options(a)).spus).toEqual(
        expect.arrayContaining(spuIds.map((id) => expect.objectContaining({ id }))),
      );
    }
  });

  it("removes archived SKUs and archived product children from list counts and searches while retaining version history", async () => {
    const products = new ProductService(new DrizzleCatalogRepository(db));
    const prefix = "ARCHIVE-LIST-";
    const fixtures = [];
    const keep = await products.createSku(a, {
      spuId: spuIds[0]!,
      code: `${prefix}KEEP`,
      attributes: { size: "legacy" },
    });
    for (const target of ["plan", "spu", "sku"] as const) {
      const { spu } = await catalog.createSpu(a, {
        code: `${prefix}${target}`,
        name: "Synthetic list archive fixture",
        idempotencyKey: randomUUID(),
      });
      const { specification } = await catalog.saveSpecification(a, {
        spuId: spu.id,
        code: "DEFAULT",
        name: "Synthetic list specification",
        attributes: { size: "fixture" },
        facts: specifications[0]!.facts,
        processProfileVersionId: profileVersionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      const {
        recipes: [recipe],
      } = await catalog.combine(a, {
        artworkVersionId: artwork.versionId,
        items: [
          { specificationVersionId: specification.versionId, skuCode: `${prefix}${target}-MAPPED` },
        ],
        idempotencyKey: randomUUID(),
      });
      const legacy = await products.createSku(a, {
        spuId: spu.id,
        code: `${prefix}${target}-LEGACY`,
        attributes: { size: "legacy" },
      });
      fixtures.push({ target, spu, recipe: recipe!, legacy });
    }
    const initial = await catalog.workspace(a, { q: prefix, pageSize: 2, page: 2 });
    expect(initial.total).toBe(7);
    expect(initial.items).toHaveLength(2);
    for (const fixture of fixtures) {
      if (fixture.target === "plan")
        await products.transition(a, fixture.spu.productPlanId, "archived");
      else if (fixture.target === "spu")
        await withTenant(db.db, a, (tx) =>
          tx.update(spus).set({ status: "archived" }).where(eq(spus.id, fixture.spu.id)),
        );
      else
        await withTenant(db.db, a, (tx) =>
          tx
            .update(skus)
            .set({ status: "archived" })
            .where(inArray(skus.id, [fixture.recipe.skuId, fixture.legacy.id])),
        );
      expect((await catalog.workspace(a, { spuId: fixture.spu.id })).total).toBe(0);
      expect(
        (await catalog.workspace(a, { q: fixture.recipe.skuCode, status: "pending_adaptation" }))
          .total,
      ).toBe(0);
      const historical = await catalog.detail(a, fixture.recipe.skuId);
      expect(historical.recipes[0]!.id).toBe(fixture.recipe.id);
      expect((await catalog.detail(a, fixture.legacy.id)).item.skuCode).toBe(fixture.legacy.code);
      await expect(catalog.detail(b, fixture.recipe.skuId)).rejects.toThrow();
    }
    for (const status of ["all", "unmapped"]) {
      const current = await catalog.workspace(a, { q: prefix, status, pageSize: 2 });
      expect(current.total).toBe(1);
      expect(current.items.map((i) => i.skuId)).toEqual([keep.id]);
    }
    expect((await catalog.workspace(b, { q: prefix })).total).toBe(0);
  });

  async function independentCompositionArtwork(code: string) {
    return (
      await catalog.registerArtwork(a, {
        code: code + "-ART",
        name: "Synthetic independent composition source",
        mode: "personalized_text",
        customization: {
          version: 1,
          fields: [{ key: "name", label: "Name", type: "short_text", required: true }],
        },
        instructions: "Synthetic text placement for isolated identity and lifecycle checks",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    ).artwork;
  }
  for (const first of ["legacy", "explicit"] as const)
    it(
      "treats default single print as one identity regardless of " + first + " transport",
      async () => {
        const code = "CANONICAL-" + first.toUpperCase(),
          { spu } = await catalog.createSpu(a, {
            code,
            name: "Synthetic canonical composition",
            idempotencyKey: randomUUID(),
          });
        const print = await independentCompositionArtwork(code);
        const { specification } = await catalog.saveSpecification(a, {
          spuId: spu.id,
          code: "DEFAULT",
          name: "Synthetic canonical specification",
          attributes: { size: "fixture" },
          facts: specifications[0]!.facts,
          processProfileVersionId: profileVersionId,
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
        });
        const legacy = { artworkVersionId: print.versionId },
          explicit = {
            printBindings: [
              {
                key: "primary",
                artworkVersionId: print.versionId,
                surface: "front",
                region: "whole",
                area: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
                fieldMappings: [],
              },
            ],
          };
        const original = {
            ...(first === "legacy" ? legacy : explicit),
            items: [{ specificationVersionId: specification.versionId, skuCode: code + "-FIRST" }],
            idempotencyKey: randomUUID(),
          },
          created = await catalog.combine(a, original),
          recipe = created.recipes[0]!;
        await expect(
          catalog.combine(a, {
            ...(first === "legacy" ? explicit : legacy),
            items: [
              { specificationVersionId: specification.versionId, skuCode: code + "-DUPLICATE" },
            ],
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(await catalog.combine(a, original)).toEqual(created);
        const revised = await catalog.revise(a, recipe.skuId, {
          ...explicit,
          specificationVersionId: specification.versionId,
          expectedVersion: 1,
          reason: "Synthetic compatible transport revision",
          idempotencyKey: randomUUID(),
        });
        expect(revised.recipe.version).toBe(2);
        expect(revised.recipe.styleId).toBe(recipe.styleId);
        expect(
          (await withTenant(db.db, a, (tx) => readRecipe(tx, recipe.id))).printBindings,
        ).toEqual(recipe.printBindings);
        expect((await catalog.workspace(a, { spuId: spu.id })).total).toBe(1);
      },
    );

  it("recognizes old hashed default styles without rewriting duplicate historical SKU identities", async () => {
    const code = "HISTORICAL-DEFAULT",
      print = await independentCompositionArtwork(code),
      { spu } = await catalog.createSpu(a, {
        code,
        name: "Synthetic legacy-compatible style",
        idempotencyKey: randomUUID(),
      });
    const specs = [];
    for (const key of ["ONE", "TWO"]) {
      const { specification } = await catalog.saveSpecification(a, {
        spuId: spu.id,
        code: key,
        name: "Synthetic compatibility specification",
        attributes: { size: key },
        facts: specifications[0]!.facts,
        processProfileVersionId: profileVersionId,
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      });
      specs.push(specification);
    }
    const original = (
      await catalog.combine(a, {
        artworkVersionId: print.versionId,
        items: [{ specificationVersionId: specs[0]!.versionId, skuCode: code + "-CANONICAL" }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    const products = new ProductService(new DrizzleCatalogRepository(db)),
      legacy = await products.createSku(a, {
        spuId: spu.id,
        code: code + "-IMPORTED",
        attributes: specs[0]!.attributes,
      }),
      styleId = createEntityId(),
      recipeId = createEntityId();
    // Isolated import of the duplicate identity produced by the old explicit-single transport.
    await withTenant(db.db, a, async (tx) => {
      const [definition] = await tx
          .select()
          .from(salesSkuDefinitions)
          .where(eq(salesSkuDefinitions.skuId, original.skuId)),
        [recipe] = await tx
          .select()
          .from(salesRecipeVersions)
          .where(eq(salesRecipeVersions.id, original.id));
      if (!definition || !recipe) throw Error("Synthetic native prerequisite missing");
      const binding = {
        key: "primary",
        surface: "front",
        region: "whole",
        area: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
        fieldMappings: [],
        artworkId: print.id,
      };
      await tx
        .insert(productStyles)
        .values({
          id: styleId,
          tenantId: a.tenantId,
          createdBy: a.userId,
          artworkId: print.id,
          spuId: spu.id,
          compositionKey: fingerprint([binding]),
        });
      await tx
        .insert(salesSkuDefinitions)
        .values({ ...definition, id: createEntityId(), skuId: legacy.id, styleId });
      await tx.insert(salesRecipeVersions).values({ ...recipe, id: recipeId, skuId: legacy.id });
    });
    const historical = await catalog.detail(a, legacy.id);
    for (const source of [
      { artworkVersionId: print.versionId },
      { printBindings: [{ key: "primary", artworkVersionId: print.versionId, surface: "front" }] },
    ])
      await expect(
        catalog.combine(a, {
          ...source,
          items: [{ specificationVersionId: specs[0]!.versionId, skuCode: code + "-THIRD" }],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    const added = (
      await catalog.combine(a, {
        artworkVersionId: print.versionId,
        items: [{ specificationVersionId: specs[1]!.versionId, skuCode: code + "-SECOND-SIZE" }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    expect(added.styleId).toBe(original.styleId);
    expect((await catalog.detail(a, legacy.id)).recipes).toEqual(historical.recipes);
    expect(historical.recipes[0]).toMatchObject({ id: recipeId, styleId });
  });

  for (const target of ["plan", "spu", "sku"] as const)
    it(
      "rejects new composition and recipe writes for archived " +
        target +
        " while retaining original receipts",
      async () => {
        const code = "COMPOSITION-ARCHIVE-" + target.toUpperCase(),
          products = new ProductService(new DrizzleCatalogRepository(db)),
          { spu } = await catalog.createSpu(a, {
            code,
            name: "Synthetic lifecycle source",
            idempotencyKey: randomUUID(),
          });
        const print = await independentCompositionArtwork(code);
        const specs = [];
        for (const key of ["ONE", "TWO"]) {
          const { specification } = await catalog.saveSpecification(a, {
            spuId: spu.id,
            code: key,
            name: "Synthetic lifecycle specification",
            attributes: { size: key },
            facts: specifications[0]!.facts,
            processProfileVersionId: profileVersionId,
            expectedVersion: 0,
            idempotencyKey: randomUUID(),
          });
          specs.push(specification);
        }
        const original = {
            artworkVersionId: print.versionId,
            items: [{ specificationVersionId: specs[0]!.versionId, skuCode: code + "-MAPPED" }],
            idempotencyKey: randomUUID(),
          },
          created = await catalog.combine(a, original),
          recipe = created.recipes[0]!,
          legacy = await products.createSku(a, {
            spuId: spu.id,
            code: code + "-LEGACY",
            attributes: { size: "legacy" },
          });
        if (target === "plan") await products.transition(a, spu.productPlanId, "archived");
        else
          await withTenant(db.db, a, async (tx) => {
            if (target === "spu")
              await tx.update(spus).set({ status: "archived" }).where(eq(spus.id, spu.id));
            else
              await tx
                .update(skus)
                .set({ status: "archived" })
                .where(inArray(skus.id, [recipe.skuId, legacy.id]));
          });
        await expect(
          catalog.combine(a, {
            artworkVersionId: print.versionId,
            items: [
              {
                specificationVersionId: specs[1]!.versionId,
                skuCode: legacy.code,
                existingSkuId: legacy.id,
              },
            ],
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          catalog.revise(a, recipe.skuId, {
            artworkVersionId: print.versionId,
            specificationVersionId: specs[0]!.versionId,
            expectedVersion: 1,
            reason: "Synthetic archived source",
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
          recipes.action(a, recipe.id, {
            action: "start_adaptation",
            reason: "Synthetic archived source",
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(await catalog.combine(a, original)).toEqual(created);
        const historical = await catalog.detail(a, recipe.skuId);
        expect(historical.recipes[0]!.id).toBe(recipe.id);
        expect(historical.recipes).toHaveLength(1);
        expect(historical.lifecycle).toMatchObject({ active: false });
        expect((await catalog.workspace(a, { spuId: spu.id })).total).toBe(0);
      },
    );

  it("atomically binds multiple size/shape specifications, rejects duplicate combinations and keeps tenant/version boundaries", async () => {
    const { spu } = await catalog.createSpu(a, {
      code: "BATCH-SPECS",
      name: "Synthetic multi-option product",
      idempotencyKey: randomUUID(),
    });
    const items = [50, 60].flatMap((size, sizeIndex) =>
      ["圆形", "心形"].map((shape, shapeIndex) => ({
        code: `SIZE-${sizeIndex}-SHAPE-${shapeIndex}`,
        name: `${size} · ${shape}`,
        attributes: { 尺寸: String(size) + "mm", 形状: shape },
        facts: { ...specifications[0]!.facts, physicalDimensions: { basis: "diameter" as const, unit: "mm" as const, length: size, width: null, height: null } },
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
      "50 mm · 成品直径",
      "50 mm · 成品直径",
      "60 mm · 成品直径",
      "60 mm · 成品直径",
    ]);
    expect(first.specifications.map(spec => spec.facts.physicalDimensions?.length)).toEqual([50, 50, 60, 60]);
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

  async function catalogEditorFixture() {
    const token = randomUUID().slice(0, 8);
    const { spu } = await catalog.createSpu(a, { code: `EDITOR-${token}`, name: "Synthetic editor lifecycle", idempotencyKey: randomUUID() });
    const { specification } = await catalog.saveSpecification(a, { spuId: spu.id, code: "DEFAULT", name: "Synthetic editor source", attributes: { size: "fixture" }, facts: specifications[0]!.facts, processProfileVersionId: profileVersionId, expectedVersion: 0, idempotencyKey: randomUUID() });
    const master = await register(`EDITOR-ART-${token}`, await creativeVersion("#336699"));
    const combined = await catalog.combine(a, { artworkVersionId: master.versionId, items: [{ specificationVersionId: specification.versionId, skuCode: `EDITOR-SKU-${token}` }], idempotencyKey: randomUUID() });
    const started = await recipes.action(a, combined.recipes[0]!.id, { action: "start_adaptation", reason: "Synthetic lifecycle", idempotencyKey: randomUUID() });
    const project = await editor.get(a, started.recipe.editorProjectId!);
    const renderInput = { expectedVersionId: project.version.id, purpose: "preview" as const, format: "png" as const, background: "transparent" as const };
    const envelope = (renderId: string, requestedBy = a.userId) => JobEnvelopeSchema.parse({ jobId: createEntityId(), tenantId: a.tenantId, requestedBy, correlationId: renderId, idempotencyKey: renderId, payload: { renderId } });
    return { spu, recipe: started.recipe, project, renderInput, envelope };
  }

  for (const target of ["plan", "spu", "sku"] as const) {
    it(`catalog editor lifecycle stops ${target} archival bypasses and preserves original render bytes`, async () => {
      const f = await catalogEditorFixture(), id = f.project.project.id;
      const original = await editor.render(a, id, f.renderInput);
      await worker.process(f.envelope(original.id));
      const bytes = await editor.renderFile(a, id, original.id, "result");
      const queued = await editor.render(a, id, f.renderInput);
      if (target === "plan") await new ProductService(new DrizzleCatalogRepository(db)).transition(a, f.spu.productPlanId, "archived");
      else await withTenant(db.db, a, tx => target === "spu" ? tx.update(spus).set({ status: "archived" }).where(eq(spus.id, f.spu.id)) : tx.update(skus).set({ status: "archived" }).where(eq(skus.id, f.recipe.skuId)));
      await expect(editor.save(a, id, { expectedVersionId: f.project.version.id, document: f.project.version.document })).rejects.toBeInstanceOf(ConflictException);
      await expect(editor.render(a, id, f.renderInput)).rejects.toBeInstanceOf(ConflictException);
      await expect(editor.upload(a, id, "new.png", image, "image")).rejects.toBeInstanceOf(ConflictException);
      await expect(editor.review(a, id, f.project.version.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(worker.process(f.envelope(queued.id))).rejects.toThrow("production_catalog_source_archived");
      expect((await editor.renderFile(a, id, original.id, "result")).body).toEqual(bytes.body);
      expect((await editor.get(a, id)).project.catalogSource).toMatchObject({ active: false });
      expect(await worker.process(f.envelope(original.id))).toMatchObject({ disposition: "already_claimed" });
      const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, queued.id)));
      expect(row).toMatchObject({ status: "failed", encryptedManifest: null, errorCode: "production_catalog_source_archived" });
    });
  }

  it("catalog durable recovery discovers a queued preview with its original identity without an order directory entry", async () => {
    const f = await catalogEditorFixture();
    const render = await editor.render(a, f.project.project.id, f.renderInput);
    await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ updatedAt: sql`now() - interval '1 minute'` }).where(eq(productionEditorRenders.id, render.id)));
    const enqueue = vi.fn<(input: { renderId: string; tenantId: string; requestedBy: string }) => Promise<void>>(async () => undefined);
    await dispatchApprovedProductionRenders(db, vault, enqueue);
    expect(enqueue).toHaveBeenCalledWith({ renderId: render.id, tenantId: a.tenantId, requestedBy: a.userId });
  });

  it("catalog durable recovery retains the queued intent when initial transport fails", async () => {
    const f = await catalogEditorFixture();
    const offline = new ProductionEditorService(db, vault, storage, reports, audit, { enqueue: async () => { throw Error("Synthetic queue unavailable"); } }, { scan });
    const render = await offline.render(a, f.project.project.id, f.renderInput);
    expect(render).toMatchObject({ status: "queued", errorCode: "queue_unavailable", versionId: f.project.version.id });
  });

  it("catalog durable recovery restores the same database intent after the actual Redis delivery disappears", async () => {
    const f = await catalogEditorFixture(), id = f.project.project.id;
    const render = await editor.render(a, id, f.renderInput);
    const queue = createQueue(`catalog-recovery-${createEntityId()}` as QueueNameValue);
    const dispatcher = new RedisProductionRenderDispatcher(db, vault, queue);
    try {
      await enqueueJob(queue, "production-editor.render", f.envelope(render.id));
      expect(await queue.getWaitingCount()).toBe(1);
      // This queue belongs only to this test in the runner's disposable Redis.
      await queue.drain(true);
      expect(await queue.getWaitingCount()).toBe(0);
      await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ updatedAt: sql`now()-interval '1 minute'` }).where(eq(productionEditorRenders.id, render.id)));
      await Promise.all([dispatcher.dispatch(), dispatcher.dispatch()]);
      const delivered = (await queue.getWaiting()).filter(job => (job.data.payload as { renderId: string }).renderId === render.id);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.data).toMatchObject({ tenantId: a.tenantId, requestedBy: a.userId, correlationId: render.id, payload: { renderId: render.id } });
      expect(Object.keys(delivered[0]!.data.payload)).toEqual(["renderId"]);
      expect(await worker.process(JobEnvelopeSchema.parse(delivered[0]!.data))).toMatchObject({ disposition: "completed" });
      const original = await editor.renderFile(a, id, render.id, "result");
      expect(await sharp(original.body).metadata()).toMatchObject({ format: "png" });
      await queue.drain(true);
      await dispatcher.dispatch();
      expect((await queue.getWaiting()).some(job => (job.data.payload as { renderId: string }).renderId === render.id)).toBe(false);
      expect(await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.projectId, id)))).toHaveLength(1);
      expect((await editor.getRender(a, id, render.id)).versionId).toBe(f.project.version.id);
      expect((await editor.renderFile(a, id, render.id, "result")).body).toEqual(original.body);
    } finally { await queue.obliterate({ force: true }); await dispatcher.close(); }
  });

  it("catalog durable recovery preserves a live claim and recovers the original version only after lease expiry", async () => {
    const f = await catalogEditorFixture(), render = await editor.render(a, f.project.project.id, f.renderInput), token = createEntityId();
    await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ status: "processing", processingToken: token, leaseUntil: sql`now()+interval '2 minutes'`, updatedAt: sql`now()-interval '3 minutes'` }).where(eq(productionEditorRenders.id, render.id)));
    const enqueue = vi.fn<(input: { renderId: string; tenantId: string; requestedBy: string }) => Promise<void>>(async () => undefined);
    await dispatchApprovedProductionRenders(db, vault, enqueue);
    expect(enqueue.mock.calls.some(([input]) => input.renderId === render.id)).toBe(false);
    expect(await worker.process(f.envelope(render.id))).toMatchObject({ disposition: "already_claimed" });
    let [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
    expect(row).toMatchObject({ status: "processing", processingToken: token, encryptedManifest: null });
    await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ leaseUntil: sql`now()-interval '1 second'` }).where(eq(productionEditorRenders.id, render.id)));
    await dispatchApprovedProductionRenders(db, vault, enqueue);
    expect(enqueue).toHaveBeenCalledWith({ renderId: render.id, tenantId: a.tenantId, requestedBy: a.userId });
    expect(await worker.process(f.envelope(render.id))).toMatchObject({ disposition: "completed" });
    [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
    expect(row).toMatchObject({ versionId: f.project.version.id, processingToken: null, leaseUntil: null, status: "completed" });
  });

  it("catalog durable recovery renews an active database lease during storage and ignores a concurrent delivery", async () => {
    const f = await catalogEditorFixture(), render = await editor.render(a, f.project.project.id, f.renderInput);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const put = storage.putPrivate.bind(storage), spy = vi.spyOn(storage, "putPrivate").mockImplementation(async (context, input) => {
      if (input.fileName === `${render.id}-result.pe`) { entered(); await held; }
      return put(context, input);
    });
    const running = worker.process(f.envelope(render.id));
    try {
      await ready;
      const [initial] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
      expect(await worker.process(f.envelope(render.id))).toMatchObject({ disposition: "already_claimed" });
      await vi.waitFor(async () => {
        const [current] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
        expect(current!.processingToken).toBe(initial!.processingToken);
        expect(current!.leaseUntil!.getTime()).toBeGreaterThan(initial!.leaseUntil!.getTime());
      }, { timeout: 19_000, interval: 100 });
    } finally {
      release();
      try { await running; expect(spy).toHaveBeenCalledTimes(1); }
      finally { spy.mockRestore(); }
    }
    expect((await editor.getRender(a, f.project.project.id, render.id)).status).toBe("completed");
  });

  for (const fault of ["invalid_snapshot", "transport_failure"] as const) {
    it(`catalog durable recovery isolates ${fault} without starving another intent`, async () => {
      const f = await catalogEditorFixture();
      const bad = await editor.render(a, f.project.project.id, f.renderInput), good = await editor.render(a, f.project.project.id, f.renderInput);
      await withTenant(db.db, a, async tx => {
        await tx.update(productionEditorRenders).set({ updatedAt: sql`now()-interval '1 minute'` }).where(inArray(productionEditorRenders.id, [bad.id, good.id]));
        if (fault === "invalid_snapshot") await tx.update(productionEditorRenders).set({ encryptedOptions: "Synthetic invalid ciphertext" }).where(eq(productionEditorRenders.id, bad.id));
      });
      const enqueue = vi.fn(async (input: { renderId: string; tenantId: string; requestedBy: string }) => {
        if (fault === "transport_failure" && input.renderId === bad.id) throw Error("Synthetic queue unavailable");
      });
      await dispatchApprovedProductionRenders(db, vault, enqueue);
      expect(enqueue).toHaveBeenCalledWith({ renderId: good.id, tenantId: a.tenantId, requestedBy: a.userId });
      if (fault === "invalid_snapshot") expect(enqueue.mock.calls.some(([input]) => input.renderId === bad.id)).toBe(false);
      else {
        enqueue.mockClear();
        await dispatchApprovedProductionRenders(db, vault, enqueue);
        expect(enqueue.mock.calls.some(([input]) => input.renderId === bad.id || input.renderId === good.id)).toBe(false);
      }
    });
  }

  it("catalog durable recovery rejects a superseded storage result without failing the new claim", async () => {
    const f = await catalogEditorFixture(), render = await editor.render(a, f.project.project.id, f.renderInput), replacement = createEntityId();
    const put = storage.putPrivate.bind(storage), spy = vi.spyOn(storage, "putPrivate").mockImplementation(async (context, input) => {
      const result = await put(context, input);
      if (input.fileName === `${render.id}-result.pe`) await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ processingToken: replacement, leaseUntil: sql`now()+interval '2 minutes'` }).where(eq(productionEditorRenders.id, render.id)));
      return result;
    });
    try { await expect(worker.process(f.envelope(render.id))).rejects.toThrow("production_claim_lost"); }
    finally { spy.mockRestore(); }
    const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
    expect(row).toMatchObject({ status: "processing", processingToken: replacement, encryptedManifest: null, errorCode: null });
  });

  for (const status of ["queued", "processing", "failed"] as const) {
    it(`catalog durable recovery excludes ${status} paid image submissions from automatic replay`, async () => {
      const f = await catalogEditorFixture(), renderId = createEntityId();
      const options = ProductionImageEditOptionsSchema.parse({ purpose: "image_edit", modelId: createEntityId(), providerConfigId: createEntityId(), model: "synthetic-paid-route", sourceImageId: f.project.images[0]!.id, prompt: "Synthetic paid intent", size: "2048x2048" });
      await withTenant(db.db, a, async tx => {
        const [project] = await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, f.project.project.id));
        const key = vault.withSecret(project!.encryptedDataKey!, value => Buffer.from(value, "base64"));
        try { await tx.insert(productionEditorRenders).values({ id: renderId, tenantId: a.tenantId, projectId: project!.id, versionId: f.project.version.id, requestedBy: a.userId, status, errorCode: status === "failed" ? "queue_unavailable" : null, updatedAt: sql`now()-interval '3 minutes'`, encryptedOptions: encryptProductionBytes(key, Buffer.from(JSON.stringify(options))).toString("base64") }); }
        finally { key.fill(0); }
      });
      const enqueue = vi.fn<(input: { renderId: string; tenantId: string; requestedBy: string }) => Promise<void>>(async () => undefined);
      await dispatchApprovedProductionRenders(db, vault, enqueue);
      expect(enqueue.mock.calls.some(([input]) => input.renderId === renderId)).toBe(false);
      const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, renderId)));
      expect(row).toMatchObject({ status, processingToken: null, encryptedManifest: null });
    });
  }

  it("catalog durable recovery discovers a legacy transport failure and rechecks the original writer's current grant", async () => {
    const f = await catalogEditorFixture(), render = await editor.render(a, f.project.project.id, f.renderInput);
    await withTenant(db.db, a, tx => tx.update(productionEditorRenders).set({ status: "failed", errorCode: "queue_unavailable" }).where(eq(productionEditorRenders.id, render.id)));
    const enqueue = vi.fn<(input: { renderId: string; tenantId: string; requestedBy: string }) => Promise<void>>(async () => undefined);
    await dispatchApprovedProductionRenders(db, vault, enqueue);
    expect(enqueue).toHaveBeenCalledWith({ renderId: render.id, tenantId: a.tenantId, requestedBy: a.userId });
    await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission).filter(p => p !== Permission.ProductWrite) }).where(eq(roles.id, editorRoleId)));
    try { await expect(worker.process(f.envelope(render.id))).rejects.toThrow("production_catalog_access_revoked"); }
    finally { await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, editorRoleId))); }
    const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)));
    expect(row).toMatchObject({ status: "failed", encryptedManifest: null, requestedBy: a.userId, versionId: f.project.version.id });
  });

  it("catalog durable recovery registers routing only in the original tenant and keeps private render reads isolated", async () => {
    const f = await catalogEditorFixture(), render = await editor.render(a, f.project.project.id, f.renderInput);
    expect(await withTenant(db.db, a, tx => tx.select().from(productionRenderDispatchTenants).where(eq(productionRenderDispatchTenants.tenantId, a.tenantId)))).toHaveLength(1);
    await expect(withTenant(db.db, b, tx => tx.insert(productionRenderDispatchTenants).values({ tenantId: a.tenantId }))).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await withTenant(db.db, b, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, render.id)))).toEqual([]);
    await expect(editor.getRender(b, f.project.project.id, render.id)).rejects.toThrow();
  });

  it("catalog editor lifecycle checks the actual requester and current write grant before queued rendering", async () => {
    const f = await catalogEditorFixture(), id = f.project.project.id;
    const queued = await editor.render(a, id, f.renderInput);
    await expect(worker.process(f.envelope(queued.id, b.userId))).rejects.toThrow("production_render_owner_mismatch");
    await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission).filter(p => p !== Permission.ProductWrite) }).where(eq(roles.id, editorRoleId)));
    try {
      await expect(worker.process(f.envelope(queued.id))).rejects.toThrow("production_catalog_access_revoked");
      const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, queued.id)));
      expect(row).toMatchObject({ status: "failed", encryptedManifest: null, errorCode: "production_catalog_access_revoked" });
    } finally {
      await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, editorRoleId)));
    }
  });

  for (const invalidation of ["archive", "write_grant"] as const) {
    it(`catalog editor lifecycle refuses ${invalidation} invalidation during result storage without adopting a manifest`, async () => {
      const f = await catalogEditorFixture(), id = f.project.project.id;
      const queued = await editor.render(a, id, f.renderInput);
      const put = storage.putPrivate.bind(storage);
      const spy = vi.spyOn(storage, "putPrivate").mockImplementation(async (context, input) => {
        const stored = await put(context, input);
        if (input.fileName === `${queued.id}-result.pe`) {
          if (invalidation === "archive") await new ProductService(new DrizzleCatalogRepository(db)).transition(a, f.spu.productPlanId, "archived");
          else await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission).filter(p => p !== Permission.ProductWrite) }).where(eq(roles.id, editorRoleId)));
        }
        return stored;
      });
      try {
        const code = invalidation === "archive" ? "production_catalog_source_archived" : "production_catalog_access_revoked";
        await expect(worker.process(f.envelope(queued.id))).rejects.toThrow(code);
        const [row] = await withTenant(db.db, a, tx => tx.select().from(productionEditorRenders).where(eq(productionEditorRenders.id, queued.id)));
        expect(row).toMatchObject({ status: "failed", encryptedManifest: null, errorCode: code });
      } finally {
        spy.mockRestore();
        await withTenant(db.db, a, tx => tx.update(roles).set({ permissions: Object.values(Permission) }).where(eq(roles.id, editorRoleId)));
      }
    });
  }

  it("catalog editor lifecycle preserves tenant reads while a queued writer scope narrows to self", async () => {
    const f = await catalogEditorFixture(), userId = createEntityId(), roleId = createEntityId(), writerId = createEntityId(), memberId = createEntityId();
    await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic scoped editor')", [userId, userId, `${userId}@example.test`]);
    await withTenant(db.db, a, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: a.tenantId, userId, status: "active" });
      await tx.insert(roles).values([
        { id: roleId, tenantId: a.tenantId, name: `Synthetic reader ${roleId}`, permissions: Object.values(Permission).filter(p => p !== Permission.ProductWrite), dataScope: "tenant" },
        { id: writerId, tenantId: a.tenantId, name: `Synthetic writer ${writerId}`, permissions: [Permission.ProductWrite], dataScope: "tenant" },
      ]);
      await tx.insert(membershipRoles).values([{ tenantId: a.tenantId, membershipId: memberId, roleId }, { tenantId: a.tenantId, membershipId: memberId, roleId: writerId }]);
    });
    const actor = await withTenant(db.db, a, tx => loadCurrentMembershipContext(tx, { tenantId: a.tenantId, userId }));
    const queued = await editor.render(actor, f.project.project.id, f.renderInput);
    await withTenant(db.db, a, tx => tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, writerId)));
    await expect(editor.render(actor, f.project.project.id, f.renderInput)).rejects.toMatchObject({ status: 404 });
    await expect(worker.process(f.envelope(queued.id, userId))).rejects.toThrow("production_catalog_access_revoked");
    expect((await editor.get(actor, f.project.project.id)).project.id).toBe(f.project.project.id);
  });

  it("catalog editor lifecycle rechecks archived editor before recipe approval and resumes the same reviewed version explicitly", async () => {
    const f = await catalogEditorFixture(), id = f.project.project.id;
    const document = structuredClone(f.project.version.document); document.confirmations.visualReview = true;
    const saved = await editor.save(a, id, { expectedVersionId: f.project.version.id, document });
    await editor.review(a, id, saved.version.id);
    const render = await editor.render(a, id, { expectedVersionId: saved.version.id, purpose: "production", format: "png", background: "transparent" });
    await worker.process(f.envelope(render.id));
    const original = await editor.renderFile(a, id, render.id, "result");
    const [before] = await withTenant(db.db, a, tx => tx.select().from(salesRecipeVersions).where(eq(salesRecipeVersions.id, f.recipe.id)));
    const command = { action: "approve_adaptation", expectedEditorVersionId: saved.version.id, renderId: render.id, reason: "Synthetic explicit reviewed source", idempotencyKey: randomUUID() };
    await editor.archive(a, id, { archived: true, reason: "Synthetic archive before recipe review" });
    await expect(recipes.action(a, f.recipe.id, command)).rejects.toBeInstanceOf(ConflictException);
    const [after] = await withTenant(db.db, a, tx => tx.select().from(salesRecipeVersions).where(eq(salesRecipeVersions.id, f.recipe.id)));
    expect(after).toEqual(before);
    expect((await editor.renderFile(a, id, render.id, "result")).body).toEqual(original.body);
    await editor.archive(a, id, { archived: false, reason: "Synthetic explicit source restoration" });
    const approved = await recipes.action(a, f.recipe.id, command);
    expect(approved.recipe).toMatchObject({ status: "approved", editorVersionId: saved.version.id, renderId: render.id });
    expect((await editor.renderFile(a, id, render.id, "result")).body).toEqual(original.body);
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

  it("approves a shaped-pillow sales recipe using unchanged factory JPG pixels, sRGB and actual 150 DPI", async () => {
    const document = createDefaultProductionDocument("shaped_pillow");
    if (document.productType !== "shaped_pillow") throw new Error("Pillow fixture required");
    const mm = (pixels: number) => (pixels * 25.4) / 150;
    document.spec = {
      ...document.spec,
      widthMm: mm(1900),
      heightMm: mm(1900),
      declaredLongestMm: 254,
      sizeBasis: "artwork",
      minimumNeckBasis: "cut_contour",
      barcodeTab: { ...document.spec.barcodeTab, centerXMm: mm(950) },
    };
    document.contour = [
      { xMm: 0, yMm: 0, smooth: false },
      { xMm: mm(1900), yMm: 0, smooth: false },
      { xMm: mm(1900), yMm: mm(1900), smooth: false },
      { xMm: 0, yMm: mm(1900), smooth: false },
    ];
    document.confirmations = {
      physicalSize: true,
      whiteBorderRule: true,
      narrowParts: true,
      barcodeTab: true,
      backText: true,
      visualReview: true,
    };
    const template = await editor.create(a, { name: "Synthetic pillow sales template", document });
    await editor.review(a, template.project.id, template.version.id);
    const profile = (
      await work.saveProfile(a, {
        code: "PILLOW-SALES-JPG",
        name: "Synthetic reviewed pillow process",
        projectId: template.project.id,
        versionId: template.version.id,
        instructions: "Synthetic current factory JPG standard",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      })
    )[0]!;
    const { spu } = await catalog.createSpu(a, {
      code: "PILLOW-SALES",
      name: "Synthetic shaped pillow carrier",
      idempotencyKey: randomUUID(),
    });
    const { specification } = await catalog.saveSpecification(a, {
      spuId: spu.id,
      code: "10IN",
      name: "Synthetic 10 inch",
      attributes: { size: "10 inch" },
      facts: {
        ...specifications[0]!.facts,
        dimensions: "254 mm artwork longest side",
        weightGrams: 200,
        packagedWeightGrams: 500,
        factsConfirmed: true,
      },
      processProfileVersionId: profile.versionId,
      canvasPrintSpecVersionId: specId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    });
    const master = await register("PILLOW-JPG-MASTER", await creativeVersion("#416b97", 2048));
    const target = (
      await catalog.combine(a, {
        artworkVersionId: master.versionId,
        items: [{ specificationVersionId: specification.versionId, skuCode: "PILLOW-JPG-SALE" }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    const started = await recipes.action(a, target.id, {
      action: "start_adaptation",
      reason: "Synthetic formal pillow sales sample",
      idempotencyKey: randomUUID(),
    });
    let project = await editor.get(a, started.recipe.editorProjectId!);
    project.version.document.layers = project.version.document.layers.map((layer) => ({
      ...layer,
      xMm: mm(200),
      yMm: mm(200),
      widthMm: 254,
      heightMm: 254,
    }));
    project.version.document.confirmations = { ...document.confirmations };
    project = await editor.save(a, project.project.id, {
      expectedVersionId: project.version.id,
      document: project.version.document,
    });
    await editor.review(a, project.project.id, project.version.id);
    const render = await editor.render(a, project.project.id, {
      expectedVersionId: project.version.id,
      purpose: "production",
      format: "jpeg",
      background: "white",
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
    const completed = await editor.getRender(a, project.project.id, render.id),
      file = completed.files.find((file) => file.mediaType === "image/jpeg")!;
    expect(completed.preflight?.productionReady).toBe(true);
    const output = await editor.renderFile(a, project.project.id, render.id, file.key),
      metadata = await sharp(output.body).metadata();
    expect(metadata).toMatchObject({
      format: "jpeg",
      density: 150,
      space: "srgb",
      width: 4012,
      height: 2206,
    });
    expect(metadata.icc?.byteLength).toBeGreaterThan(0);
    const approved = await recipes.action(a, target.id, {
      action: "approve_adaptation",
      reason: "Synthetic operator verified exact JPG and manufacturing gates",
      expectedEditorVersionId: project.version.id,
      renderId: render.id,
      idempotencyKey: randomUUID(),
    });
    expect(approved.recipe).toMatchObject({
      status: "approved",
      editorVersionId: project.version.id,
      renderId: render.id,
    });
    const stored = await withTenant(db.db, a, (tx) =>
      tx
        .select()
        .from(assetFiles)
        .where(sql`${assetFiles.rightsMetadata}->>'salesRecipeId' = ${target.id}`),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      mediaType: "image/jpeg",
      checksumSha256: createHash("sha256").update(output.body).digest("hex"),
    });
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
    const knowledge = new KnowledgeService(db, audit);
    const knowledgeFields = {
      title: "Synthetic Listing 文案",
      summary: "Synthetic fixture only",
      body: "Listing 文案应说明定制流程，规格事实使用已确认的商品来源。",
      topic: "listing" as const,
      platform: "all" as const,
      market: "ALL",
      spuId: null,
      sourceType: "team" as const,
      sourceLabel: "Synthetic operator SOP",
      sourceUrl: "",
      owner: "Synthetic operator",
      verifiedOn: "2020-01-01",
      reviewDueOn: "2099-12-31",
      tags: ["Listing"],
    };
    const knowledgeEntry = await knowledge.save(a, null, {
      fields: knowledgeFields,
      expectedRevision: 0,
      reason: "Synthetic knowledge",
      requestId: randomUUID(),
    });
    await knowledge.change(a, knowledgeEntry.id, "submit", {
      expectedRevision: 1,
      version: 1,
      reason: "Synthetic review",
      requestId: randomUUID(),
    });
    await knowledge.change(a, knowledgeEntry.id, "publish", {
      expectedRevision: 2,
      version: 1,
      reason: "Synthetic publication",
      requestId: randomUUID(),
    });
    const assistant = new AssistCatalogContextService(
      new PodPersonalizationService(db, { enqueue: vi.fn() }, audit),
      packages,
      knowledge,
    );
    const aiRequest = {
      kind: "sku_package" as const,
      modelId: createEntityId(),
      requestId: randomUUID(),
      listingId: draft.listingId,
      expectedVersionId: draft.listingVersionId,
    };
    const aiBasis = await assistant.prepare(a, aiRequest);
    expect(aiBasis.knowledge?.find((ref) => ref.entryId === knowledgeEntry.id)).toMatchObject({
      version: 1,
      excerpt: knowledgeFields.body,
    });
    expect(aiBasis.sources.some((source) => source.id.startsWith("knowledge:"))).toBe(true);
    const knowledgePin = JSON.stringify(aiBasis.knowledge);
    await knowledge.save(a, knowledgeEntry.id, {
      fields: { ...knowledgeFields, body: "Synthetic Listing revised advice" },
      expectedRevision: 3,
      reason: "Synthetic v2",
      requestId: randomUUID(),
    });
    expect(
      (await assistant.prepare(a, aiRequest)).knowledge?.find(
        (ref) => ref.entryId === knowledgeEntry.id,
      )?.version,
    ).toBe(1);
    await knowledge.change(a, knowledgeEntry.id, "submit", {
      expectedRevision: 4,
      version: 2,
      reason: "Synthetic review v2",
      requestId: randomUUID(),
    });
    await knowledge.change(a, knowledgeEntry.id, "publish", {
      expectedRevision: 5,
      version: 2,
      reason: "Synthetic publish v2",
      requestId: randomUUID(),
    });
    expect(
      (await assistant.prepare(a, aiRequest)).knowledge?.find(
        (ref) => ref.entryId === knowledgeEntry.id,
      )?.version,
    ).toBe(2);
    expect(JSON.stringify(aiBasis.knowledge)).toBe(knowledgePin);
    expect(aiBasis.images).toHaveLength(2);
    expect(aiBasis.images.every((i) => i.dataUrl?.startsWith("data:image/jpeg;base64,"))).toBe(
      true,
    );
    expect(await assistant.stale(a, aiBasis)).toBe(false);
    const pinnedImage = (await packages.analysisBasis(a, draft.listingId, draft.listingVersionId))
      .images[0]!;
    await withTenant(db.db, a, (tx) =>
      tx.update(assetFiles).set({ deletedAt: new Date() }).where(eq(assetFiles.id, pinnedImage.id)),
    );
    try {
      await expect(packages.analysisImage(a, pinnedImage)).rejects.toThrow("源文件已变化");
      expect(await assistant.stale(a, aiBasis)).toBe(true);
    } finally {
      await withTenant(db.db, a, (tx) =>
        tx.update(assetFiles).set({ deletedAt: null }).where(eq(assetFiles.id, pinnedImage.id)),
      );
    }
    await expect(assistant.prepare(b, aiRequest)).rejects.toThrow();
    await expect(
      assistant.prepare(a, { ...aiRequest, expectedVersionId: createEntityId() }),
    ).rejects.toThrow("更新");
    expect((await listing.getWorkspace(a, draft.listingId)).version.id).toBe(
      draft.listingVersionId,
    );
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
    const outsideScope = { ...a, userId: b.userId, dataScope: "self" as const };
    await expect(packages.export(outsideScope, packageId)).rejects.toMatchObject({ status: 404 });
    await expect(
      packages.isCurrent(outsideScope, packageId, r.id, input.listingVersionId),
    ).rejects.toMatchObject({ status: 404 });
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

  it("previews exact effective intervals without writes and preserves future channel mappings", async () => {
    const source = {
      packageId,
      accountId,
      externalSku: "INTERVAL-SKU",
      externalListingId: "INTERVAL-LISTING",
      customChoice: {},
    };
    const bindAt = async (time: string) =>
      packages.bind(a, {
        ...source,
        effectiveFrom: time,
        evidence: "Synthetic timeline record",
        idempotencyKey: randomUUID(),
      });
    await bindAt("2026-01-01T00:00:00.000Z");
    await bindAt("2026-03-01T00:00:00.000Z");
    const count = () =>
      withTenant(db.db, a, async (tx) => ({
        bindings: (await tx.select().from(salesChannelBindings)).length,
        events: (await tx.select().from(developmentEvents)).length,
      }));
    const before = await count(),
      input = { ...source, effectiveFrom: "2026-02-01T00:00:00.000Z" };
    const preview = await packages.previewBinding(a, input);
    expect(preview).toMatchObject({
      status: "ready",
      canBind: true,
      effectiveUntil: "2026-03-01T00:00:00.000Z",
      previous: { effectiveFrom: "2026-01-01T00:00:00.000Z", package: { id: packageId } },
      next: { effectiveFrom: "2026-03-01T00:00:00.000Z", package: { id: packageId } },
    });
    expect(await count()).toEqual(before);
    const readOnly = {
      ...a,
      permissions: [
        Permission.ProductRead,
        Permission.DesignRead,
        Permission.ListingRead,
        Permission.StoreRead,
      ],
    };
    expect((await packages.previewBinding(readOnly, input)).canBind).toBe(false);
    await bindAt(input.effectiveFrom);
    expect(await packages.previewBinding(a, input)).toMatchObject({
      status: "conflict",
      effectiveUntil: "2026-03-01T00:00:00.000Z",
    });
    await expect(bindAt(input.effectiveFrom)).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await packages.previewBinding(a, { ...source, effectiveFrom: "2026-04-01T00:00:00.000Z" }))
        .previous,
    ).toMatchObject({ effectiveFrom: "2026-03-01T00:00:00.000Z" });
  });

  it("uses current Listing and shop read scopes for package counts and before a cached channel receipt", async () => {
    const userId = createEntityId(),
      membershipId = createEntityId(),
      roleId = createEntityId(),
      listingRole = createEntityId();
    await db.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic channel scope')",
      [userId, userId, userId + "@example.test"],
    );
    await withTenant(db.db, a, async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, tenantId: a.tenantId, userId, status: "active" });
      await tx.insert(roles).values({
        id: roleId,
        tenantId: a.tenantId,
        name: "Channel scope " + roleId,
        permissions: [
          Permission.ProductRead,
          Permission.DesignRead,
          Permission.ProductWrite,
          Permission.StoreRead,
          Permission.StoreManage,
          Permission.AssetRead,
        ],
        dataScope: "tenant",
      });
      await tx.insert(roles).values({
        id: listingRole,
        tenantId: a.tenantId,
        name: "Listing source " + listingRole,
        permissions: [Permission.ListingRead],
        dataScope: "tenant",
      });
      await tx.insert(membershipRoles).values([
        { tenantId: a.tenantId, membershipId, roleId },
        { tenantId: a.tenantId, membershipId, roleId: listingRole },
      ]);
    });
    const reader = await new DatabaseMembershipContextLoader(db).load({
      sub: userId,
      tenant_id: a.tenantId,
    });
    if (!reader) throw Error("missing scoped channel actor");
    const input = {
      packageId,
      accountId,
      externalSku: "SCOPED-CHANNEL",
      externalListingId: "SCOPED-LISTING",
      customChoice: {},
      effectiveFrom: "2026-01-15T00:00:00.000Z",
      evidence: "Synthetic source check before replay",
      idempotencyKey: randomUUID(),
    };
    const receipt = await packages.bind(reader, input);
    expect(await packages.bind(reader, input)).toEqual(receipt);
    expect(
      (await catalog.detail(reader, sales[0]!.skuId)).packages.some((p) => p.id === packageId),
    ).toBe(true);
    await withTenant(db.db, a, (tx) =>
      tx.update(roles).set({ dataScope: "self" }).where(eq(roles.id, listingRole)),
    );
    const hidden = await catalog.detail(reader, sales[0]!.skuId);
    expect(hidden.packages).toEqual([]);
    expect(hidden.item.packageCount).toBe(0);
    expect(hidden.channelBindings).toEqual([]);
    const workspace = await catalog.workspace(reader, { q: sales[0]!.skuCode });
    expect(workspace.items.find((item) => item.skuId === sales[0]!.skuId)?.packageCount).toBe(0);
    expect(
      (await catalog.workspace(reader, { q: sales[0]!.skuCode, status: "packaged" })).total,
    ).toBe(0);
    await expect(packages.previewBinding(reader, input)).rejects.toThrow();
    await expect(packages.bind(reader, input)).rejects.toThrow();
    await expect(packages.export(reader, packageId)).rejects.toThrow();
    await withTenant(db.db, a, async (tx) => {
      await tx.update(roles).set({ dataScope: "tenant" }).where(eq(roles.id, listingRole));
      await tx
        .update(roles)
        .set({
          permissions: [
            Permission.ProductRead,
            Permission.DesignRead,
            Permission.ProductWrite,
            Permission.StoreManage,
            Permission.AssetRead,
          ],
        })
        .where(eq(roles.id, roleId));
    });
    await expect(packages.bind(reader, input)).rejects.toThrow();
    const rows = await withTenant(db.db, a, (tx) =>
      tx
        .select()
        .from(salesChannelBindings)
        .where(eq(salesChannelBindings.externalSku, input.externalSku)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(receipt.bindingId);
  });

  it("shows shop timeline boundaries without revealing unreadable counterpart package metadata", async () => {
    const userId = createEntityId(),
      membershipId = createEntityId(),
      roleId = createEntityId(),
      listingRole = createEntityId(),
      visibleListing = createEntityId(),
      visibleVersion = createEntityId(),
      visiblePackage = createEntityId();
    await db.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic timeline reader')",
      [userId, userId, userId + "@example.test"],
    );
    await withTenant(db.db, a, async (tx) => {
      await tx
        .insert(memberships)
        .values({ id: membershipId, tenantId: a.tenantId, userId, status: "active" });
      await tx.insert(roles).values([
        {
          id: roleId,
          tenantId: a.tenantId,
          name: "Timeline read " + roleId,
          permissions: [Permission.ProductRead, Permission.DesignRead, Permission.StoreRead],
          dataScope: "tenant",
        },
        {
          id: listingRole,
          tenantId: a.tenantId,
          name: "Own Listing " + listingRole,
          permissions: [Permission.ListingRead],
          dataScope: "self",
        },
      ]);
      await tx.insert(membershipRoles).values([
        { tenantId: a.tenantId, membershipId, roleId },
        { tenantId: a.tenantId, membershipId, roleId: listingRole },
      ]);
      const [original] = await tx
        .select()
        .from(salesPackageVersions)
        .where(eq(salesPackageVersions.id, packageId));
      if (!original) throw Error("missing native sealed package");
      const [parent] = await tx.select().from(listings).where(eq(listings.id, original.listingId));
      const [version] = await tx
        .select()
        .from(listingVersions)
        .where(eq(listingVersions.id, original.listingVersionId));
      if (!parent || !version) throw Error("missing original Listing history");
      // Isolated imported ownership variation of the actual sealed prerequisite.
      await tx.insert(listings).values({
        ...parent,
        id: visibleListing,
        locale: "en-GB",
        primaryVersionId: null,
        createdBy: userId,
      });
      await tx
        .insert(listingVersions)
        .values({ ...version, id: visibleVersion, listingId: visibleListing });
      await tx
        .update(listings)
        .set({ primaryVersionId: visibleVersion })
        .where(eq(listings.id, visibleListing));
      const snapshot = {
        ...original.snapshot,
        locale: "en-GB",
        listing: {
          ...(original.snapshot.listing as Record<string, unknown>),
          id: visibleListing,
          versionId: visibleVersion,
        },
      };
      await tx.insert(salesPackageVersions).values({
        ...original,
        id: visiblePackage,
        listingId: visibleListing,
        listingVersionId: visibleVersion,
        locale: "en-GB",
        versionNumber: original.versionNumber + 300,
        snapshot,
        checksum: fingerprint(snapshot),
      });
    });
    const source = {
      accountId,
      externalSku: "REDACTED-TIMELINE",
      externalListingId: "REDACTED-LISTING",
      customChoice: {},
    };
    for (const effectiveFrom of ["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"])
      await packages.bind(a, {
        ...source,
        packageId,
        effectiveFrom,
        evidence: "Synthetic restricted counterpart",
        idempotencyKey: randomUUID(),
      });
    const reader = await new DatabaseMembershipContextLoader(db).load({
      sub: userId,
      tenant_id: a.tenantId,
    });
    if (!reader) throw Error("missing current timeline reader");
    const preview = await packages.previewBinding(reader, {
      ...source,
      packageId: visiblePackage,
      effectiveFrom: "2026-02-01T00:00:00.000Z",
    });
    expect(preview).toMatchObject({
      status: "ready",
      canBind: false,
      effectiveUntil: "2026-03-01T00:00:00.000Z",
      previous: { effectiveFrom: "2026-01-01T00:00:00.000Z", package: null },
      next: { effectiveFrom: "2026-03-01T00:00:00.000Z", package: null },
    });
    expect(JSON.stringify(preview)).not.toContain(packageId);
  });

  it("refuses corrupt immutable imported package snapshots before channel registration", async () => {
    const [original] = await withTenant(db.db, a, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, packageId)),
    );
    if (!original) throw Error("missing native sealed fixture");
    const corruptId = createEntityId();
    // Isolated historical-import fixture only: never mutate the native sealed original.
    await withTenant(db.db, a, (tx) =>
      tx.insert(salesPackageVersions).values({
        ...original,
        id: corruptId,
        versionNumber: original.versionNumber + 100,
        checksum: "0".repeat(64),
      }),
    );
    const input = {
      packageId: corruptId,
      accountId,
      externalSku: "CORRUPT-CHANNEL",
      externalListingId: "CORRUPT-LISTING",
      customChoice: {},
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    };
    await expect(packages.previewBinding(a, input)).rejects.toThrow("校验失败");
    await expect(
      packages.bind(a, {
        ...input,
        evidence: "Synthetic corrupt import",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("校验失败");
    expect(
      await withTenant(db.db, a, (tx) =>
        tx.select().from(salesChannelBindings).where(eq(salesChannelBindings.packageId, corruptId)),
      ),
    ).toHaveLength(0);
    expect(fingerprint(original.snapshot)).toBe(original.checksum);
  });

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

  it("matches inclusive order-time boundaries and retains a saved original package after a backdated mapping", async () => {
    const [original] = await withTenant(db.db, a, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, packageId)),
    );
    if (!original) throw Error("missing sealed package");
    const newer = createEntityId();
    // A duplicate immutable historical-import fixture, with unchanged reviewed content.
    await withTenant(db.db, a, (tx) =>
      tx
        .insert(salesPackageVersions)
        .values({ ...original, id: newer, versionNumber: original.versionNumber + 200 }),
    );
    const source = {
      accountId,
      externalSku: "PIN-TIMELINE",
      externalListingId: "PIN-LISTING",
      customChoice: {},
      evidence: "Synthetic as-of mapping",
    };
    const bind = async (pack: string, at: string) =>
      packages.bind(a, {
        ...source,
        packageId: pack,
        effectiveFrom: at,
        idempotencyKey: randomUUID(),
      });
    await bind(packageId, "2026-01-01T00:00:00.000Z");
    await bind(newer, "2026-03-01T00:00:00.000Z");
    const intake = async (at: string) => {
      const external = "PIN-" + createEntityId(),
        batch = await reports.importReport(a, {
          accountId,
          marketplaceId: "ATVPDKIKX0DER",
          fileName: "synthetic-time-pin.tsv",
          content:
            "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" +
            external +
            "\tLINE-1\t" +
            at +
            "\tPIN-TIMELINE\tSynthetic cover\t1\tUSD\t20.00",
        });
      return (await reports.workspace(a, { batchId: batch.id })).lines[0]!.orderLineId;
    };
    const oldLine = await intake("2026-02-28T23:59:59.999Z"),
      newLine = await intake("2026-03-01T00:00:00.000Z"),
      before = await intake("2025-12-31T23:59:59.999Z");
    expect((await work.detail(a, oldLine)).draft.salesPackageId).toBe(packageId);
    expect((await work.detail(a, newLine)).draft.salesPackageId).toBe(newer);
    expect((await withTenant(db.db, a, (tx) => resolveOrderSalesBasis(tx, before))).status).toBe(
      "unmatched",
    );
    let pinned = await work.detail(a, oldLine);
    pinned = await work.save(a, oldLine, {
      expectedRevision: pinned.line.revision,
      expectedSourceVersionId: pinned.report?.versionId ?? null,
      draft: { ...pinned.draft, instructions: "Synthetic original package accepted" },
      status: "pending_review",
      reason: "Synthetic pin before late mapping",
      idempotencyKey: randomUUID(),
    });
    await bind(newer, "2026-02-01T00:00:00.000Z");
    expect((await work.detail(a, oldLine)).draft.salesPackageId).toBe(packageId);
    expect(
      (await work.detail(a, await intake("2026-02-28T23:59:59.999Z"))).draft.salesPackageId,
    ).toBe(newer);
    const saved = await work.save(a, oldLine, {
      expectedRevision: pinned.line.revision,
      expectedSourceVersionId: pinned.report?.versionId ?? null,
      draft: { ...pinned.draft, instructions: "Synthetic follow-up retains original pin" },
      status: "pending_review",
      reason: "Synthetic historical basis retained",
      idempotencyKey: randomUUID(),
    });
    expect(saved.draft.salesPackageId).toBe(packageId);
    expect(saved.draft.salesRecipeVersionId).toBe(original.recipeId);
  });

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

  it("pins simultaneous regional prints, revises every component and preserves the old composition", async () => {
    const front = await register("COMPOSITION-FRONT", await creativeVersion("#d05544")),
      back = await register("COMPOSITION-REGION", await creativeVersion("#3355cc"));
    const bindings = [
      {
        key: "upper",
        artworkVersionId: front.versionId,
        surface: "front",
        region: "upper",
        area: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 50 },
      },
      {
        key: "lower",
        artworkVersionId: back.versionId,
        surface: "front",
        region: "lower",
        area: { xPercent: 0, yPercent: 50, widthPercent: 100, heightPercent: 50 },
      },
    ];
    const created = await catalog.combine(a, {
        printBindings: bindings,
        items: [
          { specificationVersionId: specifications[0]!.versionId, skuCode: "COMPOSITION-SALE" },
        ],
        idempotencyKey: randomUUID(),
      }),
      recipe = created.recipes[0]!;
    expect(recipe.printBindings?.map((b) => b.artworkVersionId)).toEqual([
      front.versionId,
      back.versionId,
    ]);
    expect(recipe.artwork.assetId).toBeNull();
    const started = await recipes.action(a, recipe.id, {
      action: "start_adaptation",
      reason: "Synthetic combined artwork adaptation",
      idempotencyKey: randomUUID(),
    });
    const project = await editor.get(a, started.recipe.editorProjectId!);
    expect(
      project.version.document.layers.filter((l) => l.id.startsWith("print_")).map((l) => l.name),
    ).toHaveLength(2);
    expect(project.version.document.layers.some((l) => l.id === "catalog_artwork")).toBe(false);
    expect(project.images).toHaveLength(2);
    const next = await register(front.code, await creativeVersion("#aa22bb"), 1);
    const revised = await catalog.revise(a, recipe.skuId, {
      expectedVersion: 1,
      specificationVersionId: recipe.specification.versionId,
      printBindings: bindings.map((b, i) => ({
        ...b,
        artworkVersionId: i === 0 ? next.versionId : b.artworkVersionId,
      })),
      reason: "Synthetic component version correction",
      idempotencyKey: randomUUID(),
    });
    expect(revised.recipe.printBindings?.map((b) => b.artworkVersionId)).toEqual([
      next.versionId,
      back.versionId,
    ]);
    expect(
      (await withTenant(db.db, a, (tx) => readRecipe(tx, recipe.id))).printBindings?.map(
        (b) => b.artworkVersionId,
      ),
    ).toEqual([front.versionId, back.versionId]);
    await expect(
      catalog.revise(a, recipe.skuId, {
        expectedVersion: 2,
        specificationVersionId: recipe.specification.versionId,
        printBindings: bindings.map((b) => ({ ...b, region: "changed" })),
        reason: "Change composition identity",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("新建销售 SKU");
  });

  it("groups pattern choices as Custom options on one physical SKU and resolves order-time choices without guessing", async () => {
    const artA = await register("CHOICE-A", await creativeVersion("#aa7733")),
      artB = await register("CHOICE-B", await creativeVersion("#4499aa"));
    const first = (
      await catalog.combine(a, {
        artworkVersionId: artA.versionId,
        items: [{ specificationVersionId: specifications[0]!.versionId, skuCode: "CHOICE-A-SALE" }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    const second = (
      await catalog.combine(a, {
        artworkVersionId: artB.versionId,
        items: [{ specificationVersionId: specifications[0]!.versionId, skuCode: "CHOICE-B-SALE" }],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    const plans = new SalesPlanService(db, listing),
      created = await plans.create(a, {
        spuId: first.specification.spuId,
        fields: {
          name: "Synthetic native Custom choices",
          mode: "custom",
          fulfillment: "fbm",
          marketplaceId: "ATVPDKIKX0DER",
          specificationIds: [first.specification.id],
          artworkVersionIds: [artA.versionId, artB.versionId],
          skuIds: [first.skuId, second.skuId],
          patternChoices: {
            fieldKey: "pattern",
            options: [
              { skuId: first.skuId, value: "a", label: "A" },
              { skuId: second.skuId, value: "b", label: "B" },
            ],
          },
        },
        idempotencyKey: randomUUID(),
      });
    const drafted = await plans.draft(a, created.plan.id, {
        expectedRevision: created.plan.revision,
        idempotencyKey: randomUUID(),
      }),
      content = (await listing.getWorkspace(a, drafted.listingId)).version.content;
    expect(content.variants).toHaveLength(1);
    const mapped = CustomSalesSkuMappingSchema.parse(
      JSON.parse(String(content.attributes.custom_sales_sku_mapping)),
    );
    expect(new Set(mapped.map((m) => m.platformSkuCode)).size).toBe(1);
    expect(mapped.map((m) => m.customChoice.pattern).sort()).toEqual(["a", "b"]);
    expect(
      (await catalog.detail(a, first.skuId)).listings.some((l) => l.id === drafted.listingId),
    ).toBe(true);
    // Legacy immutable packages also support explicit choices without rewriting their contents.
    for (const value of ["a", "b"])
      await packages.bind(a, {
        packageId,
        accountId,
        externalSku: "SYNTH-CHOICE",
        externalListingId: "CHOICE-LISTING",
        customChoice: { pattern: value },
        effectiveFrom: new Date(Date.now() - 86400000).toISOString(),
        evidence: "Synthetic historic Custom choice",
        idempotencyKey: randomUUID(),
      });
    const external = `CHOICE-${createEntityId()}`,
      report = await reports.importReport(a, {
        accountId,
        marketplaceId: "ATVPDKIKX0DER",
        fileName: "choice.tsv",
        content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tSYNTH-CHOICE\tSynthetic choices\t1\tUSD\t20.00`,
      });
    const id = (await reports.workspace(a, { batchId: report.id })).lines[0]!.orderLineId;
    expect((await withTenant(db.db, a, (tx) => resolveOrderSalesBasis(tx, id))).status).toBe(
      "unmatched",
    );
    expect(
      await withTenant(db.db, a, (tx) => resolveOrderSalesBasis(tx, id, { pattern: "b" })),
    ).toMatchObject({ status: "matched", packageId, customChoice: { pattern: "b" } });
    expect(
      (await withTenant(db.db, a, (tx) => resolveOrderSalesBasis(tx, id, { pattern: "unknown" })))
        .status,
    ).toBe("unmatched");
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
    for (const partial of [
      { artworkVersionId: createEntityId() },
      { specificationVersionId: createEntityId() },
    ]) {
      await expect(
        work.save(a, id, {
          expectedRevision: 0,
          expectedSourceVersionId: detail.report?.versionId ?? null,
          draft: { ...detail.draft, ...partial },
          status: "pending_review",
          reason: "Reject an invalid partial selection",
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow();
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
    expect(plan).toMatchObject({
      ready: true,
      revision: detail.line.revision,
      artworkVersionId: custom.versionId,
      templateVersionId: detail.profile!.sourceVersionId,
    });
    expect(plan.mappings).toEqual([
      expect.objectContaining({ fieldKey: "pet_name", value: "Luna" }),
    ]);
    expect((await work.detail(a, id)).line).toMatchObject({
      artwork: "not_pushed",
      editorProjectId: null,
    });
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
      code: "CUSTOM-NO-MASTER",
      name: "Customer photo pillow",
      mode: "customer_image",
      creativeVersionId: null,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      instructions:
        "Remove the background and preserve the customer subject. Review before production.",
      customization: {
        version: 1,
        fields: [
          {
            key: "buyer_photo",
            label: "顾客原图",
            type: "image",
            required: true,
            validation: { allowedMediaTypes: ["image/png"], maxFiles: 1, maxBytes: 32000000 },
          },
        ],
      },
      materials: [
        { assetId: otherArt.assetId!, role: "decoration", usage: "Optional fixture decoration" },
      ],
      layout: [],
    };
    for (const patch of [
      { mode: "fixed" },
      { customization: { version: 1, fields: [] } },
      { instructions: "" },
      { materials: [{ assetId: createEntityId(), role: "source", usage: "Foreign" }] },
    ])
      await expect(
        catalog.registerArtwork(a, { ...input, ...patch, idempotencyKey: randomUUID() }),
      ).rejects.toThrow();
    await expect(
      catalog.registerArtwork({ ...a, permissions: [Permission.ProductWrite] }, input),
    ).rejects.toThrow();
    const registered = await catalog.registerArtwork(a, input);
    expect(await catalog.registerArtwork(a, input)).toEqual(registered);
    const custom = registered.artwork;
    expect(custom).toMatchObject({
      assetId: null,
      assetVersion: null,
      creativeVersionId: null,
      archived: false,
    });
    expect(custom.materials).toHaveLength(1);
    expect((await catalog.options(a)).artworks.some((a) => a.id === custom.id)).toBe(true);
    await expect(withTenant(db.db, b, (tx) => readArtwork(tx, custom.versionId))).rejects.toThrow();
    const combined = await catalog.combine(a, {
      artworkVersionId: custom.versionId,
      items: [
        { specificationVersionId: specifications[0]!.versionId, skuCode: "CUSTOM-NO-MASTER-SALE" },
      ],
      idempotencyKey: randomUUID(),
    });
    expect(combined.recipes[0]!.status).toBe("pending_adaptation");
    await expect(
      recipes.action(a, combined.recipes[0]!.id, {
        action: "start_adaptation",
        reason: "Needs order photo",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("没有固定主图");
    const planAction = {
      action: "confirm_customization_plan",
      reason: "Confirm reusable instructions and process, awaiting private buyer image",
      idempotencyKey: randomUUID(),
    };
    await expect(recipes.action(b, combined.recipes[0]!.id, planAction)).rejects.toThrow();
    await expect(
      recipes.action(
        { ...a, permissions: [Permission.ProductWrite] },
        combined.recipes[0]!.id,
        planAction,
      ),
    ).rejects.toThrow();
    const confirmed = await recipes.action(a, combined.recipes[0]!.id, planAction);
    expect(await recipes.action(a, combined.recipes[0]!.id, planAction)).toEqual(confirmed);
    expect(confirmed.recipe).toMatchObject({
      status: "ready_for_customization",
      editorProjectId: null,
      editorVersionId: null,
      renderId: null,
      designVersionId: null,
    });
    expect(
      (
        await catalog.workspace(a, {
          q: "CUSTOM-NO-MASTER-SALE",
          status: "ready_for_customization",
        })
      ).total,
    ).toBe(1);
    expect(
      (await withTenant(db.db, a, (tx) => orderSalesChoices(tx, a))).recipes.some(
        (recipe) => recipe.id === confirmed.recipe.id,
      ),
    ).toBe(true);
    await expect(
      recipes.action(a, confirmed.recipe.id, { ...planAction, idempotencyKey: randomUUID() }),
    ).rejects.toThrow("不可覆盖");
    const external = `MASTERLESS-${createEntityId()}`;
    const batch = await reports.importReport(a, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "masterless.tsv",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}\tLINE-1\t${new Date().toISOString()}\tUNMAPPED\tSynthetic custom\t1\tUSD\t20.00`,
    });
    const id = (await reports.workspace(a, { batchId: batch.id })).lines[0]!.orderLineId;
    let detail = await work.detail(a, id);
    const draft = {
      ...detail.draft,
      salesRecipeVersionId: confirmed.recipe.id,
      artworkVersionId: custom.versionId,
      specificationVersionId: specifications[0]!.versionId,
      printProfileVersionId: profileVersionId,
      designExecutor: "human",
    };
    await expect(
      work.save(a, id, {
        expectedRevision: 0,
        expectedSourceVersionId: detail.report?.versionId ?? null,
        draft,
        status: "ready_to_push",
        reason: "Missing buyer photo",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("必填定制内容");
    detail = await work.save(a, id, {
      expectedRevision: 0,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft,
      status: "pending_review",
      reason: "Create private draft before uploading buyer photo",
      idempotencyKey: randomUUID(),
    });
    detail = await work.upload(a, id, "buyer.png", image);
    const uploaded = detail.assets[0]!;
    detail = await work.save(a, id, {
      expectedRevision: detail.line.revision,
      expectedSourceVersionId: detail.report?.versionId ?? null,
      draft: { ...draft, images: [{ origin: "upload", key: uploaded.id, usage: "顾客原图" }] },
      status: "ready_to_push",
      reason: "Confirmed image purpose",
      idempotencyKey: randomUUID(),
    });
    const act = (action: string) =>
      work.action(a, id, {
        action,
        expectedRevision: detail.line.revision,
        expectedProjectionVersion: detail.line.projectionVersion,
        reason: "Masterless test",
        idempotencyKey: randomUUID(),
      });
    detail = await act("push");
    detail = await act("start_artwork");
    const project = await editor.get(a, detail.line.editorProjectId!);
    expect(project.project.workSource?.workItemId).toBe(id);
    expect(project.version.document.layers).toEqual([]);
    expect(project.version.document.confirmations.visualReview).toBe(false);
    expect(project.images.some((i) => i.name.includes("buyer.png"))).toBe(true);
    expect(project.images.some((i) => i.name.includes("Optional fixture decoration"))).toBe(true);
    expect(project.images.some((i) => i.name === "process.png")).toBe(false);
    expect((await work.artworkMaterial(a, id, otherArt.assetId!)).body.length).toBeGreaterThan(0);
    await expect(work.artworkMaterial(b, id, otherArt.assetId!)).rejects.toThrow();
    const mixed = (
      await catalog.combine(a, {
        printBindings: [
          {
            key: "decoration",
            artworkVersionId: otherArt.versionId,
            surface: "front",
            region: "border",
            area: { xPercent: 0, yPercent: 0, widthPercent: 100, heightPercent: 100 },
            fieldMappings: [],
          },
          {
            key: "buyer",
            artworkVersionId: custom.versionId,
            surface: "front",
            region: "portrait",
            area: { xPercent: 20, yPercent: 20, widthPercent: 60, heightPercent: 60 },
            fieldMappings: [{ fieldKey: "buyer_photo", customerFieldKey: "portrait" }],
          },
        ],
        items: [
          { specificationVersionId: specifications[0]!.versionId, skuCode: "MIXED-CUSTOM-SALE" },
        ],
        idempotencyKey: randomUUID(),
      })
    ).recipes[0]!;
    const mixedReady = (
      await recipes.action(a, mixed.id, { ...planAction, idempotencyKey: randomUUID() })
    ).recipe;
    expect(mixedReady.artwork.customization.fields.map((field) => field.key)).toEqual(["portrait"]);
    const mixedBatch = await reports.importReport(a, {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      fileName: "mixed-private.tsv",
      content: `order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n${external}-MIXED\tLINE-1\t${new Date().toISOString()}\tUNMAPPED\tSynthetic mixed custom\t1\tUSD\t20.00`,
    });
    const mixedId = (await reports.workspace(a, { batchId: mixedBatch.id })).lines[0]!.orderLineId;
    let mixedDetail = await work.detail(a, mixedId);
    const mixedDraft = {
      ...mixedDetail.draft,
      salesRecipeVersionId: mixedReady.id,
      artworkVersionId: mixedReady.artwork.versionId,
      specificationVersionId: mixedReady.specification.versionId,
      printProfileVersionId: profileVersionId,
      designExecutor: "human",
    };
    await expect(
      work.save(a, mixedId, {
        expectedRevision: 0,
        expectedSourceVersionId: mixedDetail.report?.versionId ?? null,
        draft: mixedDraft,
        status: "ready_to_push",
        reason: "Synthetic missing mixed customer image",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("必填定制内容");
    mixedDetail = await work.save(a, mixedId, {
      expectedRevision: 0,
      expectedSourceVersionId: mixedDetail.report?.versionId ?? null,
      draft: mixedDraft,
      status: "pending_review",
      reason: "Synthetic private mixed draft",
      idempotencyKey: randomUUID(),
    });
    mixedDetail = await work.upload(a, mixedId, "private-portrait.png", image);
    const buyerAsset = mixedDetail.assets[0]!;
    mixedDetail = await work.save(a, mixedId, {
      expectedRevision: mixedDetail.line.revision,
      expectedSourceVersionId: mixedDetail.report?.versionId ?? null,
      draft: {
        ...mixedDraft,
        images: [{ origin: "upload", key: buyerAsset.id, usage: "顾客原图" }],
      },
      status: "ready_to_push",
      reason: "Synthetic mixed source approved",
      idempotencyKey: randomUUID(),
    });
    for (const action of ["push", "start_artwork"])
      mixedDetail = await work.action(a, mixedId, {
        action,
        expectedRevision: mixedDetail.line.revision,
        expectedProjectionVersion: mixedDetail.line.projectionVersion,
        reason: "Synthetic mixed private production",
        idempotencyKey: randomUUID(),
      });
    const mixedProject = await editor.get(a, mixedDetail.line.editorProjectId!);
    expect(
      mixedProject.version.document.layers.filter((layer) =>
        layer.id.startsWith("print_decoration"),
      ),
    ).toHaveLength(1);
    expect(mixedProject.images.some((image) => image.name.includes("private-portrait.png"))).toBe(
      true,
    );
    expect(mixedProject.project.workSource?.workItemId).toBe(mixedId);
    expect((await catalog.options(a)).artworks.some((art) => art.assetId === buyerAsset.id)).toBe(
      false,
    );
    expect(
      (await withTenant(db.db, a, (tx) => readRecipe(tx, mixedReady.id))).printBindings?.map(
        (binding) => binding.artworkVersionId,
      ),
    ).toEqual([otherArt.versionId, custom.versionId]);
    const revision = await catalog.registerArtwork(a, {
      ...input,
      expectedVersion: 1,
      materials: [],
      idempotencyKey: randomUUID(),
    });
    expect(revision.artwork).toMatchObject({
      id: custom.id,
      version: 2,
      materials: [],
      assetId: null,
    });
    expect((await work.detail(a, id)).draft.artworkVersionId).toBe(custom.versionId);
    expect(
      (await withTenant(db.db, a, (tx) => readArtwork(tx, custom.versionId))).materials,
    ).toHaveLength(1);
  }, 60000);

  it("checks current source ownership before new artwork intents and idempotent replays", async () => {
    const creativeId = await creativeVersion("#225588"),
      source = (await catalog.options(a)).creativeVersions.find(
        (version) => version.id === creativeId,
      )!,
      researchId = createEntityId(),
      reader = { ...a, userId: b.userId, dataScope: "self" as const },
      suffix = randomUUID().slice(0, 8),
      input = {
        code: `SOURCE-${suffix}`,
        name: "Synthetic source scoped artwork",
        mode: "personalized_text",
        customization: {
          version: 1,
          fields: [{ key: "name", label: "Name", type: "short_text", required: true }],
        },
        instructions: "Synthetic source authorization",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      };
    await withTenant(db.db, a, (tx) =>
      tx.insert(researchItems).values({
        id: researchId,
        tenantId: a.tenantId,
        ownerUserId: a.userId,
        platform: "amazon",
        marketplace: "US",
        normalizedUrl: `https://example.invalid/${researchId}`,
      }),
    );
    const available = await catalog.options(reader);
    expect(available.contextAuthority).toBe(
      erpSessionAuthority({ ...reader, permissions: erpPermissions(reader.permissions) }),
    );
    expect(available.creativeVersions.some((version) => version.id === creativeId)).toBe(false);
    for (const [patch, status] of [
      [{ creativeVersionId: creativeId }, 403],
      [
        { materials: [{ assetId: source.assetId, role: "source", usage: "Synthetic source" }] },
        404,
      ],
      [{ researchItemIds: [researchId] }, 403],
    ] as const)
      await expect(catalog.registerArtwork(reader, { ...input, ...patch })).rejects.toMatchObject({
        status,
      });
    expect((await catalog.options(a)).artworks.some((art) => art.code === input.code)).toBe(false);
    await withTenant(db.db, a, async (tx) => {
      await tx
        .update(researchItems)
        .set({ ownerUserId: reader.userId })
        .where(eq(researchItems.id, researchId));
    });
    const ownCreativeId = await creativeVersion("#338866", 512, reader);
    const allowed = { ...input, creativeVersionId: ownCreativeId, researchItemIds: [researchId] },
      first = await catalog.registerArtwork(reader, allowed);
    expect(await catalog.registerArtwork(reader, allowed)).toEqual(first);
    await withTenant(db.db, a, (tx) =>
      tx
        .update(researchItems)
        .set({ ownerUserId: a.userId })
        .where(eq(researchItems.id, researchId)),
    );
    await expect(catalog.registerArtwork(reader, allowed)).rejects.toMatchObject({ status: 403 });
    expect(
      (await catalog.options(a)).artworks.filter((art) => art.code === input.code),
    ).toHaveLength(1);
  });

  it("archives and restores artwork without deleting immutable versions or historical SKU relationships", async () => {
    const art = await register("ARCHIVE-MASTER", await creativeVersion("#2244cc"));
    const combined = await catalog.combine(a, {
      artworkVersionId: art.versionId,
      items: [{ specificationVersionId: specifications[0]!.versionId, skuCode: "ARCHIVE-SALE" }],
      idempotencyKey: randomUUID(),
    });
    const input = {
      archived: true,
      expectedVersion: art.version,
      reason: "Unused fixture",
      idempotencyKey: randomUUID(),
    };
    await expect(catalog.archiveArtwork(b, art.id, input)).rejects.toThrow();
    await expect(
      catalog.archiveArtwork({ ...a, permissions: [] }, art.id, input),
    ).rejects.toThrow();
    await expect(
      catalog.archiveArtwork(a, art.id, { ...input, expectedVersion: 2 }),
    ).rejects.toThrow("版本已变化");
    const archived = await catalog.archiveArtwork(a, art.id, input);
    expect(await catalog.archiveArtwork(a, art.id, input)).toEqual(archived);
    expect(archived.artwork).toMatchObject({
      id: art.id,
      versionId: art.versionId,
      archived: true,
    });
    const options = await catalog.options(a);
    expect(options.artworks.some((a) => a.id === art.id)).toBe(false);
    expect(options.archivedArtworks?.some((a) => a.id === art.id)).toBe(true);
    expect(
      (await withTenant(db.db, a, (tx) => orderSalesChoices(tx, a))).artworks.some(
        (a) => a.id === art.versionId,
      ),
    ).toBe(false);
    expect(
      (await withTenant(db.db, a, (tx) => readRecipe(tx, combined.recipes[0]!.id))).artwork
        .versionId,
    ).toBe(art.versionId);
    await expect(
      catalog.combine(a, {
        artworkVersionId: art.versionId,
        items: [
          { specificationVersionId: specifications[1]!.versionId, skuCode: "ARCHIVED-BLOCKED" },
        ],
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("已归档");
    await expect(register(art.code, art.creativeVersionId!, 1)).rejects.toThrow("已归档");
    const restored = await catalog.archiveArtwork(a, art.id, {
      ...input,
      archived: false,
      reason: "Restore fixture",
      idempotencyKey: randomUUID(),
    });
    expect(restored.artwork).toMatchObject({ versionId: art.versionId, archived: false });
    expect((await catalog.options(a)).artworks.some((a) => a.id === art.id)).toBe(true);
    await expect(catalog.archiveArtwork(a, art.id, { ...input, archived: false })).rejects.toThrow(
      "请求编号",
    );
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
