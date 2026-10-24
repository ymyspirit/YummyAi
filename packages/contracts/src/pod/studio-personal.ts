import { z } from "zod";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";
import { CanvasResultReceiptSchema } from "@yummyai/contracts/pod/canvas-bridge";
import { PillowRuntimeCapabilitySchema } from "@yummyai/contracts/pod/design-automation";
import { StudioOriginalInspectionSchema, StudioResultLookupSchema } from "@yummyai/contracts/pod/studio-original";
import { StudioTransferLookupSchema, StudioTransferPageSchema, StudioTransferPreviewSchema } from "@yummyai/contracts/pod/studio-document-transfer";
import { StudioVideoDirectorySchema, StudioVideoPreflightSchema } from "@yummyai/contracts/pod/studio-video-directory";
import {
  assertStudioDocument, StudioGenerateSchema, StudioKeySchema, StudioNamespaceSchema, StudioSelectionRevisionSchema,
  StudioRpcSchema, StudioScopeSchema, type StudioRpc,
} from "@yummyai/contracts/pod/creative-studio";

export const STUDIO_PERSONAL_VERSION = 1;
export const STUDIO_PERSONAL_CLEAR_EVENT = "yummyai:studio:clear:v1";
export const STUDIO_PERSONAL_MEDIA_LIMIT = 29 * 1024 * 1024;
export const STUDIO_PERSONAL_METADATA_LIMIT = 10 * 1024 * 1024;
export const StudioWorkspaceQuerySchema = z.object({ scope: StudioScopeSchema.default("unassigned") }).strict();
export const StudioWorkspaceSchema = z.object({
  version: z.literal(STUDIO_PERSONAL_VERSION), scope: StudioScopeSchema,
  contextAuthority: ErpContextAuthoritySchema,
  originalHandoffVersion: z.literal(1).optional(),
  documentTransferVersion: z.literal(1).optional(),
  videoDirectoryVersion: z.literal(1).optional(),
  capabilities: z.object({
    read: z.boolean(), save: z.boolean(), mediaWrite: z.boolean(),
    review: z.boolean(), submit: z.boolean(), configure: z.boolean(),
  }).strict(),
  // The operator has paused paid execution. Enabling it requires its own
  // verified budget, route and consumer admission; model discovery is not proof.
  generation: z.object({ enabled: z.literal(false), code: z.literal("operator_paused") }).strict(),
}).strict();
export type StudioWorkspace = z.infer<typeof StudioWorkspaceSchema>;
/** A quiet transport is not proof that the current editor input was saved.
 * Older runtimes have no separate local producer count. */
export const StudioStorageStatusSchema = z.object({
  pending: z.int().nonnegative(),
  dirty: z.int().nonnegative().default(0),
  error: z.string().max(2000).nullable(),
}).strict();
export type StudioStorageStatus = z.infer<typeof StudioStorageStatusSchema>;
export const StudioPersonalInvokeSchema = z.object({
  version: z.literal(STUDIO_PERSONAL_VERSION), contextAuthority: ErpContextAuthoritySchema,
  request: StudioRpcSchema,
}).strict();
export type StudioPersonalInvoke = z.infer<typeof StudioPersonalInvokeSchema>;

