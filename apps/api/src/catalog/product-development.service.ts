import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  RegisterArtworkSchema,
  ArchiveArtworkSchema,
  CreateProductSpuSchema,
  UpdateProductSpuSchema,
  SaveProductSpecificationSchema,
  CreateProductSpecificationsSchema,
  specificationAttributesKey,
  CreateProductCombinationSchema,
  ReviseSalesRecipeSchema,
  DevelopmentQuerySchema,
  type DevelopmentOptions,
  type DevelopmentItem,
} from "@yummyai/contracts/catalog/development";
import {
  artworkMasters,
  artworkMasterVersions,
  assetFiles,
  creativeDesignVersions,
  creativeDesignVersionAssets,
  researchItems,
  productSpecifications,
  productSpecificationVersions,
  productStyles,
  salesSkuDefinitions,
  salesRecipeVersions,
  salesPackageVersions,
  salesChannelBindings,
  developmentEvents,
  canvasPrintSpecVersions,
  printProfiles,
  printProfileVersions,
  productionEditorProjects,
  inventoryStockItems,
  marketplaceAccounts,
  spus,
  productPlans,
  skus,
  listings,
  listingVersions,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import sharp from "sharp";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import {
  currentArtworkIds,
  currentSpecificationIds,
  latestRecipe,
  lockDevelopment,
  mutateDevelopment,
  readArtwork,
  readRecipe,
  readSpecification,
  productSpuView,
  assertSpecificationProcess,
  assertActiveArtwork,
  readArtworkMaterials,
} from "./development-data.js";

@Injectable()
export class ProductDevelopmentService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
  ) {}

  async preview(context: TenantContext, assetId: string) {
    authorize(context, Permission.AssetRead);
    const [asset] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(assetFiles).where(eq(assetFiles.id, assetId)),
    );
    assertAuthorizedAssets([assetId], asset ? [asset] : [], "预览素材");
    if (
      !asset ||
      asset.deletedAt ||
      !["image/png", "image/jpeg", "image/webp"].includes(asset.mediaType)
    )
      throw new NotFoundException("图片预览不可用");
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
    return withTenant(this.database.db, context, async (tx) => ({
      artworks: await Promise.all(
        (await currentArtworkIds(tx)).map((row) => readArtwork(tx, row.id)),
      ),
      archivedArtworks: await Promise.all(
        (await currentArtworkIds(tx, true)).map((row) => readArtwork(tx, row.id)),
      ),
      specifications: await Promise.all(
        (await currentSpecificationIds(tx)).map((row) => readSpecification(tx, row.id)),
      ),
      spus: (await tx
        .select({ spu: spus, plan: productPlans })
        .from(spus)
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .where(and(ne(spus.status, "archived"), ne(productPlans.status, "archived")))
        .orderBy(spus.code)).map(productSpuView),
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
              eq(assetFiles.assetDomain, "authorized"),
              eq(assetFiles.rightsStatus, "approved"),
              isNull(assetFiles.deletedAt),
            ),
          )
          .orderBy(desc(creativeDesignVersions.createdAt))
      ).map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      researchItems: (
        await tx
          .select({ id: researchItems.id, title: researchItems.latestTitle })
          .from(researchItems)
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
        : [],
      preferenceScope: `${context.tenantId}:${context.userId}`,
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
            eq(assetFiles.rightsStatus, "approved"),
            isNull(assetFiles.deletedAt),
            sql`coalesce(${assetFiles.rightsMetadata}->'source'->>'kind','') not in ('customer_provided','competitor_reference')`,
          ),
        )
        .orderBy(desc(assetFiles.createdAt))
        .limit(500),
    }));
  }

  async createSpu(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateProductSpuSchema.parse(body),
      id = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "spu.create",
        resourceId: id,
        reason: input.description,
        input,
      },
      async (tx) => {
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
          customization: { version: 1, fields: [] },
        });
        return { spu: { id, productPlanId, code: input.code, name: input.name } };
      },
    );
  }

  async updateSpu(context: TenantContext, id: string, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = UpdateProductSpuSchema.parse(body);
    return mutateDevelopment(this.database, context, {
      key: input.idempotencyKey,
      action: "spu.update",
      resourceId: id,
      reason: "修改 SPU 基础信息",
      input: { ...input, id },
    }, async (tx) => {
      await lockDevelopment(tx, context, `spu:${input.code.toLowerCase()}`);
      const [current] = await tx.select({ spu: spus, plan: productPlans }).from(spus)
        .innerJoin(productPlans, eq(productPlans.id, spus.productPlanId))
        .where(eq(spus.id, id)).for("update");
      if (!current) throw new NotFoundException("SPU 不存在");
      if (current.spu.status === "archived" || current.plan.status === "archived")
        throw new ConflictException("已归档产品不能修改基础信息");
      const previous = productSpuView(current);
      if (previous.revision !== input.expectedRevision)
        throw new ConflictException("SPU 基础资料已变化，请刷新后重新核对");
      const [duplicate] = await tx.select({ id: spus.id }).from(spus)
        .where(and(sql`lower(${spus.code}) = ${input.code.toLowerCase()}`, sql`${spus.id} <> ${id}`));
      if (duplicate) throw new ConflictException("此 SPU 编号已存在，请使用其他编号");
      const now = new Date();
      const [spu] = await tx.update(spus).set({ code: input.code, name: input.name, updatedAt: now })
        .where(eq(spus.id, id)).returning();
      const profile = current.plan.customProductProfile;
      const [plan] = await tx.update(productPlans).set({
        name: input.name,
        description: input.description,
        updatedAt: now,
        ...(profile?.sku?.value === current.spu.code ? {
          customProductProfile: { ...profile, sku: { ...profile.sku, value: input.code }, updatedAt: now.toISOString() },
        } : {}),
      }).where(eq(productPlans.id, current.plan.id)).returning();
      return { spu: productSpuView({ spu: spu!, plan: plan! }), previous };
    });
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
        key: input.idempotencyKey,
        action: "artwork.register",
        resourceId,
        reason: input.instructions,
        input,
      },
      async (tx) => {
        await lockDevelopment(tx, context, `artwork:${input.code.toLowerCase()}`);
        const [master] = await tx
          .select()
          .from(artworkMasters)
          .where(sql`lower(${artworkMasters.code}) = ${input.code.toLowerCase()}`).for("update");
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
          await tx.update(artworkMasters).set({ versionNumber }).where(eq(artworkMasters.id, id));
        else
          await tx.insert(artworkMasters).values({
            id,
            tenantId: context.tenantId,
            createdBy: context.userId,
            code: input.code,
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
    return mutateDevelopment(this.database, context, {
      key: input.idempotencyKey, action: input.archived ? "artwork.archive" : "artwork.restore",
      resourceId: id, reason: input.reason, input: { id, ...input },
    }, async tx => {
      await lockDevelopment(tx, context, "combinations");
      const [master] = await tx.select().from(artworkMasters).where(eq(artworkMasters.id, id)).for("update");
      if (!master) throw new NotFoundException("印花不存在");
      if (master.versionNumber !== input.expectedVersion) throw new ConflictException("印花版本已变化，请刷新后重试");
      await tx.update(artworkMasters).set({ archivedAt: input.archived ? new Date() : null }).where(eq(artworkMasters.id, id));
      const [version] = await tx.select({id: artworkMasterVersions.id}).from(artworkMasterVersions)
        .where(and(eq(artworkMasterVersions.artworkId, id), eq(artworkMasterVersions.versionNumber, master.versionNumber)));
      return { artwork: await readArtwork(tx, version!.id) };
    });
  }

  async saveSpecification(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = SaveProductSpecificationSchema.parse(body),
      resourceId = createEntityId();
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "specification.save",
        resourceId,
        reason: input.name,
        input,
      },
      async (tx) => ({
        specification: await this.writeSpecification(tx, context, input, resourceId),
      }),
    );
  }

  async createSpecifications(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductWrite);
    const input = CreateProductSpecificationsSchema.parse(body);
    return mutateDevelopment(
      this.database,
      context,
      {
        key: input.idempotencyKey,
        action: "specification.batch_create",
        resourceId: input.spuId,
        reason: "批量绑定产品规格",
        input,
      },
      async (tx) => {
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
      facts: input.facts,
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
        key: input.idempotencyKey,
        action: "sales_sku.combine",
        resourceId: input.artworkVersionId,
        reason: "组合印花与产品规格",
        input,
      },
      async (tx) => {
        // A tenant catalog lock serializes bulk combinations and legacy mappings.
        await lockDevelopment(tx, context, "combinations");
        const artwork = await readArtwork(tx, input.artworkVersionId);
        await assertActiveArtwork(tx, artwork);
        await readArtworkMaterials(tx, artwork);
        const results = [];
        for (const item of input.items) {
          const spec = await readSpecification(tx, item.specificationVersionId);
          assertSpecificationProcess(spec);
          const [knownStyle] = await tx
            .select()
            .from(productStyles)
            .where(
              and(eq(productStyles.artworkId, artwork.id), eq(productStyles.spuId, spec.spuId)),
            );
          const styleId = knownStyle?.id ?? createEntityId();
          if (!knownStyle)
            await tx.insert(productStyles).values({
              id: styleId,
              tenantId: context.tenantId,
              createdBy: context.userId,
              artworkId: artwork.id,
              spuId: spec.spuId,
            });
          if (
            (
              await tx
                .select()
                .from(salesSkuDefinitions)
                .where(
                  and(
                    eq(salesSkuDefinitions.styleId, styleId),
                    eq(salesSkuDefinitions.specificationId, spec.id),
                  ),
                )
            ).length
          )
            throw new ConflictException(`${spec.code} 已存在销售 SKU，请创建制作新版本`);
          const [existing] = await tx
            .select()
            .from(skus)
            .where(sql`lower(${skus.code}) = ${item.skuCode.toLowerCase()}`);
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
        key: input.idempotencyKey,
        action: "recipe.revise",
        resourceId: skuId,
        reason: input.reason,
        input: { skuId, ...input },
      },
      async (tx) => {
        await lockDevelopment(tx, context, `sku:${skuId}`);
        const current = await latestRecipe(tx, skuId);
        if (!current || current.version !== input.expectedVersion)
          throw new ConflictException("销售 SKU 版本已变化");
        const artwork = await readArtwork(tx, input.artworkVersionId),
          spec = await readSpecification(tx, input.specificationVersionId);
        assertSpecificationProcess(spec);
        if (artwork.id !== current.artwork.id || spec.id !== current.specification.id)
          throw new ConflictException("更换印花身份或规格身份应新建销售 SKU；此处仅升级版本");
        await assertActiveArtwork(tx, artwork);
        await readArtworkMaterials(tx, artwork);
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
        await tx
          .update(salesSkuDefinitions)
          .set({ versionNumber: current.version + 1 })
          .where(eq(salesSkuDefinitions.skuId, skuId));
        return { recipe: await readRecipe(tx, id) };
      },
    );
  }

  async workspace(context: TenantContext, body: unknown) {
    authorize(context, Permission.ProductRead);
    const query = DevelopmentQuerySchema.parse(body);
    return withTenant(this.database.db, context, async (tx) => {
      const packageCount = sql<number>`(select count(*)::int from sales_package_versions p where p.sku_id = ${skus.id})`;
      const needsUpdate = sql`(${artworkMasters.versionNumber} <> ${artworkMasterVersions.versionNumber} or ${productSpecifications.versionNumber} <> ${productSpecificationVersions.versionNumber})`;
      const status =
        query.status === "unmapped"
          ? isNull(salesRecipeVersions.id)
          : query.status === "packaged"
            ? sql`exists(select 1 from sales_package_versions p where p.recipe_id=${salesRecipeVersions.id})`
            : query.status === "needs_update"
              ? needsUpdate
              : query.status !== "all"
                ? eq(salesRecipeVersions.status, query.status)
                : undefined;
      const filter = and(
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
          attributes: row.sku.attributes,
          recipe: row.recipeId ? await readRecipe(tx, row.recipeId) : null,
          packageCount: row.packageCount,
          updatedAt: row.sku.createdAt.toISOString(),
        })),
      );
      return { items, total: rows[0]?.total ?? 0, page: query.page, pageSize: query.pageSize };
    });
  }

  async detail(context: TenantContext, skuId: string) {
    authorize(context, Permission.ProductRead);
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx
        .select({ sku: skus, spu: spus })
        .from(skus)
        .innerJoin(spus, eq(spus.id, skus.spuId))
        .where(eq(skus.id, skuId));
      if (!row) throw new NotFoundException("销售 SKU 不存在");
      const recipes = await Promise.all(
        (
          await tx
            .select({ id: salesRecipeVersions.id })
            .from(salesRecipeVersions)
            .where(eq(salesRecipeVersions.skuId, skuId))
            .orderBy(desc(salesRecipeVersions.versionNumber))
        ).map((r) => readRecipe(tx, r.id)),
      );
      const packages = (
        await tx
          .select()
          .from(salesPackageVersions)
          .where(eq(salesPackageVersions.skuId, skuId))
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
      const bindings = packages.length
        ? await tx
            .select({ binding: salesChannelBindings, account: marketplaceAccounts.displayName })
            .from(salesChannelBindings)
            .innerJoin(
              marketplaceAccounts,
              eq(marketplaceAccounts.id, salesChannelBindings.accountId),
            )
            .where(
              inArray(
                salesChannelBindings.packageId,
                packages.map((p) => p.id),
              ),
            )
        : [];
      const listingRows = recipes.length
        ? await tx
            .select({ listing: listings, version: listingVersions })
            .from(listings)
            .innerJoin(listingVersions, eq(listingVersions.listingId, listings.id))
            .where(eq(listings.styleId, recipes[0]!.styleId))
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
        item: {
          skuId,
          skuCode: row.sku.code,
          spuId: row.spu.id,
          spuCode: row.spu.code,
          spuName: row.spu.name,
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
