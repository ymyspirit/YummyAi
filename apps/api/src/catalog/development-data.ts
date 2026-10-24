import { ConflictException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import {
assertCatalogMutationAccess,catalogOwnerFilter,
catalogPlanFilter,currentCatalogContext,assertSpecificationProcess as sharedAssertSpecificationProcess,readArtwork as sharedReadArtwork,readRecipe as sharedReadRecipe,readSpecification as sharedReadSpecification,resolvePrintBindings as sharedResolvePrintBindings,type CatalogMutationAccess
} from "@yummyai/catalog-core";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import {
type PrintBinding
} from "@yummyai/contracts/catalog/composition";
import type {
ArtworkView,
ProductSpuView,
SalesRecipeView,
SpecificationView,
} from "@yummyai/contracts/catalog/development";
import { specificationFactProblems } from "@yummyai/contracts/catalog/development";
import {
artworkMasters,
artworkMasterVersions,
assetFiles,
developmentEvents,
productPlans,
productSpecifications,
productSpecificationVersions,
salesRecipePrintBindings,
salesRecipeVersions,
spus,
type DatabaseConnection,
type TenantTransaction
} from "@yummyai/database";
import { and,desc,eq,inArray,isNotNull,isNull,ne,sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { originalOwnerOperation,rethrowOriginalOwnerError } from "../shared/original-owner-error.js";
import { withCatalogTenant as withTenant } from "./catalog-access.js";

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
    ...(spu.legacyPlanAmbiguous ? { legacyPlanAmbiguous: true } : {}),
    ...(plan.createdBy ? { ownerUserId: plan.createdBy } : {}),
    ...(plan.teamId ? { teamId: plan.teamId } : {}),
    description: plan.description ?? "",
    capabilities: spu.capabilities,
    revision: fingerprint({
      code: spu.code,
      name: spu.name,
      description: plan.description,
      planName: plan.name,
      teamId: plan.teamId,
      capabilities: spu.capabilities,
      legacyPlanAmbiguous: spu.legacyPlanAmbiguous,
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
  request: {
    key: string;
    action: string;
    resourceId: string;
    reason: string;
    input: unknown;
    eventId?: string;
    access: CatalogMutationAccess;
    validateSources?: (tx: TenantTransaction, current: TenantContext) => Promise<void>;
    validateCachedResult?: (
      tx: TenantTransaction,
      current: TenantContext,
      result: unknown,
    ) => Promise<void>;
  },
  operation: (tx: TenantTransaction, current: TenantContext) => Promise<T>,
): Promise<T> {
  return withTenant(database.db, context, async (tx) => {
    context = await currentCatalogContext(tx, context);
    await assertCatalogMutationAccess(tx, context, request.access);
    await request.validateSources?.(tx, context);
    await lockDevelopment(tx, context, `request:${request.key}`);
    const digest = fingerprint({ action: request.action, input: request.input });
    const [prior] = await tx
      .select()
      .from(developmentEvents)
      .where(eq(developmentEvents.idempotencyKey, request.key));
    if (prior) {
      if (prior.createdBy !== context.userId)
        throw new ConflictException("请求编号属于其他操作者 请重新提交");
      if (prior.requestHash !== digest)
        throw new ConflictException("此请求编号已用于不同内容，请刷新后重试");
      await request.validateCachedResult?.(tx, context, prior.result);
      return prior.result as T;
    }
    const result = await operation(tx, context);
    await tx.insert(developmentEvents).values({
      id: request.eventId ?? createEntityId(),
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
export async function readArtwork(tx: TenantTransaction,versionId: string):Promise<ArtworkView>{return originalOwnerOperation(()=>sharedReadArtwork(tx,versionId));}
export async function readSpecification(tx: TenantTransaction,versionId: string):Promise<SpecificationView>{return originalOwnerOperation(()=>sharedReadSpecification(tx,versionId));}
export async function readRecipe(tx: TenantTransaction,recipeId: string):Promise<SalesRecipeView>{return originalOwnerOperation(()=>sharedReadRecipe(tx,recipeId));}
export async function resolvePrintBindings(tx: TenantTransaction,bindings: PrintBinding[]){return originalOwnerOperation(()=>sharedResolvePrintBindings(tx,bindings));}
export async function savePrintBindings(
  tx: TenantTransaction,
  context: TenantContext,
  recipeId: string,
  bindings: PrintBinding[],
) {
  await tx.insert(salesRecipePrintBindings).values(
    bindings.map((binding, position) => ({
      id: createEntityId(),
      tenantId: context.tenantId,
      createdBy: context.userId,
      recipeId,
      position,
      artworkVersionId: binding.artworkVersionId,
      binding,
    })),
  );
}
export function assertSpecificationProcess(specification: SpecificationView): asserts specification is SalesRecipeView['specification'] {try{sharedAssertSpecificationProcess(specification);}catch(error){rethrowOriginalOwnerError(error);}}
export function assertSpecificationFactsForNewWork(specification: SpecificationView) {
  const problems = specificationFactProblems(specification.facts);
  if (problems.length) throw new ConflictException(`产品事实未完成确认：${problems.join("；")}`);
}
export { assertCatalogSourceActive as assertActiveCatalogSource } from "@yummyai/catalog-core";
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
export async function currentArtworkIds(
  tx: TenantTransaction,
  context: TenantContext,
  archived = false,
) {
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
    .where(
      and(
        archived ? isNotNull(artworkMasters.archivedAt) : isNull(artworkMasters.archivedAt),
        catalogOwnerFilter(
          context,
          Permission.DesignRead,
          artworkMasters.createdBy,
          artworkMasters.teamId,
        ),
      ),
    )
    .orderBy(desc(artworkMasterVersions.createdAt));
}
export async function assertActiveArtwork(tx: TenantTransaction, artwork: ArtworkView) {
  const [master] = await tx
    .select()
    .from(artworkMasters)
    .where(eq(artworkMasters.id, artwork.id))
    .for("share");
  if (!master || master.archivedAt) throw new ConflictException("印花已归档，请先恢复后再使用");
}
export async function readArtworkMaterials(tx: TenantTransaction, artwork: ArtworkView) {
  const ids = artwork.materials.map((m) => m.assetId);
  const materials = ids.length
    ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).for("share")
    : [];
  assertAuthorizedAssets(ids, materials, "印花素材");
  for (const pin of artwork.materials) {
    const file = materials.find((m) => m.id === pin.assetId);
    if (
      !file ||
      file.deletedAt ||
      file.version !== pin.assetVersion ||
      file.checksumSha256 !== pin.checksumSha256
    )
      throw new ConflictException(`印花素材不可用或版本已变化：${pin.usage}`);
  }
  return materials;
}
export async function currentSpecificationIds(tx: TenantTransaction, context: TenantContext) {
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
    .where(
      and(
        ne(spus.status, "archived"),
        ne(productPlans.status, "archived"),
        catalogPlanFilter(context, Permission.ProductRead),
      ),
    )
    .orderBy(desc(productSpecificationVersions.createdAt));
}
