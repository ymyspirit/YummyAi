import { z } from "zod";

export const ModelNameSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_./:-]+$/);
export const CreativeCapabilitySchema = z.enum(["image", "video", "text"]);
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
  z.object({ operation: z.literal("configuration.get") }).strict(),
  z.object({ operation: z.literal("channel.save"), id: z.uuidv7().optional(), revision: z.string().max(80).optional(),
    name: z.string().trim().min(1).max(80), baseUrl: Endpoint, apiKey: Credential.optional(),
    models: z.array(ChannelModelSchema).max(200),
  }).strict(),
  z.object({ operation: z.literal("channel.status"), id: z.uuidv7(), revision: z.string().max(80), status: z.enum(["enabled", "disabled"]) }).strict(),
  z.object({ operation: z.literal("channel.remove"), id: z.uuidv7(), revision: z.string().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("model.remove"), channelId: z.uuidv7(), modelId: z.uuidv7(), revision: z.string().min(1).max(80) }).strict(),
  z.object({ operation: z.literal("channel.discover"), id: z.uuidv7().optional(), baseUrl: Endpoint, apiKey: Credential.optional() }).strict(),
  z.object({ operation: z.literal("defaults.save"), revision: z.int().nonnegative(), defaults: ModelDefaultsSchema }).strict(),
]);
export type ConfigurationRpc = z.infer<typeof ConfigurationRpcSchema>;
export type ConfiguredChannelModel = z.infer<typeof ChannelModelSchema> & { id: string; label: string };
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
