import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type ProductionEditorDocument, type ProductionEditorImageView, type TenantContext } from "@yummyai/contracts";
import { CanvasProductionInputSchema, ReviewCanvasResultsInputSchema, type CanvasProductionTemplate, type CanvasResultView } from "@yummyai/contracts/pod/canvas-bridge";
import { assetFiles, canvasProductionHandoffs, creativeDesignBatchItems, creativeDesignBatches, creativeDesignCandidates, creativeDesignVersions, productionEditorProjects, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { assertAuthorizedAssets, PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { ProductionEditorService } from "./production-editor.service.js";

@Injectable()
export class CanvasWorkflowService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
    @Inject(PodBatchWorkflowService) private readonly designs: PodBatchWorkflowService,
    @Inject(ProductionEditorService) private readonly production: ProductionEditorService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async records(context: TenantContext, batchId: string) {
    await this.bridge.get(context, batchId);
    return withTenant(this.database.db, context, (tx) => tx.select({ version: creativeDesignVersions, candidate: creativeDesignCandidates, asset: assetFiles })
      .from(creativeDesignVersions).innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
      .innerJoin(assetFiles, eq(creativeDesignCandidates.assetId, assetFiles.id))
      .where(and(eq(creativeDesignBatchItems.batchId, batchId), isNull(assetFiles.deletedAt)))
      .orderBy(asc(creativeDesignCandidates.ordinal)));
  }

  async results(context: TenantContext, batchId: string): Promise<{ items: CanvasResultView[] }> {
    const records = await this.records(context, batchId);
    const links = await withTenant(this.database.db, context, (tx) => tx.select({ handoff: canvasProductionHandoffs })
      .from(canvasProductionHandoffs).innerJoin(productionEditorProjects, eq(canvasProductionHandoffs.projectId, productionEditorProjects.id))
      .where(and(eq(canvasProductionHandoffs.batchId, batchId), eq(productionEditorProjects.status, "active"))));
    return { items: records.map(({ version, candidate, asset }) => ({
      versionId: version.id, assetId: asset.id, name: version.name, status: version.status, rejectionReason: version.rejectionReason,
      width: typeof candidate.qualitySnapshot?.width === "number" ? candidate.qualitySnapshot.width : null,
      height: typeof candidate.qualitySnapshot?.height === "number" ? candidate.qualitySnapshot.height : null,
      previewPath: `/api/canvas-bridge/briefs/${batchId}/results/${version.id}/preview`,
      productionProjects: links.filter(({ handoff }) => handoff.creativeVersionId === version.id)
        .map(({ handoff }) => ({ id: handoff.projectId, name: `${version.name} · 生产稿`, templateName: handoff.templateName })),
    })) };
  }

  async preview(context: TenantContext, batchId: string, versionId: string) {
    const record = (await this.records(context, batchId)).find((entry) => entry.version.id === versionId);
    if (!record) throw new NotFoundException("方案不存在");
    const body = await this.readMaster(context, record);
    return sharp(body, { limitInputPixels: 64_000_000 }).rotate().resize({ width: 800, height: 800, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  }

  async review(context: TenantContext, batchId: string, raw: unknown) {
    authorize(context, Permission.DesignReview);
    const parsed = ReviewCanvasResultsInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请选择方案，退回时填写原因");
    const input = parsed.data, records = await this.records(context, batchId);
    if (input.versionIds.some((id) => !records.some((entry) => entry.version.id === id))) throw new NotFoundException("所选方案不属于当前步骤");
    // Review each immutable version through the existing policy service. Report partial outcomes explicitly.
    const outcomes: Array<{ versionId: string; ok: boolean; error?: string }> = [];
    for (const versionId of input.versionIds) {
      const version = records.find((entry) => entry.version.id === versionId)!.version;
      const target = input.decision === "approve" ? "approved" : "rejected";
      if (version.status === target && (target === "approved" || version.rejectionReason === input.rejectionReason)) {
        outcomes.push({ versionId, ok: true }); continue;
      }
      try {
        await this.designs.reviewCreativeVersion(context, versionId, { decision: input.decision, ...(input.decision === "reject" ? { rejectionReason: input.rejectionReason } : {}) });
        outcomes.push({ versionId, ok: true });
      } catch (cause) {
        if (!(cause instanceof ConflictException || cause instanceof NotFoundException)) throw cause;
        outcomes.push({ versionId, ok: false, error: "方案状态已变化，请刷新后核对" });
      }
    }
    return { outcomes };
  }

  async templates(context: TenantContext): Promise<{ items: CanvasProductionTemplate[] }> {
    authorize(context, Permission.DesignRead);
    const rows = await withTenant(this.database.db, context, (tx) => tx.select({ id: productionEditorProjects.id }).from(productionEditorProjects)
      .where(and(eq(productionEditorProjects.status, "active"), isNull(productionEditorProjects.sourceReportLineId), eq(productionEditorProjects.reviewedVersionId, productionEditorProjects.currentVersionId)))
      .orderBy(desc(productionEditorProjects.updatedAt)).limit(50));
    const items: CanvasProductionTemplate[] = [];
    for (const row of rows) {
      try {
        const detail = await this.production.get(context, row.id);
        if (!detail.project.source && detail.version.reviewed) items.push({ projectId: row.id, versionId: detail.version.id, versionNumber: detail.version.versionNumber, name: detail.project.name, productType: detail.project.productType });
      } catch (cause) { if (!(cause instanceof NotFoundException || cause instanceof ConflictException)) throw cause; }
    }
    return { items };
  }

  async handoff(context: TenantContext, batchId: string, raw: unknown) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    const parsed = CanvasProductionInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请选择已通过的方案与工艺底稿版本");
    const input = parsed.data;
    const brief = await this.bridge.get(context, batchId);
    if (brief.workflow && brief.workflow.stepIndex < brief.workflow.template.steps.length - 1) throw new ConflictException("请先完成创作流程的最后一步");
    const records = await this.records(context, batchId), record = records.find((entry) => entry.version.id === input.versionId);
    if (!record) throw new NotFoundException("方案不属于当前步骤");
    if (records.length !== brief.resultCount || records.some((entry) => !["approved", "rejected"].includes(entry.version.status))) throw new ConflictException("请先完成当前所有方案的审核");
    if (record.version.status !== "approved") throw new ConflictException("只有已通过的方案可以制作生产稿");
    assertAuthorizedAssets([record.asset.id], [record.asset], "生产图案");
    // A transaction lock serializes retries while the existing production service owns all project writes.
    // The created project is compensated on failure; its data key is erased by ProductionEditorService.
    let createdId: string | undefined;
    try {
      return await withTenant(this.database.db, context, async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${input.versionId}:${input.templateVersionId}:canvas-production`}, 0))`);
        const [existing] = await tx.select().from(canvasProductionHandoffs).where(and(eq(canvasProductionHandoffs.creativeVersionId, input.versionId), eq(canvasProductionHandoffs.templateVersionId, input.templateVersionId)));
        if (existing) {
          if (existing.templateProjectId !== input.templateProjectId) throw new ConflictException("工艺底稿版本不匹配");
          await this.production.get(context, existing.projectId);
          return { projectId: existing.projectId, replayed: true };
        }
        const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).for("update");
        if (!batch || batch.status === "cancelled") throw new ConflictException("任务已取消");
        const [templateRow] = await tx.select().from(productionEditorProjects).where(eq(productionEditorProjects.id, input.templateProjectId)).for("share");
        if (!templateRow || templateRow.sourceReportLineId) throw new NotFoundException("通用工艺底稿不存在");
        if (templateRow.status !== "active" || templateRow.reviewedVersionId !== input.templateVersionId || templateRow.currentVersionId !== input.templateVersionId) throw new ConflictException("工艺底稿已变更，请选择当前已审核版本");
        const template = await this.production.get(context, input.templateProjectId, input.templateVersionId);
        if (brief.workflow?.template.productType && brief.workflow.template.productType !== template.project.productType) throw new ConflictException("工艺底稿的产品类型与创作任务不匹配");
        const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.id, record.asset.id), isNull(assetFiles.deletedAt))).for("share");
        assertAuthorizedAssets([record.asset.id], asset ? [asset] : [], "生产图案");
        const bytes = await this.readMaster(context, { ...record, asset: asset! });
        // Copy geometry only. Fonts, existing customer artwork and old review confirmations are never inherited.
        const document: ProductionEditorDocument = { ...template.version.document, name: `${record.version.name.slice(0, 150)} · 生产稿`, layers: [],
          confirmations: { physicalSize: false, whiteBorderRule: false, narrowParts: false, barcodeTab: false, backText: false, visualReview: false } };
        const created = await this.production.create(context, { name: document.name, document });
        createdId = created.project.id;
        // Normalize WebP and EXIF orientation for the production editor's supported PNG input.
        const png = await sharp(bytes, { limitInputPixels: 64_000_000 }).rotate().png().toBuffer();
        const image = await this.production.upload(context, createdId, "approved-design.png", png) as ProductionEditorImageView;
        const width = document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.widthMm;
        const height = document.productType === "tire_cover" ? document.spec.diameterMm : document.spec.heightMm;
        const scale = Math.min(width / image.width, height / image.height);
        document.layers = [{ id: `image_${createEntityId()}`, kind: "image", name: record.version.name.slice(0, 160), assetId: image.id, assetVersion: image.version,
          widthMm: image.width * scale, heightMm: image.height * scale, xMm: (width - image.width * scale) / 2, yMm: (height - image.height * scale) / 2,
          rotationDeg: 0, opacity: 1, visible: true, locked: false, flipX: false, flipY: false }];
        await this.production.save(context, createdId, { expectedVersionId: created.version.id, document });
        await tx.insert(canvasProductionHandoffs).values({ id: createEntityId(), tenantId: context.tenantId, batchId, creativeVersionId: input.versionId, templateProjectId: input.templateProjectId,
          templateVersionId: input.templateVersionId, templateName: template.project.name, projectId: createdId, createdBy: context.userId });
        await this.audit.recordInTransaction(tx, context, { action: "canvas.production.handoff", resourceType: "production_editor_project", resourceId: createdId, result: "success", metadata: { batchId, creativeVersionId: input.versionId, templateVersionId: input.templateVersionId } });
        return { projectId: createdId, replayed: false };
      });
    } catch (cause) {
      if (createdId) {
        // A lost connection during COMMIT has an uncertain outcome. Verify before erasing a draft.
        let committed: typeof canvasProductionHandoffs.$inferSelect | undefined;
        try { [committed] = await withTenant(this.database.db, context, (tx) => tx.select().from(canvasProductionHandoffs).where(eq(canvasProductionHandoffs.projectId, createdId!))); }
        catch { throw cause; }
        if (committed) return { projectId: committed.projectId, replayed: true };
        await this.production.remove(context, createdId);
      }
      throw cause;
    }
  }

  private async readMaster(context: TenantContext, record: Awaited<ReturnType<CanvasWorkflowService["records"]>>[number]) {
    authorize(context, Permission.AssetRead);
    if (record.asset.assetDomain !== "authorized" || record.asset.version !== record.candidate.assetVersion || record.asset.checksumSha256 !== record.candidate.checksumSha256) throw new ConflictException("方案原图已变更");
    const body = await this.storage.readPrivate(context, { ...record.asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    if (createHash("sha256").update(body).digest("hex") !== record.asset.checksumSha256) throw new ConflictException("方案原图校验失败");
    return body;
  }
}
