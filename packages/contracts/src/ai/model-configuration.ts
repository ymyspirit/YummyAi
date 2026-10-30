import { z } from "zod";
import { StudioImagePricingSchema, type StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";
import { ModelPurposeDefaultsSchema } from "@yummyai/contracts/ai/model-purpose";
import { AnalysisModelPricingSchema, type AnalysisModelPricing } from "@yummyai/contracts/ai/model-pricing-policy";
import { OfficialApiPriceCatalogSchema, type OfficialApiPriceCatalog } from "@yummyai/contracts/ai/official-model-pricing";

export const ModelNameSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_./:-]+$/);
export const CreativeCapabilitySchema = z.enum(["image", "video", "text"]);
export const TextProtocolSchema = z.enum(["responses", "chat_completions"]);
export const ModelDefaultsSchema = z.object({
  image: z.uuidv7().nullable(), video: z.uuidv7().nullable(), text: z.uuidv7().nullable(), analysis: z.uuidv7().nullable(),
  purposeDefaults: ModelPurposeDefaultsSchema.optional(),
}).strict();
export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;
export const emptyModelDefaults = (): ModelDefaults => ({ image: null, video: null, text: null, analysis: null });
export const ChannelModelSchema = z.object({
  id: z.uuidv7().optional(), name: ModelNameSchema, capability: CreativeCapabilitySchema,
  label: z.string().trim().min(1).max(100).optional(),
}).strict();
const Endpoint = z.url().max(2000);
const Credential = z.string().min(1).max(8192);
export const ConfigurationRpcSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("studio.image-pricing.save"), channelId: z.uuidv7(), modelId: z.uuidv7(),
    revision: z.string().min(1).max(80), pricing: StudioImagePricingSchema }).strict(),
  z.object({ operation: z.literal("configuration.get") }).strict(),
  z.object({ operation: z.literal("channel.save"), id: z.uuidv7().optional(), revision: z.string().max(80).optional(),
    name: z.string().trim().min(1).max(80), baseUrl: Endpoint, apiKey: Credential.optional(),
    textProtocol: TextProtocolSchema.optional(),
    models: z.array(ChannelModelSchema).max(200),
  }).strict(),
  z.object({ operation: z.literal("channel.status"), id: z.uuidv7(), revision: z.string().max(80), status: z.enum(["enabled", "disabled"]) }).strict(),
  z.object({ operation: z.literal("channel.remove"), id: z.uuidv7(), revision: z.string().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("model.remove"), channelId: z.uuidv7(), modelId: z.uuidv7(), revision: z.string().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("model.status"), channelId: z.uuidv7(), modelId: z.uuidv7(), revision: z.string().min(1).max(80), status: z.enum(["enabled", "disabled"]) }).strict(),
  z.object({ operation: z.literal("model.update"), channelId: z.uuidv7(), modelId: z.uuidv7(), revision: z.string().min(1).max(80), label: z.string().trim().min(1).max(100) }).strict(),
  z.object({ operation: z.literal("model.analysis-pricing.save"), channelId: z.uuidv7(), modelId: z.uuidv7(), revision: z.string().min(1).max(80), pricing: AnalysisModelPricingSchema }).strict(),
  z.object({ operation: z.literal("channel.discover"), id: z.uuidv7().optional(), baseUrl: Endpoint, apiKey: Credential.optional() }).strict(),
  z.object({ operation: z.literal("defaults.save"), revision: z.int().nonnegative(), defaults: ModelDefaultsSchema }).strict(),
  z.object({ operation: z.literal("purpose-defaults.save"), revision: z.int().nonnegative(), defaults: ModelPurposeDefaultsSchema }).strict(),
]);
export type ConfigurationRpc = z.infer<typeof ConfigurationRpcSchema>;

