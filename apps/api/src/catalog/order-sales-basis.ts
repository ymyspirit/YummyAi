import { ConflictException, NotFoundException } from "@nestjs/common";
import {
  amazonOrderReportBatches,
  amazonOrderReportBatchItems,
  orders,
  orderLines,
  salesChannelBindings,
  salesPackageVersions,
  salesRecipeVersions,
  artworkMasterVersions,
  artworkMasters,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, lte, isNull, or } from "drizzle-orm";
import type { OrderWorkDraft } from "@yummyai/contracts/order/workspace";
import {
  readArtwork,
  readRecipe,
  readSpecification,
  currentSpecificationIds,
  assertSpecificationProcess,
  readArtworkMaterials,
} from "./development-data.js";

export async function resolveOrderSalesBasis(tx: TenantTransaction, lineId: string) {
  const [source] = await tx
    .select({ order: orders, line: orderLines })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, lineId));
  if (!source) throw new NotFoundException("订单商品不存在");
  const reportSites = await tx
    .select({ site: amazonOrderReportBatches.marketplaceId })
    .from(amazonOrderReportBatchItems)
    .innerJoin(
      amazonOrderReportBatches,
      eq(amazonOrderReportBatches.id, amazonOrderReportBatchItems.batchId),
    )
    .where(eq(amazonOrderReportBatchItems.orderId, source.order.id));
  const sites = [...new Set(reportSites.map((r) => r.site))];
  const site = sites.length === 1 ? sites[0] : null;
  const matches = source.line.skuCode
    ? await tx
        .select({ binding: salesChannelBindings, pack: salesPackageVersions })
        .from(salesChannelBindings)
        .innerJoin(
          salesPackageVersions,
          eq(salesPackageVersions.id, salesChannelBindings.packageId),
        )
        .where(
          and(
            eq(salesChannelBindings.accountId, source.order.accountId),
            site ? eq(salesChannelBindings.marketplaceId, site) : undefined,
            eq(salesChannelBindings.externalSku, source.line.skuCode),
            source.line.externalListingId
              ? eq(salesChannelBindings.externalListingId, source.line.externalListingId)
              : undefined,
            lte(salesChannelBindings.effectiveFrom, source.order.placedAt),
            eq(salesPackageVersions.platform, source.order.platform),
          ),
        )
        .orderBy(desc(salesChannelBindings.effectiveFrom))
    : [];
  const identities = new Map<string, (typeof matches)[number]>();
  for (const m of matches) {
    const key = `${m.binding.marketplaceId}:${m.binding.externalListingId}`;
    if (!identities.has(key)) identities.set(key, m);
  }
  const picked = identities.size === 1 ? [...identities.values()][0]! : null;
  const recipe = picked ? await readRecipe(tx, picked.pack.recipeId) : null;
  return {
    status: picked
      ? ("matched" as const)
      : identities.size > 1
        ? ("ambiguous" as const)
        : ("unmatched" as const),
    packageId: picked?.pack.id ?? null,
    recipe,
  };
}

