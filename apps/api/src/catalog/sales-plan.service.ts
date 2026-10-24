import { withCatalogTenant as withTenant } from "./catalog-access.js";
import {
  catalogPlanFilter,
  catalogOwnerFilter,
  catalogAssetReadFilter,
  catalogRecipeReadFilter,
  currentCatalogContext,
  assertCatalogSpuAccess,
  assertCatalogArtworkAccess,
  assertCatalogListingAccess,
  catalogContextAuthority,
} from "@yummyai/catalog-core";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreateSalesPlanSchema,
  SalesPlanFieldsSchema,
  SaveSalesPlanSchema,
  SalesPlanActionSchema,
  SalesPlanDraftSchema,
  SalesPlanQuerySchema,
  SalesPlanDraftReferenceSchema,
  SalesPlanReferenceSelectionSchema,
  type SalesPlanFields,
  type SalesPlanView,
  type SalesPlanList,
  type SalesPlanDetail,
  type SalesPlanOptions,
  type SalesPlanReferenceOptions,
  type SalesPlanReferenceSelection,
} from "@yummyai/contracts/catalog/sales-plan";
import {
  salesPlans,
  spus,
  productPlans,
  productSpecifications,
  productSpecificationVersions,
  skus,
  researchItems,
  artworkMasterVersions,
  artworkMasters,
  creativeDesignBatches,
  assetFiles,
  activeCreativeAsset,
  marketplaceAccounts,
  listings,
  listingVersions,
  salesSkuDefinitions,
  salesRecipeVersions,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { ListingDraft } from "@yummyai/platform-rules";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { ListingService } from "../listings/listing.service.js";
import {
  LaunchAdoptRequestSchema,
  type LaunchAdoptField,
} from "@yummyai/contracts/catalog/sales-plan-launch";
import { AdoptProductVisualsSchema } from "@yummyai/contracts/catalog/product-visuals";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import {
  currentArtworkIds,
  currentSpecificationIds,
  lockDevelopment,
  mutateDevelopment,
  productSpuView,
  fingerprint,
  readArtwork,
  readRecipe,
  readSpecification,
} from "./development-data.js";

@Injectable()
export class SalesPlanService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ListingService) private readonly listingService: ListingService,
  ) {}

  async assistBasis(context: TenantContext, id: string) {
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const row = await read(tx, id);
      await assertCatalogSpuAccess(tx, context, row.plan.spuId, [Permission.ProductRead]);
      if (row.plan.archivedAt) throw new ConflictException("销售方案已归档，请查看历史资料");
      await assertSpu(tx, row.plan.spuId);
      const selectedVersions = row.plan.fields.specificationIds.length
        ? await tx
            .select({ id: productSpecificationVersions.id })
            .from(productSpecifications)
            .innerJoin(
              productSpecificationVersions,
              and(
                eq(productSpecificationVersions.specificationId, productSpecifications.id),
                eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber),
              ),
            )
            .where(
              and(
                eq(productSpecifications.spuId, row.plan.spuId),
                inArray(productSpecifications.id, row.plan.fields.specificationIds),
              ),
            )
            .orderBy(productSpecifications.id)
        : [];
      if (selectedVersions.length !== row.plan.fields.specificationIds.length)
        throw new ConflictException("已选产品规格不可用，请重新核对销售方案");
      const specifications = await Promise.all(
        selectedVersions.map((version) => readSpecification(tx, version.id)),
      );
      const basis = {
        plan: view(row),
        product: {
          id: row.spu.id,
          name: row.spu.name,
          code: row.spu.code,
          capabilities: row.spu.capabilities,
        },
        specifications,
      };
      return { ...basis, fingerprint: fingerprint(basis) };
    });
  }

  /** Only this domain service writes sales-plan fields. The resolver rechecks the
   * owner's immutable assistant output after the plan lock and idempotency check. */
  async adoptAssist(
    context: TenantContext,
    id: string,
    body: unknown,
    resolve: () => Promise<Partial<Pick<SalesPlanFields, LaunchAdoptField>>>,
  ) {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.ProductWrite);
    const input = LaunchAdoptRequestSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "salesPlan",
          id,
          permissions: [Permission.ProductRead, Permission.ProductWrite],
        },
        key: input.idempotencyKey,
        action: "sales_plan.adopt_assist",
        resourceId: id,
        reason: "人工核对并采纳 AI 上新成果",
        input: { id, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        const { plan } = await this.lock(tx, context, id, input.expectedRevision);
        const patch = await resolve();
        const fields = SalesPlanFieldsSchema.parse({ ...plan.fields, ...patch });
        await this.assertReferences(tx, context, plan.spuId, fields);
        await tx
          .update(salesPlans)
          .set({ fields, revision: plan.revision + 1, updatedAt: new Date() })
          .where(eq(salesPlans.id, id));
        return {
          plan: view(await read(tx, id)),
          adoption: {
            runId: input.runId,
            kind: input.kind,
            fields: input.fields,
            revision: plan.revision + 1,
          },
        };
      },
    );
  }

  async adoptVisuals(
    context: TenantContext,
    id: string,
    groupId: string,
    body: unknown,
    resolve: () => Promise<{ assetIds: string[]; sampleAssetId: string | null; projectId: string }>,
  ) {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    const input = AdoptProductVisualsSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "salesPlan",
          id,
          permissions: [Permission.ProductRead, Permission.ProductWrite],
          additional: [
            { kind: "create", permissions: [Permission.DesignRead, Permission.AssetRead] },
          ],
        },
        key: input.idempotencyKey,
        action: "sales_plan.adopt_visuals",
        resourceId: id,
        reason: "人工核对并采纳已审核抱枕套图",
        input: { id, groupId, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        const { plan } = await this.lock(tx, context, id, input.expectedRevision);
        const selected = await resolve();
        const mediaAssetIds = [
          ...new Set([
            ...plan.fields.mediaAssetIds,
            ...selected.assetIds,
            ...(selected.sampleAssetId ? [selected.sampleAssetId] : []),
          ]),
        ];
        const fields = SalesPlanFieldsSchema.parse({
          ...plan.fields,
          creativeProjectId: selected.projectId,
          mediaAssetIds,
          mainImageId: selected.sampleAssetId ?? plan.fields.mainImageId,
        });
        await this.assertReferences(tx, context, plan.spuId, fields);
        await tx
          .update(salesPlans)
          .set({ fields, revision: plan.revision + 1, updatedAt: new Date() })
          .where(eq(salesPlans.id, id));
        return {
          plan: view(await read(tx, id)),
          imagesAdoption: { groupId, versionIds: input.versionIds, revision: plan.revision + 1 },
        };
      },
    );
  }

  async options(context: TenantContext): Promise<SalesPlanOptions> {
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return this.readOptions(tx, context);
    });
  }

  async referenceOptions(
    context: TenantContext,
    id: string,
    body: unknown,
  ): Promise<SalesPlanReferenceOptions> {
    authorize(context, Permission.ProductRead);
    const selection = SalesPlanReferenceSelectionSchema.parse(body);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const { plan } = await read(tx, id);
      await assertCatalogSpuAccess(tx, context, plan.spuId, [Permission.ProductRead]);
      const options = await this.readOptions(tx, context, selection);
      const hiddenSkus = new Set(await this.unreadableSkuReferences(tx, context, selection.skuIds));
      return {
        ...options,
        skus: options.skus.filter((sku) => !hiddenSkus.has(sku.id)),
        planId: id,
        spuId: plan.spuId,
        selection,
      };
    });
  }

  private async readOptions(
    tx: TenantTransaction,
    context: TenantContext,
    selection?: SalesPlanReferenceSelection,
  ): Promise<SalesPlanOptions> {
    const has = (permission: Permission) => context.permissions.includes(permission);
    const artworkIds =
      has(Permission.DesignRead) && has(Permission.AssetRead)
        ? [
            ...(await currentArtworkIds(tx, context)).map((row) => row.id),
            ...(selection?.artworkVersionIds.length
              ? (
                  await tx
                    .select({ id: artworkMasterVersions.id })
                    .from(artworkMasterVersions)
                    .innerJoin(
                      artworkMasters,
                      eq(artworkMasters.id, artworkMasterVersions.artworkId),
                    )
                    .where(
                      and(
                        inArray(artworkMasterVersions.id, selection.artworkVersionIds),
                        isNull(artworkMasters.archivedAt),
                        catalogOwnerFilter(
                          context,
                          Permission.DesignRead,
                          artworkMasters.createdBy,
                          artworkMasters.teamId,
                        ),
                      ),
                    )
                ).map((row) => row.id)
              : []),
          ]
        : [];
    return {
      spus: (
        await tx
          .select({ spu: spus, plan: productPlans })
          .from(spus)
          .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
          .where(
            and(
              ne(spus.status, "archived"),
              ne(productPlans.status, "archived"),
              catalogPlanFilter(context, Permission.ProductRead),
            ),
          )
          .orderBy(spus.code)
      ).map(productSpuView),
      specifications: await Promise.all(
        (await currentSpecificationIds(tx, context)).map((row) => readSpecification(tx, row.id)),
      ),
      skus: await tx
        .select({ id: skus.id, code: skus.code, spuId: skus.spuId, attributes: skus.attributes })
        .from(skus)
        .innerJoin(spus, eq(spus.id, skus.spuId))
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .where(and(ne(skus.status, "archived"), catalogPlanFilter(context, Permission.ProductRead)))
        .orderBy(skus.code),
      artworks: await Promise.all([...new Set(artworkIds)].map((id) => readArtwork(tx, id))),
      researchItems: has(Permission.ResearchRead)
        ? (
            await tx
              .select({ id: researchItems.id, title: researchItems.latestTitle })
              .from(researchItems)
              .where(
                and(
                  isNull(researchItems.archivedAt),
                  catalogOwnerFilter(context, Permission.ResearchRead, researchItems.ownerUserId),
                ),
              )
              .orderBy(
                ...(selection?.researchItemIds.length
                  ? [
                      sql`case when ${inArray(researchItems.id, selection.researchItemIds)} then 0 else 1 end`,
                    ]
                  : []),
                desc(researchItems.lastCapturedAt),
              )
              .limit(500 + (selection?.researchItemIds.length ?? 0))
          ).map((row) => ({ ...row, title: row.title ?? "未命名研究商品" }))
        : [],
      assets: has(Permission.AssetRead)
        ? await tx
            .select({
              id: assetFiles.id,
              fileName: assetFiles.fileName,
              mediaType: assetFiles.mediaType,
            })
            .from(assetFiles)
            .where(
              and(
                eq(assetFiles.assetDomain, "authorized"),
                eq(assetFiles.rightsStatus, "approved"),
                isNull(assetFiles.deletedAt),
                catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
                activeCreativeAsset(),
                sql`${assetFiles.mediaType} in ('image/png','image/jpeg','image/webp')`,
                sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind','') not in ('customer_provided','competitor','competitor_reference')`,
              ),
            )
            .orderBy(
              ...(selection?.assetIds.length
                ? [sql`case when ${inArray(assetFiles.id, selection.assetIds)} then 0 else 1 end`]
                : []),
              desc(assetFiles.createdAt),
            )
            .limit(500 + (selection?.assetIds.length ?? 0))
        : [],
      projects: has(Permission.DesignRead)
        ? await tx
            .select({ id: creativeDesignBatches.id, name: creativeDesignBatches.name })
            .from(creativeDesignBatches)
            .where(
              and(
                isNull(creativeDesignBatches.archivedAt),
                catalogOwnerFilter(context, Permission.DesignRead, creativeDesignBatches.createdBy),
                or(
                  sql`(${creativeDesignBatches.canvasWorkflow} is null or ${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${creativeDesignBatches.id}::text)`,
                  selection?.creativeProjectId
                    ? eq(creativeDesignBatches.id, selection.creativeProjectId)
                    : undefined,
                ),
              ),
            )
            .orderBy(
              ...(selection?.creativeProjectId
                ? [
                    sql`case when ${creativeDesignBatches.id} = ${selection.creativeProjectId} then 0 else 1 end`,
                  ]
                : []),
              desc(creativeDesignBatches.createdAt),
            )
            .limit(500 + (selection?.creativeProjectId ? 1 : 0))
        : [],
      accounts: has(Permission.StoreRead)
        ? await tx
            .select({
              id: marketplaceAccounts.id,
              displayName: marketplaceAccounts.displayName,
              platform: marketplaceAccounts.platform,
            })
            .from(marketplaceAccounts)
            .where(
              and(
                eq(marketplaceAccounts.platform, "amazon"),
                catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
                sql`${marketplaceAccounts.status} not in ('disabled','revoked')`,
              ),
            )
        : [],
      access: {
        research: has(Permission.ResearchRead),
        design: has(Permission.DesignRead),
        assets: has(Permission.AssetRead),
        listing: has(Permission.ListingRead),
        write: has(Permission.ProductWrite),
        listingWrite: has(Permission.ListingWrite),
      },
      preferenceScope: `${context.tenantId}:${context.userId}`,
      contextAuthority: catalogContextAuthority(context),
    };
  }

  async list(context: TenantContext, query: unknown): Promise<SalesPlanList> {
    authorize(context, Permission.ProductRead);
    const input = SalesPlanQuerySchema.parse(query),
      pageSize = 25;
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const rows = await tx
        .select({ plan: salesPlans, spu: spus, root: productPlans })
        .from(salesPlans)
        .innerJoin(spus, eq(spus.id, salesPlans.spuId))
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .where(
          and(
            input.archived === "1"
              ? sql`${salesPlans.archivedAt} is not null`
              : and(
                  isNull(salesPlans.archivedAt),
                  ne(spus.status, "archived"),
                  ne(productPlans.status, "archived"),
                ),
            input.spuId ? eq(salesPlans.spuId, input.spuId) : undefined,
            catalogPlanFilter(context, Permission.ProductRead),
            input.q
              ? sql`concat(${salesPlans.fields}->>'name',' ',${spus.code},' ',${spus.name}) ilike ${`%${input.q.replace(/[\\%_]/g, "\\$&")}%`}`
              : undefined,
          ),
        )
        .orderBy(desc(salesPlans.updatedAt));
      return {
        items: rows.slice((input.page - 1) * pageSize, input.page * pageSize).map(view),
        total: rows.length,
        page: input.page,
        pageSize,
      };
    });
  }

  async get(context: TenantContext, id: string): Promise<SalesPlanDetail> {
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      const row = await read(tx, id),
        listingAccess = context.permissions.includes(Permission.ListingRead);
      await assertCatalogSpuAccess(tx, context, row.plan.spuId, [Permission.ProductRead]);
      const versions = listingAccess
        ? await tx
            .select({ listing: listings, version: listingVersions })
            .from(listings)
            .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
            .where(
              and(
                eq(listings.salesPlanId, id),
                catalogOwnerFilter(context, Permission.ListingRead, listings.createdBy),
              ),
            )
            .orderBy(desc(listingVersions.versionNumber))
        : [];
      const seen = new Set<string>();
      return {
        plan: view(row),
        listingAccess,
        listings: versions
          .filter((row) => {
            if (seen.has(row.listing.id)) return false;
            seen.add(row.listing.id);
            return true;
          })
          .map(({ listing, version }) => ({
            id: listing.id,
            ...(listing.createdBy ? { ownerUserId: listing.createdBy } : {}),
            versionId: version.id,
            version: version.versionNumber,
            status: listing.status,
            title: version.content.title,
            marketplaceId: listing.marketplaceId,
            locale: listing.locale,
            planRevision: listing.salesPlanRevision,
            completeness: version.validation.completeness,
            blockers: version.validation.blockers.map((issue) => issue.message),
          })),
      };
    });
  }

  async create(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateSalesPlanSchema.parse(body),
      id = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "spu", id: input.spuId, permissions: [Permission.ProductWrite] },
        validateSources: (tx, current) => this.assertReadReferences(tx, current, input.fields),
        key: input.idempotencyKey,
        action: "sales_plan.create",
        resourceId: id,
        reason: "基于 SPU 建立销售方案",
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        await assertSpu(tx, input.spuId);
        await this.assertReferences(tx, context, input.spuId, input.fields);
        await tx.insert(salesPlans).values({
          id,
          tenantId: context.tenantId,
          spuId: input.spuId,
          fields: input.fields,
          createdBy: context.userId,
        });
        return { plan: view(await read(tx, id)) };
      },
    );
  }

  async save(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = SaveSalesPlanSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "salesPlan", id, permissions: [Permission.ProductWrite] },
        validateSources: (tx, current) => this.assertReadReferences(tx, current, input.fields),
        key: input.idempotencyKey,
        action: "sales_plan.save",
        resourceId: id,
        reason: "保存销售方案草稿",
        input: { id, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        const { plan } = await this.lock(tx, context, id, input.expectedRevision);
        if (
          plan.fields.mode !== input.fields.mode ||
          plan.fields.fulfillment !== input.fields.fulfillment
        ) {
          const [linked] = await tx
            .select({ id: listings.id })
            .from(listings)
            .where(eq(listings.salesPlanId, id))
            .limit(1);
          if (linked)
            throw new ConflictException(
              "已创建刊登的方案不能切换商品模式或履约方式，请基于同一 SPU 新建销售方案",
            );
        }
        await assertSpu(tx, plan.spuId);
        await this.assertReferences(tx, context, plan.spuId, input.fields);
        await tx
          .update(salesPlans)
          .set({ fields: input.fields, revision: plan.revision + 1, updatedAt: new Date() })
          .where(eq(salesPlans.id, id));
        return { plan: view(await read(tx, id)) };
      },
    );
  }

  async archive(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = SalesPlanActionSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "salesPlan", id, permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: "sales_plan.archive",
        resourceId: id,
        reason: "归档销售方案",
        input: { id, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        const { plan } = await this.lock(tx, context, id, input.expectedRevision);
        await tx
          .update(salesPlans)
          .set({ archivedAt: new Date(), revision: plan.revision + 1, updatedAt: new Date() })
          .where(eq(salesPlans.id, id));
        return { plan: view(await read(tx, id)) };
      },
    );
  }

  async draft(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.ListingWrite);
    const input = SalesPlanDraftSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "salesPlan",
          id,
          permissions: [Permission.ProductRead],
          additional: [{ kind: "create", permissions: [Permission.ListingWrite] }],
        },
        key: input.idempotencyKey,
        action: "sales_plan.listing_draft",
        validateSources: async (tx, current) => {
          const { plan } = await read(tx, id);
          await this.assertReadReferences(tx, current, plan.fields);
        },
        validateCachedResult: async (tx, current, cached) => {
          const receipt = SalesPlanDraftReferenceSchema.safeParse(cached);
          if (!receipt.success)
            throw new ConflictException("历史同步回执缺少版本依据 请重新核对当前刊登");
          const listing = await assertCatalogListingAccess(
            tx,
            current,
            receipt.data.listingId,
            [Permission.ListingWrite],
            true,
          );
          if (listing.salesPlanId !== id) throw new NotFoundException("同步刊登不存在或不可访问");
          const [version] = await tx
            .select({ id: listingVersions.id })
            .from(listingVersions)
            .where(
              and(
                eq(listingVersions.id, receipt.data.listingVersionId),
                eq(listingVersions.listingId, listing.id),
              ),
            )
            .limit(1);
          if (!version) throw new NotFoundException("原同步版本不存在或不可访问");
        },
        resourceId: id,
        reason: "销售方案转为刊登草稿",
        input: { id, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        const { plan } = await this.lock(tx, context, id, input.expectedRevision),
          f = plan.fields;
        await assertSpu(tx, plan.spuId);
        await this.assertReferences(tx, context, plan.spuId, f);
        if (!f.marketplaceId) throw new ConflictException("请先填写目标站点");
        const selected = f.skuIds.length
          ? await tx.select().from(skus).where(inArray(skus.id, f.skuIds))
          : [];
        const definitions = f.skuIds.length
          ? await tx
              .select()
              .from(salesSkuDefinitions)
              .where(inArray(salesSkuDefinitions.skuId, f.skuIds))
          : [];
        const styleIds = [...new Set(definitions.map((definition) => definition.styleId))];
        if (styleIds.length > 1 && !f.patternChoices)
          throw new ConflictException("同一刊登的销售 SKU 应采用相同印花款式，请分别建立销售方案");
        if (selected.length) {
          const recipes = await tx
            .select({
              id: salesRecipeVersions.id,
              skuId: salesRecipeVersions.skuId,
              mode: artworkMasterVersions.mode,
            })
            .from(salesRecipeVersions)
            .innerJoin(
              artworkMasterVersions,
              eq(artworkMasterVersions.id, salesRecipeVersions.artworkVersionId),
            )
            .where(inArray(salesRecipeVersions.skuId, f.skuIds))
            .orderBy(desc(salesRecipeVersions.versionNumber));
          const seen = new Set<string>();
          const currentRecipes = recipes.filter((recipe) => {
            if (seen.has(recipe.skuId)) return false;
            seen.add(recipe.skuId);
            return true;
          });
          if (
            (await Promise.all(currentRecipes.map((recipe) => readRecipe(tx, recipe.id)))).some(
              (recipe) =>
                f.mode === "standard"
                  ? recipe.artwork.mode !== "fixed"
                  : recipe.artwork.mode === "fixed" && !f.patternChoices,
            )
          )
            throw new ConflictException(
              "销售 SKU 的印花模式与方案不一致：标品使用固定印花，定制使用来图或文字定制方案",
            );
        }
        if (
          f.patternChoices &&
          (definitions.length !== selected.length ||
            f.patternChoices.options.length !== selected.length)
        )
          throw new ConflictException("每个选款须固定一个销售 SKU 和制作配方");
        const physicalSkus = f.patternChoices
          ? [
              ...new Map(
                selected.map((sku) => [
                  definitions.find((d) => d.skuId === sku.id)!.specificationId,
                  sku,
                ]),
              ).values(),
            ]
          : selected;
        const customMappings = f.patternChoices
          ? selected.map((sku) => {
              const specificationId = definitions.find((d) => d.skuId === sku.id)!.specificationId,
                representative = physicalSkus.find(
                  (s) =>
                    definitions.find((d) => d.skuId === s.id)!.specificationId === specificationId,
                )!,
                option = f.patternChoices!.options.find((o) => o.skuId === sku.id)!;
              return {
                skuId: sku.id,
                platformSkuId: representative.id,
                platformSkuCode: representative.code,
                specificationId,
                customChoice: { [f.patternChoices!.fieldKey]: option.value },
              };
            })
          : null;
        const styleId =
          definitions.length === selected.length && styleIds.length === 1 ? styleIds[0] : undefined;
        const content: ListingDraft = {
          platform: "amazon",
          locale: f.locale,
          title: f.title,
          bullets: f.bullets,
          description: f.description,
          tags: [],
          mediaAssetIds: f.mediaAssetIds,
          ...(f.mainImageId ? { mainImageId: f.mainImageId } : {}),
          variants: physicalSkus.map((sku) => ({
            skuId: sku.id,
            skuCode: sku.code,
            optionValues: sku.attributes,
          })),
          attributes: {
            sales_mode: f.mode,
            fulfillment_method: f.fulfillment,
            ...(f.patternChoices
              ? { custom_pattern_choices: JSON.stringify(f.patternChoices) }
              : {}),
            ...(customMappings ? { custom_sales_sku_mapping: JSON.stringify(customMappings) } : {}),
            search_terms: f.keywords.join(" "),
          },
          compliance: {},
          ...(f.productType
            ? {
                publication: {
                  platform: "amazon" as const,
                  productType: f.productType,
                  attributes: {},
                },
              }
            : {}),
        };
        const [existing] = await tx
          .select()
          .from(listings)
          .where(
            and(
              eq(listings.salesPlanId, id),
              eq(listings.platform, "amazon"),
              eq(listings.marketplaceId, f.marketplaceId),
              eq(listings.locale, f.locale),
            ),
          );
        if (existing) {
          if (!input.expectedListingVersionId)
            throw new ConflictException("此方案已有刊登，请核对当前版本后同步草稿");
          return this.listingService.reviseSalesPlanDraft(tx, context, {
            listingId: existing.id,
            expectedVersionId: input.expectedListingVersionId,
            planRevision: plan.revision,
            styleId,
            content,
          });
        }
        if (input.expectedListingVersionId)
          throw new ConflictException("目标刊登已变化，请刷新后核对");
        return this.listingService.createDevelopmentDraft(tx, context, {
          spuId: plan.spuId,
          styleId,
          salesPlanId: id,
          salesPlanRevision: plan.revision,
          platform: "amazon",
          marketplaceId: f.marketplaceId,
          locale: f.locale,
          content,
        });
      },
    );
  }

  private async lock(tx: TenantTransaction, context: TenantContext, id: string, revision: number) {
    await lockDevelopment(tx, context, `sales-plan:${id}`);
    const row = await read(tx, id);
    if (row.plan.archivedAt) throw new ConflictException("方案已归档，历史资料可以查看");
    if (row.plan.revision !== revision)
      throw new ConflictException("销售方案已有新版本，请刷新后核对；当前输入仍可保留");
    return row;
  }

  private async assertReferences(
    tx: TenantTransaction,
    context: TenantContext,
    spuId: string,
    f: SalesPlanFields,
  ) {
    await this.assertReadReferences(tx, context, f);
    const ensure = (wanted: string[], found: Array<{ id: string }>, label: string) => {
      if (found.length !== wanted.length)
        throw new ConflictException(`${label}不可用或不属于当前商品`);
    };
    if (f.specificationIds.length)
      ensure(
        f.specificationIds,
        await tx
          .select({ id: productSpecifications.id })
          .from(productSpecifications)
          .where(
            and(
              eq(productSpecifications.spuId, spuId),
              inArray(productSpecifications.id, f.specificationIds),
            ),
          ),
        "规格",
      );
    if (f.skuIds.length)
      ensure(
        f.skuIds,
        await tx
          .select({ id: skus.id })
          .from(skus)
          .where(
            and(eq(skus.spuId, spuId), ne(skus.status, "archived"), inArray(skus.id, f.skuIds)),
          ),
        "销售 SKU",
      );
    if (f.researchItemIds.length) {
      authorize(context, Permission.ResearchRead);
      ensure(
        f.researchItemIds,
        await tx
          .select({ id: researchItems.id })
          .from(researchItems)
          .where(
            and(inArray(researchItems.id, f.researchItemIds), isNull(researchItems.archivedAt)),
          ),
        "研究来源",
      );
    }
    if (f.artworkVersionIds.length) {
      authorize(context, Permission.DesignRead);
      const selectedArtworks = await tx
        .select({ id: artworkMasterVersions.id, mode: artworkMasterVersions.mode })
        .from(artworkMasterVersions)
        .innerJoin(artworkMasters, eq(artworkMasters.id, artworkMasterVersions.artworkId))
        .where(
          and(
            inArray(artworkMasterVersions.id, f.artworkVersionIds),
            isNull(artworkMasters.archivedAt),
          ),
        );
      ensure(f.artworkVersionIds, selectedArtworks, "印花版本");
      if (
        selectedArtworks.some((artwork) =>
          f.mode === "standard" ? artwork.mode !== "fixed" : false,
        )
      )
        throw new ConflictException(
          "印花模式与销售方案不一致：标品使用固定印花，定制使用来图或文字定制方案",
        );
    }
    if (f.creativeProjectId) {
      authorize(context, Permission.DesignRead);
      ensure(
        [f.creativeProjectId],
        await tx
          .select({ id: creativeDesignBatches.id })
          .from(creativeDesignBatches)
          .where(
            and(
              eq(creativeDesignBatches.id, f.creativeProjectId),
              isNull(creativeDesignBatches.archivedAt),
            ),
          ),
        "图文项目",
      );
    }
    if (f.accountId) {
      authorize(context, Permission.StoreRead);
      ensure(
        [f.accountId],
        await tx
          .select({ id: marketplaceAccounts.id })
          .from(marketplaceAccounts)
          .where(
            and(
              eq(marketplaceAccounts.id, f.accountId),
              eq(marketplaceAccounts.platform, "amazon"),
              sql`${marketplaceAccounts.status} not in ('disabled','revoked')`,
            ),
          ),
        "Amazon 店铺",
      );
    }
    const assetIds = [...new Set([...f.mediaAssetIds, ...f.customMaterials.map((m) => m.assetId)])];
    if (assetIds.length) {
      authorize(context, Permission.AssetRead);
      const rows = await tx
        .select()
        .from(assetFiles)
        .where(
          and(
            inArray(assetFiles.id, assetIds),
            isNull(assetFiles.deletedAt),
            activeCreativeAsset(),
          ),
        );
      assertAuthorizedAssets(assetIds, rows, "上架素材");
      if (
        rows.some(
          (asset) =>
            !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType) ||
            (asset.rightsMetadata as { source?: { kind?: string } }).source?.kind ===
              "competitor_reference",
        )
      )
        throw new ConflictException("上架素材必须是授权图片，不能使用竞品或订单私有素材");
    }
  }

  private async assertReadReferences(
    tx: TenantTransaction,
    context: TenantContext,
    f: SalesPlanFields,
  ) {
    for (const id of f.artworkVersionIds) {
      const [version] = await tx
        .select({ artworkId: artworkMasterVersions.artworkId })
        .from(artworkMasterVersions)
        .where(eq(artworkMasterVersions.id, id));
      if (!version) throw new NotFoundException("印花资料不存在或不可访问");
      await assertCatalogArtworkAccess(tx, context, version.artworkId, [Permission.DesignRead]);
    }
    const check = async (wanted: string[], found: Promise<Array<{ id: string }>>) => {
      if (wanted.length && (await found).length !== new Set(wanted).size)
        throw new NotFoundException("方案关联资料不存在或不可访问");
    };
    if (f.researchItemIds.length)
      await check(
        f.researchItemIds,
        tx
          .select({ id: researchItems.id })
          .from(researchItems)
          .where(
            and(
              inArray(researchItems.id, f.researchItemIds),
              catalogOwnerFilter(context, Permission.ResearchRead, researchItems.ownerUserId),
            ),
          ),
      );
    const assetIds = [
      ...new Set([
        ...f.mediaAssetIds,
        ...f.customMaterials.map((item) => item.assetId),
        ...(f.mainImageId ? [f.mainImageId] : []),
      ]),
    ];
    if (assetIds.length)
      await check(
        assetIds,
        tx
          .select({ id: assetFiles.id })
          .from(assetFiles)
          .where(
            and(
              inArray(assetFiles.id, assetIds),
              catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
            ),
          ),
      );
    if ((await this.unreadableSkuReferences(tx, context, f.skuIds)).length)
      throw new NotFoundException("方案关联资料不存在或不可访问");
    if (f.creativeProjectId)
      await check(
        [f.creativeProjectId],
        tx
          .select({ id: creativeDesignBatches.id })
          .from(creativeDesignBatches)
          .where(
            and(
              eq(creativeDesignBatches.id, f.creativeProjectId),
              catalogOwnerFilter(context, Permission.DesignRead, creativeDesignBatches.createdBy),
            ),
          ),
      );
    if (f.accountId)
      await check(
        [f.accountId],
        tx
          .select({ id: marketplaceAccounts.id })
          .from(marketplaceAccounts)
          .where(
            and(
              eq(marketplaceAccounts.id, f.accountId),
              catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
            ),
          ),
      );
  }

  private async unreadableSkuReferences(
    tx: TenantTransaction,
    context: TenantContext,
    ids: string[],
  ) {
    if (ids.length) {
      const recipes = await tx
        .select({ id: salesRecipeVersions.id, skuId: salesRecipeVersions.skuId })
        .from(salesRecipeVersions)
        .innerJoin(
          salesSkuDefinitions,
          and(
            eq(salesSkuDefinitions.skuId, salesRecipeVersions.skuId),
            eq(salesSkuDefinitions.versionNumber, salesRecipeVersions.versionNumber),
          ),
        )
        .where(inArray(salesRecipeVersions.skuId, ids));
      if (recipes.length) {
        const visible = await tx
          .select({ id: salesRecipeVersions.id })
          .from(salesRecipeVersions)
          .where(
            and(
              inArray(
                salesRecipeVersions.id,
                recipes.map((row) => row.id),
              ),
              catalogRecipeReadFilter(context, salesRecipeVersions.id),
            ),
          );
        const allowed = new Set(visible.map((row) => row.id));
        return [...new Set(recipes.filter((row) => !allowed.has(row.id)).map((row) => row.skuId))];
      }
    }
    return [];
  }
}
async function assertSpu(tx: TenantTransaction, id: string) {
  const [row] = await tx
    .select({ id: spus.id })
    .from(spus)
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(and(eq(spus.id, id), ne(spus.status, "archived"), ne(productPlans.status, "archived")));
  if (!row) throw new NotFoundException("商品 SPU 不存在或已归档");
}
async function read(tx: TenantTransaction, id: string) {
  const [row] = await tx
    .select({ plan: salesPlans, spu: spus, root: productPlans })
    .from(salesPlans)
    .innerJoin(spus, eq(spus.id, salesPlans.spuId))
    .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
    .where(eq(salesPlans.id, id));
  if (!row) throw new NotFoundException("销售方案不存在");
  return row;
}
function view({ plan, spu, root }: Awaited<ReturnType<typeof read>>): SalesPlanView {
  return {
    id: plan.id,
    spuId: plan.spuId,
    spuCode: spu.code,
    spuName: spu.name,
    ownerUserId: root.createdBy ?? undefined,
    ...(root.teamId ? { teamId: root.teamId } : {}),
    fields: plan.fields,
    revision: plan.revision,
    archived: !!plan.archivedAt,
    updatedAt: plan.updatedAt.toISOString(),
  };
}
