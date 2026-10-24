
import { authorize, Permission, requireAssetAuthority, type PermissionValue } from "@yummyai/authz";
import { assertCatalogSpecificationAccess, catalogOwnerFilter } from "./access.js";
import type { TenantContext } from "@yummyai/contracts";
import {
  assetFiles, canvasPrintSpecVersions, creativeDesignBatches, creativeDesignBatchItems,
  creativeDesignCandidates, creativeDesignVersions, designRecipeVersions, productSpecificationVersions, researchItems, type TenantTransaction,
} from "@yummyai/database";
import { and, asc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";

import { currentCreativeAuthority } from "./creative-context.js";


class CreativeAccessError extends Error { readonly statusCode: number; constructor(readonly status: number, message: string) { super(message); this.statusCode=status; } }
class CreativeNotFoundError extends CreativeAccessError { constructor(message: string) { super(404,message); } }
export class CreativeConflictError extends CreativeAccessError { constructor(message: string) { super(409,message); } }

// These legacy creative objects have no trusted team binding. Wide grants for
// unrelated permissions cannot expand their owner-scoped read/write authority.
export function creativeOwnerFilter(context: TenantContext, permission: PermissionValue, owner: SQLWrapper) {
  return catalogOwnerFilter(context, permission, owner);
}

export function printSpecOwner() {
  // A collaborator creates a new version, not a new specification owner.
  return sql`(select original.created_by from canvas_print_spec_versions original
    where original.tenant_id = ${canvasPrintSpecVersions.tenantId}
      and original.spec_id = ${canvasPrintSpecVersions.specId}
    order by original.version_number asc limit 1)`;
}

export async function requirePrintSpecAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], lock: "share" | "update" = "share") {
  const [version] = await tx.select().from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, id)).for(lock);
  if (!version) throw new CreativeNotFoundError("Canvas print specification version not found");
  const [original] = await tx.select({ ownerId: canvasPrintSpecVersions.createdBy }).from(canvasPrintSpecVersions)
    .where(eq(canvasPrintSpecVersions.specId, version.specId)).orderBy(asc(canvasPrintSpecVersions.versionNumber)).limit(1);
  for (const permission of permissions) authorize(authority, permission, { ownerId: original?.ownerId });
  return version;
}

export async function requireBatchAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], options: { lock?: "share" | "update"; mutation?: boolean; canvas?: boolean } = {}) {
  const [batch] = await tx.select().from(creativeDesignBatches).where(and(eq(creativeDesignBatches.id, id),
    options.canvas ? eq(creativeDesignBatches.executionMode, "infinite_canvas") : undefined)).for(options.lock ?? "share");
  if (!batch) throw new CreativeNotFoundError("创意项目不存在");
  for (const permission of permissions) authorize(authority, permission, { ownerId: batch.createdBy });
  if (options.mutation && (batch.archivedAt || batch.status === "cancelled"))
    throw new CreativeConflictError("已归档或取消的创意项目不能继续执行 请创建新项目");
  return batch;
}

export async function requireCreativeVersionAccess(tx: TenantTransaction, authority: TenantContext, id: string,
  permissions: readonly PermissionValue[], options: { lock?: "share" | "update"; mutation?: boolean } = {}) {
  const [source] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignVersions)
    .innerJoin(creativeDesignCandidates, eq(creativeDesignCandidates.id, creativeDesignVersions.sourceCandidateId))
    .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
    .where(eq(creativeDesignVersions.id, id));
  if (!source) throw new CreativeNotFoundError("Creative design version not found");
  // All mutations lock the batch before the version and then its files.
  const batch = await requireBatchAccess(tx, authority, source.batchId, [Permission.DesignRead], {
    lock: options.lock, mutation: options.mutation,
  });
  const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.id, id)).for(options.lock ?? "share");
  if (!version) throw new CreativeNotFoundError("Creative design version not found");
  for (const permission of permissions) authorize(authority, permission, { ownerId: version.createdBy });
  return { batch, version };
}

