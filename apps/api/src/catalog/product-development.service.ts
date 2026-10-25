import { ConflictException,Inject,Injectable,NotFoundException } from "@nestjs/common";
import { authorize,Permission } from "@yummyai/authz";
import {
assertCatalogTeamAssignment,catalogAssetReadFilter,catalogContextAuthority,
catalogOwnerFilter,
catalogPlanFilter,currentCatalogContext,DevelopmentReadOwner
} from "@yummyai/catalog-core";
import { createEntityId,type TenantContext } from "@yummyai/contracts";
import { compositionIdentity,legacyPrintBinding } from "@yummyai/contracts/catalog/composition";
import {
ArchiveArtworkSchema,
CreateProductCombinationSchema,
CreateProductSpecificationsSchema,
CreateProductSpuSchema,
normalizeSpecificationFactDisplay,
RegisterArtworkSchema,
ReviseSalesRecipeSchema,
SaveProductSpecificationSchema,
specificationAttributesKey,
specificationFactProblems,
specificationProductionFactProblems,
UpdateProductSpuSchema,
type DevelopmentOptions
} from "@yummyai/contracts/catalog/development";
import {
activeCreativeAsset,
artworkMasters,
artworkMasterVersions,
assetFiles,
canvasPrintSpecVersions,
creativeDesignVersionAssets,
creativeDesignVersions,
inventoryStockItems,
marketplaceAccounts,
printProfiles,
printProfileVersions,
productionEditorProjects,
productPlans,
productSpecifications,
productSpecificationVersions,
productStyles,
researchItems,
salesRecipeVersions,
salesSkuDefinitions,
skus,
spus,
type DatabaseConnection,
type TenantTransaction
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and,desc,eq,inArray,isNull,ne,or,sql } from "drizzle-orm";
import sharp from "sharp";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { DATABASE_CONNECTION,PRIVATE_STORAGE } from "../platform.tokens.js";
import { originalOwnerOperation } from "../shared/original-owner-error.js";
import { withCatalogTenant as withTenant } from "./catalog-access.js";
import {
assertActiveArtwork,
assertActiveCatalogSource,
assertSpecificationFactsForNewWork,
assertSpecificationProcess,
currentArtworkIds,
currentSpecificationIds,
fingerprint,
latestRecipe,
lockDevelopment,
mutateDevelopment,
productSpuView,
readArtwork,
readArtworkMaterials,
readRecipe,
readSpecification,
resolvePrintBindings,
savePrintBindings,
} from "./development-data.js";
import { assertSpecificationProductionSources } from "./specification-production-sources.js";

