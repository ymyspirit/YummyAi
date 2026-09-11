import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE, CANVAS_WORKFLOW_TEMPLATES, ContinueCanvasWorkflowInputSchema, CreateCanvasBriefInputSchema, SubmitCanvasResultInputSchema, type CanvasBrief, type CanvasResultReceipt } from "@yummyai/contracts/pod/canvas-bridge";
import { assetFiles, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates, creativeDesignVersions, creativeDesignVersionAssets, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { assertAuthorizedAssets, PodBatchWorkflowService } from "./pod-batch-workflow.service.js";

@Injectable()
export class CanvasBridgeService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PodBatchWorkflowService) private readonly designs: PodBatchWorkflowService,
  ) {}

  async list(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, (tx) => tx.select({
      id: creativeDesignBatches.id, name: creativeDesignBatches.name, status: creativeDesignBatches.status,
      resultCount: creativeDesignBatches.generatedCount, createdAt: creativeDesignBatches.createdAt,
      approvedCount: creativeDesignBatches.approvedCount, workflow: creativeDesignBatches.canvasWorkflow,
    }).from(creativeDesignBatches).where(eq(creativeDesignBatches.executionMode, "infinite_canvas"))
      .orderBy(desc(creativeDesignBatches.createdAt)).limit(200));
  }

  async options(context: TenantContext) {
    authorize(context, Permission.DesignRead); authorize(context, Permission.AssetRead);
    const options = await this.designs.designOptions(context);
    return { referenceAssets: options.referenceAssets.filter((asset) => rasterMediaTypes.includes(asset.mediaType)) };
  }

  async create(context: TenantContext, raw: unknown): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead); authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    const parsed = CreateCanvasBriefInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("创作需求格式无效");
    const input = parsed.data;
    const requestChecksum = hash(JSON.stringify({ source: "infinite-canvas-brief-v1", requestId: input.requestId }));
    const batchId = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestChecksum}:canvas-brief`}, 0))`);
      const refs = input.referenceAssetIds.length ? await tx.select().from(assetFiles)
        .where(and(inArray(assetFiles.id, input.referenceAssetIds), isNull(assetFiles.deletedAt))) : [];
      assertAuthorizedAssets(input.referenceAssetIds, refs, "画布参考素材");
      if (refs.some((ref) => !rasterMediaTypes.includes(ref.mediaType) || ref.byteSize > CANVAS_BRIDGE.maxImageBytes)) {
        throw new BadRequestException("参考素材仅支持 20 MiB 以内的 PNG、JPG、WebP");
      }
      const [existing] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.requestChecksum, requestChecksum)).limit(1);
      if (existing) {
        const [item] = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, existing.id)).limit(1);
        if (!item || item.name !== input.name || item.prompt !== input.prompt || (item.negativePrompt ?? "") !== input.negativePrompt
          || JSON.stringify(item.referenceSnapshot.map((ref) => ref.assetId)) !== JSON.stringify(input.referenceAssetIds)
          || (existing.canvasWorkflow?.template.key ?? "freeform") !== input.templateKey) {
          throw new ConflictException("同一个请求编号不能用于不同的创作需求");
        }
        return existing.id;
      }
      const id = createEntityId();
      await tx.insert(creativeDesignBatches).values({
        id, tenantId: context.tenantId, name: input.name, executionMode: "infinite_canvas", status: "running",
        itemCount: 1, requestChecksum, createdBy: context.userId,
        canvasWorkflow: { template: CANVAS_WORKFLOW_TEMPLATES.find((template) => template.key === input.templateKey)!, rootBatchId: id, parentBatchId: null, stepIndex: 0, sourceVersionIds: [] },
      });
      await tx.insert(creativeDesignBatchItems).values({
        id: createEntityId(), tenantId: context.tenantId, batchId: id, ordinal: 0, rowKey: "canvas-brief",
        name: input.name, prompt: input.prompt, negativePrompt: input.negativePrompt || null,
        referenceSnapshot: input.referenceAssetIds.map((assetId) => {
          const asset = refs.find((ref) => ref.id === assetId)!;
          return { assetId, assetVersion: asset.version, checksumSha256: asset.checksumSha256 };
        }),
        candidateCount: 4, printSpecVersionIds: [], focalPoint: { xPermille: 500, yPermille: 500 }, status: "running",
      });
      return id;
    });
    await this.audit.record(context, { action: "canvas.brief.create", resourceType: "creative_design_batch", resourceId: batchId, result: "success" });
    return this.get(context, batchId);
  }

  async get(context: TenantContext, batchId: string): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead); authorize(context, Permission.AssetRead);
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.id, batchId), eq(creativeDesignBatches.executionMode, "infinite_canvas"))).limit(1);
      if (!batch) throw new NotFoundException("画布创作需求不存在");
      const [item] = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, batchId)).orderBy(asc(creativeDesignBatchItems.ordinal)).limit(1);
      if (!item) throw new NotFoundException("画布创作需求不存在");
      const refIds = item.referenceSnapshot.map((ref) => ref.assetId);
      const refs = refIds.length ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, refIds), isNull(assetFiles.deletedAt))) : [];
      assertAuthorizedAssets(refIds, refs, "画布参考素材");
      for (const pin of item.referenceSnapshot) {
        const asset = refs.find((ref) => ref.id === pin.assetId)!;
        if (asset.version !== pin.assetVersion || asset.checksumSha256 !== pin.checksumSha256) throw new ConflictException("参考素材已变更，请创建新的创作需求");
      }
      const [next] = await tx.select({ id: creativeDesignBatches.id }).from(creativeDesignBatches)
        .where(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`).limit(1);
      return {
        id: batch.id, itemId: item.id, name: item.name, prompt: item.prompt, negativePrompt: item.negativePrompt ?? "",
        status: batch.status, resultCount: batch.generatedCount,
        workflow: batch.canvasWorkflow, nextBriefId: next?.id ?? null,
        referenceAssets: refIds.map((id) => {
          const ref = refs.find((asset) => asset.id === id)!;
          return { id, fileName: ref.fileName, mediaType: ref.mediaType, version: ref.version, checksumSha256: ref.checksumSha256 };
        }),
      };
    });
  }

  async continueWorkflow(context: TenantContext, batchId: string, raw: unknown): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead); authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetRead);
    const parsed = ContinueCanvasWorkflowInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请选择已通过的方案并填写下一步说明");
    const input = parsed.data, selectedIds = [...input.versionIds].sort();
    const nextId = await withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select().from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.id, batchId), eq(creativeDesignBatches.executionMode, "infinite_canvas"))).for("update");
      if (!batch) throw new NotFoundException("创作任务不存在");
      const workflow = batch.canvasWorkflow;
      if (!workflow || workflow.stepIndex + 1 >= workflow.template.steps.length) throw new ConflictException("当前已是最后一步");
      if (batch.status === "cancelled") throw new ConflictException("已取消的任务不能继续");
      const [existing] = await tx.select().from(creativeDesignBatches)
        .where(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`);
      if (existing) {
        const [item] = await tx.select().from(creativeDesignBatchItems).where(eq(creativeDesignBatchItems.batchId, existing.id));
        if (JSON.stringify(existing.canvasWorkflow?.sourceVersionIds) !== JSON.stringify(selectedIds) || item?.prompt !== input.prompt) throw new ConflictException("下一步已创建，请打开已有任务");
        return existing.id;
      }
      const results = await tx.select({ version: creativeDesignVersions, assetId: creativeDesignCandidates.assetId,
        assetVersion: creativeDesignCandidates.assetVersion, checksumSha256: creativeDesignCandidates.checksumSha256,
      }).from(creativeDesignVersions)
        .innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
        .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
        .where(eq(creativeDesignBatchItems.batchId, batchId));
      if (!results.length || results.some((result) => !["approved", "rejected"].includes(result.version.status))) throw new ConflictException("请先完成当前所有方案的审核");
      const selected = selectedIds.map((id) => results.find((result) => result.version.id === id));
      if (selected.some((result) => !result || result.version.status !== "approved" || !result.assetId)) throw new ConflictException("只能继续当前步骤已通过的方案");
      const assetIds = selected.map((result) => result!.assetId!);
      const assets = await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, assetIds), isNull(assetFiles.deletedAt))).for("share");
      assertAuthorizedAssets(assetIds, assets, "已通过方案");
      for (const result of selected) {
        const asset = assets.find((entry) => entry.id === result!.assetId)!;
        if (asset.version !== result!.assetVersion || asset.checksumSha256 !== result!.checksumSha256) throw new ConflictException("已通过方案的原图已变更");
      }
      const id = createEntityId(), stepIndex = workflow.stepIndex + 1;
      const name = `${batch.name.slice(0, 130)} · ${workflow.template.steps[stepIndex]!.name}`;
      await tx.insert(creativeDesignBatches).values({ id, tenantId: context.tenantId, name, executionMode: "infinite_canvas", status: "running", itemCount: 1,
        requestChecksum: hash(`canvas-continue:${batchId}`), createdBy: context.userId,
        canvasWorkflow: { ...workflow, stepIndex, parentBatchId: batchId, sourceVersionIds: selectedIds },
      });
      await tx.insert(creativeDesignBatchItems).values({ id: createEntityId(), tenantId: context.tenantId, batchId: id, ordinal: 0, rowKey: "canvas-brief", name, prompt: input.prompt,
        referenceSnapshot: selected.map((result) => ({ assetId: result!.assetId!, assetVersion: result!.assetVersion!, checksumSha256: result!.checksumSha256! })),
        candidateCount: 4, printSpecVersionIds: [], focalPoint: { xPermille: 500, yPermille: 500 }, status: "running",
      });
      await this.audit.recordInTransaction(tx, context, { action: "canvas.workflow.continue", resourceType: "creative_design_batch", resourceId: id, result: "success", metadata: { parentBatchId: batchId, sourceVersionIds: selectedIds } });
      return id;
    });
    return this.get(context, nextId);
  }

  async readReference(context: TenantContext, batchId: string, assetId: string) {
    const brief = await this.get(context, batchId);
    const pin = brief.referenceAssets.find((asset) => asset.id === assetId);
    if (!pin) throw new NotFoundException("该素材不属于当前创作需求");
    const [asset] = await withTenant(this.database.db, context, (tx) => tx.select().from(assetFiles).where(and(eq(assetFiles.id, assetId), isNull(assetFiles.deletedAt))).limit(1));
    if (!asset) throw new NotFoundException("素材不存在");
    assertAuthorizedAssets([assetId], [asset], "画布参考素材");
    if (asset.version !== pin.version || asset.checksumSha256 !== pin.checksumSha256) throw new ConflictException("参考素材已变更，请创建新的创作需求");
    if (!rasterMediaTypes.includes(asset.mediaType) || asset.byteSize > CANVAS_BRIDGE.maxImageBytes) throw new BadRequestException("素材格式或大小不适合画布");
    const body = await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" });
    if (body.byteLength > CANVAS_BRIDGE.maxImageBytes) throw new PayloadTooLargeException("素材不能超过 20 MiB");
    if (hash(body) !== asset.checksumSha256) throw new ConflictException("素材校验失败");
    await this.audit.record(context, { action: "canvas.reference.read", resourceType: "asset_file", resourceId: assetId, result: "success", metadata: { batchId } });
    return { assetId, mediaType: asset.mediaType, contentBase64: Buffer.from(body).toString("base64") };
  }

  async submit(context: TenantContext, batchId: string, raw: unknown): Promise<CanvasResultReceipt> {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetWrite);
    const parsed = SubmitCanvasResultInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("图片、来源说明或画布版本无效");
    const input = parsed.data;
    const brief = await this.get(context, batchId);
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.byteLength > CANVAS_BRIDGE.maxImageBytes) throw new PayloadTooLargeException("结果图片不能超过 20 MiB");
    if (bytes.toString("base64") !== input.contentBase64) throw new BadRequestException("图片编码无效");
    const technical = await inspectImage(bytes);
    const contentHash = hash(bytes);
    const inputChecksum = hash(JSON.stringify({ ...input, contentBase64: contentHash }));
    const receipt = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${batchId}:canvas-submit`}, 0))`);
      const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).for("update");
      if (!batch || batch.executionMode !== "infinite_canvas") throw new NotFoundException("画布创作需求不存在");
      const candidates = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.itemId, brief.itemId));
      const existing = candidates.find((candidate) => candidate.parameterSnapshot.submissionId === input.submissionId);
      if (existing) {
        // Adapter-only upgrades preserve retry identity and the original immutable version/provenance.
        const originalChecksum = hash(JSON.stringify({ ...input, pluginVersion: existing.parameterSnapshot.pluginVersion, contentBase64: contentHash }));
        if (existing.inputChecksum !== inputChecksum && existing.inputChecksum !== originalChecksum) throw new ConflictException("同一个提交编号不能用于不同的图片或来源信息");
        const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.sourceCandidateId, existing.id)).limit(1);
        if (!version || !existing.assetId) throw new ConflictException("原提交尚未完整保存");
        return { batchId, candidateId: existing.id, versionId: version.id, assetId: existing.assetId, replayed: true };
      }
      if (batch.status === "cancelled") throw new ConflictException("创作需求已取消");
      const [next] = await tx.select({ id: creativeDesignBatches.id }).from(creativeDesignBatches).where(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`).limit(1);
      if (next) throw new ConflictException("此步骤已继续，请打开下一步提交新方案");
      if (candidates.length >= 4) throw new ConflictException("每个需求最多回传 4 个方案；继续迭代请创建新的需求");
      // Revalidate the pinned reference policy inside the same tenant transaction as the result write.
      const ids = brief.referenceAssets.map((asset) => asset.id);
      const refs = ids.length ? await tx.select().from(assetFiles).where(and(inArray(assetFiles.id, ids), isNull(assetFiles.deletedAt))).for("share") : [];
      assertAuthorizedAssets(ids, refs, "画布参考素材");
      if (refs.some((asset) => { const pin = brief.referenceAssets.find((ref) => ref.id === asset.id)!; return pin.version !== asset.version || pin.checksumSha256 !== asset.checksumSha256; })) throw new ConflictException("参考素材已变更");
      const fileName = `canvas-${batchId}-${input.submissionId}.${technical.extension}`;
      const stored = await this.storage.putPrivate(context, { body: bytes, domain: "authorized", fileName, mediaType: technical.mediaType });
      const assetId = createEntityId(), candidateId = createEntityId(), versionId = createEntityId();
      await tx.insert(assetFiles).values({
        id: assetId, tenantId: context.tenantId, ownerUserId: context.userId, objectKey: stored.objectKey,
        assetDomain: "authorized", fileName, mediaType: technical.mediaType, byteSize: bytes.byteLength,
        checksumSha256: contentHash, rightsStatus: "unverified", aiGenerated: input.sourceKind === "ai_generated",
        rightsMetadata: { source: { kind: input.sourceKind, reference: input.sourceReference }, attestedBy: context.userId, canvas: { batchId, submissionId: input.submissionId, sourceNodeId: input.sourceNodeId, upstreamVersion: input.upstreamVersion, pluginVersion: input.pluginVersion, protocolVersion: input.protocolVersion } },
      });
      const now = new Date();
      const qualitySnapshot = { ...technical, source: "infinite_canvas", requiresHumanReview: true, productionReady: false };
      await tx.insert(creativeDesignCandidates).values({
        id: candidateId, tenantId: context.tenantId, itemId: brief.itemId, ordinal: candidates.length, status: "selected",
        assetId, assetVersion: 1, checksumSha256: contentHash, inputChecksum, promptTemplateVersion: "infinite-canvas-bridge-v1",
        parameterSnapshot: { submissionId: input.submissionId, sourceNodeId: input.sourceNodeId, upstreamVersion: input.upstreamVersion, pluginVersion: input.pluginVersion, protocolVersion: input.protocolVersion },
        qualitySnapshot, completedAt: now,
      });
      await tx.insert(creativeDesignVersions).values({ id: versionId, tenantId: context.tenantId, familyId: createEntityId(), versionNumber: 1, sourceCandidateId: candidateId, name: input.title, status: "pending_review", createdBy: context.userId });
      await tx.insert(creativeDesignVersionAssets).values({ id: createEntityId(), tenantId: context.tenantId, creativeDesignVersionId: versionId, assetId, assetVersion: 1, role: "master", adaptationMode: "original", generatedRegions: [], qualitySnapshot });
      await tx.update(creativeDesignBatchItems).set({ status: "awaiting_review", updatedAt: now }).where(eq(creativeDesignBatchItems.id, brief.itemId));
      await tx.update(creativeDesignBatches).set({ generatedCount: candidates.length + 1, status: "awaiting_review", completedAt: null, updatedAt: now }).where(eq(creativeDesignBatches.id, batchId));
      return { batchId, candidateId, versionId, assetId, replayed: false };
    });
    await this.audit.record(context, { action: "canvas.result.submit", resourceType: "creative_design_version", resourceId: receipt.versionId, result: "success", metadata: { batchId, submissionId: input.submissionId, replayed: receipt.replayed } });
    return receipt;
  }
}

const rasterMediaTypes = ["image/png", "image/jpeg", "image/webp"];
function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
async function inspectImage(bytes: Buffer) {
  try {
    const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) throw new Error("Unsupported image");
    await image.stats();
    return { width: metadata.width, height: metadata.height, extension: metadata.format === "jpeg" ? "jpg" : metadata.format!, mediaType: `image/${metadata.format}` };
  } catch { throw new BadRequestException("图片必须是可完整解码的静态 PNG、JPG 或 WebP，且不超过 6400 万像素"); }
}
