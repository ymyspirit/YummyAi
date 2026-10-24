import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { withCatalogTenant as withTenant } from "./catalog-access.js";
import {
  currentCatalogContext,
  assertCatalogRecipeRead,
  assertCatalogMutationAccess,
  catalogAssetReadFilter,
  catalogPackageReadFilter,
  assertCatalogSkuAccess,
  CatalogAccessNotFoundError,
} from "@yummyai/catalog-core";
import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateSalesListingSchema,
  SealSalesPackageSchema,
  BindSalesChannelSchema,
  SalesChannelPreviewSchema,
  type SalesChannelPreview,
} from "@yummyai/contracts/catalog/development";
import {
  salesPackageVersions,
  salesChannelBindings,
  salesRecipeVersions,
  salesSkuDefinitions,
  listingVersions,
  listings,
  marketplaceAccounts,
  assetFiles,
  designVersionFiles,
  mockupBatchOutputs,
  mockupBatchItems,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, gt, lt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import JSZip from "jszip";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { ListingService } from "../listings/listing.service.js";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { assertDeliveryReview, readDelivery } from "./sales-plan-delivery-data.js";
import {
  fingerprint,
  lockDevelopment,
  mutateDevelopment,
  readRecipe,
  readArtworkMaterials,
  assertActiveCatalogSource,
} from "./development-data.js";
import {
  listingOwnsRecipe,
  listingRecipeVariant,
  listingSalesSkuIds,
} from "./listing-composition.js";
import { printBindingSnapshot } from "@yummyai/contracts/catalog/composition";
import { OrderSalesDeliverySnapshotSchema } from "@yummyai/contracts/catalog/sales-plan-delivery";

@Injectable()
export class SalesPackageService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ListingService) private readonly listingService: ListingService,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  /** A historical package remains downloadable; it is current only while its
   * immutable source pins still match the selected business versions and assets. */
  async isCurrent(context: TenantContext, id: string, recipeId: string, listingVersionId: string) {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.ListingRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const [pack] = await tx
        .select()
        .from(salesPackageVersions)
        .where(eq(salesPackageVersions.id, id));
      if (pack) await this.assertPackageRead(tx, context, pack);
      if (!pack || pack.recipeId !== recipeId || pack.listingVersionId !== listingVersionId)
        return false;
      const delivery = pack.snapshot.salesPlanDelivery as
        { planId: string; fingerprint: string } | undefined;
      if (delivery) {
        try {
          const current = await readDelivery(tx, delivery.planId, context);
          if (current.issues.length || current.fingerprint !== delivery.fingerprint) return false;
        } catch {
          return false;
        }
      }
      const files = pack.snapshot.files as
        Array<{ id: string; version: number; checksum: string }> | undefined;
      if (!Array.isArray(files) || !files.length) return false;
      const assets = await tx
        .select()
        .from(assetFiles)
        .where(
          and(
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
            inArray(
              assetFiles.id,
              files.map((file) => file.id),
            ),
          ),
        );
      try {
        assertAuthorizedAssets(
          files.map((file) => file.id),
          assets,
          "当前资料包",
        );
      } catch {
        return false;
      }
      return files.every((file) =>
        assets.some(
          (asset) =>
            asset.id === file.id &&
            !asset.deletedAt &&
            asset.version === file.version &&
            asset.checksumSha256 === file.checksum,
        ),
      );
    });
  }

  /** Read only: resolve the current listing against its own approved SKU recipes and mockups. */
  async analysisBasis(context: TenantContext, listingId: string, expectedVersionId: string) {
    authorize(context, Permission.ListingRead);
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    const { listing, version } = await this.listingService.getWorkspace(context, listingId);
    if (version.id !== expectedVersionId || listing.status === "archived")
      throw new ConflictException("Listing 已更新或归档，请刷新后分析");
    const variants = version.content.variants;
    if ((!listing.styleId && !listing.salesPlanId) || !variants.length || variants.length > 50)
      throw new ConflictException(
        "请先从商品开发创建带有已审核 SKU 的 Listing，单次最多 50 个规格",
      );
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await assertCatalogMutationAccess(tx, context, {
        kind: "listingVersion",
        id: version.id,
        permissions: [Permission.ListingRead],
      });
      const recipes = [];
      for (const variant of variants) {
        const [latest] = await tx
          .select({ id: salesRecipeVersions.id })
          .from(salesRecipeVersions)
          .where(eq(salesRecipeVersions.skuId, variant.skuId))
          .orderBy(desc(salesRecipeVersions.versionNumber))
          .limit(1);
        if (!latest) throw new ConflictException("销售 SKU 尚未绑定印花与产品规格");
        await assertCatalogRecipeRead(tx, context, latest.id);
        const recipe = await readRecipe(tx, latest.id);
        if (
          !listingOwnsRecipe(listing, version.content, recipe) ||
          recipe.status !== "approved" ||
          !specificationFactsReady(recipe.specification.facts) ||
          recipe.skuCode !== variant.skuCode ||
          fingerprint(recipe.specification.attributes) !== fingerprint(variant.optionValues)
        )
          throw new ConflictException("请先核对并审核 Listing 所属 SKU 的制作版本、规格与产品事实");
        recipes.push(recipe);
      }
      const ids = [
        ...new Set(
          [version.content.mainImageId, ...version.content.mediaAssetIds].filter(
            (id): id is string => !!id,
          ),
        ),
      ];
      const images: Array<typeof assetFiles.$inferSelect> = [];
      for (const assetId of ids.slice(0, 16)) {
        const [source] = await tx
          .select({ asset: assetFiles, output: mockupBatchOutputs, item: mockupBatchItems })
          .from(mockupBatchOutputs)
          .innerJoin(mockupBatchItems, eq(mockupBatchItems.id, mockupBatchOutputs.itemId))
          .innerJoin(assetFiles, eq(assetFiles.id, mockupBatchOutputs.assetId))
          .where(
            and(
              eq(mockupBatchOutputs.assetId, assetId),
              eq(mockupBatchOutputs.status, "approved"),
              catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
            ),
          )
          .limit(1);
        if (
          !source ||
          source.asset.deletedAt ||
          !recipes.some(
            (r) =>
              r.skuId === source.item.skuId && r.designVersionId === source.item.designVersionId,
          ) ||
          source.asset.version !== source.output.assetVersion ||
          source.asset.checksumSha256 !== source.output.checksumSha256 ||
          !["image/png", "image/jpeg", "image/webp"].includes(source.asset.mediaType)
        )
          continue;
        assertAuthorizedAssets([assetId], [source.asset], "AI 分析套图");
        images.push(source.asset);
      }
      return {
        listing,
        version,
        recipes,
        images,
        mediaCount: ids.length,
        fingerprint: fingerprint({
          listingVersionId: version.id,
          recipes: recipes.map((r) => [r.id, r.status, r.artwork.id, r.specification.id]),
          images: images.map((a) => [a.id, a.version, a.checksumSha256]),
        }),
      };
    });
  }

  async analysisImage(context: TenantContext, asset: typeof assetFiles.$inferSelect) {
    authorize(context, Permission.DesignRead);
    const [current] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return tx
        .select()
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.id, asset.id),
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
          ),
        );
    });
    if (
      !current ||
      current.deletedAt ||
      current.version !== asset.version ||
      current.checksumSha256 !== asset.checksumSha256
    )
      throw new ConflictException("套图源文件已变化，请刷新后分析");
    assertAuthorizedAssets([current.id], [current], "AI 分析套图");
    const bytes = await this.storage.readPrivate(
      context,
      { ...current, assetDomain: "authorized" },
      { requiredDomain: "authorized" },
    );
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256)
      throw new ConflictException("套图文件内容已变化");
    return bytes;
  }

  async createListing(context: TenantContext, body: unknown) {
    authorize(context, Permission.ListingWrite);
    const input = CreateSalesListingSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "create",
          permissions: [Permission.ListingWrite],
          additional: [
            ...input.recipeIds.map((id) => ({
              kind: "recipe" as const,
              id,
              permissions: [Permission.ProductRead],
            })),
            ...input.recipeIds.map((id) => ({
              kind: "recipeArtwork" as const,
              id,
              permissions: [Permission.DesignRead],
            })),
          ],
        },
        key: input.idempotencyKey,
        action: "sales_listing.create",
        resourceId: input.recipeIds[0]!,
        reason: input.title,
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        const recipes = await Promise.all(input.recipeIds.map((id) => readRecipe(tx, id))),
          first = recipes[0]!;
        for (const recipe of recipes)
          await assertActiveCatalogSource(tx, recipe.specification.spuId, recipe.skuId);
        if (
          recipes.some((r) => r.styleId !== first.styleId || r.status !== "approved") ||
          new Set(recipes.map((r) => r.skuId)).size !== recipes.length
        )
          throw new ConflictException("同一 Listing 只能组合相同印花与 SPU 下的不同已审核销售 SKU");
        await lockDevelopment(
          tx,
          context,
          `listing:${first.styleId}:${input.platform}:${input.marketplaceId}:${input.locale}`,
        );
        const [existing] = await tx
          .select()
          .from(listings)
          .where(
            and(
              eq(listings.styleId, first.styleId),
              isNull(listings.salesPlanId),
              eq(listings.platform, input.platform),
              eq(listings.marketplaceId, input.marketplaceId),
              eq(listings.locale, input.locale),
            ),
          );
        if (existing) throw new ConflictException("此商品款式已有该渠道 Listing，请在详情中编辑它");
        return this.listingService.createDevelopmentDraft(tx, context, {
          spuId: first.specification.spuId,
          styleId: first.styleId,
          platform: input.platform,
          marketplaceId: input.marketplaceId,
          locale: input.locale,
          content: {
            platform: input.platform,
            locale: input.locale,
            title: input.title,
            description: "",
            bullets: [],
            tags: [],
            mediaAssetIds: [],
            variants: recipes.map((r) => ({
              skuId: r.skuId,
              skuCode: r.skuCode,
              optionValues: r.specification.attributes,
            })),
            attributes: {},
            compliance: {},
          },
        });
      },
    );
  }

  async seal(context: TenantContext, body: unknown) {
    authorize(context, Permission.ListingReview);
    authorize(context, Permission.ProductWrite);
    if (SealSalesPackageSchema.parse(body).deliveryReviewId) {
      for (const permission of [
        Permission.ProductRead,
        Permission.DesignRead,
        Permission.AssetRead,
        Permission.ListingRead,
      ])
        authorize(context, permission);
    }
    const input = SealSalesPackageSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "recipe",
          id: input.recipeId,
          permissions: [Permission.ProductWrite],
          additional: [
            {
              kind: "listingVersion",
              id: input.listingVersionId,
              permissions: [Permission.ListingReview],
            },
            { kind: "recipeArtwork", id: input.recipeId, permissions: [Permission.DesignRead] },
          ],
        },
        key: input.idempotencyKey,
        action: "sales_package.seal",
        resourceId: input.recipeId,
        reason: input.reason,
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        const sourceRecipe = await readRecipe(tx, input.recipeId);
        await assertActiveCatalogSource(tx, sourceRecipe.specification.spuId, sourceRecipe.skuId);
        const { recipe, listing, version, assets, mockupSources, production, delivery } =
          await this.prepareSeal(tx, context, input);
        await lockDevelopment(
          tx,
          context,
          `package:${recipe.skuId}:${listing.platform}:${listing.marketplaceId}:${listing.locale}`,
        );
        const [last] = await tx
          .select()
          .from(salesPackageVersions)
          .where(
            and(
              eq(salesPackageVersions.skuId, recipe.skuId),
              eq(salesPackageVersions.platform, listing.platform),
              eq(salesPackageVersions.marketplaceId, listing.marketplaceId!),
              eq(salesPackageVersions.locale, listing.locale),
            ),
          )
          .orderBy(desc(salesPackageVersions.versionNumber))
          .limit(1);
        const id = createEntityId(),
          snapshot = {
            schemaVersion: 1,
            title: version.content.title,
            recipe,
            listing: {
              id: listing.id,
              versionId: version.id,
              platform: listing.platform,
              marketplaceId: listing.marketplaceId,
              locale: listing.locale,
              content: version.content,
              validation: version.validation,
            },
            ...(delivery
              ? {
                  salesPlanDelivery: {
                    schemaVersion: 1,
                    planId: delivery.data.source.planId,
                    revision: delivery.data.source.revision,
                    fingerprint: delivery.data.fingerprint,
                    review: delivery.review,
                    customization: delivery.data.source.fields.customization,
                    layout: delivery.data.source.fields.layout,
                    ...(delivery.data.source.fields.patternChoices
                      ? { patternChoices: delivery.data.source.fields.patternChoices }
                      : {}),
                    customInstructions: delivery.data.source.fields.customInstructions,
                    customPage: delivery.data.source.fields.customPage,
                    customMaterials: delivery.data.source.fields.customMaterials,
                    skuMapping: delivery.data.recipes.map((r) => ({
                      skuId: r.skuId,
                      skuCode: r.recipe!.skuCode,
                      recipeId: r.recipe!.id,
                      specificationVersionId: r.recipe!.specification.versionId,
                      ...(delivery.data.source.fields.patternChoices
                        ? {
                            platformSkuId: listingRecipeVariant(
                              version.content as Parameters<typeof listingRecipeVariant>[0],
                              r.recipe!,
                            )!.skuId,
                            platformSkuCode: listingRecipeVariant(
                              version.content as Parameters<typeof listingRecipeVariant>[0],
                              r.recipe!,
                            )!.skuCode,
                            customChoice: {
                              [delivery.data.source.fields.patternChoices.fieldKey]:
                                delivery.data.source.fields.patternChoices.options.find(
                                  (o) => o.skuId === r.skuId,
                                )!.value,
                            },
                          }
                        : {}),
                      printBindings: r.recipe!.printBindings?.map(printBindingSnapshot),
                      customization: r.recipe!.artwork.customization,
                      layout: r.recipe!.artwork.layout,
                      attributes: r.recipe!.specification.attributes,
                    })),
                  },
                }
              : {}),
            imageEvidence: input.imageEvidence,
            mockupSources,
            files: assets.map((a) => ({
              id: a.id,
              version: a.version,
              checksum: a.checksumSha256,
              objectKey: a.objectKey,
              name: a.fileName,
              mediaType: a.mediaType,
              byteSize: a.byteSize,
              role:
                a.id === recipe.artwork.assetId
                  ? "artwork_master"
                  : production.some((p) => p.id === a.id)
                    ? "production"
                    : delivery?.data.source.fields.customMaterials.some((m) => m.assetId === a.id)
                      ? "customization"
                      : delivery && recipe.artwork.materials.some((m) => m.assetId === a.id)
                        ? "artwork_source"
                        : "listing",
            })),
            review: { actor: context.userId, reason: input.reason, at: new Date().toISOString() },
          };
        // Hash the exact JSON representation stored in PostgreSQL. Optional
        // fields must not hash as null and then disappear during persistence.
        const persistedSnapshot = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
        const checksum = fingerprint(persistedSnapshot);
        await tx.insert(salesPackageVersions).values({
          id,
          tenantId: context.tenantId,
          createdBy: context.userId,
          skuId: recipe.skuId,
          recipeId: recipe.id,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          listingId: listing.id,
          listingVersionId: version.id,
          platform: listing.platform,
          marketplaceId: listing.marketplaceId!,
          locale: listing.locale,
          snapshot: persistedSnapshot,
          checksum,
        });
        return { packageId: id, checksum };
      },
    );
  }

  /** Shared read-only preflight; the original manufacturing and mockup gates remain authoritative. */
  async prepareSeal(
    tx: TenantTransaction,
    context: TenantContext,
    input: ReturnType<typeof SealSalesPackageSchema.parse>,
  ) {
    context = await currentCatalogContext(tx, context);
    await assertCatalogRecipeRead(tx, context, input.recipeId);
    await assertCatalogMutationAccess(tx, context, {
      kind: "listingVersion",
      id: input.listingVersionId,
      permissions: [Permission.ListingRead],
    });
    const recipe = await readRecipe(tx, input.recipeId);
    if (
      recipe.status !== "approved" ||
      !recipe.designVersionId ||
      !specificationFactsReady(recipe.specification.facts)
    )
      throw new ConflictException("请先审核 SKU 制作版本与产品事实");
    const [listing] = await tx.select().from(listings).where(eq(listings.id, input.listingId));
    const [version] = await tx
      .select()
      .from(listingVersions)
      .where(
        and(
          eq(listingVersions.id, input.listingVersionId),
          eq(listingVersions.listingId, input.listingId),
        ),
      );
    if (
      !listing ||
      !version ||
      !listingOwnsRecipe(listing, version.content, recipe) ||
      listing.status !== "approved" ||
      version.status !== "approved" ||
      listing.primaryVersionId !== version.id
    )
      throw new ConflictException("请选择本款式当前已审核 Listing 版本");
    const variant = listingRecipeVariant(version.content, recipe);
    if (
      !variant ||
      fingerprint(variant.optionValues) !== fingerprint(recipe.specification.attributes)
    )
      throw new ConflictException("Listing 缺少此销售 SKU 变体");
    const ids = [
      ...new Set(
        [version.content.mainImageId, ...version.content.mediaAssetIds].filter(
          (v): v is string => !!v,
        ),
      ),
    ];
    if (
      !version.content.mainImageId ||
      !ids.length ||
      ids.length !== input.imageEvidence.length ||
      new Set(input.imageEvidence.map((e) => e.assetId)).size !== ids.length ||
      input.imageEvidence.some((e) => !ids.includes(e.assetId))
    )
      throw new ConflictException("每张上架图片都需注明实物、套图或信息图用途");
    const mockups = input.imageEvidence.filter((e) => e.kind === "mockup");
    const mockupSources: Array<{
      assetId: string;
      outputId: string;
      skuId: string;
      recipeId: string;
      assetVersion: number;
      checksum: string;
    }> = [];
    for (const evidence of mockups) {
      const [output] = await tx
        .select({
          id: mockupBatchOutputs.id,
          skuId: mockupBatchItems.skuId,
          recipeId: salesRecipeVersions.id,
          assetVersion: mockupBatchOutputs.assetVersion,
          checksum: mockupBatchOutputs.checksumSha256,
        })
        .from(mockupBatchOutputs)
        .innerJoin(mockupBatchItems, eq(mockupBatchItems.id, mockupBatchOutputs.itemId))
        .innerJoin(
          salesRecipeVersions,
          and(
            eq(salesRecipeVersions.skuId, mockupBatchItems.skuId),
            eq(salesRecipeVersions.designVersionId, mockupBatchItems.designVersionId),
          ),
        )
        .innerJoin(salesSkuDefinitions, eq(salesSkuDefinitions.skuId, salesRecipeVersions.skuId))
        .where(
          and(
            eq(mockupBatchOutputs.assetId, evidence.assetId),
            eq(mockupBatchOutputs.status, "approved"),
            eq(salesRecipeVersions.status, "approved"),
            inArray(salesSkuDefinitions.skuId, listingSalesSkuIds(version.content)),
            inArray(mockupBatchItems.skuId, listingSalesSkuIds(version.content)),
            or(ne(salesRecipeVersions.skuId, recipe.skuId), eq(salesRecipeVersions.id, recipe.id)),
          ),
        );
      if (!output || !output.assetVersion || !output.checksum)
        throw new ConflictException("套图必须来自本 Listing 同款规格的已审核制作版本");
      mockupSources.push({
        assetId: evidence.assetId,
        outputId: output.id,
        skuId: output.skuId!,
        recipeId: output.recipeId,
        assetVersion: output.assetVersion,
        checksum: output.checksum,
      });
    }
    if (!mockupSources.some((m) => m.recipeId === recipe.id))
      throw new ConflictException("资料包至少需要一张来自此制作版本的已审核套图");
    if (
      listing.platform === "amazon" &&
      recipe.artwork.mode !== "fixed" &&
      !input.imageEvidence.some(
        (e) => e.assetId === version.content.mainImageId && e.kind === "finished_photo",
      )
    )
      throw new ConflictException("Amazon 定制商品主图需确认是实际成品照片");
    const production = await tx
      .select({ id: designVersionFiles.assetFileId })
      .from(designVersionFiles)
      .where(
        and(
          eq(designVersionFiles.versionId, recipe.designVersionId),
          eq(designVersionFiles.role, "production"),
        ),
      );
    const delivery = input.deliveryReviewId
      ? await assertDeliveryReview(
          tx,
          context,
          input.deliveryReviewId,
          recipe.id,
          listing.id,
          version.id,
          input.imageEvidence,
        )
      : null;
    const allIds = [
      ...new Set([
        ...ids,
        ...(recipe.artwork.assetId ? [recipe.artwork.assetId] : []),
        ...(recipe.printBindings?.flatMap((b) => (b.artwork.assetId ? [b.artwork.assetId] : [])) ??
          []),
        ...production.map((p) => p.id),
        ...(delivery?.data.source.fields.customMaterials.map((m) => m.assetId) ?? []),
        ...(delivery ? recipe.artwork.materials.map((m) => m.assetId) : []),
      ]),
    ];
    const assets = await tx
      .select()
      .from(assetFiles)
      .where(
        and(
          inArray(assetFiles.id, allIds),
          catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
        ),
      );
    for (const b of recipe.printBindings ?? []) {
      await readArtworkMaterials(tx, b.artwork);
      if (
        b.artwork.assetId &&
        assets.find((a) => a.id === b.artwork.assetId)?.version !== b.artwork.assetVersion
      )
        throw new ConflictException("组合印花主文件版本已变化，请重新核对全部制作面");
    }
    assertAuthorizedAssets(allIds, assets, "上架资料包");
    if (assets.some((a) => a.deletedAt)) throw new ConflictException("资料包素材已删除");
    if (
      mockupSources.some((m) => {
        const asset = assets.find((a) => a.id === m.assetId);
        return !asset || asset.version !== m.assetVersion || asset.checksumSha256 !== m.checksum;
      })
    )
      throw new ConflictException("已审核套图文件版本已变化，请重新核对");
    if (
      recipe.artwork.assetId &&
      assets.find((a) => a.id === recipe.artwork.assetId)?.version !== recipe.artwork.assetVersion
    )
      throw new ConflictException("印花主文件版本已变化，请核对制作来源");
    return { recipe, listing, version, assets, mockupSources, production, delivery };
  }

  private async bindingSource(
    tx: TenantTransaction,
    context: TenantContext,
    input: ReturnType<typeof SalesChannelPreviewSchema.parse>,
  ) {
    for (const p of [
      Permission.ProductRead,
      Permission.DesignRead,
      Permission.ListingRead,
      Permission.StoreRead,
    ])
      authorize(context, p);
    const [pack] = await tx
      .select()
      .from(salesPackageVersions)
      .where(eq(salesPackageVersions.id, input.packageId));
    if (!pack) throw new NotFoundException("资料包或店铺不存在");
    await this.assertPackageRead(tx, context, pack);
    await assertCatalogMutationAccess(tx, context, {
      kind: "account",
      id: input.accountId,
      permissions: [Permission.StoreRead],
    });
    const [account] = await tx
      .select()
      .from(marketplaceAccounts)
      .where(eq(marketplaceAccounts.id, input.accountId))
      .for("share");
    if (!account || account.deletedAt) throw new NotFoundException("资料包或店铺不存在");
    if (pack.platform !== account.platform || !account.marketplaceIds.includes(pack.marketplaceId))
      throw new ConflictException("资料包平台与站点必须属于所选店铺");
    if (fingerprint(pack.snapshot) !== pack.checksum)
      throw new ConflictException("原资料包校验失败 请核对封存记录");
    const recipe = pack.snapshot.recipe as
      { id?: string; skuId?: string; skuCode?: string } | undefined;
    const listing = pack.snapshot.listing as { id?: string; versionId?: string } | undefined;
    const [version] = await tx
      .select({ listingId: listingVersions.listingId })
      .from(listingVersions)
      .where(eq(listingVersions.id, pack.listingVersionId));
    if (
      recipe?.id !== pack.recipeId ||
      recipe.skuId !== pack.skuId ||
      !recipe.skuCode ||
      listing?.id !== pack.listingId ||
      listing.versionId !== pack.listingVersionId ||
      version?.listingId !== pack.listingId
    )
      throw new ConflictException("原资料包缺少一致的 SKU 与刊登依据 请核对封存记录 不得补写历史");
    if (pack.snapshot.salesPlanDelivery !== undefined) {
      const parsed = OrderSalesDeliverySnapshotSchema.safeParse(pack.snapshot.salesPlanDelivery);
      if (!parsed.success) throw new ConflictException("原资料包缺少完整交付核对 不得补写历史");
      const delivery = parsed.data,
        selected = delivery.skuMapping.find((m) => m.skuId === pack.skuId);
      if (
        !selected ||
        selected.recipeId !== pack.recipeId ||
        selected.skuCode !== recipe.skuCode ||
        delivery.review.fingerprint !== delivery.fingerprint ||
        delivery.review.revision !== delivery.revision ||
        delivery.review.listingVersionId !== pack.listingVersionId
      )
        throw new ConflictException("原交付核对与资料包身份不一致 请重新核对封存来源");
      if (selected.platformSkuCode && selected.platformSkuCode !== input.externalSku)
        throw new ConflictException("渠道 SKU 必须与封存资料包中的平台 SKU 一致");
      if (delivery.patternChoices) {
        const option = delivery.patternChoices.options.find((o) => o.skuId === pack.skuId);
        if (
          !option ||
          fingerprint(input.customChoice) !==
            fingerprint({ [delivery.patternChoices.fieldKey]: option.value }) ||
          (selected.platformSkuCode && selected.platformSkuCode !== input.externalSku)
        )
          throw new ConflictException(
            "渠道 SKU 和 Custom 选款必须与封存资料包中的销售 SKU 映射一致",
          );
      } else if (Object.keys(input.customChoice).length)
        throw new ConflictException("封存方案未配置选款 不能在渠道映射中新增选款条件");
    }
    return { pack, account, skuCode: recipe.skuCode };
  }
  async previewBinding(context: TenantContext, body: unknown): Promise<SalesChannelPreview> {
    authorize(context, Permission.ProductRead);
    const input = SalesChannelPreviewSchema.parse(body);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const { pack, account, skuCode } = await this.bindingSource(tx, context, input);
      const key = Object.keys(input.customChoice).length
        ? fingerprint(input.customChoice)
        : "legacy";
      const identity = and(
        eq(salesChannelBindings.accountId, account.id),
        eq(salesChannelBindings.marketplaceId, pack.marketplaceId),
        eq(salesChannelBindings.externalSku, input.externalSku),
        eq(salesChannelBindings.externalListingId, input.externalListingId),
        eq(salesChannelBindings.customChoiceKey, key),
      );
      const selection = {
        effectiveFrom: salesChannelBindings.effectiveFrom,
        packageId: salesPackageVersions.id,
        version: salesPackageVersions.versionNumber,
        readable: sql<boolean>`(${catalogPackageReadFilter(context, salesPackageVersions.recipeId, salesPackageVersions.listingId) ?? sql`true`})`,
      };
      const at = new Date(input.effectiveFrom);
      const [[exact], [before], [after]] = await Promise.all([
        tx
          .select({ id: salesChannelBindings.id })
          .from(salesChannelBindings)
          .where(and(identity, eq(salesChannelBindings.effectiveFrom, at)))
          .limit(1),
        tx
          .select(selection)
          .from(salesChannelBindings)
          .innerJoin(
            salesPackageVersions,
            eq(salesPackageVersions.id, salesChannelBindings.packageId),
          )
          .where(and(identity, lt(salesChannelBindings.effectiveFrom, at)))
          .orderBy(desc(salesChannelBindings.effectiveFrom))
          .limit(1),
        tx
          .select(selection)
          .from(salesChannelBindings)
          .innerJoin(
            salesPackageVersions,
            eq(salesPackageVersions.id, salesChannelBindings.packageId),
          )
          .where(and(identity, gt(salesChannelBindings.effectiveFrom, at)))
          .orderBy(asc(salesChannelBindings.effectiveFrom))
          .limit(1),
      ]);
      let canBind = false;
      try {
        await assertCatalogSkuAccess(tx, context, pack.skuId, [Permission.ProductWrite]);
        authorize(context, Permission.StoreManage, { ownerId: account.createdBy });
        canBind = true;
      } catch (error) {
        if (!(error instanceof ForbiddenError) && !(error instanceof CatalogAccessNotFoundError))
          throw error;
      }
      const timeline = (row: typeof before) =>
        row
          ? {
              effectiveFrom: row.effectiveFrom.toISOString(),
              package: row.readable ? { id: row.packageId, version: row.version } : null,
            }
          : null;
      return {
        input,
        package: {
          id: pack.id,
          version: pack.versionNumber,
          checksum: pack.checksum,
          skuCode,
          listingVersionId: pack.listingVersionId,
        },
        account: {
          id: account.id,
          displayName: account.displayName,
          platform: account.platform,
          marketplaceId: pack.marketplaceId,
        },
        status: exact ? "conflict" : "ready",
        canBind,
        effectiveUntil: after?.effectiveFrom.toISOString() ?? null,
        previous: timeline(before),
        next: timeline(after),
      };
    });
  }
  async bind(context: TenantContext, body: unknown) {
    authorize(context, Permission.StoreManage);
    authorize(context, Permission.ProductWrite);
    const input = BindSalesChannelSchema.parse(body);
    let source: Awaited<ReturnType<SalesPackageService["bindingSource"]>> | undefined;
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "package",
          id: input.packageId,
          permissions: [Permission.ProductWrite],
          additional: [
            { kind: "account", id: input.accountId, permissions: [Permission.StoreManage] },
          ],
        },
        key: input.idempotencyKey,
        action: "sales_channel.bind",
        resourceId: input.packageId,
        reason: input.evidence,
        input,
        validateSources: async (tx, current) => {
          source = await this.bindingSource(tx, current, input);
        },
      },
      async (tx, currentContext) => {
        context = currentContext;
        if (!source) throw new ConflictException("请重新核对资料包与店铺");
        const { pack, account } = source;
        await lockDevelopment(
          tx,
          context,
          `channel:${account.id}:${pack.marketplaceId}:${input.externalSku}:${input.externalListingId}`,
        );
        const [duplicate] = await tx
          .select({ id: salesChannelBindings.id })
          .from(salesChannelBindings)
          .where(
            and(
              eq(salesChannelBindings.accountId, account.id),
              eq(salesChannelBindings.marketplaceId, pack.marketplaceId),
              eq(salesChannelBindings.externalSku, input.externalSku),
              eq(salesChannelBindings.externalListingId, input.externalListingId),
              eq(
                salesChannelBindings.customChoiceKey,
                Object.keys(input.customChoice).length
                  ? fingerprint(
                      Object.fromEntries(
                        Object.entries(input.customChoice).sort(([a], [b]) => a.localeCompare(b)),
                      ),
                    )
                  : "legacy",
              ),
              eq(salesChannelBindings.effectiveFrom, new Date(input.effectiveFrom)),
            ),
          )
          .limit(1);
        if (duplicate)
          throw new ConflictException("该渠道 SKU 在此生效时间已有映射，请核对生效时间");
        const id = createEntityId();
        await tx.insert(salesChannelBindings).values({
          id,
          tenantId: context.tenantId,
          createdBy: context.userId,
          packageId: pack.id,
          accountId: account.id,
          externalSku: input.externalSku,
          externalListingId: input.externalListingId,
          customChoice: input.customChoice,
          customChoiceKey: Object.keys(input.customChoice).length
            ? fingerprint(
                Object.fromEntries(
                  Object.entries(input.customChoice).sort(([a], [b]) => a.localeCompare(b)),
                ),
              )
            : "legacy",
          marketplaceId: pack.marketplaceId,
          effectiveFrom: new Date(input.effectiveFrom),
          evidence: input.evidence,
        });
        return { bindingId: id };
      },
    );
  }

  async export(context: TenantContext, id: string) {
    authorize(context, Permission.ListingRead);
    authorize(context, Permission.AssetRead);
    const [pack] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const rows = await tx
        .select()
        .from(salesPackageVersions)
        .where(eq(salesPackageVersions.id, id));
      if (rows[0]) await this.assertPackageRead(tx, context, rows[0]);
      return rows;
    });
    if (!pack) throw new NotFoundException("资料包不存在");
    if (fingerprint(pack.snapshot) !== pack.checksum) throw new ConflictException("资料包校验失败");
    const files = pack.snapshot.files as Array<{
      id: string;
      version: number;
      checksum: string;
      objectKey: string;
      name: string;
      mediaType: string;
      byteSize: number;
      role: string;
    }>;
    if (files.reduce((sum, f) => sum + f.byteSize, 0) > 512 * 1024 * 1024)
      throw new ConflictException("资料包超过 512 MiB，请减少上架文件后重新审核");
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({ id: pack.id, checksum: pack.checksum, ...pack.snapshot }, null, 2),
    );
    const delivery = pack.snapshot.salesPlanDelivery as Record<string, unknown> | undefined;
    if (delivery) {
      const listing = pack.snapshot.listing as { content: unknown };
      zip.file("listing-fields.json", JSON.stringify(listing.content, null, 2));
      zip.file(
        "customization-config.json",
        JSON.stringify(
          {
            schemaVersion: 1,
            definition: delivery.customization,
            layout: delivery.layout,
            ...(delivery.patternChoices ? { patternChoices: delivery.patternChoices } : {}),
            instructions: delivery.customInstructions,
            materials: delivery.customMaterials,
            verification: delivery.customPage,
          },
          null,
          2,
        ),
      );
      zip.file("sku-mapping.json", JSON.stringify(delivery.skuMapping, null, 2));
      zip.file(
        "delivery-review.json",
        JSON.stringify(
          {
            planId: delivery.planId,
            revision: delivery.revision,
            fingerprint: delivery.fingerprint,
            review: delivery.review,
          },
          null,
          2,
        ),
      );
      zip.file(
        "README.txt",
        "此包固定原封存版本与原审核依据，当前适用性须另行核对。\ncustomization-config.json 为配置草案与人工核验依据，不自动配置卖家平台。\n核对目标站点、SKU、定制选项与全部图片后，按正式授权流程上架。\n封存、下载均不代表平台发布或工厂生产放行。\n",
      );
    }
    for (const file of files) {
      const [asset] = await withTenant(this.database.db, context, async (tx) => {
        context = await currentCatalogContext(tx, context);
        await this.assertPackageRead(tx, context, pack);
        return tx
          .select()
          .from(assetFiles)
          .where(
            and(
              eq(assetFiles.id, file.id),
              catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
            ),
          );
      });
      if (
        !asset ||
        asset.deletedAt ||
        asset.version !== file.version ||
        asset.checksumSha256 !== file.checksum ||
        asset.objectKey !== file.objectKey
      )
        throw new ConflictException("封存素材不可用，请检查原文件");
      assertAuthorizedAssets([file.id], [asset], "导出素材");
      const bytes = await this.storage.readPrivate(
        context,
        { ...asset, assetDomain: "authorized" },
        { requiredDomain: "authorized" },
      );
      if (
        bytes.length !== file.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== file.checksum
      )
        throw new ConflictException("封存素材内容校验失败，请检查原文件");
      zip.file(`${file.role}/${file.id}-${file.name.split(/[\\/]/).at(-1)}`, bytes);
    }
    const body = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      await this.assertPackageRead(tx, context, pack);
      const assets = await tx
        .select()
        .from(assetFiles)
        .where(
          and(
            inArray(
              assetFiles.id,
              files.map((file) => file.id),
            ),
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
          ),
        );
      assertAuthorizedAssets(
        files.map((file) => file.id),
        assets,
        "导出前素材复核",
      );
      if (
        files.some((file) => {
          const asset = assets.find((asset) => asset.id === file.id);
          return (
            !asset ||
            asset.deletedAt ||
            asset.version !== file.version ||
            asset.checksumSha256 !== file.checksum ||
            asset.objectKey !== file.objectKey
          );
        })
      )
        throw new ConflictException("封存素材已变化 请重新核对");
    });
    return {
      body,
      name: `sales-package-${id}.zip`,
    };
  }

  private async assertPackageRead(
    tx: TenantTransaction,
    context: TenantContext,
    pack: typeof salesPackageVersions.$inferSelect,
  ) {
    await assertCatalogRecipeRead(tx, context, pack.recipeId);
    await assertCatalogMutationAccess(tx, context, {
      kind: "listingVersion",
      id: pack.listingVersionId,
      permissions: [Permission.ListingRead],
    });
  }
}
