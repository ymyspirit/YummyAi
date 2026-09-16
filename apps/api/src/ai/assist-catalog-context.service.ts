import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { assistFingerprint, type AssistContext } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import sharp from "sharp";
import { PodPersonalizationService } from "../design/pod-personalization.service.js";
import { SalesPackageService } from "../catalog/sales-package.service.js";

@Injectable()
export class AssistCatalogContextService {
  constructor(
    @Inject(PodPersonalizationService) private readonly templates: PodPersonalizationService,
    @Inject(SalesPackageService) private readonly packages: SalesPackageService,
  ) {}

  async prepare(
    context: TenantContext,
    request: Extract<CreateAssist, { kind: "template_config" | "sku_package" }>,
  ): Promise<AssistContext> {
    const result: AssistContext = {
      request,
      data: {},
      sources: [],
      checks: [],
      diagnostics: [],
      images: [],
      allowedArtworkIds: [],
      allowedSpecificationIds: [],
      allowMatches: false,
    };
    if (request.kind === "template_config") {
      authorize(context, Permission.DesignWrite);
      const inspection = await this.templates.templateAnalysisBasis(context, request.inspectionId);
      if (inspection.status !== "completed" || !inspection.canvas)
        throw new ConflictException("请等待 PSD / PNG 图层解析完成后再使用配置助手");
      if (inspection.slots.length > 60)
        throw new BadRequestException("该模板超过 60 个槽位，请拆分模板或使用人工配置");
      result.templateSlotKeys = inspection.slots.map((s) => s.stableKey);
      result.sources = [
        { id: inspection.id, label: "模板源文件解析记录", href: "/pod-workbench" },
        ...inspection.slots.map((s) => ({
          id: s.stableKey,
          label: s.sourceLayerPath.join(" / "),
          href: null,
        })),
      ];
      result.data = {
        taskKind: request.kind,
        inspection,
        basisFingerprint: assistFingerprint(inspection),
      };
      result.diagnostics = ["本次分析使用解析出的图层结构；未进行 PSD 像素渲染检查。"];
      result.checks = inspection.warnings.map((w) => ({
        code: w.code,
        severity: "manual" as const,
        message: w.message,
        location: w.layerPath?.join(" / ") ?? null,
      }));
    } else {
      authorize(context, Permission.ListingWrite);
      const basis = await this.packages.analysisBasis(
        context,
        request.listingId,
        request.expectedVersionId,
      );
      result.listingPlatform = basis.listing.platform;
      result.listingMediaIds = basis.images.map((a) => a.id);
      result.sources.push({
        id: basis.version.id,
        label: `当前 Listing V${basis.version.versionNumber}`,
        href: `/listings/${request.listingId}`,
      });
      for (const recipe of basis.recipes) {
        result.sources.push(
          {
            id: recipe.id,
            label: `${recipe.skuCode} · 制作版本 V${recipe.version}`,
            href: `/product-development?sku=${recipe.skuId}`,
          },
          {
            id: recipe.specification.versionId,
            label: `${recipe.specification.spuCode} · ${recipe.specification.name} · V${recipe.specification.version}`,
            href: `/product-specifications?spu=${recipe.specification.spuId}`,
          },
          {
            id: recipe.artwork.versionId,
            label: `印花 ${recipe.artwork.code} · V${recipe.artwork.version}`,
            href: "/print-library",
          },
        );
      }
      result.sources = result.sources.filter((s, i, a) => a.findIndex((c) => c.id === s.id) === i);
      result.data = {
        taskKind: request.kind,
        platform: basis.listing.platform,
        targetLocale: basis.listing.locale,
        marketplaceId: basis.listing.marketplaceId,
        currentCopy: {
          title: basis.version.content.title,
          description: basis.version.content.description,
          bullets: basis.version.content.bullets,
          tags: basis.version.content.tags,
        },
        recipes: basis.recipes.map((r) => ({
          id: r.id,
          skuCode: r.skuCode,
          artwork: {
            id: r.artwork.id,
            versionId: r.artwork.versionId,
            code: r.artwork.code,
            name: r.artwork.name,
            mode: r.artwork.mode,
            customization: r.artwork.customization,
          },
          specification: r.specification,
        })),
        basisFingerprint: basis.fingerprint,
      };
      for (const asset of basis.images) {
        result.sources.push({ id: asset.id, label: `已审核套图 · ${asset.fileName}`, href: null });
        try {
          const bytes = await this.packages.analysisImage(context, asset);
          const image = await sharp(bytes, { limitInputPixels: 32_000_000 })
            .rotate()
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 85 })
            .toBuffer();
          result.images.push({
            sourceId: asset.id,
            dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
          });
        } catch {
          result.diagnostics.push(`套图 ${asset.fileName} 读取失败，本次不作视觉判断`);
          result.sources = result.sources.filter((s) => s.id !== asset.id);
        }
      }
      if (basis.images.length < basis.mediaCount)
        result.diagnostics.push(
          "部分媒体缺少当前 SKU 制作版本的已审核套图依据，本次未发送给模型；实物主图与信息图需人工核对。",
        );
      if (!result.images.length)
        result.diagnostics.push(
          "尚无可分析的已审核套图；只能根据确认的产品事实起草文案，图片说明保持为空。",
        );
      const current = await this.packages.analysisBasis(
        context,
        request.listingId,
        request.expectedVersionId,
      );
      if (current.fingerprint !== basis.fingerprint)
        throw new ConflictException("读取期间 SKU 或套图版本已变化，请刷新重试");
    }
    if (JSON.stringify(result.data).length > 70000)
      throw new BadRequestException("资料量过大，请减少规格或图层后分析");
    return result;
  }

  async stale(context: TenantContext, input: AssistContext) {
    try {
      if (input.request.kind === "template_config")
        return (
          assistFingerprint(
            await this.templates.templateAnalysisBasis(context, input.request.inspectionId),
          ) !== input.data.basisFingerprint
        );
      if (input.request.kind === "sku_package")
        return (
          (
            await this.packages.analysisBasis(
              context,
              input.request.listingId,
              input.request.expectedVersionId,
            )
          ).fingerprint !== input.data.basisFingerprint
        );
      return false;
    } catch {
      return true;
    }
  }
}
