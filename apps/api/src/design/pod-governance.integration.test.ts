import { Permission } from "@yummyai/authz";
import { createEntityId, type PodExecutableToolKey, type PodExportManifest, type TemplateSourceInspectionSlot, type TenantContext } from "@yummyai/contracts";
import {
  assetFiles,
  connectDatabase,
  listings,
  listingVersions,
  migrateDatabase,
  podArtworkTasks,
  podExportPackages,
  personalizationTemplateSourceInspections,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { DrizzleCatalogRepository, ProductService } from "../catalog/product.service.js";
import { DesignService, DrizzleDesignRepository } from "./design.service.js";
import { PodArtworkTaskService, type PodArtworkEnqueuer } from "./pod-artwork-task.service.js";
import { PodExportService, type PodExportEnqueuer } from "./pod-export.service.js";
import { PodGovernanceService } from "./pod-governance.service.js";
import { PodPersonalizationService, type PersonalizationTemplateSourceInspectionEnqueuer } from "./pod-personalization.service.js";
import { PodWorkbenchService, type PodToolActivationPolicy } from "./pod-workbench.service.js";

describe("POD governance database", () => {
  const database = connectDatabase();
  const audit = new AuditService(database);
  const storage = {
    signRead: async () => "https://signed.example/pod-export.zip?X-Amz-Expires=600",
  } as unknown as Storage;
  const catalog = new ProductService(new DrizzleCatalogRepository(database));
  const design = new DesignService(new DrizzleDesignRepository(database, storage), audit);
  const governance = new PodGovernanceService(database, audit);
  const inspectionJobs: string[] = [];
  const inspectionEnqueuer: PersonalizationTemplateSourceInspectionEnqueuer = { enqueue: async ({ inspectionId }) => { inspectionJobs.push(inspectionId); } };
  const personalization = new PodPersonalizationService(database, inspectionEnqueuer, audit);
  const artworkJobs: string[] = [];
  const exportJobs: string[] = [];
  const artworkEnqueuer: PodArtworkEnqueuer = { enqueue: async ({ taskId }) => { artworkJobs.push(taskId); } };
  const exportEnqueuer: PodExportEnqueuer = { enqueue: async ({ exportId }) => { exportJobs.push(exportId); } };
  const activation = {
    enabledTools: () => new Set<PodExecutableToolKey>(["pattern_crop"]),
  } as PodToolActivationPolicy;
  const artwork = new PodArtworkTaskService(database, artworkEnqueuer, new PodWorkbenchService(activation), audit);
  const exports = new PodExportService(database, exportEnqueuer, storage, audit);
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);
  let skuId: string;
  let spuId: string;
  let listingVersionId: string;
  let sourceAssetId: string;
  let outputAssetId: string;
  let psdAssetId: string;
  let customerAssetId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'POD Governance A', $2), ($3, 'POD Governance B', $4)`,
      [first.tenantId, `pod-gov-${first.tenantId}`, second.tenantId, `pod-gov-${second.tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'POD Governance User')`,
      [userId, `pod-gov-${userId}`, `${userId}@example.test`],
    );
    ({ skuId, spuId } = await createCatalog(first));
    listingVersionId = await createListing(first, spuId, skuId);
    sourceAssetId = await createAsset(database, first, "source.png", "image/png", "a");
    outputAssetId = await createAsset(database, first, "result.png", "image/png", "b");
    psdAssetId = await createAsset(database, first, "template.psd", "image/vnd.adobe.photoshop", "c");
    customerAssetId = await createAsset(database, first, "customer.png", "image/png", "d", "customer_provided");
  });

  afterAll(async () => { await database.client.end(); });

  it("keeps template versions, same-name slot reuse, SKU bindings, and production manifests immutable", async () => {
    const options = await personalization.personalizationOptions(first);
    expect(options.skus.map((item) => item.id)).toContain(skuId);
    expect(options.sourceAssets.map((item) => item.id)).toContain(psdAssetId);
    expect(options.sourceAssets.map((item) => item.id)).not.toContain(customerAssetId);
    const inspection = await personalization.createTemplateSourceInspection(first, {
      sourceAssetId: psdAssetId,
      sourceAssetVersion: 1,
      idempotencyKey: createEntityId(),
    });
    expect(inspectionJobs).toContain(inspection.id);
    const detectedSlots: TemplateSourceInspectionSlot[] = [
      { ...slot("front.pet", "顾客照片", 0), sourceLayerPath: ["image", "顾客照片"], confidencePermille: 950 },
      { ...slot("back.pet", "顾客照片", 1500), sourceLayerPath: ["image", "顾客照片"], confidencePermille: 950 },
      {
          stableKey: "caption",
          name: "顾客姓名",
          kind: "text" as const,
          psdGroup: "text" as const,
          geometry: { x: 200, y: 2500, width: 2600, height: 300, rotationDegrees: 0 },
          fillMode: "none" as const,
          validationSnapshot: { required: true, maxLength: 40 },
          replaceable: true,
          sourceLayerPath: ["text", "顾客姓名"],
          confidencePermille: 950,
      },
    ];
    await withTenant(database.db, first, (tx) => tx.update(personalizationTemplateSourceInspections).set({
      status: "completed",
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      slotSnapshot: detectedSlots,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(personalizationTemplateSourceInspections.id, inspection.id)));
    const template = await personalization.confirmTemplateSourceInspection(first, inspection.id, {
      name: "同名双面宠物模板",
      acknowledgeWarnings: true,
      slots: detectedSlots.map(({ stableKey, name, kind, fillMode, replaceable }) => ({
        stableKey,
        name,
        kind,
        fillMode,
        replaceable,
      })),
    });
    const frontSlot = template.slots.find((item) => item.stableKey === "front.pet");
    const backSlot = template.slots.find((item) => item.stableKey === "back.pet");
    expect(frontSlot?.reuseLabel).toBe("same-name:顾客照片");
    expect(backSlot?.reuseLabel).toBe(frontSlot?.reuseLabel);
    const approved = await personalization.reviewTemplate(first, template.id, { decision: "approve" });
    expect(approved.status).toBe("approved");
    const copied = await personalization.cloneTemplate(first, approved.id, { name: "组织宠物模板副本" });
    expect(copied).toMatchObject({
      name: "组织宠物模板副本",
      source: "popular_template",
      sourceTemplateVersionId: approved.id,
      versionNumber: 1,
      status: "draft",
    });
    expect(copied.id).not.toBe(approved.id);
    expect(copied.templateId).not.toBe(approved.templateId);
    expect(copied.slots.map((slot) => [slot.stableKey, slot.reuseLabel])).toEqual(
      approved.slots.map((slot) => [slot.stableKey, slot.reuseLabel]),
    );
    await expect(personalization.cloneTemplate(second, approved.id, { name: "Cross tenant copy" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(database.client.unsafe(
      "update personalization_template_versions set source_template_version_id = null where id = $1",
      [copied.id],
    )).rejects.toMatchObject({ code: "55000" });
    const binding = await personalization.createBinding(first, {
      skuId,
      templateVersionId: approved.id,
      sizeLabel: "M",
      mappingSnapshot: {
        slotFieldMap: { "front.pet": "customer_image", "back.pet": "customer_image", caption: "customer_name" },
      },
      effectiveFrom: "2026-08-03T00:00:00.000Z",
    });
    expect(binding.mappingSnapshot.slotFieldMap["front.pet"]).toBe(binding.mappingSnapshot.slotFieldMap["back.pet"]);

    const designTask = await design.createTask(first, { skuId, title: "生产图验收", brief: "锁定生产文件和校验值" });
    const version = await design.uploadVersion(first, designTask.id, { files: [{ assetId: outputAssetId, role: "production" }] });
    await design.reviewVersion(first, version.id, { decision: "approve" });
    const manifest = await personalization.createProductionManifest(first, {
      designVersionId: version.id,
      templateVersionId: approved.id,
      inputSnapshot: [{ assetId: sourceAssetId, assetVersion: 1, checksumSha256: "a".repeat(64) }],
      files: [{
        assetId: outputAssetId,
        assetVersion: 1,
        checksumSha256: "b".repeat(64),
        fileName: "result.png",
        mediaType: "image/png",
        width: 3000,
        height: 3000,
        unit: "px",
        dpi: 300,
        colorMode: "rgb",
      }],
      qualityCheckSnapshot: { passed: true, dimensions: true, dpi: true, colorMode: true },
    });
    const reviewed = await personalization.reviewProductionManifest(first, manifest.id, { decision: "approve" });
    expect(reviewed.status).toBe("approved");
    await expect(database.client.unsafe(
      `update production_manifests set input_snapshot = '[]'::jsonb where id = $1`,
      [manifest.id],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(personalization.getTemplate(second, approved.id)).rejects.toMatchObject({ status: 404 });
  });

  it("requires an approved result, queues identifier-only export work, and locks completed packages", async () => {
    const task = await artwork.create(first, {
      idempotencyKey: createEntityId(),
      skuId,
      toolKey: "pattern_crop",
      title: "图案裁剪导出验收",
      inputAssetIds: [sourceAssetId],
      parameterSnapshot: patternCropParameters(),
    });
    const resultVersion = await design.uploadVersion(first, task.designTaskId, {
      changeNote: "POD worker result",
      files: [{ assetId: outputAssetId, role: "effect" }],
    });
    await withTenant(database.db, first, (tx) => tx.update(podArtworkTasks).set({
      status: "awaiting_review",
      resultVersionId: resultVersion.id,
      progressPercent: 100,
      qualityCheckSnapshot: patternCropQuality(),
    }).where(eq(podArtworkTasks.id, task.id)));
    await design.reviewVersion(first, resultVersion.id, { decision: "approve" });

    const idempotencyKey = createEntityId();
    const requested = await exports.request(first, task.id, { idempotencyKey });
    const replayed = await exports.request(first, task.id, { idempotencyKey });
    expect(replayed.id).toBe(requested.id);
    expect(exportJobs.filter((id) => id === requested.id)).toHaveLength(1);
    await expect(exports.get(second, requested.id)).rejects.toMatchObject({ status: 404 });

    const now = new Date();
    const manifest = {
      exportId: requested.id,
      tenantId: first.tenantId,
      taskId: task.id,
      designTaskId: task.designTaskId,
      designVersionId: resultVersion.id,
      toolKey: "pattern_crop",
      inputAssets: [{ assetId: sourceAssetId, assetVersion: 1, checksumSha256: "a".repeat(64) }],
      files: [{ path: `artwork/${outputAssetId}-v1-result.png`, sha256: "b".repeat(64), assetId: outputAssetId, assetVersion: 1, mediaType: "image/png" }],
      qualityCheckSnapshot: patternCropQuality(),
      createdBy: first.userId,
      createdAt: now.toISOString(),
    } satisfies PodExportManifest;
    await withTenant(database.db, first, (tx) => tx.update(podExportPackages).set({
      status: "completed",
      objectKey: `tenants/${first.tenantId}/authorized/exports/${requested.id}.zip`,
      checksumSha256: "d".repeat(64),
      byteSize: 2048,
      manifest,
      completedAt: now,
    }).where(eq(podExportPackages.id, requested.id)));
    await expect(exports.signDownload(first, requested.id)).resolves.toMatchObject({ expiresInSeconds: 600 });
    await expect(database.client.unsafe(
      `update pod_export_packages set checksum_sha256 = $2 where id = $1`,
      [requested.id, "e".repeat(64)],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("stores legal risk separately from visual similarity and confines visual search to a tenant", async () => {
    const twinAssetId = await createAsset(database, first, "result-copy.png", "image/png", "b");
    const firstFingerprint = await governance.registerFingerprint(first, {
      assetId: outputAssetId,
      assetVersion: 1,
      checksumSha256: "b".repeat(64),
      perceptualHash: "0123456789abcdef",
      fingerprintAlgorithm: "phash",
      fingerprintVersion: "1",
      indexStatus: "indexed",
    });
    await governance.registerFingerprint(first, {
      assetId: twinAssetId,
      assetVersion: 1,
      checksumSha256: "b".repeat(64),
      perceptualHash: "0123456789abcdef",
      fingerprintAlgorithm: "phash",
      fingerprintVersion: "1",
      indexStatus: "indexed",
    });
    const search = await governance.visualSearch(first, { assetId: outputAssetId, domain: "authorized", limit: 10, maxHammingDistance: 4 });
    expect(search.queryFingerprintId).toBe(firstFingerprint.id);
    expect(search.hits).toContainEqual(expect.objectContaining({ assetId: twinAssetId, exactChecksumMatch: true }));
    await expect(governance.visualSearch(second, {
      assetId: outputAssetId,
      domain: "all",
      limit: 20,
      maxHammingDistance: 16,
    })).rejects.toMatchObject({ status: 404 });

    const blocked = await governance.createRightsAssessment(first, {
      assetId: twinAssetId,
      assetVersion: 1,
      scopeSnapshot: {
        marketplaces: ["amazon", "etsy"],
        checkedAt: "2026-08-03T00:00:00.000Z",
        validUntil: "2026-09-02T00:00:00.000Z",
        ruleVersion: "rights-rules-42",
      },
      status: "blocked",
      legalRisk: "high",
      visualSimilarityPermille: 80,
      evidence: [{
        kind: "internal", reference: "manual-review", checkedAt: "2026-08-03T00:00:00.000Z",
        accessible: true, sourceVersion: "internal-risk-catalog-42", contentHashSha256: "8".repeat(64),
      }],
      decisionReason: "Potential trademark conflict requires human review",
    });
    expect(blocked).toMatchObject({
      legalRisk: "high", visualSimilarityPermille: 80, status: "blocked",
      scopeSnapshot: { validUntil: "2026-09-02T00:00:00.000Z", ruleVersion: "rights-rules-42" },
      evidence: [{ accessible: true, sourceVersion: "internal-risk-catalog-42", contentHashSha256: "8".repeat(64) }],
    });
  });

  it("keeps order-private assets out of shared fingerprint and artifact relation graphs", async () => {
    const orderAssetId = await createOrderAsset(database, first, "private-result.png", "e");
    const piiContext: TenantContext = { ...first, permissions: [Permission.OrderPiiRead] };
    await expect(governance.createRightsAssessment(piiContext, {
      assetId: orderAssetId,
      assetVersion: 1,
      rightsSource: { kind: "customer_provided", reference: `order-customization:${createEntityId()}` },
      scopeSnapshot: { purpose: "order_personalization_output" },
      status: "approved",
      legalRisk: "low",
      evidence: [{ kind: "internal", reference: "customer-order", checkedAt: "2026-08-04T00:00:00.000Z" }],
      decisionReason: "Customer supplied the source for this order",
    })).rejects.toMatchObject({ status: 409 });
    await expect(governance.registerFingerprint(first, {
      assetId: orderAssetId,
      assetVersion: 1,
      checksumSha256: "e".repeat(64),
      perceptualHash: "0123456789abcdef",
      fingerprintAlgorithm: "phash",
      fingerprintVersion: "1",
      indexStatus: "indexed",
    })).rejects.toMatchObject({ status: 409 });
    await expect(governance.createArtifactRelations(first, [{
      fromAssetId: orderAssetId,
      fromAssetVersion: 1,
      toAssetId: outputAssetId,
      toAssetVersion: 1,
      relationType: "source_to_result",
    }])).rejects.toMatchObject({ status: 409 });
    await expect(governance.traceAsset(first, orderAssetId)).rejects.toThrow();
    await expect(governance.traceAsset(piiContext, orderAssetId))
      .resolves.toEqual({ relations: [] });
  });

  it("offers and binds only rights-approved assets from approved design results", async () => {
    const unreviewedAssetId = await createAsset(database, first, "unreviewed-listing.png", "image/png", "f");
    await expect(governance.createListingArtifactBinding(first, {
      listingVersionId,
      assetId: unreviewedAssetId,
      assetVersion: 1,
      contentKind: "image",
      slotKey: "gallery.1",
    })).rejects.toMatchObject({ status: 409 });

    const task = await design.createTask(first, { skuId, title: "Listing 套图审核", brief: "审核后允许进入 Listing 素材槽位" });
    const version = await design.uploadVersion(first, task.id, { files: [{ assetId: outputAssetId, role: "effect" }] });
    await design.reviewVersion(first, version.id, { decision: "approve" });
    const options = await governance.listingOptions(first);
    expect(options.listingVersions.map((item) => item.id)).toContain(listingVersionId);
    expect(options.assets.map((item) => item.id)).toContain(outputAssetId);
    expect(options.assets.map((item) => item.id)).not.toContain(unreviewedAssetId);
    expect(options.assets.map((item) => item.id)).not.toContain(customerAssetId);

    const binding = await governance.createListingArtifactBinding(first, {
      listingVersionId,
      assetId: outputAssetId,
      assetVersion: 1,
      contentKind: "image",
      slotKey: "gallery.1",
    });
    expect(binding).toMatchObject({ listingVersionId, assetId: outputAssetId, status: "candidate" });
    await expect(governance.listListingArtifactBindings(second, listingVersionId)).resolves.toEqual({ items: [] });
  });

  async function createCatalog(context: TenantContext) {
    const plan = await catalog.createPlan(context, { name: "POD governance", sourceReportIds: [createEntityId()], customization: { version: 1, fields: [] } });
    await catalog.transition(context, plan.id, "pending_approval");
    await catalog.transition(context, plan.id, "approved");
    const spu = await catalog.createSpu(context, plan.id, { code: `POD-GOV-${plan.id.slice(-6)}`, name: "POD governance product" });
    const sku = await catalog.createSku(context, { spuId: spu.id, code: `POD-GOV-SKU-${plan.id.slice(-6)}`, attributes: {} });
    return { skuId: sku.id, spuId: spu.id };
  }

  async function createListing(context: TenantContext, targetSpuId: string, targetSkuId: string) {
    const listingId = createEntityId();
    const versionId = createEntityId();
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(listings).values({
        id: listingId,
        tenantId: context.tenantId,
        spuId: targetSpuId,
        platform: "amazon",
        marketplaceId: "ATVPDKIKX0DER",
        locale: "en-US",
        status: "draft",
        createdBy: context.userId,
      });
      await tx.insert(listingVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        listingId,
        versionNumber: 1,
        ruleVersion: "amazon-2026.08",
        status: "draft",
        source: "human",
        content: {
          platform: "amazon",
          locale: "en-US",
          title: "POD listing slot test",
          description: "Reviewed design result",
          bullets: [],
          tags: [],
          mediaAssetIds: [],
          variants: [{ skuId: targetSkuId, skuCode: "POD-GOV-SKU", optionValues: {} }],
          attributes: {},
          compliance: {},
        },
        validation: { completeness: 80, blockers: [], warnings: [] },
        createdBy: context.userId,
      });
    });
    return versionId;
  }
});

function slot(stableKey: string, name: string, x: number) {
  return {
    stableKey,
    name,
    kind: "image" as const,
    psdGroup: "image" as const,
    geometry: { x, y: 0, width: 1500, height: 2200, rotationDegrees: 0 },
    fillMode: "cover" as const,
    validationSnapshot: { required: true },
    replaceable: true,
  };
}

async function createAsset(
  database: DatabaseConnection,
  context: TenantContext,
  fileName: string,
  mediaType: string,
  checksumCharacter: string,
  rightsKind = "owned",
) {
  const id = createEntityId();
  await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({
    id,
    tenantId: context.tenantId,
    ownerUserId: context.userId,
    objectKey: `tenants/${context.tenantId}/authorized/${checksumCharacter.repeat(64)}/${fileName}`,
    assetDomain: "authorized",
    fileName,
    mediaType,
    byteSize: 1200,
    checksumSha256: checksumCharacter.repeat(64),
    rightsStatus: "approved",
    rightsMetadata: { source: { kind: rightsKind, reference: "integration" }, approvedAt: new Date().toISOString() },
  }));
  return id;
}

async function createOrderAsset(
  database: DatabaseConnection,
  context: TenantContext,
  fileName: string,
  checksumCharacter: string,
) {
  const id = createEntityId();
  await withTenant(database.db, context, (tx) => tx.insert(assetFiles).values({
    id,
    tenantId: context.tenantId,
    ownerUserId: context.userId,
    objectKey: `tenants/${context.tenantId}/order/${checksumCharacter.repeat(64)}/${fileName}`,
    assetDomain: "order",
    fileName,
    mediaType: "image/png",
    byteSize: 1200,
    checksumSha256: checksumCharacter.repeat(64),
    rightsStatus: "approved",
    rightsMetadata: {
      source: { kind: "customer_provided", reference: createEntityId() },
      approvedAt: new Date().toISOString(),
    },
  }));
  return id;
}

function patternCropParameters() {
  return {
    mode: "general", multiCrop: false, maximumCropsPerInput: 1, outputFormat: "png",
    background: "preserved", perspectiveCorrection: true, cropPaddingPercent: 2,
  };
}

function patternCropQuality() {
  return {
    passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true,
    blankOutputsDetected: false, duplicateOutputsDetected: false,
    outputChecks: [{
      fileName: "result.png", inputOrdinal: 0, cropIndex: 0,
      sourceBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      outputWidth: 3000, outputHeight: 3000, transparent: false,
      perspectiveCorrectionValidated: true, cropComplete: true,
    }],
  };
}

function tenant(tenantId: string, userId: string): TenantContext {
  return { tenantId, userId, permissions: [], dataScope: "tenant" };
}
