import { specificationFactsReady } from "@yummyai/contracts/catalog/development";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  AdoptProductVisualsSchema,
  GenerateProductVisualSchema,
  PrepareProductVisualsSchema,
  ReviewProductVisualSchema,
  VISUAL_SLOTS,
  type ProductVisualProject,
  type ProductVisualWorkspace,
  type VisualDeliverySnapshot,
} from "@yummyai/contracts/catalog/product-visuals";
import {
  assetFiles,
  aiBudgetLedger,
  creativeDesignBatches,
  developmentEvents,
  modelRoutes,
  modelProviderConfigs,
  withTenant,
  visualDeliverySource,
  assertVisualDeliveryCurrent,
  assertVisualDeliveryReview,
  visualDeliveryModelFingerprint,
  type DatabaseConnection,
} from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { CanvasWorkflowService } from "../design/canvas-workflow.service.js";
import { StudioGenerationService } from "../design/studio-generation.service.js";
import { StudioGenerateRequestSchema } from "@yummyai/contracts/pod/creative-studio";
import { CreativeStudioService } from "../design/creative-studio.service.js";
import { assertAuthorizedAssets } from "../design/pod-batch-workflow.service.js";
import { AuditService } from "../audit/audit.service.js";
import { fingerprint } from "./development-data.js";
import { SalesPlanService } from "./sales-plan.service.js";