@Injectable()
export class ProductDevelopmentService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  async preview(context: TenantContext, assetId: string) {
    authorize(context, Permission.AssetRead);
    const [asset] = await withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return tx
        .select()
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.id, assetId),
            catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id),
          ),
        );
    });
    if (
      !asset ||
      asset.deletedAt ||
      !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType)
    )
      throw new NotFoundException("图片预览不可用");
    assertAuthorizedAssets([assetId], [asset], "预览素材");
    const bytes = await this.storage.readPrivate(
      context,
      { ...asset, assetDomain: "authorized" },
      { requiredDomain: "authorized" },
    );
    return sharp(bytes, { limitInputPixels: 64_000_000 })
      .rotate()
      .resize(640, 640, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  }

  async options(context: TenantContext): Promise<DevelopmentOptions> {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, async (tx) => {
      context = await currentCatalogContext(tx, context);
      return {
        artworks: await Promise.all(
          (await currentArtworkIds(tx, context)).map((row) => readArtwork(tx, row.id)),
        ),
        archivedArtworks: await Promise.all(
          (await currentArtworkIds(tx, context, true)).map((row) => readArtwork(tx, row.id)),
        ),
        specifications: await Promise.all(
          (await currentSpecificationIds(tx, context)).map((row) => readSpecification(tx, row.id)),
        ),
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
        creativeVersions: (
          await tx
            .select({
              id: creativeDesignVersions.id,
              name: creativeDesignVersions.name,
              version: creativeDesignVersions.versionNumber,
              assetId: creativeDesignVersionAssets.assetId,
              createdAt: creativeDesignVersions.createdAt,
            })
            .from(creativeDesignVersions)
            .innerJoin(
              creativeDesignVersionAssets,
              and(
                eq(creativeDesignVersionAssets.creativeDesignVersionId, creativeDesignVersions.id),
                eq(creativeDesignVersionAssets.role, "master"),
              ),
            )
            .innerJoin(assetFiles, eq(assetFiles.id, creativeDesignVersionAssets.assetId))
            .where(
              and(
                eq(creativeDesignVersions.status, "approved"),
                activeCreativeAsset(),
                eq(assetFiles.assetDomain, "authorized"),
                eq(assetFiles.rightsStatus, "approved"),
                isNull(assetFiles.deletedAt),
                catalogOwnerFilter(
                  context,
                  Permission.DesignRead,
                  creativeDesignVersions.createdBy,
                ),
                context.permissions.includes(Permission.AssetRead)
                  ? catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id)
                  : sql`false`,
              ),
            )
            .orderBy(desc(creativeDesignVersions.createdAt))
        ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        researchItems: (
          await tx
            .select({ id: researchItems.id, title: researchItems.latestTitle })
            .from(researchItems)
            .where(
              context.permissions.includes(Permission.ResearchRead)
                ? catalogOwnerFilter(context, Permission.ResearchRead, researchItems.ownerUserId)
                : sql`false`,
            )
            .orderBy(desc(researchItems.lastCapturedAt))
            .limit(500)
        ).map((row) => ({ ...row, title: row.title ?? row.id })),
        processes: await tx
          .select({
            versionId: printProfileVersions.id,
            code: printProfiles.code,
            name: printProfileVersions.name,
            productType: printProfileVersions.productType,
          })
          .from(printProfileVersions)
          .innerJoin(printProfiles, eq(printProfiles.id, printProfileVersions.profileId))
          .where(isNull(printProfiles.archivedAt))
          .orderBy(printProfiles.code, desc(printProfileVersions.versionNumber)),
        canvasPrintSpecs: await tx
          .select({ id: canvasPrintSpecVersions.id, name: canvasPrintSpecVersions.name })
          .from(canvasPrintSpecVersions)
          .where(eq(canvasPrintSpecVersions.status, "approved")),
        stockItems: await tx
          .select({
            id: inventoryStockItems.id,
            code: inventoryStockItems.code,
            name: inventoryStockItems.name,
          })
          .from(inventoryStockItems)
          .where(and(eq(inventoryStockItems.status, "active"), isNull(inventoryStockItems.skuId))),
        accounts: context.permissions.includes(Permission.StoreRead)
          ? await tx
              .select({
                id: marketplaceAccounts.id,
                displayName: marketplaceAccounts.displayName,
                platform: marketplaceAccounts.platform,
              })
              .from(marketplaceAccounts)
              .where(
                and(
                  sql`${marketplaceAccounts.status} not in ('disabled','revoked')`,
                  catalogOwnerFilter(context, Permission.StoreRead, marketplaceAccounts.createdBy),
                ),
              )
          : [],
        preferenceScope: `${context.tenantId}:${context.userId}`,
        contextAuthority: catalogContextAuthority(context),
        materialAssets: await tx
          .select({
            id: assetFiles.id,
            fileName: assetFiles.fileName,
            mediaType: assetFiles.mediaType,
            version: assetFiles.version,
          })
          .from(assetFiles)
          .where(
            and(
              eq(assetFiles.assetDomain, "authorized"),
              activeCreativeAsset(),
              eq(assetFiles.rightsStatus, "approved"),
              isNull(assetFiles.deletedAt),
              context.permissions.includes(Permission.AssetRead)
                ? catalogAssetReadFilter(context, assetFiles.ownerUserId, assetFiles.id)
                : sql`false`,
              sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind','') not in ('customer_provided','competitor_reference')`,
            ),
          )
          .orderBy(desc(assetFiles.createdAt))
          .limit(500),
      };
    });
  }

  async createSpu(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateProductSpuSchema.parse(body),
      id = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "create", permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: "spu.create",
        resourceId: id,
        reason: input.description,
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        await assertCatalogTeamAssignment(tx, context, input.teamId);
        await lockDevelopment(tx, context, `spu:${input.code.toLowerCase()}`);
        const [existing] = await tx
          .select({ id: spus.id })
          .from(spus)
          .where(sql`lower(${spus.code}) = ${input.code.toLowerCase()}`);
        if (existing) throw new ConflictException("此 SPU 编号已存在，请在已有产品下添加规格");
        // Existing sourcing links require a product-plan parent. This compatibility
        // record represents a physical catalog product, with no research approval.
        const productPlanId = createEntityId();
        await tx.insert(productPlans).values({
          id: productPlanId,
          tenantId: context.tenantId,
          createdBy: context.userId,
          teamId: input.teamId,
          name: input.name,
          description: input.description,
          status: "developing",
          sourceReportIds: [],
          customization: { version: 1, fields: [] },
        });
        await tx.insert(spus).values({
          id,
          tenantId: context.tenantId,
          productPlanId,
          code: input.code,
          name: input.name,
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          customization: { version: 1, fields: [] },
        });
        return {
          spu: {
            id,
            productPlanId,
            code: input.code,
            name: input.name,
            ownerUserId: context.userId,
            ...(input.teamId ? { teamId: input.teamId } : {}),
          },
        };
      },
    );
  }

  async updateSpu(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = UpdateProductSpuSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "spu", id, permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: "spu.update",
        resourceId: id,
        reason: "修改 SPU 基础信息",
        input: { ...input, id },
      },
      async (tx, currentContext) => {
        context = currentContext;
        await assertCatalogTeamAssignment(tx, context, input.teamId);
        await lockDevelopment(tx, context, `spu:${input.code.toLowerCase()}`);
        const [current] = await tx
          .select({ spu: spus, plan: productPlans })
          .from(spus)
          .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
          .where(eq(spus.id, id))
          .for("update");
        if (!current) throw new NotFoundException("SPU 不存在");
        if (current.spu.legacyPlanAmbiguous)
          throw new ConflictException("此 SPU 保留了历史多商品企划关系，需先明确关联；本次不会改写共享企划或选择默认商品");
        if (current.spu.status === "archived" || current.plan.status === "archived")
          throw new ConflictException("已归档产品不能修改基础信息");
        const previous = productSpuView(current);
        if (previous.revision !== input.expectedRevision)
          throw new ConflictException("SPU 基础资料已变化，请刷新后重新核对");
        const [duplicate] = await tx
          .select({ id: spus.id })
          .from(spus)
          .where(
            and(sql`lower(${spus.code}) = ${input.code.toLowerCase()}`, sql`${spus.id} <> ${id}`),
          );
        if (duplicate) throw new ConflictException("此 SPU 编号已存在，请使用其他编号");
        const now = new Date();
        const [spu] = await tx
          .update(spus)
          .set({
            code: input.code,
            name: input.name,
            updatedAt: now,
            ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          })
          .where(eq(spus.id, id))
          .returning();
        const profile = current.plan.customProductProfile;
        const [plan] = await tx
          .update(productPlans)
          .set({
            name: input.name,
            description: input.description,
            ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
            updatedAt: now,
            ...(profile?.sku?.value === current.spu.code
              ? {
                  customProductProfile: {
                    ...profile,
                    sku: { ...profile.sku, value: input.code },
                    updatedAt: now.toISOString(),
                  },
                }
              : {}),
          })
          .where(eq(productPlans.id, current.plan.id))
          .returning();
        return { spu: productSpuView({ spu: spu!, plan: plan! }), previous };
      },
    );
  }

  async registerArtwork(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    authorize(context, Permission.DesignReview);
    const input = RegisterArtworkSchema.parse(body),
      resourceId = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "artworkCode",
          id: input.code,
          permissions: [Permission.ProductWrite, Permission.DesignReview],
          additional: [
            ...(input.creativeVersionId
              ? [
                  {
                    kind: "creativeVersion" as const,
                    id: input.creativeVersionId,
                    permissions: [Permission.DesignRead],
                  },
                ]
              : []),
            ...[...new Set(input.researchItemIds)].sort().map((id) => ({
              kind: "research" as const,
              id,
              permissions: [Permission.ResearchRead],
            })),
            ...[...new Set(input.materials.map((material) => material.assetId))]
              .sort()
              .map((id) => ({ kind: "asset" as const, id, permissions: [Permission.AssetRead] })),
          ],
        },
        key: input.idempotencyKey,
        action: "artwork.register",
        resourceId,
        reason: input.instructions,
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        await assertCatalogTeamAssignment(tx, context, input.teamId);
        await lockDevelopment(tx, context, `artwork:${input.code.toLowerCase()}`);
        const [master] = await tx
          .select()
          .from(artworkMasters)
          .where(sql`lower(${artworkMasters.code}) = ${input.code.toLowerCase()}`)
          .for("update");
        if (master?.archivedAt) throw new ConflictException("印花已归档，请先恢复后再修改");
        if ((master?.versionNumber ?? 0) !== input.expectedVersion)
          throw new ConflictException("印花版本已变化，请刷新后重试");
        let asset: typeof assetFiles.$inferSelect | undefined;
        if (input.creativeVersionId) {
          const [creative] = await tx
            .select()
            .from(creativeDesignVersions)
            .where(eq(creativeDesignVersions.id, input.creativeVersionId));
          const sources = await tx
            .select()
            .from(creativeDesignVersionAssets)
            .where(
              and(
                eq(creativeDesignVersionAssets.creativeDesignVersionId, input.creativeVersionId),
                eq(creativeDesignVersionAssets.role, "master"),
              ),
            );
          if (creative?.status !== "approved" || sources.length !== 1)
            throw new ConflictException("请先审核创意版本，并确定唯一主印花文件");
          assertAuthorizedAssets(
            [sources[0]!.assetId],
            await tx.select().from(assetFiles).where(eq(assetFiles.id, sources[0]!.assetId)),
            "创意主文件",
          );
          [asset] = await tx
            .select()
            .from(assetFiles)
            .where(eq(assetFiles.id, sources[0]!.assetId));
          if (!asset || asset.deletedAt || asset.version !== sources[0]!.assetVersion)
            throw new ConflictException("创意主文件版本已失效");
        }
        if (
          input.researchItemIds.length &&
          (
            await tx
              .select({ id: researchItems.id })
              .from(researchItems)
              .where(inArray(researchItems.id, input.researchItemIds))
          ).length !== new Set(input.researchItemIds).size
        )
          throw new NotFoundException("研究来源不存在");
        if (input.mode === "fixed" && input.customization.fields.length)
          throw new ConflictException("固定印花不能包含定制字段");
        const materialInputs = [
          ...(asset ? [{ assetId: asset.id, role: "master" as const, usage: "印花主文件" }] : []),
          ...input.materials.filter((m) => m.assetId !== asset?.id),
        ];
        if (
          new Set(materialInputs.map((m) => m.assetId)).size !== materialInputs.length ||
          materialInputs.some((m) => m.role === "master" && m.assetId !== asset?.id)
        )
          throw new ConflictException("素材不可重复，主文件由已审核创意确定");
        const materialRows = await tx
          .select()
          .from(assetFiles)
          .where(
            inArray(
              assetFiles.id,
              materialInputs.map((m) => m.assetId),
            ),
          )
          .for("share");
        assertAuthorizedAssets(
          materialInputs.map((m) => m.assetId),
          materialRows,
          "印花素材",
        );
        const materials = materialInputs.map((m) => {
          const row = materialRows.find((r) => r.id === m.assetId)!;
          if (row.deletedAt) throw new ConflictException("印花素材已删除");
          return {
            ...m,
            assetVersion: row.version,
            checksumSha256: row.checksumSha256,
            fileName: row.fileName,
            mediaType: row.mediaType,
          };
        });
        if (input.layout.some((p) => !input.customization.fields.some((f) => f.key === p.fieldKey)))
          throw new ConflictException("定制区域未关联有效字段");
        const id = master?.id ?? resourceId,
          versionNumber = input.expectedVersion + 1,
          versionId = createEntityId();
        if (master)
          await tx
            .update(artworkMasters)
            .set({ versionNumber, ...(input.teamId !== undefined ? { teamId: input.teamId } : {}) })
            .where(eq(artworkMasters.id, id));
        else
          await tx.insert(artworkMasters).values({
            id,
            tenantId: context.tenantId,
            createdBy: context.userId,
            code: input.code,
            teamId: input.teamId,
            versionNumber,
          });
        await tx.insert(artworkMasterVersions).values({
          id: versionId,
          tenantId: context.tenantId,
          createdBy: context.userId,
          artworkId: id,
          versionNumber,
          name: input.name,
          mode: input.mode,
          creativeVersionId: input.creativeVersionId,
          assetId: asset?.id ?? null,
          tags: input.tags,
          researchItemIds: input.researchItemIds,
          customization: input.customization,
          instructions: input.instructions,
          materials,
          layout: input.layout,
        });
        return { artwork: await readArtwork(tx, versionId) };
      },
    );
  }

  async archiveArtwork(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = ArchiveArtworkSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "artwork", id, permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: input.archived ? "artwork.archive" : "artwork.restore",
        resourceId: id,
        reason: input.reason,
        input: { id, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        await lockDevelopment(tx, context, "combinations");
        const [master] = await tx
          .select()
          .from(artworkMasters)
          .where(eq(artworkMasters.id, id))
          .for("update");
        if (!master) throw new NotFoundException("印花不存在");
        if (master.versionNumber !== input.expectedVersion)
          throw new ConflictException("印花版本已变化，请刷新后重试");
        await tx
          .update(artworkMasters)
          .set({ archivedAt: input.archived ? new Date() : null })
          .where(eq(artworkMasters.id, id));
        const [version] = await tx
          .select({ id: artworkMasterVersions.id })
          .from(artworkMasterVersions)
          .where(
            and(
              eq(artworkMasterVersions.artworkId, id),
              eq(artworkMasterVersions.versionNumber, master.versionNumber),
            ),
          );
        return { artwork: await readArtwork(tx, version!.id) };
      },
    );
  }

  async saveSpecification(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = SaveProductSpecificationSchema.parse(body),
      resourceId = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "spu", id: input.spuId, permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: "specification.save",
        resourceId,
        reason: input.name,
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        return {
          specification: await this.writeSpecification(tx, context, input, resourceId),
        };
      },
    );
  }

  async createSpecifications(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateProductSpecificationsSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: { kind: "spu", id: input.spuId, permissions: [Permission.ProductWrite] },
        key: input.idempotencyKey,
        action: "specification.batch_create",
        resourceId: input.spuId,
        reason: "批量绑定产品规格",
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        await lockDevelopment(tx, context, `specifications:${input.spuId}`);
        const specifications = [];
        for (const item of input.items)
          specifications.push(
            await this.writeSpecification(
              tx,
              context,
              {
                ...item,
                spuId: input.spuId,
                expectedVersion: 0,
              },
              createEntityId(),
            ),
          );
        return { specifications };
      },
    );
  }

  private async writeSpecification(
    tx: TenantTransaction,
    context: TenantContext,
    input: Omit<ReturnType<typeof SaveProductSpecificationSchema.parse>, "idempotencyKey">,
    resourceId: string,
  ) {
    await lockDevelopment(tx, context, `specifications:${input.spuId}`);
    const [spu] = await tx.select().from(spus).where(eq(spus.id, input.spuId));
    if (!spu) throw new NotFoundException("SPU 不存在");
    const [current] = await tx
      .select()
      .from(productSpecifications)
      .where(
        and(
          eq(productSpecifications.spuId, spu.id),
          sql`lower(${productSpecifications.code}) = ${input.code.toLowerCase()}`,
        ),
      );
    if ((current?.versionNumber ?? 0) !== input.expectedVersion)
      throw new ConflictException("规格版本已变化，请刷新后重试");
    if (Object.keys(input.attributes).length) {
      const existing = await tx
        .select({
          id: productSpecifications.id,
          attributes: productSpecificationVersions.attributes,
        })
        .from(productSpecifications)
        .innerJoin(
          productSpecificationVersions,
          and(
            eq(productSpecificationVersions.specificationId, productSpecifications.id),
            eq(productSpecificationVersions.versionNumber, productSpecifications.versionNumber),
          ),
        )
        .where(eq(productSpecifications.spuId, input.spuId));
      const key = specificationAttributesKey(input.attributes);
      if (
        existing.some(
          (item) => item.id !== current?.id && specificationAttributesKey(item.attributes) === key,
        )
      )
        throw new ConflictException("此 SPU 已有相同的规格组合，请修改已有规格或调整选项");
    }
    if (!input.processProfileVersionId && input.facts.factsConfirmed)
      throw new ConflictException("未配置工艺底稿时只能保存未确认的规格草稿");
    const facts = normalizeSpecificationFactDisplay(input.facts);
    if (facts.factsConfirmed) {
      const problems = specificationFactProblems(facts);
      if (problems.length) throw new ConflictException(`产品事实未完成确认：${problems.join("；")}`);
    }
    if (facts.productionConfirmed) {
      const problems = specificationProductionFactProblems(facts);
      if (problems.length) throw new ConflictException(`生产资料未完成核对：${problems.join("；")}`);
    }
    if (input.processProfileVersionId) {
      const [process] = await tx
        .select({ profile: printProfileVersions, project: productionEditorProjects })
        .from(printProfileVersions)
        .innerJoin(
          productionEditorProjects,
          eq(productionEditorProjects.id, printProfileVersions.projectId),
        )
        .where(eq(printProfileVersions.id, input.processProfileVersionId));
      if (
        !process ||
        process.project.status !== "active" ||
        !process.project.encryptedDataKey ||
        process.project.sourceReportLineId ||
        process.project.sourceWorkItemId ||
        process.project.sourceSalesRecipeId
      )
        throw new ConflictException("工艺底稿不可用或含订单/销售素材");
    }
    if (
      input.canvasPrintSpecVersionId &&
      !(
        await tx
          .select()
          .from(canvasPrintSpecVersions)
          .where(
            and(
              eq(canvasPrintSpecVersions.id, input.canvasPrintSpecVersionId),
              eq(canvasPrintSpecVersions.status, "approved"),
            ),
          )
      ).length
    )
      throw new ConflictException("套图印刷规格尚未审核");
    if (
      input.stockItemId &&
      !(
        await tx
          .select()
          .from(inventoryStockItems)
          .where(
            and(
              eq(inventoryStockItems.id, input.stockItemId),
              eq(inventoryStockItems.status, "active"),
              isNull(inventoryStockItems.skuId),
            ),
          )
      ).length
    )
      throw new ConflictException("请选择共用空白品库存物料");
    if (facts.productionConfirmed || facts.productionRuleReferences?.length) {
      const [previous] = current ? await tx.select({ facts: productSpecificationVersions.facts }).from(productSpecificationVersions)
        .where(and(eq(productSpecificationVersions.specificationId, current.id), eq(productSpecificationVersions.versionNumber, current.versionNumber))) : [];
      await assertSpecificationProductionSources(tx, context, {
        spuId: input.spuId, processProfileVersionId: input.processProfileVersionId, facts, previousFacts: previous?.facts,
      });
    }
    const id = current?.id ?? resourceId,
      versionNumber = input.expectedVersion + 1,
      versionId = createEntityId();
    if (current)
      await tx
        .update(productSpecifications)
        .set({ versionNumber })
        .where(eq(productSpecifications.id, id));
    else
      await tx.insert(productSpecifications).values({
        id,
        tenantId: context.tenantId,
        createdBy: context.userId,
        spuId: spu.id,
        code: input.code,
        versionNumber,
      });
    await tx.insert(productSpecificationVersions).values({
      id: versionId,
      tenantId: context.tenantId,
      createdBy: context.userId,
      specificationId: id,
      versionNumber,
      name: input.name,
      attributes: input.attributes,
      facts,
      processProfileVersionId: input.processProfileVersionId,
      canvasPrintSpecVersionId: input.canvasPrintSpecVersionId,
      stockItemId: input.stockItemId,
    });
    return readSpecification(tx, versionId);
  }

  async combine(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateProductCombinationSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "create",
          permissions: [Permission.ProductWrite, Permission.DesignRead],
          additional: [
            ...input.items.map((i) => ({
              kind: "specificationVersion" as const,
              id: i.specificationVersionId,
              permissions: [Permission.ProductWrite],
            })),
            ...input.items.flatMap((i) =>
              i.existingSkuId
                ? [
                    {
                      kind: "sku" as const,
                      id: i.existingSkuId,
                      permissions: [Permission.ProductWrite],
                    },
                  ]
                : [],
            ),
            ...[
              ...new Set([
                ...(input.printBindings ?? []).map((b) => b.artworkVersionId),
                ...(input.artworkVersionId ? [input.artworkVersionId] : []),
              ]),
            ]
              .sort()
              .map((id) => ({
                kind: "artworkVersion" as const,
                id,
                permissions: [Permission.DesignRead],
              })),
          ],
        },
        key: input.idempotencyKey,
        action: "sales_sku.combine",
        resourceId: input.artworkVersionId ?? input.printBindings![0]!.artworkVersionId,
        reason: "组合印花与产品规格",
        input,
      },
      async (tx, currentContext) => {
        context = currentContext;
        // A tenant catalog lock serializes bulk combinations and legacy mappings.
        await lockDevelopment(tx, context, "combinations");
        const bindings = input.printBindings ?? [legacyPrintBinding(input.artworkVersionId!)];
        const resolved = await resolvePrintBindings(tx, bindings),
          artwork = resolved[0]!.artwork;
        for (const b of resolved) {
          await assertActiveArtwork(tx, b.artwork);
          await readArtworkMaterials(tx, b.artwork);
        }
        const identityKey = fingerprint(compositionIdentity(resolved));
        const defaultIdentityKey = fingerprint(
          compositionIdentity([{ ...legacyPrintBinding(artwork.versionId), artwork }]),
        );
        const legacyEquivalent = identityKey === defaultIdentityKey;
        const compositionKey = legacyEquivalent ? null : identityKey;
        const results = [];
        for (const item of input.items) {
          const spec = await readSpecification(tx, item.specificationVersionId);
          assertSpecificationProcess(spec);
          assertSpecificationFactsForNewWork(spec);
          await assertActiveCatalogSource(tx, spec.spuId);
          const knownStyles = await tx
            .select()
            .from(productStyles)
            .where(
              and(
                eq(productStyles.spuId, spec.spuId),
                legacyEquivalent
                  ? and(
                      eq(productStyles.artworkId, artwork.id),
                      or(
                        isNull(productStyles.compositionKey),
                        eq(productStyles.compositionKey, identityKey),
                      ),
                    )
                  : eq(productStyles.compositionKey, compositionKey!),
              ),
            )
            .orderBy(
              sql`case when ${productStyles.compositionKey} is null then 0 else 1 end`,
              productStyles.id,
            );
          const knownStyle = knownStyles[0];
          const styleId = knownStyle?.id ?? createEntityId();
          if (!knownStyle)
            await tx.insert(productStyles).values({
              id: styleId,
              tenantId: context.tenantId,
              createdBy: context.userId,
              artworkId: artwork.id,
              compositionKey,
              spuId: spec.spuId,
            });
          if (
            (
              await tx
                .select()
                .from(salesSkuDefinitions)
                .where(
                  and(
                    inArray(
                      salesSkuDefinitions.styleId,
                      knownStyles.length ? knownStyles.map((style) => style.id) : [styleId],
                    ),
                    eq(salesSkuDefinitions.specificationId, spec.id),
                  ),
                )
            ).length
          )
            throw new ConflictException(`${spec.code} 已存在销售 SKU，请创建制作新版本`);
          const [existing] = await tx
            .select()
            .from(skus)
            .where(sql`lower(${skus.code}) = ${item.skuCode.toLowerCase()}`)
            .for("share");
          if (existing?.status === "archived")
            throw new ConflictException("销售 SKU 已归档 不能补建新的组合映射");
          if (
            existing &&
            (!item.existingSkuId ||
              existing.id !== item.existingSkuId ||
              existing.spuId !== spec.spuId)
          )
            throw new ConflictException(
              `销售 SKU ${item.skuCode} 已存在，请明确选择同一 SPU 的旧 SKU 进行映射`,
            );
          if (item.existingSkuId && !existing)
            throw new NotFoundException("待映射旧 SKU 不存在或编号不符");
          const skuId = existing?.id ?? createEntityId();
          if (
            (
              await tx
                .select()
                .from(salesSkuDefinitions)
                .where(eq(salesSkuDefinitions.skuId, skuId))
            ).length
          )
            throw new ConflictException("该 SKU 已有关联，不能覆盖历史身份");
          if (!existing)
            await tx.insert(skus).values({
              id: skuId,
              tenantId: context.tenantId,
              spuId: spec.spuId,
              code: item.skuCode,
              attributes: spec.attributes,
            });
          await tx.insert(salesSkuDefinitions).values({
            id: createEntityId(),
            tenantId: context.tenantId,
            createdBy: context.userId,
            skuId,
            styleId,
            spuId: spec.spuId,
            specificationId: spec.id,
          });
          const recipeId = createEntityId();
          await tx.insert(salesRecipeVersions).values({
            id: recipeId,
            tenantId: context.tenantId,
            createdBy: context.userId,
            skuId,
            versionNumber: 1,
            artworkVersionId: artwork.versionId,
            specificationVersionId: spec.versionId,
          });
          await savePrintBindings(tx, context, recipeId, bindings);
          results.push(await readRecipe(tx, recipeId));
        }
        return { recipes: results };
      },
    );
  }

  async revise(context: TenantContext, skuId: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = ReviseSalesRecipeSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        access: {
          kind: "sku",
          id: skuId,
          permissions: [Permission.ProductWrite],
          additional: [
            ...[
              ...new Set([
                ...(input.printBindings ?? []).map((b) => b.artworkVersionId),
                ...(input.artworkVersionId ? [input.artworkVersionId] : []),
              ]),
            ]
              .sort()
              .map((id) => ({
                kind: "artworkVersion" as const,
                id,
                permissions: [Permission.DesignRead],
              })),
          ],
        },
        key: input.idempotencyKey,
        action: "recipe.revise",
        resourceId: skuId,
        reason: input.reason,
        input: { skuId, ...input },
      },
      async (tx, currentContext) => {
        context = currentContext;
        await lockDevelopment(tx, context, `sku:${skuId}`);
        const current = await latestRecipe(tx, skuId);
        if (!current || current.version !== input.expectedVersion)
          throw new ConflictException("销售 SKU 版本已变化");
        await assertActiveCatalogSource(tx, current.specification.spuId, skuId);
        const bindings = input.printBindings ?? [legacyPrintBinding(input.artworkVersionId!)];
        const resolved = await resolvePrintBindings(tx, bindings),
          artwork = resolved[0]!.artwork,
          spec = await readSpecification(tx, input.specificationVersionId);
        assertSpecificationProcess(spec);
        assertSpecificationFactsForNewWork(spec);
        if (
          fingerprint(compositionIdentity(resolved)) !==
            fingerprint(
              compositionIdentity(
                current.printBindings ?? [
                  { ...legacyPrintBinding(current.artwork.versionId), artwork: current.artwork },
                ],
              ),
            ) ||
          spec.id !== current.specification.id
        )
          throw new ConflictException("更换印花身份或规格身份应新建销售 SKU；此处仅升级版本");
        for (const b of resolved) {
          await assertActiveArtwork(tx, b.artwork);
          await readArtworkMaterials(tx, b.artwork);
        }
        const id = createEntityId();
        await tx.insert(salesRecipeVersions).values({
          id,
          tenantId: context.tenantId,
          createdBy: context.userId,
          skuId,
          versionNumber: current.version + 1,
          artworkVersionId: artwork.versionId,
          specificationVersionId: spec.versionId,
        });
        await savePrintBindings(tx, context, id, bindings);
        await tx
          .update(salesSkuDefinitions)
          .set({ versionNumber: current.version + 1 })
          .where(eq(salesSkuDefinitions.skuId, skuId));
        return { recipe: await readRecipe(tx, id) };
      },
    );
  }

  async workspace(context:TenantContext,body:unknown){return originalOwnerOperation(()=>new DevelopmentReadOwner(this.database).workspace(context,body));}

  async detail(context:TenantContext,skuId:string){return originalOwnerOperation(()=>new DevelopmentReadOwner(this.database).detail(context,skuId));}
}