/** Fixed owner failures only; provider text and arbitrary diagnostics never cross the bridge. */
const configurationRemovalFailures = {
  model_configuration_model_in_use: { status: 409, outcome: "rejected", message: "该模型仍有排队或进行中的任务 本次配置未修改 请先完成或取消相关任务" },
  model_configuration_channel_in_use: { status: 409, outcome: "rejected", message: "该渠道仍有排队或进行中的任务 本次配置未修改 请先完成或取消相关任务" },
  model_configuration_pricing_conflict: { status: 409, outcome: "rejected", message: "该模型仍继承关联分析配置的价格或限额 请先核对关联分析模型 本次价格未修改" },
  model_configuration_model_paused: { status: 409, outcome: "rejected", message: "该模型已停用 请在模型库核对原配置后启用 本次未新增或改写" },
  model_configuration_revision_conflict: { status: 409, outcome: "rejected", message: "渠道或模型配置已变化 本次未删除 请读取最新配置后重新确认" },
  model_configuration_channel_referenced: { status: 409, outcome: "rejected", message: "该渠道仍被业务路由使用 本次未删除 请先调整关联路由" },
  model_configuration_channel_busy: { status: 409, outcome: "rejected", message: "该渠道仍有排队或进行中的任务 本次未删除 请先完成或取消相关任务" },
  model_configuration_model_busy: { status: 409, outcome: "rejected", message: "该模型仍有排队或进行中的任务 本次未删除 请先完成或取消相关任务" },
  model_configuration_channel_missing: { status: 404, outcome: "missing", message: "当前渠道不存在或已删除 请读取原配置核对" },
  model_configuration_model_missing: { status: 404, outcome: "missing", message: "当前模型不存在或已删除 请读取原配置核对" },
} as const;
export type ModelConfigurationRemovalCode = keyof typeof configurationRemovalFailures;
export function publicModelConfigurationError(code: unknown, status: number) {
  if (typeof code !== "string" || !Object.hasOwn(configurationRemovalFailures, code)) return null;
  const value = configurationRemovalFailures[code as ModelConfigurationRemovalCode];
  return value.status === status ? { code: code as ModelConfigurationRemovalCode, ...value } : null;
}
/** The iframe receives presentation strings; classify only our exact fixed messages. */
export function modelConfigurationRemovalFailure(message: unknown) {
  if (typeof message !== "string") return null;
  for (const [code, value] of Object.entries(configurationRemovalFailures)) {
    if (value.message === message) return { code: code as ModelConfigurationRemovalCode, ...value };
  }
  return null;
}
export type ConfiguredChannelModel = z.infer<typeof ChannelModelSchema> & { id: string; label: string; status?: "enabled" | "disabled"; imagePricing?: StudioImagePricing; analysisPricing?: AnalysisModelPricing; analysisPricingInheritedFrom?: string };
export type ConfiguredChannel = {
  id: string; name: string; baseUrl: string; provider: string; hasCredential: boolean;
  status: "enabled" | "disabled"; revision: string; models: ConfiguredChannelModel[];
  textProtocol?: z.infer<typeof TextProtocolSchema>;
  analysisModels: Array<{ id: string; name: string; label: string; status?: "enabled" | "disabled"; analysisPricing?: AnalysisModelPricing; analysisPricingInheritedFrom?: string }>;
  dependentRoutes: Array<{ id: string; label: string }>;
};
export type ConfigurationSnapshot = {
  channels: ConfiguredChannel[];
  analysisModels: Array<{ id: string; label: string; model: string; providerLabel: string; providerConfigId: string }>;
  defaults: ModelDefaults; defaultsRevision: number;
  officialPriceCatalog?: OfficialApiPriceCatalog;
};
export type ModelCatalogue = { models: string[]; fetchedAt: string; source: "provider"; skipped: number };

const PublicModelId = z.uuidv7();
export const ConfigurationSnapshotSchema = z.object({
  channels: z.array(z.object({
    id: PublicModelId, name: z.string().max(500), baseUrl: z.url().max(2000), provider: z.string().max(128),
    hasCredential: z.boolean(), status: z.enum(["enabled", "disabled"]), revision: z.string().max(80),
    textProtocol: TextProtocolSchema.optional(),
    updatedAt: z.iso.datetime().optional(),
    models: z.array(ChannelModelSchema.extend({ id: PublicModelId, label: z.string().max(500), status: z.enum(["enabled", "disabled"]).optional(), imagePricing: StudioImagePricingSchema.optional(), analysisPricing: AnalysisModelPricingSchema.optional(), analysisPricingInheritedFrom: PublicModelId.optional() }).strict()).max(1000),
    analysisModels: z.array(z.object({ id: PublicModelId, name: ModelNameSchema, label: z.string().max(500), status: z.enum(["enabled", "disabled"]).optional(), analysisPricing: AnalysisModelPricingSchema.optional(), analysisPricingInheritedFrom: PublicModelId.optional() }).strict()).max(1000),
    dependentRoutes: z.array(z.object({ id: PublicModelId, label: z.string().max(500) }).strict()).max(1000),
  }).strict()).max(1000),
  analysisModels: z.array(z.object({ id: PublicModelId, label: z.string().max(500), model: ModelNameSchema,
    providerLabel: z.string().max(500), providerConfigId: PublicModelId }).strict()).max(1000),
  defaults: ModelDefaultsSchema, defaultsRevision: z.int().nonnegative(),
  officialPriceCatalog: OfficialApiPriceCatalogSchema.optional(),
}).strict();
export const ModelCatalogueSchema = z.object({
  models: z.array(ModelNameSchema).max(10_000), fetchedAt: z.iso.datetime(), source: z.literal("provider"), skipped: z.int().nonnegative(),
}).strict();
/** The legacy provider management endpoint also returns a public projection. */
export const PublicModelProviderSchema = z.object({
  id: PublicModelId, provider: z.enum(["openai", "anthropic", "openai-compatible"]), label: z.string().max(500),
  endpoint: z.url().max(2000).nullable(), status: z.enum(["enabled", "disabled"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), hasCredential: z.boolean(),
}).strict();
