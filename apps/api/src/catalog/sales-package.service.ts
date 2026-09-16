import { createHash } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateSalesListingSchema,
  SealSalesPackageSchema,
  BindSalesChannelSchema,
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
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import JSZip from "jszip";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { ListingService } from "../listings/listing.service.js";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { fingerprint, lockDevelopment, mutateDevelopment, readRecipe } from "./development-data.js";

@Injectable()
export class SalesPackageService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ListingService) private readonly listingService: ListingService,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  /** Read only: resolve the current listing against its own approved SKU recipes and mockups. */
  async analysisBasis(context: TenantContext, listingId: string, expectedVersionId: string) {
    authorize(context, Permission.ListingRead);
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    const { listing, version } = await this.listingService.getWorkspace(context, listingId);
    if (version.id !== expectedVersionId || listing.status === "archived") throw new ConflictException("Listing 已更新或归档，请刷新后分析");
    const variants = version.content.variants;
    if (!listing.styleId || !variants.length || variants.length > 50) throw new ConflictException("请先从商品开发创建带有已审核 SKU 的 Listing，单次最多 50 个规格");
    return withTenant(this.database.db, context, async tx => {
      const recipes = [];
      for (const variant of variants) {
        const [latest] = await tx.select({ id: salesRecipeVersions.id }).from(salesRecipeVersions).where(eq(salesRecipeVersions.skuId, variant.skuId)).orderBy(desc(salesRecipeVersions.versionNumber)).limit(1);
        if (!latest) throw new ConflictException("销售 SKU 尚未绑定印花与产品规格");
        const recipe = await readRecipe(tx, latest.id);
        if (recipe.styleId !== listing.styleId || recipe.status !== "approved" || !recipe.specification.facts.factsConfirmed || recipe.skuCode !== variant.skuCode || fingerprint(recipe.specification.attributes) !== fingerprint(variant.optionValues)) throw new ConflictException("请先核对并审核 Listing 所属 SKU 的制作版本、规格与产品事实");
        recipes.push(recipe);
      }
      const ids = [...new Set([version.content.mainImageId, ...version.content.mediaAssetIds].filter((id): id is string => !!id))];
      const images: Array<typeof assetFiles.$inferSelect> = [];
      for (const assetId of ids.slice(0,16)) {
        const [source] = await tx.select({ asset: assetFiles, output: mockupBatchOutputs, item: mockupBatchItems }).from(mockupBatchOutputs)
          .innerJoin(mockupBatchItems, eq(mockupBatchItems.id, mockupBatchOutputs.itemId))
          .innerJoin(assetFiles, eq(assetFiles.id, mockupBatchOutputs.assetId))
          .where(and(eq(mockupBatchOutputs.assetId, assetId), eq(mockupBatchOutputs.status, "approved"))).limit(1);
        if (!source || source.asset.deletedAt || !recipes.some(r => r.skuId === source.item.skuId && r.designVersionId === source.item.designVersionId) || source.asset.version !== source.output.assetVersion || source.asset.checksumSha256 !== source.output.checksumSha256 || !["image/png","image/jpeg","image/webp"].includes(source.asset.mediaType)) continue;
        assertAuthorizedAssets([assetId], [source.asset], "AI 分析套图");
        images.push(source.asset);
      }
      return { listing, version, recipes, images, mediaCount: ids.length,
        fingerprint: fingerprint({ listingVersionId: version.id, recipes: recipes.map(r => [r.id, r.status, r.artwork.id, r.specification.id]), images: images.map(a => [a.id, a.version, a.checksumSha256]) }) };
    });
  }

  async analysisImage(context: TenantContext, asset: typeof assetFiles.$inferSelect) {
    authorize(context, Permission.DesignRead);
    const [current] = await withTenant(this.database.db, context, tx => tx.select().from(assetFiles).where(eq(assetFiles.id, asset.id)));
    if (!current || current.deletedAt || current.version !== asset.version || current.checksumSha256 !== asset.checksumSha256) throw new ConflictException("套图源文件已变化，请刷新后分析");
    assertAuthorizedAssets([current.id], [current], "AI 分析套图");
    const bytes = await this.storage.readPrivate(context, { ...current, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256) throw new ConflictException("套图文件内容已变化");
    return bytes;
  }

  async createListing(context: TenantContext, body: unknown) {
    authorize(context, Permission.ListingWrite);
    const input = CreateSalesListingSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "sales_listing.create",
        resourceId: input.recipeIds[0]!,
        reason: input.title,
        input,
      },
      async (tx) => {
        const recipes = await Promise.all(input.recipeIds.map((id) => readRecipe(tx, id))),
          first = recipes[0]!;
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
    const input = SealSalesPackageSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "sales_package.seal",
        resourceId: input.recipeId,
        reason: input.reason,
        input,
      },
      async (tx) => {
        const recipe = await readRecipe(tx, input.recipeId);
        if (
          recipe.status !== "approved" ||
          !recipe.designVersionId ||
          !recipe.specification.facts.factsConfirmed
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
          listing.styleId !== recipe.styleId ||
          listing.status !== "approved" ||
          version.status !== "approved" ||
          listing.primaryVersionId !== version.id
        )
          throw new ConflictException("请选择本款式当前已审核 Listing 版本");
        if (
          !version.content.variants.some(
            (v) => v.skuId === recipe.skuId && v.skuCode === recipe.skuCode,
          )
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
            .innerJoin(
              salesSkuDefinitions,
              eq(salesSkuDefinitions.skuId, salesRecipeVersions.skuId),
            )
            .where(
              and(
                eq(mockupBatchOutputs.assetId, evidence.assetId),
                eq(mockupBatchOutputs.status, "approved"),
                eq(salesRecipeVersions.status, "approved"),
                eq(salesSkuDefinitions.styleId, recipe.styleId),
                inArray(
                  mockupBatchItems.skuId,
                  version.content.variants.map((v) => v.skuId),
                ),
                or(
                  ne(salesRecipeVersions.skuId, recipe.skuId),
                  eq(salesRecipeVersions.id, recipe.id),
                ),
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
        const allIds = [
          ...new Set([...ids, ...(recipe.artwork.assetId ? [recipe.artwork.assetId] : []), ...production.map((p) => p.id)]),
        ];
        const assets = await tx.select().from(assetFiles).where(inArray(assetFiles.id, allIds));
        assertAuthorizedAssets(allIds, assets, "上架资料包");
        if (assets.some((a) => a.deletedAt)) throw new ConflictException("资料包素材已删除");
        if (
          mockupSources.some((m) => {
            const asset = assets.find((a) => a.id === m.assetId);
            return (
              !asset || asset.version !== m.assetVersion || asset.checksumSha256 !== m.checksum
            );
          })
        )
          throw new ConflictException("已审核套图文件版本已变化，请重新核对");
        if (
          recipe.artwork.assetId && assets.find((a) => a.id === recipe.artwork.assetId)?.version !==
          recipe.artwork.assetVersion
        )
          throw new ConflictException("印花主文件版本已变化，请核对制作来源");
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
                    : "listing",
            })),
            review: { actor: context.userId, reason: input.reason, at: new Date().toISOString() },
          };
        const checksum = fingerprint(snapshot);
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
          snapshot,
          checksum,
        });
        return { packageId: id, checksum };
      },
    );
  }

  async bind(context: TenantContext, body: unknown) {
    authorize(context, Permission.StoreManage);
    authorize(context, Permission.ProductWrite);
    const input = BindSalesChannelSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "sales_channel.bind",
        resourceId: input.packageId,
        reason: input.evidence,
        input,
      },
      async (tx) => {
        const [pack] = await tx
          .select()
          .from(salesPackageVersions)
          .where(eq(salesPackageVersions.id, input.packageId));
        const [account] = await tx
          .select()
          .from(marketplaceAccounts)
          .where(eq(marketplaceAccounts.id, input.accountId));
        if (!pack || !account) throw new NotFoundException("资料包或店铺不存在");
        if (
          pack.platform !== account.platform ||
          !account.marketplaceIds.includes(pack.marketplaceId)
        )
          throw new ConflictException("资料包平台与站点必须属于所选店铺");
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
    const [pack] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(salesPackageVersions).where(eq(salesPackageVersions.id, id)),
    );
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
    for (const file of files) {
      const [asset] = await withTenant(this.database.db, context, (tx) =>
        tx.select().from(assetFiles).where(eq(assetFiles.id, file.id)),
      );
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
    return {
      body: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      name: `sales-package-${id}.zip`,
    };
  }
}
