import { z } from "zod";
import { PodInvocationReceiptSchema } from "@yummyai/contracts/harness";

export const POD_MAX_RESPONSE_BYTES = 72 * 1024 * 1024;
export const PodArtworkResponseCheckpointSchema = z.object({
  version: z.literal("pod-response-checkpoint-v1"),
  kind: z.enum(["http", "result"]),
  rawBody: z.string().max(POD_MAX_RESPONSE_BYTES),
  status: z.int().min(100).max(599),
  deploymentId: z.string().min(1).max(160),
  maxOutputBytes: z.int().positive().max(50 * 1024 * 1024),
  receipt: PodInvocationReceiptSchema,
}).strict();

export const CreativeResponseMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/svg+xml", "video/mp4", "video/webm", "application/json", "application/zip", "application/postscript", "text/plain", "application/octet-stream"]);
export const CreativeLocalOutputSchema = z.object({
  dataBase64: z.string().min(1).max(POD_MAX_RESPONSE_BYTES), mediaType: CreativeResponseMediaTypeSchema,
  role: z.string().min(1).max(100),
}).strict();
/** Business-specific metadata stays encrypted with the original result, never in queue traces. */
export const CreativeResponseSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal("creative-response-v1"), kind: z.literal("pod"), checkpoint: PodArtworkResponseCheckpointSchema }).strict(),
  z.object({ version: z.literal("creative-response-v1"), kind: z.literal("local"),
    outputs: z.array(CreativeLocalOutputSchema).max(100), result: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ version: z.literal("creative-response-v1"), kind: z.literal("studio"), receipt: PodInvocationReceiptSchema,
    providerTaskId: z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/).nullable(), text: z.string().min(1).max(100000).nullable(),
    outputs: z.array(CreativeLocalOutputSchema).max(1),
  }).strict().superRefine((value, ctx) => {
    if ((value.text !== null) === (value.outputs.length > 0)) ctx.addIssue({ code: "custom", message: "A Studio response has one text or binary result" });
  }),
]);
export const CreativeResponseArchiveSchema = z.object({ version: z.literal(1), tenantId: z.uuidv7(), executionId: z.uuidv7(), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/), response: CreativeResponseSchema }).strict();
export type PodArtworkResponseCheckpoint = z.infer<typeof PodArtworkResponseCheckpointSchema>;
export type CreativeResponse = z.infer<typeof CreativeResponseSchema>;
