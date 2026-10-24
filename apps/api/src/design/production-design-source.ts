import { ConflictException, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission, requireAssetAuthority } from "@yummyai/authz";
import { creativeOwnerFilter, currentCreativeAuthority } from "@yummyai/catalog-core";
import { RightsSourceSchema, type TenantContext } from "@yummyai/contracts";
import { assetFiles, designTasks, designVersionFiles, designVersions, creativeDesignSkuBindings, skus, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { assertSkuSpecCompatible } from "./canvas-print-spec-policy.js";
import { requirePrintSpecAccess } from "./canvas-workflow-access.js";

/** Native/Canvas designs use their actual reviewed files; customer artwork follows order work. */
export async function approvedDesignProductionSource(tx: TenantTransaction, context: TenantContext,
  input: { designVersionId: string | null; assetIds: string[]; skuId: string; spuId: string; canvasPrintSpecVersionId: string | null }) {
  const { authority, checkedAt } = await currentCreativeAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
  if (!input.designVersionId || !input.assetIds.length || new Set(input.assetIds).size !== input.assetIds.length)
    throw new ConflictException("直接生产须选择已审核设计及其正式生产文件");
  const [row] = await tx.select({ version: designVersions, task: designTasks, sku: skus }).from(designVersions)
    .innerJoin(designTasks, eq(designTasks.id, designVersions.taskId)).innerJoin(skus, eq(skus.id, designTasks.skuId))
    .where(eq(designVersions.id, input.designVersionId)).for("share");
  if (!row) throw new NotFoundException("设计版本不存在或不可访问");
  authorize(authority, Permission.DesignRead, { ownerId: row.task.createdBy });
  if (row.version.status !== "approved" || row.task.status === "archived" || row.sku.status === "archived" || row.task.skuId !== input.skuId || row.sku.spuId !== input.spuId)
    throw new ConflictException("设计版本须已审核并属于本单实际关联的产品 SKU");
  const [creative] = await tx.select({ printSpecVersionId: creativeDesignSkuBindings.printSpecVersionId }).from(creativeDesignSkuBindings)
    .where(eq(creativeDesignSkuBindings.designVersionId, row.version.id));
  if (creative && creative.printSpecVersionId !== input.canvasPrintSpecVersionId)
    throw new ConflictException("画布设计须沿用实际审核绑定的印刷规格");
  if (input.canvasPrintSpecVersionId) {
    const print = await requirePrintSpecAccess(tx, authority, input.canvasPrintSpecVersionId, [Permission.DesignRead]);
    if (print.status !== "approved") throw new ConflictException("画布印刷规格须已审核");
    assertSkuSpecCompatible(row.sku.code, row.sku.attributes, print);
  }
  const files = await tx.select({ file: designVersionFiles, asset: assetFiles }).from(designVersionFiles)
    .innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId))
    .where(and(eq(designVersionFiles.versionId, row.version.id), eq(designVersionFiles.role, "production"), inArray(assetFiles.id, input.assetIds)))
    .orderBy(asc(assetFiles.id)).for("share");
  if (files.length !== input.assetIds.length) throw new ConflictException("生产文件须来自本次明确选择的原审核设计");
  for (const { asset } of files) {
    requireAssetAuthority(authority, Permission.AssetRead, asset);
    const metadata = asset.rightsMetadata as { source?: unknown; approvedAt?: string }, source = RightsSourceSchema.safeParse(metadata.source);
    if (asset.deletedAt || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || !metadata.approvedAt ||
        !Number.isFinite(Date.parse(metadata.approvedAt)) || !source.success || ["competitor", "customer_provided"].includes(source.data.kind) ||
        source.data.licenseExpiresAt && !(Date.parse(source.data.licenseExpiresAt) > checkedAt))
      throw new ConflictException("生产文件的授权、来源或有效期不完整 请先核对原设计");
  }
  return { designVersionId: row.version.id, skuId: row.task.skuId, assetIds: files.map(file => file.asset.id) };
}

/** Read choices through the same design/file authority and compatibility checks used by release. */
export async function approvedDesignProductionChoices(tx: TenantTransaction, context: TenantContext,
  input: { skuId: string; spuId: string; canvasPrintSpecVersionId: string | null }) {
  const { authority } = await currentCreativeAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
  const rows = await tx.select({ version: designVersions, task: designTasks }).from(designVersions)
    .innerJoin(designTasks, eq(designTasks.id, designVersions.taskId))
    .where(and(eq(designTasks.skuId, input.skuId), ne(designTasks.status, "archived"), eq(designVersions.status, "approved"),
      creativeOwnerFilter(authority, Permission.DesignRead, designTasks.createdBy)))
    .orderBy(desc(designVersions.id)).limit(26);
  const items: Array<{ versionId: string; taskId: string; title: string; versionNumber: number; files: Array<{ id: string; name: string; sha256: string }> }> = [];
  for (const row of rows.slice(0, 25)) {
    const files = await tx.select({ id: assetFiles.id, name: assetFiles.fileName, sha256: assetFiles.checksumSha256 }).from(designVersionFiles)
      .innerJoin(assetFiles, eq(assetFiles.id, designVersionFiles.assetFileId))
      .where(and(eq(designVersionFiles.versionId, row.version.id), eq(designVersionFiles.role, "production"))).orderBy(asc(assetFiles.id)).limit(101);
    if (!files.length || files.length > 100) continue;
    try {
      await approvedDesignProductionSource(tx, authority, { ...input, designVersionId: row.version.id, assetIds: files.map(file => file.id) });
    } catch (cause) { if (cause instanceof ConflictException || cause instanceof ForbiddenError) continue; throw cause; }
    items.push({ versionId: row.version.id, taskId: row.task.id, title: row.task.title, versionNumber: row.version.versionNumber, files });
  }
  return { items, truncated: rows.length > 25 };
}
