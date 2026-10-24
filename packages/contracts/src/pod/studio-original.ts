import { z } from "zod";
import { CanvasResultReceiptSchema } from "@yummyai/contracts/pod/canvas-bridge";

export const STUDIO_ORIGINAL_HANDOFF_VERSION = 1;
export const STUDIO_ORIGINAL_MEDIA_LIMIT = 20 * 1024 * 1024;
export const STUDIO_RESULT_INTENT_PREFIX = "erp-result-v1:";
export const StudioOriginalNamespaceSchema = z.enum(["image_files", "media_files"]);
export const StudioOriginalPinSchema = z.object({
  entryId: z.uuidv7(), revision: z.int().positive(), namespace: StudioOriginalNamespaceSchema,
  assetId: z.uuidv7(), assetVersion: z.int().positive(),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mediaType: z.string().max(160).regex(/^(image|video|audio)\/[a-z0-9.+-]+$/i),
  byteSize: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceKind: z.enum(["owned", "licensed", "ai_generated"]),
}).strict();
export type StudioOriginalPin = z.infer<typeof StudioOriginalPinSchema>;

const Dimension = z.int().positive().max(65_535);
const Duration = z.number().finite().positive().max(86_400);
const Image = z.object({
  status: z.literal("verified"), kind: z.literal("image"),
  encodedWidth: Dimension, encodedHeight: Dimension, displayWidth: Dimension, displayHeight: Dimension,
  orientation: z.int().min(1).max(8), validation: z.literal("full_static_decode"),
}).strict();
const Video = z.object({
  status: z.literal("verified"), kind: z.literal("video"),
  encodedWidth: Dimension, encodedHeight: Dimension, displayWidth: Dimension, displayHeight: Dimension,
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  durationSeconds: Duration, validation: z.literal("container_and_packets"),
}).strict();
const Audio = z.object({ status: z.literal("verified"), kind: z.literal("audio"),
  durationSeconds: Duration, validation: z.literal("container_and_packets"),
}).strict();
export const StudioTechnicalInfoSchema = z.union([
  Image, Video, Audio,
  z.object({ status: z.enum(["unknown", "unsupported", "failed"]),
    code: z.enum(["unavailable", "unsupported_media", "invalid_media", "media_type_mismatch", "size_limit", "scan_failed", "inspection_timeout", "unreadable", "integrity_mismatch"]),
  }).strict(),
]);
export type StudioTechnicalInfo = z.infer<typeof StudioTechnicalInfoSchema>;
export const StudioOriginalInspectionSchema = z.object({ source: StudioOriginalPinSchema, technical: StudioTechnicalInfoSchema }).strict();
export type StudioOriginalInspection = z.infer<typeof StudioOriginalInspectionSchema>;

// Frozen original input shared by first submit and read-only receipt lookup.
export const StudioPinnedResultFields = {
  scope: z.uuidv7(), key: z.string().min(1).max(180).regex(/^[a-zA-Z0-9:_-]+$/),
  title: z.string().trim().min(1).max(160), submissionId: z.uuid(),
  sourceReference: z.string().trim().min(1).max(500), rightsAttested: z.literal(true),
  source: StudioOriginalPinSchema,
};
export const StudioPinnedResultRequestSchema = z.object({ operation: z.literal("result.submit.pinned"), ...StudioPinnedResultFields }).strict();
export type StudioPinnedResultRequest = z.infer<typeof StudioPinnedResultRequestSchema>;
export const StudioResultLookupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), receipt: CanvasResultReceiptSchema.strict() }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
]);
export type StudioResultLookup = z.infer<typeof StudioResultLookupSchema>;
const IntentBase = { version: z.literal(1), request: StudioPinnedResultRequestSchema };
export const StudioResultIntentSchema = z.discriminatedUnion("status", [
  z.object({ ...IntentBase, status: z.literal("prepared") }).strict(),
  z.object({ ...IntentBase, status: z.literal("unknown") }).strict(),
  z.object({ ...IntentBase, status: z.literal("confirmed"), receipt: CanvasResultReceiptSchema.strict() }).strict(),
]);
export type StudioResultIntent = z.infer<typeof StudioResultIntentSchema>;
export function studioResultIntentKey(source: Pick<StudioOriginalPin, "entryId" | "revision">): string {
  return `${STUDIO_RESULT_INTENT_PREFIX}${source.entryId}:${source.revision}`;
}
