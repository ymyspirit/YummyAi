import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { orderAssistChecks, type AssistContext } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import type { CreateAssist } from "@yummyai/contracts/ai/assist";
import { captureSnapshots, withTenant, type DatabaseConnection } from "@yummyai/database";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { resolveResearchSources } from "../research/research-study.service.js";
import { readSpecification } from "../catalog/development-data.js";
import { OrderWorkspaceService } from "../orders/order-workspace.service.js";
import { AmazonOrderReportService } from "../orders/amazon-order-report.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { AssistCatalogContextService } from "./assist-catalog-context.service.js";
import { AssistBusinessContextService } from "./assist-business-context.service.js";

@Injectable()
export class AssistContextService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(OrderWorkspaceService) private readonly orders: OrderWorkspaceService,
    @Inject(AmazonOrderReportService) private readonly reports: AmazonOrderReportService,
    @Inject(ProductionEditorService) private readonly editor: ProductionEditorService,
    @Inject(AssistCatalogContextService) private readonly catalog: AssistCatalogContextService,
    @Inject(AssistBusinessContextService) private readonly business: AssistBusinessContextService,
  ) {}

  async prepare(context: TenantContext, request: CreateAssist): Promise<AssistContext> {
    if ("expectedFingerprint" in request) return this.business.prepare(context, request);
    if (request.kind === "template_config" || request.kind === "sku_package")
      return this.catalog.prepare(context, request);
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
    if (request.kind === "creative") {
      authorize(context, Permission.DesignWrite);
      authorize(context, Permission.ResearchRead);
      const data = await withTenant(this.database.db, context, async (tx) => {
        const references = await resolveResearchSources(tx, context, request.sources);
        const snapshots = [];
        for (const source of references) {
          const [snapshot] = await tx
            .select()
            .from(captureSnapshots)
            .where(eq(captureSnapshots.id, source.snapshotId));
          if (!snapshot || snapshot.domain !== "research")
            throw new BadRequestException("请选择有效的研究快照");
          const textId = source.snapshotId;
          result.sources.push({
            id: textId,
            label: source.title,
            href: `/research?item=${source.researchItemId}`,
          });
          if (source.studyRevisionId)
            result.sources.push({
              id: source.studyRevisionId,
              label: `${source.title} · 研究结论 v${source.studyVersion}`,
              href: `/research?item=${source.researchItemId}`,
            });
          const media = snapshot.draft.media.filter((m) => m.kind === "image" && m.included);
          for (const [index, image] of media.slice(0, 2).entries()) {
            const sourceId = `${source.snapshotId}:image:${index}`;
            result.images.push({ sourceId, url: image.sourceUrl });
            result.sources.push({
              id: sourceId,
              label: `${source.title} · 图片 ${index + 1}`,
              href: `/research?item=${source.researchItemId}`,
            });
          }
          if (!media.length) result.diagnostics.push(`${source.title}：快照没有可分析的图片`);
          if (media.length > 2)
            result.diagnostics.push(`${source.title}：本次仅分析前 2 张图片，其余图片未发送`);
          snapshots.push({
            sourceId: textId,
            title: source.title,
            capturedAt: source.capturedAt,
            bullets: snapshot.draft.bullets.slice(0, 15),
            variants: snapshot.draft.variants.slice(0, 12),
            content: snapshot.draft.contentBlocks
              .filter((b) => b.kind !== "review")
              .slice(0, 8)
              .map((b) => ({ kind: b.kind, text: b.text.slice(0, 3000) })),
            study: source.content,
            studySourceId: source.studyRevisionId,
          });
        }
        const specifications = [];
        if (request.requirements.specificationVersionIds.length)
          authorize(context, Permission.ProductRead);
        for (const id of request.requirements.specificationVersionIds) {
          const spec = await readSpecification(tx, id);
          specifications.push({
            sourceId: id,
            name: spec.name,
            facts: spec.facts,
            attributes: spec.attributes,
          });
          result.sources.push({ id, label: spec.name, href: "/product-specifications" });
        }
        // Pin resolved versions; subsequent edits to research do not rewrite this input.
        result.request = {
          ...request,
          sources: references.map((s) => ({
            researchItemId: s.researchItemId,
            snapshotId: s.snapshotId,
            studyRevisionId: s.studyRevisionId,
          })),
        };
        return {
          kind: request.kind,
          research: snapshots,
          specifications,
          prompt: request.prompt,
          requirements: request.requirements,
        };
      });
      result.data = data;
    } else {
      authorize(context, Permission.OrderPiiRead);
      authorize(
        context,
        request.kind === "order_review" ? Permission.OrderWrite : Permission.DesignWrite,
      );
      const detail = await this.orders.detail(context, request.orderLineId);
      result.expiresAt = (
        await this.orders.analysisExpiresAt(context, request.orderLineId)
      ).toISOString();
      if (detail.line.sourceChanged)
        throw new ConflictException("导入资料已有新版本，请先核对并保存订单需求");
      if (
        detail.line.revision !== request.expectedRevision ||
        (request.kind === "order_review" &&
          (detail.report?.versionId ?? null) !== request.expectedSourceVersionId)
      )
        throw new ConflictException("订单资料已更新，请刷新后重新检查");
      result.checks = orderAssistChecks(detail);
      result.sources.push({
        id: "order",
        label: `订单资料 · 修订 ${detail.line.revision}`,
        href: `/orders?line=${request.orderLineId}`,
      });
      const artworks = [...(detail.catalog?.artworks ?? [])]
        .sort(
          (a, b) =>
            Number(b.id === detail.draft.artworkVersionId) -
            Number(a.id === detail.draft.artworkVersionId),
        )
        .slice(0, 50);
      const specifications = [...(detail.catalog?.specifications ?? [])]
        .sort(
          (a, b) =>
            Number(b.id === detail.draft.specificationVersionId) -
            Number(a.id === detail.draft.specificationVersionId),
        )
        .slice(0, 50);
      result.allowedArtworkIds = detail.draft.artworkVersionId
        ? artworks.filter((a) => a.id === detail.draft.artworkVersionId).map((a) => a.id)
        : artworks.map((a) => a.id);
      result.allowedSpecificationIds = detail.draft.specificationVersionId
        ? specifications
            .filter((s) => s.id === detail.draft.specificationVersionId)
            .map((s) => s.id)
        : specifications.map((s) => s.id);
      result.allowMatches =
        request.kind === "order_review" &&
        !["matched", "pinned"].includes(detail.catalog?.status ?? "") &&
        (!detail.draft.artworkVersionId || !detail.draft.specificationVersionId);
      result.sources.push(
        ...artworks.map((a) => ({
          id: a.id,
          label: `${a.code} · ${a.name} v${a.version}`,
          href: "/print-library",
        })),
        ...specifications.map((s) => ({
          id: s.id,
          label: `${s.spuCode} · ${s.name} v${s.version}`,
          href: `/product-specifications?spu=${s.spuId}`,
        })),
      );
      if (
        (detail.catalog?.artworks.length ?? 0) > 50 ||
        (detail.catalog?.specifications.length ?? 0) > 50
      )
        result.diagnostics.push(
          "候选库超过本次上限；本次仅对列表前 50 个印花、50 个规格提出建议，可在订单匹配区继续搜索",
        );
      result.data = {
        kind: request.kind,
        order: {
          sourceId: "order",
          sku: detail.line.skuCode,
          title: detail.line.title,
          quantity: detail.line.quantity,
          draft: {
            artworkVersionId: detail.draft.artworkVersionId,
            specificationVersionId: detail.draft.specificationVersionId,
            fields: detail.draft.fields,
            images: detail.draft.images.map((i) => ({ usage: i.usage })),
            instructions: detail.draft.instructions,
          },
        },
        catalog: {
          status: detail.catalog?.status,
          artworks: artworks.map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            version: a.version,
            mode: a.mode,
            customization: a.customization,
            layout: a.layout,
            instructions: a.instructions,
          })),
          specifications,
        },
        allowMatches: result.allowMatches,
      };
      for (const [index, image] of detail.draft.images.slice(0, 6).entries()) {
        const sourceId = `buyer-image:${index}`;
        try {
          const file =
            image.origin === "upload"
              ? await this.orders.image(context, request.orderLineId, image.key)
              : detail.report?.versionId && detail.line.reportLineId
                ? await this.reports.originalFromVersion(
                    context,
                    detail.line.reportLineId,
                    detail.report.versionId,
                    image.key,
                  )
                : null;
          if (!file) throw new Error("missing");
          result.images.push({ sourceId, dataUrl: await analysisImage(file.body) });
          result.sources.push({
            id: sourceId,
            label: `本单图片 ${index + 1} · ${image.usage}`,
            href: null,
          });
        } catch {
          result.diagnostics.push(`本单图片 ${index + 1} 无法读取，需人工检查`);
        }
      }
      if (detail.draft.images.length > 6)
        result.diagnostics.push("本单仅向模型发送前 6 张买家图片，其余图片需人工核对");
      if (request.kind === "artwork_preflight") {
        for (const material of (
          artworks.find((a) => a.id === detail.draft.artworkVersionId)?.materials ?? []
        )
          .filter(
            (m) =>
              ["master", "background", "decoration"].includes(m.role) &&
              ["image/png", "image/jpeg", "image/webp"].includes(m.mediaType),
          )
          .slice(0, 3)) {
          const sourceId = `artwork-material:${material.assetId}`;
          try {
            const file = await this.orders.artworkMaterial(
              context,
              request.orderLineId,
              material.assetId,
            );
            result.images.push({ sourceId, dataUrl: await analysisImage(file.body) });
            result.sources.push({
              id: sourceId,
              label: `本单印花素材 · ${material.usage}`,
              href: null,
            });
          } catch {
            result.diagnostics.push(`印花素材“${material.usage}”暂不可读取，需人工对照`);
          }
        }
        if (!detail.line.editorProjectId)
          throw new ConflictException("请先制作并保存该订单的生产稿");
        const preview = await this.editor.analysisPreview(
          context,
          detail.line.editorProjectId,
          request.expectedEditorVersionId,
        );
        result.checks.push(
          ...preview.preflight.issues.map((i) => ({
            code: i.code,
            severity: i.severity,
            message: i.message,
            location: i.layerId ?? null,
          })),
        );
        result.data.document = preview.document;
        result.sources.push({
          id: "document",
          label: `生产稿版本 ${request.expectedEditorVersionId}`,
          href: `/order-artwork?line=${request.orderLineId}`,
        });
        if (preview.preview) {
          result.images.push({
            sourceId: "production-preview",
            dataUrl: await analysisImage(preview.preview),
          });
          result.sources.push({ id: "production-preview", label: "本次生产稿预览", href: null });
        } else result.diagnostics.push("当前生产稿无法渲染，已保留规则检查；本次不能进行视觉预检");
        const texts = preview.document.layers.flatMap((l) =>
          l.kind === "text" && l.visible ? [l.text] : [],
        );
        for (const field of detail.draft.fields)
          if (field.value.trim() && !texts.some((t) => t.includes(field.value)))
            result.checks.push({
              code: "text_not_in_layers",
              severity: "manual",
              message: `“${field.label}”原文未在可见文字图层中找到，若已转为图片请人工对照`,
              location: field.key,
            });
      }
      result.data.allowedArtworkIds = result.allowedArtworkIds;
      result.data.allowedSpecificationIds = result.allowedSpecificationIds;
      // Recheck after private image reads to avoid combining two revisions.
      const current = await this.orders.detail(context, request.orderLineId);
      if (
        current.line.revision !== request.expectedRevision ||
        (current.report?.versionId ?? null) !== (detail.report?.versionId ?? null)
      )
        throw new ConflictException("读取期间订单资料发生变化，请重试");
    }
    if (JSON.stringify(result.data).length > 70000)
      throw new BadRequestException("所选资料过多，请减少研究来源或缩短需求后分析");
    return result;
  }

  async stale(
    context: TenantContext,
    input: CreateAssist,
    snapshot?: AssistContext,
  ): Promise<boolean> {
    if ("expectedFingerprint" in input) return this.business.stale(context, input);
    if (input.kind === "template_config" || input.kind === "sku_package")
      return !snapshot || this.catalog.stale(context, snapshot);
    if (input.kind === "creative") return false; // Creative selections are immutable pinned versions; draft changes are checked by the UI.
    try {
      const detail = await this.orders.detail(context, input.orderLineId);
      if (detail.line.revision !== input.expectedRevision || detail.line.sourceChanged) return true;
      if (input.kind === "order_review")
        return (detail.report?.versionId ?? null) !== input.expectedSourceVersionId;
      if (!detail.line.editorProjectId) return true;
      return (
        (await this.editor.get(context, detail.line.editorProjectId)).project.currentVersionId !==
        input.expectedEditorVersionId
      );
    } catch {
      return true;
    }
  }
  previewBusiness(context: TenantContext, input: unknown) {
    return this.business.preview(context, input);
  }
}
async function analysisImage(bytes: Uint8Array): Promise<string> {
  const body = await sharp(bytes, { limitInputPixels: 64_000_000 })
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${body.toString("base64")}`;
}
