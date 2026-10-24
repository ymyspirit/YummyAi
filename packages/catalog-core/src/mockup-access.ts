import { authorize, Permission, requireAssetAuthority, type PermissionValue } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { assetFiles, creativeDesignSkuBindings, designTasks, designVersionFiles, designVersions,
  salesRecipeVersions, productSpecificationVersions, artworkMasterVersions,
  mockupBatches, mockupTemplatePackVersions, mockupTemplateSlots, mockupTemplateSourceInspections,
  type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { catalogErrors } from "./errors.js";
import { requireCreativeVersionAccess, requirePrintSpecAccess, requireReferenceAuthority } from "./creative-access.js";
import { assertCatalogRecipeRead, assertCatalogSkuAccess, catalogRecipeReadFilter } from "./access.js";
import { assertCatalogSourceActive } from "./lifecycle.js";

export function mockupPackOwner() {
  return sql`(select original.created_by from mockup_template_pack_versions original
    where original.tenant_id=${mockupTemplatePackVersions.tenantId} and original.pack_id=${mockupTemplatePackVersions.packId}
    order by original.version_number asc limit 1)`;
}

export async function requireMockupInspectionAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], lock: "share" | "update" = "share") {
  const [row] = await tx.select().from(mockupTemplateSourceInspections).where(eq(mockupTemplateSourceInspections.id, id)).for(lock);
  if (!row) throw catalogErrors.notFound("模板检查记录不存在");
  for (const permission of permissions) authorize(authority, permission, { ownerId: row.requestedBy });
  return row;
}

export async function requireMockupPackAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], lock: "share" | "update" = "share") {
  const [pack] = await tx.select().from(mockupTemplatePackVersions).where(eq(mockupTemplatePackVersions.id, id)).for(lock);
  if (!pack) throw catalogErrors.notFound("模板包版本不存在");
  const [original] = await tx.select({ ownerId: mockupTemplatePackVersions.createdBy }).from(mockupTemplatePackVersions)
    .where(eq(mockupTemplatePackVersions.packId, pack.packId)).orderBy(asc(mockupTemplatePackVersions.versionNumber)).limit(1);
  for (const permission of permissions) authorize(authority, permission, { ownerId: original?.ownerId });
  return pack;
}

export async function requireMockupBatchAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], lock: "share" | "update" = "share") {
  const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, id)).for(lock);
  if (!batch) throw catalogErrors.notFound("套图批次不存在");
  for (const permission of permissions) authorize(authority, permission, { ownerId: batch.createdBy });
  return batch;
}

export async function requireMockupAsset(tx: TenantTransaction, authority: TenantContext, id: string,
  pin?: { version: number; checksumSha256: string }, checkedAt?: number, allowDraft = false, write = false) {
  const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, id)).for(write ? "update" : "share");
  if (!asset) throw catalogErrors.notFound("原素材不存在");
  requireAssetAuthority(authority, Permission.AssetRead, asset);
  if (pin && (asset.version !== pin.version || asset.checksumSha256 !== pin.checksumSha256))
    throw catalogErrors.conflict("原素材版本或校验值已经变化");
  if (checkedAt !== undefined) {
    requireReferenceAuthority(authority, [asset], checkedAt);
    const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
    if (asset.deletedAt || asset.assetDomain !== "authorized" || ["customer_provided", "competitor"].includes(kind ?? "")
      || (asset.rightsStatus !== "approved" && !(allowDraft && asset.rightsStatus === "unverified")))
      throw catalogErrors.conflict("原素材当前不可用于套图操作");
  }
  return asset;
}

export async function requireMockupInspectionSources(tx: TenantTransaction, authority: TenantContext,
  inspection: typeof mockupTemplateSourceInspections.$inferSelect, checkedAt?: number, requireCompilation = false) {
  const source = await requireMockupAsset(tx, authority, inspection.sourceAssetId,
    checkedAt === undefined ? undefined : { version: inspection.sourceAssetVersion, checksumSha256: inspection.checksumSha256 }, checkedAt);
  const compilation = inspection.compilation;
  if (requireCompilation && (inspection.status !== "completed" || !compilation || compilation.ssimPermille < 990
    || compilation.slotKey !== inspection.slotKey || compilation.compilerVersion !== inspection.compilerVersion))
    throw catalogErrors.conflict("原模板编译与黄金图证据不完整");
  const ids = compilation ? [...new Set([compilation.backgroundAssetId, compilation.foregroundAssetId,
    compilation.previewAssetId, compilation.manifestAssetId, ...(compilation.maskAssetId ? [compilation.maskAssetId] : [])])].sort() : [];
  const assets = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(asc(assetFiles.id)).for("share") : [];
  if (assets.length !== ids.length) throw catalogErrors.conflict("原模板编译文件缺失");
  for (const asset of assets) {
    requireAssetAuthority(authority, Permission.AssetRead, asset);
    if (checkedAt !== undefined) {
      requireReferenceAuthority(authority, [asset], checkedAt);
      const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (asset.deletedAt || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved"
        || ["customer_provided", "competitor"].includes(kind ?? ""))
        throw catalogErrors.conflict("原模板编译文件已不可用");
    }
  }
  if (checkedAt !== undefined && compilation && assets.find(asset => asset.id === compilation.manifestAssetId)?.checksumSha256 !== compilation.checksumSha256)
    throw catalogErrors.conflict("原编译清单校验值已经变化");
  return { source, assets };
}

