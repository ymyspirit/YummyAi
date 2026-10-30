import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { OFFICIAL_API_PRICE_CATALOG, type SecretVault } from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ConfigurationRpcSchema, emptyModelDefaults, type ConfigurationRpc, type ConfigurationSnapshot, type ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import type { ModelPurpose, ModelPurposeDefaults } from "@yummyai/contracts/ai/model-purpose";
import { agentLoopRuns, agentPlanRuns, aiAssistRuns, creativeStudioGenerations, modelPreferences, modelProviderConfigs, modelRoutes, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { DATABASE_CONNECTION, MODEL_SECRET_VAULT } from "../platform.tokens.js";
import { discoverProviderModels, modelEndpoint } from "./model-catalogue.js";
import { configuredAssistModels } from "./configured-assist-models.js";
import { currentDesignAuthority } from "../design/design-access.js";
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
      else if (input.operation === "model.status") await this.setModelStatus(tx, context, input);
      else if (input.operation === "model.update") await this.updateModel(tx, context, input);
      else if (input.operation === "model.analysis-pricing.save") await this.saveAnalysisPricing(tx, context, input);
      else if (input.operation === "studio.image-pricing.save") {
        await currentDesignAuthority(tx, context, [Permission.ModelConfigure]);
        const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.channelId);
        if (!current || current.status !== "enabled") throw new NotFoundException("模型渠道不存在或已停用");
        if (current.revision !== input.revision) throw new ConflictException("模型配置已被修改，请刷新配置后重试");
        const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId),
          eq(modelRoutes.taskType, "studio_image"), eq(modelRoutes.status, "enabled")));
        if (!route || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== current.id)
          throw new NotFoundException("此渠道中没有可配置的图片模型");
        await tx.update(modelRoutes).set({ targets: [{ ...route.targets[0]!, imagePricing: input.pricing }], updatedAt: sql`clock_timestamp()` })
          .where(eq(modelRoutes.id, route.id));
      }
      else if (input.operation === "model.remove") {
        const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.channelId);
        if (!current) throw new NotFoundException({ code: "model_configuration_channel_missing", message: "模型渠道不存在" });
        if (current.revision !== input.revision) throw new ConflictException({ code: "model_configuration_revision_conflict", message: "模型配置已被修改，请刷新配置后重试" });
        const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), inArray(modelRoutes.taskType, [...studioTypes, "studio_analysis"])));
        if (!route || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== current.id || (route.status !== "enabled" && !route.targets[0]!.configurationDisabled)) throw new NotFoundException({ code: "model_configuration_model_missing", message: "此渠道中没有该模型" });
        await this.removeModels(tx, context, [route.id]);
      }
      else if (input.operation === "channel.status") {
        const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.id);
        if (!current) throw new NotFoundException("模型渠道不存在");
        if (current.revision !== input.revision) throw new ConflictException("渠道已被修改，请刷新配置后重试");
        if (input.status === "disabled" && current.status !== "disabled") await this.assertChannelIdle(tx, input.id, "model_configuration_channel_in_use");
        await tx.update(modelProviderConfigs).set({ status: input.status, updatedAt: sql`clock_timestamp()` }).where(eq(modelProviderConfigs.id, input.id));
      } else if (input.operation === "defaults.save") {
        const current = await this.snapshot(tx, context);
        if (current.defaultsRevision !== input.revision) throw new ConflictException("默认模型已被修改，请刷新配置后重试");
        for (const capability of ["image", "video", "text", "analysis"] as const) {
          const id = input.defaults[capability];
          if (!id) continue;
          const valid = capability === "analysis" ? current.analysisModels.some(model => model.id === id)
            : current.channels.some(channel => channel.status === "enabled" && channel.models.some(model => model.id === id && model.capability === capability && model.status !== "disabled"));
          if (!valid) throw new BadRequestException("默认模型已停用或用途不匹配，请重新选择");
        }
        const defaults = { ...input.defaults, ...(input.defaults.purposeDefaults === undefined && current.defaults.purposeDefaults ? { purposeDefaults: current.defaults.purposeDefaults } : {}) };
        this.validatePurposeDefaults(defaults.purposeDefaults, current);
        await this.saveDefaults(tx, context, defaults, input.revision);
      } else if (input.operation === "purpose-defaults.save") {
        const current = await this.snapshot(tx, context);
        if (current.defaultsRevision !== input.revision) throw new ConflictException("默认模型已被修改，请刷新配置后重试");
        const purposeDefaults = { ...current.defaults.purposeDefaults, ...input.defaults };
        this.validatePurposeDefaults(purposeDefaults, current);
        await this.saveDefaults(tx, context, { ...current.defaults, purposeDefaults }, input.revision);
      }
      return this.snapshot(tx, context);
    });
  }

  private async snapshot(tx: TenantTransaction, context: TenantContext): Promise<ConfigurationSnapshot> {
    const providers = await tx.select({ id: modelProviderConfigs.id, name: modelProviderConfigs.label, baseUrl: modelProviderConfigs.endpoint, provider: modelProviderConfigs.provider, status: modelProviderConfigs.status, updatedAt: modelProviderConfigs.updatedAt }).from(modelProviderConfigs).where(ne(modelProviderConfigs.status, "deleted")).orderBy(modelProviderConfigs.createdAt);
    const routes = await tx.select().from(modelRoutes).orderBy(modelRoutes.createdAt, modelRoutes.id);
    const channels: ConfiguredChannel[] = providers.map(provider => {
      const related = routes.filter(route => route.targets.some(target => target.providerConfigId === provider.id));
      const owned = related.filter(route => route.targets.length === 1 && (route.status === "enabled" || (route.status === "disabled" && route.targets[0]!.configurationDisabled === true)));
      const quoteSources = owned.filter(route => route.taskType === "studio_analysis" && route.targets[0]!.analysisPricing)
        .sort((left, right) => Number(right.status === "enabled") - Number(left.status === "enabled"));
      const pricingProjection = (route: typeof routes[number]) => {
        const direct = route.targets[0]!.analysisPricing;
        if (direct) return { analysisPricing: direct };
        if (!["studio_text", "studio_analysis"].includes(route.taskType)) return {};
        const inherited = quoteSources.find(source => source.targets[0]!.providerModel === route.targets[0]!.providerModel);
        return inherited ? { analysisPricing: inherited.targets[0]!.analysisPricing!, analysisPricingInheritedFrom: inherited.id } : {};
      };
      return { ...provider, baseUrl: provider.baseUrl ?? "https://api.openai.com/v1", status: provider.status as "enabled" | "disabled", hasCredential: true,
        revision: modelConfigurationRevision(provider, routes),
        ...(provider.provider === "openai" ? { textProtocol: "responses" as const } : provider.provider === "openai-compatible" ? { textProtocol: "chat_completions" as const } : {}),
        models: owned.filter(route => studioTypes.includes(route.taskType)).map(route => ({ id: route.id, label: route.modelKey, name: route.targets[0]!.providerModel, capability: route.taskType.slice(7) as "image" | "video" | "text",
          ...(route.status === "disabled" ? { status: "disabled" as const } : {}),
          ...pricingProjection(route),
          ...(route.taskType === "studio_image" && route.targets[0]!.imagePricing ? { imagePricing: route.targets[0]!.imagePricing } : {}) })),
        analysisModels: owned.filter(route => route.taskType === "studio_analysis").map(route => ({ id: route.id, label: route.modelKey, name: route.targets[0]!.providerModel,
          ...(route.status === "disabled" ? { status: "disabled" as const } : {}),
          ...pricingProjection(route),
        })),
        dependentRoutes: related.filter(route => route.status === "enabled" && (route.targets.length !== 1 || ![...studioTypes, "studio_analysis"].includes(route.taskType))).map(route => ({ id: route.id, label: route.modelKey })),
      };
    });
    const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
    return { channels, defaults: preferences?.defaults ?? emptyModelDefaults(), defaultsRevision: preferences?.revision ?? 0, officialPriceCatalog: OFFICIAL_API_PRICE_CATALOG,
      analysisModels: (await configuredAssistModels(tx, context.userId)).map(({ id, label, model, providerLabel }) => ({ id, label, model, providerLabel, providerConfigId: routes.find(route => route.id === id)!.targets[0]!.providerConfigId })),
    };
  }

  private validatePurposeDefaults(defaults: ModelPurposeDefaults | undefined, snapshot: ConfigurationSnapshot) {
    for (const id of Object.values(defaults ?? {})) {
      if (id && !snapshot.analysisModels.some(model => model.id === id))
        throw new BadRequestException("业务默认模型已停用或不支持文字分析 请重新选择");
    }
  }

  private async saveDefaults(tx: TenantTransaction, context: TenantContext, defaults: ConfigurationSnapshot["defaults"], revision: number) {
    await tx.insert(modelPreferences).values({ tenantId: context.tenantId, userId: context.userId, defaults, revision: revision + 1 })
      .onConflictDoUpdate({ target: [modelPreferences.tenantId, modelPreferences.userId], set: { defaults, revision: revision + 1, updatedAt: sql`clock_timestamp()` } });
  }

  private async selectedModel(tx: TenantTransaction, context: TenantContext, input: { channelId: string; modelId: string; revision: string }) {
    await currentDesignAuthority(tx, context, [Permission.ModelConfigure]);
    const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.channelId);
    if (!current) throw new NotFoundException({ code: "model_configuration_channel_missing", message: "模型渠道不存在或已删除" });
    if (current.revision !== input.revision) throw new ConflictException({ code: "model_configuration_revision_conflict", message: "模型配置已被修改 请读取最新配置后重试" });
    const [route] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.id, input.modelId), inArray(modelRoutes.taskType, [...studioTypes, "studio_analysis"])));
    if (!route || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== current.id
      || (route.status !== "enabled" && !(route.status === "disabled" && route.targets[0]!.configurationDisabled === true)))
      throw new NotFoundException({ code: "model_configuration_model_missing", message: "此渠道中没有该模型" });
    return { current, route };
  }

  private async setModelStatus(tx: TenantTransaction, context: TenantContext, input: Extract<ConfigurationRpc, { operation: "model.status" }>) {
    const { route } = await this.selectedModel(tx, context, input);
    if (route.status === input.status) return;
    await this.assertModelsIdle(tx, [route.id], "model_configuration_model_in_use");
    const target = { ...route.targets[0]! };
    if (input.status === "disabled") target.configurationDisabled = true;
    else delete target.configurationDisabled;
    await tx.update(modelRoutes).set({ targets: [target], status: input.status, updatedAt: sql`clock_timestamp()` }).where(eq(modelRoutes.id, route.id));
    if (input.status === "disabled") await this.clearDefaultReferences(tx, context, [route.id]);
  }

  private async updateModel(tx: TenantTransaction, context: TenantContext, input: Extract<ConfigurationRpc, { operation: "model.update" }>) {
    const { route } = await this.selectedModel(tx, context, input);
    if (route.modelKey === input.label) return;
    await this.assertModelsIdle(tx, [route.id], "model_configuration_model_in_use");
    const [conflict] = await tx.select({ id: modelRoutes.id }).from(modelRoutes)
      .where(and(eq(modelRoutes.modelKey, input.label), eq(modelRoutes.taskType, route.taskType), ne(modelRoutes.id, route.id))).limit(1);
    if (conflict) throw new BadRequestException("同用途的模型显示名称已存在 请修改名称");
    await tx.update(modelRoutes).set({ modelKey: input.label, updatedAt: sql`clock_timestamp()` }).where(eq(modelRoutes.id, route.id));
  }

  private async saveAnalysisPricing(tx: TenantTransaction, context: TenantContext, input: Extract<ConfigurationRpc, { operation: "model.analysis-pricing.save" }>) {
    const { route } = await this.selectedModel(tx, context, input);
    if (!["studio_text", "studio_analysis"].includes(route.taskType)) throw new BadRequestException("此设置仅适用于文字和分析模型 图片报价请使用图片模型费用设置");
    const target = route.targets[0]!;
    const sameQuote = (value: typeof target.analysisPricing) => !!value
      && value.inputUsdPerMillion === input.pricing.inputUsdPerMillion
      && value.outputUsdPerMillion === input.pricing.outputUsdPerMillion
      && value.maxTaskCostUsd === input.pricing.maxTaskCostUsd;
    if (sameQuote(target.analysisPricing)) return;
    const all = await tx.select().from(modelRoutes).where(inArray(modelRoutes.taskType, ["studio_text", "studio_analysis"]));
    const aliases = all.filter(candidate => candidate.targets.length === 1 && candidate.targets[0]!.providerConfigId === target.providerConfigId
      && candidate.targets[0]!.providerModel === target.providerModel
      && (candidate.status === "enabled" || (candidate.status === "disabled" && candidate.targets[0]!.configurationDisabled === true)));
    // A quote on a shared model must not quietly override a separately configured
    // analysis quote or cap, including one whose selectable model is paused.
    if (route.taskType === "studio_text" && aliases.some(candidate => candidate.id !== route.id && candidate.taskType === "studio_analysis"
      && candidate.targets[0]!.analysisPricing && !sameQuote(candidate.targets[0]!.analysisPricing)))
      throw new ConflictException({ code: "model_configuration_pricing_conflict", message: "该模型仍继承关联分析配置的价格或限额 请先核对关联分析模型 本次价格未修改" });
    // A queued alias may pin the effective policy of this provider/model pair.
    await this.assertModelsIdle(tx, aliases.map(candidate => candidate.id), "model_configuration_model_in_use");
    await tx.update(modelRoutes).set({ targets: [{ ...target, analysisPricing: input.pricing }], updatedAt: sql`clock_timestamp()` })
      .where(eq(modelRoutes.id, route.id));
  }

  private async assertChannelIdle(tx: TenantTransaction, id: string, code: "model_configuration_channel_busy" | "model_configuration_channel_in_use") {
    const [assist] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(inArray(aiAssistRuns.status, ["queued", "running"]), sql`${aiAssistRuns.modelSnapshot}->>'providerConfigId' = ${id}`)).limit(1);
    const [generation] = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(inArray(creativeStudioGenerations.status, ["queued", "running"]), sql`${creativeStudioGenerations.modelSnapshot}->>'providerConfigId' = ${id}`)).limit(1);
    const [loop] = await tx.select({ id: agentLoopRuns.id }).from(agentLoopRuns).where(and(inArray(agentLoopRuns.status, ["queued", "running", "stopping"]), sql`${agentLoopRuns.modelSnapshot}->>'providerConfigId' = ${id}`)).limit(1);
    const [plan] = await tx.select({ id: agentPlanRuns.id }).from(agentPlanRuns).where(and(inArray(agentPlanRuns.status, ["queued", "running", "stopping"]), sql`${agentPlanRuns.modelSnapshot}->>'providerConfigId' = ${id}`)).limit(1);
    if (assist || generation || loop || plan) throw new ConflictException({ code, message: code === "model_configuration_channel_busy"
      ? "该渠道仍有排队或进行中的任务，请等待完成或取消任务后再删除"
      : "该渠道仍有排队或进行中的任务 本次配置未修改 请先完成或取消相关任务" });
  }

  private async assertModelsIdle(tx: TenantTransaction, ids: string[], code: "model_configuration_model_busy" | "model_configuration_model_in_use") {
    if (!ids.length) return;
    const [assist] = await tx.select({ id: aiAssistRuns.id }).from(aiAssistRuns).where(and(inArray(aiAssistRuns.status, ["queued", "running"]),
      sql`${aiAssistRuns.modelSnapshot}->>'id' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)).limit(1);
    const [generation] = await tx.select({ id: creativeStudioGenerations.id }).from(creativeStudioGenerations).where(and(inArray(creativeStudioGenerations.status, ["queued", "running"]),
      sql`${creativeStudioGenerations.input}->>'modelId' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)).limit(1);
    const [loop] = await tx.select({ id: agentLoopRuns.id }).from(agentLoopRuns).where(and(inArray(agentLoopRuns.status, ["queued", "running", "stopping"]),
      sql`${agentLoopRuns.modelSnapshot}->>'id' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)).limit(1);
    const [plan] = await tx.select({ id: agentPlanRuns.id }).from(agentPlanRuns).where(and(inArray(agentPlanRuns.status, ["queued", "running", "stopping"]),
      sql`${agentPlanRuns.modelSnapshot}->>'id' in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`)).limit(1);
    if (assist || generation || loop || plan) throw new ConflictException({ code, message: code === "model_configuration_model_busy"
      ? "该模型仍有排队或进行中的任务，请等待完成或取消任务后再删除"
      : "该模型仍有排队或进行中的任务 本次配置未修改 请先完成或取消相关任务" });
  }

  private async clearDefaultReferences(tx: TenantTransaction, context: TenantContext, ids: string[]) {
    // Preferences remain user-owned by RLS; never rewrite another user's choices.
    const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
    if (!preferences) return;
    const defaults = { ...preferences.defaults, ...(preferences.defaults.purposeDefaults ? { purposeDefaults: { ...preferences.defaults.purposeDefaults } } : {}) };
    let changed = false;
    for (const capability of ["image", "video", "text", "analysis"] as const) {
      if (defaults[capability] && ids.includes(defaults[capability]!)) { defaults[capability] = null; changed = true; }
    }
    for (const [purpose, id] of Object.entries(defaults.purposeDefaults ?? {})) {
      if (id && ids.includes(id)) { defaults.purposeDefaults![purpose as ModelPurpose] = null; changed = true; }
    }
    if (changed) await tx.update(modelPreferences).set({ defaults, revision: preferences.revision + 1, updatedAt: sql`clock_timestamp()` })
      .where(eq(modelPreferences.userId, context.userId));
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
      // Saving a channel is not permission to restart a reversibly paused model.
      // Selecting an old removed model without its ID retains the established re-add flow.
      const readdingRemoved = existing?.status === "disabled" && !existing.targets[0]!.configurationDisabled && !model.id;
      const values = { modelKey, taskType, targets: [{ timeoutMs: 600_000, ...existing?.targets[0], providerConfigId: id, providerModel: model.name }], status: readdingRemoved ? "enabled" : existing?.status ?? "enabled", updatedAt };
      if (existing) await tx.update(modelRoutes).set(values).where(eq(modelRoutes.id, routeId));
      else await tx.insert(modelRoutes).values({ ...values, id: routeId, tenantId: context.tenantId });
    }
    const removed = related.filter(route => !kept.has(route.id) && route.status === "enabled").map(route => route.id);
    if (removed.length) await this.removeModels(tx, context, removed);
  }

  private async removeChannel(tx: TenantTransaction, context: TenantContext, input: Extract<ConfigurationRpc, { operation: "channel.remove" }>) {
    const current = (await this.snapshot(tx, context)).channels.find(channel => channel.id === input.id);
    if (!current) throw new NotFoundException({ code: "model_configuration_channel_missing", message: "模型渠道不存在或已删除" });
    if (current.revision !== input.revision) throw new ConflictException({ code: "model_configuration_revision_conflict", message: "渠道或模型已被修改，请刷新配置后重新确认删除" });
    if (current.dependentRoutes.length) throw new ConflictException({ code: "model_configuration_channel_referenced", message: `该渠道仍被业务路由引用，请先调整：${current.dependentRoutes.map(route => route.label).join("、")}` });
    // Include other members' tasks and snapshots whose route was disabled.
    await this.assertChannelIdle(tx, input.id, "model_configuration_channel_busy");
    const routes = await tx.select().from(modelRoutes);
    const ownedIds = routes.filter(route => route.targets.length === 1 && route.targets[0]!.providerConfigId === input.id).map(route => route.id);
    if (ownedIds.length) await this.removeModels(tx, context, ownedIds);
    // Retain the identity for history, but discard its credential permanently.
    await tx.update(modelProviderConfigs).set({ status: "deleted", encryptedApiKey: "", updatedAt: sql`clock_timestamp()` }).where(eq(modelProviderConfigs.id, input.id));
  }

  private async removeModels(tx: TenantTransaction, context: TenantContext, ids: string[]) {
    // Creation takes the same configuration lock, so a new task cannot slip
    // between this check and removal. History keeps its immutable model snapshot.
    await this.assertModelsIdle(tx, ids, "model_configuration_model_busy");
    // Deletion removes the reversible-pause marker while retaining the route identity.
    const removed = await tx.select().from(modelRoutes).where(inArray(modelRoutes.id, ids));
    for (const route of removed) {
      const targets = route.targets.map(target => { const next = { ...target }; delete next.configurationDisabled; return next; });
      await tx.update(modelRoutes).set({ targets, status: "disabled", updatedAt: sql`clock_timestamp()` }).where(eq(modelRoutes.id, route.id));
    }
    await this.clearDefaultReferences(tx, context, ids);
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