@Injectable()
export class ProductVisualsService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(SalesPlanService) private readonly plans: SalesPlanService,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
    @Inject(CanvasWorkflowService) private readonly workflow: CanvasWorkflowService,
    @Inject(StudioGenerationService) private readonly studio: StudioGenerationService,
    @Inject(CreativeStudioService) private readonly assets: CreativeStudioService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private access(context: TenantContext) {
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    authorize(context, Permission.AssetRead);
  }
  private async rows(context: TenantContext, planId: string, groupId?: string) {
    return withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(creativeDesignBatches)
        .where(
          and(
            eq(creativeDesignBatches.createdBy, context.userId),
            isNull(creativeDesignBatches.archivedAt),
            sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'salesPlanId' = ${planId}`,
            groupId
              ? sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'groupId' = ${groupId}`
              : undefined,
          ),
        )
        .orderBy(desc(creativeDesignBatches.createdAt))
        .limit(80),
    );
  }
  private async group(context: TenantContext, planId: string, groupId: string) {
    this.access(context);
    await this.plans.assistBasis(context, planId);
    const rows = await this.rows(context, planId, groupId);
    if (!rows.length) throw new NotFoundException("视觉交付不存在或当前账号不可读取");
    return rows;
  }
  private async current(context: TenantContext, pin: VisualDeliverySnapshot) {
    try {
      await withTenant(this.database.db, context, (tx) => assertVisualDeliveryCurrent(tx, pin));
    } catch {
      throw new ConflictException("商品、方案或规格已变化，请准备新的视觉交付；原结果保留在历史中");
    }
  }

  async get(context: TenantContext, planId: string): Promise<ProductVisualWorkspace> {
    const basis = await this.plans.assistBasis(context, planId);
    const blockers: string[] = [];
    if (!basis.specifications.length) blockers.push("请在销售方案选择抱枕规格");
    if (basis.specifications.some((s) => !specificationFactsReady(s.facts)))
      blockers.push("请先确认所选规格的商品事实");
    if (basis.specifications.some((s) => s.productType !== "shaped_pillow"))
      blockers.push("首轮视觉交付仅支持绑定已审核抱枕工艺的规格");
    const sourceSummary = basis.specifications.map(
      (s) =>
        `${s.name}：${s.facts.material}；${s.facts.dimensions}；${s.facts.packageContents}；工艺 ${s.processName || "未绑定"} / V${s.version}`,
    );
    const has = (p: Permission) => context.permissions.includes(p);
    const permissions = {
      create: has(Permission.DesignWrite) && has(Permission.AssetWrite),
      review: has(Permission.DesignReview),
      adopt: has(Permission.ProductWrite),
      sync:
        has(Permission.ProductWrite) && has(Permission.ListingRead) && has(Permission.ListingWrite),
    };
    if (!has(Permission.DesignRead) || !has(Permission.AssetRead))
      return {
        planId,
        revision: basis.plan.revision,
        blockers: [...blockers, "当前账号不能读取图稿与授权素材"],
        sourceSummary,
        references: [],
        models: [],
        projects: [],
        permissions: { create: false, review: false, adopt: false, sync: false },
      };
    const references = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ id: assetFiles.id, fileName: assetFiles.fileName })
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.assetDomain, "authorized"),
            eq(assetFiles.rightsStatus, "approved"),
            eq(assetFiles.aiGenerated, false),
            isNull(assetFiles.deletedAt),
            inArray(assetFiles.mediaType, ["image/png", "image/jpeg", "image/webp"]),
            sql`${assetFiles.rightsMetadata}->'source'->>'kind' in ('owned','licensed')`,
          ),
        )
        .orderBy(desc(assetFiles.createdAt))
        .limit(200),
    );
    const models = (await this.studio.models(context)).filter((m) => m.capability === "image");
    if (!references.length)
      blockers.push("暂无已审核的授权实拍素材，请先在素材库核对权利和样品来源");
    if (!models.length) blockers.push("请在模型配置启用图像模型后固定视觉需求");
    const rows = await this.rows(context, planId);
    const groupIds = [...new Set(rows.map((r) => r.canvasWorkflow!.visualDelivery!.groupId))];
    const events = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(developmentEvents)
        .where(
          and(
            eq(developmentEvents.resourceId, planId),
            eq(developmentEvents.action, "sales_plan.adopt_visuals"),
            eq(developmentEvents.createdBy, context.userId),
          ),
        )
        .orderBy(desc(developmentEvents.createdAt))
        .limit(100),
    );
    const projects: ProductVisualProject[] = [];
    for (const groupId of groupIds) {
      const group = rows.filter((r) => r.canvasWorkflow!.visualDelivery!.groupId === groupId),
        pin = group[0]!.canvasWorkflow!.visualDelivery!;
      let stale = false;
      try {
        await this.current(context, pin);
      } catch {
        stale = true;
      }
      const tasks: ProductVisualProject["tasks"] = [];
      for (const row of group) {
        const attempts = await this.studio.list(context, row.id);
        let results: Awaited<ReturnType<CanvasWorkflowService["results"]>> = { items: [] },
          unavailable = false;
        try {
          results = await this.workflow.results(context, row.id);
        } catch (cause) {
          if (!(
            cause instanceof BadRequestException ||
            cause instanceof ConflictException ||
            cause instanceof NotFoundException
          ))
            throw cause;
          stale = true;
          unavailable = true;
        }
        for (const attempt of attempts) {
          const result = results.items.find((r) => r.assetId === attempt.assetId) ?? null;
          const technicalIssues = result
            ? await this.inspect(
                context,
                result.assetId,
                row.canvasWorkflow!.visualDelivery!.slotKey === "artwork",
              )
            : unavailable
              ? ["参考素材或规格已不可用，原结果保留；请准备新的视觉需求"]
              : [];
          let controlledReview = false;
          if (result?.status === "approved")
            try {
              await withTenant(this.database.db, context, (tx) =>
                assertVisualDeliveryReview(tx, pin, result.versionId),
              );
              controlledReview = true;
            } catch {
              /* Explicit check completion remains visible in this workspace. */
            }
          tasks.push({
            id: attempt.id,
            projectId: row.id,
            slotKey: row.canvasWorkflow!.visualDelivery!.slotKey,
            status: attempt.status,
            model: attempt.model.model,
            createdAt: attempt.createdAt.toISOString(),
            error: attempt.error,
            result,
            controlledReview,
            technicalIssues,
          });
        }
      }
      const ledger = tasks.length
        ? await withTenant(this.database.db, context, (tx) =>
            tx
              .select()
              .from(aiBudgetLedger)
              .where(
                inArray(
                  aiBudgetLedger.requestId,
                  tasks.map((t) => t.id),
                ),
              ),
          )
        : [];
      const occupiedUsd = Number(
        ledger
          .filter((l) => l.state !== "released")
          .reduce((sum, l) => sum + Number(l.amountUsd), 0)
          .toFixed(6),
      );
      const adopted = events
        .map(
          (e) =>
            (e.result as { imagesAdoption?: { groupId: string; revision: number } }).imagesAdoption,
        )
        .find((a) => a?.groupId === groupId);
      projects.push({
        id: groupId,
        name: group[0]!.name.replace(/ · (图稿候选|场景图|细节图|定制说明图)$/, ""),
        snapshot: pin,
        stale,
        adoptedRevision: adopted?.revision ?? null,
        tasks,
        budget: {
          occupiedUsd,
          remainingUsd: Number(Math.max(0, pin.totalBudgetUsd - occupiedUsd).toFixed(6)),
          actualUsd: null,
        },
      });
    }
    return {
      planId,
      revision: basis.plan.revision,
      blockers,
      sourceSummary,
      references,
      models,
      projects,
      permissions,
    };
  }

  async prepare(context: TenantContext, planId: string, raw: unknown) {
    this.access(context);
    authorize(context, Permission.DesignWrite);
    const input = PrepareProductVisualsSchema.parse(raw),
      requestFingerprint = fingerprint(input);
    const replay = await this.rows(context, planId, input.requestId);
    if (
      replay.length &&
      replay.some(
        (r) => r.canvasWorkflow!.visualDelivery!.requestFingerprint !== requestFingerprint,
      )
    )
      throw new ConflictException("同一准备编号不能更换需求，请打开原交付");
    if (replay.length === 4) return { groupId: input.requestId, replayed: true };
    const basis = await this.plans.assistBasis(context, planId);
    if (basis.plan.revision !== input.expectedRevision)
      throw new ConflictException("方案已有新版本，请刷新后重新准备");
    if (
      !basis.specifications.length ||
      basis.specifications.some((s) => s.productType !== "shaped_pillow" || (replay.length ? !s.facts.factsConfirmed : !specificationFactsReady(s.facts)))
    )
      throw new ConflictException("请先选择商品事实已确认、工艺已绑定的异形抱枕规格");
    const source = await withTenant(this.database.db, context, (tx) =>
      visualDeliverySource(tx, planId),
    );
    const [route] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(modelRoutes)
        .where(
          and(
            eq(modelRoutes.id, input.modelId),
            eq(modelRoutes.taskType, "studio_image"),
            eq(modelRoutes.status, "enabled"),
          ),
        ),
    );
    if (!route || route.targets.length !== 1)
      throw new BadRequestException("请选择已配置的图像模型");
    const target = route.targets[0]!;
    const [provider] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(modelProviderConfigs)
        .where(
          and(
            eq(modelProviderConfigs.id, target.providerConfigId),
            eq(modelProviderConfigs.status, "enabled"),
          ),
        ),
    );
    if (!provider || !["openai", "openai-compatible"].includes(provider.provider))
      throw new ConflictException("请使用已启用的 OpenAI 兼容图像渠道");
    const facts = basis.specifications
      .map(
        (s) =>
          `${s.name} / ${s.facts.material} / ${s.facts.dimensions} / ${s.facts.packageContents} / 工艺 ${s.processName} V${s.version}`,
      )
      .join("\n");
    for (const slot of VISUAL_SLOTS) {
      await this.bridge.create(context, {
        requestId: childRequest(input.requestId, slot.key),
        name: `${basis.plan.fields.name.slice(0, 130)} · ${slot.label}`,
        templateKey: "freeform",
        prompt: `${slot.instructions}\n\n人工确认的设计方向：${input.direction}\n\n已确认商品事实：\n${facts}\n\n样品依据：${input.sampleAttestation}\n目标语言：${basis.plan.fields.locale}\n定制字段：${basis.plan.fields.customization.fields.map((f) => f.label).join("、") || "尚未配置，不得添加选项"}`,
        referenceAssetIds: [input.sampleAssetId, ...input.referenceAssetIds],
        requirements: {
          mode: "customer_image",
          specificationVersionIds: basis.specifications.map((s) => s.versionId),
          acceptance: "商品视觉方案逐张人工审核；生产文件须另走原工厂规格与审核流程。",
        },
        visualDelivery: {
          version: 1,
          productType: "shaped_pillow",
          groupId: input.requestId,
          slotKey: slot.key,
          requestFingerprint,
          salesPlanId: planId,
          salesPlanRevision: basis.plan.revision,
          sourceFingerprint: source.fingerprint,
          sampleAssetId: input.sampleAssetId,
          sampleAttestation: input.sampleAttestation,
          modelId: input.modelId,
          providerConfigId: target.providerConfigId,
          providerModel: target.providerModel,
          providerFingerprint: visualDeliveryModelFingerprint(provider, target),
          size: input.size,
          callCeilingUsd: input.callCeilingUsd,
          totalBudgetUsd: input.totalBudgetUsd,
        },
      });
    }
    return { groupId: input.requestId, replayed: false };
  }
  async generate(context: TenantContext, planId: string, groupId: string, raw: unknown) {
    const input = GenerateProductVisualSchema.parse(raw),
      rows = await this.group(context, planId, groupId);
    const project = rows.find((r) => r.canvasWorkflow!.visualDelivery!.slotKey === input.slotKey);
    if (!project) throw new ConflictException("图片步骤尚未准备完成，请重新读取交付");
    const original = await this.studio.originalInput(context, project.id, input.requestId);
    let selectionRevision: string;
    if (original) {
      const retained = StudioGenerateRequestSchema.safeParse(original);
      if (!retained.success || retained.data.capability !== "image") throw new ConflictException("原任务未固定图片模型选择版本，请查看原任务，不要重新提交");
      selectionRevision = retained.data.selectionRevision;
    } else {
      const selected = (await this.studio.models(context)).find(model => model.id === input.modelId && model.capability === "image");
      if (!selected) throw new ConflictException("所选图片模型不可用，请重新读取视觉交付");
      selectionRevision = selected.selectionRevision;
    }
    // Replay retains the original references. The original owner compares the
    // complete input before it may dispatch; an unknown outcome never reattaches.
    const referenceKeys = original ? [...original.referenceKeys] : [];
    if (!original && input.slotKey !== "artwork") {
      const artwork = rows.find((r) => r.canvasWorkflow!.visualDelivery!.slotKey === "artwork");
      const result = artwork
        ? (await this.workflow.results(context, artwork.id)).items.find(
            (r) => r.versionId === input.artworkVersionId && r.status === "approved",
          )
        : undefined;
      if (!result || (await this.inspect(context, result.assetId, true)).length)
        throw new ConflictException("请先选择本交付中技术检查与人工审核通过的图稿");
      try {
        await withTenant(this.database.db, context, (tx) =>
          assertVisualDeliveryReview(tx, project.canvasWorkflow!.visualDelivery!, result.versionId),
        );
      } catch {
        throw new ConflictException("请在视觉交付中完成主体、轮廓、事实和单双面核对");
      }
      await this.assets.invoke(context, {
        operation: "reference.attach",
        scope: project.id,
        assetId: result.assetId,
      });
      referenceKeys.push(`image:asset-${result.assetId}`);
    }
    return this.studio.create(context, project.id, {
      requestId: input.requestId,
      modelId: input.modelId,
      capability: "image",
      selectionRevision,
      visualSlotKey: input.slotKey,
      ...(input.artworkVersionId ? { visualArtworkVersionId: input.artworkVersionId } : {}),
      prompt: input.prompt || "按本步骤固定需求生成一张可审核候选。",
      referenceKeys,
      size: input.size,
      quality: input.quality,
      background: input.slotKey === "artwork" ? "transparent" : "opaque",
      seconds: 4,
    });
  }
  async collect(context: TenantContext, planId: string, groupId: string) {
    const rows = await this.group(context, planId, groupId);
    authorize(context, Permission.DesignWrite);
    for (const row of rows) {
      const results = (await this.workflow.results(context, row.id)).items;
      for (const task of await this.studio.list(context, row.id))
        if (
          task.status === "completed" &&
          task.assetId &&
          !results.some((r) => r.assetId === task.assetId)
        )
          await this.studio.get(context, row.id, task.id);
    }
    return { ok: true };
  }
  async review(context: TenantContext, planId: string, groupId: string, raw: unknown) {
    authorize(context, Permission.DesignReview);
    const input = ReviewProductVisualSchema.parse(raw),
      rows = await this.group(context, planId, groupId);
    for (const row of rows) {
      const result = (await this.workflow.results(context, row.id)).items.find(
        (r) => r.versionId === input.versionId,
      );
      if (!result) continue;
      if (input.decision === "approve") {
        await this.current(context, row.canvasWorkflow!.visualDelivery!);
        const issues = await this.inspect(
          context,
          result.assetId,
          row.canvasWorkflow!.visualDelivery!.slotKey === "artwork",
        );
        if (issues.length) throw new ConflictException(issues.join("；"));
      }
      const outcome = await this.workflow.review(context, row.id, {
        versionIds: [input.versionId],
        decision: input.decision,
        ...(input.decision === "reject" ? { rejectionReason: input.reason } : {}),
      });
      if (outcome.outcomes.some((o) => !o.ok))
        throw new ConflictException("版本状态已变化，请刷新后核对");
      await this.audit.record(context, {
        action: "product_visual.review",
        resourceType: "creative_design_version",
        resourceId: input.versionId,
        result: "success",
        metadata: {
          groupId,
          sourceFingerprint: row.canvasWorkflow!.visualDelivery!.sourceFingerprint,
          decision: input.decision,
          checks: input.checks,
        },
      });
      return { ok: true };
    }
    throw new NotFoundException("该方案不属于当前交付");
  }
  async adopt(context: TenantContext, planId: string, groupId: string, raw: unknown) {
    const input = AdoptProductVisualsSchema.parse(raw);
    return this.plans.adoptVisuals(context, planId, groupId, input, async () => {
      const rows = await this.group(context, planId, groupId),
        pin = rows[0]!.canvasWorkflow!.visualDelivery!;
      await this.current(context, pin);
      const selected: Array<{ assetId: string; slotKey: string; artworkVersionId: string }> = [];
      const approvedArtwork = new Set<string>();
      for (const row of rows)
        for (const result of (await this.workflow.results(context, row.id)).items) {
          const slotKey = row.canvasWorkflow!.visualDelivery!.slotKey;
          if (
            slotKey === "artwork" &&
            result.status === "approved" &&
            !(await this.inspect(context, result.assetId, true)).length
          )
            approvedArtwork.add(result.versionId);
          if (input.versionIds.includes(result.versionId)) {
            if (slotKey === "artwork" || result.status !== "approved")
              throw new ConflictException("套图配图只采纳已审核的场景、细节和定制说明版本");
            if ((await this.inspect(context, result.assetId, false)).length)
              throw new ConflictException("所选图片技术检查未通过");
            try {
              await withTenant(this.database.db, context, (tx) =>
                assertVisualDeliveryReview(tx, pin, result.versionId),
              );
            } catch {
              throw new ConflictException("请在视觉交付中逐张完成主体、轮廓、事实和单双面核对");
            }
            const attempt = (await this.studio.list(context, row.id)).find(
              (t) => t.assetId === result.assetId,
            );
            if (!attempt?.input.visualArtworkVersionId)
              throw new ConflictException("所选套图没有固定的图稿来源，请重新制作");
            selected.push({
              assetId: result.assetId,
              slotKey,
              artworkVersionId: attempt.input.visualArtworkVersionId,
            });
          }
        }
      if (selected.length !== 3 || new Set(selected.map((s) => s.slotKey)).size !== 3)
        throw new ConflictException("请先审核图稿，并明确选择三个必需套图槽位的已审核版本");
      if (new Set(selected.map((s) => s.artworkVersionId)).size !== 1)
        throw new ConflictException("三个套图槽位须使用同一已审核图稿，请核对所选版本");
      if (!approvedArtwork.has(selected[0]!.artworkVersionId))
        throw new ConflictException("套图使用的图稿版本已不可用，请重新核对图稿与套图");
      try {
        await withTenant(this.database.db, context, (tx) =>
          assertVisualDeliveryReview(tx, pin, selected[0]!.artworkVersionId),
        );
      } catch {
        throw new ConflictException("所选图稿未完成视觉交付核对");
      }
      selected.sort(
        (a, b) =>
          VISUAL_SLOTS.findIndex((s) => s.key === a.slotKey) -
          VISUAL_SLOTS.findIndex((s) => s.key === b.slotKey),
      );
      const assetIds = selected.map((s) => s.assetId),
        validateIds = [...assetIds, pin.sampleAssetId];
      const assets = await withTenant(this.database.db, context, (tx) =>
        tx
          .select()
          .from(assetFiles)
          .where(and(inArray(assetFiles.id, validateIds), isNull(assetFiles.deletedAt))),
      );
      assertAuthorizedAssets(validateIds, assets, "已审核抱枕视觉交付");
      return {
        assetIds,
        sampleAssetId: input.useSampleAsMain ? pin.sampleAssetId : null,
        projectId: rows.find((r) => r.canvasWorkflow!.visualDelivery!.slotKey === "artwork")!.id,
      };
    });
  }
  private async inspect(context: TenantContext, assetId: string, artwork: boolean) {
    const [asset] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(assetFiles)
        .where(
          and(
            eq(assetFiles.id, assetId),
            eq(assetFiles.assetDomain, "authorized"),
            isNull(assetFiles.deletedAt),
          ),
        ),
    );
    if (!asset) return ["结果素材已不可用"];
    try {
      const bytes = await this.storage.readPrivate(
        context,
        { ...asset, assetDomain: "authorized" },
        { requiredDomain: "authorized" },
      );
      if (createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256)
        return ["结果文件校验值已变化，请重新核对素材"];
      const image = sharp(bytes, { limitInputPixels: 64_000_000, failOn: "error" });
      const meta = await image.metadata();
      const issues: string[] = [];
      if (!meta.width || !meta.height || Math.min(meta.width, meta.height) < 1024)
        issues.push("实际图片短边不足 1024 px，请重新制作；不通过改 DPI 标签提升");
      if (artwork) {
        const stats = await image.stats();
        if (!meta.hasAlpha || stats.isOpaque) issues.push("图稿候选缺少真实透明背景，请重新制作");
        else if (!stats.channels.at(-1)?.max) issues.push("图稿候选没有可见主体，请重新制作");
      }
      return issues;
    } catch {
      return ["无法完整读取实际图片，请核对原结果"];
    }
  }
}
function childRequest(groupId: string, key: string) {
  const hex = fingerprint({ groupId, key });
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
