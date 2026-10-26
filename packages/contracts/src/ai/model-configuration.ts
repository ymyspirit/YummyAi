import { z } from "zod";
import { StudioImagePricingSchema, type StudioImagePricing } from "@yummyai/contracts/ai/studio-image-pricing";

export const ModelNameSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_./:-]+$/);
export const CreativeCapabilitySchema = z.enum(["image", "video", "text"]);
export const TextProtocolSchema = z.enum(["responses", "chat_completions"]);
export const ModelDefaultsSchema = z.object({
  image: z.uuidv7().nullable(), video: z.uuidv7().nullable(), text: z.uuidv7().nullable(), analysis: z.uuidv7().nullable(),
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
  z.object({ operation: z.literal("channel.discover"), id: z.uuidv7().optional(), baseUrl: Endpoint, apiKey: Credential.optional() }).strict(),
  z.object({ operation: z.literal("defaults.save"), revision: z.int().nonnegative(), defaults: ModelDefaultsSchema }).strict(),
]);
export type ConfigurationRpc = z.infer<typeof ConfigurationRpcSchema>;
export type ConfiguredChannelModel = z.infer<typeof ChannelModelSchema> & { id: string; label: string; imagePricing?: StudioImagePricing };
export type ConfiguredChannel = {
  id: string; name: string; baseUrl: string; provider: string; hasCredential: boolean;
  status: "enabled" | "disabled"; revision: string; models: ConfiguredChannelModel[];
  analysisModels: Array<{ id: string; name: string; label: string }>;
  dependentRoutes: Array<{ id: string; label: string }>;
};
export type ConfigurationSnapshot = {
  channels: ConfiguredChannel[];
  analysisModels: Array<{ id: string; label: string; model: string; providerLabel: string; providerConfigId: string }>;
  defaults: ModelDefaults; defaultsRevision: number;
};
export type ModelCatalogue = { models: string[]; fetchedAt: string; source: "provider"; skipped: number };

const PublicModelId = z.uuidv7();
export const ConfigurationSnapshotSchema = z.object({
  channels: z.array(z.object({
    id: PublicModelId, name: z.string().max(500), baseUrl: z.url().max(2000), provider: z.string().max(128),
    hasCredential: z.boolean(), status: z.enum(["enabled", "disabled"]), revision: z.string().max(80),
    updatedAt: z.iso.datetime().optional(),
    models: z.array(ChannelModelSchema.extend({ id: PublicModelId, label: z.string().max(500), imagePricing: StudioImagePricingSchema.optional() }).strict()).max(1000),
    analysisModels: z.array(z.object({ id: PublicModelId, name: ModelNameSchema, label: z.string().max(500) }).strict()).max(1000),
    dependentRoutes: z.array(z.object({ id: PublicModelId, label: z.string().max(500) }).strict()).max(1000),
  }).strict()).max(1000),
  analysisModels: z.array(z.object({ id: PublicModelId, label: z.string().max(500), model: ModelNameSchema,
    providerLabel: z.string().max(500), providerConfigId: PublicModelId }).strict()).max(1000),
  defaults: ModelDefaultsSchema, defaultsRevision: z.int().nonnegative(),
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
