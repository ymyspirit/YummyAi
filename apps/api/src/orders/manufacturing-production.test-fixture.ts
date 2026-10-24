import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { ProductionEditorDocument } from "@yummyai/contracts/pod/production-editor";
import { withTenant, productSpecifications, productSpecificationVersions, artworkMasters, artworkMasterVersions, orderLineCatalogLinks,
  assetFiles, skus, designTasks, designVersions, designVersionFiles, printProfileVersions, productStyles, salesSkuDefinitions, salesRecipeVersions, type DatabaseConnection } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSpecificationFacts } from "../../../../tools/testing/specification-fixtures.js";
import { manufacturingBasis } from "../catalog/manufacturing.test-fixture.js";
import { ManufacturingService } from "../catalog/manufacturing.service.js";
import { AuditService } from "../audit/audit.service.js";
import { ClamAvScanner, createStorageFromEnvironment } from "@yummyai/storage";

/** Explicit synthetic reference facts and approvals, never real production or factory acceptance. */
export async function syntheticManufacturingProduct(db: DatabaseConnection, actor: TenantContext,
  options: { profileVersionId?: string; document?: ProductionEditorDocument; existingSkuId?: string; automaticInputs?: boolean; productType?: ProductionEditorDocument["productType"] } = {}) {
  requireDisposableIntegrationEnvironment();
  const seed: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, dataScope: "tenant", permissions: Object.values(Permission) };
  const base = await manufacturingBasis(db, seed, options.productType), specificationVersionId = createEntityId(), artworkId = createEntityId(), artworkVersionId = createEntityId();
  let spuId = base.spuId, specificationId = base.specificationId, versionNumber = 2;
  if (options.existingSkuId) {
    const [existing] = await withTenant(db.db, seed, tx => tx.select().from(skus).where(eq(skus.id, options.existingSkuId!)));
    if (!existing) throw new Error("Synthetic production SKU is missing");
    spuId = existing.spuId; specificationId = createEntityId(); versionNumber = 1;
  }
  const document = options.document, longest = document?.productType === "shaped_pillow" ? document.spec.declaredLongestMm : document?.productType === "tire_cover" ? document.spec.diameterMm : document ? Math.max(document.spec.widthMm, document.spec.heightMm) : 254;
  const skuId = options.profileVersionId ? createEntityId() : null, salesRecipeVersionId = options.profileVersionId ? createEntityId() : null;
  await withTenant(db.db, seed, async tx => {
    if (options.existingSkuId) await tx.insert(productSpecifications).values({ id: specificationId, tenantId: seed.tenantId, spuId, code: randomUUID(), createdBy: seed.userId });
    await tx.insert(productSpecificationVersions).values({ id: specificationVersionId, tenantId: seed.tenantId, specificationId, versionNumber,
      name: "Synthetic exact manufacturing specification", attributes: {}, facts: syntheticSpecificationFacts({ physicalDimensions: {
        basis: document?.productType === "tire_cover" ? "diameter" : document?.productType === "rectangular_print" ? "finished_outer_2d" : "artwork_longest",
        unit: "mm", length: longest, width: document?.productType === "rectangular_print" ? Math.min(document.spec.widthMm, document.spec.heightMm) : null, height: null } }),
      processProfileVersionId: options.profileVersionId ?? base.profileVersionId, createdBy: seed.userId });
    await tx.update(productSpecifications).set({ versionNumber }).where(eq(productSpecifications.id, specificationId));
    await tx.insert(artworkMasters).values({ id: artworkId, tenantId: seed.tenantId, code: randomUUID(), createdBy: seed.userId });
    await tx.insert(artworkMasterVersions).values({ id: artworkVersionId, tenantId: seed.tenantId, artworkId, versionNumber: 1, name: "Synthetic order matching basis",
      mode: "personalized_text", tags: [], researchItemIds: [], customization: { version: 1, fields: options.automaticInputs ? [
        { key: "beautification", label: "Image beautification options", type: "short_text", required: false },
        { key: "front_photo", label: "正面", type: "image", required: false, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 10_000_000 } },
        { key: "back_photo", label: "背面", type: "image", required: false, validation: { allowedMediaTypes: ["image/png", "image/jpeg"], maxFiles: 1, maxBytes: 10_000_000 } },
      ] : [] }, materials: [], layout: options.automaticInputs ? [
        { fieldKey: "beautification", xPercent: 5, yPercent: 5, widthPercent: 90, heightPercent: 10, color: "#111111" },
        { fieldKey: "front_photo", xPercent: 5, yPercent: 20, widthPercent: 40, heightPercent: 70, color: "#111111" },
        { fieldKey: "back_photo", xPercent: 55, yPercent: 20, widthPercent: 40, heightPercent: 70, color: "#111111" },
      ] : [], instructions: "Synthetic test reference only", createdBy: seed.userId });
    if (skuId && salesRecipeVersionId) {
      const [profile] = await tx.select().from(printProfileVersions).where(eq(printProfileVersions.id, options.profileVersionId!));
      if (!profile) throw new Error("Synthetic reviewed profile missing");
      const styleId = createEntityId();
      await tx.insert(skus).values({ id: skuId, tenantId: seed.tenantId, spuId, code: randomUUID(), attributes: {} });
      await tx.insert(productStyles).values({ id: styleId, tenantId: seed.tenantId, artworkId, spuId, createdBy: seed.userId });
      await tx.insert(salesSkuDefinitions).values({ id: createEntityId(), tenantId: seed.tenantId, skuId, styleId, spuId, specificationId, createdBy: seed.userId });
      await tx.insert(salesRecipeVersions).values({ id: salesRecipeVersionId, tenantId: seed.tenantId, skuId, versionNumber: 1, artworkVersionId, specificationVersionId,
        status: "approved", editorProjectId: profile.projectId, editorVersionId: profile.sourceVersionId, createdBy: seed.userId });
    }
  });
  const service = new ManufacturingService(db, new AuditService(db));
  const version = await service.create(seed, { spuId, specificationId, code: randomUUID(), idempotencyKey: randomUUID(), content: {
    specificationVersionId, name: "Synthetic approved production BOM", outputQuantity: 1, outputUnit: "each", notes: "Synthetic disposable test only",
    materials: [{ code: "MATERIAL", name: "Synthetic material", stockItemId: base.stockId, quantityNumerator: 1, quantityDenominator: 2,
      unit: "meter", lossBps: 0, lossBasis: "add_to_net", responsibility: "merchant", operationCode: "MAKE" }],
    operations: [{ code: "MAKE", name: "Synthetic manufacture", processCode: "make", responsibility: "factory", expectedSecondsPerOutput: null }] } });
  await service.review(seed, version.recipeId, { expectedVersion: 1, versionId: version.versionId, decision: "approved", note: "Synthetic approval for test lineage only", idempotencyKey: randomUUID() });
  return { spuId, specificationId, specificationVersionId, artworkVersionId, salesRecipeVersionId, skuId, profileVersionId: options.profileVersionId ?? base.profileVersionId,
    manufacturing: { versionId: version.versionId, orderUnitConfirmed: true as const }, productConfirmation: { specificationVersionId, note: "Synthetic explicit new product assignment" } };
}