export async function validateOrderSalesBasis(tx: TenantTransaction, draft: OrderWorkDraft, allowPartial = false) {
  const recipe = draft.salesRecipeVersionId
    ? await readRecipe(tx, draft.salesRecipeVersionId)
    : null;
  if (!recipe && !draft.artworkVersionId && !draft.specificationVersionId && !draft.salesPackageId)
    return null;
  if (!recipe && allowPartial && (!draft.artworkVersionId || !draft.specificationVersionId)) {
    if (draft.salesPackageId) throw new ConflictException("请先匹配资料包对应的制作版本");
    if (draft.artworkVersionId) await readArtwork(tx, draft.artworkVersionId);
    if (draft.specificationVersionId) await readSpecification(tx, draft.specificationVersionId);
    return null;
  }
  if (
    recipe &&
    !(recipe.status === "approved" && recipe.editorProjectId && recipe.editorVersionId || recipe.status === "ready_for_customization" && !recipe.artwork.assetId && !recipe.editorProjectId && !recipe.editorVersionId)
  )
    throw new ConflictException("订单必须引用已审核的销售 SKU 制作版本");
  const specificationId = draft.specificationVersionId ?? recipe?.specification.versionId;
  const artworkId = draft.artworkVersionId ?? recipe?.artwork.versionId;
  if (!specificationId || !artworkId)
    throw new ConflictException("请为本单匹配印花 SKU、产品 SPU 和具体规格");
  const specification = await readSpecification(tx, specificationId);
  assertSpecificationProcess(specification);
  if (recipe && recipe.specification.versionId !== specificationId)
    throw new ConflictException("所选规格与销售 SKU 制作版本不一致，请重新匹配");
  if (!specification.facts.factsConfirmed) throw new ConflictException("产品规格事实尚未确认");
  if (draft.printProfileVersionId !== specification.processProfileVersionId)
    throw new ConflictException("订单工艺应与所选产品规格保持一致");
  if (draft.salesPackageId) {
    const [pack] = await tx
      .select()
      .from(salesPackageVersions)
      .where(eq(salesPackageVersions.id, draft.salesPackageId));
    if (!pack || pack.recipeId !== recipe?.id)
      throw new ConflictException("资料包与制作版本不一致");
  }
  const artwork = await readArtwork(tx, artworkId);
  const materials = await readArtworkMaterials(tx, artwork);
  const asset = artwork.assetId ? materials.find((m) => m.id === artwork.assetId) : undefined;
  if (artwork.assetId && !asset) throw new ConflictException("印花主文件未包含在素材包中");
  return { recipe, specification, artwork, asset, materials };
}

export async function orderSalesChoices(
  tx: TenantTransaction,
  pinnedSpecificationId?: string | null,
  pinnedArtworkId?: string | null,
  pinnedRecipeId?: string | null,
) {
  const rows = await tx
    .select({ id: salesRecipeVersions.id })
    .from(salesRecipeVersions)
    .where(or(eq(salesRecipeVersions.status, "approved"), eq(salesRecipeVersions.status, "ready_for_customization")))
    .orderBy(desc(salesRecipeVersions.createdAt));
  const recipes = (await Promise.all(rows.map((r) => readRecipe(tx, r.id)))).filter(r => !r.artwork.archived || r.id === pinnedRecipeId);
  const artworkIds = await tx
    .select({
      id: artworkMasterVersions.id,
      code: artworkMasters.code,
      name: artworkMasterVersions.name,
      version: artworkMasterVersions.versionNumber,
    })
    .from(artworkMasterVersions)
    .innerJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
    .where(or(isNull(artworkMasters.archivedAt), pinnedArtworkId ? eq(artworkMasterVersions.id, pinnedArtworkId) : undefined))
    .orderBy(artworkMasters.code, desc(artworkMasterVersions.versionNumber));
  const artworks = await Promise.all(artworkIds.map((a) => readArtwork(tx, a.id)));
  const specificationIds = new Set((await currentSpecificationIds(tx)).map((s) => s.id));
  for (const recipe of recipes) specificationIds.add(recipe.specification.versionId);
  if (pinnedSpecificationId) specificationIds.add(pinnedSpecificationId);
  const specifications = await Promise.all(
    [...specificationIds].map((id) => readSpecification(tx, id)),
  );
  return {
    recipes: recipes.map((r) => ({
      id: r.id,
      skuId: r.skuId,
      skuCode: r.skuCode,
      version: r.version,
      printSku: r.artwork.code,
      artworkVersionId: r.artwork.versionId,
      processProfileVersionId: r.specification.processProfileVersionId,
      spuCode: r.specification.spuCode,
      specification: r.specification.name,
      specificationVersionId: r.specification.versionId,
    })),
    artworks: artworks.map((a) => ({
      id: a.versionId,
      code: a.code,
      name: a.name,
      version: a.version,
      mode: a.mode,
      materials: a.materials,
      customization: a.customization,
      layout: a.layout,
      instructions: a.instructions,
    })),
    specifications: specifications.filter((s): s is typeof s & { processProfileVersionId: string } => !!s.processProfileVersionId && s.facts.factsConfirmed).map((s) => ({
      id: s.versionId,
      spuId: s.spuId,
      spuCode: s.spuCode,
      spuName: s.spuName,
      name: s.name,
      version: s.version,
      processProfileVersionId: s.processProfileVersionId,
      processName: s.processName,
      dimensions: s.facts.dimensions,
    })),
  };
}
