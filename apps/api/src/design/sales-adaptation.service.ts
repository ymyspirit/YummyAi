import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { SalesRecipeView } from "@yummyai/contracts/catalog/development";
import { creativeDerivedRights, requireReferenceAuthority } from "@yummyai/catalog-core";
import { legacyPrintBinding,printBindingSnapshot } from "@yummyai/contracts/catalog/composition";
import {
  assetFiles,
  designTasks,
  designVersions,
  designVersionFiles,
  printProfileVersions,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { eq, inArray, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import sharp from "sharp";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { ProductionEditorService } from "./production-editor.service.js";
import { assertAuthorizedAssets } from "./pod-batch-workflow.service.js";
import { readArtwork, readArtworkMaterials, assertActiveArtwork, assertSpecificationFactsForNewWork } from "../catalog/development-data.js";

@Injectable()
export class SalesAdaptationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
  ) {}

  async validateCustomizationPlan(context: TenantContext, recipe: SalesRecipeView) {
    authorize(context, Permission.DesignReview);
    authorize(context, Permission.AssetRead);
    if (recipe.artwork.assetId || !recipe.artwork.customization.fields.some(field => field.type === "image" && field.required))
      throw new ConflictException("此操作仅适用于没有固定主图、必须由买家提供图片的来图方案");
    if (recipe.artwork.archived || !specificationFactsReady(recipe.specification.facts))
      throw new ConflictException("请先核实产品事实，并使用有效的来图方案");
    const profile = await withTenant(this.database.db, context, async tx => {
      await readArtworkMaterials(tx, recipe.artwork);
      const [profile] = await tx.select().from(printProfileVersions).where(eq(printProfileVersions.id, recipe.specification.processProfileVersionId));
      if (!profile) throw new ConflictException("工艺底稿不可用");
      return profile;
    });
    const template = await this.editor.get(context, profile.projectId, profile.sourceVersionId);
    if (template.project.source || template.project.workSource || template.project.catalogSource || !template.version.reviewed || !template.version.document.confirmations.physicalSize)
      throw new ConflictException("请使用已审核、已确认物理规格的通用工艺底稿");
  }

  async start(context: TenantContext, recipe: SalesRecipeView, tx: TenantTransaction) {
    return this.editor.inCatalogTransaction(context, tx, () => this.prepare(context, recipe));
  }

  private async prepare(context: TenantContext, recipe: SalesRecipeView) {
    assertSpecificationFactsForNewWork(recipe.specification);
    const bindings = recipe.printBindings ?? [{ ...legacyPrintBinding(recipe.artwork.versionId), artwork: recipe.artwork }];
    const masters = bindings.filter(b => b.artwork.assetId);
    const artworkAssetId = masters[0]?.artwork.assetId;
    if (!artworkAssetId) throw new ConflictException("此印花没有固定主图。请从订单读取顾客图片与素材制作；商品展示样例需另行准备并审核");
    const { asset, profile } = await withTenant(this.database.db, context, async (tx) => {
      const [asset] = await tx
        .select()
        .from(assetFiles)
        .where(eq(assetFiles.id, artworkAssetId));
      const [profile] = await tx
        .select()
        .from(printProfileVersions)
        .where(eq(printProfileVersions.id, recipe.specification.processProfileVersionId));
      assertAuthorizedAssets([artworkAssetId], asset ? [asset] : [], "销售 SKU 印花");
      if (!profile || !asset || asset.deletedAt || asset.version !== masters[0]!.artwork.assetVersion)
        throw new ConflictException("工艺或印花素材不可用");
      return { asset, profile };
    });
    const template = await this.editor.get(context, profile.projectId, profile.sourceVersionId);
    const bytes = await this.storage.readPrivate(
      context,
      { ...asset, assetDomain: "authorized" },
      { requiredDomain: "authorized" },
    );
    const png = await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().png().toBuffer();
    const printArtworks = [];
    for (const binding of masters) {
      const files = await withTenant(this.database.db, context, tx => readArtworkMaterials(tx, binding.artwork));
      const file = files.find(f => f.id === binding.artwork.assetId);
      if (!file) throw new ConflictException("印花主文件不可用");
      const body = await this.storage.readPrivate(context, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" });
      printArtworks.push({ binding, name: `${binding.key}-${binding.artwork.code}.png`, bytes: await sharp(body, { limitInputPixels: 64_000_000 }).rotate().png().toBuffer() });
    }
    return this.editor.createFromSalesRecipe(context, {
      skuId: recipe.skuId,
      recipeId: recipe.id,
      name: `${recipe.skuCode} · 制作 v${recipe.version}`,
      template,
      artwork: { name: `${recipe.artwork.code}.png`, bytes: png },
      ...(bindings.length > 1 || recipe.printBindings?.some(b => b.surface === "back" || b.region !== "whole" || b.area.widthPercent !== 100 || b.area.heightPercent !== 100) ? { printArtworks } : {}),
    });
  }

  private async approvedRecipeSources(tx: TenantTransaction, context: TenantContext, recipe: SalesRecipeView) {
    const bindings = recipe.printBindings ?? [{ ...legacyPrintBinding(recipe.artwork.versionId), artwork: recipe.artwork }];
    const artworks = [];
    for (const versionId of [...new Set(bindings.map(binding => binding.artworkVersionId))].sort()) {
      const artwork = await readArtwork(tx, versionId);
      await assertActiveArtwork(tx, artwork);
      artworks.push(artwork);
    }
    const ids = [...new Set(artworks.flatMap(artwork => [...artwork.materials.map(material => material.assetId), ...(artwork.assetId ? [artwork.assetId] : [])]))].sort();
    if (!ids.length) throw new ConflictException("sales_adaptation_source_unavailable");
    const files = await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).orderBy(assetFiles.id).for("share");
    if (files.length !== ids.length) throw new ConflictException("sales_adaptation_source_unavailable");
    for (const artwork of artworks) {
      await readArtworkMaterials(tx, artwork);
      if (artwork.assetId && !files.some(file => file.id === artwork.assetId && file.version === artwork.assetVersion))
        throw new ConflictException("sales_adaptation_source_unavailable");
    }
    const [clock] = await tx.execute<{ checkedAt: string }>(sql`select clock_timestamp()::text as "checkedAt"`);
    const checkedAt = Date.parse(clock!.checkedAt);
    for (const file of files) {
      const kind = (file.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (file.deletedAt || file.assetDomain !== "authorized" || file.rightsStatus !== "approved" ||
        !["owned", "licensed", "commissioned", "ai_generated"].includes(kind ?? ""))
        throw new ConflictException("sales_adaptation_source_unavailable");
    }
    requireReferenceAuthority(context, files, checkedAt);
    return { files, reviewedAt: new Date(checkedAt) };
  }

  async approve(
    tx: TenantTransaction,
    context: TenantContext,
    recipe: SalesRecipeView,
    versionId: string,
    renderId: string,
    reason: string,
  ) {
    authorize(context, Permission.DesignReview);
    authorize(context, Permission.AssetWrite);
    authorize(context, Permission.AssetRead);
    if (!recipe.editorProjectId) throw new ConflictException("尚未创建制作项目");
    await this.editor.confirmSalesVersion(
      tx,
      context,
      recipe.id,
      recipe.editorProjectId,
      versionId,
    );
    const render = await this.editor.getRender(context, recipe.editorProjectId, renderId);
    if (
      render.status !== "completed" ||
      render.purpose !== "production" ||
      render.versionId !== versionId ||
      !render.preflight?.productionReady
    )
      throw new ConflictException("请完成当前版本的生产出图并通过预检");
    const project = await this.editor.get(context, recipe.editorProjectId, versionId);
    const pillow = project.version.document.productType === "shaped_pillow";
    const file = render.files.find((f) => f.mediaType === (pillow ? "image/jpeg" : "image/png"));
    if (!file) throw new ConflictException(pillow ? "异形抱枕需使用通过工艺门禁的正式 JPG" : "请以 PNG 生产格式出图，作为套图和生产共用的已审核文件");
    const output = await this.editor.renderFile(
      context,
      recipe.editorProjectId,
      renderId,
      file.key,
    );
    const sources = await this.approvedRecipeSources(tx, context, recipe);
    const stored = await this.storage.putPrivate(context, {
      body: output.body,
      domain: "authorized",
      fileName: `${recipe.skuCode}-v${recipe.version}-${renderId}.${pillow ? "jpg" : "png"}`,
      mediaType: pillow ? "image/jpeg" : "image/png",
    });
    const [existing] = await tx
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.objectKey, stored.objectKey));
    const assetId = existing?.id ?? createEntityId();
    if (existing) {
      assertAuthorizedAssets([assetId], [existing], "制作成品");
      const kind = (existing.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (existing.deletedAt || !["owned", "licensed", "commissioned", "ai_generated"].includes(kind ?? ""))
        throw new ConflictException("sales_adaptation_source_unavailable");
      requireReferenceAuthority(context, [existing], sources.reviewedAt.getTime());
    }
    else
      await tx.insert(assetFiles).values({
        id: assetId,
        tenantId: context.tenantId,
        ownerUserId: context.userId,
        objectKey: stored.objectKey,
        assetDomain: "authorized",
        fileName: output.name,
        mediaType: output.mediaType,
        byteSize: output.body.byteLength,
        checksumSha256: stored.checksumSha256,
        aiGenerated: sources.files.some(source => source.aiGenerated),
        rightsStatus: "approved",
        rightsMetadata: {
          ...creativeDerivedRights(sources.files, { kind: "sales_recipe_adaptation", salesRecipeId: recipe.id,
            editorProjectId: recipe.editorProjectId, editorVersionId: versionId, renderId }),
          salesRecipeId: recipe.id,
          artworkVersionId: recipe.artwork.versionId,
          printBindings: recipe.printBindings?.map(printBindingSnapshot) ?? [],
          editorVersionId: versionId,
          renderId,
          reviewedBy: context.userId,
          reviewReason: reason,
          approvedBy: context.userId,
          approvedAt: sources.reviewedAt.toISOString(),
          // Editor uploads have no catalog-rights pin. Their changes remain the
          // actual editor reviewer's responsibility; do not invent owned provenance.
          sourceCoverage: { kind: "recipe_print_bindings", editorChanges: "operator_reviewed" },
        },
      });
    const taskId = createEntityId(),
      designVersionId = createEntityId();
    await tx.insert(designTasks).values({
      id: taskId,
      tenantId: context.tenantId,
      skuId: recipe.skuId,
      title: `${recipe.skuCode} · 制作 v${recipe.version}`,
      brief: reason,
      status: "approved",
      primaryVersionId: designVersionId,
      createdBy: context.userId,
    });
    await tx.insert(designVersions).values({
      id: designVersionId,
      tenantId: context.tenantId,
      taskId,
      versionNumber: 1,
      status: "approved",
      changeNote: reason,
      createdBy: context.userId,
      reviewedBy: context.userId,
      reviewedAt: sources.reviewedAt,
    });
    await tx.insert(designVersionFiles).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      versionId: designVersionId,
      assetFileId: assetId,
      role: "production",
    });
    return { designVersionId };
  }
}