export async function syntheticNativeManufacturingForLine(db: DatabaseConnection, actor: TenantContext, lineId: string,
  options: { productType?: ProductionEditorDocument["productType"]; document?: ProductionEditorDocument; productionFile?: { body: Uint8Array; name: string } } = {}) {
  requireDisposableIntegrationEnvironment();
  const seed: TenantContext = { tenantId: actor.tenantId, userId: actor.userId, dataScope: "tenant", permissions: Object.values(Permission) };
  const [link] = await withTenant(db.db, seed, tx => tx.select().from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, lineId)));
  const product = await syntheticManufacturingProduct(db, seed, { ...options, ...(link?.skuId ? { existingSkuId: link.skuId } : {}) });
  const skuId = link?.skuId ?? createEntityId(), designVersionId = createEntityId(), taskId = createEntityId(), assetId = createEntityId();
  let file = { objectKey: `authorized/synthetic-${assetId}`, fileName: "synthetic-metadata-only.png", byteSize: 1, checksumSha256: "e".repeat(64) };
  if (options.productionFile) {
    const scan = await new ClamAvScanner().scan({ body: options.productionFile.body, fileName: options.productionFile.name, mediaType: "image/png" });
    if (scan.result !== "clean" || scan.signatureVersion === "unavailable") throw Error("Synthetic source file requires a real clean scan");
    const stored = await createStorageFromEnvironment().putPrivate(seed, { domain: "authorized", body: options.productionFile.body, fileName: options.productionFile.name, mediaType: "image/png" });
    file = { objectKey: stored.objectKey, fileName: options.productionFile.name, byteSize: options.productionFile.body.byteLength, checksumSha256: stored.checksumSha256 };
  }
  await withTenant(db.db, seed, async tx => {
    if (!link?.skuId) {
      await tx.insert(skus).values({ id: skuId, tenantId: seed.tenantId, spuId: product.spuId, code: randomUUID(), attributes: {} });
      if (link) await tx.update(orderLineCatalogLinks).set({ skuId }).where(eq(orderLineCatalogLinks.id, link.id));
      else await tx.insert(orderLineCatalogLinks).values({ id: createEntityId(), tenantId: seed.tenantId, orderLineId: lineId, skuId, matchSource: "manual", linkedBy: seed.userId });
    }
    await tx.insert(assetFiles).values({ id: assetId, tenantId: seed.tenantId, ownerUserId: seed.userId, ...file, assetDomain: "authorized", mediaType: "image/png", rightsStatus: "approved",
      rightsMetadata: { source: { kind: "owned", reference: options.productionFile ? "Synthetic scanned source file; no factory or production acceptance" : "Synthetic reference; no actual file or production acceptance" }, approvedAt: new Date().toISOString() } });
    await tx.insert(designTasks).values({ id: taskId, tenantId: seed.tenantId, skuId, title: "Synthetic native design", brief: "Synthetic reference only", status: "approved", createdBy: seed.userId });
    await tx.insert(designVersions).values({ id: designVersionId, tenantId: seed.tenantId, taskId, versionNumber: 1, status: "approved", createdBy: seed.userId, reviewedBy: seed.userId, reviewedAt: new Date() });
    await tx.insert(designVersionFiles).values({ id: createEntityId(), tenantId: seed.tenantId, versionId: designVersionId, assetFileId: assetId, role: "production" });
  });
  return { ...product, skuId, designVersionId, productionAssetIds: [assetId] };
}
