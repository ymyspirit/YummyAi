import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CANVAS_BRIDGE,
  CANVAS_WORKFLOW_TEMPLATES,
  ContinueCanvasWorkflowInputSchema,
  CreateCanvasBriefInputSchema,
  ReviseCanvasBriefInputSchema,
  SubmitCanvasResultInputSchema,
  type CanvasBrief,
  type CanvasResultReceipt,
} from "@yummyai/contracts/pod/canvas-bridge";
import { StudioPinnedResultRequestSchema, type StudioPinnedResultRequest, type StudioResultLookup } from "@yummyai/contracts/pod/studio-original";
import {
  assetFiles,
  creativeDesignBatches,
  creativeDesignBatchItems,
  creativeDesignCandidates,
  creativeDesignVersions,
  creativeDesignVersionAssets,
  withTenant,
  assertVisualDeliveryCurrent,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { creativeRequirementsText } from "@yummyai/contracts/catalog/artwork";
import { researchSourceInstructions } from "@yummyai/contracts/research/creative";
import { resolveResearchSources } from "../research/research-study.service.js";
import { readSpecification } from "../catalog/development-data.js";
import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { assertAuthorizedAssets, PodBatchWorkflowService } from "./pod-batch-workflow.service.js";
import { copyStudioDrafts } from "./creative-studio-drafts.js";
import { currentDesignAuthority } from "./design-access.js";
import { creativeOwnerFilter, requireBatchAccess, requireBatchInputs, requireProductTargets, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { ProductionEditorScanner } from "./production-editor.service.js";
import { inspectStudioOriginalBytes } from "./studio-media-inspection.js";
import { assertStudioAssetPin, sameStudioAsset, sameStudioRequest, studioCanvasInput } from "./studio-media-inspection-owner.js";

type StudioSubmission = { request: StudioPinnedResultRequest; verify(tx: TenantTransaction): Promise<void> };

@Injectable()
export class CanvasBridgeService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(PodBatchWorkflowService) private readonly designs: PodBatchWorkflowService,
    @Inject(ProductionEditorScanner) private readonly scanner: ProductionEditorScanner,
  ) {}

  async list(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead]);
      return tx
        .select({
          id: creativeDesignBatches.id,
          name: creativeDesignBatches.name,
          status: creativeDesignBatches.status,
          resultCount: creativeDesignBatches.generatedCount,
          createdAt: creativeDesignBatches.createdAt,
          approvedCount: creativeDesignBatches.approvedCount,
          workflow: sql<typeof creativeDesignBatches.$inferSelect["canvasWorkflow"]>`${creativeDesignBatches.canvasWorkflow} - 'researchReferences'`,
        })
        .from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.executionMode, "infinite_canvas"), isNull(creativeDesignBatches.archivedAt), creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignBatches.createdBy)))
        .orderBy(desc(creativeDesignBatches.createdAt))
        .limit(200);
    });
  }

  async options(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    const options = await this.designs.designOptions(context);
    return {
      referenceAssets: options.referenceAssets.filter((asset) =>
        rasterMediaTypes.includes(asset.mediaType),
      ),
    };
  }

  async projectSummaries(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead]);
      return tx.select({
      id: creativeDesignBatches.id,
      name: creativeDesignBatches.name,
      stepIndex: sql<number | null>`(${creativeDesignBatches.canvasWorkflow}->>'stepIndex')::integer`,
    }).from(creativeDesignBatches).where(and(eq(creativeDesignBatches.executionMode, "infinite_canvas"), isNull(creativeDesignBatches.archivedAt), creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignBatches.createdBy)))
      .orderBy(desc(creativeDesignBatches.createdAt)).limit(200);
    });
  }

  async create(context: TenantContext, raw: unknown): Promise<CanvasBrief> {
    return this.saveBrief(context, raw);
  }

  async revise(context: TenantContext, batchId: string, raw: unknown): Promise<CanvasBrief> {
    authorize(context, Permission.DesignWrite);
    const parsed = ReviseCanvasBriefInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请检查项目名称、需求和定制配置");
    const source = await this.get(context, batchId);
    if (source.workflow?.visualDelivery)
      throw new ConflictException("此需求绑定商品套图交付，请从销售方案修改商品要求并重新准备套图任务");
    const { expectedRevision, changeNote, ...input } = parsed.data;
    return this.saveBrief(context, { ...input, templateKey: source.workflow?.template.key ?? "freeform" }, {
      sourceBriefId: batchId, rootId: source.workflow?.rootBatchId ?? batchId, expectedRevision, changeNote,
    });
  }

  private async saveBrief(context: TenantContext, raw: unknown, revision?: {
    sourceBriefId: string; rootId: string; expectedRevision: number; changeNote: string;
  }): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.AssetRead);
    const parsed = CreateCanvasBriefInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("创作需求格式无效");
    const input = parsed.data;
    if (input.visualDelivery) authorize(context, Permission.ProductRead);
    const requestChecksum = hash(
      JSON.stringify({ source: revision ? "infinite-canvas-revision-v2" : "infinite-canvas-brief-v2", applicant: context.userId, requestId: input.requestId }),
    );
    const legacyRequestChecksum = hash(JSON.stringify({ source: revision ? "infinite-canvas-revision-v1" : "infinite-canvas-brief-v1", requestId: input.requestId }));
    const batchId = await withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${requestChecksum}:canvas-brief`}, 0))`,
      );
      // All revisions of a project serialize on its root; immutable snapshots stay untouched.
      const [root] = revision ? await tx.select().from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.id, revision.rootId), eq(creativeDesignBatches.executionMode, "infinite_canvas"), isNull(creativeDesignBatches.archivedAt))).for("update") : [];
      const [source] = revision ? await tx.select().from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.id, revision.sourceBriefId), eq(creativeDesignBatches.executionMode, "infinite_canvas"), isNull(creativeDesignBatches.archivedAt))).for("update") : [];
      if (revision && (!root || !source || (source.canvasWorkflow?.rootBatchId ?? source.id) !== root.id))
        throw new NotFoundException("要修改的创意项目不存在或已归档");
      for (const parent of [root, source]) if (parent) {
        for (const permission of [Permission.DesignRead, Permission.DesignWrite]) authorize(authority, permission, { ownerId: parent.createdBy });
        if (parent.status === "cancelled") throw new ConflictException("已取消的项目不能修改");
      }
      if (source) await requireBatchInputs(tx, authority, source, checkedAt);
      const refs = input.referenceAssetIds.length
        ? await tx
            .select()
            .from(assetFiles)
            .where(
              and(inArray(assetFiles.id, input.referenceAssetIds), isNull(assetFiles.deletedAt)),
            )
        : [];
      assertAuthorizedAssets(input.referenceAssetIds, refs, "画布参考素材");
      requireReferenceAuthority(authority, refs, checkedAt);
      if (
        refs.some(
          (ref) =>
            !rasterMediaTypes.includes(ref.mediaType) || ref.byteSize > CANVAS_BRIDGE.maxImageBytes,
        )
      ) {
        throw new BadRequestException("参考素材仅支持 20 MiB 以内的 PNG、JPG、WebP");
      }
      await requireProductTargets(tx, authority, input.requirements?.specificationVersionIds ?? []);
      const [existing] = await tx
        .select()
        .from(creativeDesignBatches)
        .where(or(eq(creativeDesignBatches.requestChecksum, requestChecksum), and(eq(creativeDesignBatches.requestChecksum, legacyRequestChecksum), eq(creativeDesignBatches.createdBy, context.userId))))
        .orderBy(sql`case when ${creativeDesignBatches.requestChecksum} = ${requestChecksum} then 0 else 1 end`)
        .limit(1);
      if (existing) {
        for (const permission of [Permission.DesignRead, Permission.DesignWrite]) authorize(authority, permission, { ownerId: existing.createdBy });
        const [item] = await tx
          .select()
          .from(creativeDesignBatchItems)
          .where(eq(creativeDesignBatchItems.batchId, existing.id))
          .limit(1);
        if (
          !item ||
          item.name !== input.name ||
          item.prompt !== input.prompt ||
          (item.negativePrompt ?? "") !== input.negativePrompt ||
          JSON.stringify(item.referenceSnapshot.map((ref) => ref.assetId)) !==
            JSON.stringify(input.referenceAssetIds) ||
          (existing.canvasWorkflow?.template.key ?? "freeform") !== input.templateKey ||
          !isDeepStrictEqual(existing.canvasWorkflow?.requirements, input.requirements) ||
          existing.canvasWorkflow?.analysisScopeId !== input.analysisScopeId ||
          !isDeepStrictEqual(existing.canvasWorkflow?.visualDelivery, input.visualDelivery) ||
          (revision && (existing.canvasWorkflow?.revision?.sourceBriefId !== revision.sourceBriefId ||
            existing.canvasWorkflow.revision.number !== revision.expectedRevision + 1 ||
            existing.canvasWorkflow.revision.changeNote !== revision.changeNote)) ||
          input.researchSources.some((source) => {
            const pin = existing.canvasWorkflow?.researchReferences?.find((ref) => ref.researchItemId === source.researchItemId);
            return !pin || (source.snapshotId !== undefined && pin.snapshotId !== source.snapshotId) || (source.studyRevisionId !== undefined && pin.studyRevisionId !== source.studyRevisionId);
          })
        ) {
          throw new ConflictException("同一个请求编号不能用于不同的创作需求");
        }
        return existing.id;
      }
      if (revision) {
        const [current] = await tx.select({ number: sql<number>`coalesce(max(coalesce((${creativeDesignBatches.canvasWorkflow}->'revision'->>'number')::int, 1)), 1)::int` })
          .from(creativeDesignBatches).where(or(eq(creativeDesignBatches.id, revision.rootId), sql`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${revision.rootId}`));
        if (current!.number !== revision.expectedRevision)
          throw new ConflictException("项目已有其他人保存的新版本，请先查看最新需求，再核对并保存你的修改");
      }
      if (input.visualDelivery) {
        const pin = input.visualDelivery;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${pin.groupId}:visual-delivery`}, 0))`);
        const siblings = await tx.select().from(creativeDesignBatches).where(and(eq(creativeDesignBatches.createdBy, context.userId), sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'groupId' = ${pin.groupId}`));
        if (siblings.some(s => {
          const other = s.canvasWorkflow!.visualDelivery!;
          const { slotKey: otherSlot, ...otherPin } = other;
          const { slotKey, ...sharedPin } = pin;
          return otherSlot === slotKey || !isDeepStrictEqual(otherPin, sharedPin);
        })) throw new ConflictException("视觉交付编号已用于不同需求，请打开原任务或重新准备");
        try { await assertVisualDeliveryCurrent(tx, input.visualDelivery); }
        catch { throw new ConflictException("商品或规格已变化，请刷新后重新准备视觉交付"); }
        if (!input.referenceAssetIds.includes(input.visualDelivery.sampleAssetId)) throw new BadRequestException("视觉交付必须固定已核对的真实样品图");
        const sample = refs.find(a => a.id === pin.sampleAssetId);
        if (sample?.aiGenerated || !["image/png", "image/jpeg", "image/webp"].includes(sample?.mediaType ?? "") || !["owned", "licensed"].includes((sample?.rightsMetadata.source as { kind?: string } | undefined)?.kind ?? "")) throw new BadRequestException("真实样品图须使用授权实拍 PNG、JPEG 或 WebP 素材");
      }
      const id = createEntityId();
      const researchReferences = await resolveResearchSources(tx, authority, (input.requirements?.researchItemIds ?? []).map((researchItemId) => input.researchSources.find((source) => source.researchItemId === researchItemId) ?? { researchItemId }));
      await tx.insert(creativeDesignBatches).values({
        id,
        tenantId: context.tenantId,
        name: input.name,
        executionMode: "infinite_canvas",
        status: "running",
        itemCount: 1,
        requestChecksum,
        createdBy: context.userId,
        canvasWorkflow: {
          template: source?.canvasWorkflow?.template ?? CANVAS_WORKFLOW_TEMPLATES.find(
            (template) => template.key === input.templateKey,
          )!,
          rootBatchId: revision?.rootId ?? id,
          parentBatchId: null,
          stepIndex: source?.canvasWorkflow?.stepIndex ?? 0,
          sourceVersionIds: source?.canvasWorkflow?.sourceVersionIds ?? [],
          ...(revision ? { revision: { number: revision.expectedRevision + 1, sourceBriefId: revision.sourceBriefId, projectName: input.name, changeNote: revision.changeNote } } : {}),
          ...(input.requirements ? { requirements: input.requirements } : {}),
          researchReferences,
          ...(input.analysisScopeId ? { analysisScopeId: input.analysisScopeId } : {}),
          ...(input.visualDelivery ? { visualDelivery: input.visualDelivery } : {}),
        },
      });
      await tx.insert(creativeDesignBatchItems).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        batchId: id,
        ordinal: 0,
        rowKey: "canvas-brief",
        name: input.name,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt || null,
        referenceSnapshot: input.referenceAssetIds.map((assetId) => {
          const asset = refs.find((ref) => ref.id === assetId)!;
          return { assetId, assetVersion: asset.version, checksumSha256: asset.checksumSha256 };
        }),
        candidateCount: 4,
        printSpecVersionIds: [],
        focalPoint: { xPermille: 500, yPermille: 500 },
        status: "running",
      });
      if (revision) await copyStudioDrafts(tx, authority, revision.sourceBriefId, id);
      await this.audit.recordInTransaction(tx, context, {
        action: revision ? "canvas.brief.revise" : "canvas.brief.create",
        resourceType: "creative_design_batch", resourceId: id, result: "success",
        metadata: revision ? { rootId: revision.rootId, sourceBriefId: revision.sourceBriefId, revision: revision.expectedRevision + 1 } : {},
      });
      return id;
    });
    return this.get(context, batchId);
  }

  async get(context: TenantContext, batchId: string): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
    return withTenant(this.database.db, context, async (tx) => {
      const { authority } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead], { canvas: true });
      await requireBatchInputs(tx, authority, batch);
      const [item] = await tx
        .select()
        .from(creativeDesignBatchItems)
        .where(eq(creativeDesignBatchItems.batchId, batchId))
        .orderBy(asc(creativeDesignBatchItems.ordinal))
        .limit(1);
      if (!item) throw new NotFoundException("画布创作需求不存在");
      const refIds = item.referenceSnapshot.map((ref) => ref.assetId);
      const refs = refIds.length
        ? await tx
            .select()
            .from(assetFiles)
            .where(and(inArray(assetFiles.id, refIds), isNull(assetFiles.deletedAt)))
        : [];
      assertAuthorizedAssets(refIds, refs, "画布参考素材");
      requireReferenceAuthority(authority, refs);
      for (const pin of item.referenceSnapshot) {
        const asset = refs.find((ref) => ref.id === pin.assetId)!;
        if (asset.version !== pin.assetVersion || asset.checksumSha256 !== pin.checksumSha256)
          throw new ConflictException("参考素材已变更，请创建新的创作需求");
      }
      const [next] = await tx
        .select({ id: creativeDesignBatches.id })
        .from(creativeDesignBatches)
        .where(and(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`, creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignBatches.createdBy)))
        .limit(1);
      const requirements = batch.canvasWorkflow?.requirements;
      const rootId = batch.canvasWorkflow?.rootBatchId ?? batch.id;
      const history = await tx.select({ id: creativeDesignBatches.id, name: creativeDesignBatches.name,
        workflow: creativeDesignBatches.canvasWorkflow, createdAt: creativeDesignBatches.createdAt, archivedAt: creativeDesignBatches.archivedAt })
        .from(creativeDesignBatches).where(and(or(eq(creativeDesignBatches.id, rootId), sql`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${rootId}`), creativeOwnerFilter(authority, Permission.DesignRead, creativeDesignBatches.createdBy)));
      history.sort((a, b) => (b.workflow?.revision?.number ?? 1) - (a.workflow?.revision?.number ?? 1)
        || (b.workflow?.stepIndex ?? 0) - (a.workflow?.stepIndex ?? 0) || b.createdAt.getTime() - a.createdAt.getTime());
      const targets = requirements
        ? await Promise.all(
            requirements.specificationVersionIds.map((id) => readSpecification(tx, id)),
          )
        : [];
      return {
        id: batch.id,
        itemId: item.id,
        name: item.name,
        prompt: item.prompt,
        negativePrompt: item.negativePrompt ?? "",
        status: batch.status,
        resultCount: batch.generatedCount,
        workflow: batch.canvasWorkflow,
        nextBriefId: next?.id ?? null,
        projectRevision: history[0]?.workflow?.revision?.number ?? 1,
        latestBriefId: history.find(row => !row.archivedAt)?.id ?? batch.id,
        revisions: history.map(row => ({ id: row.id, number: row.workflow?.revision?.number ?? 1,
          name: row.name, changeNote: row.workflow?.revision?.changeNote ?? "",
          stepName: row.workflow?.template.steps[row.workflow.stepIndex]?.name ?? "创作与审核", createdAt: row.createdAt.toISOString(), archived: Boolean(row.archivedAt) })),
        ...(requirements
          ? {
              designInstructions: [
                item.prompt,
                creativeRequirementsText(requirements),
                researchSourceInstructions(batch.canvasWorkflow?.researchReferences ?? []),
                ...targets.map(
                  (s) =>
                    `计划适配：${s.spuCode} / ${s.name}；${s.facts.dimensions}；工艺 ${s.processName}`,
                ),
                item.negativePrompt ? `避免：${item.negativePrompt}` : "",
              ]
                .filter(Boolean)
                .join("\n\n"),
            }
          : {}),
        referenceAssets: refIds.map((id) => {
          const ref = refs.find((asset) => asset.id === id)!;
          return {
            id,
            fileName: ref.fileName,
            mediaType: ref.mediaType,
            version: ref.version,
            checksumSha256: ref.checksumSha256,
          };
        }),
      };
    });
  }

  async continueWorkflow(
    context: TenantContext,
    batchId: string,
    raw: unknown,
  ): Promise<CanvasBrief> {
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.AssetRead);
    const parsed = ContinueCanvasWorkflowInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请选择已通过的方案并填写下一步说明");
    const input = parsed.data,
      selectedIds = [...input.versionIds].sort();
    const nextId = await withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { canvas: true, mutation: true, lock: "update" });
      await requireBatchInputs(tx, authority, batch, checkedAt);
      const workflow = batch.canvasWorkflow;
      if (!workflow || workflow.stepIndex + 1 >= workflow.template.steps.length)
        throw new ConflictException("当前已是最后一步");
      if (batch.status === "cancelled") throw new ConflictException("已取消的任务不能继续");
      const [existing] = await tx
        .select()
        .from(creativeDesignBatches)
        .where(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`);
      if (existing) {
        for (const permission of [Permission.DesignRead, Permission.DesignWrite]) authorize(authority, permission, { ownerId: existing.createdBy });
        const [item] = await tx
          .select()
          .from(creativeDesignBatchItems)
          .where(eq(creativeDesignBatchItems.batchId, existing.id));
        if (
          JSON.stringify(existing.canvasWorkflow?.sourceVersionIds) !==
            JSON.stringify(selectedIds) ||
          item?.prompt !== input.prompt
        )
          throw new ConflictException("下一步已创建，请打开已有任务");
        return existing.id;
      }
      await assertCurrentBriefRevision(tx, batch);
      const results = await tx
        .select({
          version: creativeDesignVersions,
          assetId: creativeDesignCandidates.assetId,
          assetVersion: creativeDesignCandidates.assetVersion,
          checksumSha256: creativeDesignCandidates.checksumSha256,
        })
        .from(creativeDesignVersions)
        .innerJoin(
          creativeDesignCandidates,
          eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id),
        )
        .innerJoin(
          creativeDesignBatchItems,
          eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id),
        )
        .where(eq(creativeDesignBatchItems.batchId, batchId));
      if (
        !results.length ||
        results.some((result) => !["approved", "rejected"].includes(result.version.status))
      )
        throw new ConflictException("请先完成当前所有方案的审核");
      const selected = selectedIds.map((id) => results.find((result) => result.version.id === id));
      for (const result of selected) if (result) authorize(authority, Permission.DesignRead, { ownerId: result.version.createdBy });
      if (
        selected.some(
          (result) => !result || result.version.status !== "approved" || !result.assetId,
        )
      )
        throw new ConflictException("只能继续当前步骤已通过的方案");
      const assetIds = selected.map((result) => result!.assetId!);
      const assets = await tx
        .select()
        .from(assetFiles)
        .where(and(inArray(assetFiles.id, assetIds), isNull(assetFiles.deletedAt)))
        .for("share");
      assertAuthorizedAssets(assetIds, assets, "已通过方案");
      requireReferenceAuthority(authority, assets, checkedAt);
      for (const result of selected) {
        const asset = assets.find((entry) => entry.id === result!.assetId)!;
        if (
          asset.version !== result!.assetVersion ||
          asset.checksumSha256 !== result!.checksumSha256
        )
          throw new ConflictException("已通过方案的原图已变更");
      }
      const id = createEntityId(),
        stepIndex = workflow.stepIndex + 1;
      const name = `${batch.name.slice(0, 130)} · ${workflow.template.steps[stepIndex]!.name}`;
      await tx.insert(creativeDesignBatches).values({
        id,
        tenantId: context.tenantId,
        name,
        executionMode: "infinite_canvas",
        status: "running",
        itemCount: 1,
        requestChecksum: hash(`canvas-continue:${batchId}`),
        createdBy: context.userId,
        canvasWorkflow: {
          ...workflow,
          stepIndex,
          parentBatchId: batchId,
          sourceVersionIds: selectedIds,
        },
      });
      await tx.insert(creativeDesignBatchItems).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        batchId: id,
        ordinal: 0,
        rowKey: "canvas-brief",
        name,
        prompt: input.prompt,
        referenceSnapshot: selected.map((result) => ({
          assetId: result!.assetId!,
          assetVersion: result!.assetVersion!,
          checksumSha256: result!.checksumSha256!,
        })),
        candidateCount: 4,
        printSpecVersionIds: [],
        focalPoint: { xPermille: 500, yPermille: 500 },
        status: "running",
      });
      await this.audit.recordInTransaction(tx, context, {
        action: "canvas.workflow.continue",
        resourceType: "creative_design_batch",
        resourceId: id,
        result: "success",
        metadata: { parentBatchId: batchId, sourceVersionIds: selectedIds },
      });
      return id;
    });
    return this.get(context, nextId);
  }

  async readReference(context: TenantContext, batchId: string, assetId: string) {
    const brief = await this.get(context, batchId);
    const pin = brief.referenceAssets.find((asset) => asset.id === assetId);
    if (!pin) throw new NotFoundException("该素材不属于当前创作需求");
    const readAsset = () => withTenant(this.database.db, context, async (tx) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead], { canvas: true });
      await requireBatchInputs(tx, authority, batch);
      const [asset] = await tx
        .select()
        .from(assetFiles)
        .where(and(eq(assetFiles.id, assetId), isNull(assetFiles.deletedAt)))
        .limit(1).for("share");
      if (!asset) throw new NotFoundException("素材不存在");
      assertAuthorizedAssets([assetId], [asset], "画布参考素材");
      requireReferenceAuthority(authority, [asset], checkedAt);
      if (asset.version !== pin.version || asset.checksumSha256 !== pin.checksumSha256)
        throw new ConflictException("参考素材已变更，请创建新的创作需求");
      if (!rasterMediaTypes.includes(asset.mediaType) || asset.byteSize > CANVAS_BRIDGE.maxImageBytes)
        throw new BadRequestException("素材格式或大小不适合画布");
      return asset;
    });
    const asset = await readAsset();
    const body = await this.storage.readPrivate(
      context,
      { ...asset, assetDomain: "authorized" },
      { requiredDomain: "authorized" },
    );
    if (body.byteLength > CANVAS_BRIDGE.maxImageBytes)
      throw new PayloadTooLargeException("素材不能超过 20 MiB");
    if (hash(body) !== asset.checksumSha256) throw new ConflictException("素材校验失败");
    await this.audit.record(context, {
      action: "canvas.reference.read",
      resourceType: "asset_file",
      resourceId: assetId,
      result: "success",
      metadata: { batchId },
    });
    const current = await readAsset();
    if (current.objectKey !== asset.objectKey) throw new ConflictException("参考素材存储已变化");
    return {
      assetId,
      mediaType: asset.mediaType,
      contentBase64: Buffer.from(body).toString("base64"),
    };
  }

  async lookupStudioResult(context: TenantContext, request: StudioPinnedResultRequest): Promise<StudioResultLookup> {
    return withTenant(this.database.db, context, tx => this.lookupStudioResultInTransaction(tx, context, request));
  }

  /** Original owner lookup. This is a read and never repairs, scans, submits or
   * requires the caller's current editor key still to reference the old asset. */
  async lookupStudioResultInTransaction(tx: TenantTransaction, context: TenantContext, request: StudioPinnedResultRequest): Promise<StudioResultLookup> {
    const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.AssetRead]);
    const batch = await requireBatchAccess(tx, authority, request.scope, [Permission.DesignRead], { canvas: true });
    await requireBatchInputs(tx, authority, batch);
    const candidates = await tx.select({ candidate: creativeDesignCandidates }).from(creativeDesignCandidates)
      .innerJoin(creativeDesignBatchItems, eq(creativeDesignBatchItems.id, creativeDesignCandidates.itemId))
      .where(and(eq(creativeDesignBatchItems.batchId, request.scope),
        sql`${creativeDesignCandidates.parameterSnapshot}->>'submissionId' = ${request.submissionId}`)).limit(2).for("share", { of: creativeDesignCandidates });
    if (candidates.length > 1) throw new ConflictException("原提交编号对应多个结果 请核对历史记录");
    const candidate = candidates[0];
    if (!candidate) return { status: "missing" };
    const row = candidate.candidate, stored = StudioPinnedResultRequestSchema.safeParse(row.parameterSnapshot.studioOriginalRequest);
    if (!stored.success || !sameStudioRequest(stored.data, request)) throw new ConflictException("原提交编号对应的固定方案不同 请核对原请求");
    const [version] = await tx.select().from(creativeDesignVersions).where(eq(creativeDesignVersions.sourceCandidateId, row.id)).for("share");
    if (!version || !row.assetId) throw new ConflictException("原提交尚未完整保存");
    if (version.createdBy !== context.userId) throw new NotFoundException("原送审记录不存在");
    authorize(authority, Permission.DesignRead, { ownerId: version.createdBy });
    const [asset] = await tx.select().from(assetFiles).where(and(eq(assetFiles.id, row.assetId), eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))).for("share");
    if (!asset) throw new NotFoundException("原提交素材不存在");
    requireReferenceAuthority(authority, [asset], checkedAt);
    assertStudioAssetPin(asset, request.source);
    if (row.assetId !== request.source.assetId || row.assetVersion !== request.source.assetVersion || row.checksumSha256 !== request.source.checksumSha256)
      throw new ConflictException("原提交素材版本不同");
    const input = studioCanvasInput(request, request.source.checksumSha256);
    const originalChecksum = hash(JSON.stringify({ ...input, pluginVersion: row.parameterSnapshot.pluginVersion }));
    if (row.inputChecksum !== originalChecksum) throw new ConflictException("原提交输入校验不一致");
    return { status: "found", receipt: { batchId: request.scope, candidateId: row.id, versionId: version.id, assetId: row.assetId, replayed: true } };
  }

  async submit(
    context: TenantContext,
    batchId: string,
    raw: unknown,
    existingAssetId?: string,
    studio?: StudioSubmission,
  ): Promise<CanvasResultReceipt> {
    authorize(context, Permission.DesignWrite);
    authorize(context, Permission.AssetWrite);
    const parsed = SubmitCanvasResultInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("图片、来源说明或画布版本无效");
    const input = parsed.data;
    if (studio && (studio.request.scope !== batchId || studio.request.source.assetId !== existingAssetId)) throw new BadRequestException("固定方案与原项目或素材不匹配");
    const brief = await this.get(context, batchId);
    await withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.AssetWrite]);
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { canvas: true });
      await requireBatchInputs(tx, authority, batch, checkedAt);
    });
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.byteLength > CANVAS_BRIDGE.maxImageBytes)
      throw new PayloadTooLargeException("结果图片不能超过 20 MiB");
    if (bytes.toString("base64") !== input.contentBase64)
      throw new BadRequestException("图片编码无效");
    const contentHash = hash(bytes);
    const inputChecksum = hash(JSON.stringify({ ...input, contentBase64: contentHash }));
    const prepare = async (tx: TenantTransaction) => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.AssetWrite]);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${batchId}:canvas-submit`}, 0))`,
      );
      const batch = await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { canvas: true, lock: "update" });
      await requireBatchInputs(tx, authority, batch, checkedAt);
      const candidates = await tx
        .select()
        .from(creativeDesignCandidates)
        .where(eq(creativeDesignCandidates.itemId, brief.itemId));
      const existing = candidates.find(
        (candidate) => candidate.parameterSnapshot.submissionId === input.submissionId,
      );
      if (existing) {
        // Adapter-only upgrades preserve retry identity and the original immutable version/provenance.
        const originalChecksum = hash(
          JSON.stringify({
            ...input,
            pluginVersion: existing.parameterSnapshot.pluginVersion,
            contentBase64: contentHash,
          }),
        );
        if (existing.inputChecksum !== inputChecksum && existing.inputChecksum !== originalChecksum)
          throw new ConflictException("同一个提交编号不能用于不同的图片或来源信息");
        const [version] = await tx
          .select()
          .from(creativeDesignVersions)
          .where(eq(creativeDesignVersions.sourceCandidateId, existing.id))
          .limit(1);
        if (!version || !existing.assetId) throw new ConflictException("原提交尚未完整保存");
        if (studio) {
          const receipt = await this.lookupStudioResultInTransaction(tx, context, studio.request);
          if (receipt.status !== "found") throw new ConflictException("原固定方案回执不存在");
          return { kind: "replayed" as const, receipt: receipt.receipt };
        }
        authorize(authority, Permission.DesignRead, { ownerId: version.createdBy });
        const [file] = await tx.select().from(assetFiles).where(eq(assetFiles.id, existing.assetId)).for("share");
        if (!file || file.deletedAt || file.assetDomain !== "authorized") throw new NotFoundException("原提交素材不存在");
        requireReferenceAuthority(authority, [file], checkedAt);
        if (file.version !== existing.assetVersion || file.checksumSha256 !== existing.checksumSha256 || file.checksumSha256 !== contentHash)
          throw new ConflictException("原提交素材版本已变化");
        return {
          kind: "replayed" as const,
          receipt: { batchId, candidateId: existing.id, versionId: version.id, assetId: existing.assetId, replayed: true },
        };
      }
      if (batch.archivedAt || batch.status === "cancelled") throw new ConflictException("创作需求已归档或取消");
      await assertCurrentBriefRevision(tx, batch);
      const [next] = await tx
        .select({ id: creativeDesignBatches.id })
        .from(creativeDesignBatches)
        .where(sql`${creativeDesignBatches.canvasWorkflow}->>'parentBatchId' = ${batchId}`)
        .limit(1);
      if (next) throw new ConflictException("此步骤已继续，请打开下一步提交新方案");
      if (candidates.length >= 4)
        throw new ConflictException("每个需求最多回传 4 个方案；继续迭代请创建新的需求");
      if (studio) await studio.verify(tx);
      // Revalidate the pinned reference policy inside the same tenant transaction as the result write.
      const ids = brief.referenceAssets.map((asset) => asset.id);
      const refs = ids.length
        ? await tx
            .select()
            .from(assetFiles)
            .where(and(inArray(assetFiles.id, ids), isNull(assetFiles.deletedAt)))
            .for("share")
        : [];
      assertAuthorizedAssets(ids, refs, "画布参考素材");
      requireReferenceAuthority(authority, refs, checkedAt);
      if (
        refs.some((asset) => {
          const pin = brief.referenceAssets.find((ref) => ref.id === asset.id)!;
          return pin.version !== asset.version || pin.checksumSha256 !== asset.checksumSha256;
        })
      )
        throw new ConflictException("参考素材已变更");
      const [existingAsset] = existingAssetId
        ? await tx
            .select()
            .from(assetFiles)
            .where(
              and(
                eq(assetFiles.id, existingAssetId),
                eq(assetFiles.assetDomain, "authorized"),
                isNull(assetFiles.deletedAt),
              ),
            )
            .for("share")
        : [];
      const source = existingAsset?.rightsMetadata.source as { kind?: string } | undefined;
      if (existingAsset) requireReferenceAuthority(authority, [existingAsset], checkedAt);
      if (
        existingAssetId &&
        (!existingAsset ||
          existingAsset.checksumSha256 !== contentHash || existingAsset.byteSize !== bytes.byteLength ||
          source?.kind !== input.sourceKind ||
          existingAsset.rightsStatus === "rejected" || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? ""))
      )
        throw new BadRequestException("待审素材来源不匹配");
      if (studio && existingAsset) assertStudioAssetPin(existingAsset, studio.request.source);
      return { kind: "write" as const, existingAsset, candidates };
    };
    const prepared = await withTenant(this.database.db, context, prepare);
    let technical: Awaited<ReturnType<typeof inspectImage>> | undefined;
    if (prepared.kind === "write") {
      let scanClean = false;
      try { scanClean = (await this.scanner.scan(bytes, "canvas-result-original", prepared.existingAsset?.mediaType ?? imageMime(bytes))).result === "clean"; }
      catch { /* A scanner failure is not permission to commit the source. */ }
      // Even a failed scan must recheck the current owner before returning an
      // observable result. No project/membership lock is held across that I/O.
      await withTenant(this.database.db, context, prepare);
      if (!scanClean) throw new UnprocessableEntityException("方案原件未通过安全扫描");
      try { technical = await inspectImage(bytes); }
      finally { await withTenant(this.database.db, context, prepare); }
      if (prepared.existingAsset && prepared.existingAsset.mediaType !== technical.mediaType)
        throw new BadRequestException("方案原件与记录的媒体类型不一致");
    }
    const fileName = `canvas-${batchId}-${input.submissionId}.${technical?.extension ?? "bin"}`;
    // No storage latency holds a project or membership lock. A second owning
    // transaction revalidates all inputs before associating the immutable bytes.
    const stored = prepared.kind === "write" && !prepared.existingAsset
      ? await this.storage.putPrivate(context, { body: bytes, domain: "authorized", fileName, mediaType: technical!.mediaType })
      : null;
    const receipt = prepared.kind === "replayed" ? prepared.receipt : await withTenant(this.database.db, context, async tx => {
      const current = await prepare(tx);
      if (current.kind === "replayed") return current.receipt;
      const { existingAsset, candidates } = current;
      if (existingAsset && (!prepared.existingAsset || !sameStudioAsset(existingAsset, prepared.existingAsset)))
        throw new ConflictException("待审素材版本已变化");
      const assetId = existingAsset?.id ?? createEntityId(),
        candidateId = createEntityId(),
        versionId = createEntityId();
      const assetVersion = existingAsset?.version ?? 1;
      if (!existingAsset)
        await tx.insert(assetFiles).values({
          id: assetId,
          tenantId: context.tenantId,
          ownerUserId: context.userId,
          objectKey: stored!.objectKey,
          assetDomain: "authorized",
          fileName,
          mediaType: technical!.mediaType,
          byteSize: bytes.byteLength,
          checksumSha256: contentHash,
          rightsStatus: "unverified",
          aiGenerated: input.sourceKind === "ai_generated",
          rightsMetadata: {
            source: { kind: input.sourceKind, reference: input.sourceReference },
            attestedBy: context.userId,
            canvas: {
              batchId,
              submissionId: input.submissionId,
              sourceNodeId: input.sourceNodeId,
              upstreamVersion: input.upstreamVersion,
              pluginVersion: input.pluginVersion,
              protocolVersion: input.protocolVersion,
            },
          },
        });
      const now = new Date();
      const qualitySnapshot = {
        ...technical,
        source: "infinite_canvas",
        requiresHumanReview: true,
        productionReady: false,
      };
      await tx.insert(creativeDesignCandidates).values({
        id: candidateId,
        tenantId: context.tenantId,
        itemId: brief.itemId,
        ordinal: candidates.length,
        status: "selected",
        assetId,
        assetVersion,
        checksumSha256: contentHash,
        inputChecksum,
        promptTemplateVersion: "infinite-canvas-bridge-v1",
        parameterSnapshot: {
          submissionId: input.submissionId,
          sourceNodeId: input.sourceNodeId,
          upstreamVersion: input.upstreamVersion,
          pluginVersion: input.pluginVersion,
          protocolVersion: input.protocolVersion,
          ...(studio ? { studioOriginalRequest: studio.request } : {}),
        },
        qualitySnapshot,
        completedAt: now,
      });
      await tx.insert(creativeDesignVersions).values({
        id: versionId,
        tenantId: context.tenantId,
        familyId: createEntityId(),
        versionNumber: 1,
        sourceCandidateId: candidateId,
        name: input.title,
        status: "pending_review",
        createdBy: context.userId,
      });
      await tx.insert(creativeDesignVersionAssets).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        creativeDesignVersionId: versionId,
        assetId,
        assetVersion,
        role: "master",
        adaptationMode: "original",
        generatedRegions: [],
        qualitySnapshot,
      });
      await tx
        .update(creativeDesignBatchItems)
        .set({ status: "awaiting_review", updatedAt: now })
        .where(eq(creativeDesignBatchItems.id, brief.itemId));
      await tx
        .update(creativeDesignBatches)
        .set({
          generatedCount: candidates.length + 1,
          status: "awaiting_review",
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(creativeDesignBatches.id, batchId));
      return { batchId, candidateId, versionId, assetId, replayed: false };
    });
    await this.audit.record(context, {
      action: "canvas.result.submit",
      resourceType: "creative_design_version",
      resourceId: receipt.versionId,
      result: "success",
      metadata: { batchId, submissionId: input.submissionId, replayed: receipt.replayed },
    });
    await withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentDesignAuthority(tx, context, [Permission.DesignRead, Permission.DesignWrite, Permission.AssetRead, Permission.AssetWrite]);
      await requireBatchAccess(tx, authority, batchId, [Permission.DesignRead, Permission.DesignWrite], { canvas: true });
      const [asset] = await tx.select().from(assetFiles).where(eq(assetFiles.id, receipt.assetId)).for("share");
      if (!asset) throw new NotFoundException("创作素材不存在");
      requireReferenceAuthority(authority, [asset], checkedAt);
    });
    return receipt;
  }
}

const rasterMediaTypes = ["image/png", "image/jpeg", "image/webp"];
async function assertCurrentBriefRevision(tx: TenantTransaction, batch: typeof creativeDesignBatches.$inferSelect) {
  const rootId = batch.canvasWorkflow?.rootBatchId ?? batch.id;
  const [current] = await tx.select({ number: sql<number>`coalesce(max(coalesce((${creativeDesignBatches.canvasWorkflow}->'revision'->>'number')::int, 1)), 1)::int` })
    .from(creativeDesignBatches).where(or(eq(creativeDesignBatches.id, rootId), sql`${creativeDesignBatches.canvasWorkflow}->>'rootBatchId' = ${rootId}`));
  if (current!.number > (batch.canvasWorkflow?.revision?.number ?? 1))
    throw new ConflictException("需求已有新版本，请打开最新需求继续设计，历史方案与审核记录仍保留");
}
function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
async function inspectImage(bytes: Buffer) {
  const mediaType = imageMime(bytes), result = await inspectStudioOriginalBytes(bytes, mediaType);
  if (result.status !== "verified" || result.kind !== "image")
    throw new BadRequestException(
      "图片必须是可完整解码的静态 PNG、JPG 或 WebP，且不超过 6400 万像素",
    );
  return { ...result, width: result.displayWidth, height: result.displayHeight, mediaType,
    extension: mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp" };
}
function imageMime(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216) return "image/jpeg";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "application/octet-stream";
}