export async function requireMockupPackSources(tx: TenantTransaction, authority: TenantContext,
  pack: typeof mockupTemplatePackVersions.$inferSelect, checkedAt?: number) {
  const slots = await tx.select().from(mockupTemplateSlots).where(eq(mockupTemplateSlots.templatePackVersionId, pack.id)).orderBy(asc(mockupTemplateSlots.ordinal));
  if (!slots.length) throw catalogErrors.conflict("模板包没有槽位");
  const inspections = [];
  for (const slot of slots) {
    const inspection = await requireMockupInspectionAccess(tx, authority, slot.inspectionId, [Permission.DesignRead]);
    await requireMockupInspectionSources(tx, authority, inspection, checkedAt, checkedAt !== undefined);
    if (checkedAt !== undefined && (!inspection.confirmedAt || slot.slotKey !== inspection.slotKey))
      throw catalogErrors.conflict("槽位缺少当前原模板的人工确认");
    for (const id of [...new Set(slot.acceptedPrintSpecVersionIds)].sort()) {
      const spec = await requirePrintSpecAccess(tx, authority, id, [Permission.DesignRead]);
      if (checkedAt !== undefined && spec.status !== "approved") throw catalogErrors.conflict("原兼容规格尚未批准");
    }
    inspections.push(inspection);
  }
  return { slots, inspections };
}

/** Formal artwork and its upstream owners remain independent of the batch owner. */
export async function requireMockupDesignSource(tx: TenantTransaction, authority: TenantContext,
  designVersionId: string, skuId: string, checkedAt?: number) {
  const [design] = await tx.select({ version: designVersions, task: designTasks }).from(designVersions)
    .innerJoin(designTasks, eq(designTasks.id, designVersions.taskId)).where(eq(designVersions.id, designVersionId)).for("share");
  if (!design) throw catalogErrors.notFound("原正式设计版本不存在");
  authorize(authority, Permission.DesignRead, { ownerId: design.task.createdBy });
  const sku = await assertCatalogSkuAccess(tx, authority, skuId, [Permission.ProductRead]);
  if (design.task.skuId !== skuId) throw catalogErrors.conflict("正式设计与所选 SKU 不匹配");
  if (checkedAt !== undefined) {
    if (design.version.status !== "approved" || design.task.status !== "approved")
      throw catalogErrors.conflict("正式设计及其原任务尚未批准或已归档");
    await assertCatalogSourceActive(tx, sku.spuId, skuId);
  }
  const [formal] = await tx.select().from(creativeDesignSkuBindings).where(and(
    eq(creativeDesignSkuBindings.designVersionId, designVersionId), eq(creativeDesignSkuBindings.skuId, skuId)));
  let printSpecVersionId: string;
  let creativeDesignVersionId: string;
  if (formal) {
    printSpecVersionId = formal.printSpecVersionId;
    creativeDesignVersionId = formal.creativeDesignVersionId;
  } else {
    const sales = await tx.select({ recipe: salesRecipeVersions, printSpecVersionId: productSpecificationVersions.canvasPrintSpecVersionId,
      creativeDesignVersionId: artworkMasterVersions.creativeVersionId }).from(salesRecipeVersions)
      .innerJoin(productSpecificationVersions, eq(productSpecificationVersions.id, salesRecipeVersions.specificationVersionId))
      .innerJoin(artworkMasterVersions, eq(artworkMasterVersions.id, salesRecipeVersions.artworkVersionId))
      .where(and(eq(salesRecipeVersions.designVersionId, designVersionId), eq(salesRecipeVersions.skuId, skuId),
        catalogRecipeReadFilter(authority, salesRecipeVersions.id), eq(salesRecipeVersions.status, "approved")))
      .orderBy(asc(salesRecipeVersions.id));
    const sale = sales[0];
    if (!sale?.printSpecVersionId || !sale.creativeDesignVersionId)
      throw catalogErrors.conflict("正式设计缺少当前可读的创作或销售配方绑定");
    if (sales.some(row => row.printSpecVersionId !== sale.printSpecVersionId || row.creativeDesignVersionId !== sale.creativeDesignVersionId))
      throw catalogErrors.conflict("正式设计的销售来源不唯一 请明确原配方");
    await assertCatalogRecipeRead(tx, authority, sale.recipe.id);
    printSpecVersionId = sale.printSpecVersionId;
    creativeDesignVersionId = sale.creativeDesignVersionId;
  }
  await requireCreativeVersionAccess(tx, authority, creativeDesignVersionId, [Permission.DesignRead], { mutation: checkedAt !== undefined });
  const spec = await requirePrintSpecAccess(tx, authority, printSpecVersionId, [Permission.DesignRead]);
  if (checkedAt !== undefined && spec.status !== "approved") throw catalogErrors.conflict("原设计规格尚未批准");
  const files = await tx.select({ assetId: designVersionFiles.assetFileId }).from(designVersionFiles)
    .where(and(eq(designVersionFiles.versionId, designVersionId), eq(designVersionFiles.role, "production")));
  if (files.length !== 1) throw catalogErrors.conflict("正式设计必须有唯一的生产原稿");
  const artwork = await requireMockupAsset(tx, authority, files[0]!.assetId, undefined, checkedAt);
  return { ...design, sku, artwork, printSpecVersionId, creativeDesignVersionId };
}
