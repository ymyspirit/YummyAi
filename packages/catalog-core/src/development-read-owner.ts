import { authorize,Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { DevelopmentQuerySchema,type DevelopmentItem } from "@yummyai/contracts/catalog/development";
import { OriginalOwnerError } from "@yummyai/contracts/common/original-owner-error";
import { artworkMasters,artworkMasterVersions,developmentEvents,listings,listingVersions,marketplaceAccounts,productPlans,productSpecifications,productSpecificationVersions,salesChannelBindings,salesPackageVersions,salesRecipeVersions,salesSkuDefinitions,skus,spus,type DatabaseConnection } from "@yummyai/database";
import { and,desc,eq,inArray,isNull,ne,or,sql } from "drizzle-orm";
import { assertCatalogRecipeRead,assertCatalogSkuAccess,catalogOwnerFilter,catalogPackageReadFilter,catalogPlanFilter,catalogRecipeReadFilter,currentCatalogContext } from "./access.js";
import { readRecipe,withCatalogReadTenant as withTenant } from "./development-read-data.js";
export class DevelopmentReadOwner{constructor(private readonly database:DatabaseConnection){}
async workspace(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductRead);
    const query = DevelopmentQuerySchema.parse(body);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const packageRead =
        catalogPackageReadFilter(context, sql`p.recipe_id`, sql`p.listing_id`) ?? sql`true`;
      const packageCount = sql<number>`(select count(*)::int from sales_package_versions p where p.sku_id = ${skus.id} and ${packageRead})`;
      const needsUpdate = sql`(${artworkMasters.versionNumber} <> ${artworkMasterVersions.versionNumber} or ${productSpecifications.versionNumber} <> ${productSpecificationVersions.versionNumber} or exists(select 1 from sales_recipe_print_bindings b join artwork_master_versions v on v.id=b.artwork_version_id join artwork_masters a on a.id=v.artwork_id where b.recipe_id=${salesRecipeVersions.id} and a.version_number<>v.version_number))`;
      const status =
        query.status === "unmapped"
          ? isNull(salesRecipeVersions.id)
          : query.status === "packaged"
            ? sql`exists(select 1 from sales_package_versions p where p.recipe_id=${salesRecipeVersions.id} and ${packageRead})`
            : query.status === "needs_update"
              ? needsUpdate
              : query.status !== "all"
                ? eq(salesRecipeVersions.status, query.status)
                : undefined;
      const recipeScope = catalogRecipeReadFilter(context, salesRecipeVersions.id);
      const filter = and(
        catalogPlanFilter(context, Permission.ProductRead),
        recipeScope ? or(isNull(salesRecipeVersions.id), recipeScope) : undefined,
        ne(skus.status, "archived"),
        ne(spus.status, "archived"),
        ne(productPlans.status, "archived"),
        query.spuId ? eq(spus.id, query.spuId) : undefined,
        query.artworkId ? eq(artworkMasters.id, query.artworkId) : undefined,
        status,
        query.q
          ? sql`concat_ws(' ',${skus.code},${spus.code},${spus.name},${artworkMasters.code},${artworkMasterVersions.name},${skus.attributes}::text) ilike ${"%" + query.q.replace(/[\\%_]/g, "\\$&") + "%"}`
          : undefined,
      );
      const base = tx
        .select({
          sku: skus,
          spu: spus,
          plan: productPlans,
          recipeId: salesRecipeVersions.id,
          packageCount,
          total: sql<number>`count(*) over()::int`,
        })
        .from(skus)
        .innerJoin(spus, eq(spus.id, skus.spuId))
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .leftJoin(salesSkuDefinitions, eq(salesSkuDefinitions.skuId, skus.id))
        .leftJoin(
          salesRecipeVersions,
          and(
            eq(salesRecipeVersions.skuId, skus.id),
            eq(salesRecipeVersions.versionNumber, salesSkuDefinitions.versionNumber),
          ),
        )
        .leftJoin(
          artworkMasterVersions,
          eq(artworkMasterVersions.id, salesRecipeVersions.artworkVersionId),
        )
        .leftJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
        .leftJoin(
          productSpecificationVersions,
          eq(productSpecificationVersions.id, salesRecipeVersions.specificationVersionId),
        )
        .leftJoin(
          productSpecifications,
          eq(productSpecifications.id, productSpecificationVersions.specificationId),
        );
      const rows = await base
        .where(filter)
        .orderBy(desc(skus.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize);
      const items: DevelopmentItem[] = await Promise.all(
        rows.map(async (row) => ({
          skuId: row.sku.id,
          skuCode: row.sku.code,
          spuId: row.spu.id,
          spuCode: row.spu.code,
          spuName: row.spu.name,
          ownerUserId: row.plan.createdBy ?? undefined,
          ...(row.plan.teamId ? { teamId: row.plan.teamId } : {}),
          attributes: row.sku.attributes,
          recipe: row.recipeId ? await readRecipe(tx, row.recipeId) : null,
          packageCount: row.packageCount,
          updatedAt: row.sku.createdAt.toISOString(),
        })),
      );
      const total =
        rows[0]?.total ??
        (query.page > 1 ? (await base.where(filter).limit(1).offset(0))[0]?.total : 0) ??
        0;
      return { items, total, page: query.page, pageSize: query.pageSize };
    });
  }
