import { z } from "zod";

export const STUDIO_VERSION = "1.0.0";
export const StudioToolSchema = z.enum(["canvas", "image", "video", "prompts", "assets"]);
export type StudioTool = z.infer<typeof StudioToolSchema>;
export const StudioScopeSchema = z.union([z.literal("unassigned"), z.uuidv7()]);
export const StudioNamespaceSchema = z.enum(["app_state", "image_generation_logs", "video_generation_logs", "image_files", "media_files"]);
export const StudioKeySchema = z.string().min(1).max(180).regex(/^[a-zA-Z0-9:_-]+$/);
const Revision = z.int().nonnegative();
const Media = z.object({ contentBase64: z.string().min(4).max(28_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "audio/mpeg", "audio/wav"]) }).strict();
export const StudioGenerateSchema = z.object({
  requestId: z.uuid(), modelId: z.uuidv7(), prompt: z.string().trim().min(1).max(8000),
  referenceKeys: z.array(StudioKeySchema).max(10).default([]),
  size: z.string().regex(/^(auto|[0-9]{1,5}x[0-9]{1,5}|[0-9]{1,2}:[0-9]{1,2})$/).default("1024x1024"),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto"),
  seconds: z.int().min(1).max(20).default(4),
}).strict();
export const StudioModelInputSchema = z.object({
  providerConfigId: z.uuidv7(), model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_./:-]+$/),
  capability: z.enum(["image", "video", "text"]), label: z.string().trim().min(1).max(100),
}).strict();
const Base = { scope: StudioScopeSchema.default("unassigned") };
const Address = { namespace: StudioNamespaceSchema, key: StudioKeySchema };
export const StudioRpcSchema = z.discriminatedUnion("operation", [
  z.object({ ...Base, operation: z.literal("state.get"), ...Address }).strict(),
  z.object({ ...Base, operation: z.literal("state.keys"), namespace: StudioNamespaceSchema }).strict(),
  z.object({ ...Base, operation: z.literal("state.set"), ...Address, revision: Revision, value: z.unknown().optional(), media: Media.optional() }).strict(),
  z.object({ ...Base, operation: z.literal("state.remove"), ...Address, revision: Revision }).strict(),
  z.object({ ...Base, operation: z.literal("models") }).strict(),
  z.object({ ...Base, operation: z.literal("generate"), input: StudioGenerateSchema }).strict(),
  z.object({ ...Base, operation: z.literal("generation.get"), id: z.uuidv7() }).strict(),
  z.object({ ...Base, operation: z.literal("generations") }).strict(),
  z.object({ ...Base, operation: z.literal("asset.review"), key: StudioKeySchema, decision: z.enum(["approve", "reject"]), sourceReference: z.string().trim().min(1).max(500) }).strict(),
  z.object({ ...Base, operation: z.literal("assets") }).strict(),
  z.object({ ...Base, operation: z.literal("asset.preview"), namespace: z.literal("image_files"), key: StudioKeySchema }).strict(),
  z.object({ ...Base, operation: z.literal("reference.attach"), assetId: z.uuidv7() }).strict(),
  z.object({ ...Base, operation: z.literal("result.submit"), key: StudioKeySchema, title: z.string().trim().min(1).max(160), submissionId: z.uuid(), sourceReference: z.string().trim().min(1).max(500), rightsAttested: z.literal(true) }).strict(),
]);
export type StudioRpc = z.infer<typeof StudioRpcSchema>;
export type StudioGenerate = z.infer<typeof StudioGenerateSchema>;
export type StudioModelInput = z.infer<typeof StudioModelInputSchema>;

/** Editor documents never contain credentials or executable provider scripts. */
export function assertStudioDocument(value: unknown): void {
  if (typeof value === "string" && /^\s*[[{]/.test(value)) value = JSON.parse(value);
  const json = JSON.stringify(value);
  if (json === undefined || json.length > 8_000_000) throw new Error("创作记录过大");
  if (/"(?:apiKey|api_key|accessToken|refreshToken|authorization|password|cookie|encryptedApiKey)"\s*:/i.test(json)) throw new Error("创作记录不能包含凭据");
}
