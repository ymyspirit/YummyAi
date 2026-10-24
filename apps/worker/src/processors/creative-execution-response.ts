import { z } from "zod";
import { PodInvocationReceiptSchema } from "@yummyai/contracts/harness";
import { PodArtworkResponseCheckpointSchema, POD_MAX_RESPONSE_BYTES, hashPodResponse } from "./pod-artwork-response.js";

const MediaType = z.enum(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/svg+xml", "video/mp4", "video/webm", "application/json", "application/zip", "application/postscript", "text/plain", "application/octet-stream"]);
export const CreativeLocalOutputSchema = z.object({
  dataBase64: z.string().min(1).max(POD_MAX_RESPONSE_BYTES), mediaType: MediaType,
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
export type CreativeResponse = z.infer<typeof CreativeResponseSchema>;
export type CreativeLocalOutput = { bytes: Uint8Array; mediaType: z.infer<typeof MediaType>; role: string };

export function creativeLocalResponse(outputs: CreativeLocalOutput[], result: Record<string, unknown>): CreativeResponse {
  return parseCreativeResponse({ version: "creative-response-v1", kind: "local", outputs: outputs.map(({ bytes, ...rest }) => ({ ...rest, dataBase64: Buffer.from(bytes).toString("base64") })), result });
}
export function parseCreativeResponse(raw: unknown) {
  const value = CreativeResponseSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(value)) > POD_MAX_RESPONSE_BYTES) throw new Error("CREATIVE_RESPONSE_TOO_LARGE");
  if (value.kind !== "pod") decodeCreativeOutputs(value);
  return value;
}
export function decodeCreativeOutputs(response: { outputs: Array<z.infer<typeof CreativeLocalOutputSchema>> }): CreativeLocalOutput[] {
  let total = 0;
  return response.outputs.map(({ dataBase64, ...rest }) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw new Error("CREATIVE_RESPONSE_INVALID");
    const bytes = Buffer.from(dataBase64, "base64"); total += bytes.length;
    if (!bytes.length || total > 50 * 1024 * 1024) throw new Error("CREATIVE_RESPONSE_TOO_LARGE");
    return { ...rest, bytes };
  });
}
export function creativeResponseChecksum(response: CreativeResponse) {
  return response.kind === "pod" ? response.checkpoint.receipt.responseChecksum : response.kind === "studio" ? response.receipt.responseChecksum : hashPodResponse(JSON.stringify(response));
}
export const creativeMediaExtension: Record<z.infer<typeof MediaType>, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "application/json": "json", "application/zip": "zip", "application/postscript": "ps", "text/plain": "txt", "application/octet-stream": "bin",
};