async detail(context: TenantContext, skuId: string) {
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogSkuAccess(tx, context, skuId, [Permission.ProductRead]);
      const [row] = await tx
        .select({ sku: skus, spu: spus, plan: productPlans })
        .from(skus)
        .innerJoin(spus, eq(spus.id, skus.spuId))
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .where(eq(skus.id, skuId));
      if (!row) throw new OriginalOwnerError(404, "销售 SKU 不存在");
      const [currentRecipe] = await tx
        .select({ id: salesRecipeVersions.id })
        .from(salesRecipeVersions)
        .where(eq(salesRecipeVersions.skuId, skuId))
        .orderBy(desc(salesRecipeVersions.versionNumber))
        .limit(1);
      if (currentRecipe) await assertCatalogRecipeRead(tx, context, currentRecipe.id);
      const recipes = await Promise.all(
        (
          await tx
            .select({ id: salesRecipeVersions.id })
            .from(salesRecipeVersions)
            .where(
              and(
                eq(salesRecipeVersions.skuId, skuId),
                catalogRecipeReadFilter(context, salesRecipeVersions.id),
              ),
            )
            .orderBy(desc(salesRecipeVersions.versionNumber))
        ).map((r) => readRecipe(tx, r.id)),
      );
      const packages = (
        await tx
          .select()
          .from(salesPackageVersions)
          .where(
            and(
              eq(salesPackageVersions.skuId, skuId),
              catalogPackageReadFilter(
                context,
                salesPackageVersions.recipeId,
                salesPackageVersions.listingId,
              ),
            ),
          )
          .orderBy(desc(salesPackageVersions.createdAt))
      ).map((p) => ({
        id: p.id,
        skuId,
        skuCode: row.sku.code,
        recipeId: p.recipeId,
        version: p.versionNumber,
        platform: p.platform,
        marketplaceId: p.marketplaceId,
        locale: p.locale,
        listingId: p.listingId,
        listingVersionId: p.listingVersionId,
        title: String(p.snapshot.title ?? row.sku.code),
        checksum: p.checksum,
        createdAt: p.createdAt.toISOString(),
      }));
      const bindings =
        packages.length && context.permissions.includes(Permission.StoreRead)
          ? await tx
              .select({ binding: salesChannelBindings, account: marketplaceAccounts.displayName })
              .from(salesChannelBindings)
              .innerJoin(
                marketplaceAccounts,
                eq(marketplaceAccounts.id, salesChannelBindings.accountId),
              )
              .where(
                and(
                  catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
                  inArray(
                    salesChannelBindings.packageId,
                    packages.map((p) => p.id),
                  ),
                ),
              )
          : [];
      const listingRows =
        recipes.length && context.permissions.includes(Permission.ListingRead)
          ? await tx
              .select({ listing: listings, version: listingVersions })
              .from(listings)
              .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
              .where(
                and(
                  eq(listings.spuId, recipes[0]!.specification.spuId),
                  catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
                  sql`(${listings.styleId}=${recipes[0]!.styleId} or exists(select 1 from jsonb_array_elements(coalesce(${listingVersions.content}->'variants','[]'::jsonb)) v where v->>'skuId'=${skuId}) or ${listingVersions.content}->'attributes'->>'custom_sales_sku_mapping' like ${'%"skuId":"' + skuId + '"%'})`,
                ),
              )
              .orderBy(desc(listingVersions.versionNumber))
          : [];
      const relatedRecipes = recipes.length
        ? await Promise.all(
            (
              await tx
                .selectDistinctOn([salesRecipeVersions.skuId], { id: salesRecipeVersions.id })
                .from(salesRecipeVersions)
                .innerJoin(
                  salesSkuDefinitions,
                  eq(salesSkuDefinitions.skuId, salesRecipeVersions.skuId),
                )
                .where(
                  and(
                    eq(salesSkuDefinitions.styleId, recipes[0]!.styleId),
                    eq(salesRecipeVersions.status, "approved"),
                    eq(salesRecipeVersions.versionNumber, salesSkuDefinitions.versionNumber),
                    catalogRecipeReadFilter(context, salesRecipeVersions.id),
                  ),
                )
                .orderBy(salesRecipeVersions.skuId, desc(salesRecipeVersions.versionNumber))
            ).map((r) => readRecipe(tx, r.id)),
          )
        : [];
      const events = await tx
        .select()
        .from(developmentEvents)
        .where(
          inArray(developmentEvents.resourceId, [
            skuId,
            ...recipes.map((r) => r.id),
            ...packages.map((p) => p.id),
          ]),
        )
        .orderBy(desc(developmentEvents.createdAt))
        .limit(100);
      return {
        lifecycle: {
          active: ![row.plan.status, row.spu.status, row.sku.status].includes("archived"),
          archived: [
            ...(row.plan.status === "archived" ? ["product_plan" as const] : []),
            ...(row.spu.status === "archived" ? ["spu" as const] : []),
            ...(row.sku.status === "archived" ? ["sku" as const] : []),
          ],
        },
        access: {
          packageRead: [
            Permission.ProductRead,
            Permission.DesignRead,
            Permission.ListingRead,
          ].every((p) => context.permissions.includes(p)),
          channelRead: context.permissions.includes(Permission.StoreRead),
        },
        item: {
          skuId,
          skuCode: row.sku.code,
          spuId: row.spu.id,
          spuCode: row.spu.code,
          spuName: row.spu.name,
          ownerUserId: row.plan.createdBy ?? undefined,
          ...(row.plan.teamId ? { teamId: row.plan.teamId } : {}),
          attributes: row.sku.attributes,
          recipe: recipes[0] ?? null,
          packageCount: packages.length,
          updatedAt: recipes[0]?.createdAt ?? row.sku.createdAt.toISOString(),
        },
        recipes,
        relatedRecipes,
        packages,
        channelBindings: bindings.map(({ binding: b, account }) => ({
          id: b.id,
          packageId: b.packageId,
          accountId: b.accountId,
          accountName: account,
          externalSku: b.externalSku,
          externalListingId: b.externalListingId,
          effectiveFrom: b.effectiveFrom.toISOString(),
          customChoice: b.customChoice,
          evidence: b.evidence,
        })),
        listings: listingRows.map(({ listing: l, version: v }) => ({
          id: l.id,
          platform: l.platform,
          locale: l.locale,
          versionId: v.id,
          status: v.status,
          title: v.content.title,
          assetIds: [
            ...new Set(
              [v.content.mainImageId, ...v.content.mediaAssetIds].filter(
                (id): id is string => !!id,
              ),
            ),
          ],
        })),
        events: events.map((e) => ({
          id: e.id,
          action: e.action,
          reason: e.reason,
          actor: e.createdBy,
          occurredAt: e.createdAt.toISOString(),
        })),
      };
    });
  }
}
