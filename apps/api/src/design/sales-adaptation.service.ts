import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { SalesRecipeView } from "@yummyai/contracts/catalog/development";
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
import { eq } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import sharp from "sharp";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { ProductionEditorService } from "./production-editor.service.js";
import { assertAuthorizedAssets } from "./pod-batch-workflow.service.js";
import { readArtworkMaterials } from "../catalog/development-data.js";

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
    if (recipe.artwork.archived || !recipe.specification.facts.factsConfirmed)
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

  async start(context: TenantContext, recipe: SalesRecipeView) {
    const artworkAssetId = recipe.artwork.assetId;
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
      if (!profile || !asset || asset.deletedAt || asset.version !== recipe.artwork.assetVersion)
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
    return this.editor.createFromSalesRecipe(context, {
      skuId: recipe.skuId,
      recipeId: recipe.id,
      name: `${recipe.skuCode} · 制作 v${recipe.version}`,
      template,
      artwork: { name: `${recipe.artwork.code}.png`, bytes: png },
    });
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
    const file = render.files.find((f) => f.mediaType === "image/png");
    if (!file) throw new ConflictException("请以 PNG 生产格式出图，作为套图和生产共用的已审核文件");
    const output = await this.editor.renderFile(
      context,
      recipe.editorProjectId,
      renderId,
      file.key,
    );
    const stored = await this.storage.putPrivate(context, {
      body: output.body,
      domain: "authorized",
      fileName: `${recipe.skuCode}-v${recipe.version}-${renderId}.png`,
      mediaType: "image/png",
    });
    const [existing] = await tx
      .select()
      .from(assetFiles)
      .where(eq(assetFiles.objectKey, stored.objectKey));
    const assetId = existing?.id ?? createEntityId();
    if (existing) assertAuthorizedAssets([assetId], [existing], "制作成品");
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
        rightsStatus: "approved",
        rightsMetadata: {
          source: { kind: "original_design" },
          salesRecipeId: recipe.id,
          artworkVersionId: recipe.artwork.versionId,
          editorVersionId: versionId,
          renderId,
          reviewedBy: context.userId,
          reviewReason: reason,
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
      reviewedAt: new Date(),
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
