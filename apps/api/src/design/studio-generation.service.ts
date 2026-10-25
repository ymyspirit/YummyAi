import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, ForbiddenError, Permission } from "@yummyai/authz";
import { createHash } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioModelInputSchema, type StudioGenerate } from "@yummyai/contracts/pod/creative-studio";
import type { StudioModel } from "@yummyai/contracts/pod/studio-personal";
import { assetFiles, creativeStudioGenerations, modelPreferences, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, PRIVATE_STORAGE } from "../platform.tokens.js";
import { modelConfigurationRevision } from "../ai/model-configuration-revision.js";
import { CanvasBridgeService } from "./canvas-bridge.service.js";
import { currentDesignAuthority } from "./design-access.js";
import { currentCreativeWorkspaceAuthority, requireReferenceAuthority } from "./canvas-workflow-access.js";

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
          isDefault: preferences?.defaults[capability]?.toLowerCase() === row.id, selectionRevision: revisions.get(provider.id)!,
          ...(capability === "image" && row.targets[0]!.imagePricing ? { imagePricing: row.targets[0]!.imagePricing } : {}) });
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
  async create(context: TenantContext, scope: string, raw: unknown): Promise<{ id: string; status: "queued" | "running" | "completed" | "failed" }> {
    // Legacy callers (including visual-delivery adapters) cannot bypass the
    // dedicated prepared quote, explicit confirmation and atomic reservation.
    void context; void scope; void raw;
    throw new ConflictException({ code: "studio_paid_execution_paused", message: "请通过单张图片费用面板准备并确认付费生成" });
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
    if (scope !== "unassigned" && asset.mediaType.startsWith("image/") && !row.modelSnapshot.paidImage) {
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
