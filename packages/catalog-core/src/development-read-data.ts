import type { TenantContext } from "@yummyai/contracts";
import { composedArtwork,legacyPrintBinding,PrintBindingsSchema,type PrintBinding } from "@yummyai/contracts/catalog/composition";
import { specificationFactsReady,type ArtworkView,type SalesRecipeView,type SpecificationView } from "@yummyai/contracts/catalog/development";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { artworkMasters,artworkMasterVersions,assetFiles,creativeDesignVersionAssets,withTenant as databaseWithTenant,printProfileVersions,productSpecifications,productSpecificationVersions,salesRecipePrintBindings,salesRecipeVersions,salesSkuDefinitions,skus,spus,type DatabaseConnection,type TenantTransaction } from "@yummyai/database";
import { and,eq,inArray } from "drizzle-orm";
import { CatalogAccessNotFoundError,CatalogAuthorityChangedError } from "./access.js";
import { CatalogError } from "./errors.js";
export async function withCatalogReadTenant<T>(db:DatabaseConnection['db'],context:TenantContext,operation:(tx:TenantTransaction)=>Promise<T>){
try{return await databaseWithTenant(db,context,operation);}catch(error){
if(error instanceof CatalogAccessNotFoundError)throw new OriginalOwnerError(404,error.message);
if(error instanceof CatalogAuthorityChangedError)throw new OriginalOwnerError(409,error.message);
if(error instanceof CatalogError&&error.status===409)throw new OriginalOwnerError(409,error.message);
const value=error as {code?:string;cause?:{code?:string}};
if(['40P01','40001'].includes(value?.code??value?.cause?.code??''))throw new OriginalOwnerError(409,'并发更新中断 请先核对当前记录再操作');
throw error;}}
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
  if (!row) throw new OriginalOwnerError(404, "印花版本不存在");
  const { master, version } = row;
  if (version.assetId && (!row.asset || !row.assetVersion))
    throw new OriginalOwnerError(409, "印花主文件版本不可用");
  return {
    id: master.id,
    ownerUserId: master.createdBy,
    ...(master.teamId ? { teamId: master.teamId } : {}),
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
      : version.assetId && row.asset && row.assetVersion
        ? [
            {
              assetId: version.assetId,
              assetVersion: row.assetVersion,
              checksumSha256: row.asset.checksumSha256,
              fileName: row.asset.fileName,
              mediaType: row.asset.mediaType,
              role: "master",
              usage: "印花主文件",
            },
          ]
        : [],
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
  if (!row) throw new OriginalOwnerError(404, "产品规格版本不存在");
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
    factVerification: specificationFactsReady(version.facts)
      ? { confirmedByUserId: version.createdBy, confirmedAt: version.createdAt.toISOString(), reference: version.facts.verificationReference! }
      : null,
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
  if (!row) throw new OriginalOwnerError(404, "销售 SKU 制作版本不存在");
  const pins = await tx
    .select()
    .from(salesRecipePrintBindings)
    .where(eq(salesRecipePrintBindings.recipeId, recipeId))
    .orderBy(salesRecipePrintBindings.position);
  const printBindings = await resolvePrintBindings(
    tx,
    pins.length ? pins.map((p) => p.binding) : [legacyPrintBinding(row.recipe.artworkVersionId)],
  );
  const artwork = composedArtwork(printBindings),
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
    printBindings,
    specification,
    status: row.recipe.status as SalesRecipeView["status"],
    editorProjectId: row.recipe.editorProjectId,
    editorVersionId: row.recipe.editorVersionId,
    renderId: row.recipe.renderId,
    designVersionId: row.recipe.designVersionId,
    needsUpdate:
      master!.version !== artwork.version ||
      spec!.version !== specification.version ||
      (
        await tx
          .select()
          .from(artworkMasters)
          .where(
            inArray(
              artworkMasters.id,
              printBindings.map((b) => b.artwork.id),
            ),
          )
      ).some((m) =>
        printBindings.some((b) => b.artwork.id === m.id && b.artwork.version !== m.versionNumber),
      ),
    createdAt: row.recipe.createdAt.toISOString(),
  };
}
export async function resolvePrintBindings(tx: TenantTransaction, bindings: PrintBinding[]) {
  const pins = PrintBindingsSchema.parse(bindings);
  const resolved = await Promise.all(
    pins.map(async (binding) => ({
      ...binding,
      artwork: await readArtwork(tx, binding.artworkVersionId),
    })),
  );
  try {
    composedArtwork(resolved);
  } catch (error) {
    throw new OriginalOwnerError(409, error instanceof Error ? error.message : "印花组合无效");
  }
  return resolved;
}
export function assertSpecificationProcess(
  specification: SpecificationView,
): asserts specification is SalesRecipeView["specification"] {
  if (!specification.processProfileVersionId || !specification.productType)
    throw new OriginalOwnerError(409, "规格仍为草稿，请先补齐并审核工艺底稿");
}
