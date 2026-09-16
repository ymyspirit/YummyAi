import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioModelInputSchema, type StudioGenerate } from "@yummyai/contracts/pod/creative-studio";
import { assetFiles, creativeStudioEntries, creativeStudioGenerations, modelPreferences, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";

export abstract class StudioGenerationEnqueuer { abstract enqueue(input: { id: string; tenantId: string; userId: string }): Promise<void>; }
@Injectable()
export class StudioGenerationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(PRIVATE_STORAGE) private readonly storage: Storage,
    @Inject(StudioGenerationEnqueuer) private readonly queue: StudioGenerationEnqueuer,
    @Inject(CanvasBridgeService) private readonly bridge: CanvasBridgeService,
  ) {}
  async models(context: TenantContext) {
    authorize(context, Permission.DesignRead);
    const rows = await withTenant(this.database.db, context, tx => tx.select().from(modelRoutes).where(and(inArray(modelRoutes.taskType, ["studio_image", "studio_video", "studio_text"]), eq(modelRoutes.status, "enabled"))));
    const providers = await withTenant(this.database.db, context, tx => tx.select({ id: modelProviderConfigs.id, label: modelProviderConfigs.label }).from(modelProviderConfigs).where(eq(modelProviderConfigs.status, "enabled")));
    const [preferences] = await withTenant(this.database.db, context, tx => tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId)));
    return rows.filter(row => row.targets.length === 1 && providers.some(p => p.id === row.targets[0]!.providerConfigId)).map(row => ({ id: row.id, label: row.modelKey, model: row.targets[0]!.providerModel, capability: row.taskType.replace("studio_", ""), providerLabel: providers.find(p => p.id === row.targets[0]!.providerConfigId)!.label, isDefault: preferences?.defaults[row.taskType.slice(7) as "image" | "video" | "text"] === row.id }));
  }
  async addModel(context: TenantContext, raw: unknown) {
    authorize(context, Permission.ModelConfigure);
    const parsed = StudioModelInputSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("请填写渠道、模型名称和用途");
    const input = parsed.data;
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      const [provider] = await tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, input.providerConfigId));
      if (!provider || provider.status === "deleted" || !["openai", "openai-compatible"].includes(provider.provider)) throw new BadRequestException("创作模型需要 OpenAI 兼容渠道");
      const [row] = await tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: context.tenantId, modelKey: input.label, taskType: `studio_${input.capability}`, targets: [{ providerConfigId: provider.id, providerModel: input.model, timeoutMs: 600_000 }] }).onConflictDoNothing().returning({ id: modelRoutes.id });
      if (!row) throw new ConflictException("同用途的模型显示名称已存在");
      return row;
    });
  }
  async create(context: TenantContext, scope: string, input: StudioGenerate) {
    authorize(context, Permission.DesignWrite); authorize(context, Permission.AssetWrite);
    const projectBrief=scope!=="unassigned"?await this.bridge.get(context,scope):null;
    if(projectBrief?.designInstructions) {
      const prompt=`${input.prompt}\n\n项目固定需求：\n${projectBrief.designInstructions}`;
      if(prompt.length>8000)throw new BadRequestException("项目需求与本次提示合计超过 8000 字，请缩短本次提示或复制项目精简需求");
      input={...input,prompt};
    }
    const result = await withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${context.userId}:studio-generation`}, 0))`);
      const [existing] = await tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.requestId, input.requestId)));
      if (existing) {
        if (existing.scope !== scope || !isDeepStrictEqual(existing.input, input)) throw new ConflictException("同一生成请求不能更换参数");
        return existing;
      }
      const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), eq(modelRoutes.status, "enabled"), inArray(modelRoutes.taskType, ["studio_image", "studio_video", "studio_text"])));
      if (!route || route.targets.length !== 1) throw new BadRequestException("请选择已配置的创作模型");
      const target = route.targets[0]!;
      const [provider] = await tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, target.providerConfigId), eq(modelProviderConfigs.status, "enabled")));
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider)) throw new BadRequestException("模型渠道不可用");
      const active = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), inArray(creativeStudioGenerations.status, ["queued", "running"])));
      if (active.length >= 4) throw new ConflictException("最多同时运行 4 个创作任务，请等待已有任务完成");
      const references: Array<{ assetId: string; version: number; checksum: string }> = [];
      for (const key of input.referenceKeys) {
        const [row] = await tx.select({ asset: assetFiles }).from(creativeStudioEntries).innerJoin(assetFiles, eq(assetFiles.id, creativeStudioEntries.assetId)).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.key, key), eq(creativeStudioEntries.namespace, "image_files"), isNull(creativeStudioEntries.deletedAt), isNull(assetFiles.deletedAt)));
        const source = row?.asset.rightsMetadata.source as { kind?: string } | undefined;
        if (!row || row.asset.assetDomain !== "authorized" || row.asset.rightsStatus !== "approved" || !["owned", "licensed", "ai_generated"].includes(source?.kind ?? "")) throw new BadRequestException("参考图须先在素材审核中确认权利；客户照片与竞品不能用于通用创作");
        references.push({ assetId: row.asset.id, version: row.asset.version, checksum: row.asset.checksumSha256 });
      }
      if(projectBrief?.workflow?.requirements && route.taskType === "studio_image") for(const a of projectBrief.referenceAssets) {
        if(!references.some(r=>r.assetId===a.id)) references.push({assetId:a.id,version:a.version,checksum:a.checksumSha256});
      }
      if(references.length>10)throw new BadRequestException("项目与本次选择的参考图合计不能超过 10 张");
      if (route.taskType === "studio_video" && references.length > 1) throw new BadRequestException("当前视频接口支持一张首帧参考图");
      if (route.taskType === "studio_text" && references.length) throw new BadRequestException("当前文字接口仅支持文字输入");
      const [created] = await tx.insert(creativeStudioGenerations).values({ id: createEntityId(), tenantId: context.tenantId, ownerId: context.userId, scope, requestId: input.requestId, input, references, modelSnapshot: { providerConfigId: target.providerConfigId, model: target.providerModel, capability: route.taskType.replace("studio_", "") as "image" | "video" | "text" } }).returning();
      return created!;
    });
    if (result.status === "queued") await this.queue.enqueue({ id: result.id, tenantId: context.tenantId, userId: context.userId });
    return { id: result.id, status: result.status };
  }
  async list(context: TenantContext, scope: string) {
    return withTenant(this.database.db, context, tx => tx.select({ id: creativeStudioGenerations.id, status: creativeStudioGenerations.status, input: creativeStudioGenerations.input, model: creativeStudioGenerations.modelSnapshot, createdAt: creativeStudioGenerations.createdAt, error: creativeStudioGenerations.error }).from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.scope, scope))).orderBy(desc(creativeStudioGenerations.createdAt)).limit(40));
  }
  async get(context: TenantContext, scope: string, id: string) {
    const [row] = await withTenant(this.database.db, context, tx => tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.id, id), eq(creativeStudioGenerations.ownerId, context.userId), eq(creativeStudioGenerations.scope, scope))));
    if (!row) throw new NotFoundException("创作任务不存在");
    if (row.status !== "completed" || !row.assetId) return { id, status: row.status, error: row.error, text: row.resultText };
    const [asset] = await withTenant(this.database.db, context, tx => tx.select().from(assetFiles).where(and(eq(assetFiles.id, row.assetId!), eq(assetFiles.assetDomain, "authorized"), isNull(assetFiles.deletedAt))));
    if (!asset) throw new NotFoundException("生成结果不存在");
    const bytes = Buffer.from(await this.storage.readPrivate(context, { ...asset, assetDomain: "authorized" }, { requiredDomain: "authorized" }));
    let reviewError: string | undefined;
    if (scope !== "unassigned" && asset.mediaType.startsWith("image/")) {
      try { await this.bridge.submit(context, scope, { submissionId: row.requestId, title: row.input.prompt.slice(0, 80), sourceNodeId: `image:${id}`, protocolVersion: 1, pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, contentBase64: bytes.toString("base64"), rightsAttested: true, sourceKind: "ai_generated", sourceReference: `ERP 创作模型 ${row.modelSnapshot.model}` }, asset.id); }
      catch { reviewError = "结果已保存到素材。当前步骤无法再接收方案，请在项目中核对审核状态。"; }
    }
    return { id, status: row.status, key: `${asset.mediaType.startsWith("image/") ? "image" : "video"}:${id}`, contentBase64: bytes.toString("base64"), mediaType: asset.mediaType, reviewError };
  }
}
