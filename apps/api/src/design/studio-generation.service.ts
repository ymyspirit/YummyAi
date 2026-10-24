import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { createHash } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioGenerateRequestSchema, StudioModelInputSchema, type StudioGenerate } from "@yummyai/contracts/pod/creative-studio";
import type { StudioModel } from "@yummyai/contracts/pod/studio-personal";
import { assetFiles, creativeStudioEntries, creativeStudioGenerations, creativeDesignBatches, aiBudgetLedger, aiBudgetPolicies, assertVisualDeliveryCurrent, visualDeliveryArtwork, visualDeliveryModelFingerprint, modelPreferences, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, isNull, gte, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { modelConfigurationRevision } from "../ai/model-configuration-revision.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { currentDesignAuthority } from "./design-access.js";
import { currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";
import { stageCreativeExecution } from "@yummyai/pod-core";

export abstract class StudioGenerationEnqueuer { abstract enqueue(input: { id: string; tenantId: string; userId: string }): Promise<void>; }
@Injectable()
export class StudioGenerationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(StudioGenerationEnqueuer) private readonly queue: StudioGenerationEnqueuer,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
  ) {}
  async models(context: TenantContext): Promise<StudioModel[]> {
    return withTenant(this.database.db, context, async tx => {
      await currentDesignAuthority(tx, context, [Permission.DesignRead]);
      // The revision covers every related route, not only the displayed model.
      // This read projection deliberately never selects the channel credential.
      const rows = await tx.select().from(modelRoutes).orderBy(modelRoutes.id);
      const providers = await tx.select({ id: modelProviderConfigs.id, label: modelProviderConfigs.label, provider: modelProviderConfigs.provider, updatedAt: modelProviderConfigs.updatedAt }).from(modelProviderConfigs).where(eq(modelProviderConfigs.status, "enabled"));
      const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
      const revisions = new Map(providers.map(provider => [provider.id, modelConfigurationRevision(provider, rows)]));
      const result: StudioModel[] = [];
      for (const row of rows) {
        if (row.status !== "enabled" || row.targets.length !== 1) continue;
        const capability = row.taskType === "studio_image" ? "image" : row.taskType === "studio_video" ? "video" : row.taskType === "studio_text" ? "text" : undefined;
        if (!capability) continue;
        const provider = providers.find(p => p.id === row.targets[0]!.providerConfigId.toLowerCase() && ["openai", "openai-compatible"].includes(p.provider));
        if (!provider) continue;
        result.push({ id: row.id, label: row.modelKey, model: row.targets[0]!.providerModel, capability, providerLabel: provider.label,
          isDefault: preferences?.defaults[capability]?.toLowerCase() === row.id, selectionRevision: revisions.get(provider.id)! });
      }
      return result;
    // The current membership gate takes FOR SHARE. This projection has no
    // writes, but PostgreSQL must allow those original authority row locks.
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
  }
  async addModel(context: TenantContext, raw: unknown) {
    authorize(context, Permission.ModelConfigure);
    const parsed = StudioModelInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请填写渠道、模型名称和用途");
    const input = parsed.data;
    return withTenant(this.database.db, context, async tx => {
      await currentDesignAuthority(tx, context, [Permission.ModelConfigure]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, input.providerConfigId));
      if (!provider || provider.status === "deleted" || !["openai", "openai-compatible"].includes(provider.provider)) throw new BadRequestException("创作模型需要 OpenAI 兼容渠道");
      const [row] = await tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: context.tenantId, modelKey: input.label, taskType: `studio_${input.capability}`, targets: [{ providerConfigId: provider.id, providerModel: input.model, timeoutMs: 600_000 }] }).onConflictDoNothing().returning({ id: modelRoutes.id });
      if (!row) throw new ConflictException("同用途的模型显示名称已存在");
      return row;
    });
  }
  async originalInput(context: TenantContext, scope: string, requestId: string): Promise<StudioGenerate | null> {
    return withTenant(this.database.db, context, async tx => {
      await currentCreativeWorkspaceAuthority(tx, context, scope, [Permission.DesignWrite, Permission.AssetWrite]);
      const [existing] = await tx.select({ scope: creativeStudioGenerations.scope, input: creativeStudioGenerations.input })
        .from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.requestId, requestId)));
      if (!existing) return null;
      if (existing.scope !== scope) throw new ConflictException("同一生成请求不能更换项目");
      // Read the immutable input exactly as stored, including legacy omissions.
      // Recovery never calls get(), stages an execution or queues the request.
      return existing.input;
    });
  }
  async create(context: TenantContext, scope: string, raw: unknown) {
    const parsed = StudioGenerateRequestSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException({ code: "studio_model_selection_invalid", message: "请选择用途匹配的当前创作模型" });
    let input = parsed.data;
    await withTenant(this.database.db, context, tx => currentCreativeWorkspaceAuthority(tx, context, scope, [Permission.DesignWrite, Permission.AssetWrite]));
    const projectBrief=scope!=="unassigned"?await this.bridge.get(context,scope):null;
    const visual = projectBrief?.workflow?.visualDelivery;
    if (visual) {
      authorize(context, Permission.ProductRead);
      authorize(context, Permission.DesignRead);
      authorize(context, Permission.AssetRead);
      if (input.capability !== "image") throw new BadRequestException({ code: "studio_model_capability_mismatch", message: "视觉交付需要图片模型" });
      if (input.visualSlotKey !== visual.slotKey) throw new BadRequestException("请选择本交付步骤对应的图片槽位");
      if (input.modelId.toLowerCase() !== visual.modelId.toLowerCase() || input.size !== visual.size || input.quality !== "high" || input.background !== (visual.slotKey === "artwork" ? "transparent" : "opaque")) throw new BadRequestException("模型和图片参数已固定，请按原需求执行或准备新的视觉交付");
    } else if (input.visualSlotKey) throw new BadRequestException("该项目不是受控视觉交付任务");
    if(projectBrief?.designInstructions) {
      const origin = visual && visual.slotKey !== "artwork" ? `\n\n套图固定图稿版本：${input.visualArtworkVersionId}。首张参考图是已审核的唯一图稿来源，须保持图案、身份、姿态、比例和文字不变；真实样品参考用于核对抱枕轮廓、材质和单双面。不能用样品照片替换图稿内容。` : "";
      const prompt=`${input.prompt}\n\n项目固定需求：\n${projectBrief.designInstructions}${origin}`;
      if(prompt.length>8000)throw new BadRequestException("项目需求与本次提示合计超过 8000 字，请缩短本次提示或复制项目精简需求");
      input={...input,prompt};
    }
    const result = await withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentCreativeWorkspaceAuthority(tx, context, scope, [Permission.DesignWrite, Permission.AssetWrite]);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:studio-generation`}, 0))`);
      const [existing] = await tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.requestId, input.requestId)));
      if (existing) {
        if (existing.scope !== scope || !isDeepStrictEqual(existing.input, input)) throw new ConflictException("同一生成请求不能更换参数");
        const pin = existing.modelSnapshot;
        // Replays retain their original configuration pin. A legacy or damaged
        // snapshot cannot be silently promoted into a new request or enqueued.
        if (!pin || pin.capability !== input.capability || typeof pin.routeId !== "string" || pin.routeId.toLowerCase() !== input.modelId.toLowerCase()
          || typeof pin.providerFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(pin.providerFingerprint))
          throw new ConflictException({ code: "studio_model_selection_changed", message: "原生成请求的模型快照不可用，请核对历史任务" });
        return existing;
      }
      const routes = await tx.select().from(modelRoutes);
      const route = routes.find(row => row.id === input.modelId.toLowerCase() && row.status === "enabled" && ["studio_image", "studio_video", "studio_text"].includes(row.taskType));
      if (!route || route.targets.length !== 1) throw new BadRequestException("请选择已配置的创作模型");
      if (route.taskType !== `studio_${input.capability}`) throw new BadRequestException({ code: "studio_model_capability_mismatch", message: "所选模型用途与本次创作不匹配，请重新选择" });
      const target = route.targets[0]!;
      if (visual && (target.providerConfigId.toLowerCase() !== visual.providerConfigId.toLowerCase() || target.providerModel !== visual.providerModel)) throw new ConflictException("模型渠道或路由已变化，请重新核对费用并准备视觉交付");
      const [provider] = await tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, target.providerConfigId), eq(modelProviderConfigs.status, "enabled")));
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider)) throw new BadRequestException("模型渠道不可用");
      if (modelConfigurationRevision(provider, routes) !== input.selectionRevision) throw new ConflictException({ code: "studio_model_selection_changed", message: "模型配置已变化，请刷新模型列表后重新选择" });
      if (visual && visualDeliveryModelFingerprint(provider, target) !== visual.providerFingerprint) throw new ConflictException("模型渠道配置已变化，请重新核对费用并准备视觉交付");
      if (visual) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`}, 0))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:${visual.groupId}:visual-budget`}, 0))`);
        try { await assertVisualDeliveryCurrent(tx, visual); } catch { throw new ConflictException("商品或规格已变化，请重新准备视觉交付"); }
        const group = await tx.select({ id: creativeDesignBatches.id, pin: creativeDesignBatches.canvasWorkflow }).from(creativeDesignBatches)
          .where(and(eq(creativeDesignBatches.createdBy, context.userId), isNull(creativeDesignBatches.archivedAt), sql`${creativeDesignBatches.canvasWorkflow}->'visualDelivery'->>'groupId' = ${visual.groupId}`));
        if (group.length !== 4 || new Set(group.map(p => p.pin?.visualDelivery?.slotKey)).size !== 4 || group.some(p => p.pin?.visualDelivery?.requestFingerprint !== visual.requestFingerprint)) throw new ConflictException("视觉交付步骤尚未齐备，请重新读取准备结果");
        const attempts = await tx.select().from(creativeStudioGenerations).where(inArray(creativeStudioGenerations.scope, group.map(p => p.id)));
        if (attempts.filter(a => a.scope === scope).length >= 4) throw new ConflictException("每个槽位最多 4 次尝试，请核对现有结果或准备新交付");
        const reservations = attempts.length ? await tx.select().from(aiBudgetLedger).where(inArray(aiBudgetLedger.requestId, attempts.map(a => a.id))) : [];
        const occupied = reservations.filter(r => r.state !== "released").reduce((sum, r) => sum + Number(r.amountUsd), 0);
        if (occupied + visual.callCeilingUsd > visual.totalBudgetUsd + 0.0000001) throw new ConflictException("本次交付剩余预算不足；已调用或结果不确定的尝试仍保留预算占用");
        const [policy] = await tx.select().from(aiBudgetPolicies);
        if (policy) {
          const cap = policy.taskCapsUsd.studio_image ?? Number(policy.defaultTaskCapUsd);
          if (visual.callCeilingUsd > cap) throw new ConflictException("单次视觉调用预算超过组织上限");
          const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0,0,0,0);
          const [unpriced] = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(gte(creativeStudioGenerations.createdAt, monthStart), sql`${creativeStudioGenerations.modelSnapshot}->>'visualCeilingUsd' is null`, inArray(creativeStudioGenerations.status, ["running", "completed", "failed"]))).limit(1);
          if (unpriced) throw new ConflictException("本月有未计价的创作调用，请先核对账单与组织预算");
          const [total] = await tx.select({ value: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}),0)` }).from(aiBudgetLedger).where(and(gte(aiBudgetLedger.createdAt, monthStart), inArray(aiBudgetLedger.state, ["reserved", "committed"])));
          if (Number(total?.value ?? 0) + visual.callCeilingUsd > Number(policy.monthlyCapUsd)) throw new ConflictException("组织当月 AI 预算不足");
        }
      }
      const active = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), inArray(creativeStudioGenerations.status, ["queued", "running"])));
      if (active.length >= 4) throw new ConflictException("最多同时运行 4 个创作任务，请等待已有任务完成");
      const references: Array<{ assetId: string; version: number; checksum: string }> = [];
      for (const key of input.referenceKeys) {
        const [row] = await tx.select({ asset: assetFiles }).from(creativeStudioEntries).innerJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId)).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.key, key), eq(creativeStudioEntries.namespace, "image_files"), isNull(creativeStudioEntries.deletedAt), isNull(assetFiles.deletedAt)));
        const source = row?.asset.rightsMetadata.source as { kind?: string } | undefined;
        if (!row || row.asset.assetDomain !== "authorized" || row.asset.rightsStatus !== "approved" || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? "")) throw new BadRequestException("参考图须先在素材审核中确认权利；客户照片与竞品不能用于通用创作");
        requireReferenceAuthority(authority, [row.asset], checkedAt);
        references.push({ assetId: row.asset.id, version: row.asset.version, checksum: row.asset.checksumSha256 });
      }
      if(projectBrief?.workflow?.requirements && route.taskType === "studio_image") for(const a of projectBrief.referenceAssets) {
        if(!references.some(r=>r.assetId===a.id)) references.push({assetId:a.id,version:a.version,checksum:a.checksumSha256});
      }
      if (visual && visual.slotKey !== "artwork") {
        let artworkAssetId: string;
        try { artworkAssetId = await visualDeliveryArtwork(tx, visual, input.visualArtworkVersionId ?? ""); }
        catch { throw new ConflictException("套图须选用同一交付中已经审核的图稿版本"); }
        if (!references.some(r => r.assetId === artworkAssetId)) throw new BadRequestException("本次套图没有固定所选图稿素材，请重新读取依据");
        references.unshift(...references.splice(references.findIndex(r => r.assetId === artworkAssetId), 1));
      }
      if(references.length>10)throw new BadRequestException("项目与本次选择的参考图合计不能超过 10 张");
      if (route.taskType === "studio_video" && references.length > 1) throw new BadRequestException("当前视频接口支持一张首帧参考图");
      if (route.taskType === "studio_text" && references.length) throw new BadRequestException("当前文字接口仅支持文字输入");
      const [created] = await tx.insert(creativeStudioGenerations).values({ id: createEntityId(), tenantId: context.tenantId, ownerId: context.userId, scope, requestId: input.requestId, input, references, modelSnapshot: { providerConfigId: target.providerConfigId, routeId: route.id,
        providerFingerprint: visualDeliveryModelFingerprint(provider, target), model: target.providerModel,
        capability: route.taskType.replace("studio_", "") as "image" | "video" | "text", ...(visual ? { visualCeilingUsd: visual.callCeilingUsd } : {}) } }).returning();
      if (visual) await tx.insert(aiBudgetLedger).values({ id: createEntityId(), tenantId: context.tenantId, requestId: created!.id, taskType: "studio_image", modelKey: target.providerModel, provider: provider.provider, amountUsd: visual.callCeilingUsd.toFixed(6), state: "reserved" });
      await stageCreativeExecution(tx, context, { kind: "studio_generation", ownerId: created!.id, stepKey: "generate" }, "external_request");
      return created!;
    });
    if (result.status === "queued") {
      await withTenant(this.database.db, context, async tx => {
        const { authority, checkedAt } = await currentCreativeWorkspaceAuthority(tx, context, scope, [Permission.DesignWrite, Permission.AssetWrite]);
        await this.references(tx, authority, result, checkedAt);
      });
      await this.queue.enqueue({ id: result.id, tenantId: context.tenantId, userId: context.userId });
    }
    await withTenant(this.database.db, context, tx => currentCreativeWorkspaceAuthority(tx, context, scope, [Permission.DesignWrite, Permission.AssetWrite]));
    return { id: result.id, status: result.status };
  }
  async list(context: TenantContext, scope: string) {
    return withTenant(this.database.db, context, async tx => {
      const { authority } = await currentCreativeWorkspaceAuthority(tx, context, scope);
      const rows = await tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.scope, scope))).orderBy(desc(creativeStudioGenerations.createdAt)).limit(40);
      const result = [];
      for (const row of rows) {
        try { await this.references(tx, authority, row); }
        catch (error) { if (error instanceof ForbiddenError || error instanceof NotFoundException) continue; throw error; }
        result.push({ id: row.id, assetId: row.assetId, status: row.status, input: row.input, model: row.modelSnapshot, createdAt: row.createdAt, error: row.error });
      }
      return result;
    });
  }
  async get(context: TenantContext, scope: string, id: string) {
    const read = () => withTenant(this.database.db, context, async tx => {
      const { authority, checkedAt } = await currentCreativeWorkspaceAuthority(tx, context, scope);
      const [row] = await tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.id, id), eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.scope, scope))).for("share");
      if (!row) throw new NotFoundException("创作任务不存在");
      await this.references(tx, authority, row);
      const [asset] = row.status === "completed" && row.assetId ? await tx.select().from(assetFiles).where(and(eq(assetFiles.id, row.assetId), eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))).for("share") : [];
      if (row.status === "completed" && row.assetId && !asset) throw new NotFoundException("生成结果不存在");
      if (asset) {
        const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
        if (!["owned", "licensed", "ai_generated"].includes(kind ?? "")) throw new NotFoundException("生成结果来源不可用");
        requireReferenceAuthority(authority, [asset], checkedAt);
      }
      return { row, asset };
    });
    const original = await read(), { row, asset } = original;
    if (row.status !== "completed" || !row.assetId) return { id, status: row.status, error: row.error, text: row.resultText };
    if (!asset) throw new NotFoundException("生成结果不存在");
    const bytes = Buffer.from(await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" }));
    if (createHash("sha256").update(bytes).digest("hex") !== asset.checksumSha256) throw new ConflictException("生成结果校验失败");
    const verify = async () => {
      const current = await read();
      if (current.row.assetId !== row.assetId || current.row.status !== row.status || current.asset?.version !== asset.version || current.asset.objectKey !== asset.objectKey || current.asset.checksumSha256 !== asset.checksumSha256)
        throw new ConflictException("生成结果已变化 请重新读取");
    };
    await verify();
    let reviewError: string | undefined;
    if (scope !== "unassigned" && asset.mediaType.startsWith("image/")) {
      try { await this.bridge.submit(context, scope, { submissionId: row.requestId, title: row.input.prompt.slice(0, 80), sourceNodeId: `image:${id}`, protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, contentBase64: bytes.toString("base64"), rightsAttested: true, sourceKind: "ai_generated", sourceReference: `ERP 创作模型 ${row.modelSnapshot.model}` }, asset.id); }
      catch { reviewError = "结果已保存到素材。当前步骤无法再接收方案，请在项目中核对审核状态。"; }
    }
    await verify();
    return { id, status: row.status, key: `${asset.mediaType.startsWith("image/") ? "image" : "video"}:${id}`, contentBase64: bytes.toString("base64"), mediaType: asset.mediaType, reviewError };
  }

  private async references(tx: TenantTransaction, authority: TenantContext, row: typeof creativeStudioGenerations.$inferSelect, checkedAt?: number) {
    const ids = [...new Set([...row.references.map(reference => reference.assetId), ...(row.assetId ? [row.assetId] : [])])].sort();
    const assets = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)).for("share") : [];
    if (assets.length !== ids.length) throw new NotFoundException("创作任务素材不存在");
    requireReferenceAuthority(authority, assets, checkedAt);
    if (checkedAt !== undefined) for (const reference of row.references) {
      const asset = assets.find(file => file.id === reference.assetId)!;
      const kind = (asset.rightsMetadata.source as { kind?: string } | undefined)?.kind;
      if (asset.deletedAt || asset.assetDomain !== "authorized" || asset.rightsStatus !== "approved" || !["owned", "licensed", "ai_generated"].includes(kind ?? "") || asset.version !== reference.version || asset.checksumSha256 !== reference.checksum)
        throw new ConflictException("原参考图已变化 请重新核对创作输入");
    }
  }
}