const Revision = z.int().nonnegative();
const Id = z.uuidv7();
const Base64 = z.string().min(4).max(28_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const MediaType = z.string().max(160).regex(/^(image|video|audio)\/[a-z0-9.+-]+$/i);
const Status = z.enum(["queued", "running", "completed", "failed"]);
const StudioValue = z.unknown().superRefine((value, context) => {
  try { assertStudioDocument(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid studio document" }); }
});
const StateRead = z.union([
  z.object({ revision: Revision, value: StudioValue }).strict(),
  z.object({ revision: Revision, media: z.object({ contentBase64: Base64, mediaType: MediaType }).strict(), assetId: Id }).strict(),
]);
export const StudioAssetSchema = z.object({
  key: StudioKeySchema, namespace: StudioNamespaceSchema, assetId: Id,
  fileName: z.string().max(1000), mediaType: MediaType,
  rightsStatus: z.enum(["unverified", "approved", "rejected"]), aiGenerated: z.boolean(),
}).strict();
export const StudioModelSchema = z.object({
  id: Id, label: z.string().max(500), model: z.string().max(500),
  capability: z.enum(["image", "video", "text"]), providerLabel: z.string().max(500), isDefault: z.boolean(),
  selectionRevision: StudioSelectionRevisionSchema,
}).strict();
export type StudioModel = z.infer<typeof StudioModelSchema>;
const GenerationResult = z.union([
  z.object({ id: Id, status: Status, error: z.string().max(2000).nullable(), text: z.string().max(1_000_000).nullable() }).strict(),
  z.object({ id: Id, status: Status, key: StudioKeySchema, contentBase64: Base64, mediaType: MediaType, reviewError: z.string().max(1000).optional() }).strict(),
]);
export const StudioGenerationRecordSchema = z.object({
  id: Id, assetId: Id.nullable(), status: Status, input: StudioGenerateSchema,
  model: z.object({
    providerConfigId: Id, model: z.string().max(500), capability: z.enum(["image", "video", "text"]),
    routeId: Id.optional(), providerFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    visualCeilingUsd: z.number().finite().nonnegative().optional(),
  }).strict(),
  createdAt: z.iso.datetime(), error: z.string().max(2000).nullable(),
}).strict();

export const studioPersonalDataSchemas = {
  "video.directory": StudioVideoDirectorySchema,
  "video.preflight": StudioVideoPreflightSchema,
  "document.preview": StudioTransferPreviewSchema,
  "document.requests": StudioTransferPageSchema,
  "document.prepare": StudioTransferLookupSchema,
  "document.commit": StudioTransferLookupSchema,
  "document.lookup": StudioTransferLookupSchema,
  "document.cancel": StudioTransferLookupSchema,
  "state.get": StateRead,
  "state.keys": z.array(StudioKeySchema).max(10_000),
  "state.set": z.object({ revision: Revision, assetId: Id.nullable() }).strict(),
  "state.remove": z.object({ revision: Revision, assetId: z.null() }).strict(),
  models: z.array(StudioModelSchema).max(1000),
  "pillow-runtime": PillowRuntimeCapabilitySchema,
  generate: z.object({ id: Id, status: Status }).strict(),
  "generation.get": GenerationResult,
  generations: z.array(StudioGenerationRecordSchema).max(40),
  assets: z.array(StudioAssetSchema).max(500),
  "asset.preview": z.object({ contentBase64: Base64, mediaType: z.literal("image/webp") }).strict(),
  "asset.inspect": StudioOriginalInspectionSchema,
  "reference.attach": z.object({ key: StudioKeySchema }).strict(),
  "asset.review": z.object({ ok: z.literal(true) }).strict(),
  "result.submit": CanvasResultReceiptSchema.strict(),
  "result.submit.pinned": CanvasResultReceiptSchema.strict(),
  "result.lookup": StudioResultLookupSchema,
} as const;
function reply<Operation extends StudioRpc["operation"], Schema extends z.ZodType>(operation: Operation, data: Schema) {
  return z.object({ version: z.literal(STUDIO_PERSONAL_VERSION), scope: StudioScopeSchema,
    contextAuthority: ErpContextAuthoritySchema, operation: z.literal(operation), data }).strict();
}
export const StudioPersonalReplySchema = z.discriminatedUnion("operation", [
  reply("video.directory", studioPersonalDataSchemas["video.directory"]),
  reply("video.preflight", studioPersonalDataSchemas["video.preflight"]),
  reply("document.preview", studioPersonalDataSchemas["document.preview"]),
  reply("document.requests", studioPersonalDataSchemas["document.requests"]),
  reply("document.prepare", studioPersonalDataSchemas["document.prepare"]),
  reply("document.commit", studioPersonalDataSchemas["document.commit"]),
  reply("document.lookup", studioPersonalDataSchemas["document.lookup"]),
  reply("document.cancel", studioPersonalDataSchemas["document.cancel"]),
  reply("state.get", studioPersonalDataSchemas["state.get"]), reply("state.keys", studioPersonalDataSchemas["state.keys"]),
  reply("state.set", studioPersonalDataSchemas["state.set"]), reply("state.remove", studioPersonalDataSchemas["state.remove"]),
  reply("models", studioPersonalDataSchemas.models), reply("pillow-runtime", studioPersonalDataSchemas["pillow-runtime"]),
  reply("generate", studioPersonalDataSchemas.generate), reply("generation.get", studioPersonalDataSchemas["generation.get"]),
  reply("generations", studioPersonalDataSchemas.generations), reply("assets", studioPersonalDataSchemas.assets),
  reply("asset.preview", studioPersonalDataSchemas["asset.preview"]), reply("reference.attach", studioPersonalDataSchemas["reference.attach"]),
  reply("asset.review", studioPersonalDataSchemas["asset.review"]), reply("result.submit", studioPersonalDataSchemas["result.submit"]),
  reply("asset.inspect", studioPersonalDataSchemas["asset.inspect"]), reply("result.submit.pinned", studioPersonalDataSchemas["result.submit.pinned"]),
  reply("result.lookup", studioPersonalDataSchemas["result.lookup"]),
]);
export type StudioPersonalReply = z.infer<typeof StudioPersonalReplySchema>;
export function parseStudioPersonalReply(raw: unknown, request: StudioRpc, authority: string): StudioPersonalReply {
  const value = StudioPersonalReplySchema.parse(raw);
  if (value.scope !== request.scope || value.operation !== request.operation || value.contextAuthority !== authority)
    throw new Error("STUDIO_PERSONAL_REPLY_CONTEXT_CHANGED");
  return value;
}
