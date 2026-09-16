import { createHash } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type {
  ArtworkView,
  SpecificationView,
  SalesRecipeView,
  ProductSpuView,
} from "@yummyai/contracts/catalog/development";
import {
  artworkMasters,
  artworkMasterVersions,
  creativeDesignVersionAssets,
  assetFiles,
  productSpecifications,
  productSpecificationVersions,
  salesSkuDefinitions,
  salesRecipeVersions,
  printProfileVersions,
  spus,
  productPlans,
  skus,
  developmentEvents,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, ne, sql, isNull, isNotNull, inArray } from "drizzle-orm";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";

export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(stable(value)).digest("hex");
export function productSpuView(row: {
  spu: typeof spus.$inferSelect;
  plan: typeof productPlans.$inferSelect;
}): ProductSpuView {
  const { spu, plan } = row;
  return {
    id: spu.id,
    code: spu.code,
    name: spu.name,
    productPlanId: spu.productPlanId,
    description: plan.description ?? "",
    revision: fingerprint({
      code: spu.code,
      name: spu.name,
      description: plan.description,
      planName: plan.name,
      spuUpdatedAt: spu.updatedAt.toISOString(),
      planUpdatedAt: plan.updatedAt.toISOString(),
    }),
  };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(",")}`;
  return JSON.stringify(value) ?? "null";
}
export async function lockDevelopment(tx: TenantTransaction, context: TenantContext, key: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:catalog:${key}`},0))`,
  );
}
export async function mutateDevelopment<T extends Record<string, unknown>>(
  database: DatabaseConnection,
  context: TenantContext,
  request: { key: string; action: string; resourceId: string; reason: string; input: unknown },
  operation: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return withTenant(database.db, context, async (tx) => {
    await lockDevelopment(tx, context, `request:${request.key}`);
    const digest = fingerprint({ action: request.action, input: request.input });
    const [prior] = await tx
      .select()
      .from(developmentEvents)
      .where(eq(developmentEvents.idempotencyKey, request.key));
    if (prior) {
      if (prior.requestHash !== digest)
        throw new ConflictException("此请求编号已用于不同内容，请刷新后重试");
      return prior.result as T;
    }
    const result = await operation(tx);
    await tx.insert(developmentEvents).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      createdBy: context.userId,
      resourceId: request.resourceId,
      action: request.action,
      reason: request.reason,
      idempotencyKey: request.key,
      requestHash: digest,
      result,
    });
    return result;
  });
}
export async function readArtwork(tx: TenantTransaction, versionId: string): Promise<ArtworkView> {
  const [row] = await tx
    .select({
      master: artworkMasters,
      version: artworkMasterVersions,
      assetVersion: creativeDesignVersionAssets.assetVersion,
      asset: assetFiles,
    })
    .from(artworkMasterVersions)
    .innerJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
    .leftJoin(assetFiles, eq(assetFiles.id, artworkMasterVersions.assetId))
    .leftJoin(
      creativeDesignVersionAssets,
      and(
        eq(
          creativeDesignVersionAssets.creativeDesignVersionId,
          artworkMasterVersions.creativeVersionId,
        ),
        eq(creativeDesignVersionAssets.assetId, artworkMasterVersions.assetId),
        eq(creativeDesignVersionAssets.role, "master"),
      ),
    )
    .where(eq(artworkMasterVersions.id, versionId));
  if (!row) throw new NotFoundException("印花版本不存在");
  const { master, version } = row;
  if (version.assetId && (!row.asset || !row.assetVersion))
    throw new ConflictException("印花主文件版本不可用");
  return {
    id: master.id,
    code: master.code,
    name: version.name,
    mode: version.mode,
    versionId: version.id,
    version: version.versionNumber,
    creativeVersionId: version.creativeVersionId,
    assetId: version.assetId,
    assetVersion: row.assetVersion,
    archived: !!master.archivedAt,
    tags: version.tags,
    researchItemIds: version.researchItemIds,
    customization: version.customization,
    instructions: version.instructions,
    layout: version.layout,
    materials: version.materials.length
      ? version.materials
      : version.assetId && row.asset && row.assetVersion ? [
          {
            assetId: version.assetId,
            assetVersion: row.assetVersion,
            checksumSha256: row.asset.checksumSha256,
            fileName: row.asset.fileName,
            mediaType: row.asset.mediaType,
            role: "master",
            usage: "印花主文件",
          },
        ] : [],
    createdAt: version.createdAt.toISOString(),
  };
}
export async function readSpecification(
  tx: TenantTransaction,
  versionId: string,
): Promise<SpecificationView> {
  const [row] = await tx
    .select({
      spec: productSpecifications,
      version: productSpecificationVersions,
      spu: spus,
      process: printProfileVersions,
    })
    .from(productSpecificationVersions)
    .innerJoin(
      productSpecifications,
      eq(productSpecifications.id, productSpecificationVersions.specificationId),
    )
    .innerJoin(spus, eq(spus.id, productSpecifications.spuId))
    .leftJoin(
      printProfileVersions,
      eq(printProfileVersions.id, productSpecificationVersions.processProfileVersionId),
    )
    .where(eq(productSpecificationVersions.id, versionId));
  if (!row) throw new NotFoundException("产品规格版本不存在");
  const { spec, version, spu, process } = row;
  return {
    id: spec.id,
    spuId: spu.id,
    spuCode: spu.code,
    spuName: spu.name,
    code: spec.code,
    name: version.name,
    versionId: version.id,
    version: version.versionNumber,
    attributes: version.attributes,
    facts: version.facts,
    processProfileVersionId: process?.id ?? null,
    processName: process?.name ?? "规格草稿 · 待补工艺底稿",
    productType: (process?.productType ?? null) as SpecificationView["productType"],
    canvasPrintSpecVersionId: version.canvasPrintSpecVersionId,
    stockItemId: version.stockItemId,
    createdAt: version.createdAt.toISOString(),
  };
}
export async function readRecipe(
  tx: TenantTransaction,
  recipeId: string,
): Promise<SalesRecipeView> {
  const [row] = await tx
    .select({ recipe: salesRecipeVersions, definition: salesSkuDefinitions, sku: skus })
    .from(salesRecipeVersions)
    .innerJoin(salesSkuDefinitions, eq(salesSkuDefinitions.skuId, salesRecipeVersions.skuId))
    .innerJoin(skus, eq(skus.id, salesRecipeVersions.skuId))
    .where(eq(salesRecipeVersions.id, recipeId));
  if (!row) throw new NotFoundException("销售 SKU 制作版本不存在");
  const artwork = await readArtwork(tx, row.recipe.artworkVersionId),
    specification = await readSpecification(tx, row.recipe.specificationVersionId);
  assertSpecificationProcess(specification);
  const [master] = await tx
    .select({ version: artworkMasters.versionNumber })
    .from(artworkMasters)
    .where(eq(artworkMasters.id, artwork.id));
  const [spec] = await tx
    .select({ version: productSpecifications.versionNumber })
    .from(productSpecifications)
    .where(eq(productSpecifications.id, specification.id));
  return {
    id: row.recipe.id,
    skuId: row.sku.id,
    skuCode: row.sku.code,
    styleId: row.definition.styleId,
    version: row.recipe.versionNumber,
    artwork,
    specification,
    status: row.recipe.status as SalesRecipeView["status"],
    editorProjectId: row.recipe.editorProjectId,
    editorVersionId: row.recipe.editorVersionId,
    renderId: row.recipe.renderId,
    designVersionId: row.recipe.designVersionId,
    needsUpdate: master!.version !== artwork.version || spec!.version !== specification.version,
    createdAt: row.recipe.createdAt.toISOString(),
  };
}
export function assertSpecificationProcess(specification: SpecificationView): asserts specification is SalesRecipeView["specification"] {
  if (!specification.processProfileVersionId || !specification.productType)
    throw new ConflictException("规格仍为草稿，请先补齐并审核工艺底稿");
}
export async function latestRecipe(
  tx: TenantTransaction,
  skuId: string,
): Promise<SalesRecipeView | null> {
  const [row] = await tx
    .select({ id: salesRecipeVersions.id })
    .from(salesRecipeVersions)
    .where(eq(salesRecipeVersions.skuId, skuId))
    .orderBy(desc(salesRecipeVersions.versionNumber))
    .limit(1);
  return row ? readRecipe(tx, row.id) : null;
}
export async function currentArtworkIds(tx: TenantTransaction, archived = false) {
  return tx
    .select({ id: artworkMasterVersions.id })
    .from(artworkMasters)
    .innerJoin(
      artworkMasterVersions,
      and(
        eq(artworkMasterVersions.artworkId, artworkMasters.id),
        eq(artworkMasterVersions.versionNumber, artworkMasters.versionNumber),
      ),
    )
    .where(archived ? isNotNull(artworkMasters.archivedAt) : isNull(artworkMasters.archivedAt))
    .orderBy(desc(artworkMasterVersions.createdAt));
}
export async function assertActiveArtwork(tx: TenantTransaction, artwork: ArtworkView) {
  const [master] = await tx.select().from(artworkMasters).where(eq(artworkMasters.id, artwork.id)).for("share");
  if (!master || master.archivedAt) throw new ConflictException("印花已归档，请先恢复后再使用");
}
export async function readArtworkMaterials(tx: TenantTransaction, artwork: ArtworkView) {
  const ids = artwork.materials.map(m => m.assetId);
  const materials = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).for("share") : [];
  assertAuthorizedAssets(ids, materials, "印花素材");
  for (const pin of artwork.materials) {
    const file = materials.find(m => m.id === pin.assetId);
    if (!file || file.deletedAt || file.version !== pin.assetVersion || file.checksumSha256 !== pin.checksumSha256)
      throw new ConflictException(`印花素材不可用或版本已变化：${pin.usage}`);
  }
  return materials;
}
export async function currentSpecificationIds(tx: TenantTransaction) {
  return tx
    .select({ id: productSpecificationVersions.id })
    .from(productSpecifications)
    .innerJoin(
      productSpecificationVersions,
      and(
        eq(productSpecificationVersions.specificationId, productSpecifications.id),
        eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber),
      ),
    )
    .innerJoin(spus, eq(spus.id, productSpecifications.spuId))
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(and(ne(spus.status, "archived"), ne(productPlans.status, "archived")))
    .orderBy(desc(productSpecificationVersions.createdAt));
}
