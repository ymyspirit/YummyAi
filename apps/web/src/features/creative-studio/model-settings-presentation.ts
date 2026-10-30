import type { ConfiguredChannel, ConfigurationSnapshot, ModelDefaults } from "@yummyai/contracts/ai/model-configuration";
import type { AnalysisModelPricing } from "@yummyai/contracts/ai/model-pricing-policy";
import type { OfficialApiPriceCatalog } from "@yummyai/contracts/ai/official-model-pricing";

export type ModelCapability = "text" | "image" | "video";
export type ChannelModelDraft = { id?: string; name: string; label: string; capability: ModelCapability };
export type ChannelDraft = {
  id?: string; revision?: string; name: string; baseUrl: string; apiKey: string;
  textProtocol: "responses" | "chat_completions"; models: ChannelModelDraft[];
};
export type ManagedModel = {
  id: string; name: string; label: string; capability: ModelCapability | "analysis";
  channel: ConfiguredChannel; shared: boolean; status: "enabled" | "disabled";
  analysisPricing?: AnalysisModelPricing; analysisPricingInheritedFrom?: string;
};
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
export const modelSettingsTabKeys = ["channels", "models", "defaults", "usage"] as const;
export type ModelSettingsTab = typeof modelSettingsTabKeys[number];
export function modelSettingsTab(search: string, hash: string): ModelSettingsTab {
  const requested = new URLSearchParams(search).get("settingsTab");
  if (modelSettingsTabKeys.some(tab => tab === requested)) return requested as ModelSettingsTab;
  if (hash === "#analysis-model-settings" || hash === "#models") return "models";
  if (hash === "#defaults") return "defaults";
  if (hash === "#usage") return "usage";
  return "channels";
}
export function modelSettingsTabHref(current: string, tab: ModelSettingsTab) {
  const url = new URL(current, "http://localhost");
  url.searchParams.set("settingsTab", tab); url.hash = "";
  return url.pathname + url.search;
}
export const capabilityLabels: Record<ManagedModel["capability"], string> = { text: "文本任务", image: "图片生成", video: "视频生成", analysis: "历史分析模型" };

export function channelDraft(channel?: ConfiguredChannel): ChannelDraft {
  const protocol = channel && "textProtocol" in channel ? channel.textProtocol : undefined;
  return {
    id: channel?.id, revision: channel?.revision, name: channel?.name ?? "", baseUrl: channel?.baseUrl ?? "",
    apiKey: "", textProtocol: protocol === "responses" ? "responses" : protocol === "chat_completions" || channel?.provider === "openai-compatible" ? "chat_completions" : "responses",
    models: channel?.models.map(model => ({ id: model.id, name: model.name, label: model.label, capability: model.capability })) ?? [],
  };
}
export function suggestedChannelName(endpoint: string) {
  try { return new URL(endpoint).hostname.replace(/^www\./, "").slice(0, 80); } catch { return ""; }
}
export function suggestedModelLabel(channelName: string, model: string) {
  return `${channelName.trim().slice(0, 30) || "模型渠道"} / ${model.slice(0, 64)}`.slice(0, 100);
}
export function filteredCatalogue(models: readonly string[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return [...new Set(models)].filter(name => !needle || name.toLocaleLowerCase().includes(needle)).sort(collator.compare);
}
export function managedModels(snapshot: ConfigurationSnapshot): ManagedModel[] {
  return snapshot.channels.flatMap(channel => [
    ...channel.models.map(model => ({ id: model.id, name: model.name, label: model.label, capability: model.capability,
      channel, shared: model.capability === "text", status: "status" in model && model.status === "disabled" ? "disabled" as const : "enabled" as const,
      ...(model.analysisPricing ? { analysisPricing: model.analysisPricing } : {}),
      ...("analysisPricingInheritedFrom" in model && typeof model.analysisPricingInheritedFrom === "string" ? { analysisPricingInheritedFrom: model.analysisPricingInheritedFrom } : {}) })),
    ...channel.analysisModels.map(model => ({ id: model.id, name: model.name, label: model.label, capability: "analysis" as const,
      channel, shared: false, status: "status" in model && model.status === "disabled" ? "disabled" as const : "enabled" as const,
      ...(model.analysisPricing ? { analysisPricing: model.analysisPricing } : {}) })),
  ]).sort((a, b) => collator.compare(a.channel.name, b.channel.name) || collator.compare(a.name, b.name));
}
export function filterManagedModels(models: readonly ManagedModel[], query: string, capability: string, channelId: string) {
  const needle = query.trim().toLocaleLowerCase();
  return models.filter(model => (!capability || model.capability === capability)
    && (!channelId || model.channel.id === channelId)
    && (!needle || [model.name, model.label, model.channel.name].some(value => value.toLocaleLowerCase().includes(needle))));
}
export function defaultModelLabel(snapshot: ConfigurationSnapshot, id: string | null) {
  if (!id) return "未指定 · 沿用业务现有选择";
  const model = managedModels(snapshot).find(item => item.id === id);
  if (!model) return "原模型已不可选 · 请重新指定";
  return model.status === "disabled" || model.channel.status === "disabled" ? `${model.label} · 已停用 请重新指定` : model.label;
}
export function isDefaultModel(defaults: ModelDefaults, id: string) {
  return Object.values(defaults).includes(id) || Object.values(defaults.purposeDefaults ?? {}).includes(id);
}
export function officialTextRate(catalog: OfficialApiPriceCatalog | undefined, modelId: string) {
  return catalog?.rates.find(rate => rate.modelId === modelId && rate.category === "text");
}
export function pricingSummary(pricing?: AnalysisModelPricing) {
  if (pricing?.maxTaskCostUsd !== null && pricing?.maxTaskCostUsd !== undefined) return `单次费用上限 $${pricing.maxTaskCostUsd}`;
  return pricing?.inputUsdPerMillion !== null && pricing?.inputUsdPerMillion !== undefined
    && pricing?.outputUsdPerMillion !== null && pricing?.outputUsdPerMillion !== undefined ? "不限额 · 已配置估算报价" : "不限额 · 报价待核对";
}
export function channelDraftProblem(draft: ChannelDraft) {
  if (!draft.name.trim()) return "填写渠道名称";
  if (draft.name.trim().length > 80) return "渠道名称不能超过 80 个字符";
  try { const endpoint = new URL(draft.baseUrl); if (!["http:", "https:"].includes(endpoint.protocol)) return "填写有效的 HTTP 或 HTTPS 接口地址"; }
  catch { return "填写有效的接口地址"; }
  if (!draft.id && !draft.apiKey.trim()) return "填写新渠道的 API Key";
  if (draft.apiKey.trim().length > 8192) return "API Key 超过可保存长度";
  if (draft.models.length > 200) return "每个渠道最多保存 200 个模型";
  if (new Set(draft.models.map(model => model.name)).size !== draft.models.length) return "同一渠道不能重复添加同名模型";
  if (draft.models.some(model => !model.label.trim())) return "填写已选模型的显示名称";
  if (draft.models.some(model => model.label.trim().length > 100)) return "模型显示名称不能超过 100 个字符";
  return null;
}
export function channelSaveInput(draft: ChannelDraft) {
  return {
    operation: "channel.save" as const,
    ...(draft.id ? { id: draft.id, revision: draft.revision } : {}),
    name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), textProtocol: draft.textProtocol,
    ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
    models: draft.models.map(model => ({ ...(model.id ? { id: model.id } : {}), name: model.name, label: model.label.trim(), capability: model.capability })),
  };
}