export function requireReferenceAuthority(authority: TenantContext, rows: (typeof assetFiles.$inferSelect)[], checkedAt?: number) {
  for (const asset of rows) {
    requireAssetAuthority(authority, Permission.AssetRead, asset);
    if (checkedAt !== undefined) {
      const source = asset.rightsMetadata.source as { licenseExpiresAt?: string } | undefined;
      if (source?.licenseExpiresAt && !(Date.parse(source.licenseExpiresAt) > checkedAt))
        throw new CreativeConflictError("素材授权已到期 请更新来源依据");
    }
  }
}

export async function requireBatchInputs(tx: TenantTransaction, authority: TenantContext,
  batch: typeof creativeDesignBatches.$inferSelect, checkedAt?: number) {
  const items = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batch.id));
  const refs = [...new Set(items.flatMap(item => item.referenceSnapshot.map(ref => ref.assetId)))].sort();
  const files = refs.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, refs)).orderBy(asc(assetFiles.id)).for("share") : [];
  if (files.length !== refs.length) throw new CreativeNotFoundError("Creative reference not found");
  requireReferenceAuthority(authority, files, checkedAt);
  if (checkedAt !== undefined) {
    for (const item of items) for (const pin of item.referenceSnapshot) {
      const file = files.find(asset => asset.id === pin.assetId)!;
      const kind = (file.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (file.deletedAt || file.assetDomain !== "authorized" || file.rightsStatus !== "approved" ||
        ["customer_provided", "competitor"].includes(kind ?? "") || file.version !== pin.assetVersion || file.checksumSha256 !== pin.checksumSha256)
        throw new CreativeConflictError("原创作输入已变化 请核对后创建新任务");
    }
  }
  for (const id of [...new Set(items.flatMap(item => item.printSpecVersionIds))].sort()) {
    const spec = await requirePrintSpecAccess(tx, authority, id, [Permission.DesignRead]);
    if (checkedAt !== undefined && spec.status !== "approved") throw new CreativeConflictError("原印刷规格不再可用");
  }
  if (batch.recipeVersionId) {
    const [recipe] = await tx.select().from(designRecipeVersions).where(eq(designRecipeVersions.id, batch.recipeVersionId));
    if (!recipe) throw new CreativeNotFoundError("Design recipe version not found");
    authorize(authority, Permission.DesignRead, { ownerId: recipe.createdBy });
  }
  await requireProductTargets(tx, authority, batch.canvasWorkflow?.requirements?.specificationVersionIds ?? []);
  const researchIds = [...new Set(batch.canvasWorkflow?.researchReferences?.map(ref => ref.researchItemId) ?? [])];
  if (researchIds.length) {
    const sources = await tx.select().from(researchItems).where(inArray(researchItems.id, researchIds)).for("share");
    if (sources.length !== researchIds.length) throw new CreativeNotFoundError("原研究来源不存在");
    for (const source of sources) authorize(authority, Permission.ResearchRead, { ownerId: source.ownerUserId });
  }
  return items;
}

export async function requireProductTargets(tx: TenantTransaction, authority: TenantContext, ids: string[]) {
  if (!ids.length) return;
  authorize(authority, Permission.ProductRead);
  // Versions are append-only and deliberately have no UPDATE privilege for row locks.
  const rows = await tx.select().from(productSpecificationVersions).where(inArray(productSpecificationVersions.id, ids));
  if (rows.length !== ids.length) throw new CreativeNotFoundError("目标商品规格不存在");
  for (const row of rows) await assertCatalogSpecificationAccess(tx, authority, row.specificationId, [Permission.ProductRead]);
}

export async function currentCreativeWorkspaceAuthority(tx: TenantTransaction, context: TenantContext, scope: string,
  extra: readonly PermissionValue[] = []) {
  const result = await currentCreativeAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead, ...extra]);
  if (scope !== "unassigned") {
    const mutations = extra.filter(permission => permission === Permission.DesignWrite || permission === Permission.DesignReview);
    const batch = await requireBatchAccess(tx, result.authority, scope, [Permission.DesignRead, ...mutations], {
      canvas: true, mutation: mutations.length > 0,
    });
    await requireBatchInputs(tx, result.authority, batch, mutations.length ? result.checkedAt : undefined);
  }
  return result;
}
