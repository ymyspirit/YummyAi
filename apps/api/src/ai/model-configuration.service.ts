import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ConfigurationRpcSchema, emptyModelDefaults, type ConfigurationRpc, type ConfigurationSnapshot, type ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import { aiAssistRuns, creativeStudioGenerations, modelPreferences, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, MODEL_SECRET_VAULT } from "../platform.tokens.js";
import { discoverProviderModels, modelEndpoint } from "./model-catalogue.js";
import { configuredAssistModels } from "./configured-assist-models.js";
import { modelConfigurationRevision } from "./model-configuration-revision.js";

const studioTypes = ["studio_image", "studio_video", "studio_text"];
const providersSupported = ["openai", "openai-compatible"];
type ChannelSave = Extract<ConfigurationRpc, { operation: "channel.save" }>;

@Injectable()
export class ModelConfigurationService {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection, @Inject(MODEL_SECRET_VAULT) private readonly vault: SecretVault) {}

  async invoke(context: TenantContext, raw: unknown) {
    authorize(context, Permission.ModelConfigure);
    const parsed = ConfigurationRpcSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("配置格式无效，请核对渠道、模型名称和用途");
    const input = parsed.data;
    if (input.operation === "channel.discover") return this.discover(context, input);
    if (input.operation === "configuration.get") return withTenant(this.database.db, context, tx => this.snapshot(tx, context), { isolationLevel: "repeatable read", accessMode: "read only" });
    return withTenant(this.database.db, context, async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      if (input.operation === "channel.save") await this.saveChannel(tx, context, input);
      else if (input.operation === "channel.remove") await this.removeChannel(tx, context, input);
      else if (input.operation === "model.remove") {
        const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.channelId);
        if (!current) throw new NotFoundException("模型渠道不存在");
        if (current.revision !== input.revision) throw new ConflictException("模型配置已被修改，请刷新配置后重试");
        const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), inArray(modelRoutes.taskType, [...studioTypes, "studio_analysis"]), eq(modelRoutes.status, "enabled")));
        if (!route || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== current.id) throw new NotFoundException("此渠道中没有该模型");
        await this.removeModels(tx, context, [route.id]);
      }
      else if (input.operation === "channel.status") {
        const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.id);
        if (!current) throw new NotFoundException("模型渠道不存在");
        if (current.revision !== input.revision) throw new ConflictException("渠道已被修改，请刷新配置后重试");
        await tx.update(modelProviderConfigs).set({ status: input.status, updatedAt: sql`clock_timestamp()` }).where(eq(modelProviderConfigs.id, input.id));
      } else if (input.operation === "defaults.save") {
        const current = await this.snapshot(tx, context);
        if (current.defaultsRevision !== input.revision) throw new ConflictException("默认模型已被修改，请刷新配置后重试");
        for (const [capability, id] of Object.entries(input.defaults)) {
          if (!id) continue;
          const valid = capability === "analysis" ? current.analysisModels.some(model => model.id === id)
            : current.channels.some(channel => channel.status === "enabled" && channel.models.some(model => model.id === id && model.capability === capability));
          if (!valid) throw new BadRequestException("默认模型已停用或用途不匹配，请重新选择");
        }
        await tx.insert(modelPreferences).values({ tenantId: context.tenantId, userId: context.userId, defaults: input.defaults, revision: input.revision + 1 })
          .onConflictDoUpdate({ target: [modelPreferences.tenantId, modelPreferences.userId], set: { defaults: input.defaults, revision: input.revision + 1, updatedAt: sql`clock_timestamp()` } });
      }
      return this.snapshot(tx, context);
    });
  }

  private async snapshot(tx: TenantTransaction, context: TenantContext): Promise<ConfigurationSnapshot> {
    const providers = await tx.select({ id: modelProviderConfigs.id, name: modelProviderConfigs.label, baseUrl: modelProviderConfigs.endpoint, provider: modelProviderConfigs.provider, status: modelProviderConfigs.status, updatedAt: modelProviderConfigs.updatedAt }).from(modelProviderConfigs).where(ne(modelProviderConfigs.status, "deleted")).orderBy(modelProviderConfigs.createdAt);
    const routes = await tx.select().from(modelRoutes).orderBy(modelRoutes.createdAt);
    const channels: ConfiguredChannel[] = providers.map(provider => {
      const related = routes.filter(route => route.targets.some(target => target.providerConfigId === provider.id));
      const owned = related.filter(route => route.targets.length === 1 && route.status === "enabled");
      return { ...provider, baseUrl: provider.baseUrl ?? "https://api.openai.com/v1", status: provider.status as "enabled" | "disabled", hasCredential: true,
        revision: modelConfigurationRevision(provider, routes),
        models: owned.filter(route => studioTypes.includes(route.taskType)).map(route => ({ id: route.id, label: route.modelKey, name: route.targets[0]!.providerModel, capability: route.taskType.slice(7) as "image" | "video" | "text" })),
        analysisModels: owned.filter(route => route.taskType === "studio_analysis").map(route => ({ id: route.id, label: route.modelKey, name: route.targets[0]!.providerModel })),
        dependentRoutes: related.filter(route => route.status === "enabled" && (route.targets.length !== 1 || ![...studioTypes, "studio_analysis"].includes(route.taskType))).map(route => ({ id: route.id, label: route.modelKey })),
      };
    });
    const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
    return { channels, defaults: preferences?.defaults ?? emptyModelDefaults(), defaultsRevision: preferences?.revision ?? 0,
      analysisModels: (await configuredAssistModels(tx, context.userId)).map(({ id, label, model, providerLabel }) => ({ id, label, model, providerLabel, providerConfigId: routes.find(route => route.id === id)!.targets[0]!.providerConfigId })),
    };
  }

  private async saveChannel(tx: TenantTransaction, context: TenantContext, input: ChannelSave) {
    const endpoint = modelEndpoint(input.baseUrl);
    const snapshot = await this.snapshot(tx, context);
    const current = input.id ? snapshot.channels.find(channel => channel.id === input.id) : undefined;
    if (input.id && !current) throw new NotFoundException("模型渠道不存在");
    if (current && (!providersSupported.includes(current.provider) || current.revision !== input.revision)) throw new ConflictException("渠道已变化或协议暂未接入，请刷新配置后重试");
    const explicitProvider = input.textProtocol === "responses" ? "openai" : input.textProtocol === "chat_completions" ? "openai-compatible" : undefined;
    if (current && explicitProvider && explicitProvider !== current.provider)
      throw new ConflictException("已有渠道的文本协议不能修改 请新建渠道以保留原任务的执行协议");
    if (current && new Set(current.models.map(model => model.name)).size !== current.models.length) throw new ConflictException("此历史渠道含同名多用途模型，需先完成兼容转换；现有模型继续保留和使用");
    if (!current && !input.apiKey) throw new BadRequestException("新渠道需要填写 API Key");
    if (new Set(input.models.map(model => model.name)).size !== input.models.length) throw new BadRequestException("同一渠道不能重复添加同名创作模型");
    if (snapshot.channels.some(channel => channel.id !== input.id && channel.name === input.name)) throw new ConflictException("渠道名称已存在，请使用其他名称");
    // Template authority timestamps also come from PostgreSQL. Mixing the API
    // host clock here can make an unchanged route appear newer than its template.
    const id = current?.id ?? createEntityId(), updatedAt = sql`clock_timestamp()`;
    if (current) await tx.update(modelProviderConfigs).set({ label: input.name, endpoint, updatedAt, ...(input.apiKey ? { encryptedApiKey: this.vault.encrypt(input.apiKey) } : {}) }).where(eq(modelProviderConfigs.id, id));
    else await tx.insert(modelProviderConfigs).values({ id, tenantId: context.tenantId, createdBy: context.userId,
      provider: explicitProvider ?? (new URL(endpoint).origin === "https://api.openai.com" ? "openai" : "openai-compatible"),
      label: input.name, endpoint, encryptedApiKey: this.vault.encrypt(input.apiKey!) });
    const allRoutes = await tx.select().from(modelRoutes).where(inArray(modelRoutes.taskType, studioTypes));
    const related = allRoutes.filter(route => route.targets.length === 1 && route.targets[0]!.providerConfigId === id);
    const kept = new Set<string>();
    for (const model of input.models) {
      const existing = model.id ? related.find(route => route.id === model.id) : related.find(route => route.targets[0]!.providerModel === model.name && route.taskType === `studio_${model.capability}`);
      if (model.id && !existing) throw new NotFoundException("配置中包含不属于此渠道的模型");
      const routeId = existing?.id ?? createEntityId(); kept.add(routeId);
      let modelKey = model.label ?? existing?.modelKey ?? `${input.name.slice(0, 30)} / ${model.name.slice(0, 64)}`;
      const taskType = `studio_${model.capability}`;
      // Reusing a deleted channel's name must not reuse historical model IDs.
      const conflict = allRoutes.find(route => route.id !== routeId && route.taskType === taskType && route.modelKey === modelKey);
      if (conflict && !model.label && !existing && conflict.status === "disabled" && conflict.targets.every(target => !snapshot.channels.some(channel => channel.id === target.providerConfigId))) modelKey = `${modelKey.slice(0, 60)} / ${routeId}`;
      if (allRoutes.some(route => route.id !== routeId && route.taskType === taskType && route.modelKey === modelKey)) throw new ConflictException("同用途的模型显示名称已存在，请修改模型或渠道名称");
      const values = { modelKey, taskType, targets: [{ timeoutMs: 600_000, ...existing?.targets[0], providerConfigId: id, providerModel: model.name }], status: "enabled", updatedAt };
      if (existing) await tx.update(modelRoutes).set(values).where(eq(modelRoutes.id, routeId));
      else await tx.insert(modelRoutes).values({ ...values, id: routeId, tenantId: context.tenantId });
    }
    const removed = related.filter(route => !kept.has(route.id) && route.status === "enabled").map(route => route.id);
    if (removed.length) await this.removeModels(tx, context, removed);
  }

  private async removeChannel(tx: TenantTransaction, context: TenantContext, input: Extract<ConfigurationRpc, { operation: "channel.remove" }>) {
    const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.id);
    if (!current) throw new NotFoundException("模型渠道不存在或已删除");
    if (current.revision !== input.revision) throw new ConflictException("渠道或模型已被修改，请刷新配置后重新确认删除");
    if (current.dependentRoutes.length) throw new ConflictException(`该渠道仍被业务路由引用，请先调整：${current.dependentRoutes.map(route => route.label).join("、")}`);
    // Include other members' tasks and snapshots whose route was disabled.
    const [assist] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(inArray(aiAssistRuns.status, ["queued", "running"]), sql`${aiAssistRuns.modelSnapshot}->>'providerConfigId' = ${input.id}`)).limit(1);
    const [generation] = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(inArray(creativeStudioGenerations.status, ["queued", "running"]), sql`${creativeStudioGenerations.modelSnapshot}->>'providerConfigId' = ${input.id}`)).limit(1);
    if (assist || generation) throw new ConflictException("该渠道仍有排队或进行中的任务，请等待完成或取消任务后再删除");
    const routes = await tx.select().from(modelRoutes);
    const ownedIds = routes.filter(route => route.targets.length === 1 && route.targets[0]!.providerConfigId === input.id).map(route => route.id);
    if (ownedIds.length) await this.removeModels(tx, context, ownedIds);
    // Retain the identity for history, but discard its credential permanently.
    await tx.update(modelProviderConfigs).set({ status: "deleted", encryptedApiKey: "", updatedAt: sql`clock_timestamp()` }).where(eq(modelProviderConfigs.id, input.id));
  }

  private async removeModels(tx: TenantTransaction, context: TenantContext, ids: string[]) {
    // Creation takes the same configuration lock, so a new task cannot slip
    // between this check and removal. History keeps its immutable model snapshot.
    const [assist] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(
      inArray(aiAssistRuns.status, ["queued", "running"]),
      sql`${aiAssistRuns.modelSnapshot}->>'id' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`,
    )).limit(1);
    const [generation] = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(
      inArray(creativeStudioGenerations.status, ["queued", "running"]),
      sql`${creativeStudioGenerations.input}->>'modelId' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`,
    )).limit(1);
    if (assist || generation) throw new ConflictException("该模型仍有排队或进行中的任务，请等待完成或取消任务后再删除");
    await tx.update(modelRoutes).set({ status: "disabled", updatedAt: sql`clock_timestamp()` }).where(inArray(modelRoutes.id, ids));
    // Preferences are user-owned by RLS; another user's saved choices are never rewritten.
    const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
    if (preferences && Object.values(preferences.defaults).some(id => id && ids.includes(id))) {
      const defaults = { ...preferences.defaults };
      for (const capability of ["image", "video", "text", "analysis"] as const) if (defaults[capability] && ids.includes(defaults[capability]!)) defaults[capability] = null;
      await tx.update(modelPreferences).set({ defaults, revision: preferences.revision + 1, updatedAt: sql`clock_timestamp()` }).where(eq(modelPreferences.userId, context.userId));
    }
  }

  private async discover(context: TenantContext, input: Extract<ConfigurationRpc, { operation: "channel.discover" }>) {
    const endpoint = modelEndpoint(input.baseUrl);
    if (!input.id) {
      if (!input.apiKey) throw new BadRequestException("请先填写 API Key，再获取模型");
      return discoverProviderModels(endpoint, input.apiKey);
    }
    const [provider] = await withTenant(this.database.db, context, tx => tx.select().from(modelProviderConfigs).where(and(eq(modelProviderConfigs.id, input.id!), ne(modelProviderConfigs.status, "deleted"))));
    if (!provider) throw new NotFoundException("模型渠道不存在");
    if (!providersSupported.includes(provider.provider)) throw new BadRequestException("当前仅支持 OpenAI 协议的模型目录");
    if (input.apiKey) return discoverProviderModels(endpoint, input.apiKey);
    if (endpoint !== modelEndpoint(provider.endpoint ?? "https://api.openai.com/v1")) throw new BadRequestException("API 地址已修改，请保存渠道后再获取模型，或填写此地址对应的新 Key");
    return this.vault.withSecret(provider.encryptedApiKey, key => discoverProviderModels(endpoint, key));
  }
}
